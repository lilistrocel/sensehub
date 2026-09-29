/**
 * elementTargetScaling — per-element ppm targets that follow the stage's input EC
 * target (operator request 2026-09-29: "element targets follow input EC target").
 *
 * Pure (no DB): unit-testable. The DB side lives in CropProfileService.
 *
 * The human agronomist's protocol gives stock recipes; SenseHub prefills the
 * element targets with that recipe diluted at a FIXED design dilution (1:150),
 * which corresponds to one fertilizer EC (≈ 1.45 mS/cm for the vegetative recipe).
 * When the operator sets a different input EC target, every element is scaled by
 * the same factor so the protocol's element RATIOS are kept:
 *
 *   fertilizer EC target = EC_target − source_water_EC   (0 when not entered)
 *   factor               = fertilizer EC target ÷ EC(protocol ppm at 1:design)
 *   ppm_el               = protocol ppm_el × factor       (every macro and micro)
 *
 * EC(ppm) = Σ cations (meq/L) ÷ 10 (FeedCalculator.cationEc) is linear in ppm, so
 * the scaled set corresponds exactly to the fertilizer EC target. The band around
 * the target (macro ±15 %, micro −30/+50 %), rounding (macro 0.1, micro 0.001 ppm)
 * and priorities (never 1: the planner turns priority 1 into an automatic
 * guardrail) are the same as the protocol prefill.
 *
 * Manual-edit protection: each crop_element_targets row stores the last value
 * SenseHub wrote from the protocol / a scaling (basis_hard_min / basis_soft_target
 * / basis_hard_max, basis_source 'protocol' | 'scaled'). A row whose values differ
 * from its basis — or has no basis — was edited by hand and is never overwritten
 * unless the request names it explicitly.
 */

const FC = require('./FeedCalculator');

const MACRO_BAND = { lo: 0.85, hi: 1.15 };
const MICRO_BAND = { lo: 0.7, hi: 1.5 };
// Never priority 1 here: the planner turns every priority-1 target into an automatic guardrail.
const ELEMENT_PRIORITY = { N: 2, K: 2, Ca: 2, P: 3, Mg: 3, S: 4, Fe: 3, Mn: 4, Zn: 4, B: 4, Cu: 5, Mo: 5 };
const SCALE_LIMITS = Object.freeze({ min: 0.3, max: 3 });

const round = (v, dp) => { const f = Math.pow(10, dp); return Math.round(v * f) / f; };
const isMicro = (el) => FC.MICROS.includes(el);
const decimals = (el) => (isMicro(el) ? 3 : 1);
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Priority for a written row: the element default, never 1. */
function priorityFor(el, current = null) {
  const c = num(current);
  if (c !== null && c >= 2 && c <= 5) return c;
  return ELEMENT_PRIORITY[el] || 3;
}

/** min / target / max for one element around an (unrounded) ppm target. */
function bandRow(el, ppm) {
  const band = isMicro(el) ? MICRO_BAND : MACRO_BAND;
  const dp = decimals(el);
  return { hard_min: round(ppm * band.lo, dp), soft_target: round(ppm, dp), hard_max: round(ppm * band.hi, dp) };
}

const bandText = (el) => (isMicro(el) ? '-30/+50' : '±15');

/** Protocol stage recipe as feed ppm at the design dilution (null when the stage has no recipe). */
function protocolStagePpm(protocolData, stage, library = () => null) {
  if (!protocolData) return null;
  const recipeKey = (protocolData.stage_recipe || {})[stage];
  if (!recipeKey) return null;
  const tanks = require('./cropProtocol').recipeTanks(protocolData, recipeKey, library);
  if (!tanks.length) return null;
  const design = Number(protocolData.senseHub_design_dilution) || 150;
  const { ppm } = FC.mixPpm(tanks.map(t => ({ tank: t, fraction: 1 / design })));
  return { recipe: recipeKey, design_dilution: design, ppm, fertilizer_ec_ms_cm: FC.cationEc(ppm) };
}

/** Prefill rows (protocol at the design dilution) — factor 1. */
function protocolElementRows(stagePpm) {
  if (!stagePpm) return [];
  return FC.TARGET_ELEMENTS.filter(el => stagePpm.ppm[el] > 0).map(el => ({
    element: el,
    ...bandRow(el, stagePpm.ppm[el]),
    priority: ELEMENT_PRIORITY[el] || 3,
    notes: `Prefill: human agronomist protocol ${stagePpm.recipe} recipe at 1:${stagePpm.design_dilution} (SenseHub design assumption); band ${bandText(el)} %`,
  }));
}

/**
 * Scale factor for a stage, with the guards.
 * @returns {{ ok, reason?, factor?, math }}
 *   reason: no_ec_target | no_protocol_recipe | protocol_ec_unknown | source_water_exceeds_target | factor_out_of_range
 */
function scaleFactor({ ecTarget, sourceWaterEc = null, stagePpm }) {
  const ec = num(ecTarget);
  const sw = num(sourceWaterEc);
  const protocolEc = stagePpm ? stagePpm.fertilizer_ec_ms_cm : null;
  const fertEc = ec !== null ? ec - (sw || 0) : null;
  const math = {
    ec_target: ec,
    source_water_ec: sw,
    source_water_known: sw !== null,
    fertilizer_ec_target: fertEc !== null ? round(fertEc, 3) : null,
    recipe: stagePpm ? stagePpm.recipe : null,
    design_dilution: stagePpm ? stagePpm.design_dilution : null,
    protocol_fertilizer_ec: protocolEc !== null ? round(protocolEc, 3) : null,
    factor: null,
    equivalent_dilution: null,
    limits: { ...SCALE_LIMITS },
  };
  if (ec === null) return { ok: false, reason: 'no_ec_target', math };
  if (!stagePpm) return { ok: false, reason: 'no_protocol_recipe', math };
  if (!(protocolEc > 0)) return { ok: false, reason: 'protocol_ec_unknown', math };
  if (!(fertEc > 0)) return { ok: false, reason: 'source_water_exceeds_target', math };
  const factor = fertEc / protocolEc;
  math.factor = round(factor, 4);
  math.equivalent_dilution = Math.round(stagePpm.design_dilution / factor);
  if (factor < SCALE_LIMITS.min || factor > SCALE_LIMITS.max) return { ok: false, reason: 'factor_out_of_range', math };
  return { ok: true, factor, math };
}

/** Same number within float noise. */
const same = (a, b) => {
  const x = num(a); const y = num(b);
  if (x === null || y === null) return x === y;
  return Math.abs(x - y) <= 1e-9 + 1e-9 * Math.abs(y);
};

/**
 * Hand-edited = the row's values differ from the last value SenseHub wrote
 * (basis_*), or the row has no basis at all (written by someone, not by SenseHub).
 */
function isManuallyEdited(row) {
  if (!row) return false;
  if (!row.basis_source) return true;
  return !(same(row.hard_min, row.basis_hard_min) && same(row.soft_target, row.basis_soft_target) && same(row.hard_max, row.basis_hard_max));
}

/**
 * The proposed element targets of a stage scaled to its input EC target.
 * @param opts.stagePpm       protocolStagePpm(...)
 * @param opts.ecTarget       stage input EC target (mS/cm)
 * @param opts.sourceWaterEc  profile source water EC (null = not entered → 0)
 * @param opts.current        current crop_element_targets rows of the stage (with basis_* columns)
 * @param opts.include        element list (or true = all) of hand-edited rows to overwrite anyway
 * @returns {{ ok, reason?, factor?, math, rows: [{ element, action, manual, old, new, priority, notes }], kept_manual: string[] }}
 *   action: update | insert | unchanged | kept_manual
 */
function scaleElementTargets({ stagePpm, ecTarget, sourceWaterEc = null, current = [], include = [] }) {
  const f = scaleFactor({ ecTarget, sourceWaterEc, stagePpm });
  if (!f.ok) return { ok: false, reason: f.reason, math: f.math, rows: [], kept_manual: [] };
  const includeAll = include === true;
  const inc = new Set(Array.isArray(include) ? include : []);
  const byEl = new Map((current || []).map(r => [r.element, r]));
  const m = f.math;
  const swText = m.source_water_known ? `source water ${m.source_water_ec}` : 'source water not entered (0)';
  const rows = [];
  const kept = [];
  for (const el of FC.TARGET_ELEMENTS) {
    const base = stagePpm.ppm[el];
    if (!(base > 0)) continue;
    const cur = byEl.get(el) || null;
    const next = bandRow(el, base * f.factor);
    const manual = cur ? isManuallyEdited(cur) : false;
    const old = cur ? { hard_min: num(cur.hard_min), soft_target: num(cur.soft_target), hard_max: num(cur.hard_max) } : null;
    let action;
    if (!cur) action = 'insert';
    else if (manual && !(includeAll || inc.has(el))) action = 'kept_manual';
    else if (same(old.hard_min, next.hard_min) && same(old.soft_target, next.soft_target) && same(old.hard_max, next.hard_max)) action = 'unchanged';
    else action = 'update';
    if (action === 'kept_manual') kept.push(el);
    rows.push({
      element: el,
      action,
      manual,
      protocol_ppm: round(base, decimals(el)),
      old,
      new: next,
      priority: priorityFor(el, cur ? cur.priority : null),
      notes: `Scaled: human agronomist protocol ${m.recipe} recipe ×${m.factor} (1:${m.design_dilution} → ≈1:${m.equivalent_dilution}) to input EC ${m.ec_target} (fertilizers ${m.fertilizer_ec_target}, ${swText}); band ${bandText(el)} %`,
    });
  }
  return { ok: true, factor: f.factor, math: m, rows, kept_manual: kept };
}

/**
 * Which EC the stored element targets correspond to (for the table header and the
 * advisor): fertilizer EC of the stored soft targets (Σ cations ÷ 10). NH4-N (not an
 * element target) keeps the protocol's NH4 share of N; without a protocol it is 0.
 * @returns {{ fertilizer_ec_ms_cm, source_water_ec, total_ec_ms_cm, ec_target, nh4_basis, factor_vs_protocol } | null}
 */
function targetsCorrespondence({ rows = [], stagePpm = null, sourceWaterEc = null, ecTarget = null }) {
  const t = {};
  for (const r of rows || []) { const v = num(r.soft_target); if (v !== null) t[r.element] = v; }
  if (t.K == null && t.Ca == null && t.Mg == null) return null;
  const ppm = { K: t.K || 0, Ca: t.Ca || 0, Mg: t.Mg || 0, NH4_N: 0 };
  let nh4Basis = 'none';
  if (stagePpm && stagePpm.ppm.N > 0 && stagePpm.ppm.NH4_N > 0 && t.N != null) {
    ppm.NH4_N = stagePpm.ppm.NH4_N * (t.N / stagePpm.ppm.N);
    nh4Basis = 'protocol_share';
  }
  const fert = FC.cationEc(ppm);
  const sw = num(sourceWaterEc);
  const pEc = stagePpm ? stagePpm.fertilizer_ec_ms_cm : null;
  return {
    fertilizer_ec_ms_cm: round(fert, 2),
    source_water_ec: sw,
    total_ec_ms_cm: round(fert + (sw || 0), 2),
    ec_target: num(ecTarget),
    nh4_basis: nh4Basis,
    factor_vs_protocol: pEc > 0 ? round(fert / pEc, 3) : null,
  };
}

module.exports = {
  MACRO_BAND,
  MICRO_BAND,
  ELEMENT_PRIORITY,
  SCALE_LIMITS,
  bandRow,
  priorityFor,
  protocolStagePpm,
  protocolElementRows,
  scaleFactor,
  isManuallyEdited,
  scaleElementTargets,
  targetsCorrespondence,
};
