/**
 * FeedCalculator — deterministic "what are the plants getting" (no AI).
 *
 * Delivered ppm per element for a period (last run / today / last 7 days):
 *
 *   ppm_el = Σ_tank  stock_mg_per_L(tank, el) × concentrate_L(tank) ÷ water_L
 *
 * stock_mg_per_L comes from the mixture each tank held when the run STARTED (refill
 * history: the last fertigation_tank_refills row at/before the run, else the tank's
 * current mixture — operator request 2026-09-30, recipe changed at 12:00 mid-day;
 * ingredient analyses, % w/w, fertigationMath) and concentrate / water litres are MEASURED
 * (irrigation_runs: every run incl. manual ones, from the irrigation monitor's
 * flow meter + per-tank consumption counters; fallback dose_controller_runs).
 * With no measured run in the period the configured dose-controller ratio
 * (1:ratio per tank) is used instead and the source says so.
 *
 * EC estimate (recipe only, source water not included):
 *   EC (mS/cm) ≈ Σ cations (meq/L) ÷ 10,
 *   cations: Ca 20.04, Mg 12.15, K 39.10, NH4-N 14.01 mg per meq;
 *   anions (ion balance check): NO3-N 14.01, H2PO4-P 30.97, SO4-S 16.03 mg per meq.
 * measured SEKO EC − recipe EC ≈ source water EC + acid + analysis error.
 *
 * Pure helpers on top; DB loaders at the bottom take the db handle. Nothing
 * here writes anything.
 */

const M = require('./fertigationMath');

const MACROS = ['N', 'P', 'K', 'Ca', 'Mg', 'S'];
const MICROS = ['Fe', 'Mn', 'Zn', 'B', 'Cu', 'Mo'];
const TARGET_ELEMENTS = [...MACROS, ...MICROS];

// mg per meq
const EQ = { Ca: 20.039, Mg: 12.153, K: 39.098, NH4_N: 14.007, Na: 22.99, NO3_N: 14.007, P: 30.974, S: 16.032, Cl: 35.453 };

const r1 = (v) => M.roundTo(v, 1);
const r2 = (v) => M.roundTo(v, 2);
const r3 = (v) => M.roundTo(v, 3);

function tankLetter(name, fallback) {
  const m = /\bTank\s+([A-Z0-9])\b/i.exec(String(name || ''));
  return m ? m[1].toUpperCase() : (fallback != null ? String(fallback) : null);
}

/** Stock concentrations of one tank: element mg/L + NH4-N / NO3-N mg/L. */
function tankStock(tank) {
  const mg = M.stockElementalMgPerL(tank.items, tank.water_base_liters);
  const nf = M.stockNitrogenForms(tank.items, tank.water_base_liters);
  return { mg, nh4: nf.nh4, no3: nf.no3, assumptions: nf.assumptions };
}

/**
 * Mix tanks into the feed.
 * @param parts [{ tank, fraction }]  fraction = L concentrate per L water (dosed/water or 1/ratio)
 * @returns {{ ppm, per_tank, assumptions }}  ppm includes NH4_N / NO3_N
 */
function mixPpm(parts) {
  const ppm = {};
  const perTank = [];
  const assumptions = new Set();
  for (const { tank, fraction, dosed_l = null } of parts) {
    const f = Number(fraction) || 0;
    const st = tankStock(tank);
    st.assumptions.forEach(a => assumptions.add(a));
    const tp = {};
    for (const [el, mgl] of Object.entries(st.mg)) { tp[el] = mgl * f; ppm[el] = (ppm[el] || 0) + mgl * f; }
    tp.NH4_N = st.nh4 * f; tp.NO3_N = st.no3 * f;
    ppm.NH4_N = (ppm.NH4_N || 0) + tp.NH4_N;
    ppm.NO3_N = (ppm.NO3_N || 0) + tp.NO3_N;
    perTank.push({
      tank_id: tank.tank_id ?? null,
      letter: tank.letter ?? null,
      name: tank.name ?? null,
      dosed_l: dosed_l === null ? null : r2(dosed_l),
      ratio: f > 0 ? Math.round(1 / f) : null,
      ppm: M.round(tp, 3),
    });
  }
  return { ppm: M.round(ppm, 3), per_tank: perTank, assumptions: [...assumptions] };
}

/**
 * Unrounded fertilizer-only EC (mS/cm) = Σ cations (meq/L) ÷ 10 — the same sum as
 * ecEstimate(). Linear in ppm: scaling every element by f scales this EC by f.
 */
function cationEc(ppm) {
  const p = ppm || {};
  const meq = (p.Ca || 0) / EQ.Ca + (p.Mg || 0) / EQ.Mg + (p.K || 0) / EQ.K + (p.NH4_N || 0) / EQ.NH4_N + (p.Na || 0) / EQ.Na;
  return meq / 10;
}

/** EC estimate from the recipe ions (mS/cm) + ion balance. */
function ecEstimate(ppm) {
  const p = ppm || {};
  const cat = {
    Ca: (p.Ca || 0) / EQ.Ca, Mg: (p.Mg || 0) / EQ.Mg, K: (p.K || 0) / EQ.K, NH4: (p.NH4_N || 0) / EQ.NH4_N, Na: (p.Na || 0) / EQ.Na,
  };
  const an = {
    NO3: (p.NO3_N ?? Math.max(0, (p.N || 0) - (p.NH4_N || 0))) / EQ.NO3_N,
    H2PO4: (p.P || 0) / EQ.P, SO4: (p.S || 0) / EQ.S, Cl: (p.Cl || 0) / EQ.Cl,
  };
  const cations = Object.values(cat).reduce((a, b) => a + b, 0);
  const anions = Object.values(an).reduce((a, b) => a + b, 0);
  return {
    method: 'sum of cations (meq/L) / 10, source water excluded',
    cations_meq_l: r2(cations),
    anions_meq_l: r2(anions),
    cations: M.round(cat, 2),
    anions: M.round(an, 2),
    balance_pct: cations + anions > 0 ? r1(((cations - anions) / (cations + anions)) * 100) : null,
    ec_ms_cm: r2(cations / 10),
  };
}

/** Mass ratios + NH4 share + K:Ca:Mg cation meq %. */
function elementRatios(ppm) {
  const p = ppm || {};
  const div = (a, b) => (b > 0 && a != null ? r2(a / b) : null);
  const kMeq = (p.K || 0) / EQ.K; const caMeq = (p.Ca || 0) / EQ.Ca; const mgMeq = (p.Mg || 0) / EQ.Mg;
  const tot = kMeq + caMeq + mgMeq;
  return {
    N_K: div(p.N, p.K),
    K_Ca: div(p.K, p.Ca),
    K_Mg: div(p.K, p.Mg),
    Ca_Mg: div(p.Ca, p.Mg),
    K_N: div(p.K, p.N),
    nh4_share_pct: p.N > 0 ? r1(((p.NH4_N || 0) / p.N) * 100) : null,
    cation_meq_pct: tot > 0 ? { K: r1((kMeq / tot) * 100), Ca: r1((caMeq / tot) * 100), Mg: r1((mgMeq / tot) * 100) } : null,
  };
}

/**
 * Compare a value with a band { min, target, max }.
 * status: ok | low | high | unknown; severity: ok | caution | alarm | unknown.
 * alarm = more than 25 % beyond the violated bound. pct = deviation from target
 * (or from the band middle when the band has no target).
 */
function compareBand(value, band) {
  const v = Number(value);
  if (value === null || value === undefined || !Number.isFinite(v)) return { status: 'unknown', severity: 'unknown', reason: 'no_value', pct: null };
  const b = band || {};
  const min = b.min != null && Number.isFinite(Number(b.min)) ? Number(b.min) : null;
  const max = b.max != null && Number.isFinite(Number(b.max)) ? Number(b.max) : null;
  const target = b.target != null && Number.isFinite(Number(b.target)) ? Number(b.target) : null;
  if (min === null && max === null && target === null) return { status: 'unknown', severity: 'unknown', reason: 'no_target', pct: null };
  const ref = target ?? (min !== null && max !== null ? (min + max) / 2 : (min ?? max));
  const pct = ref ? r1(((v - ref) / ref) * 100) : null;
  let lo = min; let hi = max;
  if (lo === null && hi === null) { lo = target * 0.9; hi = target * 1.1; } // target only: ±10 %
  if (lo !== null && v < lo) return { status: 'low', severity: v < lo * 0.75 ? 'alarm' : 'caution', pct, band_assumed: min === null && max === null };
  if (hi !== null && v > hi) return { status: 'high', severity: v > hi * 1.25 ? 'alarm' : 'caution', pct, band_assumed: min === null && max === null };
  return { status: 'ok', severity: 'ok', pct, band_assumed: min === null && max === null };
}

/** Per-element comparison against [{ element, hard_min, soft_target, hard_max }]. */
function compareElements(ppm, targets) {
  const byEl = new Map((targets || []).map(t => [t.element, t]));
  return TARGET_ELEMENTS.map(el => {
    const t = byEl.get(el);
    const value = ppm && ppm[el] != null ? r3(ppm[el]) : 0;
    const band = t ? { min: t.hard_min, target: t.soft_target, max: t.hard_max } : null;
    const c = band ? compareBand(value, band) : { status: 'unknown', severity: 'unknown', reason: 'no_target', pct: null };
    return { element: el, value, min: band ? band.min ?? null : null, target: band ? band.target ?? null : null, max: band ? band.max ?? null : null, ...c };
  });
}

/** Line-by-line comparison of the current tank contents with a protocol recipe (facts only). */
function compareRecipes(currentTanks, protocolTanks) {
  const letters = [...new Set([...currentTanks.map(t => t.letter), ...protocolTanks.map(t => t.letter)])].filter(Boolean).sort();
  const norm = (s) => String(s || '').toLowerCase();
  return letters.map(letter => {
    const cur = currentTanks.find(t => t.letter === letter);
    const pro = protocolTanks.find(t => t.letter === letter);
    const lines = [];
    const seen = new Set();
    for (const it of (pro ? pro.items : [])) {
      const match = cur ? cur.items.find(c => norm(c.name) === norm(it.name)) : null;
      if (match) seen.add(match);
      lines.push({
        ingredient: it.label || it.name,
        library_name: it.name,
        protocol_kg: it.amount,
        current_kg: match ? Number(match.amount) : 0,
        current_unit: match ? match.unit : 'kg',
        diff_kg: r2((match ? Number(match.amount) : 0) - it.amount),
      });
    }
    for (const c of (cur ? cur.items : [])) {
      if (seen.has(c)) continue;
      lines.push({ ingredient: c.name, library_name: c.name, protocol_kg: 0, current_kg: Number(c.amount), current_unit: c.unit, diff_kg: r2(Number(c.amount)) });
    }
    return {
      letter,
      tank_id: cur ? cur.tank_id : null,
      tank_name: cur ? cur.name : null,
      mixture_name: cur ? cur.mixture_name || null : null,
      per_liters: cur ? cur.water_base_liters : (pro ? pro.water_base_liters : null),
      lines,
    };
  });
}

// ---------------------------------------------------------------------------
// DB loaders
// ---------------------------------------------------------------------------

function parseJson(v, dflt) {
  if (v === null || v === undefined || v === '') return dflt;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return dflt; }
}

/** Active nutrient tanks (role nutrient) with their current mixture items. */
function loadCurrentTanks(db) {
  const rows = db.prepare(`
    SELECT t.id, t.name, t.role, t.equipment_id, t.channel, t.mixture_id, t.pending_mixture_id,
           t.water_base_liters, t.capacity_liters, t.current_stock_liters, t.active,
           m.name AS mixture_name, m.updated_at AS mixture_updated_at, e.name AS equipment_name
    FROM fertigation_tanks t
    LEFT JOIN fertigation_mixtures m ON m.id = t.mixture_id
    LEFT JOIN equipment e ON e.id = t.equipment_id
    WHERE COALESCE(t.active, 1) = 1
    ORDER BY t.id
  `).all();
  return rows.map((t, i) => ({
    tank_id: t.id,
    name: t.name,
    letter: tankLetter(t.name, i + 1),
    role: t.role,
    equipment_id: t.equipment_id,
    equipment_name: t.equipment_name,
    channel: t.channel,
    mixture_id: t.mixture_id,
    mixture_name: t.mixture_name,
    mixture_updated_at: t.mixture_updated_at,
    pending_mixture_id: t.pending_mixture_id,
    water_base_liters: t.water_base_liters || 1000,
    capacity_liters: t.capacity_liters,
    current_stock_liters: t.current_stock_liters,
    items: M.loadMixtureItems(db, t.mixture_id).map(it => ({ ...it, composition: M.parseComposition(it.composition) })),
  }));
}

/** 'YYYY-MM-DD HH:MM:SS' (SQLite, UTC) or ISO with zone -> epoch ms. */
function tsMs(v) {
  if (v === null || v === undefined || v === '') return null;
  const str = String(v);
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(str) ? str : `${str.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Recipe history per tank from the refill events (fertigation_tank_refills: refilled_at +
 * mixture_id). A refill is when a recipe took effect (operator request 2026-09-30: the
 * fruit-set recipe went into A-D at 12:00, so the runs before 12:00 were fed the old
 * recipe and the runs after it the new one).
 * @returns {Map<tank_id, [{ at_ms, mixture_id, refill_id }]>} oldest first
 */
function loadRecipeHistory(db) {
  const out = new Map();
  let rows = [];
  try {
    rows = db.prepare('SELECT id, tank_id, refilled_at, mixture_id FROM fertigation_tank_refills WHERE mixture_id IS NOT NULL ORDER BY refilled_at, id').all();
  } catch (_) { rows = []; }
  for (const r of rows) {
    const at = tsMs(r.refilled_at);
    if (at === null) continue;
    if (!out.has(r.tank_id)) out.set(r.tank_id, []);
    out.get(r.tank_id).push({ at_ms: at, mixture_id: r.mixture_id, refill_id: r.id });
  }
  return out;
}

/** Mixture a tank held when a run started: the last refill at/before it; else its current mixture. */
function mixtureAt(history, tank, startMs) {
  const list = history.get(tank.tank_id) || [];
  let found = null;
  if (startMs !== null) for (const h of list) { if (h.at_ms <= startMs) found = h; else break; }
  return found ? { mixture_id: found.mixture_id, refill_id: found.refill_id, from_ms: found.at_ms } : { mixture_id: tank.mixture_id, refill_id: null, from_ms: null };
}

/** Dose-controller config (stored merged onto defaults), or the defaults. */
function doseConfig(db) {
  let DC = null;
  try { DC = require('./DoseController'); } catch (_) { DC = null; }
  let stored = {};
  try {
    const row = db.prepare("SELECT value FROM system_settings WHERE key = 'dose_controller'").get();
    stored = row && row.value ? JSON.parse(row.value) : {};
  } catch (_) { stored = {}; }
  if (DC && DC.mergeConfig && DC.DEFAULT_CONFIG) {
    try { return DC.mergeConfig(DC.DEFAULT_CONFIG, stored); } catch (_) { /* fall through */ }
  }
  return stored || {};
}

/** Local YYYY-MM-DD dates of the period (newest last). */
function periodDates(period, nowMs, tz) {
  const { localDateStr } = require('../utils/systemTimezone');
  const days = period === '7d' ? 7 : 1;
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(localDateStr(new Date(nowMs - i * 86400000), tz));
  return out;
}

/**
 * Measured runs of the period. irrigation_runs first (all runs incl. manual);
 * dose_controller_runs when irrigation_runs has nothing (older installs).
 * @returns {{ source, runs: [{ id, type, status, started_at, local_date, water_l, tanks: {tank_id: L}, ec_ms, ph, acid_s, achieved_ratio }] }}
 */
function loadMeasuredRuns(db, { period = 'today', nowMs = Date.now(), tz = 'UTC' } = {}) {
  let runs = [];
  const mapIrr = (r) => {
    const d = parseJson(r.detail_json, {});
    const tanks = {};
    for (const t of (Array.isArray(d.tanks) ? d.tanks : [])) if (t && t.tank_id != null) tanks[t.tank_id] = Number(t.dosed_l) || 0;
    return {
      id: r.id, source: 'irrigation_runs', type: r.type, status: r.status, started_at: r.started_at, local_date: r.local_date,
      water_l: Number(r.water_l) || 0, tanks,
      ec_ms: d.ec_ms && d.ec_ms.avg != null ? Number(d.ec_ms.avg) : null,
      ec_samples: d.ec_ms ? d.ec_ms.samples || 0 : 0,
      ph: d.ph && d.ph.avg != null ? Number(d.ph.avg) : null,
      acid_s: d.acid_s != null ? Number(d.acid_s) : null,
      achieved_ratio: d.achieved_ratio ?? null,
      uncontrolled_dosing: !!r.uncontrolled_dosing,
      dose_controller_run_id: r.dose_controller_run_id ?? null,
    };
  };
  try {
    if (period === 'last_run') {
      const r = db.prepare(`
        SELECT * FROM irrigation_runs WHERE water_l >= 50 AND detail_json LIKE '%dosed_l%'
        ORDER BY started_at DESC LIMIT 20
      `).all().map(mapIrr).find(x => Object.values(x.tanks).some(v => v > 0));
      runs = r ? [r] : [];
    } else {
      const dates = periodDates(period, nowMs, tz);
      runs = db.prepare(`SELECT * FROM irrigation_runs WHERE local_date IN (${dates.map(() => '?').join(',')}) AND water_l > 0 ORDER BY started_at`)
        .all(...dates).map(mapIrr);
    }
  } catch (_) { runs = []; }
  if (runs.length) return { source: 'irrigation_runs', runs };

  // Fallback: closed-loop dose controller records
  const mapDc = (r) => {
    const tanks = {};
    for (const t of parseJson(r.tanks_json, [])) if (t && t.tank_id != null) tanks[t.tank_id] = Number(t.dosed_l) || 0;
    return {
      id: r.id, source: 'dose_controller_runs', type: 'automated', status: r.status, started_at: r.started_at, local_date: r.local_date,
      water_l: Number(r.water_l) || 0, tanks,
      ec_ms: r.ec_avg != null ? Number(r.ec_avg) / 1000 : null, ec_samples: r.ec_samples || 0,
      ph: r.ph_avg != null ? Number(r.ph_avg) : null, acid_s: r.acid_s != null ? Number(r.acid_s) : null,
      achieved_ratio: null, uncontrolled_dosing: false, dose_controller_run_id: r.id,
    };
  };
  try {
    if (period === 'last_run') {
      const r = db.prepare("SELECT * FROM dose_controller_runs WHERE water_l > 0 AND status <> 'running' ORDER BY started_at DESC LIMIT 1").get();
      runs = r ? [mapDc(r)] : [];
    } else {
      const dates = periodDates(period, nowMs, tz);
      runs = db.prepare(`SELECT * FROM dose_controller_runs WHERE local_date IN (${dates.map(() => '?').join(',')}) AND water_l > 0 ORDER BY started_at`)
        .all(...dates).map(mapDc);
    }
  } catch (_) { runs = []; }
  return { source: runs.length ? 'dose_controller_runs' : null, runs };
}

/** Water-weighted average of a per-run field (runs where it is present). */
function weighted(runs, field, weightField = 'water_l') {
  let s = 0; let w = 0;
  for (const r of runs) {
    const v = r[field];
    const wt = Number(r[weightField]) || 0;
    if (v === null || v === undefined || !Number.isFinite(Number(v)) || wt <= 0) continue;
    s += Number(v) * wt; w += wt;
  }
  return w > 0 ? s / w : null;
}

/**
 * Full feed report for the UI + the advisor.
 * @param opts.profile   resolved profile (CropProfileService.resolve): stage, targets, plants, protocol
 * @param opts.period    'last_run' | 'today' | '7d'
 * @param opts.protocolData  crop_protocols.data (null = none)
 * @param opts.library   (name) => ingredient row | null
 */
function buildFeedReport(db, { profile = null, period = 'today', nowMs = Date.now(), tz = 'UTC', protocolData = null, library = null } = {}) {
  const tanks = loadCurrentTanks(db);
  const nutrientTanks = tanks.filter(t => t.role === 'nutrient');
  const cfg = doseConfig(db);
  const ratioCfg = (cfg.nutrients && cfg.nutrients.ratio) || {};
  const ratioOf = (t) => Number(ratioCfg[t.tank_id] ?? ratioCfg[String(t.tank_id)]) || null;

  const measured = loadMeasuredRuns(db, { period, nowMs, tz });
  const runs = measured.runs;
  const water = runs.reduce((a, r) => a + r.water_l, 0);
  const dosedBy = {};
  for (const r of runs) for (const [id, l] of Object.entries(r.tanks)) dosedBy[id] = (dosedBy[id] || 0) + l;
  const anyDosed = Object.values(dosedBy).some(v => v > 0);

  let basis;
  let mix;
  let recipeSegments = null;
  if (water > 0 && anyDosed) {
    basis = 'measured';
    // Each run is fed the recipe its tanks held when it started (refill history): litres are
    // summed per (tank, mixture) and every part is mixed at its own stock concentration.
    const history = loadRecipeHistory(db);
    const itemsCache = new Map();
    const itemsOf = (mixtureId) => {
      if (!itemsCache.has(mixtureId)) itemsCache.set(mixtureId, M.loadMixtureItems(db, mixtureId).map(it => ({ ...it, composition: M.parseComposition(it.composition) })));
      return itemsCache.get(mixtureId);
    };
    const segs = new Map(); // `${tank_id}:${mixture_id}` -> { tank, mixture_id, dosed_l, runs, from_ms }
    for (const r of runs) {
      const startMs = tsMs(r.started_at);
      for (const t of nutrientTanks) {
        const l = Number(r.tanks[t.tank_id]) || 0;
        if (!(l > 0)) continue;
        const at = mixtureAt(history, t, startMs);
        const key = `${t.tank_id}:${at.mixture_id}`;
        if (!segs.has(key)) segs.set(key, { tank: t, mixture_id: at.mixture_id, refill_id: at.refill_id, from_ms: at.from_ms, dosed_l: 0, runs: 0 });
        const sg = segs.get(key);
        sg.dosed_l += l; sg.runs += 1;
      }
    }
    const parts = [...segs.values()].map(sg => ({
      tank: sg.mixture_id === sg.tank.mixture_id ? sg.tank : { ...sg.tank, mixture_id: sg.mixture_id, items: itemsOf(sg.mixture_id) },
      fraction: sg.dosed_l / water,
      dosed_l: sg.dosed_l,
    }));
    const raw = mixPpm(parts);
    // per tank: the sum over its recipes
    const perTank = nutrientTanks.map(t => {
      const own = raw.per_tank.filter(p => p.tank_id === t.tank_id);
      const ppm = {};
      for (const p of own) for (const [el, v] of Object.entries(p.ppm)) ppm[el] = (ppm[el] || 0) + v;
      const dosed = dosedBy[t.tank_id] || 0;
      return { tank_id: t.tank_id, letter: t.letter, name: t.name, dosed_l: r2(dosed), ratio: dosed > 0 ? Math.round(water / dosed) : null, ppm: M.round(ppm, 3) };
    });
    mix = { ppm: raw.ppm, per_tank: perTank, assumptions: raw.assumptions };
    const mixNames = new Map();
    const nameOf = (id) => {
      if (!mixNames.has(id)) { try { mixNames.set(id, (db.prepare('SELECT name FROM fertigation_mixtures WHERE id = ?').get(id) || {}).name || null); } catch (_) { mixNames.set(id, null); } }
      return mixNames.get(id);
    };
    recipeSegments = [...segs.values()].map(sg => ({
      tank_id: sg.tank.tank_id, letter: sg.tank.letter, mixture_id: sg.mixture_id, mixture_name: nameOf(sg.mixture_id),
      current: sg.mixture_id === sg.tank.mixture_id, since: sg.from_ms !== null ? new Date(sg.from_ms).toISOString() : null,
      refill_id: sg.refill_id, runs: sg.runs, dosed_l: r2(sg.dosed_l),
    })).sort((a, b) => (a.tank_id - b.tank_id) || String(a.since || '').localeCompare(String(b.since || '')));
  } else {
    basis = 'configured_ratio';
    mix = mixPpm(nutrientTanks.map(t => ({ tank: t, fraction: ratioOf(t) ? 1 / ratioOf(t) : 0 })));
  }
  const configured = mixPpm(nutrientTanks.map(t => ({ tank: t, fraction: ratioOf(t) ? 1 / ratioOf(t) : 0 })));

  const ecCalc = ecEstimate(mix.ppm);
  const ecMeasured = weighted(runs.filter(r => Object.values(r.tanks).some(v => v > 0)), 'ec_ms');
  const phMeasured = weighted(runs.filter(r => Object.values(r.tanks).some(v => v > 0)), 'ph');
  const acidS = runs.reduce((a, r) => a + (Number(r.acid_s) || 0), 0);
  const days = new Set(runs.map(r => r.local_date)).size || (period === '7d' ? 7 : 1);

  // plants / water per plant
  const plants = profile && profile.plants ? profile.plants : { total: null, per_section: null, source: null };
  // mL per plant per day (a single run: mL per plant for that run)
  const mlPerPlant = plants.total > 0 && water > 0 ? Math.round((period === 'last_run' ? water : water / days) / plants.total * 1000) : null;
  const mlPerPlantDay = period === 'last_run' ? null : mlPerPlant;

  const stage = profile ? profile.stage : null;
  const stageTargets = profile && profile.stage_targets ? profile.stage_targets[stage && stage.effective] || null : null;
  const elementTargets = profile && profile.element_targets ? (profile.element_targets[stage && stage.effective] || []) : [];

  const sourceWaterEc = profile && profile.source_water_ec != null ? Number(profile.source_water_ec) : null;
  const ecWithWater = sourceWaterEc != null ? r2(ecCalc.ec_ms_cm + sourceWaterEc) : null;

  const comparisons = {
    elements: compareElements(mix.ppm, elementTargets),
    ec: compareBand(ecMeasured, stageTargets ? { min: stageTargets.ec_min, target: stageTargets.ec_target, max: stageTargets.ec_max } : null),
    ph: compareBand(phMeasured, stageTargets ? { min: stageTargets.ph_min, max: stageTargets.ph_max } : null),
    ml_per_plant_day: period === 'last_run'
      ? { status: 'unknown', severity: 'unknown', reason: 'single_run', pct: null }
      : period === 'today' && mlPerPlantDay !== null
      ? { status: 'unknown', severity: 'unknown', reason: 'partial_day', pct: null }
      : compareBand(mlPerPlantDay, stageTargets ? { min: stageTargets.ml_min, target: stageTargets.ml_target, max: stageTargets.ml_max } : null),
    drain: { status: 'unknown', severity: 'unknown', reason: 'not_measured', pct: null },
  };

  // Protocol recipe for the current stage (facts: its ppm at the design dilution and at the configured ratio)
  let protocol = null;
  if (protocolData && stage && stage.effective) {
    const recipeKey = (protocolData.stage_recipe || {})[stage.effective] || stage.effective;
    const CP = require('./cropProtocol');
    const pTanks = CP.recipeTanks(protocolData, recipeKey, library || (() => null));
    if (pTanks.length) {
      const dil = CP.recipeDilution(protocolData, recipeKey);
      const design = dil.dilution;
      const pDesign = mixPpm(pTanks.map(t => ({ tank: t, fraction: 1 / design })));
      const ratioByLetter = {};
      for (const t of nutrientTanks) ratioByLetter[t.letter] = ratioOf(t);
      const pConfigured = mixPpm(pTanks.map(t => ({ tank: t, fraction: ratioByLetter[t.letter] ? 1 / ratioByLetter[t.letter] : 0 })));
      protocol = {
        recipe: recipeKey,
        design_dilution: design,
        dilution_source: dil.source,
        ppm_at_design: pDesign.ppm,
        ec_at_design: ecEstimate(pDesign.ppm).ec_ms_cm,
        ppm_at_configured_ratio: pConfigured.ppm,
        ec_at_configured_ratio: ecEstimate(pConfigured.ppm).ec_ms_cm,
        tanks_vs_protocol: compareRecipes(nutrientTanks, pTanks),
        analysis_sources: [...new Set(pTanks.flatMap(t => t.items.map(i => `${i.label}: ${i.analysis_source}`)))],
      };
    }
  }

  const lastRun = runs.length ? runs[runs.length - 1] : null;
  return {
    period,
    period_dates: period === 'last_run' ? (lastRun ? [lastRun.local_date] : []) : periodDates(period, nowMs, tz),
    computed_at: new Date(nowMs).toISOString(),
    basis,
    measured_source: measured.source,
    runs_count: runs.length,
    days_with_runs: new Set(runs.map(r => r.local_date)).size,
    last_run_at: lastRun ? lastRun.started_at : null,
    water_l: r1(water),
    // measured basis: which recipe each tank's litres were mixed with (a refill inside the
    // period splits it); recipe_changed = a run of the period was fed a recipe that is not current
    recipe_segments: recipeSegments,
    recipe_changed_in_period: !!(recipeSegments && recipeSegments.some(sg => !sg.current)),
    tanks: nutrientTanks.map(t => {
      const pt = mix.per_tank.find(p => p.tank_id === t.tank_id) || {};
      return {
        tank_id: t.tank_id, letter: t.letter, name: t.name, mixture_id: t.mixture_id, mixture_name: t.mixture_name,
        water_base_liters: t.water_base_liters,
        items: t.items.map(i => ({ name: i.name, amount: i.amount, unit: i.unit, composition: i.composition })),
        stock_mg_per_l: M.round(M.stockElementalMgPerL(t.items, t.water_base_liters), 1),
        dosed_l: basis === 'measured' ? r2(dosedBy[t.tank_id] || 0) : null,
        achieved_ratio: basis === 'measured' && dosedBy[t.tank_id] > 0 ? Math.round(water / dosedBy[t.tank_id]) : null,
        configured_ratio: ratioOf(t),
        ppm: pt.ppm || {},
      };
    }),
    ppm: mix.ppm,
    configured_ratio_ppm: configured.ppm,
    ratios: elementRatios(mix.ppm),
    ec: {
      calc: ecCalc,
      calc_plus_source_water_ms_cm: ecWithWater,
      source_water_ec_ms_cm: sourceWaterEc,
      measured_ms_cm: r2(ecMeasured),
      measured_minus_calc_ms_cm: ecMeasured != null ? r2(ecMeasured - ecCalc.ec_ms_cm) : null,
    },
    ph_measured: r2(phMeasured),
    acid_s: r1(acidS),
    acid_est_l: r2(acidS / 60 * (Number(cfg.ph && cfg.ph.acid_lpm_estimate) || 0)),
    acid_note: 'acid volume is an estimate (acid valve not metered)',
    plants,
    ml_per_plant_day: mlPerPlantDay,
    ml_per_plant_run: period === 'last_run' ? mlPerPlant : null,
    stage: stage ? { effective: stage.effective, days_after_transplant: stage.days_after_transplant } : null,
    targets: { stage: stageTargets, elements: elementTargets },
    comparisons,
    protocol,
    assumptions: mix.assumptions,
    runs: runs.map(r => ({
      id: r.id, type: r.type, status: r.status, started_at: r.started_at, water_l: r1(r.water_l),
      ec_ms: r2(r.ec_ms), ph: r2(r.ph), acid_s: r1(r.acid_s), achieved_ratio: r.achieved_ratio,
      dosed: Object.fromEntries(Object.entries(r.tanks).map(([k, v]) => [k, r2(v)])),
      uncontrolled_dosing: r.uncontrolled_dosing,
    })),
  };
}

module.exports = {
  MACROS,
  MICROS,
  TARGET_ELEMENTS,
  EQ,
  tankLetter,
  tankStock,
  mixPpm,
  cationEc,
  ecEstimate,
  elementRatios,
  compareBand,
  compareElements,
  compareRecipes,
  loadCurrentTanks,
  loadMeasuredRuns,
  loadRecipeHistory,
  mixtureAt,
  doseConfig,
  periodDates,
  buildFeedReport,
};
