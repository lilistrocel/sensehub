/**
 * Pure parsing / validation for the irrigation-monitor MQTT contract.
 *
 * Topic contract (vendor doc, schema v=1), prefix farm/<farmId>/:
 *   status              {v, state: online|offline}          QoS1 retained (offline = LWT)
 *   meta                free-form field descriptions         QoS1 retained
 *   flowmeter/live      flow_lph, net_total_m3, signal_*, error_flags   QoS0
 *   dosing/live         tanks: [{id, consumed_l, rate_lph|null}]       QoS0
 *   irrigation/state    {active, since}                      QoS1 retained
 *   irrigation/report   {cycle_id, start, end, duration_s, water_m3|null, dosing[]}  QoS1 retained
 *
 * Rules: `v` must be 1 (anything else is ignored, not guessed at); numbers must be
 * finite; a null tank rate means "not measured" and is never turned into 0.
 * Nothing in here touches the DB, the clock or the network.
 */

const SCHEMA_VERSION = 1;
const MAX_PAYLOAD_BYTES = 128 * 1024;
// Device timestamps are trusted only inside this window around receive time.
const TS_MAX_PAST_MS = 10 * 60 * 1000;
const TS_MAX_FUTURE_MS = 2 * 60 * 1000;
const FARM_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const CYCLE_ID_RE = /^\d{8}T\d{6}$/;

const KINDS = {
  status: 'status',
  meta: 'meta',
  'flowmeter/live': 'flowmeter',
  'dosing/live': 'dosing',
  'irrigation/state': 'irrigation_state',
  'irrigation/report': 'irrigation_report',
};

class PayloadError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** 'farm/1021/flowmeter/live' -> { farmId: '1021', kind: 'flowmeter' } | null */
function parseTopic(topic) {
  if (typeof topic !== 'string') return null;
  const parts = topic.split('/');
  if (parts.length < 3 || parts[0] !== 'farm') return null;
  const farmId = parts[1];
  if (!FARM_ID_RE.test(farmId)) return null;
  const kind = KINDS[parts.slice(2).join('/')];
  if (!kind) return null;
  return { farmId, kind };
}

const isFiniteNumber = (x) => typeof x === 'number' && Number.isFinite(x);

/** Parse the raw buffer into an object and check the schema version. */
function parseEnvelope(buf) {
  const len = buf == null ? 0 : (Buffer.isBuffer(buf) ? buf.length : Buffer.byteLength(String(buf)));
  if (len === 0) throw new PayloadError('empty', 'empty payload');
  if (len > MAX_PAYLOAD_BYTES) throw new PayloadError('too_large', `payload ${len} B > ${MAX_PAYLOAD_BYTES} B`);
  let obj;
  try {
    obj = JSON.parse(Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf));
  } catch (e) {
    throw new PayloadError('bad_json', 'payload is not valid JSON');
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new PayloadError('bad_shape', 'payload is not a JSON object');
  if (obj.v !== SCHEMA_VERSION) throw new PayloadError('bad_version', `unsupported schema version v=${JSON.stringify(obj.v)}`);
  return obj;
}

/**
 * The device's `ts` (epoch ms) when it is sane (inside the window around
 * receive time), else the receive time. Returns { ms, source: 'device'|'receive' }.
 */
function pickTimestamp(obj, receivedMs) {
  const ts = obj && obj.ts;
  if (isFiniteNumber(ts) && ts >= receivedMs - TS_MAX_PAST_MS && ts <= receivedMs + TS_MAX_FUTURE_MS) {
    return { ms: Math.round(ts), source: 'device' };
  }
  return { ms: receivedMs, source: 'receive' };
}

function parseStatus(obj) {
  if (obj.state !== 'online' && obj.state !== 'offline') {
    throw new PayloadError('bad_field', `status.state must be online|offline, got ${JSON.stringify(obj.state)}`);
  }
  return { state: obj.state };
}

/**
 * Flow meter live sample. Invalid individual fields are dropped (and listed in
 * `invalid`) rather than recorded; a sample with no valid field is rejected.
 */
function parseFlowmeter(obj) {
  const out = {};
  const invalid = [];
  const take = (key, check) => {
    if (!(key in obj)) return;
    const v = obj[key];
    if (isFiniteNumber(v) && (!check || check(v))) out[key] = v;
    else invalid.push(key);
  };
  take('flow_lph');
  take('net_total_m3');
  take('signal_quality', v => v >= 0 && v <= 100);
  take('signal_up_pct', v => v >= 0 && v <= 100);
  take('signal_down_pct', v => v >= 0 && v <= 100);
  take('error_flags', v => Number.isInteger(v) && v >= 0);
  if (Object.keys(out).length === 0) throw new PayloadError('no_valid_fields', `flowmeter sample has no valid fields${invalid.length ? ` (invalid: ${invalid.join(',')})` : ''}`);
  return { values: out, invalid };
}

/** Dosing live sample: tanks[] with finite consumed_l / rate_lph; null rate = not measured. */
function parseDosing(obj) {
  if (!Array.isArray(obj.tanks)) throw new PayloadError('bad_field', 'dosing.tanks must be an array');
  const tanks = [];
  const invalid = [];
  const seen = new Set();
  for (const t of obj.tanks) {
    if (!t || typeof t !== 'object' || !Number.isInteger(t.id) || t.id < 1 || t.id > 32 || seen.has(t.id)) {
      invalid.push(`tank:${t && t.id}`);
      continue;
    }
    seen.add(t.id);
    const tank = { id: t.id, consumed_l: null, rate_lph: null };
    if (t.consumed_l === null || t.consumed_l === undefined) { /* not reported */ }
    else if (isFiniteNumber(t.consumed_l) && t.consumed_l >= 0) tank.consumed_l = t.consumed_l;
    else invalid.push(`tank${t.id}.consumed_l`);
    if (t.rate_lph === null || t.rate_lph === undefined) { /* null = not measured, never 0 */ }
    else if (isFiniteNumber(t.rate_lph) && t.rate_lph >= 0) tank.rate_lph = t.rate_lph;
    else invalid.push(`tank${t.id}.rate_lph`);
    tanks.push(tank);
  }
  if (!tanks.some(t => t.consumed_l !== null || t.rate_lph !== null)) {
    throw new PayloadError('no_valid_fields', 'dosing sample has no valid tank values');
  }
  tanks.sort((a, b) => a.id - b.id);
  return { tanks, invalid };
}

const isIsoDate = (s) => typeof s === 'string' && s.length <= 40 && Number.isFinite(Date.parse(s));

function parseIrrigationState(obj) {
  if (typeof obj.active !== 'boolean') throw new PayloadError('bad_field', 'irrigation.active must be boolean');
  if (!(obj.since === null || obj.since === undefined || isIsoDate(obj.since))) {
    throw new PayloadError('bad_field', 'irrigation.since must be ISO 8601 or null');
  }
  return { active: obj.active, since: obj.since || null };
}

function parseReport(obj) {
  if (typeof obj.cycle_id !== 'string' || !CYCLE_ID_RE.test(obj.cycle_id)) {
    throw new PayloadError('bad_field', `report.cycle_id must be YYYYMMDDTHHMMSS, got ${JSON.stringify(obj.cycle_id)}`);
  }
  if (!isIsoDate(obj.start) || !isIsoDate(obj.end)) throw new PayloadError('bad_field', 'report.start/end must be ISO 8601');
  if (!isFiniteNumber(obj.duration_s) || obj.duration_s < 0) throw new PayloadError('bad_field', 'report.duration_s must be a finite number >= 0');
  let water = null;
  if (obj.water_m3 !== null && obj.water_m3 !== undefined) {
    if (!isFiniteNumber(obj.water_m3)) throw new PayloadError('bad_field', 'report.water_m3 must be a finite number or null');
    water = obj.water_m3;
  }
  if (!Array.isArray(obj.dosing)) throw new PayloadError('bad_field', 'report.dosing must be an array');
  const dosing = [];
  const seen = new Set();
  for (const d of obj.dosing) {
    if (!d || !Number.isInteger(d.id) || d.id < 1 || d.id > 32 || seen.has(d.id)) {
      throw new PayloadError('bad_field', `report.dosing has an invalid/duplicate tank id ${JSON.stringify(d && d.id)}`);
    }
    seen.add(d.id);
    if (d.consumed_l !== null && !(isFiniteNumber(d.consumed_l) && d.consumed_l >= 0)) {
      throw new PayloadError('bad_field', `report.dosing tank ${d.id} consumed_l must be a finite number >= 0 or null`);
    }
    dosing.push({ id: d.id, consumed_l: d.consumed_l === undefined ? null : d.consumed_l });
  }
  dosing.sort((a, b) => a.id - b.id);
  return {
    cycle_id: obj.cycle_id,
    start: obj.start,
    end: obj.end,
    duration_s: Math.round(obj.duration_s),
    water_m3: water,
    dosing,
  };
}

/** Metric rows (name/value/unit) for the readings table from a parsed live sample. */
function flowmeterMetrics(values) {
  const m = [];
  if ('flow_lph' in values) m.push({ name: 'Flow Rate', value: values.flow_lph, unit: 'L/h' });
  if ('net_total_m3' in values) m.push({ name: 'Net Total', value: values.net_total_m3, unit: 'm³' });
  if ('signal_quality' in values) m.push({ name: 'Signal Quality', value: values.signal_quality, unit: '' });
  if ('error_flags' in values) m.push({ name: 'Error Flags', value: values.error_flags, unit: '' });
  return m;
}

function dosingMetrics(tanks) {
  const m = [];
  for (const t of tanks) {
    if (t.consumed_l !== null) m.push({ name: `Tank ${t.id} Consumed`, value: t.consumed_l, unit: 'L' });
    if (t.rate_lph !== null) m.push({ name: `Tank ${t.id} Rate`, value: t.rate_lph, unit: 'L/h' });
  }
  return m;
}

/** Display values (last_reading.values) — includes signal up/down, which are not stored as history. */
function flowmeterDisplayValues(values) {
  const out = {};
  for (const r of flowmeterMetrics(values)) out[r.name] = { value: r.value, unit: r.unit };
  if ('signal_up_pct' in values) out['Signal Up'] = { value: values.signal_up_pct, unit: '%' };
  if ('signal_down_pct' in values) out['Signal Down'] = { value: values.signal_down_pct, unit: '%' };
  return out;
}

module.exports = {
  SCHEMA_VERSION,
  MAX_PAYLOAD_BYTES,
  TS_MAX_PAST_MS,
  TS_MAX_FUTURE_MS,
  PayloadError,
  parseTopic,
  parseEnvelope,
  pickTimestamp,
  parseStatus,
  parseFlowmeter,
  parseDosing,
  parseIrrigationState,
  parseReport,
  flowmeterMetrics,
  dosingMetrics,
  flowmeterDisplayValues,
};
