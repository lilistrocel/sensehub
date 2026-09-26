/**
 * IrrigationFlowWatchService — live irrigation flow-watch alerts.
 *
 * Incident 2026-09-26 09:40:55: Zone 4's relay was ON and confirmed, both pumps
 * ran, but its valve never opened: flow fell 8,837 → 0 L/h in 18 s and stayed
 * there for 2 min 50 s while all four fertiliser tanks kept dosing (~16 L of
 * concentrate) into a line that was not moving. Nothing alerted. This service
 * watches the irrigation monitor's full-rate MQTT stream against the relay
 * state and raises fingerprinted alerts within ~35 s.
 *
 * INPUTS (read-only)
 *   - Irrigation monitor live stream via MqttIngestService.onLive():
 *     flowmeter (0.5 s while irrigating / 10 s idle) and dosing (1 s / 10 s).
 *     The downsampled readings table is NOT used — it is too coarse.
 *   - Relay ACTUAL state: equipment.last_reading.relayStates of the irrigation
 *     board (written by the 15 s poll and by every write path's read-back via
 *     RelayStateCache). Fresh only if last_communication < relay_fresh_seconds.
 *   - Relay COMMANDED state/time: latest relay_events row per channel (when a
 *     zone or pump was switched ON; whether a dosing valve is commanded open).
 *   - FertigationDoseScheduler.isRunning()/currentCycle().
 *   Evaluated on every live flowmeter/dosing sample and on a 5 s timer, so a
 *   monitor that goes silent is noticed.
 *
 * RULES (thresholds in system_settings 'irrigation_flow_watch', see DEFAULT_CONFIG)
 *   valve_no_flow        alarm   pump + zone ON, >= settle s since the most recent zone
 *                                open / pump start, flow < no_flow_pct of expected for
 *                                no_flow_seconds, meter healthy. Key per zone.
 *   low_flow             caution same gating, no_flow_pct <= flow < low_flow_pct for
 *                                low_flow_seconds. Key per zone.
 *   flow_above_expected  caution exactly one zone ON, 30 s mean flow > zone baseline
 *                                + above_expected_pct for above_expected_seconds
 *                                (another valve open?). Baseline learned per zone.
 *   dosing_without_water alarm   a dosing valve is open (dose cycle running or
 *                                commanded ON), a metered tank reports rate > dosing_rate_lph
 *                                and flow < dosing_max_flow_lph for dosing_seconds.
 *                                abort_dosing_on_no_water (default TRUE): abort the running
 *                                dose cycle through FertigationDoseScheduler.abortCycle()
 *                                (source 'flow_watch') — closing injector valves only.
 *   water_without_valve  caution flow > 1,000 L/h for 30 s with no zone relay ON.
 *   flow_after_pump_off  caution flow > 1,000 L/h for 20 s with the pump relay OFF.
 *   monitor_blind        caution pump ON but no fresh flowmeter data for 60 s, or the
 *                                meter unhealthy (signal < 60 / error_flags != 0) for 30 s.
 *
 * ACTUATION: the ONLY actuation is the optional dose-cycle abort, which goes
 * through the scheduler's existing abort path (writes coils OFF, logs every
 * write via RelayEventLogger). It never energises anything, never touches the
 * pumps or zone valves, and runs regardless of the arming state (closing
 * dosing valves is the fail-safe direction; disarm must never block a stop).
 *
 * ALERTS: createAlert() with a stable fingerprint `flow_watch:<rule>:<eq>[:<ch>]`,
 * once per episode. When the condition ends the same open alert is rewritten via
 * updateOpenAlert() ("Resolved: ... recovered after 25 s" → info; ended without
 * recovering keeps its severity). Episodes go to irrigation_flow_episodes.
 */

const RULES = {
  valve_no_flow: { severity: 'critical', level: 'alarm', title: 'Irrigation: no water flow' },
  low_flow: { severity: 'warning', level: 'caution', title: 'Irrigation: low flow' },
  flow_above_expected: { severity: 'warning', level: 'caution', title: 'Irrigation: more flow than one zone' },
  dosing_without_water: { severity: 'critical', level: 'alarm', title: 'Fertigation: dosing without water' },
  water_without_valve: { severity: 'warning', level: 'caution', title: 'Irrigation: flow with no zone open' },
  flow_after_pump_off: { severity: 'warning', level: 'caution', title: 'Irrigation: flow with pump OFF' },
  monitor_blind: { severity: 'warning', level: 'caution', title: 'Irrigation: flow not verifiable' },
};
const ZONE_RULES = ['valve_no_flow', 'low_flow', 'flow_above_expected'];

const CONFIG_KEY = 'irrigation_flow_watch';
const BASELINE_KEY = 'irrigation_flow_baseline';
const TICK_MS = 5000;
const EVAL_MIN_GAP_MS = 200;
const RELAY_CACHE_MS = 1000;
const STATIC_CACHE_MS = 60000;
const MIN_SAMPLES_PER_BASELINE_MINUTE = 20;   // >= 10 s of 0.5 s samples in the minute
const STEADY_AFTER_SETTLE_MS = 10000;          // learn only >= settle + 10 s after a zone opened

const DEFAULT_CONFIG = {
  enabled: true,
  monitor_farm_id: null,          // null = any (the single) irrigation monitor
  irrigation_equipment_id: 1,
  pump_channel: 1,
  zone_channels: [3, 4, 5, 6],
  dosing_equipment_id: 2,
  expected_flow_lph: null,        // null = relay_channel_config.flow_rate of the zone
  settle_seconds: 20,
  no_flow_pct: 15,
  no_flow_seconds: 15,
  low_flow_pct: 70,
  low_flow_seconds: 60,
  above_expected_pct: 3,
  above_expected_fallback_pct: 5, // used while no baseline has been learned yet
  above_expected_seconds: 60,
  above_expected_window_seconds: 30,
  baseline_minutes: 30,           // steady minute-means kept per zone (median = baseline)
  baseline_min_minutes: 3,        // minute-means needed before the learned baseline is used
  dosing_rate_lph: 5,
  dosing_max_flow_lph: 500,
  dosing_seconds: 15,
  abort_dosing_on_no_water: true,
  water_without_valve_lph: 1000,
  water_without_valve_seconds: 30,
  flow_after_pump_off_lph: 1000,
  flow_after_pump_off_seconds: 20,
  blind_stale_seconds: 60,
  blind_unhealthy_seconds: 30,
  min_signal_quality: 60,
  flow_fresh_seconds: 25,         // monitor sends every 10 s when it thinks it is idle
  dosing_fresh_seconds: 30,
  relay_fresh_seconds: 60,        // relay board polled every 15 s
  clear_seconds: 5,
  gap_seconds: 3,
  episode_min_seconds: 10,
  telegram: true,                 // alarms (critical) also go to Telegram when configured
};

const NUM = (min, max) => ({ type: 'number', min, max });
const INT = (min, max) => ({ type: 'int', min, max });
const CONFIG_SCHEMA = {
  enabled: { type: 'bool' },
  monitor_farm_id: { type: 'farm' },
  irrigation_equipment_id: INT(1, 1e9),
  pump_channel: INT(1, 64),
  zone_channels: { type: 'channels' },
  dosing_equipment_id: INT(1, 1e9),
  expected_flow_lph: { type: 'nullable_number', min: 1, max: 1e6 },
  settle_seconds: NUM(0, 600),
  no_flow_pct: NUM(1, 95),
  no_flow_seconds: NUM(1, 600),
  low_flow_pct: NUM(5, 99),
  low_flow_seconds: NUM(1, 3600),
  above_expected_pct: NUM(0.5, 100),
  above_expected_fallback_pct: NUM(0.5, 100),
  above_expected_seconds: NUM(1, 3600),
  above_expected_window_seconds: NUM(5, 300),
  baseline_minutes: INT(1, 1000),
  baseline_min_minutes: INT(1, 1000),
  dosing_rate_lph: NUM(0, 1000),
  dosing_max_flow_lph: NUM(0, 100000),
  dosing_seconds: NUM(1, 600),
  abort_dosing_on_no_water: { type: 'bool' },
  water_without_valve_lph: NUM(1, 100000),
  water_without_valve_seconds: NUM(1, 3600),
  flow_after_pump_off_lph: NUM(1, 100000),
  flow_after_pump_off_seconds: NUM(1, 3600),
  blind_stale_seconds: NUM(10, 3600),
  blind_unhealthy_seconds: NUM(1, 3600),
  min_signal_quality: NUM(0, 100),
  flow_fresh_seconds: NUM(2, 600),
  dosing_fresh_seconds: NUM(2, 600),
  relay_fresh_seconds: NUM(10, 3600),
  clear_seconds: NUM(0, 600),
  gap_seconds: NUM(0, 60),
  episode_min_seconds: NUM(1, 3600),
  telegram: { type: 'bool' },
};

/** Validate a partial config update. Returns { value } or { error }. */
function validateConfigUpdate(updates) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return { error: 'body must be a JSON object' };
  const out = {};
  for (const [k, v] of Object.entries(updates)) {
    const spec = CONFIG_SCHEMA[k];
    if (!spec) return { error: `unknown setting "${k}"` };
    switch (spec.type) {
      case 'bool':
        if (typeof v !== 'boolean') return { error: `${k} must be true or false` };
        break;
      case 'number': case 'int':
        if (typeof v !== 'number' || !Number.isFinite(v) || v < spec.min || v > spec.max || (spec.type === 'int' && !Number.isInteger(v))) {
          return { error: `${k} must be ${spec.type === 'int' ? 'an integer' : 'a number'} between ${spec.min} and ${spec.max}` };
        }
        break;
      case 'nullable_number':
        if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < spec.min || v > spec.max)) {
          return { error: `${k} must be null or a number between ${spec.min} and ${spec.max}` };
        }
        break;
      case 'farm':
        if (v !== null && !(typeof v === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(v))) return { error: `${k} must be null or a farm id` };
        break;
      case 'channels':
        if (!Array.isArray(v) || v.length === 0 || v.length > 32 || !v.every(c => Number.isInteger(c) && c >= 1 && c <= 64) || new Set(v).size !== v.length) {
          return { error: `${k} must be a non-empty list of distinct channel numbers 1-64` };
        }
        break;
      default:
        return { error: `unsupported setting "${k}"` };
    }
    out[k] = v;
  }
  return { value: out };
}

function parseDbTs(s) {
  if (!s) return null;
  const str = String(s);
  const hasZone = /[zZ]|[+-]\d\d:?\d\d$/.test(str);
  const ms = Date.parse(hasZone ? str : `${str.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : null;
}

const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
const round = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x));
const fmtLph = (x) => (x === null || x === undefined || !Number.isFinite(x) ? '?' : Math.round(x).toLocaleString('en-US'));
function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}
function fmtClock(ms) {
  try {
    return new Date(ms).toLocaleTimeString('en-GB', { timeZone: process.env.TZ || undefined, hour12: false });
  } catch (_) {
    return new Date(ms).toISOString().slice(11, 19);
  }
}
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function shortTankName(name, id) {
  if (!name) return `Tank ${id}`;
  return String(name).split(' — ')[0] || name;
}

class IrrigationFlowWatchService {
  /**
   * @param {object} deps
   * @param {import('better-sqlite3').Database} deps.db
   * @param {Function} [deps.now]            () => epoch ms
   * @param {Function} [deps.createAlert]    utils/alertBroadcast createAlert
   * @param {Function} [deps.updateOpenAlert] utils/alertBroadcast updateOpenAlert
   * @param {Function} [deps.notify]         async (title, text, severity) — Telegram
   * @param {object}   [deps.doseScheduler]  { isRunning(), currentCycle(), abortCycle(reason, {source}) }
   * @param {object}   [deps.mqtt]           { onLive(fn) } (MqttIngestService)
   * @param {object}   [deps.config]         overrides on top of stored config (tests)
   * @param {object}   [deps.logger]
   */
  constructor(deps = {}) {
    this.db = deps.db;
    this.now = deps.now || (() => Date.now());
    this._createAlert = deps.createAlert || (() => null);
    this._updateOpenAlert = deps.updateOpenAlert || (() => null);
    this._notify = deps.notify || null;
    this.doseScheduler = deps.doseScheduler || null;
    this.mqtt = deps.mqtt || null;
    this.configOverride = deps.config || null;
    this.log = deps.logger || console;

    this.startedAt = this.now();
    this.timer = null;
    this._unsubscribe = null;
    this._config = null;
    this._configAt = 0;

    this.flow = null;         // { values, receivedMs, farmId, equipmentId }
    this.dosing = null;       // { tanks, receivedMs }
    this.irrigation = null;   // { active, since, receivedMs }
    this.samples = [];        // [ms, flow_lph] for the rolling mean
    this.unhealthySince = null;
    this._seenOn = new Map(); // `${eq}:${ch}` -> first ms we saw it ON without an ON event
    this._relayCache = null;
    this._static = null;
    this.instances = new Map(); // key -> rule instance
    this.baselines = {};        // `${eq}:${ch}` -> { means: [..], updated_at }
    this._bucket = null;        // { zoneKey, minute, sum, n }
    this._pending = new Set();  // in-flight async work (abort, notify)
    this._lastEvalMs = 0;
    this._otherFarmLogged = new Set();
    this.lastEvaluation = null;
  }

  // ─── lifecycle ────────────────────────────────────────────────────────────

  start() {
    this._closeInterruptedEpisodes();
    this._loadBaselines();
    if (this.mqtt && !this._unsubscribe) this._unsubscribe = this.mqtt.onLive(evt => this.ingest(evt));
    if (!this.timer) {
      this.timer = setInterval(() => {
        try { this.evaluate(); } catch (e) { this.log.error(`[FlowWatch] evaluate failed: ${e.message}`); }
      }, TICK_MS);
      if (this.timer.unref) this.timer.unref();
    }
    const cfg = this.getConfig();
    this.log.log(`[FlowWatch] Started (enabled=${cfg.enabled}, irrigation eq ${cfg.irrigation_equipment_id} pump ch${cfg.pump_channel} zones ${cfg.zone_channels.join(',')}, abort_dosing_on_no_water=${cfg.abort_dosing_on_no_water})`);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this._unsubscribe) { this._unsubscribe(); this._unsubscribe = null; }
  }

  /** Resolves when in-flight async work (dose abort, notifications) is done. For tests. */
  async flush() {
    while (this._pending.size) await Promise.allSettled([...this._pending]);
  }

  _track(promise) {
    const p = Promise.resolve(promise).catch(e => this.log.error(`[FlowWatch] ${e.message}`)).finally(() => this._pending.delete(p));
    this._pending.add(p);
    return p;
  }

  // ─── config ───────────────────────────────────────────────────────────────

  getStoredConfig() {
    try {
      const row = this.db.prepare('SELECT value FROM system_settings WHERE key = ?').get(CONFIG_KEY);
      if (row && row.value) {
        const parsed = JSON.parse(row.value);
        const { value } = validateConfigUpdate(Object.fromEntries(Object.entries(parsed).filter(([k]) => k in CONFIG_SCHEMA)));
        return value || {};
      }
    } catch (e) {
      this.log.error(`[FlowWatch] bad ${CONFIG_KEY} setting, using defaults: ${e.message}`);
    }
    return {};
  }

  getConfig() {
    const nowMs = this.now();
    if (!this._config || nowMs - this._configAt > 30000 || nowMs < this._configAt) {
      this._config = { ...DEFAULT_CONFIG, ...this.getStoredConfig(), ...(this.configOverride || {}) };
      this._configAt = nowMs;
    }
    return this._config;
  }

  saveConfig(updates) {
    const { value, error } = validateConfigUpdate(updates);
    if (error) { const e = new Error(error); e.status = 400; throw e; }
    const merged = { ...DEFAULT_CONFIG, ...this.getStoredConfig(), ...value };
    if (merged.no_flow_pct >= merged.low_flow_pct) {
      const e = new Error('no_flow_pct must be below low_flow_pct'); e.status = 400; throw e;
    }
    this.db.prepare(
      "INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).run(CONFIG_KEY, JSON.stringify(merged));
    this._config = null;
    this._static = null;
    this._relayCache = null;
    return this.getConfig();
  }

  resetBaselines() {
    this.baselines = {};
    this._bucket = null;
    this._saveBaselines();
  }

  // ─── input ────────────────────────────────────────────────────────────────

  /** One live event from MqttIngestService.onLive(). */
  ingest(evt) {
    if (!evt || evt.live === false) return;
    const cfg = this.getConfig();
    if (cfg.monitor_farm_id !== null && String(evt.farmId) !== String(cfg.monitor_farm_id)) return;
    if (cfg.monitor_farm_id === null && this.flow && this.flow.farmId && evt.farmId !== this.flow.farmId && !this._otherFarmLogged.has(evt.farmId)) {
      this._otherFarmLogged.add(evt.farmId);
      this.log.warn(`[FlowWatch] second irrigation monitor farm/${evt.farmId} seen; set irrigation_flow_watch.monitor_farm_id to pick one`);
    }
    const nowMs = evt.receivedMs || this.now();
    if (evt.kind === 'flowmeter' && evt.values) {
      const prev = this.flow ? this.flow.values : {};
      this.flow = { values: { ...prev, ...evt.values }, receivedMs: nowMs, farmId: evt.farmId, equipmentId: evt.equipmentId };
      if (typeof evt.values.flow_lph === 'number') {
        this.samples.push([nowMs, evt.values.flow_lph]);
        const keepMs = Math.max(cfg.above_expected_window_seconds, 60) * 1000;
        while (this.samples.length && this.samples[0][0] < nowMs - keepMs) this.samples.shift();
      }
      this.evaluate(nowMs, { learn: true });
    } else if (evt.kind === 'dosing' && Array.isArray(evt.tanks)) {
      this.dosing = { tanks: evt.tanks, receivedMs: nowMs };
      this.evaluate(nowMs);
    } else if (evt.kind === 'irrigation_state') {
      this.irrigation = { active: !!evt.active, since: evt.since || null, receivedMs: nowMs };
    }
  }

  // ─── state readers ────────────────────────────────────────────────────────

  _staticInfo(cfg, nowMs) {
    if (this._static && nowMs - this._static.at < STATIC_CACHE_MS && nowMs >= this._static.at) return this._static;
    const db = this.db;
    const eq = db.prepare('SELECT id, name, register_mappings FROM equipment WHERE id = ?').get(cfg.irrigation_equipment_id);
    const names = {};
    if (eq && eq.register_mappings) {
      try {
        for (const m of JSON.parse(eq.register_mappings) || []) {
          const ch = parseInt(m.register, 10);
          if (Number.isInteger(ch) && m.name) names[ch] = m.name;
        }
      } catch (_) { /* unnamed channels fall back to "relay N" */ }
    }
    const expected = {};
    for (const r of db.prepare('SELECT channel, flow_rate, flow_unit FROM relay_channel_config WHERE equipment_id = ?').all(cfg.irrigation_equipment_id)) {
      const rate = Number(r.flow_rate);
      if (!Number.isFinite(rate) || rate <= 0) continue;
      const unit = String(r.flow_unit || 'L/min').toLowerCase();
      expected[r.channel] = unit === 'l/h' ? rate : unit === 'm3/h' || unit === 'm³/h' ? rate * 1000 : rate * 60;
    }
    const dosingEq = db.prepare('SELECT id, name FROM equipment WHERE id = ?').get(cfg.dosing_equipment_id);
    const tanks = db.prepare('SELECT id, name, equipment_id, channel FROM fertigation_tanks').all();
    const tankNames = {};
    for (const t of tanks) tankNames[t.id] = t.name;
    const dosingChannels = [...new Set(tanks.filter(t => t.equipment_id === cfg.dosing_equipment_id && t.channel != null).map(t => t.channel))];
    this._static = {
      at: nowMs,
      eqName: eq ? eq.name : `equipment ${cfg.irrigation_equipment_id}`,
      eqExists: !!eq,
      names, expected,
      dosingEqName: dosingEq ? dosingEq.name : `equipment ${cfg.dosing_equipment_id}`,
      tankNames, dosingChannels,
    };
    return this._static;
  }

  _latestEvent(eqId, ch) {
    return this.db.prepare(
      'SELECT state, source, created_at FROM relay_events WHERE equipment_id = ? AND channel = ? ORDER BY id DESC LIMIT 1'
    ).get(eqId, ch);
  }

  /** Actual relay state of pump + zones, with open times. Cached 1 s. */
  _relays(cfg, nowMs) {
    const c = this._relayCache;
    if (c && nowMs - c.at < RELAY_CACHE_MS && nowMs >= c.at) return c.value;
    const st = this._staticInfo(cfg, nowMs);
    const eqId = cfg.irrigation_equipment_id;
    const eq = this.db.prepare('SELECT last_reading, last_communication FROM equipment WHERE id = ?').get(eqId);
    let value;
    if (!eq) {
      value = { known: false, reason: `irrigation equipment #${eqId} not found`, ageMs: null };
    } else {
      const commMs = parseDbTs(eq.last_communication);
      const ageMs = commMs === null ? null : nowMs - commMs;
      let states = null;
      try { states = (JSON.parse(eq.last_reading || '{}') || {}).relayStates || null; } catch (_) { states = null; }
      const fresh = ageMs !== null && ageMs <= cfg.relay_fresh_seconds * 1000;
      const channels = [cfg.pump_channel, ...cfg.zone_channels];
      const haveAll = states && channels.every(ch => typeof states[ch] === 'boolean');
      if (!fresh || !haveAll) {
        value = { known: false, reason: !fresh ? 'irrigation relay board state is stale' : 'irrigation relay state not reported', ageMs };
      } else {
        const chan = (ch) => {
          const on = states[ch] === true;
          const k = `${eqId}:${ch}`;
          let openedAt = null;
          if (on) {
            const ev = this._latestEvent(eqId, ch);
            const evMs = ev && ev.state === 1 ? parseDbTs(ev.created_at) : null;
            if (evMs !== null) { openedAt = evMs; this._seenOn.delete(k); }
            else {
              if (!this._seenOn.has(k)) this._seenOn.set(k, nowMs);
              openedAt = this._seenOn.get(k);
            }
          } else {
            this._seenOn.delete(k);
          }
          return { channel: ch, on, openedAt };
        };
        const pump = chan(cfg.pump_channel);
        const zones = cfg.zone_channels.map(ch => {
          const z = chan(ch);
          const configured = cfg.expected_flow_lph || st.expected[ch] || null;
          const b = this._baselineFor(eqId, ch, cfg);
          return {
            ...z,
            name: st.names[ch] || `Relay ${ch}`,
            configuredLph: configured,
            baselineLph: b.lph,
            baselineMinutes: b.minutes,
            expectedLph: b.lph || configured,
          };
        });
        value = { known: true, ageMs, pump, zones };
      }
    }
    // Dosing valves: commanded state (dose_program writes do not refresh the
    // relayStates cache between polls, so relay_events is the timely source).
    const commandedOpen = [];
    for (const ch of st.dosingChannels) {
      const ev = this._latestEvent(cfg.dosing_equipment_id, ch);
      if (ev && ev.state === 1) commandedOpen.push(ch);
    }
    value.dosingCommandedOpen = commandedOpen;
    this._relayCache = { at: nowMs, value };
    return value;
  }

  _meter(cfg, nowMs) {
    const f = this.flow;
    const lastMs = f ? f.receivedMs : null;
    const ageMs = lastMs === null ? null : nowMs - lastMs;
    const fresh = ageMs !== null && ageMs <= cfg.flow_fresh_seconds * 1000;
    const v = f ? f.values : {};
    const signal = typeof v.signal_quality === 'number' ? v.signal_quality : null;
    const errorFlags = typeof v.error_flags === 'number' ? v.error_flags : null;
    const healthy = (signal === null || signal >= cfg.min_signal_quality) && (errorFlags === null || errorFlags === 0);
    const flow = typeof v.flow_lph === 'number' ? v.flow_lph : null;
    if (fresh && !healthy) { if (this.unhealthySince === null) this.unhealthySince = nowMs; }
    else if (fresh && healthy) this.unhealthySince = null;
    return {
      lastMs, ageMs, fresh, healthy, signal, errorFlags, flow,
      known: fresh && healthy && flow !== null,
      staleForMs: nowMs - (lastMs === null ? this.startedAt : Math.max(lastMs, 0)),
      unhealthyForMs: this.unhealthySince === null ? 0 : nowMs - this.unhealthySince,
    };
  }

  _rollingMean(cfg, nowMs, fromMs) {
    const since = Math.max(nowMs - cfg.above_expected_window_seconds * 1000, fromMs);
    let sum = 0; let n = 0;
    for (let i = this.samples.length - 1; i >= 0; i--) {
      const [t, v] = this.samples[i];
      if (t < since) break;
      if (t > nowMs) continue;
      sum += v; n++;
    }
    return n ? { mean: sum / n, n } : { mean: null, n: 0 };
  }

  _dosingState(cfg, nowMs, relays, st) {
    const d = this.dosing;
    const fresh = !!d && nowMs - d.receivedMs <= cfg.dosing_fresh_seconds * 1000;
    const tanks = (d ? d.tanks : []).map(t => ({
      id: t.id, name: st.tankNames[t.id] || `Tank ${t.id}`, rate_lph: t.rate_lph, consumed_l: t.consumed_l,
    }));
    const active = fresh ? tanks.filter(t => typeof t.rate_lph === 'number' && t.rate_lph > cfg.dosing_rate_lph) : [];
    let cycle = null;
    try {
      if (this.doseScheduler && this.doseScheduler.isRunning()) cycle = this.doseScheduler.currentCycle() || { };
    } catch (_) { cycle = null; }
    const cycleRunning = !!cycle && !cycle.dryRun;
    const open = cycleRunning || (relays.dosingCommandedOpen || []).length > 0;
    return { fresh, tanks, active, cycle, cycleRunning, open, ageMs: d ? nowMs - d.receivedMs : null };
  }

  // ─── baselines ────────────────────────────────────────────────────────────

  _baselineFor(eqId, ch, cfg) {
    const b = this.baselines[`${eqId}:${ch}`];
    const means = b && Array.isArray(b.means) ? b.means : [];
    if (means.length < cfg.baseline_min_minutes) return { lph: null, minutes: means.length };
    return { lph: median(means), minutes: means.length };
  }

  _loadBaselines() {
    try {
      const row = this.db.prepare('SELECT value FROM system_settings WHERE key = ?').get(BASELINE_KEY);
      const parsed = row && row.value ? JSON.parse(row.value) : {};
      const clean = {};
      for (const [k, v] of Object.entries(parsed || {})) {
        if (/^\d+:\d+$/.test(k) && v && Array.isArray(v.means)) {
          clean[k] = { means: v.means.filter(x => typeof x === 'number' && Number.isFinite(x) && x > 0), updated_at: v.updated_at || null };
        }
      }
      this.baselines = clean;
    } catch (e) {
      this.log.error(`[FlowWatch] could not load baselines: ${e.message}`);
      this.baselines = {};
    }
  }

  _saveBaselines() {
    try {
      this.db.prepare(
        "INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      ).run(BASELINE_KEY, JSON.stringify(this.baselines));
    } catch (e) {
      this.log.error(`[FlowWatch] could not save baselines: ${e.message}`);
    }
  }

  _closeBucket(cfg) {
    const b = this._bucket;
    this._bucket = null;
    if (!b || b.n < MIN_SAMPLES_PER_BASELINE_MINUTE) return;
    const rec = this.baselines[b.zoneKey] || { means: [] };
    rec.means = [...rec.means, Math.round(b.sum / b.n)].slice(-cfg.baseline_minutes);
    rec.updated_at = iso(this.now());
    this.baselines[b.zoneKey] = rec;
    this._saveBaselines();
  }

  /**
   * Learn the steady single-zone flow: exactly one zone + pump ON, meter healthy,
   * >= settle + 10 s after the zone opened, within 70-130 % of the configured
   * flow, no zone rule pending for it, and not above the current threshold (so a
   * second valve left open does not become the new normal).
   */
  _learn(cfg, nowMs, relays, meter, current, onZones) {
    const eligible = relays.known && relays.pump.on && current && onZones.length === 1 && meter.known
      && nowMs >= Math.max(current.openedAt, relays.pump.openedAt || 0) + cfg.settle_seconds * 1000 + STEADY_AFTER_SETTLE_MS
      && current.configuredLph
      && meter.flow >= current.configuredLph * 0.7 && meter.flow <= current.configuredLph * 1.3
      && !ZONE_RULES.some(r => this.instances.has(this._zoneKey(r, cfg, current.channel)))
      && meter.flow <= this._aboveThreshold(cfg, current).threshold;
    const zoneKey = current ? `${cfg.irrigation_equipment_id}:${current.channel}` : null;
    const minute = Math.floor(nowMs / 60000);
    // A minute bucket closes when the minute or the zone changes; ineligible
    // samples (a noisy spike, a pending rule) are skipped, not bucket-closing.
    if (this._bucket && (this._bucket.zoneKey !== zoneKey || this._bucket.minute !== minute)) this._closeBucket(cfg);
    if (!eligible) return;
    if (!this._bucket) this._bucket = { zoneKey, minute, sum: 0, n: 0 };
    this._bucket.sum += meter.flow;
    this._bucket.n += 1;
  }

  _aboveThreshold(cfg, zone) {
    if (zone.baselineLph) return { base: zone.baselineLph, pct: cfg.above_expected_pct, basis: `learned from ${zone.baselineMinutes} steady minute(s)`, threshold: zone.baselineLph * (1 + cfg.above_expected_pct / 100) };
    if (zone.configuredLph) return { base: zone.configuredLph, pct: cfg.above_expected_fallback_pct, basis: 'configured flow (no baseline learned yet)', threshold: zone.configuredLph * (1 + cfg.above_expected_fallback_pct / 100) };
    return { base: null, pct: null, basis: 'none', threshold: Infinity };
  }

  // ─── evaluation ───────────────────────────────────────────────────────────

  _zoneKey(rule, cfg, ch) { return `${rule}:${cfg.irrigation_equipment_id}:${ch}`; }

  /**
   * Advance one rule instance. verdict: true (condition holds), false (it does
   * not — falseReason says why), null (unknown: freeze, neither advance nor clear).
   */
  _step(key, rule, nowMs, verdict, opts) {
    let inst = this.instances.get(key);
    if (verdict === null) return inst || null;
    if (!inst) {
      if (!verdict) return null;
      inst = {
        key, rule, start: nowMs, lastTrue: nowMs, falseSince: null, falseReason: null,
        fired: false, firedAt: null, episodeId: null, alertId: null,
        minFlow: null, maxFlow: null, ctx: {},
      };
      this.instances.set(key, inst);
    }
    if (opts.ctx) Object.assign(inst.ctx, opts.ctx);
    if (verdict) {
      inst.lastTrue = nowMs;
      inst.falseSince = null;
      inst.falseReason = null;
      if (opts.flow !== undefined && opts.flow !== null) {
        inst.minFlow = inst.minFlow === null ? opts.flow : Math.min(inst.minFlow, opts.flow);
        inst.maxFlow = inst.maxFlow === null ? opts.flow : Math.max(inst.maxFlow, opts.flow);
      }
      if (!inst.fired && nowMs - Math.max(inst.start, opts.notBefore || 0) >= opts.holdMs) {
        inst.fired = true;
        inst.firedAt = nowMs;
        this._onFire(inst, nowMs, opts);
      } else if (!inst.fired && rule === 'valve_no_flow' && !inst.episodeId && nowMs - inst.start >= this.getConfig().episode_min_seconds * 1000) {
        this._openEpisode(inst, nowMs);
      }
      return inst;
    }
    if (inst.falseSince === null) { inst.falseSince = nowMs; inst.falseReason = opts.falseReason || 'recovered'; inst.ctx.endFlow = opts.flow; }
    const waited = nowMs - inst.falseSince;
    if (inst.fired ? waited >= opts.clearMs : waited >= opts.gapMs) {
      this.instances.delete(key);
      this._onEnd(inst, nowMs);
      return null;
    }
    return inst;
  }

  evaluate(nowMs = this.now(), { learn = false, force = false } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) {
      this.lastEvaluation = { at: nowMs, enabled: false };
      return this.lastEvaluation;
    }
    if (!learn && !force && this.lastEvaluation && this.lastEvaluation.relays
        && nowMs - this._lastEvalMs < EVAL_MIN_GAP_MS && nowMs >= this._lastEvalMs) return this.lastEvaluation;
    this._lastEvalMs = nowMs;

    const st = this._staticInfo(cfg, nowMs);
    const relays = this._relays(cfg, nowMs);
    const meter = this._meter(cfg, nowMs);
    const dosing = this._dosingState(cfg, nowMs, relays, st);
    const flow = meter.flow;
    const gap = cfg.gap_seconds * 1000;
    const clear = cfg.clear_seconds * 1000;

    // ── zone rules ──
    const onZones = relays.known ? relays.zones.filter(z => z.on) : [];
    const current = onZones.length ? [...onZones].sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0))[0] : null;
    const gating = relays.known && relays.pump.on && !!current;
    const settleEnd = gating ? Math.max(current.openedAt || 0, relays.pump.openedAt || 0) + cfg.settle_seconds * 1000 : 0;
    const zoneCtx = current ? {
      zone: { channel: current.channel, name: current.name }, eqName: st.eqName, eqId: cfg.irrigation_equipment_id,
      expected: current.expectedLph, openedAt: current.openedAt,
    } : {};

    for (const rule of ZONE_RULES) {
      const curKey = current ? this._zoneKey(rule, cfg, current.channel) : null;
      const common = { notBefore: settleEnd, flow, ctx: zoneCtx };
      // instances for zones that are no longer the current one have ended
      for (const [key, inst] of [...this.instances]) {
        if (inst.rule !== rule || key === curKey) continue;
        this._step(key, rule, nowMs, relays.known ? false : null, { falseReason: 'ended', clearMs: clear, gapMs: gap, flow });
      }
      if (!curKey) continue;
      if (!relays.known) { this._step(curKey, rule, nowMs, null, {}); continue; }
      if (!gating || !current.expectedLph) {
        this._step(curKey, rule, nowMs, false, { falseReason: 'ended', clearMs: clear, gapMs: gap, flow });
        continue;
      }
      const exp = current.expectedLph;
      const noThr = exp * cfg.no_flow_pct / 100;
      const lowThr = exp * cfg.low_flow_pct / 100;
      if (rule === 'valve_no_flow') {
        this._step(curKey, rule, nowMs, meter.known ? flow < noThr : null,
          { ...common, holdMs: cfg.no_flow_seconds * 1000, gapMs: gap, clearMs: clear, falseReason: 'recovered' });
      } else if (rule === 'low_flow') {
        this._step(curKey, rule, nowMs, meter.known ? flow >= noThr && flow < lowThr : null,
          { ...common, holdMs: cfg.low_flow_seconds * 1000, gapMs: gap, clearMs: Math.max(clear, 10000), falseReason: meter.known && flow < noThr ? 'escalated' : 'recovered' });
      } else if (rule === 'flow_above_expected') {
        let verdict = null;
        let reason = 'recovered';
        const thr = this._aboveThreshold(cfg, current);
        const rm = this._rollingMean(cfg, nowMs, settleEnd);
        if (onZones.length !== 1) { verdict = false; reason = 'ended'; }
        else if (meter.known && rm.n >= 5) verdict = rm.mean > thr.threshold;
        this._step(curKey, rule, nowMs, verdict, {
          ...common, flow: rm.mean, holdMs: cfg.above_expected_seconds * 1000, gapMs: 10000, clearMs: 10000, falseReason: reason,
          ctx: { ...zoneCtx, above: { ...thr, mean: rm.mean } },
        });
      }
    }

    // ── dosing without water ──
    {
      const key = `dosing_without_water:${cfg.dosing_equipment_id}`;
      let verdict = null;
      let reason = 'recovered';
      if (meter.known && dosing.fresh) {
        verdict = dosing.open && dosing.active.length > 0 && flow < cfg.dosing_max_flow_lph;
        if (!verdict) reason = flow >= cfg.dosing_max_flow_lph ? 'recovered' : 'dosing_stopped';
      }
      const inst = this.instances.get(key);
      const ctx = { dosing: { active: dosing.active, tanks: dosing.tanks, cycle: dosing.cycle, open: dosing.open } };
      if (verdict && !inst) ctx.consumedStart = Object.fromEntries(dosing.tanks.map(t => [t.id, t.consumed_l]));
      ctx.consumedNow = Object.fromEntries(dosing.tanks.map(t => [t.id, t.consumed_l]));
      this._step(key, 'dosing_without_water', nowMs, verdict, {
        holdMs: cfg.dosing_seconds * 1000, gapMs: gap, clearMs: clear, falseReason: reason, flow, ctx,
      });
    }

    // ── water without a zone valve ──
    {
      const key = `water_without_valve:${cfg.irrigation_equipment_id}`;
      let verdict = null;
      let reason = 'recovered';
      if (relays.known && meter.known) {
        verdict = onZones.length === 0 && flow > cfg.water_without_valve_lph;
        if (!verdict && onZones.length > 0) reason = 'ended';
      }
      this._step(key, 'water_without_valve', nowMs, verdict, {
        holdMs: cfg.water_without_valve_seconds * 1000, gapMs: gap, clearMs: 10000, falseReason: reason, flow,
        ctx: { eqName: st.eqName, eqId: cfg.irrigation_equipment_id },
      });
    }

    // ── flow with the pump OFF ──
    {
      const key = `flow_after_pump_off:${cfg.irrigation_equipment_id}:${cfg.pump_channel}`;
      let verdict = null;
      let reason = 'recovered';
      if (relays.known && meter.known) {
        verdict = !relays.pump.on && flow > cfg.flow_after_pump_off_lph;
        if (!verdict && relays.pump.on) reason = 'ended';
      }
      this._step(key, 'flow_after_pump_off', nowMs, verdict, {
        holdMs: cfg.flow_after_pump_off_seconds * 1000, gapMs: gap, clearMs: 10000, falseReason: reason, flow,
        ctx: { eqName: st.eqName, eqId: cfg.irrigation_equipment_id, pumpChannel: cfg.pump_channel },
      });
    }

    // ── monitor blind ──
    {
      const key = 'monitor_blind:irrigation_monitor';
      let verdict = null;
      let reason = 'recovered';
      let why = null;
      if (relays.known) {
        const stale = meter.staleForMs >= cfg.blind_stale_seconds * 1000;
        const unhealthy = meter.fresh && !meter.healthy && meter.unhealthyForMs >= cfg.blind_unhealthy_seconds * 1000;
        verdict = relays.pump.on && (stale || unhealthy);
        if (!relays.pump.on) reason = 'ended';
        if (stale) why = { kind: 'stale', forMs: meter.staleForMs };
        else if (unhealthy) why = { kind: 'unhealthy', forMs: meter.unhealthyForMs, signal: meter.signal, errorFlags: meter.errorFlags };
      }
      this._step(key, 'monitor_blind', nowMs, verdict, {
        holdMs: 0, gapMs: 0, clearMs: 10000, falseReason: reason, flow,
        ctx: why ? { why, monitorEquipmentId: this.flow ? this.flow.equipmentId : null } : {},
      });
    }

    if (learn) this._learn(cfg, nowMs, relays, meter, current, onZones);

    this.lastEvaluation = { at: nowMs, enabled: true, relays, meter, dosing, current, onZones, settleEnd, cfg };
    return this.lastEvaluation;
  }

  // ─── alerts + episodes ────────────────────────────────────────────────────

  _fingerprint(inst) { return `flow_watch:${inst.key}`; }

  _zoneLabel(ctx) {
    return ctx.zone ? `${ctx.zone.name} (${ctx.eqName} relay ${ctx.zone.channel})` : 'Irrigation';
  }

  _litresDosed(ctx) {
    const s = ctx.consumedStart || {};
    const n = ctx.consumedNow || {};
    let total = 0; let any = false;
    for (const [id, v0] of Object.entries(s)) {
      const v1 = n[id];
      if (typeof v0 === 'number' && typeof v1 === 'number' && v1 >= v0) { total += v1 - v0; any = true; }
    }
    return any ? total : null;
  }

  _fireMessage(inst, nowMs) {
    const cfg = this.getConfig();
    const c = inst.ctx;
    const dur = fmtDur(nowMs - inst.start);
    const flow = this.flow ? this.flow.values.flow_lph : null;
    switch (inst.rule) {
      case 'valve_no_flow':
        return `${this._zoneLabel(c)} is ON with the irrigation pump running, but no water is flowing: ${fmtLph(flow)} L/h for ${dur}, expected ~${fmtLph(c.expected)} L/h. Valve not opening? Check the zone valve (then the pump).`;
      case 'low_flow':
        return `${this._zoneLabel(c)}: low flow — ${fmtLph(flow)} L/h is ${Math.round((flow / c.expected) * 100)} % of the expected ~${fmtLph(c.expected)} L/h for ${dur}. Valve partly open, blocked filter or pump problem?`;
      case 'flow_above_expected': {
        const a = c.above || {};
        const pct = a.base ? Math.round(((a.mean - a.base) / a.base) * 1000) / 10 : null;
        return `${this._zoneLabel(c)}: more water than one zone should take — ${fmtLph(a.mean)} L/h (${cfg.above_expected_window_seconds} s average) vs ~${fmtLph(a.base)} L/h for this zone (+${pct} %, limit +${a.pct} %, ${a.basis}) for ${dur}. Another valve may be open (manual override or bleed left open?).`;
      }
      case 'dosing_without_water': {
        const tanks = (c.dosing.active || []).map(t => `${shortTankName(t.name, t.id)} ${fmtLph(t.rate_lph)} L/h`).join(', ');
        return `Fertiliser is dosing into a line with no water flow: ${tanks} (water ${fmtLph(flow)} L/h, below ${fmtLph(cfg.dosing_max_flow_lph)} L/h for ${dur}).`;
      }
      case 'water_without_valve':
        return `Water is flowing (${fmtLph(flow)} L/h for ${dur}) but no irrigation zone relay on ${c.eqName} is ON — stuck-open valve, leak or a manual valve?`;
      case 'flow_after_pump_off':
        return `Water is flowing (${fmtLph(flow)} L/h for ${dur}) while the irrigation pump relay (${c.eqName} relay ${c.pumpChannel}) is OFF — pump run by hand at the panel, or siphoning?`;
      case 'monitor_blind': {
        const w = c.why || {};
        const why = w.kind === 'unhealthy'
          ? `the flow meter is unhealthy (signal ${w.signal ?? '?'}, error flags ${w.errorFlags ?? '?'}) for ${fmtDur(w.forMs)}`
          : `no data from the flow meter for ${fmtDur(w.forMs || 0)}`;
        return `The irrigation pump is ON but water flow cannot be verified: ${why}. Zone, low-flow and dosing checks are paused until it reports again.`;
      }
      default:
        return `${inst.rule}`;
    }
  }

  _endMessage(inst, nowMs) {
    const c = inst.ctx;
    const endAt = inst.falseSince || nowMs;
    const dur = fmtDur(endAt - inst.start);
    const endFlow = c.endFlow;
    const recovered = inst.falseReason === 'recovered';
    let severity = recovered ? 'info' : RULES[inst.rule].severity;
    let message;
    switch (inst.rule) {
      case 'valve_no_flow':
        message = recovered
          ? `Resolved: ${this._zoneLabel(c)} — water flow recovered after ${dur} with no flow (now ${fmtLph(endFlow)} L/h, expected ~${fmtLph(c.expected)} L/h). The valve opened late.`
          : `${this._zoneLabel(c)} ran ${dur} with no water flowing (lowest ${fmtLph(inst.minFlow)} L/h, expected ~${fmtLph(c.expected)} L/h) until the zone/pump switched off at ${fmtClock(endAt)}. Check the zone valve before the next run.`;
        break;
      case 'low_flow':
        if (recovered) message = `Resolved: ${this._zoneLabel(c)} — flow back to ${fmtLph(endFlow)} L/h after ${dur} of low flow.`;
        else if (inst.falseReason === 'escalated') { message = `${this._zoneLabel(c)}: low flow turned into no flow after ${dur} — see the no-flow alarm.`; severity = 'warning'; }
        else message = `${this._zoneLabel(c)} ran ${dur} at low flow (lowest ${fmtLph(inst.minFlow)} L/h, expected ~${fmtLph(c.expected)} L/h) until it switched off at ${fmtClock(endAt)}.`;
        break;
      case 'flow_above_expected':
        message = recovered
          ? `Resolved: ${this._zoneLabel(c)} — flow back within +${(c.above || {}).pct} % of the zone baseline after ${dur}.`
          : `${this._zoneLabel(c)} took more water than one zone for ${dur} (highest ${fmtLph(inst.maxFlow)} L/h, ${cfgPct(c)}) until the zone changed at ${fmtClock(endAt)}. Check for another valve left open.`;
        break;
      case 'dosing_without_water': {
        const litres = this._litresDosed(c);
        const lit = litres === null ? '' : ` About ${litres.toFixed(2)} L of concentrate went in with no water flow.`;
        const tanks = ((c.firedTanks || (c.dosing && c.dosing.active)) || []).map(t => `${shortTankName(t.name, t.id)} ${fmtLph(t.rate_lph)} L/h`).join(', ');
        const outcome = c.abort ? c.abort.outcome : null;
        const how = outcome === 'aborted' ? `dosing stopped automatically${c.abort.text ? ` —${c.abort.text.replace(/^ Dosing stopped automatically:/, '')}` : ' (the flow watch aborted the dose cycle)'}`
          : outcome === 'pending' ? 'automatic dosing stop in progress'
          : outcome === 'failed' ? 'the automatic dosing stop FAILED'
          : 'dosing stopped';
        if (recovered) message = `Resolved: dosing without water (${tanks}) ended after ${dur}: water flow recovered (${fmtLph(endFlow)} L/h).${outcome === 'aborted' ? ' Dosing had been stopped automatically (dose cycle aborted).' : ''}${lit}`;
        else {
          message = `Dosing without water (${tanks}) lasted ${dur}; ${how.replace(/\.$/, '')}.${lit} Find out why there was no water flow before the next run.`;
          // an automatic stop (or a failed one) stays an alarm; a cycle that simply ended is a caution
          severity = outcome === 'aborted' || outcome === 'failed' || outcome === 'pending' ? 'critical' : 'warning';
        }
        break;
      }
      case 'water_without_valve':
        message = recovered
          ? `Resolved: water flow with no zone open stopped after ${dur}.`
          : `Water flowed with no zone open for ${dur} until a zone opened at ${fmtClock(endAt)} (highest ${fmtLph(inst.maxFlow)} L/h).`;
        if (!recovered) severity = 'info';
        break;
      case 'flow_after_pump_off':
        message = recovered
          ? `Resolved: water flow with the pump relay OFF stopped after ${dur}.`
          : `Water flowed with the pump relay OFF for ${dur} until the pump was switched on at ${fmtClock(endAt)} (highest ${fmtLph(inst.maxFlow)} L/h).`;
        if (!recovered) severity = 'info';
        break;
      case 'monitor_blind':
        message = recovered
          ? `Resolved: flow meter data is back (was unverifiable for ${dur}).`
          : `Flow could not be verified for ${dur} of pumping; the pump is now OFF. Check the irrigation monitor.`;
        if (!recovered) severity = 'warning';
        break;
      default:
        message = `${inst.rule} ended after ${dur}`;
    }
    return { message, severity };

    function cfgPct(ctx) {
      const a = ctx.above || {};
      return a.base ? `baseline ~${fmtLph(a.base)} L/h` : 'no baseline';
    }
  }

  _alertEquipmentId(inst) {
    const cfg = this.getConfig();
    if (inst.rule === 'dosing_without_water') return cfg.dosing_equipment_id;
    if (inst.rule === 'monitor_blind') return inst.ctx.monitorEquipmentId || null;
    return cfg.irrigation_equipment_id;
  }

  _onFire(inst, nowMs) {
    const cfg = this.getConfig();
    const def = RULES[inst.rule];
    let message = this._fireMessage(inst, nowMs);
    let abortPlanned = false;
    if (inst.rule === 'dosing_without_water') {
      const d = inst.ctx.dosing;
      inst.ctx.firedTanks = d.active;
      if (!cfg.abort_dosing_on_no_water) {
        message += ' Automatic dosing stop is OFF (abort_dosing_on_no_water = false) — stop dosing manually.';
        inst.ctx.abort = { outcome: 'disabled' };
      } else if (d.cycle && !d.cycle.dryRun && this.doseScheduler) {
        message += ` Stopping dosing automatically (aborting dose cycle${d.cycle.cycleLogId ? ` #${d.cycle.cycleLogId}` : ''})…`;
        abortPlanned = true;
        inst.ctx.abort = { outcome: 'pending' };
      } else {
        message += ' The injector valves are open but no dose cycle is running under the scheduler, so the flow watch cannot stop them — close them manually.';
        inst.ctx.abort = { outcome: 'not_running' };
      }
    }
    inst.message = message;
    const row = this._createAlert({
      severity: def.severity,
      source: 'flow_watch',
      equipment_id: this._alertEquipmentId(inst),
      fingerprint: this._fingerprint(inst),
      message,
      metadata: { rule: inst.rule, key: inst.key },
    });
    inst.alertId = row && row.id ? row.id : null;
    this.log.warn(`[FlowWatch] ${def.level.toUpperCase()} ${inst.key}: ${message}`);
    this._openEpisode(inst, nowMs);
    if (abortPlanned) this._track(this._abortDosing(inst));
    else if (def.severity === 'critical') this._sendNotify(def.title, message, def.severity);
  }

  /** Abort the running dose cycle via the scheduler's existing abort path, then report the outcome. */
  async _abortDosing(inst) {
    const def = RULES[inst.rule];
    const cycle = inst.ctx.dosing.cycle || {};
    const tanks = (cycle.schedule && cycle.schedule.tanks) || [];
    let outcome;
    let text;
    try {
      const before = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM relay_events').get().id;
      const aborted = await this.doseScheduler.abortCycle('flow_watch: dosing without water flow', { source: 'flow_watch' });
      if (!aborted) {
        outcome = 'not_running';
        text = ' The dose cycle had already ended.';
      } else {
        const closed = new Set(this.db.prepare(
          "SELECT equipment_id, channel FROM relay_events WHERE id > ? AND source = 'flow_watch' AND state = 0"
        ).all(before).map(r => `${r.equipment_id}:${r.channel}`));
        const missing = tanks.filter(t => !closed.has(`${t.equipment_id}:${t.channel}`));
        const names = tanks.map(t => shortTankName(t.tank_name, t.tank_id)).join(', ');
        outcome = 'aborted';
        text = missing.length === 0
          ? ` Dosing stopped automatically: dose cycle${cycle.cycleLogId ? ` #${cycle.cycleLogId}` : ''} aborted by the flow watch, injector valves closed (${names || 'none open'}). Pumps and zone valves were not touched.`
          : ` Dosing stopped automatically: dose cycle${cycle.cycleLogId ? ` #${cycle.cycleLogId}` : ''} aborted, but closing ${missing.map(t => shortTankName(t.tank_name, t.tank_id)).join(', ')} was NOT confirmed — check the injector valves now.`;
      }
    } catch (e) {
      outcome = 'failed';
      text = ` Automatic dosing stop FAILED (${e.message}) — stop the dose cycle and close the injector valves now.`;
    }
    inst.ctx.abort = { outcome, text };
    const base = inst.message.replace(/ Stopping dosing automatically.*$/, '');
    inst.message = base + text;
    if (inst.ended) {
      // The condition already ended while the abort was in flight: the alert
      // carries the end summary, rebuilt now that the outcome is known.
      this._updateOpenAlert(this._fingerprint(inst), this._endMessage(inst, inst.endedAt));
    } else {
      this._updateOpenAlert(this._fingerprint(inst), { message: inst.message, severity: def.severity });
    }
    if (inst.episodeId) {
      try {
        this.db.prepare("UPDATE irrigation_flow_episodes SET dosing_aborted = ?, updated_at = ? WHERE id = ?")
          .run(outcome === 'aborted' ? 1 : 0, iso(this.now()), inst.episodeId);
      } catch (_) { /* best-effort */ }
    }
    this.log.warn(`[FlowWatch] dosing abort outcome: ${outcome}`);
    this._sendNotify(def.title, inst.message, def.severity);
  }

  _onEnd(inst, nowMs) {
    const cfg = this.getConfig();
    const def = RULES[inst.rule];
    const endAt = inst.falseSince || nowMs;
    inst.ended = true;
    inst.endedAt = nowMs;
    if (inst.fired) {
      const { message, severity } = this._endMessage(inst, nowMs);
      this._updateOpenAlert(this._fingerprint(inst), { message, severity });
      this.log.log(`[FlowWatch] ended ${inst.key} (${inst.falseReason}): ${message}`);
      if (def.severity === 'critical') this._sendNotify(`${def.title} — ${inst.falseReason === 'recovered' ? 'resolved' : 'ended'}`, message, severity);
    } else if (inst.rule === 'valve_no_flow' && endAt - inst.start >= cfg.episode_min_seconds * 1000 && !inst.episodeId) {
      this._openEpisode(inst, inst.start);
    }
    this._closeEpisode(inst, endAt);
  }

  _openEpisode(inst, nowMs) {
    if (inst.episodeId) {
      if (inst.fired) {
        try {
          this.db.prepare('UPDATE irrigation_flow_episodes SET alarmed = 1, severity = ?, alert_id = ?, updated_at = ? WHERE id = ?')
            .run(RULES[inst.rule].severity, inst.alertId, iso(nowMs), inst.episodeId);
        } catch (_) { /* best-effort */ }
      }
      return;
    }
    const c = inst.ctx;
    try {
      const info = this.db.prepare(`
        INSERT INTO irrigation_flow_episodes
          (kind, equipment_id, channel, zone_name, started_at, expected_lph, min_flow_lph, max_flow_lph, alarmed, severity, alert_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        inst.rule, this._alertEquipmentId(inst), c.zone ? c.zone.channel : (inst.rule === 'flow_after_pump_off' ? c.pumpChannel : null),
        c.zone ? c.zone.name : null, iso(inst.start), round(c.expected), round(inst.minFlow), round(inst.maxFlow),
        inst.fired ? 1 : 0, inst.fired ? RULES[inst.rule].severity : null, inst.alertId, iso(nowMs), iso(nowMs),
      );
      inst.episodeId = Number(info.lastInsertRowid);
    } catch (e) {
      this.log.error(`[FlowWatch] could not record episode: ${e.message}`);
    }
  }

  _closeEpisode(inst, endAt) {
    if (!inst.episodeId) return;
    const detail = {
      end_flow_lph: round(inst.ctx.endFlow),
      fired_at: iso(inst.firedAt),
      message: inst.message || null,
    };
    if (inst.rule === 'dosing_without_water') {
      detail.litres_dosed = this._litresDosed(inst.ctx);
      detail.abort = inst.ctx.abort ? inst.ctx.abort.outcome : null;
      detail.tanks = (inst.ctx.dosing && inst.ctx.dosing.active || []).map(t => ({ id: t.id, name: t.name, rate_lph: t.rate_lph }));
    }
    if (inst.rule === 'flow_above_expected' && inst.ctx.above) {
      detail.baseline_lph = round(inst.ctx.above.base);
      detail.baseline_basis = inst.ctx.above.basis;
    }
    const recovered = inst.falseReason === 'recovered' ? 1 : 0;
    try {
      this.db.prepare(`
        UPDATE irrigation_flow_episodes
        SET ended_at = ?, duration_s = ?, min_flow_lph = ?, max_flow_lph = ?, recovered = ?, end_reason = ?,
            alarmed = ?, severity = COALESCE(severity, ?), alert_id = COALESCE(alert_id, ?), detail_json = ?, updated_at = ?
        WHERE id = ?
      `).run(
        iso(endAt), Math.round((endAt - inst.start) / 100) / 10, round(inst.minFlow), round(inst.maxFlow), recovered,
        inst.falseReason || 'ended', inst.fired ? 1 : 0, inst.fired ? RULES[inst.rule].severity : null, inst.alertId,
        JSON.stringify(detail), iso(endAt), inst.episodeId,
      );
    } catch (e) {
      this.log.error(`[FlowWatch] could not close episode: ${e.message}`);
    }
  }

  _closeInterruptedEpisodes() {
    try {
      this.db.prepare(`
        UPDATE irrigation_flow_episodes SET ended_at = ?, end_reason = 'interrupted', updated_at = ?
        WHERE ended_at IS NULL
      `).run(iso(this.now()), iso(this.now()));
    } catch (e) {
      this.log.error(`[FlowWatch] could not close interrupted episodes: ${e.message}`);
    }
  }

  _sendNotify(title, text, severity) {
    const cfg = this.getConfig();
    if (!cfg.telegram) return;
    let fn = this._notify;
    if (!fn) {
      fn = async (t, body, sev) => {
        const { telegramService } = require('./TelegramService');
        if (!telegramService.isConfigured()) return;
        await telegramService.sendAlert(t, body, sev);
      };
    }
    // Legacy Telegram Markdown chokes on _ * [ ` in free text.
    const clean = (s) => String(s).replace(/[_*`[\]]/g, ' ');
    this._track(Promise.resolve().then(() => fn(clean(title), clean(text), severity)));
  }

  // ─── read API ─────────────────────────────────────────────────────────────

  getStatus(nowMs = this.now()) {
    const cfg = this.getConfig();
    if (!cfg.enabled) return { enabled: false, state: 'disabled', evaluated_at: iso(nowMs), active: [], last_episode: this.lastEpisode(), config: cfg };
    const last = this.lastEvaluation;
    const ev = last && last.relays && nowMs >= last.at && nowMs - last.at < TICK_MS + 1000 ? last : this.evaluate(nowMs, { force: true });
    const { relays, meter, dosing, current, onZones, settleEnd } = ev;
    const active = [...this.instances.values()].map(i => ({
      rule: i.rule,
      level: RULES[i.rule].level,
      severity: RULES[i.rule].severity,
      key: i.key,
      fired: i.fired,
      since: iso(i.start),
      fired_at: iso(i.firedAt),
      zone: i.ctx.zone || null,
      message: i.fired ? i.message : null,
    }));
    let state;
    if (active.some(a => a.fired && a.level === 'alarm')) state = 'alarm';
    else if (active.some(a => a.fired)) state = 'caution';
    else if (active.length) state = 'checking';
    else if (!relays.known) state = 'unknown';
    else if (relays.pump.on && !meter.known) state = 'unknown';
    else if (relays.pump.on || onZones.length) state = 'ok';
    else state = 'idle';
    const ratio = current && meter.known && current.expectedLph ? Math.round((meter.flow / current.expectedLph) * 100) : null;
    const rm = current ? this._rollingMean(cfg, nowMs, settleEnd || 0) : { mean: null };
    return {
      enabled: true,
      state,
      evaluated_at: iso(nowMs),
      settling: !!current && nowMs < settleEnd,
      flow: {
        lph: meter.flow,
        rolling_lph: rm.mean === null ? null : Math.round(rm.mean),
        fresh: meter.fresh,
        healthy: meter.healthy,
        age_s: meter.ageMs === null ? null : Math.round(meter.ageMs / 1000),
        signal_quality: meter.signal,
        error_flags: meter.errorFlags,
        farm_id: this.flow ? this.flow.farmId : null,
        monitor_equipment_id: this.flow ? this.flow.equipmentId : null,
        irrigation_active: this.irrigation ? this.irrigation.active : null,
      },
      relays: {
        known: relays.known,
        reason: relays.known ? null : relays.reason,
        age_s: relays.ageMs === null || relays.ageMs === undefined ? null : Math.round(relays.ageMs / 1000),
        pump_on: relays.known ? relays.pump.on : null,
        zones: relays.known ? relays.zones.map(z => ({
          channel: z.channel, name: z.name, on: z.on, opened_at: iso(z.openedAt),
          expected_lph: round(z.expectedLph), configured_lph: round(z.configuredLph),
          baseline_lph: round(z.baselineLph), baseline_minutes: z.baselineMinutes,
        })) : [],
      },
      current_zone: current ? {
        channel: current.channel, name: current.name, opened_at: iso(current.openedAt),
        expected_lph: round(current.expectedLph), ratio_pct: ratio,
      } : null,
      dosing: {
        fresh: dosing.fresh,
        open: dosing.open,
        cycle_running: dosing.cycleRunning,
        tanks: dosing.tanks.map(t => ({ id: t.id, name: t.name, rate_lph: t.rate_lph })),
      },
      active,
      last_episode: this.lastEpisode(),
      config: cfg,
    };
  }

  formatEpisode(row) {
    if (!row) return null;
    let detail = null;
    try { detail = row.detail_json ? JSON.parse(row.detail_json) : null; } catch (_) { detail = null; }
    return {
      id: row.id, kind: row.kind, equipment_id: row.equipment_id, channel: row.channel, zone_name: row.zone_name,
      started_at: row.started_at, ended_at: row.ended_at, duration_s: row.duration_s,
      expected_lph: row.expected_lph, min_flow_lph: row.min_flow_lph, max_flow_lph: row.max_flow_lph,
      recovered: row.recovered === null ? null : !!row.recovered, end_reason: row.end_reason,
      alarmed: !!row.alarmed, severity: row.severity, alert_id: row.alert_id, dosing_aborted: !!row.dosing_aborted,
      detail,
    };
  }

  lastEpisode() {
    try {
      return this.formatEpisode(this.db.prepare('SELECT * FROM irrigation_flow_episodes ORDER BY started_at DESC, id DESC LIMIT 1').get());
    } catch (_) { return null; }
  }

  listEpisodes({ limit = 50, offset = 0, kind = null, from = null, to = null } = {}) {
    const where = [];
    const params = [];
    if (kind) { where.push('kind = ?'); params.push(kind); }
    if (from) { where.push('started_at >= ?'); params.push(from); }
    if (to) { where.push('started_at <= ?'); params.push(to); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM irrigation_flow_episodes ${w}`).get(...params).n;
    const rows = this.db.prepare(`SELECT * FROM irrigation_flow_episodes ${w} ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return { total, episodes: rows.map(r => this.formatEpisode(r)) };
  }

  getBaselines() {
    const cfg = this.getConfig();
    return cfg.zone_channels.map(ch => {
      const rec = this.baselines[`${cfg.irrigation_equipment_id}:${ch}`];
      const b = this._baselineFor(cfg.irrigation_equipment_id, ch, cfg);
      return { channel: ch, baseline_lph: round(b.lph), minutes: b.minutes, updated_at: rec ? rec.updated_at : null };
    });
  }
}

let singleton = null;
function getFlowWatchService() {
  if (!singleton) {
    const { db } = require('../utils/database');
    const { createAlert, updateOpenAlert } = require('../utils/alertBroadcast');
    const { fertigationDoseScheduler } = require('./FertigationDoseScheduler');
    const { getMqttIngestService } = require('./MqttIngestService');
    singleton = new IrrigationFlowWatchService({
      db, createAlert, updateOpenAlert, doseScheduler: fertigationDoseScheduler, mqtt: getMqttIngestService(),
    });
  }
  return singleton;
}

module.exports = {
  IrrigationFlowWatchService,
  getFlowWatchService,
  validateConfigUpdate,
  DEFAULT_CONFIG,
  RULES,
  CONFIG_KEY,
  BASELINE_KEY,
};
