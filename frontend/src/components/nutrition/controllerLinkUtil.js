/**
 * Pure helpers for the "Follow crop targets" dose-controller link (operator decision
 * 2026-09-30). No React; labels are i18n keys under nutrition:link.*.
 */

/** Controller field (backend dotted path) -> i18n key suffix (nutrition:link.field.<key>). */
export const FIELD_KEY = {
  'ph.setpoint': 'phSetpoint',
  'ph.floor_ph': 'phFloor',
  'nutrients.ratio': 'ratio',
  'nutrients.ec_trim.target_us': 'trimTarget',
  'nutrients.ec_trim.water_us': 'trimWater',
  'ec_check.raw_water_ec_us': 'rawWater',
  'nutrients.ec_trim.enabled': 'trimEnabled',
};

export const PROPOSAL_STATUSES = ['pending', 'approved', 'applied', 'rejected', 'superseded', 'cancelled', 'failed'];
export const TRIGGERS = ['link_enabled', 'targets_changed', 'source_water_changed', 'stage_changed', 'controller_changed', 'protocol_changed'];
export const BLOCK_REASONS = [
  'source_water_missing', 'no_ec_target', 'no_protocol', 'no_protocol_recipe', 'protocol_ec_unknown',
  'source_water_exceeds_target', 'factor_out_of_range', 'ratio_out_of_bounds', 'no_tanks',
  'no_ph_target', 'cross_check', 'no_stage_targets',
];
export const DIFF_REASONS = ['ph_midpoint', 'ph_target', 'ph_floor', 'ec_ratio', 'trim_target', 'trim_water', 'raw_water'];

const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

/**
 * Where a controller value comes from -> shared provenance kind (src/ui/Provenance.jsx).
 *   crop_link            calculated from the crop targets (operator-set) by an approved proposal
 *   operator             edited by the farm team (dose-controller settings)
 *   ec_trim_check        switched by the farm team with a recorded SEKO check
 *   operator_unrecorded  set by the farm team before origins were recorded
 *   default              SenseHub default value (never set, never measured)
 */
export function originProvenance(origin) {
  switch (origin) {
    case 'crop_link': return { kind: 'calculated', from: 'operator', detailKey: 'cropLink' };
    case 'operator': return { kind: 'operator', from: null, detailKey: 'operator' };
    case 'ec_trim_check': return { kind: 'operator', from: null, detailKey: 'trimCheck' };
    case 'operator_unrecorded': return { kind: 'operator', from: null, detailKey: 'unrecorded' };
    case 'default': return { kind: 'calculated', from: null, detailKey: 'default' };
    default: return null;
  }
}

/** Provenance of the ratio row: the tanks' common origin, or 'operator' when mixed. */
export function ratioOrigin(provenance, tankIds) {
  const list = (tankIds || []).map(id => provenance && provenance[`nutrients.ratio.${id}`]).filter(Boolean);
  if (!list.length) return null;
  const first = list[0];
  if (list.every(p => p.origin === first.origin && (p.proposal_id ?? null) === (first.proposal_id ?? null))) return first;
  return { origin: 'operator', mixed: true };
}

/** Uniform ratio of {tank: ratio} or null when the tanks differ / are missing. */
export function uniformRatio(ratio) {
  const vals = Object.values(ratio || {}).map(Number);
  if (!vals.length || vals.some(v => !Number.isFinite(v) || v <= 0)) return null;
  return vals.every(v => Math.abs(v - vals[0]) < 1e-9) ? vals[0] : null;
}

/**
 * Display text of a controller value (Western digits via fmt). µS/cm values are shown
 * in mS/cm like the rest of the nutrition pages. null -> '—' (never a fake value).
 */
export function fieldText(field, value, fmt, letters = {}) {
  if (field === 'nutrients.ratio') {
    if (!value || typeof value !== 'object') return isNum(value) ? `1:${fmt.int(Number(value))}` : '—';
    const u = uniformRatio(value);
    const ids = Object.keys(value);
    const span = ids.length > 1 ? ` (${letters[ids[0]] || ids[0]}–${letters[ids[ids.length - 1]] || ids[ids.length - 1]})` : '';
    if (u !== null) return `1:${fmt.int(u)}${span}`;
    return ids.map(id => `${letters[id] || id} ${isNum(value[id]) ? `1:${fmt.int(Number(value[id]))}` : '—'}`).join(' · ');
  }
  if (!isNum(value)) return '—';
  if (field === 'ph.setpoint' || field === 'ph.floor_ph') return fmt.number(Number(value), { decimals: 2 });
  if (field.endsWith('_us')) return `${fmt.number(Number(value) / 1000, { decimals: 2 })} mS/cm`;
  return fmt.number(Number(value), { decimals: 2 });
}

/** Match mark for one comparison row: ok (match), caution (differs), unknown (not available). */
export const matchState = (row) => (!row || !row.available ? 'unknown' : row.match ? 'ok' : 'caution');

/** Proposal status -> status shape (StatusMark). */
export function proposalShape(status) {
  if (status === 'applied') return 'ok';
  if (status === 'pending' || status === 'approved') return 'caution';
  if (status === 'failed') return 'alarm';
  return 'unknown';
}

/** SEKO vs handheld deviation in % (1 decimal) or null. */
export function deviationPct(handheld, seko) {
  const h = Number(handheld); const s = Number(seko);
  if (!Number.isFinite(h) || !Number.isFinite(s) || h <= 0) return null;
  return Math.round((Math.abs(s - h) / h) * 1000) / 10;
}

/** Best-fit element row -> status shape: unreachable = alarm, out of band = caution, else ok. */
export function bestFitShape(el) {
  if (!el) return 'unknown';
  if (el.unreachable) return 'alarm';
  return el.status === 'ok' ? 'ok' : 'caution';
}
