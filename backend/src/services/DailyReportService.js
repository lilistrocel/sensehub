/**
 * DailyReportService — builds GET /api/reports/daily.
 *
 * READ-ONLY. Nothing here writes to the DB, touches a relay or raises an alert.
 * The DB handle is injected so the whole report can be exercised against a
 * read-only copy of the live DB (`new Database(path, { readonly: true })`).
 *
 * Two kinds of numbers live side by side and must never be confused:
 *
 *   ESTIMATED  relay ON-time x configured flow (relay_channel_config.flow_rate).
 *              Water = Irrigation 1 zone valves, fertigation = Irrigation 2
 *              venturi channels. This is what the report has always shown.
 *   MEASURED   the MQTT irrigation monitor (MqttIngestService): flow-meter
 *              accumulator (readings 'Net Total', m³), per-tank dosing counters
 *              ('Tank n Consumed', L) and one irrigation_cycles row per run.
 *              Only exists from the day the monitor was connected; a day
 *              without monitor data is "no measurement", never 0.
 *
 * Days are the farm's LOCAL days (system_settings.timezone, default Asia/Dubai).
 * Storage formats differ per table, so every bound is rendered in the table's
 * own format before comparing:
 *   readings.timestamp          ISO-8601 UTC  '2026-09-26T05:07:07.949Z'
 *   relay_events.created_at     SQLite UTC    '2026-09-26 05:07:07'
 *   automation_logs.triggered_at, relay_drift_log.created_at  (SQLite UTC)
 *   irrigation_cycles.start_time  ISO with the DEVICE's offset -> julianday()
 */

const WATER_EQUIPMENT_ID = 1;
const FERTIGATION_EQUIPMENT_ID = 2;
const DEFAULT_TIMEZONE = 'Asia/Dubai';

/**
 * 2026-09-26 08:51 local: Irrigation 2 relays were found wired one off and were
 * remapped (relay 1 = pH Down, 2 = Tank A ... 5 = Tank D). Relay events before
 * this instant on eq 2 channel N did NOT dose tank N, so any per-tank ESTIMATE
 * whose window starts earlier attributes litres by the old (wrong) mapping.
 * History is not rewritten; the report flags it instead.
 */
const FERTIGATION_RELAY_REMAP_AT = '2026-09-26T04:50:58.000Z';

/** Estimated vs measured deviation that gets flagged, in percent. */
const DEVIATION_THRESHOLD_PCT = 15;

// Below these the deviation % is noise (counter resolution: 0.1 L water, 0.25 L tank).
const MIN_WATER_COMPARE_L = 20;
const MIN_TANK_COMPARE_L = 0.5;
// "Dosing with no relay" / "relay with no dosing" thresholds.
const TANK_DOSED_L = 0.5;          // a tank that moved this much really dosed
const TANK_IDLE_L = 0.25;          // below this a tank did not dose
const RELAY_MEANINGFUL_S = 30;     // relay ON at least this long should have dosed
const WATER_FLOWED_L = 50;
const WATER_DRY_L = 10;
const VALVE_MEANINGFUL_S = 60;

// Counter plausibility (a delta faster than this is a glitch, not consumption).
const WATER_MAX_M3_PER_S = 30 / 3600;   // 30 m³/h — ~3.4x the 147 L/min main line
const WATER_JUMP_SLACK_M3 = 0.05;
const TANK_MAX_L_PER_S = 1200 / 3600;   // 20 L/min — ~10x the largest venturi
const TANK_JUMP_SLACK_L = 0.5;

const BASELINE_LOOKBACK_MS = 15 * 60 * 1000; // monitor heartbeat is 5 min
const GAP_MS = 11 * 60 * 1000;               // > 2 missed heartbeats = offline gap
const CYCLE_PAD_MS = 120 * 1000;             // relay/flow-detection skew around a cycle
const RELAY_LOOKAROUND_MS = 6 * 3600 * 1000; // pair ON/OFF across a window edge
const MAX_INTERVAL_S = 86400;

// ─── time helpers ───────────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0');
const toIso = (ms) => new Date(ms).toISOString();
/** SQLite CURRENT_TIMESTAMP format, UTC: 'YYYY-MM-DD HH:MM:SS'. */
const toSqlTs = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const sqlTsToMs = (s) => (s ? Date.parse(String(s).replace(' ', 'T') + 'Z') : NaN);
const r2 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const r1 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);

const dtfCache = new Map();
function dtf(tz) {
  if (!dtfCache.has(tz)) {
    dtfCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return dtfCache.get(tz);
}

function zonedParts(tz, ms) {
  const p = {};
  for (const { type, value } of dtf(tz).formatToParts(new Date(ms))) p[type] = value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

/** Offset of `tz` from UTC at instant `ms`, in ms (Asia/Dubai = +4h). */
function tzOffsetMs(tz, ms) {
  const p = zonedParts(tz, ms);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

function localDateStr(tz, ms) {
  const p = zonedParts(tz, ms);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
}

/** UTC instant of local midnight at the start of `dateStr` in `tz`. */
function localMidnightUtcMs(tz, dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const off = tzOffsetMs(tz, guess);
  let t = guess - off;
  const off2 = tzOffsetMs(tz, t);
  if (off2 !== off) t = guess - off2;
  return t;
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

function getTimezone(db) {
  try {
    const row = db.prepare("SELECT value FROM system_settings WHERE key = 'timezone'").get();
    if (row && row.value) {
      let tz = row.value;
      try { const v = JSON.parse(row.value); tz = typeof v === 'string' ? v : v.timezone; } catch (_) { /* plain string */ }
      if (tz) { dtf(tz); return tz; } // throws RangeError on an unknown zone
    }
  } catch (_) { /* fall through */ }
  return DEFAULT_TIMEZONE;
}

// ─── ESTIMATED: relay ON-time (unchanged semantics, local-day window) ───────

/** Pair each ON event that starts in [startSql, endSql) with the next OFF on that channel. */
function calcOnTime(db, equipmentId, startSql, endSql) {
  const onEvents = db.prepare(`
    SELECT re1.channel, re1.created_at as on_time,
      (SELECT MIN(re2.created_at) FROM relay_events re2
       WHERE re2.equipment_id = re1.equipment_id AND re2.channel = re1.channel
       AND re2.state = 0 AND re2.created_at > re1.created_at) as off_time
    FROM relay_events re1
    WHERE re1.equipment_id = ? AND re1.state = 1
      AND re1.created_at >= ? AND re1.created_at < ?
  `).all(equipmentId, startSql, endSql);

  let totalSeconds = 0;
  let eventCount = 0;
  const channelSeconds = {};
  for (const ev of onEvents) {
    if (!ev.off_time) continue; // still ON or no matching OFF
    const dur = Math.round((sqlTsToMs(ev.off_time) - sqlTsToMs(ev.on_time)) / 1000);
    if (dur > 0 && dur < MAX_INTERVAL_S) { // sanity: skip >24h durations
      totalSeconds += dur;
      eventCount++;
      channelSeconds[ev.channel] = (channelSeconds[ev.channel] || 0) + dur;
    }
  }
  return { total_seconds: totalSeconds, events: eventCount, by_channel: channelSeconds };
}

function loadChannelConfig(db) {
  const rows = db.prepare(
    'SELECT rcc.*, fm.name as mixture_name FROM relay_channel_config rcc ' +
    'LEFT JOIN fertigation_mixtures fm ON rcc.mixture_id = fm.id'
  ).all();
  const map = {};
  for (const r of rows) map[`${r.equipment_id}:${r.channel}`] = r;
  return map;
}

function calcLiters(onTimeResult, equipmentId, cfgMap) {
  let totalLiters = 0;
  const channelLiters = {};
  const channelDetails = {};
  for (const [ch, seconds] of Object.entries(onTimeResult.by_channel || {})) {
    const config = cfgMap[`${equipmentId}:${parseInt(ch, 10)}`];
    if (config && config.flow_rate > 0) {
      const liters = (seconds / 60) * config.flow_rate;
      totalLiters += liters;
      channelLiters[ch] = Math.round(liters * 100) / 100;
      channelDetails[ch] = {
        liters: channelLiters[ch],
        seconds,
        flow_rate: config.flow_rate,
        flow_unit: config.flow_unit,
        ingredient: config.ingredient_name || null,
        mixture: config.mixture_name || null,
      };
    }
  }
  return { total_liters: Math.round(totalLiters * 100) / 100, by_channel: channelLiters, details: channelDetails };
}

/**
 * Relay ON intervals for one board around [fromMs, toMs): ON paired with the
 * next OFF on the same channel (a repeated ON while already ON keeps the first
 * start). Unclosed intervals are dropped, like calcOnTime. Returns
 * [{ channel, startMs, endMs, automation_id }].
 */
function relayIntervals(db, equipmentId, fromMs, toMs) {
  const rows = db.prepare(`
    SELECT channel, state, automation_id, created_at FROM relay_events
    WHERE equipment_id = ? AND created_at >= ? AND created_at < ?
    ORDER BY created_at, id
  `).all(equipmentId, toSqlTs(fromMs - RELAY_LOOKAROUND_MS), toSqlTs(toMs + RELAY_LOOKAROUND_MS));
  const open = {};
  const out = [];
  for (const ev of rows) {
    const t = sqlTsToMs(ev.created_at);
    if (ev.state === 1) {
      if (!open[ev.channel]) open[ev.channel] = { startMs: t, automation_id: ev.automation_id };
    } else if (open[ev.channel]) {
      const o = open[ev.channel];
      delete open[ev.channel];
      if (t > o.startMs && (t - o.startMs) / 1000 < MAX_INTERVAL_S && t > fromMs && o.startMs < toMs) {
        out.push({ channel: ev.channel, startMs: o.startMs, endMs: t, automation_id: o.automation_id });
      }
    }
  }
  return out;
}

/** Seconds of ON per channel inside [a, b). */
function clippedSeconds(intervals, a, b) {
  const out = {};
  for (const iv of intervals) {
    const s = Math.max(iv.startMs, a);
    const e = Math.min(iv.endMs, b);
    if (e > s) out[iv.channel] = (out[iv.channel] || 0) + (e - s) / 1000;
  }
  return out;
}

// ─── MEASURED: irrigation monitor ───────────────────────────────────────────

function loadMonitor(db) {
  let row;
  try {
    row = db.prepare(`
      SELECT m.farm_id, m.equipment_id, e.name
      FROM mqtt_monitors m LEFT JOIN equipment e ON e.id = m.equipment_id
      WHERE m.equipment_id IS NOT NULL
      ORDER BY m.created_at, m.farm_id LIMIT 1
    `).get();
  } catch (_) { return null; } // table absent on an old DB
  if (!row) return null;
  const span = db.prepare('SELECT MIN(timestamp) AS first_ts FROM readings WHERE equipment_id = ?').get(row.equipment_id);
  const metered = new Set(
    db.prepare("SELECT DISTINCT name FROM readings WHERE equipment_id = ? AND name LIKE 'Tank % Rate'")
      .all(row.equipment_id)
      .map(r => parseInt(r.name.replace(/^Tank (\d+) Rate$/, '$1'), 10))
      .filter(Number.isFinite)
  );
  const tanksSeen = db.prepare("SELECT DISTINCT name FROM readings WHERE equipment_id = ? AND name LIKE 'Tank % Consumed'")
    .all(row.equipment_id)
    .map(r => parseInt(r.name.replace(/^Tank (\d+) Consumed$/, '$1'), 10))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  return {
    farm_id: row.farm_id,
    equipment_id: row.equipment_id,
    name: row.name || `Irrigation Monitor ${row.farm_id}`,
    first_reading: span && span.first_ts ? span.first_ts : null,
    monitor_tanks: tanksSeen,
    // A tank with no rate sensor (vendor: rate_lph null = "not measured") reports a
    // consumed_l that never moves; it is shown as "not metered", never as 0 L dosed.
    metered_tanks: metered,
  };
}

/**
 * Monitor tank n -> fertigation_tanks.id. Configurable per farm in
 * system_settings key 'mqtt_monitor_settings':
 *   { "1021": { "tank_map": { "1": 1, "2": 2, "3": 3, "4": 4, "5": 5 } } }
 * Default is identity (UNCONFIRMED on site). null = counter not attributed.
 */
function loadTankMap(db, farmId, tankIds) {
  const dflt = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 };
  let map = dflt;
  let source = 'default';
  try {
    const row = db.prepare("SELECT value FROM system_settings WHERE key = 'mqtt_monitor_settings'").get();
    const cfg = row ? JSON.parse(row.value) : null;
    const tm = cfg && cfg[farmId] && cfg[farmId].tank_map;
    if (tm && typeof tm === 'object') {
      map = {};
      for (const [k, v] of Object.entries(tm)) {
        const n = parseInt(k, 10);
        if (!Number.isInteger(n)) continue;
        map[n] = v === null ? null : (Number.isInteger(Number(v)) ? Number(v) : null);
      }
      source = 'system_settings';
    }
  } catch (_) { /* malformed setting -> default */ }
  for (const k of Object.keys(map)) if (map[k] !== null && !tankIds.has(map[k])) map[k] = null;
  return { map, source };
}

/** Readings of one counter in [fromMs, toMs), plus the last sample shortly before fromMs as baseline. */
function counterSeries(db, eqId, name, fromMs, toMs) {
  const baseline = db.prepare(`
    SELECT timestamp, value FROM readings
    WHERE equipment_id = ? AND name = ? AND timestamp < ? AND timestamp >= ?
    ORDER BY timestamp DESC LIMIT 1
  `).get(eqId, name, toIso(fromMs), toIso(fromMs - BASELINE_LOOKBACK_MS));
  const rows = db.prepare(`
    SELECT timestamp, value FROM readings
    WHERE equipment_id = ? AND name = ? AND timestamp >= ? AND timestamp < ?
    ORDER BY timestamp
  `).all(eqId, name, toIso(fromMs), toIso(toMs));
  return baseline ? [baseline, ...rows] : rows;
}

/**
 * Consumption from a cumulative counter, robust to resets, jitter and glitches.
 * Walks the samples against a reference value `ref` (last accepted level):
 *   - rise within the plausible rate (maxPerS * dt + slack): counted, ref moves up
 *   - fall within `jitter`: ignored, ref stays (net_total_m3 is forward-minus-
 *     reverse and flickers by one LSB; counting the flicker back up would inflate)
 *   - fall beyond `jitter`: counter reset (dosing counters can be reset), ref = new value
 *   - rise faster than plausible: glitch/unknown, not counted, ref = new value
 * Never negative. delta is null when there are < 2 samples (= no measurement).
 */
function positiveDelta(series, maxPerS, slack, jitter = 0) {
  const vals = (series || []).filter(s => s && s.value !== null && Number.isFinite(s.value));
  if (vals.length < 2) return { delta: null, resets: 0, rejected: 0, samples: vals.length };
  let delta = 0;
  let resets = 0;
  let rejected = 0;
  let ref = vals[0];
  for (let i = 1; i < vals.length; i++) {
    const b = vals[i];
    const d = b.value - ref.value;
    if (d < 0) {
      if (-d <= jitter) continue;
      resets++;
      ref = b;
      continue;
    }
    const dt = Math.max(0, (Date.parse(b.timestamp) - Date.parse(ref.timestamp)) / 1000);
    if (d > maxPerS * dt + slack) { rejected++; ref = b; continue; }
    delta += d;
    ref = b;
  }
  return { delta, resets, rejected, samples: vals.length };
}

const WATER_JITTER_M3 = 0.005; // 5 L
const TANK_JITTER_L = 0.3;     // ~one counter step (0.25 L)

function waterDeltaLiters(db, mon, fromMs, toMs) {
  const r = positiveDelta(counterSeries(db, mon.equipment_id, 'Net Total', fromMs, toMs), WATER_MAX_M3_PER_S, WATER_JUMP_SLACK_M3, WATER_JITTER_M3);
  return { ...r, liters: r.delta === null ? null : r.delta * 1000 };
}

function tankDeltaLiters(db, mon, n, fromMs, toMs) {
  const r = positiveDelta(counterSeries(db, mon.equipment_id, `Tank ${n} Consumed`, fromMs, toMs), TANK_MAX_L_PER_S, TANK_JUMP_SLACK_L, TANK_JITTER_L);
  return { ...r, liters: r.delta };
}

/** Monitor coverage of [fromMs, toMs): first/last sample, offline gaps, completeness. */
function coverage(db, mon, fromMs, toMs, nowMs) {
  const endMs = Math.min(toMs, nowMs);
  const ts = db.prepare(`
    SELECT DISTINCT timestamp FROM readings
    WHERE equipment_id = ? AND timestamp >= ? AND timestamp < ?
    ORDER BY timestamp
  `).all(mon.equipment_id, toIso(fromMs - BASELINE_LOOKBACK_MS), toIso(toMs)).map(r => Date.parse(r.timestamp));
  const inDay = ts.filter(t => t >= fromMs);
  if (inDay.length === 0) return null;
  const hasBaseline = ts.length > inDay.length;
  const first = inDay[0];
  const last = inDay[inDay.length - 1];
  const gaps = [];
  for (let i = 1; i < ts.length; i++) {
    if (ts[i] - ts[i - 1] > GAP_MS) {
      const a = Math.max(ts[i - 1], fromMs);
      if (ts[i] > a) gaps.push({ from: toIso(a), to: toIso(ts[i]), seconds: Math.round((ts[i] - a) / 1000) });
    }
  }
  const startMissing = hasBaseline ? 0 : Math.max(0, first - fromMs);
  const tailMissing = Math.max(0, endMs - last);
  const gapMs = gaps.reduce((s, g) => s + g.seconds * 1000, 0) + (startMissing > GAP_MS ? startMissing : 0) + (tailMissing > GAP_MS ? tailMissing : 0);
  const spanMs = Math.max(1, endMs - fromMs);
  return {
    first_reading: toIso(first),
    last_reading: toIso(last),
    baseline_before_start: hasBaseline,
    samples: inDay.length,
    gaps: gaps.slice(0, 20),
    gap_count: gaps.length,
    max_gap_s: gaps.reduce((m, g) => Math.max(m, g.seconds), 0),
    fraction: Math.max(0, Math.min(1, Math.round((1 - gapMs / spanMs) * 1000) / 1000)),
    complete: startMissing <= GAP_MS && tailMissing <= GAP_MS && gaps.length === 0,
    // measurement window: from the day start when a pre-day baseline exists, else the first sample
    window_from: toIso(hasBaseline ? fromMs : first),
    window_to: toIso(last),
  };
}

function deviationPct(measured, estimated) {
  if (measured === null || estimated === null || !(estimated > 0)) return null;
  return r1(((measured - estimated) / estimated) * 100);
}

/**
 * Per-tank / water flags. Types:
 *   deviation              |dev| > threshold with both values above the noise floor
 *   dosing_without_relay   tank counter moved, its relay never ON  (the 2026-09-26 miswire)
 *   relay_without_dosing   relay ON long enough, tank counter did not move
 *   water_without_valve / valve_without_water  (same for the flow meter vs zone valves)
 */
function tankFlags(t) {
  const f = [];
  if (!t.metered || t.measured_liters === null) return f;
  const on = t.relay_on_s || 0;
  if (t.measured_liters >= TANK_DOSED_L && on === 0) f.push('dosing_without_relay');
  else if (on >= RELAY_MEANINGFUL_S && (t.estimated_liters || 0) >= TANK_DOSED_L && t.measured_liters < TANK_IDLE_L) f.push('relay_without_dosing');
  else if (t.deviation_pct !== null && Math.abs(t.deviation_pct) > DEVIATION_THRESHOLD_PCT
    && Math.max(t.measured_liters, t.estimated_liters || 0) >= MIN_TANK_COMPARE_L) f.push('deviation');
  return f;
}

function waterFlags(w) {
  const f = [];
  if (w.measured_liters === null) return f;
  const on = w.valve_on_s || 0;
  if (w.measured_liters >= WATER_FLOWED_L && on === 0) f.push('water_without_valve');
  else if (on >= VALVE_MEANINGFUL_S && w.measured_liters < WATER_DRY_L) f.push('valve_without_water');
  else if (w.deviation_pct !== null && Math.abs(w.deviation_pct) > DEVIATION_THRESHOLD_PCT
    && Math.max(w.measured_liters, w.estimated_liters || 0) >= MIN_WATER_COMPARE_L) f.push('deviation');
  return f;
}

const FLAG_TEXT = {
  deviation: (who, t) => `${who}: measured ${r1(t.measured_liters)} L vs estimated ${r1(t.estimated_liters)} L (${t.deviation_pct > 0 ? '+' : ''}${t.deviation_pct} %)`,
  dosing_without_relay: (who, t) => `${who}: ${r1(t.measured_liters)} L dosed but relay ch ${t.channel ?? '?'} was never ON`,
  relay_without_dosing: (who, t) => `${who}: relay ch ${t.channel ?? '?'} ON ${Math.round(t.relay_on_s)} s but no dosing measured`,
  water_without_valve: (who, t) => `${who}: ${r1(t.measured_liters)} L flowed with no zone valve ON`,
  valve_without_water: (who, t) => `${who}: zone valves ON ${Math.round(t.valve_on_s)} s but no flow measured`,
};

/** Estimated water / per-tank litres for [a, b) from pre-fetched relay intervals. */
function estimateWindow(ctx, a, b) {
  const wSec = clippedSeconds(ctx.waterIntervals, a, b);
  let waterL = 0;
  let valveS = 0;
  for (const [ch, s] of Object.entries(wSec)) {
    const cfg = ctx.cfgMap[`${WATER_EQUIPMENT_ID}:${ch}`];
    if (cfg && cfg.flow_rate > 0) { waterL += (s / 60) * cfg.flow_rate; valveS += s; }
  }
  const fSec = clippedSeconds(ctx.fertIntervals, a, b);
  const byTank = {};
  for (const tank of ctx.tanks) {
    const s = tank.channel ? (fSec[tank.channel] || 0) : 0;
    const cfg = tank.channel ? ctx.cfgMap[`${FERTIGATION_EQUIPMENT_ID}:${tank.channel}`] : null;
    byTank[tank.id] = { relay_on_s: s, estimated_liters: cfg && cfg.flow_rate > 0 ? (s / 60) * cfg.flow_rate : 0, flow_rate: cfg ? cfg.flow_rate : null };
  }
  return { water_liters: waterL, valve_on_s: valveS, by_tank: byTank };
}

function tankRows(ctx, measuredByMonitorTank, est) {
  const rows = [];
  for (const n of ctx.mon.monitor_tanks) {
    const tankId = ctx.tankMap.map[n] ?? null;
    const tank = tankId !== null ? ctx.tankById[tankId] : null;
    const m = measuredByMonitorTank[n] || {};
    const e = tank ? est.by_tank[tank.id] : null;
    const metered = ctx.mon.metered_tanks.has(n);
    const row = {
      monitor_tank: n,
      tank_id: tank ? tank.id : null,
      tank_name: tank ? tank.name : null,
      channel: tank ? tank.channel : null,
      metered,
      measured_liters: metered ? r2(m.liters ?? null) : null,
      measured_source: metered ? (m.source || null) : null,
      estimated_liters: e ? r2(e.estimated_liters) : null,
      relay_on_s: e ? Math.round(e.relay_on_s) : null,
      configured_flow_lpm: e ? e.flow_rate : null,
    };
    if (m.counter_liters !== undefined) row.counter_liters = metered ? r2(m.counter_liters) : null;
    if (m.cycles_liters !== undefined) row.cycles_liters = metered ? r2(m.cycles_liters) : null;
    if (m.resets) row.counter_resets = m.resets;
    if (m.rejected) row.rejected_jumps = m.rejected;
    row.deviation_pct = tank ? deviationPct(row.measured_liters, row.estimated_liters) : null;
    row.flags = tank ? tankFlags(row) : [];
    rows.push(row);
  }
  return rows;
}

function parseDosing(json) {
  try { const d = JSON.parse(json); return Array.isArray(d) ? d : []; } catch (_) { return []; }
}

/** Automations whose relay events fall inside the cycle window, most events first. */
function matchAutomations(db, a, b) {
  return db.prepare(`
    SELECT re.automation_id AS id, a.name, COUNT(*) AS events
    FROM relay_events re LEFT JOIN automations a ON a.id = re.automation_id
    WHERE re.equipment_id IN (?, ?) AND re.automation_id IS NOT NULL
      AND re.created_at >= ? AND re.created_at < ?
    GROUP BY re.automation_id ORDER BY events DESC, re.automation_id
  `).all(WATER_EQUIPMENT_ID, FERTIGATION_EQUIPMENT_ID, toSqlTs(a), toSqlTs(b));
}

function buildCycles(db, ctx, fromMs, toMs) {
  const rows = db.prepare(`
    SELECT * FROM irrigation_cycles
    WHERE farm_id = ? AND julianday(start_time) >= julianday(?) AND julianday(start_time) < julianday(?)
    ORDER BY julianday(start_time), id
  `).all(ctx.mon.farm_id, toIso(fromMs), toIso(toMs));
  return rows.map((c) => {
    const s = Date.parse(c.start_time);
    const e = Date.parse(c.end_time);
    const a = s - CYCLE_PAD_MS;
    const b = e + CYCLE_PAD_MS;
    const est = estimateWindow(ctx, a, b);
    const autos = matchAutomations(db, a, b);

    let waterMeasured = c.water_m3 !== null ? c.water_m3 * 1000 : null;
    let waterSource = c.water_m3 !== null ? 'cycle_report' : null;
    if (waterMeasured === null) {
      const d = waterDeltaLiters(db, ctx.mon, s, e + 1000);
      if (d.liters !== null) { waterMeasured = d.liters; waterSource = 'flowmeter_counter'; }
    }
    const water = {
      measured_liters: r1(waterMeasured),
      measured_source: waterSource,
      estimated_liters: r1(est.water_liters),
      valve_on_s: Math.round(est.valve_on_s),
    };
    water.deviation_pct = deviationPct(water.measured_liters, water.estimated_liters);
    water.flags = waterFlags(water);

    const measured = {};
    for (const d of parseDosing(c.dosing_json)) {
      if (d && Number.isInteger(d.id)) measured[d.id] = { liters: d.consumed_l, source: d.consumed_l === null ? null : 'cycle_report' };
    }
    const tanks = tankRows(ctx, measured, est);
    const caveat = a < ctx.remapMs;
    return {
      id: c.id,
      cycle_id: c.cycle_id,
      start: c.start_time,
      end: c.end_time,
      duration_s: c.duration_s,
      automation: autos[0] ? { id: autos[0].id, name: autos[0].name } : null,
      automations: autos,
      water,
      tanks,
      flag_count: water.flags.length + tanks.reduce((n, t) => n + t.flags.length, 0),
      estimate_mapping_caveat: caveat,
    };
  });
}

function buildMeasuredDay(db, ctx, fromMs, toMs, nowMs) {
  const mon = ctx.mon;
  if (!mon || !mon.first_reading || Date.parse(mon.first_reading) >= toMs || fromMs > nowMs) {
    return { available: false, reason: 'no_measurement' };
  }
  const cov = coverage(db, mon, fromMs, toMs, nowMs);
  if (!cov) return { available: false, reason: 'no_measurement' };
  const wFrom = Date.parse(cov.window_from);
  const wTo = Date.parse(cov.window_to) + 1; // include the last sample

  // Water: flow-meter accumulator is primary, cycle reports are the cross-check.
  const wd = waterDeltaLiters(db, mon, wFrom, wTo);
  const cycles = buildCycles(db, ctx, fromMs, toMs);
  const cyclesWithWater = cycles.filter(c => c.water.measured_source === 'cycle_report');
  const cyclesWaterL = cyclesWithWater.length ? cyclesWithWater.reduce((s, c) => s + c.water.measured_liters, 0) : null;
  const waterL = wd.liters !== null ? wd.liters : cyclesWaterL;
  const water = {
    liters: r1(waterL),
    source: wd.liters !== null ? 'flowmeter_counter' : (cyclesWaterL !== null ? 'cycle_reports' : null),
    counter_liters: r1(wd.liters),
    cycles_liters: r1(cyclesWaterL),
    cycles_count: cycles.length,
    cycles_with_water: cyclesWithWater.length,
    counter_vs_cycles_pct: wd.liters !== null && cyclesWaterL ? deviationPct(wd.liters, cyclesWaterL) : null,
    counter_resets: wd.resets,
    rejected_jumps: wd.rejected,
  };

  // Tanks: counter delta primary, cycle dosing sums the cross-check.
  const measuredByTank = {};
  for (const n of mon.monitor_tanks) {
    const td = tankDeltaLiters(db, mon, n, wFrom, wTo);
    let cyc = null;
    for (const c of cycles) {
      const row = c.tanks.find(t => t.monitor_tank === n);
      if (row && row.measured_liters !== null) cyc = (cyc || 0) + row.measured_liters;
    }
    measuredByTank[n] = {
      liters: td.liters !== null ? td.liters : cyc,
      source: td.liters !== null ? 'dosing_counter' : (cyc !== null ? 'cycle_reports' : null),
      counter_liters: td.liters,
      cycles_liters: cyc,
      resets: td.resets,
      rejected: td.rejected,
    };
  }

  // Comparison: estimate restricted to the window the monitor actually covered.
  const est = estimateWindow(ctx, wFrom, wTo);
  const tanks = tankRows(ctx, measuredByTank, est);
  const cmpWater = {
    measured_liters: water.liters,
    estimated_liters: r1(est.water_liters),
    valve_on_s: Math.round(est.valve_on_s),
  };
  cmpWater.deviation_pct = deviationPct(cmpWater.measured_liters, cmpWater.estimated_liters);
  cmpWater.flags = waterFlags(cmpWater);

  const meteredTanks = tanks.filter(t => t.metered && t.tank_id !== null && t.measured_liters !== null);
  const fertMeasured = meteredTanks.length ? meteredTanks.reduce((s, t) => s + t.measured_liters, 0) : null;
  const fertEstimated = meteredTanks.reduce((s, t) => s + (t.estimated_liters || 0), 0);
  const cmpFert = {
    measured_liters: r2(fertMeasured),
    estimated_liters: r2(fertEstimated),
    deviation_pct: deviationPct(fertMeasured, fertEstimated),
    tanks_included: meteredTanks.map(t => t.tank_id),
    tanks_not_metered: tanks.filter(t => !t.metered).map(t => ({ monitor_tank: t.monitor_tank, tank_id: t.tank_id, tank_name: t.tank_name })),
  };
  cmpFert.flagged = cmpFert.deviation_pct !== null && Math.abs(cmpFert.deviation_pct) > DEVIATION_THRESHOLD_PCT
    && Math.max(fertMeasured || 0, fertEstimated) >= MIN_TANK_COMPARE_L;

  const flags = [];
  for (const f of cmpWater.flags) flags.push({ type: f, scope: 'water', message: FLAG_TEXT[f]('Water', cmpWater) });
  for (const t of tanks) for (const f of t.flags) {
    flags.push({ type: f, scope: 'tank', tank_id: t.tank_id, monitor_tank: t.monitor_tank, message: FLAG_TEXT[f](t.tank_name || `Monitor tank ${t.monitor_tank}`, t) });
  }
  for (const c of cycles) {
    const who = `${c.cycle_id}${c.automation ? ` (${c.automation.name})` : ''}`;
    for (const f of c.water.flags) flags.push({ type: f, scope: 'cycle', cycle_id: c.cycle_id, message: `${who} — ${FLAG_TEXT[f]('water', c.water)}` });
    for (const t of c.tanks) for (const f of t.flags) {
      flags.push({ type: f, scope: 'cycle', cycle_id: c.cycle_id, tank_id: t.tank_id, message: `${who} — ${FLAG_TEXT[f](t.tank_name || `monitor tank ${t.monitor_tank}`, t)}` });
    }
  }

  // Calibration hint: implied venturi flow for each tank's CURRENT relay, post-remap only.
  const calFrom = Math.max(wFrom, ctx.remapMs);
  const calibration = [];
  if (wTo > calFrom) {
    const calEst = estimateWindow(ctx, calFrom, wTo);
    for (const t of tanks) {
      if (!t.metered || t.tank_id === null) continue;
      const liters = calFrom === wFrom ? measuredByTank[t.monitor_tank].counter_liters : tankDeltaLiters(db, mon, t.monitor_tank, calFrom, wTo).liters;
      const onS = calEst.by_tank[t.tank_id] ? calEst.by_tank[t.tank_id].relay_on_s : 0;
      calibration.push({
        tank_id: t.tank_id, tank_name: t.tank_name, channel: t.channel, monitor_tank: t.monitor_tank,
        measured_liters: r2(liters), relay_on_s: Math.round(onS),
        configured_flow_lpm: t.configured_flow_lpm,
      });
    }
  }

  // Runs: the cycles grouped with the relay events (automated / manual app / manual panel).
  // Same builder as /api/irrigation/runs, computed read-only for the day.
  let runs = [];
  let dropped = [];
  let runsSummary = null;
  try {
    const B = require('./IrrigationRunBuilder'); // lazy: the builder requires this module
    const built = B.buildRuns(db, { fromMs, toMs, nowMs });
    runs = built.runs.map(r => ({ ...r, cycles: r.cycles.map(({ tanks: _t, ...c }) => c) }));
    dropped = built.dropped.map(({ tanks: _t, ...d }) => d);
    runsSummary = B.summariseRuns(built.runs, built.dropped);
    water.runs_liters = runsSummary.water_l;
    water.dropped_blips_liters = runsSummary.dropped_water_l;
  } catch (e) {
    runsSummary = { error: e.message };
  }

  return {
    available: true,
    reason: null,
    coverage: cov,
    water,
    runs,
    runs_summary: runsSummary,
    dropped_blips: dropped,
    fertigation_liters: r2(fertMeasured),
    tanks,
    cycles,
    comparison: {
      window: { from: cov.window_from, to: cov.window_to },
      threshold_pct: DEVIATION_THRESHOLD_PCT,
      water: cmpWater,
      fertigation: cmpFert,
      tanks: tanks.map(t => ({
        monitor_tank: t.monitor_tank, tank_id: t.tank_id, tank_name: t.tank_name, channel: t.channel, metered: t.metered,
        measured_liters: t.measured_liters, estimated_liters: t.estimated_liters, relay_on_s: t.relay_on_s,
        deviation_pct: t.deviation_pct, flags: t.flags,
      })),
      estimate_mapping_caveat: wFrom < ctx.remapMs,
      flags,
    },
    calibration,
  };
}

function summariseCalibration(days) {
  const acc = {};
  for (const d of days) {
    for (const c of (d.measured && d.measured.calibration) || []) {
      if (c.measured_liters === null) continue;
      const a = acc[c.tank_id] || (acc[c.tank_id] = { ...c, measured_liters: 0, relay_on_s: 0, days: 0 });
      a.measured_liters += c.measured_liters;
      a.relay_on_s += c.relay_on_s;
      a.days++;
    }
  }
  return Object.values(acc).map(a => ({
    tank_id: a.tank_id, tank_name: a.tank_name, channel: a.channel, monitor_tank: a.monitor_tank,
    measured_liters: r2(a.measured_liters),
    relay_on_minutes: r2(a.relay_on_s / 60),
    implied_flow_lpm: a.relay_on_s >= 60 ? Math.round((a.measured_liters / (a.relay_on_s / 60)) * 1000) / 1000 : null,
    configured_flow_lpm: a.configured_flow_lpm,
    days: a.days,
  })).sort((x, y) => (x.channel ?? 99) - (y.channel ?? 99));
}

function summariseMeasured(days) {
  const withM = days.filter(d => d.measured && d.measured.available);
  if (!withM.length) return { days_with_measurement: 0 };
  const sum = (f) => withM.reduce((s, d) => { const v = f(d); return v === null || v === undefined ? s : s + v; }, 0);
  const wM = sum(d => d.measured.comparison.water.measured_liters);
  const wE = sum(d => d.measured.comparison.water.estimated_liters);
  const fM = sum(d => d.measured.comparison.fertigation.measured_liters);
  const fE = sum(d => d.measured.comparison.fertigation.estimated_liters);
  return {
    days_with_measurement: withM.length,
    dates: withM.map(d => d.date),
    water: { measured_liters: r1(wM), estimated_liters: r1(wE), deviation_pct: deviationPct(wM, wE) },
    fertigation: { measured_liters: r2(fM), estimated_liters: r2(fE), deviation_pct: deviationPct(fM, fE) },
    cycles: sum(d => d.measured.cycles.length),
    runs: sum(d => (d.measured.runs ? d.measured.runs.length : 0)),
    manual_runs: sum(d => (d.measured.runs ? d.measured.runs.filter(r => r.type !== 'automated').length : 0)),
    flags: sum(d => d.measured.comparison.flags.length),
    threshold_pct: DEVIATION_THRESHOLD_PCT,
  };
}

// ─── the report ─────────────────────────────────────────────────────────────

function buildDailyReport(db, { days = 7, nowMs = Date.now() } = {}) {
  const tz = getTimezone(db);
  const today = localDateStr(tz, nowMs);
  const cfgMap = loadChannelConfig(db);

  // Discover power meters: any equipment that has logged an "Energy Imported" reading in kWh.
  const powerMeters = db.prepare(`
    SELECT DISTINCT r.equipment_id, e.name
    FROM readings r
    JOIN equipment e ON e.id = r.equipment_id
    WHERE r.name = 'Energy Imported' AND r.unit = 'kWh'
    ORDER BY r.equipment_id
  `).all();

  const tanks = db.prepare(`
    SELECT id, name, channel, role, equipment_id FROM fertigation_tanks
    WHERE active = 1 ORDER BY id
  `).all().map(t => ({ ...t, channel: t.equipment_id === FERTIGATION_EQUIPMENT_ID ? t.channel : null }));
  const tankById = {};
  for (const t of tanks) tankById[t.id] = t;

  const mon = loadMonitor(db);
  const tankMap = mon ? loadTankMap(db, mon.farm_id, new Set(tanks.map(t => t.id))) : { map: {}, source: 'default' };
  const remapMs = Date.parse(FERTIGATION_RELAY_REMAP_AT);

  const report = [];
  for (let d = 0; d < days; d++) {
    const dateStr = addDays(today, -d);
    const fromMs = localMidnightUtcMs(tz, dateStr);
    const toMs = localMidnightUtcMs(tz, addDays(dateStr, 1));
    const startSql = toSqlTs(fromMs);
    const endSql = toSqlTs(toMs);

    const water = calcOnTime(db, WATER_EQUIPMENT_ID, startSql, endSql);
    const fertigation = calcOnTime(db, FERTIGATION_EQUIPMENT_ID, startSql, endSql);
    const waterLiters = calcLiters(water, WATER_EQUIPMENT_ID, cfgMap);
    const fertLiters = calcLiters(fertigation, FERTIGATION_EQUIPMENT_ID, cfgMap);

    const autoStats = db.prepare(`
      SELECT
        COUNT(*) as total_runs,
        SUM(CASE WHEN status = 'failure' THEN 1 ELSE 0 END) as failures,
        SUM(CASE WHEN message LIKE '%skipped by dependency%' THEN 1 ELSE 0 END) as skipped_runs
      FROM automation_logs
      WHERE triggered_at >= ? AND triggered_at < ?
    `).get(startSql, endSql);

    let totalSkippedActions = 0;
    for (const row of db.prepare(`
      SELECT message FROM automation_logs
      WHERE triggered_at >= ? AND triggered_at < ? AND message LIKE '%skipped by dependency%'
    `).all(startSql, endSql)) {
      const match = row.message.match(/(\d+) action/);
      if (match) totalSkippedActions += parseInt(match[1], 10);
    }

    const driftCount = db.prepare(`
      SELECT COUNT(*) as count FROM relay_drift_log WHERE created_at >= ? AND created_at < ?
    `).get(startSql, endSql).count;

    // Power per meter: "Energy Imported" is a monotonically increasing counter,
    // so MAX - MIN over the local day is the day's consumption.
    const power = {};
    let powerTotalKwh = 0;
    for (const pm of powerMeters) {
      const row = db.prepare(`
        SELECT MIN(value) as start_v, MAX(value) as end_v, COUNT(*) as samples
        FROM readings
        WHERE equipment_id = ? AND name = 'Energy Imported' AND timestamp >= ? AND timestamp < ?
      `).get(pm.equipment_id, toIso(fromMs), toIso(toMs));
      const kwh = (row && row.samples > 0 && row.start_v != null && row.end_v != null) ? Math.max(0, row.end_v - row.start_v) : 0;
      const rounded = Math.round(kwh * 100) / 100;
      power[pm.equipment_id] = {
        equipment_id: pm.equipment_id, name: pm.name, kwh: rounded,
        start: row?.start_v ?? null, end: row?.end_v ?? null, samples: row?.samples ?? 0,
      };
      powerTotalKwh += rounded;
    }

    // Relay intervals for the whole day (+ edges) once; windows below are clipped from these.
    const ctx = {
      mon, tanks, tankById, tankMap, cfgMap, remapMs,
      waterIntervals: relayIntervals(db, WATER_EQUIPMENT_ID, fromMs, toMs),
      fertIntervals: relayIntervals(db, FERTIGATION_EQUIPMENT_ID, fromMs, toMs),
    };
    const measured = buildMeasuredDay(db, ctx, fromMs, toMs, nowMs);

    report.push({
      date: dateStr,
      day_start: toIso(fromMs),
      day_end: toIso(toMs),
      water: {
        total_seconds: water.total_seconds,
        total_minutes: Math.round(water.total_seconds / 60),
        total_liters: waterLiters.total_liters,
        events: water.events,
        by_channel: water.by_channel,
        liters_by_channel: waterLiters.by_channel,
        channel_details: waterLiters.details,
        source: 'estimated',
      },
      fertigation: {
        total_seconds: fertigation.total_seconds,
        total_minutes: Math.round(fertigation.total_seconds / 60),
        total_liters: fertLiters.total_liters,
        events: fertigation.events,
        by_channel: fertigation.by_channel,
        liters_by_channel: fertLiters.by_channel,
        channel_details: fertLiters.details,
        source: 'estimated',
        // per-channel -> tank attribution before the 08:51 remap used the old (wrong) wiring
        mapping_caveat: fromMs < remapMs,
      },
      automations: {
        total_runs: autoStats.total_runs || 0,
        failures: autoStats.failures || 0,
        skipped_runs: autoStats.skipped_runs || 0,
        skipped_actions: totalSkippedActions,
      },
      drift_events: driftCount,
      power: { total_kwh: Math.round(powerTotalKwh * 100) / 100, by_meter: power },
      measured,
    });
  }

  const eqName = (id) => db.prepare('SELECT name FROM equipment WHERE id = ?').get(id)?.name;

  return {
    days,
    timezone: tz,
    water_equipment: { id: WATER_EQUIPMENT_ID, name: eqName(WATER_EQUIPMENT_ID) },
    fertigation_equipment: { id: FERTIGATION_EQUIPMENT_ID, name: eqName(FERTIGATION_EQUIPMENT_ID) },
    power_meters: powerMeters,
    monitor: mon ? {
      farm_id: mon.farm_id,
      equipment_id: mon.equipment_id,
      name: mon.name,
      first_reading: mon.first_reading,
      tank_map: mon.monitor_tanks.map(n => {
        const id = tankMap.map[n] ?? null;
        return { monitor_tank: n, tank_id: id, tank_name: id !== null ? tankById[id]?.name ?? null : null, metered: mon.metered_tanks.has(n) };
      }),
      tank_map_source: tankMap.source,
      tank_map_confirmed: tankMap.source !== 'default',
    } : null,
    fertigation_relay_remap_at: FERTIGATION_RELAY_REMAP_AT,
    deviation_threshold_pct: DEVIATION_THRESHOLD_PCT,
    measured_totals: summariseMeasured(report),
    calibration: summariseCalibration(report),
    report,
  };
}

module.exports = {
  buildDailyReport,
  // exported for tests / scratch verification
  positiveDelta,
  localMidnightUtcMs,
  localDateStr,
  tzOffsetMs,
  clippedSeconds,
  // shared with IrrigationRunBuilder (same local-day / tank-map rules)
  getTimezone,
  loadTankMap,
  addDays,
  FERTIGATION_RELAY_REMAP_AT,
  DEVIATION_THRESHOLD_PCT,
};
