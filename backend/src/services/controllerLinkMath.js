/**
 * controllerLinkMath — "Follow crop targets": what the fertigation dose controller
 * WOULD be set to from the operator's crop stage targets (operator decision
 * 2026-09-30). Pure (no DB): unit-testable. The DB side, the proposal lifecycle
 * and the apply-at-next-cycle hook live in ControllerLinkService.
 *
 * 1. pH  setpoint = the stage pH target when one is set, else the midpoint of the
 *        stage pH min / max (vegetative 5.80-6.20 -> 6.00);
 *        floor_ph = max(5.0, pH min - 0.2) unless that fails the controller's
 *        cross-checks (then the current floor is kept). Every other pH safety
 *        limit (acid caps, stale / frozen / plausible, max duty) is untouched.
 * 2. EC  base ratio (uniform across the nutrient tanks A-D, agronomy decision:
 *        all tanks draw equally) from the SAME helper as the element targets
 *        (elementTargetScaling.scaleFactor, ebf8d4a), so element targets and the
 *        ratio agree:
 *          factor = (EC target - source water EC) / protocol recipe EC at 1:design
 *          ratio  = design / factor           (rounded like equivalent_dilution)
 *        The source water EC (crop profile field — the ONE source of truth) is
 *        REQUIRED: without it the EC part is blocked. Outside the hard bounds
 *        1:100..1:250 (narrowed by ec_check / ec_trim bounds) nothing is proposed.
 *        EC trim (outer loop) follows too: target_us = EC target x 1000, water_us
 *        = source water EC x 1000; ec_check.raw_water_ec_us = the same water EC.
 *        ec_trim.enabled is NEVER proposed (separately confirmed control).
 * 3. Element best fit (ADVISORY ONLY, never applied): per-tank ratios in
 *    [100, 250] that best match the stage element ppm targets with the CURRENT
 *    stock mixtures — weighted least squares on the relative error (weights from
 *    the element priority), exact bounded solution by active-set enumeration
 *    (ppm is linear in x = 1/ratio). Elements whose band cannot be reached with
 *    any ratios in bounds are flagged "needs a stock recipe change".
 */

const ScaleMath = require('./elementTargetScaling');
const FC = require('./FeedCalculator');

const RATIO_HARD_BOUNDS = Object.freeze({ min: 100, max: 250 });
const PH_FLOOR_MIN = 5.0;
const PH_FLOOR_OFFSET = 0.2;
// Element priority (1 = most important .. 5) -> weight of its relative error.
const PRIORITY_WEIGHT = Object.freeze({ 1: 4, 2: 3, 3: 2, 4: 1, 5: 0.5 });

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const round = (v, dp) => { if (v === null || v === undefined || !Number.isFinite(v)) return null; const f = Math.pow(10, dp); return Math.round(v * f) / f; };
const same = (a, b) => {
  const x = num(a); const y = num(b);
  if (x === null || y === null) return x === y;
  return Math.abs(x - y) <= 1e-9 + 1e-9 * Math.abs(y);
};

/** Effective ratio bounds: the hard bounds narrowed by the controller's ec_check / ec_trim bounds. */
function ratioBounds(cfg) {
  const ec = (cfg && cfg.ec_check) || {};
  const tr = (cfg && cfg.nutrients && cfg.nutrients.ec_trim) || {};
  const lo = Math.max(RATIO_HARD_BOUNDS.min, num(ec.min_ratio) ?? -Infinity, num(tr.min_ratio) ?? -Infinity);
  const hi = Math.min(RATIO_HARD_BOUNDS.max, num(ec.max_ratio) ?? Infinity, num(tr.max_ratio) ?? Infinity);
  return { min: lo, max: hi, hard: { ...RATIO_HARD_BOUNDS } };
}

/** Ratio-controlled nutrient tank ids of the config (A-D), numeric, sorted. */
function ratioTankIds(cfg, roles = null) {
  const r = (cfg && cfg.nutrients && cfg.nutrients.ratio) || {};
  return Object.keys(r)
    .map(Number)
    .filter(id => Number.isInteger(id) && num(r[id]) > 0 && (!roles || !roles[id] || roles[id] === 'nutrient'))
    .sort((a, b) => a - b);
}

/** Uniform ratio of a config ({id: ratio}) or null when the tanks differ. */
function uniformRatio(ratioObj, ids) {
  const vals = ids.map(id => num(ratioObj && (ratioObj[id] ?? ratioObj[String(id)])));
  if (!vals.length || vals.some(v => v === null)) return null;
  return vals.every(v => same(v, vals[0])) ? vals[0] : null;
}

/**
 * pH part.
 * @returns {{ ok, reason?, setpoint?, floor_ph?, floor_kept?, floor_reason?, math }}
 *   reason: no_ph_target
 */
function proposePh({ stageTarget, cfg, crossCheck, mergeConfig }) {
  const st = stageTarget || {};
  const phTarget = num(st.ph_target);
  const lo = num(st.ph_min);
  const hi = num(st.ph_max);
  const math = { ph_target: phTarget, ph_min: lo, ph_max: hi, basis: null, floor_rule: { min: PH_FLOOR_MIN, offset: PH_FLOOR_OFFSET } };
  let setpoint = null;
  if (phTarget !== null) { setpoint = phTarget; math.basis = 'target'; }
  else if (lo !== null && hi !== null) { setpoint = (lo + hi) / 2; math.basis = 'midpoint'; }
  if (setpoint === null) return { ok: false, reason: 'no_ph_target', math };
  setpoint = round(setpoint, 2);
  const cur = cfg.ph;
  let floor = lo !== null ? round(Math.max(PH_FLOOR_MIN, lo - PH_FLOOR_OFFSET), 2) : null;
  let floorKept = false;
  let floorReason = null;
  if (floor === null) { floor = cur.floor_ph; floorKept = true; floorReason = 'no_ph_min'; }
  const check = (sp, fl) => crossCheck(mergeConfig(cfg, { ph: { setpoint: sp, floor_ph: fl } }));
  if (!floorKept && check(setpoint, floor)) { floorReason = 'cross_check'; floor = cur.floor_ph; floorKept = true; }
  const bad = check(setpoint, floor);
  if (bad) return { ok: false, reason: 'cross_check', detail: bad, math: { ...math, setpoint, floor_ph: floor } };
  return { ok: true, setpoint, floor_ph: floor, floor_kept: floorKept, floor_reason: floorReason, math: { ...math, setpoint, floor_ph: floor } };
}

/**
 * EC part: uniform base ratio + EC-trim target / water + raw water EC.
 * @returns {{ ok, reason?, ratio?, math }}
 *   reason: source_water_missing | no_ec_target | no_protocol | no_protocol_recipe |
 *           protocol_ec_unknown | source_water_exceeds_target | factor_out_of_range | ratio_out_of_bounds | no_tanks
 */
function proposeEc({ stageTarget, sourceWaterEc, stagePpm, cfg, tankIds, hasProtocol = true }) {
  const bounds = ratioBounds(cfg);
  const ecTarget = num(stageTarget && stageTarget.ec_target);
  const sw = num(sourceWaterEc);
  const f = ScaleMath.scaleFactor({ ecTarget, sourceWaterEc: sw, stagePpm });
  const math = { ...f.math, bounds, raw_ratio: f.ok ? stagePpm.design_dilution / f.factor : null };
  if (sw === null) return { ok: false, reason: 'source_water_missing', math };
  if (!hasProtocol) return { ok: false, reason: 'no_protocol', math };
  if (!f.ok) return { ok: false, reason: f.reason, math };
  if (!tankIds || !tankIds.length) return { ok: false, reason: 'no_tanks', math };
  const ratio = math.equivalent_dilution; // = Math.round(design / factor), same as the element-target header
  if (ratio < bounds.min || ratio > bounds.max) return { ok: false, reason: 'ratio_out_of_bounds', ratio, math };
  const targetUs = Math.round(ecTarget * 1000);
  const waterUs = Math.round(sw * 1000);
  return { ok: true, ratio, target_us: targetUs, water_us: waterUs, raw_water_ec_us: waterUs >= 1 ? waterUs : null, math };
}

/**
 * The whole proposal for one stage against the current controller config.
 * @param opts.stage, stageTarget (crop_stage_targets row), sourceWaterEc (profile, mS/cm),
 *        stagePpm (elementTargetScaling.protocolStagePpm), cfg (merged controller config),
 *        tankIds (ratio tanks), hasProtocol, crossCheck, mergeConfig
 * @returns {{ update, diff, parts: { ph, ec }, blocked: [{ part, reason }] }}
 *   update  = partial controller config (only fields that change); {} = nothing to do
 *   diff    = [{ field, current, proposed, reason: { code, params } }]
 */
function buildProposal(opts) {
  const { cfg, tankIds } = opts;
  const ph = proposePh(opts);
  const ec = proposeEc(opts);
  const update = {};
  const diff = [];
  const blocked = [];
  if (ph.ok) {
    if (!same(cfg.ph.setpoint, ph.setpoint)) {
      (update.ph = update.ph || {}).setpoint = ph.setpoint;
      diff.push({ field: 'ph.setpoint', current: cfg.ph.setpoint, proposed: ph.setpoint, reason: { code: ph.math.basis === 'target' ? 'ph_target' : 'ph_midpoint', params: { min: ph.math.ph_min, max: ph.math.ph_max, target: ph.math.ph_target } } });
    }
    if (!same(cfg.ph.floor_ph, ph.floor_ph)) {
      (update.ph = update.ph || {}).floor_ph = ph.floor_ph;
      diff.push({ field: 'ph.floor_ph', current: cfg.ph.floor_ph, proposed: ph.floor_ph, reason: { code: 'ph_floor', params: { min: ph.math.ph_min, offset: PH_FLOOR_OFFSET, floor_min: PH_FLOOR_MIN } } });
    }
  } else {
    blocked.push({ part: 'ph', reason: ph.reason, detail: ph.detail || null });
  }
  if (ec.ok) {
    const curRatio = {};
    const newRatio = {};
    let ratioChanged = false;
    for (const id of tankIds) {
      const c = num(cfg.nutrients.ratio[id] ?? cfg.nutrients.ratio[String(id)]);
      curRatio[id] = c;
      newRatio[id] = ec.ratio;
      if (!same(c, ec.ratio)) ratioChanged = true;
    }
    const m = ec.math;
    const ecParams = { ec: m.ec_target, water: m.source_water_ec, fert: m.fertilizer_ec_target, protocol_ec: m.protocol_fertilizer_ec, design: m.design_dilution, factor: m.factor, ratio: ec.ratio };
    if (ratioChanged) {
      update.nutrients = { ...(update.nutrients || {}), ratio: newRatio };
      diff.push({ field: 'nutrients.ratio', current: curRatio, proposed: newRatio, reason: { code: 'ec_ratio', params: ecParams } });
    }
    const tr = cfg.nutrients.ec_trim;
    const trimUpd = {};
    if (!same(tr.target_us, ec.target_us)) {
      trimUpd.target_us = ec.target_us;
      diff.push({ field: 'nutrients.ec_trim.target_us', current: tr.target_us, proposed: ec.target_us, reason: { code: 'trim_target', params: { ec: m.ec_target } } });
    }
    if (!same(tr.water_us, ec.water_us)) {
      trimUpd.water_us = ec.water_us;
      diff.push({ field: 'nutrients.ec_trim.water_us', current: tr.water_us, proposed: ec.water_us, reason: { code: 'trim_water', params: { water: m.source_water_ec } } });
    }
    if (Object.keys(trimUpd).length) update.nutrients = { ...(update.nutrients || {}), ec_trim: trimUpd };
    const rawCur = cfg.ec_check.raw_water_ec_us;
    if (!same(rawCur, ec.raw_water_ec_us)) {
      update.ec_check = { raw_water_ec_us: ec.raw_water_ec_us };
      diff.push({ field: 'ec_check.raw_water_ec_us', current: rawCur, proposed: ec.raw_water_ec_us, reason: { code: 'raw_water', params: { water: m.source_water_ec } } });
    }
  } else {
    blocked.push({ part: 'ec', reason: ec.reason, ratio: ec.ratio ?? null, bounds: ec.math.bounds });
  }
  return { update, diff, parts: { ph, ec }, blocked };
}

/**
 * Controller values the crop targets imply, per field, compared with the live
 * config (for the "Controller" block: match / mismatch per field).
 */
function comparison({ cfg, parts, tankIds }) {
  const rows = [];
  const cmp = (field, current, wanted, available) => rows.push({ field, current, wanted: available ? wanted : null, available: !!available, match: available ? same(current, wanted) : null });
  cmp('ph.setpoint', cfg.ph.setpoint, parts.ph.setpoint, parts.ph.ok);
  cmp('ph.floor_ph', cfg.ph.floor_ph, parts.ph.floor_ph, parts.ph.ok);
  const ur = uniformRatio(cfg.nutrients.ratio, tankIds);
  rows.push({ field: 'nutrients.ratio', current: Object.fromEntries(tankIds.map(id => [id, num(cfg.nutrients.ratio[id])])), uniform: ur, wanted: parts.ec.ok ? parts.ec.ratio : null, available: parts.ec.ok, match: parts.ec.ok ? (ur !== null && same(ur, parts.ec.ratio)) : null });
  cmp('nutrients.ec_trim.target_us', cfg.nutrients.ec_trim.target_us, parts.ec.target_us, parts.ec.ok);
  cmp('nutrients.ec_trim.water_us', cfg.nutrients.ec_trim.water_us, parts.ec.water_us, parts.ec.ok);
  return rows;
}

// ─── element best fit (advisory) ────────────────────────────────────────────

/** Solve the square system M y = v (Gaussian elimination, partial pivoting); null when singular. */
function solve(M, v) {
  const n = v.length;
  const A = M.map((row, i) => [...row, v[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  const y = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = A[r][n];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * y[k];
    y[r] = s / A[r][r];
  }
  return y;
}

/**
 * min ||A x - b||^2 subject to lo <= x <= hi (small n): every free / lower / upper
 * assignment is tried; the free variables solve the reduced normal equations and
 * must land inside their bounds. Convex problem -> the best feasible assignment is
 * the global optimum.
 */
function boundedLeastSquares(A, b, lo, hi) {
  const n = lo.length;
  const m = b.length;
  const cost = (x) => { let s = 0; for (let e = 0; e < m; e++) { let r = -b[e]; for (let i = 0; i < n; i++) r += A[e][i] * x[i]; s += r * r; } return s; };
  let best = null;
  const total = Math.pow(3, n);
  for (let code = 0; code < total; code++) {
    const state = []; let c = code;
    for (let i = 0; i < n; i++) { state.push(c % 3); c = Math.floor(c / 3); } // 0 free, 1 lower, 2 upper
    const x = state.map((s, i) => (s === 1 ? lo[i] : s === 2 ? hi[i] : 0));
    const free = state.map((s, i) => (s === 0 ? i : -1)).filter(i => i >= 0);
    if (free.length) {
      // residual target after the fixed variables
      const rhs = b.map((bv, e) => bv - state.reduce((acc, s, i) => acc + (s === 0 ? 0 : A[e][i] * x[i]), 0));
      const N = free.map(i => free.map(j => A.reduce((acc, row) => acc + row[i] * row[j], 0)));
      const v = free.map(i => A.reduce((acc, row, e) => acc + row[i] * rhs[e], 0));
      const y = solve(N, v);
      if (!y) continue;
      let ok = true;
      free.forEach((i, k) => { if (y[k] < lo[i] - 1e-12 || y[k] > hi[i] + 1e-12) ok = false; x[i] = y[k]; });
      if (!ok) continue;
    }
    const cst = cost(x);
    if (!best || cst < best.cost - 1e-15) best = { x, cost: cst };
  }
  return best;
}

/**
 * Best-fit per-tank ratios for the stage element targets with the current stock.
 * @param opts.tanks   [{ tank_id, letter, name, stock: { el: mg/L } }]  (stock = FC.tankStock(t).mg)
 * @param opts.targets [{ element, hard_min, soft_target, hard_max, priority }]
 * @param opts.bounds  { min, max } ratio bounds (1:min is the richest)
 * @returns {{ ok, reason?, ratios, elements: [...], ec_ms_cm, weights }}
 *   element: { element, target, min, max, achieved, pct, status ok|low|high, priority, weight,
 *              reachable_min, reachable_max, unreachable, needs_stock_change, reason }
 */
function bestFit({ tanks = [], targets = [], bounds = RATIO_HARD_BOUNDS, currentRatios = null }) {
  const els = (targets || []).filter(t => num(t.soft_target) > 0 && FC.TARGET_ELEMENTS.includes(t.element));
  if (!tanks.length) return { ok: false, reason: 'no_tanks', ratios: {}, elements: [] };
  if (!els.length) return { ok: false, reason: 'no_element_targets', ratios: {}, elements: [] };
  const lo = tanks.map(() => 1 / bounds.max);
  const hi = tanks.map(() => 1 / bounds.min);
  const weightOf = (p) => PRIORITY_WEIGHT[Math.max(1, Math.min(5, parseInt(p, 10) || 3))];
  const A = els.map(t => tanks.map(tk => Math.sqrt(weightOf(t.priority)) * ((tk.stock[t.element] || 0) / num(t.soft_target))));
  const b = els.map(t => Math.sqrt(weightOf(t.priority)));
  const sol = boundedLeastSquares(A, b, lo, hi);
  if (!sol) return { ok: false, reason: 'no_solution', ratios: {}, elements: [] };
  const ratios = {};
  tanks.forEach((tk, i) => { ratios[tk.tank_id] = Math.round(1 / sol.x[i]); });
  // achieved ppm with the rounded ratios (what an operator would enter)
  const ppm = {};
  for (const el of [...FC.TARGET_ELEMENTS, 'NH4_N']) ppm[el] = tanks.reduce((acc, tk) => acc + (tk.stock[el] || 0) / ratios[tk.tank_id], 0);
  const current = currentRatios ? tanks.every(tk => num(currentRatios[tk.tank_id]) > 0) : false;
  const ppmAt = (rs) => { const o = {}; for (const el of FC.TARGET_ELEMENTS) o[el] = tanks.reduce((acc, tk) => acc + (tk.stock[el] || 0) / rs[tk.tank_id], 0); return o; };
  const curPpm = current ? ppmAt(currentRatios) : null;
  const elements = FC.TARGET_ELEMENTS.map(el => {
    const t = els.find(x => x.element === el);
    if (!t) return null;
    const target = num(t.soft_target);
    const min = num(t.hard_min);
    const max = num(t.hard_max);
    const achieved = ppm[el];
    const rMax = tanks.reduce((acc, tk) => acc + (tk.stock[el] || 0) / bounds.min, 0);
    const rMin = tanks.reduce((acc, tk) => acc + (tk.stock[el] || 0) / bounds.max, 0);
    const bandLo = min ?? target * 0.9;
    const bandHi = max ?? target * 1.1;
    let reason = null;
    if (!(rMax > 0)) reason = 'not_in_stock';
    else if (rMax < bandLo) reason = 'too_low_even_richest';
    else if (rMin > bandHi) reason = 'too_high_even_weakest';
    const status = achieved < bandLo ? 'low' : achieved > bandHi ? 'high' : 'ok';
    const dp = FC.MICROS.includes(el) ? 3 : 1;
    return {
      element: el, target, min, max,
      achieved: round(achieved, dp),
      current: curPpm ? round(curPpm[el], dp) : null,
      pct: target ? round(((achieved - target) / target) * 100, 1) : null,
      status,
      priority: num(t.priority) ?? 3,
      weight: weightOf(t.priority),
      reachable_min: round(rMin, dp),
      reachable_max: round(rMax, dp),
      unreachable: !!reason,
      needs_stock_change: !!reason,
      reason,
    };
  }).filter(Boolean);
  return {
    ok: true,
    ratios,
    bounds: { min: bounds.min, max: bounds.max },
    elements,
    ec_ms_cm: round(FC.cationEc(ppm), 2),
    unreachable: elements.filter(e => e.unreachable).map(e => e.element),
    compromised: elements.filter(e => !e.unreachable && e.status !== 'ok').map(e => e.element),
    weights: { ...PRIORITY_WEIGHT },
  };
}

module.exports = {
  RATIO_HARD_BOUNDS,
  PH_FLOOR_MIN,
  PH_FLOOR_OFFSET,
  PRIORITY_WEIGHT,
  ratioBounds,
  ratioTankIds,
  uniformRatio,
  proposePh,
  proposeEc,
  buildProposal,
  comparison,
  boundedLeastSquares,
  bestFit,
  same,
};
