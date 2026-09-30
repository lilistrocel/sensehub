/**
 * Pure helpers for the Crop & Nutrition page (no React, unit-tested).
 * Labels are i18n keys; components translate them.
 */

export const STAGES = ['seedling', 'vegetative', 'flowering', 'fruiting', 'ripening', 'harvested'];
export const ELEMENTS = ['N', 'P', 'K', 'Ca', 'Mg', 'S', 'Fe', 'Mn', 'Zn', 'B', 'Cu', 'Mo'];
export const MICROS = ['Fe', 'Mn', 'Zn', 'B', 'Cu', 'Mo'];
export const PERIODS = ['last_run', 'today', '7d'];
export const VS_PROTOCOL = ['agrees', 'extends', 'differs'];

/** Decimals to show for a ppm value of an element. */
export const ppmDecimals = (el) => (el === 'Mo' ? 3 : MICROS.includes(el) ? 2 : 1);

/**
 * Status (calculator comparison or advisor verdict) → shape used by StatusMark.
 * ok → ok (filled circle); low/high → caution (triangle) or alarm (square) by
 * severity; unknown / missing → unknown (hollow, never green).
 */
export function shapeOf(status, severity) {
  if (status === 'ok') return 'ok';
  if (status === 'low' || status === 'high') return severity === 'alarm' ? 'alarm' : 'caution';
  if (status === 'caution' || status === 'alarm') return status;
  return 'unknown';
}

/** Card rail for an overall state. */
export const railOf = (status) => ({ ok: 'ok', caution: 'caution', alarm: 'alarm' }[status] || 'idle');

/** Warning severity → state for pills / rails. */
export const warningState = (sev) => ({ critical: 'alarm', warning: 'caution' }[sev] || 'idle');

/** Stages that have targets in the profile, in growth order (current stage first when present). */
export function targetStages(profile) {
  if (!profile) return [];
  const have = new Set([
    ...Object.keys(profile.stage_targets || {}),
    ...Object.keys(profile.element_targets || {}),
    ...(profile.stage_timeline || []).map(e => e.stage),
  ]);
  return STAGES.filter(s => have.has(s));
}

/** Date (YYYY-MM-DD) of a timeline entry. */
export function stageDate(transplantDate, fromDay) {
  if (!transplantDate || fromDay === null || fromDay === undefined || fromDay === '') return null;
  const t = Date.parse(`${transplantDate}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return new Date(t + Number(fromDay) * 86400000).toISOString().slice(0, 10);
}

/** '' / null / undefined → null, else a finite number, else NaN (invalid). */
export function parseNum(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/** Only the fields that changed (numbers parsed), for a PUT body. */
export function diffFields(original, draft, numericKeys = []) {
  const out = {};
  for (const [k, v] of Object.entries(draft)) {
    const val = numericKeys.includes(k) ? parseNum(v) : (v === '' ? null : v);
    const before = original ? original[k] ?? null : null;
    if (val !== before) out[k] = val;
  }
  return out;
}

/** First numeric field of a draft that does not parse (for inline validation). */
export function invalidField(draft, numericKeys) {
  return numericKeys.find(k => Number.isNaN(parseNum(draft[k]))) || null;
}

/** Days since an ISO time (for "stale advice" labels). */
export function ageDays(iso, now = Date.now()) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (now - t) / 86400000 : null;
}

/** An advice is stale when older than its cadence (weekly → 8 days). */
export const isStaleAdvice = (iso, now = Date.now(), maxDays = 8) => {
  const a = ageDays(iso, now);
  return a !== null && a > maxDays;
};

/** Range text pieces "min – max" (target) for display; returns null parts as null. */
export function band(min, target, max) {
  return { min: min ?? null, target: target ?? null, max: max ?? null, empty: min == null && target == null && max == null };
}

/**
 * Do the element ppm targets correspond to the stage's input EC target?
 * corr = profile.element_targets_ec[stage]. ok within ±0.05 mS/cm, caution
 * otherwise, unknown when either side is missing (never green by default).
 */
export function ecCorrespondenceState(corr, ecTarget, tol = 0.05) {
  if (!corr || corr.total_ec_ms_cm === null || corr.total_ec_ms_cm === undefined) return 'unknown';
  if (ecTarget === null || ecTarget === undefined || ecTarget === '') return 'unknown';
  return Math.abs(Number(corr.total_ec_ms_cm) - Number(ecTarget)) <= tol + 1e-9 ? 'ok' : 'caution';
}

// ---------------------------------------------------------------------------
// Provenance (operator request 2026-09-30): which shared provenance kind
// (src/ui/Provenance.jsx) a value on the Crop & Nutrition page gets.
// ---------------------------------------------------------------------------

const sameNum = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && Math.abs(Number(a) - Number(b)) < 1e-9;

/**
 * A stage-target row ([min, target, max] with nulls) against the protocol's values
 * for the same row. Every set value equal to the protocol → 'protocol'; any value
 * that differs, or a row the protocol has no value for → 'operator' (hand-entered).
 * `edited` = indexes (0 min, 1 target, 2 max) that differ from the protocol.
 * null when the row has no value at all.
 */
export function stageRowProvenance(values, protoValues) {
  const vals = values || [];
  const set = [0, 1, 2].filter(i => vals[i] !== null && vals[i] !== undefined && vals[i] !== '');
  if (!set.length) return null;
  const proto = protoValues || [];
  const edited = set.filter(i => !sameNum(vals[i], proto[i]));
  return { kind: edited.length ? 'operator' : 'protocol', edited };
}

/**
 * An element-target row (crop_element_targets with basis_* + manual, 2026-09-29):
 * hand-edited → 'operator'; protocol prefill (protocol recipe × SenseHub design
 * dilution + bands) → calculated from protocol; scale-to-EC → calculated from
 * protocol, scaled. null for no row.
 */
export function elementTargetProvenance(row) {
  if (!row) return null;
  if (row.manual) return { kind: 'operator', from: null, basis: 'manual' };
  if (row.basis_source === 'scaled') return { kind: 'calculated', from: 'protocol', basis: 'scaled', ec: row.basis_ec ?? null, factor: row.basis_factor ?? null };
  if (row.basis_source === 'protocol') return { kind: 'calculated', from: 'protocol', basis: 'protocol' };
  return { kind: 'operator', from: null, basis: 'manual' };
}

/** Plant count source (profile.plants.source) → provenance kind. */
export const plantsProvenance = (source) => ({ entered: 'operator', density_area: 'calculated', estimated_from_flow: 'calculated' }[source] || null);

/** True when at least one verdict / warning / recommendation carries a basis (advices from 2026-09-30 on). */
export function adviceHasBasis(a) {
  if (!a) return false;
  return [...(a.per_element || []), ...(a.warnings || []), ...(a.recommendations || [])]
    .some(x => x && Array.isArray(x.basis) && x.basis.length > 0);
}
