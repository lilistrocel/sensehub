/**
 * IrrigationRunBuilder — groups irrigation-monitor cycles + relay events into
 * irrigation RUNS (requirement 2026-09-27: manual-irrigation tracking).
 *
 * READ-ONLY. Pure classification over the DB: nothing here writes, touches a
 * relay or raises an alert. IrrigationRunsService persists the result;
 * DailyReportService calls it directly for the Reports page.
 *
 * Why: the irrigation monitor (MQTT farm/1021) ends a "cycle" every time the
 * water stops. Under the soft-switch sequences (automations 95-101) every ZONE
 * is its own cycle, drain-back makes 2-5 s blips of ~0.1 L, and a run started
 * at the fertigation panel (bypassing the relay boards) shows up only as water
 * with no SenseHub relay ON. A run is what the operator thinks of as "one
 * irrigation".
 *
 * TYPES
 *   automated     cycles that START inside an automation's run window: the
 *                 automation's relay events on the irrigation/dosing boards
 *                 (source automation*, dose_*, ph_controller, flow_watch*),
 *                 clustered per automation id (gap <= 10 min), from the first
 *                 event - 20 s to the last event + 30 s grace. Per-zone segments
 *                 come from the zone relays the automation switched ON; linked to
 *                 the dose_controller_runs row of the same automation + time,
 *                 whose per-zone EC/pH/status is reused.
 *   manual_app    water outside any automation window while pump/zone relays
 *                 were switched by the app (source manual / manual_all /
 *                 all_channels, with user_email) for >= 30 % of the (padded)
 *                 water window. Zones from those relays, operator = the users.
 *   manual_panel  water outside any automation window with (almost) no SenseHub
 *                 pump/zone relay ON: someone ran it at the panel. Zone unknown;
 *                 "one zone's flow" when the mean flow is within ±15 % of a zone.
 *
 * GROUPING (non-automated water): consecutive cycles < 20 s apart form one
 * group; a group shorter than 10 s OR with < 5 L is dropped as drain-back
 * (listed in `dropped`, so totals still reconcile). Inside a run, blips are
 * kept: they are that run's water (automated) or absorbed into the manual run
 * without moving its start/end.
 *
 * PER RUN + PER ZONE SEGMENT: start/end, duration, water L (monitor cycle
 * reports; a cycle spanning several zones is split on the flow-meter / dosing
 * counters), A-D litres (monitor dosing mapped through the same tank_map as
 * DailyReportService), achieved ratio 1:N, EC (µS/cm) and pH avg/min/max
 * (DoseRunZoneStats: SEKO samples while flow >= 50 % expected), status
 * ok / cut_short / no_water / shutdown / not_run / manual (run level also
 * 'stopped': ended by the operator's Stop irrigation button), and
 * uncontrolled_dosing: tanks moved >= 0.5 L with no dosing-valve command from
 * SenseHub during the run.
 */

const zoneStats = require('./DoseRunZoneStats');
const i18n = require('../i18n');
const { M } = i18n;
const DR = require('./DailyReportService');

const PAD_MS = 20000;                 // monitor clock vs relay events, valve lead
const GRACE_MS = 30000;               // after an automation's last relay event
const CLUSTER_GAP_MS = 10 * 60000;    // automation events further apart = a new window
const MERGE_GAP_MS = 20000;           // cycles closer than this are one group
const BLIP_MIN_S = 10;
const BLIP_MIN_L = 5;
const FLUSH_KEYS = ['flush_samples', 'flush_s', 'flush_ec_avg_us', 'flush_ec_min_us', 'flush_ec_max_us', 'flush_ph_avg', 'flush_ph_min', 'flush_ph_max'];
const MANUAL_COVERAGE = 0.3;          // app relays ON for >= 30 % of the padded water window
const TANK_MOVED_L = 0.5;
const SINGLE_ZONE_SHARE = 0.85;       // a cycle this much inside one zone belongs to it whole
const RELAY_LOOKBACK_MS = 6 * 3600000;
const LOAD_MARGIN_MS = 45 * 60000;
const MAX_OPEN_MS = 24 * 3600000;
const DEFAULT_EXPECTED_LPH = 8820;
const ONE_ZONE_TOL = 0.15;

const MANUAL_SOURCES = new Set(['manual', 'manual_all', 'all_channels']);
const OPERATOR_STOP_SOURCES = new Set(['stop_all', 'manual_all', 'all_channels', 'manual', 'stop_irrigation']);
// The operator's "Stop irrigation" button (2026-09-27): the run is 'stopped', not just 'cut_short'.
const STOP_IRRIGATION_SOURCE = 'stop_irrigation';

const TYPE_LABEL = { automated: 'Scheduled', manual_app: 'Manual — app', manual_panel: 'Manual — panel' };

const r1 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const r2 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const iso = (ms) => (ms === null || ms === undefined || !Number.isFinite(ms) ? null : new Date(ms).toISOString());
const toSqlTs = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const parseTs = zoneStats.parseTs;

const clockFmt = new Map();
/** HH:MM:SS in the farm's timezone (notes are read by operators). */
function clock(tz, ms) {
  if (!Number.isFinite(ms)) return '—';
  try {
    if (!clockFmt.has(tz)) clockFmt.set(tz, new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }));
    return clockFmt.get(tz).format(new Date(ms));
  } catch (_) { return new Date(ms).toISOString().slice(11, 19); }
}

function isAutoSource(s) {
  const src = String(s || '');
  return src === 'automation' || src.startsWith('automation_') || src.startsWith('dose_')
    || src === 'ph_controller' || src.startsWith('flow_watch');
}

function overlapMs(a0, a1, b0, b1) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/** Total length of the union of [s, e) intervals clipped to [a, b). */
function unionMs(intervals, a, b) {
  const xs = intervals.map(i => [Math.max(i[0], a), Math.min(i[1], b)]).filter(([s, e]) => e > s).sort((x, y) => x[0] - y[0]);
  let total = 0; let cs = null; let ce = null;
  for (const [s, e] of xs) {
    if (cs === null) { cs = s; ce = e; continue; }
    if (s <= ce) { ce = Math.max(ce, e); continue; }
    total += ce - cs; cs = s; ce = e;
  }
  if (cs !== null) total += ce - cs;
  return total;
}

function median(arr) {
  const s = arr.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ─── context ────────────────────────────────────────────────────────────────

function readFlowWatchCfg(db) {
  const dflt = { irrigation_equipment_id: 1, pump_channel: 1, mixing_pump_channel: 2, zone_channels: [3, 4, 5, 6], dosing_equipment_id: 2, monitor_farm_id: null };
  try {
    const row = db.prepare("SELECT value FROM system_settings WHERE key = 'irrigation_flow_watch'").get();
    const v = row && row.value ? JSON.parse(row.value) : {};
    const out = { ...dflt };
    for (const k of Object.keys(dflt)) if (v[k] !== undefined && v[k] !== null) out[k] = v[k];
    if (!Array.isArray(out.zone_channels) || !out.zone_channels.length) out.zone_channels = dflt.zone_channels;
    return out;
  } catch (_) { return dflt; }
}

function loadContext(db, opts = {}) {
  const cfg = { ...readFlowWatchCfg(db), ...(opts.config || {}) };
  const tz = DR.getTimezone(db);
  let mon = null;
  try {
    mon = db.prepare(`
      SELECT m.farm_id, m.equipment_id FROM mqtt_monitors m
      WHERE m.equipment_id IS NOT NULL ${cfg.monitor_farm_id ? 'AND m.farm_id = ?' : ''}
      ORDER BY m.created_at, m.farm_id LIMIT 1
    `).get(...(cfg.monitor_farm_id ? [String(cfg.monitor_farm_id)] : []));
  } catch (_) { mon = null; }
  const tanks = db.prepare('SELECT id, name, channel, role, equipment_id, active FROM fertigation_tanks ORDER BY id').all();
  const tankById = Object.fromEntries(tanks.map(t => [t.id, t]));
  const tankMap = mon ? DR.loadTankMap(db, mon.farm_id, new Set(tanks.filter(t => t.active !== 0).map(t => t.id))) : { map: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 }, source: 'default' };
  const nutrientIds = tanks.filter(t => t.active !== 0 && (t.role || 'nutrient') === 'nutrient').map(t => t.id);
  const dosingChannels = new Set(tanks.filter(t => t.equipment_id === cfg.dosing_equipment_id && t.channel != null).map(t => t.channel));

  const names = {};
  try {
    const eq = db.prepare('SELECT register_mappings FROM equipment WHERE id = ?').get(cfg.irrigation_equipment_id);
    for (const m of JSON.parse((eq && eq.register_mappings) || '[]') || []) {
      const ch = parseInt(m.register, 10);
      if (Number.isInteger(ch) && m.name) names[ch] = m.name;
    }
  } catch (_) { /* unnamed */ }
  const expected = {};
  try {
    for (const r of db.prepare('SELECT channel, flow_rate, flow_unit FROM relay_channel_config WHERE equipment_id = ?').all(cfg.irrigation_equipment_id)) {
      const v = Number(r.flow_rate);
      if (!Number.isFinite(v) || v <= 0) continue;
      const unit = String(r.flow_unit || 'L/min').toLowerCase();
      expected[r.channel] = unit === 'l/h' ? v : (unit === 'm3/h' || unit === 'm³/h') ? v * 1000 : v * 60;
    }
  } catch (_) { /* default */ }
  const zoneExpected = cfg.zone_channels.map(ch => expected[ch]).filter(Number.isFinite);
  const oneZoneLph = median(zoneExpected) || DEFAULT_EXPECTED_LPH;

  let dcCfg = { sensor_equipment_id: 17, sensor_metric: 'pH', ec_metric: 'Water EC', plausible_min: 3, plausible_max: 9 };
  try {
    const row = db.prepare("SELECT value FROM system_settings WHERE key = 'dose_controller'").get();
    const ph = row && row.value ? (JSON.parse(row.value) || {}).ph : null;
    if (ph) dcCfg = { ...dcCfg, ...Object.fromEntries(Object.entries(ph).filter(([k]) => k in dcCfg)) };
  } catch (_) { /* defaults */ }

  const autoNames = {};
  try { for (const a of db.prepare('SELECT id, name, updated_at FROM automations').all()) autoNames[a.id] = a; } catch (_) { /* none */ }

  return {
    cfg, tz, mon, tanks, tankById, tankMap, nutrientIds, dosingChannels, names, expected, oneZoneLph, dcCfg, autoNames,
    zoneSet: new Set(cfg.zone_channels),
    runChannels: new Set([cfg.pump_channel, cfg.mixing_pump_channel, ...cfg.zone_channels]),
  };
}

const zoneName = (ctx, ch) => ctx.names[ch] || `Zone relay ${ch}`;

// ─── inputs ─────────────────────────────────────────────────────────────────

function loadCycles(ctx, db, fromMs, toMs) {
  if (!ctx.mon) return [];
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT id, cycle_id, start_time, end_time, duration_s, water_m3, dosing_json FROM irrigation_cycles
      WHERE farm_id = ? AND julianday(start_time) >= julianday(?) AND julianday(start_time) < julianday(?)
      ORDER BY julianday(start_time), id
    `).all(ctx.mon.farm_id, iso(fromMs), iso(toMs));
  } catch (_) { return []; }
  return rows.map((c) => {
    const s = Date.parse(c.start_time);
    let e = Date.parse(c.end_time);
    if (!Number.isFinite(e) || e < s) e = s + (c.duration_s || 0) * 1000;
    const dosing = {};
    try {
      for (const d of JSON.parse(c.dosing_json) || []) {
        if (!d || !Number.isInteger(d.id) || typeof d.consumed_l !== 'number') continue;
        const tankId = ctx.tankMap.map[d.id] ?? null;
        if (tankId !== null) dosing[tankId] = (dosing[tankId] || 0) + Math.max(0, d.consumed_l);
      }
    } catch (_) { /* no dosing */ }
    const waterL = c.water_m3 === null || c.water_m3 === undefined ? null : c.water_m3 * 1000;
    return {
      id: c.id, cycle_id: c.cycle_id, start: c.start_time, end: c.end_time, s, e,
      duration_s: c.duration_s ?? Math.round((e - s) / 1000), water_l: waterL, dosing,
    };
  }).filter(c => Number.isFinite(c.s));
}

const isBlip = (c) => (c.duration_s ?? 0) < BLIP_MIN_S || (c.water_l ?? 0) < BLIP_MIN_L;

function loadEvents(ctx, db, fromMs, toMs) {
  const { irrigation_equipment_id: irr, dosing_equipment_id: dos } = ctx.cfg;
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT id, equipment_id, channel, state, source, automation_id, user_email, created_at FROM relay_events
      WHERE equipment_id IN (?, ?) AND created_at >= ? AND created_at < ?
      ORDER BY created_at, id
    `).all(irr, dos, toSqlTs(fromMs), toSqlTs(toMs));
  } catch (_) {
    // older DB without user_email
    rows = db.prepare(`
      SELECT id, equipment_id, channel, state, source, automation_id, NULL AS user_email, created_at FROM relay_events
      WHERE equipment_id IN (?, ?) AND created_at >= ? AND created_at < ?
      ORDER BY created_at, id
    `).all(irr, dos, toSqlTs(fromMs), toSqlTs(toMs));
  }
  return rows.map(r => ({ ...r, t: parseTs(r.created_at) })).filter(r => r.t !== null);
}

/** ON -> next OFF per (equipment, channel). A repeated ON keeps the first. Unclosed = open (end = now). */
function buildIntervals(events, nowMs) {
  const open = new Map();
  const out = [];
  for (const ev of events) {
    const key = `${ev.equipment_id}:${ev.channel}`;
    if (ev.state === 1) {
      if (!open.has(key)) {
        open.set(key, {
          eq: ev.equipment_id, ch: ev.channel, s: ev.t, onSource: ev.source, aid: ev.automation_id ?? null,
          onUser: ev.user_email || null, users: new Set(ev.user_email ? [ev.user_email] : []),
        });
      } else if (ev.user_email) open.get(key).users.add(ev.user_email);
    } else if (open.has(key)) {
      const iv = open.get(key);
      open.delete(key);
      iv.e = ev.t; iv.offSource = ev.source; iv.offUser = ev.user_email || null;
      if (iv.aid === null && ev.automation_id !== null && ev.automation_id !== undefined) iv.aid = ev.automation_id;
      if (ev.user_email) iv.users.add(ev.user_email);
      out.push(iv);
    }
  }
  for (const iv of open.values()) {
    iv.open = true; iv.e = Math.max(iv.s, Math.min(nowMs, iv.s + MAX_OPEN_MS)); iv.offSource = null; iv.offUser = null;
    out.push(iv);
  }
  return out.sort((a, b) => a.s - b.s);
}

/** Automation run windows from the automation-sourced relay events, clustered per automation id. */
function buildWindows(ctx, events, intervals, nowMs) {
  const byKey = new Map();
  for (const ev of events) {
    if (!isAutoSource(ev.source)) continue;
    const k = ev.automation_id === null || ev.automation_id === undefined ? 'none' : String(ev.automation_id);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(ev);
  }
  const windows = [];
  for (const [k, evs] of byKey) {
    let cur = null;
    for (const ev of evs) {
      if (cur && ev.t - cur.last <= CLUSTER_GAP_MS) { cur.last = ev.t; cur.events.push(ev); continue; }
      cur = { aid: k === 'none' ? null : Number(k), first: ev.t, last: ev.t, events: [ev] };
      windows.push(cur);
    }
  }
  // a window touching the irrigation board only via dosing events is still a window (dosing-only programs)
  for (const w of windows) {
    const irr = ctx.cfg.irrigation_equipment_id;
    w.openIntervals = intervals.filter(iv => iv.open && iv.eq === irr && ctx.runChannels.has(iv.ch)
      && isAutoSource(iv.onSource) && (iv.aid === w.aid) && iv.s >= w.first - 1000 && iv.s <= w.last + 1000);
    w.provisional = w.openIntervals.length > 0;
    w.end = w.provisional ? Math.max(w.last, nowMs) : w.last;
  }
  windows.sort((a, b) => a.first - b.first);
  // merge overlapping windows (two automations at once): one run, the busiest automation named
  const merged = [];
  for (const w of windows) {
    const prev = merged[merged.length - 1];
    if (prev && w.first <= prev.end + GRACE_MS) {
      prev.parts.push(w);
      prev.end = Math.max(prev.end, w.end);
      prev.last = Math.max(prev.last, w.last);
      prev.provisional = prev.provisional || w.provisional;
      prev.events.push(...w.events);
      continue;
    }
    merged.push({ ...w, parts: [w], events: [...w.events] });
  }
  for (const m of merged) {
    const counts = new Map();
    for (const p of m.parts) counts.set(p.aid, (counts.get(p.aid) || 0) + p.events.length);
    m.aid = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    m.aids = [...counts.keys()];
  }
  return merged;
}

// ─── counters (split a cycle that spans several zones) ──────────────────────

function counterSeries(db, eqId, name, fromMs, toMs) {
  try {
    return db.prepare(`
      SELECT timestamp, value FROM readings
      WHERE equipment_id = ? AND name = ? AND timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp
    `).all(eqId, name, iso(fromMs - 120000), iso(toMs + 120000))
      .map(r => [Date.parse(r.timestamp), Number(r.value)]).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  } catch (_) { return []; }
}

function valueAt(series, ms) {
  if (!series.length) return null;
  if (ms <= series[0][0]) return series[0][1];
  const last = series[series.length - 1];
  if (ms >= last[0]) return last[1];
  let lo = 0; let hi = series.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (series[mid][0] <= ms) lo = mid; else hi = mid; }
  const [t0, v0] = series[lo]; const [t1, v1] = series[hi];
  return t1 === t0 ? v1 : v0 + (v1 - v0) * ((ms - t0) / (t1 - t0));
}

function counterDelta(series, a, b) {
  const va = valueAt(series, a); const vb = valueAt(series, b);
  return va === null || vb === null ? null : Math.max(0, vb - va);
}

/**
 * Distribute every cycle's water + dosing over the segments.
 * segments: [{ s, e }] (valve windows). Mutates seg.water_l, seg.dosing, seg.cycles.
 */
function distribute(db, ctx, cycles, segments) {
  let counters = null;
  const getCounters = (a, b) => {
    if (counters) return counters;
    counters = { water: [], tanks: {} };
    if (!ctx.mon) return counters;
    counters.water = counterSeries(db, ctx.mon.equipment_id, 'Net Total', a, b);
    for (const [n, tankId] of Object.entries(ctx.tankMap.map)) {
      if (tankId === null) continue;
      counters.tanks[tankId] = counterSeries(db, ctx.mon.equipment_id, `Tank ${n} Consumed`, a, b);
    }
    return counters;
  };
  for (const seg of segments) { seg.water_l = seg.water_l || 0; seg.dosing = seg.dosing || {}; seg.cycles = seg.cycles || []; seg.waterKnown = seg.waterKnown || false; }
  if (!segments.length) return;
  const spanA = Math.min(...cycles.map(c => c.s));
  const spanB = Math.max(...cycles.map(c => c.e));
  for (const c of cycles) {
    const dur = Math.max(0, c.e - c.s);
    const ov = segments.map(sg => (dur > 0 ? overlapMs(c.s, c.e, sg.s, sg.e) : (c.s >= sg.s && c.s <= sg.e ? 1 : 0)));
    const total = ov.reduce((a, b) => a + b, 0);
    let shares;
    if (total <= 0) {
      // outside every valve window (clock skew): nearest segment
      const dist = segments.map(sg => (c.e < sg.s ? sg.s - c.e : c.s > sg.e ? c.s - sg.e : 0));
      const i = dist.indexOf(Math.min(...dist));
      shares = { water: segments.map((_, k) => (k === i ? 1 : 0)) };
    } else {
      const best = Math.max(...ov);
      const nonzero = ov.filter(x => x > 0).length;
      if (nonzero === 1 || best >= SINGLE_ZONE_SHARE * (dur || 1)) {
        const i = ov.indexOf(best);
        shares = { water: segments.map((_, k) => (k === i ? 1 : 0)) };
      } else {
        const cn = getCounters(spanA, spanB);
        const w = segments.map((sg, k) => (ov[k] > 0 ? counterDelta(cn.water, Math.max(c.s, sg.s), Math.min(c.e, sg.e)) : 0));
        const wSum = w.reduce((a, b) => a + (b || 0), 0);
        const water = wSum > 0 && w.every(x => x !== null) ? w.map(x => x / wSum) : ov.map(x => x / total);
        shares = { water, tanks: {} };
        for (const tankId of Object.keys(c.dosing)) {
          const series = cn.tanks[tankId] || [];
          const t = segments.map((sg, k) => (ov[k] > 0 ? counterDelta(series, Math.max(c.s, sg.s), Math.min(c.e, sg.e)) : 0));
          const tSum = t.reduce((a, b) => a + (b || 0), 0);
          shares.tanks[tankId] = tSum > 0 && t.every(x => x !== null) ? t.map(x => x / tSum) : water;
        }
        shares.split = true;
      }
    }
    segments.forEach((sg, k) => {
      const f = shares.water[k];
      if (!(f > 0)) return;
      if (c.water_l !== null) { sg.water_l += c.water_l * f; sg.waterKnown = true; }
      for (const [tankId, l] of Object.entries(c.dosing)) {
        const tf = shares.tanks && shares.tanks[tankId] ? shares.tanks[tankId][k] : f;
        sg.dosing[tankId] = (sg.dosing[tankId] || 0) + l * tf;
      }
      sg.cycles.push(shares.split ? `${c.cycle_id}~${Math.round(f * 100)}%` : c.cycle_id);
    });
  }
}

// ─── quality / status ───────────────────────────────────────────────────────

function tanksOf(ctx, dosing) {
  return ctx.nutrientIds.map(id => ({ tank_id: id, name: ctx.tankById[id] ? ctx.tankById[id].name : `Tank ${id}`, dosed_l: r2(dosing[id] || 0) }));
}

function withRatio(rec) {
  return { ...rec, achieved_ratio: zoneStats.zoneAchievedRatio(rec) };
}

/** Per-segment EC/pH from stored SEKO readings (DoseRunZoneStats.statsFromHistory). */
function historyStats(db, ctx, windows, expectedLph) {
  if (!windows.length) return [];
  const run = {
    started_at: iso(Math.min(...windows.map(w => w.s))),
    ended_at: iso(Math.max(...windows.map(w => w.e))),
    zones: windows.map(w => ({ started_at: iso(w.s), ended_at: iso(w.e) })),
  };
  const out = zoneStats.statsFromHistory(db, run, {
    sensorEquipmentId: ctx.dcCfg.sensor_equipment_id, phMetric: ctx.dcCfg.sensor_metric, ecMetric: ctx.dcCfg.ec_metric,
    expectedLph, phMin: ctx.dcCfg.plausible_min, phMax: ctx.dcCfg.plausible_max,
  });
  return out || windows.map(() => zoneStats.accFields(null));
}

/** The dose-controller run of this automation window, decorated like DoseController.formatRun (visits + stats). */
function linkedDoseRun(db, ctx, w) {
  if (w.aid === null) return null;
  let row;
  try {
    row = db.prepare(`
      SELECT * FROM dose_controller_runs
      WHERE automation_id = ? AND started_at >= ? AND started_at <= ?
      ORDER BY started_at LIMIT 1
    `).get(w.aid, iso(w.first - 120000), iso(w.last + 60000));
  } catch (_) { return null; }
  if (!row) return null;
  let zones = [];
  let tanks = [];
  try { zones = JSON.parse(row.zones_json || '[]') || []; } catch (_) { zones = []; }
  try { tanks = JSON.parse(row.tanks_json || '[]') || []; } catch (_) { tanks = []; }
  const final = row.status !== 'running';
  if (final && zones.some(z => !z.not_run && !('samples' in z))) {
    const stats = zoneStats.statsFromHistory(db, { started_at: row.started_at, ended_at: row.ended_at, zones }, {
      sensorEquipmentId: ctx.dcCfg.sensor_equipment_id, phMetric: ctx.dcCfg.sensor_metric, ecMetric: ctx.dcCfg.ec_metric,
      expectedLph: ctx.oneZoneLph, phMin: ctx.dcCfg.plausible_min, phMax: ctx.dcCfg.plausible_max,
    });
    if (stats) {
      let i = 0;
      zones = zones.map(z => (z.not_run ? z : ('samples' in z ? (i++, z) : { ...z, ...stats[i++], stats_source: 'history' })));
    }
  }
  const { visits } = zoneStats.analyseZones(zones, {
    expectedLph: ctx.oneZoneLph, final, endReason: row.end_reason,
    endSource: zoneStats.isShutdownEnd({ endReason: row.end_reason }) ? zoneStats.SHUTDOWN_SOURCE : null,
  });
  const targets = tanks.map(t => t.ratio_target).filter(x => x > 0);
  return {
    id: row.id, status: row.status, end_reason: row.end_reason, visits,
    ratio_target: targets.length && targets.every(x => x === targets[0]) ? targets[0] : null,
    acid_s: row.acid_s, water_l: row.water_l,
  };
}

const STATUS_RANK = { shutdown: 4, no_water: 3, cut_short: 2, ok: 1 };

/** shutdown (flow-watch OFF) > no_water (volume) > cut_short (an operator switched it OFF) > ok. */
function segmentStatus(ctx, seg) {
  const off = seg.offSource || '';
  if (off === 'flow_watch_shutdown') return 'shutdown';
  const a = seg.pumpS ?? seg.s; const b = seg.pumpE ?? seg.e;
  const st = zoneStatus2(seg.waterKnown ? seg.water_l : null, a, b, ctx.expected[seg.channel] || ctx.oneZoneLph);
  if (st === 'ok' && (OPERATOR_STOP_SOURCES.has(off) || OPERATOR_STOP_SOURCES.has(seg.pumpOffSource || ''))) return 'cut_short';
  return st;
}

function zoneStatus2(waterL, a, b, expectedLph) {
  return zoneStats.zoneStatus({ started_at: iso(a), ended_at: iso(b), water_l: waterL, planned_s: null }, { expectedLph });
}

function flowHint(ctx, waterL, durationS) {
  if (!(waterL > 0) || !(durationS > 0)) return { avg_flow_lph: null, zone_hint: null };
  const lph = (waterL * 3600) / durationS;
  const k = lph / ctx.oneZoneLph;
  let hint = null;
  if (Math.abs(k - 1) <= ONE_ZONE_TOL) hint = "one zone's flow";
  else if (Math.abs(k - 2) <= 2 * ONE_ZONE_TOL) hint = "about two zones' flow";
  else if (k < 1 - ONE_ZONE_TOL) hint = "less than one zone's flow";
  return { avg_flow_lph: Math.round(lph), zone_hint: hint, one_zone_lph: Math.round(ctx.oneZoneLph) };
}

function sumDosing(list) {
  const out = {};
  for (const d of list) for (const [k, v] of Object.entries(d || {})) out[k] = (out[k] || 0) + v;
  return out;
}

/** Tanks that moved >= 0.5 L while SenseHub commanded no dosing valve in the (padded) run window. */
function uncontrolledDosing(ctx, intervals, dosing, a, b) {
  const moved = Object.entries(dosing).filter(([, l]) => l >= TANK_MOVED_L).map(([id]) => Number(id));
  if (!moved.length) return { uncontrolled_dosing: false, uncontrolled_tanks: [], dosing_commanded: false };
  const cmd = intervals.filter(iv => iv.eq === ctx.cfg.dosing_equipment_id && ctx.dosingChannels.has(iv.ch)
    && overlapMs(iv.s, iv.e, a - PAD_MS, b + PAD_MS) > 0);
  const commanded = cmd.length > 0;
  return {
    uncontrolled_dosing: !commanded,
    uncontrolled_tanks: commanded ? [] : moved.map(id => ({ tank_id: id, name: ctx.tankById[id] ? ctx.tankById[id].name : `Tank ${id}`, dosed_l: r2(dosing[id]) })),
    dosing_commanded: commanded,
  };
}

function relayNote(ctx, iv) {
  return {
    channel: iv.ch, name: zoneName(ctx, iv.ch), from: iso(iv.s), to: iv.open ? null : iso(iv.e),
    opened_by: iv.onUser || iv.onSource, closed_by: iv.open ? null : (iv.offUser || iv.offSource), still_on: !!iv.open,
  };
}

// ─── run assembly ───────────────────────────────────────────────────────────

function baseRun(ctx, type, cycles, bounds, durationS = null) {
  const water = cycles.reduce((s, c) => s + (c.water_l || 0), 0);
  const waterKnown = cycles.some(c => c.water_l !== null);
  const dosing = sumDosing(cycles.map(c => c.dosing));
  const s = bounds ? bounds.s : Math.min(...cycles.map(c => c.s));
  const e = bounds ? bounds.e : Math.max(...cycles.map(c => c.e));
  const run = {
    type,
    type_label: TYPE_LABEL[type],
    started_at: iso(s),
    ended_at: iso(e),
    local_date: DR.localDateStr(ctx.tz, s),
    duration_s: durationS ?? Math.round((e - s) / 1000),
    water_l: waterKnown ? r1(water) : null,
    tanks: tanksOf(ctx, dosing),
    cycles: cycles.map(c => ({
      cycle_id: c.cycle_id, start: c.start, end: c.end, duration_s: c.duration_s, water_l: r1(c.water_l), blip: isBlip(c),
      tanks: tanksOf(ctx, c.dosing),
    })),
    cycle_ids: cycles.map(c => c.cycle_id),
  };
  run.achieved_ratio = zoneStats.zoneAchievedRatio(run);
  return { run, dosing, s, e };
}

function finish(run, visits, extra = {}) {
  run.zone_visits = visits.map((v, i) => ({ ...v, visit: i + 1 }));
  run.zone_totals = zoneStats.zoneTotals(run, run.zone_visits);
  const ran = run.zone_visits.filter(v => !v.not_run);
  const ec = run.zone_totals;
  const mins = (k) => { const xs = ran.map(v => v[k]).filter(Number.isFinite); return xs.length ? Math.min(...xs) : null; };
  const maxs = (k) => { const xs = ran.map(v => v[k]).filter(Number.isFinite); return xs.length ? Math.max(...xs) : null; };
  run.ec_ms = {
    avg: ec.ec_avg_us !== null && ec.ec_avg_us !== undefined ? r2(ec.ec_avg_us / 1000) : null,
    min: mins('ec_min_us') === null ? null : r2(mins('ec_min_us') / 1000),
    max: maxs('ec_max_us') === null ? null : r2(maxs('ec_max_us') / 1000),
    samples: ec.ec_samples || 0,
  };
  run.ph = { avg: ec.ph_avg ?? null, min: mins('ph_min'), max: maxs('ph_max'), samples: ec.samples || 0 };
  Object.assign(run, extra);
  return run;
}

function buildAutomatedRun(db, ctx, w, cycles, intervals, events, nowMs) {
  const irr = ctx.cfg.irrigation_equipment_id;
  const inWin = (iv) => overlapMs(iv.s, iv.e, w.first - 1000, w.end + 1000) > 0 || (iv.s >= w.first - 1000 && iv.s <= w.end + 1000);
  const autoOf = (iv) => isAutoSource(iv.onSource) && (w.aids.includes(iv.aid) || iv.aid === null);
  const zoneIvs = intervals.filter(iv => iv.eq === irr && ctx.zoneSet.has(iv.ch) && inWin(iv) && autoOf(iv));
  const pumpIvs = intervals.filter(iv => iv.eq === irr && iv.ch === ctx.cfg.pump_channel && inWin(iv) && autoOf(iv));
  const manualIvs = intervals.filter(iv => iv.eq === irr && ctx.runChannels.has(iv.ch) && !isAutoSource(iv.onSource)
    && overlapMs(iv.s, iv.e, w.first, w.end) > 0);

  // zone segments: consecutive intervals of the same channel (flow-watch retry of a hard-switched zone) merge
  const segs = [];
  for (const iv of zoneIvs) {
    const prev = segs[segs.length - 1];
    if (prev && prev.channel === iv.ch && iv.s - prev.e < 30000) { prev.e = iv.e; prev.offSource = iv.offSource; prev.open = iv.open; prev.parts++; continue; }
    segs.push({ channel: iv.ch, s: iv.s, e: iv.e, offSource: iv.offSource, open: !!iv.open, parts: 1 });
  }
  for (const sg of segs) {
    const pumped = pumpIvs.filter(p => overlapMs(p.s, p.e, sg.s, sg.e) > 0);
    sg.pumpS = pumped.length ? Math.max(sg.s, Math.min(...pumped.map(p => p.s))) : null;
    sg.pumpE = pumped.length ? Math.min(sg.e, Math.max(...pumped.map(p => p.e))) : null;
    // the pump's OFF counts for this zone only when it happened inside the zone window
    const pumpEnded = pumped.filter(p => !p.open && p.e <= sg.e + 1000 && p.e >= sg.s);
    sg.pumpOffSource = pumpEnded.length ? pumpEnded[pumpEnded.length - 1].offSource : null;
    sg.retries = events.filter(ev => ev.equipment_id === irr && ev.channel === ctx.cfg.pump_channel && ev.state === 0
      && ev.source === 'flow_watch_retry' && ev.t >= sg.s && ev.t <= sg.e).length;
    sg.alsoOpen = manualIvs.filter(m => ctx.zoneSet.has(m.ch) && m.ch !== sg.channel && overlapMs(m.s, m.e, sg.s, sg.e) > 0)
      .map(m => ({ channel: m.ch, name: zoneName(ctx, m.ch), by: m.onUser || m.onSource }));
  }

  const bounds = cycles.length ? null : { s: segs.length ? segs[0].s : w.first, e: segs.length ? segs[segs.length - 1].e : w.last };
  const { run, dosing, s, e } = baseRun(ctx, 'automated', cycles, bounds);
  if (!cycles.length) run.water_l = 0;
  if (segs.length && cycles.length) distribute(db, ctx, cycles, segs);

  const dcr = linkedDoseRun(db, ctx, w);
  const used = new Set();
  const dcrVisitFor = (ch) => {
    if (!dcr) return null;
    const i = dcr.visits.findIndex((v, k) => !used.has(k) && !v.not_run && v.channel === ch);
    if (i < 0) return null;
    used.add(i);
    return dcr.visits[i];
  };
  const needHistory = [];
  const visits = segs.map((sg) => {
    const rec = {
      channel: sg.channel, name: zoneName(ctx, sg.channel),
      started_at: iso(sg.s), ended_at: sg.open ? null : iso(sg.e),
      pumped_from: iso(sg.pumpS), pumped_to: iso(sg.pumpE),
      water_l: cycles.length ? (sg.waterKnown ? r1(sg.water_l) : null) : 0,
      tanks: tanksOf(ctx, sg.dosing || {}),
      cycles: sg.cycles || [],
      retries: sg.retries,
      also_open: sg.alsoOpen,
    };
    const v = dcrVisitFor(sg.channel);
    let status = sg.open ? 'running' : segmentStatus(ctx, sg);
    if (v) {
      for (const k of ['ec_avg_us', 'ec_min_us', 'ec_max_us', 'ec_samples', 'ph_avg', 'ph_min', 'ph_max', 'samples', 'skipped_samples']) rec[k] = v[k] ?? (k.endsWith('samples') ? 0 : null);
      // run-start line flush kept out of the averages (DoseRunZoneStats flush_*)
      if (v.flush_samples > 0) for (const k of FLUSH_KEYS) rec[k] = v[k] ?? null;
      rec.stats_source = 'dose_controller'; // the run's DoseController record (live or history-computed)
      rec.controller_water_l = v.water_l ?? null;
      if (!sg.open && status !== 'shutdown' && v.status && STATUS_RANK[v.status] > (STATUS_RANK[status] || 0)) status = v.status;
      if (v.retries > rec.retries) rec.retries = v.retries;
    } else {
      needHistory.push({ rec, s: sg.s, e: sg.e, ch: sg.channel });
    }
    rec.status = status;
    return rec;
  });
  if (needHistory.length) {
    const stats = historyStats(db, ctx, needHistory.map(n => ({ s: n.s, e: n.e })), ctx.oneZoneLph);
    needHistory.forEach((n, i) => Object.assign(n.rec, stats[i] || zoneStats.accFields(null), { stats_source: 'history' }));
  }
  // zones the controller lists as not irrigated after a shutdown
  if (dcr) {
    for (const v of dcr.visits.filter(x => x.not_run)) {
      if (visits.some(x => x.channel === v.channel)) continue;
      visits.push({ channel: v.channel, name: v.name || zoneName(ctx, v.channel), started_at: null, ended_at: null, water_l: null, tanks: [], not_run: true, status: 'not_run', ...zoneStats.accFields(null), samples: 0 });
    }
  }

  const decorated = visits.map(withRatio);
  const segStatuses = decorated.filter(v => !v.not_run).map(v => v.status);
  // an operator stop = an operator OFF (Stop All / manual) that closed a relay this automation had ON
  const stops = [...zoneIvs, ...pumpIvs].filter(iv => !iv.open && OPERATOR_STOP_SOURCES.has(iv.offSource || ''))
    .map(iv => ({ t: iv.e, source: iv.offSource, channel: iv.ch, user: iv.offUser })).sort((x, y) => x.t - y.t);
  const shutdownEv = events.some(ev => ev.source === 'flow_watch_shutdown' && ev.t >= w.first && ev.t <= w.end + GRACE_MS);
  let status = 'ok';
  if (w.provisional) status = 'running';
  else if (shutdownEv || segStatuses.includes('shutdown')) status = 'shutdown';
  else if (!cycles.length && ctx.monitorSeen && ctx.monitorSeen(w.first, w.end)) status = 'no_water';
  else if (segStatuses.includes('no_water')) status = 'no_water';
  else if (stops.some(ev => ev.source === STOP_IRRIGATION_SOURCE)) status = 'stopped';
  else if (segStatuses.includes('cut_short') || stops.length) status = 'cut_short';
  const auto = w.aid !== null ? ctx.autoNames[w.aid] : null;
  // notes: English text (as before) + notes_i18n (catalog specs) for tr / ar at read time
  const noteSpecs = [];
  if (stops.length) {
    noteSpecs.push(M('irrigation_runs.note.stopped_by_operator', {
      source: stops[0].source === STOP_IRRIGATION_SOURCE ? M('irrigation_runs.stop_irrigation') : String(stops[0].source),
      user: stops[0].user ? M('irrigation_runs.note.user_suffix', { user: String(stops[0].user) }) : '',
      at: clock(ctx.tz, stops[0].t),
    }));
  }
  for (const m of manualIvs.filter(m => ctx.zoneSet.has(m.ch))) {
    const base = { zone: zoneName(ctx, m.ch), opened: clock(ctx.tz, m.s), by: `${m.onUser || m.onSource}` };
    noteSpecs.push(m.open
      ? M('irrigation_runs.note.manual_open_still_on', base)
      : M('irrigation_runs.note.manual_open_closed', { ...base, closed: clock(ctx.tz, m.e), closed_by: `${m.offUser || m.offSource}` }));
  }
  if (w.aid === null) noteSpecs.push(M('irrigation_runs.note.no_automation_id'));
  const unc = uncontrolledDosing(ctx, intervals, dosing, s, e);
  if (w.aid === null) run.type_label = 'Automation';
  const notes = noteSpecs.map(n => i18n.render('en', n));
  return finish(run, decorated, {
    key: `a:${w.aid ?? 'none'}:${toSqlTs(w.first).replace(' ', 'T')}`,
    status,
    provisional: !!w.provisional,
    automation_id: w.aid,
    automation_name: auto ? auto.name : null,
    automation_ids: w.aids,
    window_from: iso(w.first),
    window_to: iso(w.end),
    dose_controller_run_id: dcr ? dcr.id : null,
    ratio_target: dcr ? dcr.ratio_target : null,
    acid_s: dcr ? dcr.acid_s : null,
    operators: [],
    manual_overlap: manualIvs.map(m => relayNote(ctx, m)),
    operator_stops: stops.map(ev => ({ at: iso(ev.t), source: ev.source, channel: ev.channel, user: ev.user || null })),
    notes,
    notes_i18n: noteSpecs,
    ...flowHint(ctx, run.water_l, cycles.length ? cycles.reduce((a, c) => a + c.duration_s, 0) : 0),
    zone_hint: null,
    ...unc,
  });
}

function buildManualRun(db, ctx, group, intervals) {
  const irr = ctx.cfg.irrigation_equipment_id;
  const core = group.filter(c => !isBlip(c));
  const boundCycles = core.length ? core : group;
  const s = Math.min(...boundCycles.map(c => c.s));
  const e = Math.max(...boundCycles.map(c => c.e));
  const a = Math.min(...group.map(c => c.s)) - PAD_MS;
  const b = Math.max(...group.map(c => c.e)) + PAD_MS;
  const appIvs = intervals.filter(iv => iv.eq === irr && ctx.runChannels.has(iv.ch) && !isAutoSource(iv.onSource)
    && (overlapMs(iv.s, iv.e, a, b) > 0 || (iv.s >= a && iv.s <= b)));
  const coverage = unionMs(appIvs.map(iv => [iv.s, iv.e]), a, b) / Math.max(1, b - a);
  const type = appIvs.length && coverage >= MANUAL_COVERAGE ? 'manual_app' : 'manual_panel';
  const { run, dosing } = baseRun(ctx, type, group, { s, e }, boundCycles.length === 1 ? boundCycles[0].duration_s : null);
  const waterDurS = boundCycles.reduce((x, c) => x + (c.duration_s || 0), 0) || run.duration_s;
  const hint = flowHint(ctx, run.water_l, waterDurS);
  // operator = whoever switched the relays ON (a later OFF by someone else is "closed by")
  const users = [...new Set(appIvs.filter(iv => iv.e > iv.s).map(iv => iv.onUser).filter(Boolean))];

  let visits;
  if (type === 'manual_app') {
    const zoneIvs = appIvs.filter(iv => ctx.zoneSet.has(iv.ch));
    const segs = [];
    for (const iv of zoneIvs) {
      const prev = segs.find(sg => sg.channel === iv.ch && iv.s - sg.e < MERGE_GAP_MS);
      if (prev) { prev.e = Math.max(prev.e, iv.e); continue; }
      segs.push({ channel: iv.ch, s: iv.s, e: iv.e });
    }
    // segment = the part of the relay window that had water (else the relay window inside the padded run)
    for (const sg of segs) {
      const ws = Math.max(sg.s, s); const we = Math.min(sg.e, e);
      if (we > ws) { sg.s = ws; sg.e = we; } else { sg.s = Math.max(sg.s, a); sg.e = Math.min(sg.e, b); }
    }
    segs.sort((x, y) => x.s - y.s);
    if (segs.length) {
      distribute(db, ctx, group, segs);
      const stats = historyStats(db, ctx, segs.map(sg => ({ s: sg.s, e: sg.e })), ctx.oneZoneLph);
      visits = segs.map((sg, i) => ({
        channel: sg.channel, name: zoneName(ctx, sg.channel), started_at: iso(sg.s), ended_at: iso(sg.e),
        water_l: sg.waterKnown ? r1(sg.water_l) : null, tanks: tanksOf(ctx, sg.dosing), cycles: sg.cycles,
        ...stats[i], stats_source: 'history', status: 'manual', operators: users,
      }));
    }
  }
  if (!visits) {
    const stats = historyStats(db, ctx, [{ s, e }], ctx.oneZoneLph)[0] || zoneStats.accFields(null);
    visits = [{
      channel: null, name: 'Zone unknown', zone_unknown: true, zone_hint: hint.zone_hint,
      started_at: iso(s), ended_at: iso(e), water_l: run.water_l, tanks: run.tanks, cycles: run.cycle_ids,
      ...stats, stats_source: 'history', status: 'manual',
    }];
  }
  const unc = uncontrolledDosing(ctx, intervals, dosing, s, e);
  const noteSpecs = [];
  if (type === 'manual_panel') {
    noteSpecs.push(M('irrigation_runs.note.panel_run'));
    if (appIvs.length) {
      noteSpecs.push(M('irrigation_runs.note.app_switches', {
        switches: i18n.list(appIvs.map(iv => M('irrigation_runs.note.app_switch', { zone: zoneName(ctx, iv.ch), at: clock(ctx.tz, iv.s), by: `${iv.onUser || iv.onSource}` }))),
      }));
    }
  }
  if (unc.uncontrolled_dosing) {
    noteSpecs.push(M('irrigation_runs.note.uncontrolled_dosing', {
      tanks: i18n.list(unc.uncontrolled_tanks.map(t => M('irrigation_runs.note.tank_litres', { tank: t.name.split(' — ')[0], litres: `${t.dosed_l}` }))),
    }));
  }
  const notes = noteSpecs.map(n => i18n.render('en', n));
  return finish(run, visits.map(withRatio), {
    key: `c:${group[0].cycle_id}`,
    status: 'manual',
    provisional: false,
    automation_id: null,
    automation_name: null,
    dose_controller_run_id: null,
    ratio_target: null,
    operators: type === 'manual_app' ? users : [],
    operator_known: type === 'manual_app' && users.length > 0,
    app_relays: appIvs.map(iv => relayNote(ctx, iv)),
    app_relay_coverage_pct: Math.round(coverage * 100),
    blips_absorbed: group.length - boundCycles.length,
    notes,
    notes_i18n: noteSpecs,
    ...hint,
    ...unc,
  });
}

/**
 * Build the runs whose start falls in [fromMs, toMs).
 * @returns {{ runs: object[], dropped: object[], timezone: string, generated_at: string }}
 */
function buildRuns(db, { fromMs, toMs, nowMs = Date.now(), config = null } = {}) {
  const ctx = loadContext(db, { config: config || undefined });
  const loadFrom = fromMs - LOAD_MARGIN_MS;
  const loadTo = Math.min(toMs + LOAD_MARGIN_MS, nowMs + 60000);
  const cycles = loadCycles(ctx, db, loadFrom, loadTo);
  const events = loadEvents(ctx, db, loadFrom - RELAY_LOOKBACK_MS, Math.max(loadTo, nowMs) + 60000);
  const intervals = buildIntervals(events, nowMs);
  const windows = buildWindows(ctx, events, intervals, nowMs);
  ctx.monitorSeen = (a, b) => {
    if (!ctx.mon) return false;
    try {
      return !!db.prepare('SELECT 1 FROM readings WHERE equipment_id = ? AND timestamp >= ? AND timestamp <= ? LIMIT 1').get(ctx.mon.equipment_id, iso(a), iso(b));
    } catch (_) { return false; }
  };

  const byWindow = new Map();
  const free = [];
  for (const c of cycles) {
    const w = windows.find(x => c.s >= x.first - PAD_MS && c.s <= x.end + GRACE_MS);
    if (w) { if (!byWindow.has(w)) byWindow.set(w, []); byWindow.get(w).push(c); } else free.push(c);
  }

  const runs = [];
  for (const w of windows) {
    const cs = byWindow.get(w) || [];
    if (!cs.length) {
      // an automation that ran the pump >= 30 s on a zone but produced no cycle report
      const irr = ctx.cfg.irrigation_equipment_id;
      const pumped = intervals.some(iv => iv.eq === irr && iv.ch === ctx.cfg.pump_channel && isAutoSource(iv.onSource)
        && w.aids.includes(iv.aid) && iv.s >= w.first - 1000 && iv.s <= w.end && !iv.open && iv.e - iv.s >= 30000);
      if (!pumped || w.provisional || !ctx.monitorSeen(w.first, w.end)) continue;
    }
    runs.push(buildAutomatedRun(db, ctx, w, cs, intervals, events, nowMs));
  }

  const dropped = [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    const span = (Math.max(...group.map(c => c.e)) - Math.min(...group.map(c => c.s))) / 1000;
    const water = group.reduce((s, c) => s + (c.water_l || 0), 0);
    if (span < BLIP_MIN_S || water < BLIP_MIN_L) {
      for (const c of group) dropped.push({ cycle_id: c.cycle_id, start: c.start, end: c.end, duration_s: c.duration_s, water_l: r1(c.water_l), reason: 'drain-back blip', tanks: tanksOf(ctx, c.dosing) });
    } else {
      runs.push(buildManualRun(db, ctx, group, intervals));
    }
    group = [];
  };
  for (const c of free) {
    const prev = group[group.length - 1];
    if (prev && c.s - prev.e >= MERGE_GAP_MS) flush();
    group.push(c);
  }
  flush();

  const inRange = (ms) => ms >= fromMs && ms < toMs;
  return {
    runs: runs.filter(r => inRange(Date.parse(r.started_at))).sort((x, y) => Date.parse(x.started_at) - Date.parse(y.started_at)),
    dropped: dropped.filter(d => inRange(Date.parse(d.start))),
    timezone: ctx.tz,
    generated_at: iso(nowMs),
  };
}

/** Totals that reconcile the runs with the monitor's cycle reports. */
function summariseRuns(runs, dropped) {
  const byType = {};
  for (const r of runs) {
    const t = byType[r.type] || (byType[r.type] = { count: 0, water_l: 0 });
    t.count++; t.water_l += r.water_l || 0;
  }
  for (const t of Object.values(byType)) t.water_l = r1(t.water_l);
  const runsWater = runs.reduce((s, r) => s + (r.water_l || 0), 0);
  const droppedWater = dropped.reduce((s, d) => s + (d.water_l || 0), 0);
  return {
    runs: runs.length,
    water_l: r1(runsWater),
    dropped_blips: dropped.length,
    dropped_water_l: r1(droppedWater),
    cycles_water_l: r1(runsWater + droppedWater),
    cycles: runs.reduce((s, r) => s + r.cycles.length, 0) + dropped.length,
    by_type: byType,
    uncontrolled_dosing_runs: runs.filter(r => r.uncontrolled_dosing).length,
  };
}

module.exports = {
  buildRuns,
  summariseRuns,
  // exported for tests
  buildIntervals,
  unionMs,
  valueAt,
  isAutoSource,
  TYPE_LABEL,
  PAD_MS,
  GRACE_MS,
  MERGE_GAP_MS,
  BLIP_MIN_S,
  BLIP_MIN_L,
};
