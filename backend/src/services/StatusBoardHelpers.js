/**
 * StatusBoardHelpers - pure helpers behind GET /api/dashboard/status-board.
 *
 * No database or Modbus access here: every function takes plain equipment
 * rows (as stored in the `equipment` table) and a `nowMs` clock so the
 * grouping / unknown / stale logic can be unit-tested without a DB.
 */

const IRRIGATION_EQUIPMENT_IDS = new Set([1, 2]);

// Ordered: first regex that matches a channel label wins.
const GROUP_DEFS = [
  { key: 'big_fans',      label: 'Big fans',      re: /big fan/i },
  { key: 'small_fans',    label: 'Small fans',    re: /small fan/i },
  { key: 'circular_fans', label: 'Circular fans', re: /circular fan/i },
  { key: 'chiller_pads',  label: 'Chiller pads',  re: /chiller pad/i },
  { key: 'drain_pumps',   label: 'Drain pumps',   re: /drain pump/i },
  { key: 'shades_open',   label: 'Shades open',   re: /open .*shade/i },
  { key: 'shades_close',  label: 'Shades close',  re: /close .*shade/i },
  { key: 'irrigation',    label: 'Irrigation' },
  { key: 'other',         label: 'Other' },
];

// Climate tiles: which equipment/metric feeds each key. `sources` with more
// than one entry are averaged (substrate temperature = mean of far + near).
const CLIMATE_SPEC = [
  { key: 'temp_shielded',          label: 'Air temp (shielded)',    sources: [{ equipment_id: 8,  metric: 'Temperature' }] },
  { key: 'temp_exposed',           label: 'Air temp (exposed)',     sources: [{ equipment_id: 9,  metric: 'Temperature' }] },
  { key: 'rh',                     label: 'Relative humidity',      sources: [{ equipment_id: 8,  metric: 'Humidity' }] },
  { key: 'vpd_leaf',               label: 'VPD (leaf)',             sources: [{ equipment_id: 8,  metric: 'VPD Leaf' }] },
  { key: 'substrate_temp',         label: 'Substrate temp',         sources: [{ equipment_id: 7,  metric: 'Substrate Temperature' }, { equipment_id: 12, metric: 'Substrate Temperature' }] },
  { key: 'substrate_moisture_far', label: 'Substrate moisture (far)',  sources: [{ equipment_id: 7,  metric: 'Substrate Moisture' }] },
  { key: 'substrate_moisture_near',label: 'Substrate moisture (near)', sources: [{ equipment_id: 12, metric: 'Substrate Moisture' }] },
  { key: 'pore_ec_far',            label: 'Pore EC (far)',          sources: [{ equipment_id: 7,  metric: 'Pore EC' }] },
  { key: 'pore_ec_near',           label: 'Pore EC (near)',         sources: [{ equipment_id: 12, metric: 'Pore EC' }] },
  { key: 'water_ph',               label: 'Water pH',               sources: [{ equipment_id: 17, metric: 'pH' }] },
  { key: 'water_ec',               label: 'Water EC',               sources: [{ equipment_id: 17, metric: 'Water EC' }] },
  { key: 'water_temp',             label: 'Water temp',             sources: [{ equipment_id: 17, metric: 'Water Temperature' }] },
];

const DEFAULT_STALE_MS = 5 * 60 * 1000;
// A reading is stale after STALE_POLL_MULTIPLIER missed polls (but never
// sooner than MIN_STALE_MS), so one dropped cycle does not flip a tile.
const STALE_POLL_MULTIPLIER = 3;
const MIN_STALE_MS = 90 * 1000;

/** Staleness limit (ms) for a device polled every pollMs (5 min when unknown). */
function staleLimitMs(pollMs) {
  const p = Number(pollMs);
  if (!(p > 0)) return DEFAULT_STALE_MS;
  return Math.max(STALE_POLL_MULTIPLIER * p, MIN_STALE_MS);
}

/**
 * Parse a stored timestamp. SQLite datetime('now') yields 'YYYY-MM-DD HH:MM:SS'
 * (UTC, no zone marker); the polling service stores ISO strings with 'Z'.
 * Returns epoch ms or null.
 */
function parseTs(s) {
  if (!s) return null;
  if (s instanceof Date) return Number.isNaN(s.getTime()) ? null : s.getTime();
  let str = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(str)) str = str.replace(' ', 'T') + 'Z';
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(str)) str += 'Z';
  const ms = Date.parse(str);
  return Number.isNaN(ms) ? null : ms;
}

function toIso(s) {
  const ms = parseTs(s);
  return ms === null ? null : new Date(ms).toISOString();
}

function parseJson(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch (e) { return fallback; }
}

/** Which relayGroups bucket a channel belongs to. */
function groupKeyForChannel(label, equipmentId) {
  const text = String(label || '');
  for (const g of GROUP_DEFS) {
    if (g.re && g.re.test(text)) return g.key;
  }
  if (IRRIGATION_EQUIPMENT_IDS.has(Number(equipmentId))) return 'irrigation';
  return 'other';
}

/** Mappings the board should not show: explicitly disabled, or an "Unused N" placeholder. */
function isMappingSkipped(mapping) {
  if (!mapping || mapping.enabled === false) return true;
  const label = mapping.label || mapping.name || '';
  return /^unused/i.test(String(label).trim());
}

/**
 * Why a relay channel's state cannot be trusted right now, or null when it can.
 * Order matters: 'disabled' > 'write_only' > 'offline' > 'stale'.
 */
function channelUnknownReason(equipment, nowMs = Date.now()) {
  if (!equipment) return 'missing';
  if (!equipment.enabled) return 'disabled';
  if (equipment.write_only) return 'write_only';
  if (equipment.status !== 'online') return 'offline';
  const pollMs = Number(equipment.polling_interval_ms) || 0;
  const lastMs = parseTs(equipment.last_communication);
  if (lastMs === null) return 'stale';
  if (nowMs - lastMs > staleLimitMs(pollMs)) return 'stale';
  return null;
}

/**
 * A reading is stale when older than 3x the device's poll interval, with a
 * 90 s floor (5 min when the interval is unknown).
 */
function isStale(tsMs, pollMs, nowMs = Date.now()) {
  if (tsMs === null || tsMs === undefined) return true;
  return nowMs - tsMs > staleLimitMs(pollMs);
}

/**
 * Build the relayGroups array.
 *
 * @param {Array<object>} equipmentRows - equipment rows (relay boards; other types are ignored)
 * @param {(equipmentId:number, channel:number)=>object|null} [lastEventFor]
 *        returns the newest relay_events row for a channel ({state, source, created_at, confirmed}) or null
 * @param {number} [nowMs]
 */
function buildRelayGroups(equipmentRows, lastEventFor = () => null, nowMs = Date.now()) {
  const groups = new Map(GROUP_DEFS.map(g => [g.key, { key: g.key, label: g.label, on: 0, total: 0, unknown: 0, channels: [] }]));

  for (const eq of equipmentRows || []) {
    if (!eq || eq.type !== 'relay') continue;
    const mappings = parseJson(eq.register_mappings, []);
    if (!Array.isArray(mappings)) continue;
    const lastReading = parseJson(eq.last_reading, {}) || {};
    const relayStates = (lastReading && lastReading.relayStates) || {};
    const unknownReason = channelUnknownReason(eq, nowMs);

    for (const m of mappings) {
      if (!m || m.type !== 'coil') continue;
      if (isMappingSkipped(m)) continue;
      const channel = parseInt(m.register ?? m.address, 10);
      if (!Number.isFinite(channel)) continue;
      const label = m.label || m.name || `Coil ${channel}`;
      const key = groupKeyForChannel(label, eq.id);
      const group = groups.get(key);

      let state = null;
      if (unknownReason === null) {
        const cached = relayStates[channel] ?? relayStates[String(channel)];
        state = typeof cached === 'boolean' ? cached : (cached === 1 ? true : cached === 0 ? false : null);
      }
      const last = lastEventFor(eq.id, channel) || null;
      // confirmed is false when the state is unknown, or when the most recent
      // write to this channel explicitly failed its read-back check.
      const confirmed = state !== null && !(last && last.confirmed === 0);

      group.channels.push({
        equipment_id: eq.id,
        equipment_name: eq.name,
        channel,
        label,
        state,
        confirmed,
        unknownReason: state === null ? (unknownReason || 'no_reading') : null,
        lastChangeTs: last ? toIso(last.created_at) : null,
        source: last ? (last.source || null) : null,
      });
      group.total++;
      if (state === true) group.on++;
      if (state === null) group.unknown++;
    }
  }

  return GROUP_DEFS.map(g => groups.get(g.key));
}

/**
 * Build the climate array from equipment rows. Disabled equipment is excluded
 * (its tiles are returned with value null so the key set is stable).
 */
function buildClimate(equipmentRows, nowMs = Date.now()) {
  const byId = new Map();
  for (const eq of equipmentRows || []) {
    if (!eq || !eq.enabled) continue;
    byId.set(Number(eq.id), eq);
  }

  return CLIMATE_SPEC.map(spec => {
    const found = [];
    for (const src of spec.sources) {
      const eq = byId.get(src.equipment_id);
      if (!eq) continue;
      const reading = parseJson(eq.last_reading, {}) || {};
      const values = reading.values || {};
      const entry = values[src.metric];
      const raw = entry && typeof entry === 'object' ? entry.value : entry;
      const num = raw === null || raw === undefined ? NaN : Number(raw);
      if (!Number.isFinite(num)) continue;
      const tsMs = parseTs(eq.last_communication);
      found.push({
        equipment_id: eq.id,
        metric: src.metric,
        value: num,
        unit: entry && typeof entry === 'object' ? (entry.unit || '') : '',
        tsMs,
        pollMs: Number(eq.polling_interval_ms) || null,
      });
    }

    if (found.length === 0) {
      return {
        key: spec.key, label: spec.label, value: null, unit: null,
        equipment_id: spec.sources.length === 1 ? spec.sources[0].equipment_id : spec.sources.map(s => s.equipment_id),
        metric: spec.sources[0].metric, ts: null, stale: true, pollMs: null,
      };
    }

    const value = found.reduce((a, f) => a + f.value, 0) / found.length;
    // Oldest contributing reading decides staleness.
    const oldest = found.reduce((a, f) => (a === null || (f.tsMs !== null && f.tsMs < a) ? f.tsMs : a), null);
    const pollMs = Math.max(...found.map(f => f.pollMs || 0)) || null;
    return {
      key: spec.key,
      label: spec.label,
      value: Math.round(value * 100) / 100,
      unit: found[0].unit,
      equipment_id: found.length === 1 ? found[0].equipment_id : found.map(f => f.equipment_id),
      metric: found[0].metric,
      ts: oldest === null ? null : new Date(oldest).toISOString(),
      stale: found.some(f => isStale(f.tsMs, f.pollMs, nowMs)),
      pollMs,
    };
  });
}

/** 'scheduler trigger executed ...' -> 'scheduler' */
function triggerTypeFromLogMessage(message) {
  const m = /^(\S+) trigger/i.exec(String(message || ''));
  return m ? m[1] : null;
}

module.exports = {
  GROUP_DEFS,
  CLIMATE_SPEC,
  IRRIGATION_EQUIPMENT_IDS,
  DEFAULT_STALE_MS,
  STALE_POLL_MULTIPLIER,
  MIN_STALE_MS,
  staleLimitMs,
  parseTs,
  toIso,
  groupKeyForChannel,
  isMappingSkipped,
  channelUnknownReason,
  isStale,
  buildRelayGroups,
  buildClimate,
  triggerTypeFromLogMessage,
};
