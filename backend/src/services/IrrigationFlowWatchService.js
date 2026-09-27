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
 *   manual_panel         info    MANUAL IRRIGATION AT THE PANEL (requirement 2026-09-27, after
 *                                the 08:07 panel run raised flow_after_pump_off + water_without_valve
 *                                for 12 min): flow > water_without_valve_lph for manual_panel_seconds
 *                                with NO SenseHub pump relay and NO zone relay ON. ONE info alert
 *                                "Manual irrigation detected (panel) — water X L/h, started HH:MM";
 *                                water_without_valve / flow_after_pump_off are held while it lasts.
 *                                Escalation (water_without_valve is the escalation path: it fires as
 *                                a caution with the panel wording) when (a) it runs longer than
 *                                manual_panel_max_minutes (default 20), (b) the tanks dose stronger
 *                                than 1:manual_panel_max_ratio (default 1:80), or (c) the dosing
 *                                counters keep moving with flow < dosing_max_flow_lph for
 *                                dosing_seconds (dosing_without_water itself only covers valves
 *                                SenseHub opened and stays an alarm). Resolved with a summary
 *                                (duration, water, litres per tank, ratio). Read-only: no actuation.
 *   monitor_blind        caution pump ON but no fresh flowmeter data for 60 s, or the
 *                                meter unhealthy (signal < 60 / error_flags != 0) for 30 s.
 *   pump_no_flow_shutdown alarm  PUMP PROTECTION (operator request 2026-09-26, after the
 *                                15:30 and 09:40 runs dead-headed the pumps against a stuck
 *                                Zone 4 valve for ~2-3 min). Irrigation pump ON, meter healthy
 *                                + fresh, flow < max(shutdown_flow_lph, shutdown_flow_pct % of
 *                                the zone's expected flow) for shutdown_no_flow_seconds, counted
 *                                from shutdown_grace_seconds after the latest pump/zone switch
 *                                (cold_start_grace_seconds when that switch was a pump start —
 *                                the 0 -> 8,800 L/h ramp takes 6-8 s). Zone ON (stuck valve) or
 *                                no zone ON (dead-heading) alike. Meter blind -> never acts
 *                                (monitor_blind alerts instead).
 *                                Action, once per zone per run:
 *                                1. COLD-RESTART RETRY (zone ON, max_retries, not disarmed,
 *                                   >= retry_min_remaining_seconds of the zone left, planned
 *                                   auto-offs known): pause dosing (DoseController hold, targets
 *                                   kept; fixed-schedule cycles are aborted instead), pumps OFF
 *                                   (+ the zone valve if it was switched ON under pressure; a
 *                                   soft-switch valve that led the pumps stays energised), wait
 *                                   retry_pause_seconds, then pumps (+ that zone) ON again through
 *                                   the guarded ON path (guardWriteSet, arming re-checked, source
 *                                   'flow_watch_retry') for the zone's remaining planned time,
 *                                   dosing resumed. Flow back -> alert downgraded, episode
 *                                   'retry_recovered'. Still no flow -> 2.
 *                                2. RUN SHUTDOWN: cancel the run's pending delayed starts, all
 *                                   irrigation pumps + zones OFF (FC15 + read-back, one retry,
 *                                   source 'flow_watch_shutdown'), dose cycle aborted, run marked
 *                                   in automation_logs, one critical alert + Telegram per run
 *                                   and zone, episode 'run_shutdown'.
 *                                Accepted trade-off: a valve that opens ~25 s late (11:30 run)
 *                                is now retried/shut down at ~20 s instead of recovering alone.
 *
 * ACTUATION: (a) the optional dose-cycle abort (scheduler's abort path); (b) the
 * run shutdown: OFF writes only, never blocked by disarm (OFF is the fail-safe
 * direction), RelayEventLogger source 'flow_watch_shutdown'; (c) the cold-restart
 * retry, which DOES energise the irrigation pumps and one zone valve: only through
 * RelayInterlockService.guardWriteSet + read-back, refused while disarmed (then the
 * run is shut down instead), logged 'flow_watch_retry', bounded by the run's planned
 * auto-offs (and RelaySafetyWatchdogService max-on as a backstop); (d) the
 * operator's "Stop irrigation" (stopIrrigation(), POST /api/irrigation/stop,
 * 2026-09-27): the same OFF path for the irrigation board AND the dosing valves,
 * source 'stop_irrigation' + the operator's email, never touching another board.
 *
 * ALERTS: createAlert() with a stable fingerprint `flow_watch:<rule>:<eq>[:<ch>]`,
 * once per episode. When the condition ends the same open alert is rewritten via
 * updateOpenAlert() ("Resolved: ... recovered after 25 s" → info; ended without
 * recovering keeps its severity). Episodes go to irrigation_flow_episodes.
 */

const { getSystemTimezone } = require('../utils/systemTimezone'); // pure (no DB handle of its own)
const i18n = require('../i18n'); // pure (catalog + renderer)

// ─── i18n: every operator-facing text is an i18n spec ({ $k, $p }, see src/i18n) ───
// Alerts store the English render in alerts.message plus message_key / message_params;
// the API / Telegram render the same spec in tr / ar. English output is identical to
// the pre-i18n texts. Episode detail / automation_logs keep the English render.
const { M } = i18n;
const en = (spec) => i18n.render('en', spec);
/** createAlert / updateOpenAlert arguments of a spec. */
const keyArgs = (spec) => ({ messageKey: spec.$k, messageParams: spec.$p || {} });
/** Same spec with its trailing {extra} fragment set (follow-ups: abort outcome, escalation, retry end). */
const withExtra = (spec, extra) => ({ $k: spec.$k, $p: { ...(spec.$p || {}), extra } });
/** "a; b; c" in the target language. */
const semi = (items) => items.slice(1).reduce((acc, x) => M('flow_watch.semi', { a: acc, b: x }), items[0]);
const cycleRef = (id) => (id ? ` #${id}` : '');
const TITLES = {
  valve_no_flow: M('flow_watch.title.valve_no_flow'),
  low_flow: M('flow_watch.title.low_flow'),
  flow_above_expected: M('flow_watch.title.flow_above_expected'),
  dosing_without_water: M('flow_watch.title.dosing_without_water'),
  water_without_valve: M('flow_watch.title.water_without_valve'),
  flow_after_pump_off: M('flow_watch.title.flow_after_pump_off'),
  monitor_blind: M('flow_watch.title.monitor_blind'),
  manual_panel: M('flow_watch.title.manual_panel'),
  pump_no_flow_shutdown: M('flow_watch.title.pump_no_flow_shutdown'),
};

const RULES = {
  valve_no_flow: { severity: 'critical', level: 'alarm', title: 'Irrigation: no water flow' },
  low_flow: { severity: 'warning', level: 'caution', title: 'Irrigation: low flow' },
  flow_above_expected: { severity: 'warning', level: 'caution', title: 'Irrigation: more flow than one zone' },
  dosing_without_water: { severity: 'critical', level: 'alarm', title: 'Fertigation: dosing without water' },
  water_without_valve: { severity: 'warning', level: 'caution', title: 'Irrigation: flow with no zone open' },
  flow_after_pump_off: { severity: 'warning', level: 'caution', title: 'Irrigation: flow with pump OFF' },
  monitor_blind: { severity: 'warning', level: 'caution', title: 'Irrigation: flow not verifiable' },
  manual_panel: { severity: 'info', level: 'info', title: 'Manual irrigation detected (panel)' },
  pump_no_flow_shutdown: { severity: 'critical', level: 'alarm', title: 'Irrigation stopped: no water flow' },
};
// Guard phases of the pump no-flow protection while it is acting on a run.
const GUARD_BUSY = new Set(['retry_stopping', 'retry_pause', 'retry_restarting', 'shutting_down']);
const GUARD_RETRY = new Set(['retry_stopping', 'retry_pause', 'retry_restarting', 'retry_watch']);
// Operator actions on the irrigation board that end a pending retry (never restart after these).
const OPERATOR_SOURCES = new Set(['manual', 'manual_all', 'all_channels', 'stop_all', 'stop_irrigation']);
const OFF_WRITE_OPTIONS = Object.freeze({ priority: 'high', timeout: 1500, retries: 2, retryDelayMs: 200 });
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
  dosing_channels: [1, 2, 3, 4, 5], // Stop irrigation switches these OFF: pH Down + Tanks A-D (relay 6 unused)
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
  // manual irrigation at the panel (no SenseHub pump / zone relay ON)
  manual_panel_enabled: true,
  manual_panel_seconds: 20,       // flow this long with no SenseHub relay -> one info alert
  manual_panel_max_minutes: 20,   // longer -> caution (water_without_valve, panel wording)
  manual_panel_max_ratio: 80,     // dosing stronger than 1:80 -> caution
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
  // pump no-flow protection (pump_no_flow_shutdown + cold-restart retry)
  mixing_pump_channel: 2,
  shutdown_enabled: true,
  shutdown_no_flow_seconds: 15,   // operator: "after 15 or 30 seconds with 0 flow"
  shutdown_flow_lph: 500,         // no flow = below this ...
  shutdown_flow_pct: 10,          // ... or below this % of the zone's expected flow (the larger)
  shutdown_grace_seconds: 5,      // after any zone / pump switch (switch-over dips are < 5 s)
  cold_start_grace_seconds: 10,   // after a pump start (ramp 0 -> 8,800 L/h in 6-8 s)
  max_retries: 1,                 // cold-restart retries per zone per run; 0 = shut down at once
  retry_pause_seconds: 10,        // pumps OFF this long before the cold restart
  retry_min_remaining_seconds: 20, // no retry when less of the zone would be left
  recovered_pct: 50,              // retry succeeded once flow >= this % of expected
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
  dosing_channels: { type: 'channels' },
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
  manual_panel_enabled: { type: 'bool' },
  manual_panel_seconds: NUM(5, 600),
  manual_panel_max_minutes: NUM(1, 600),
  manual_panel_max_ratio: NUM(10, 1000),
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
  mixing_pump_channel: INT(1, 64),
  shutdown_enabled: { type: 'bool' },
  shutdown_no_flow_seconds: NUM(10, 60),
  shutdown_flow_lph: NUM(50, 5000),
  shutdown_flow_pct: NUM(1, 50),
  shutdown_grace_seconds: NUM(2, 30),
  cold_start_grace_seconds: NUM(5, 60),
  max_retries: INT(0, 3),
  retry_pause_seconds: NUM(5, 60),
  retry_min_remaining_seconds: NUM(10, 600),
  recovered_pct: NUM(10, 95),
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
function fmtHm(ms) { return fmtClock(ms).slice(0, 5); }
const fmtL2 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? '?' : (Math.round(x * 100) / 100).toString());
const TANK_MOVED_L = 0.5;
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

/**
 * Real I/O for the pump no-flow protection. Every coil write goes through the
 * executor's confirmed-write path (FC15 + FC01 read-back, one re-send on a
 * disagreeing read-back) and RelayStateCache/RelayEventLogger with the given
 * source. ON writes (cold-restart retry only) are refused while disarmed and go
 * through RelayInterlockService.guardWriteSet first. Loaded lazily so the module
 * stays DB/Modbus-free for tests.
 */
function defaultActuator(db, log = console) {
  const exec = () => require('./AutomationExecutor');
  const timers = () => require('./RelayTimerService').relayTimerService;
  const arming = () => require('./AutomationArmingService').automationArmingService;
  const eqRow = (id) => {
    const eq = db.prepare('SELECT * FROM equipment WHERE id = ?').get(id);
    if (!eq) throw new Error(`equipment ${id} not found`);
    const hp = exec().parseHostPort(eq.address);
    if (!hp) throw new Error(`equipment ${id} has an invalid address "${eq.address}"`);
    return { eq, target: { host: hp.host, port: hp.port, unitId: eq.slave_id || 1 } };
  };
  // Keeps the caller's order across runs (zone before pumps on a restart); adjacent channels share one FC15.
  const writeRuns = async (eqId, channels, state, { source, automationId = null, userEmail = null }) => {
    const { writeCoilsConfirmed, applyRelayCache } = exec();
    const { eq, target } = eqRow(eqId);
    const runs = [];
    for (const ch of channels) {
      const last = runs[runs.length - 1];
      if (last && ch === last.start + last.values.length) last.values.push(state);
      else runs.push({ start: ch, values: [state] });
    }
    const items = [];
    let error = null;
    for (const run of runs) {
      try {
        const rb = await writeCoilsConfirmed(eq, target, run.start, run.values, { source, automationId, userEmail }, OFF_WRITE_OPTIONS);
        for (const it of rb.items) items.push({ channel: it.channel, requested: state, readback: it.readback, confirmed: it.confirmed });
      } catch (e) {
        error = e.message;
        run.values.forEach((_, i) => items.push({ channel: run.start + i, requested: state, readback: null, confirmed: false, failed: true }));
        if (state) break; // never energise the pumps after the zone write failed
      }
    }
    const written = items.filter(i => !i.failed);
    if (written.length) applyRelayCache(eq, written, { source, automationId, userEmail });
    return { confirmed: items.length === channels.length && items.every(i => i.confirmed), items, error };
  };
  return {
    isDisarmed: () => arming().isDisarmed(),
    writeOff: (eqId, channels, opts) => writeRuns(eqId, channels, false, opts),
    writeOn: async (eqId, channels, opts) => {
      if (arming().isDisarmed()) throw new Error('automations are disarmed');
      const interlock = require('./RelayInterlockService');
      const { modbusTcpClient } = require('./ModbusTcpClient');
      const { eq } = eqRow(eqId);
      await interlock.guardWriteSet(eq, channels.map(ch => ({ channel: ch, state: true })), modbusTcpClient, { source: opts.source, automationId: opts.automationId ?? null });
      if (arming().isDisarmed()) throw new Error('automations were disarmed'); // re-check right before energising
      return writeRuns(eqId, channels, true, opts);
    },
    cancelRunTimers: (automationId, eqId) => timers().cancelTimersForAutomation(automationId, {
      filter: (e) => e.type !== 'off',
      extraKeyPrefixes: [`delay:${eqId}:`, `transition_delay:${eqId}:`],
    }),
    cancelOffTimers: (eqId, channels) => channels.map(ch => timers().cancelTimer(`off:${eqId}:${ch}`)),
    // Stop irrigation: every pending timer on these boards, whoever armed it (never another board's).
    listEquipmentTimers: (eqIds, opts) => timers().listTimersForEquipment(eqIds, opts),
    cancelEquipmentTimers: (eqIds, opts) => timers().cancelTimersForEquipment(eqIds, opts),
    getOffTimer: (eqId, ch) => timers().getOffTimer(eqId, ch),
    scheduleOff: (eqId, ch, seconds, { source, automationId = null }) => timers().scheduleOff(eqId, ch, seconds, async () => {
      const r = await writeRuns(eqId, [ch], false, { source, automationId });
      if (!r.confirmed) log.error(`[FlowWatch] ${source}: OFF of eq ${eqId} ch ${ch} not confirmed`);
    }, { automationId }),
    logAutomationRun: (automationId, status, message) => db.prepare(
      "INSERT INTO automation_logs (automation_id, status, message, triggered_at, completed_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))"
    ).run(automationId, status, message),
  };
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
   * @param {object}   [deps.actuator]       pump no-flow protection I/O (tests inject a fake):
   *   { writeOff(eqId, channels, {source, automationId}) -> {confirmed, items:[{channel, confirmed, readback}], error},
   *     writeOn(eqId, channels, {source, automationId}) -> same (guarded ON path; throws when refused),
   *     isDisarmed() -> bool, cancelRunTimers(automationId, eqId) -> [{key,type,channel,firesAt}],
   *     cancelOffTimers(eqId, channels, automationId), getOffTimer(eqId, ch) -> {firesAt: Date}|null,
   *     scheduleOff(eqId, ch, seconds, {source, automationId}), logAutomationRun(automationId, status, message),
   *     listEquipmentTimers(eqIds, {kind, channels, includeRaw}) / cancelEquipmentTimers(same) -> [{key,type,equipmentId,channel,automationId,firesAt}] }
   *   writeOff/writeOn also take {userEmail} (relay_events.user_email for operator-triggered writes).
   * @param {Function} [deps.setTimer]       (fn, ms) => handle — retry restart wake-up (tests: no-op)
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
    this._actuator = deps.actuator || null;
    this._setTimer = deps.setTimer || ((fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; });
    this.guard = null;          // pump no-flow protection state for the current run

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
      'SELECT id, state, source, automation_id, created_at FROM relay_events WHERE equipment_id = ? AND channel = ? ORDER BY id DESC LIMIT 1'
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
      const reasonSpec = M('flow_watch.relay_reason.not_found', { id: String(eqId) });
      value = { known: false, reason: en(reasonSpec), reasonSpec, ageMs: null };
    } else {
      const commMs = parseDbTs(eq.last_communication);
      const ageMs = commMs === null ? null : nowMs - commMs;
      let states = null;
      try { states = (JSON.parse(eq.last_reading || '{}') || {}).relayStates || null; } catch (_) { states = null; }
      const fresh = ageMs !== null && ageMs <= cfg.relay_fresh_seconds * 1000;
      const channels = [cfg.pump_channel, ...cfg.zone_channels];
      const haveAll = states && channels.every(ch => typeof states[ch] === 'boolean');
      if (!fresh || !haveAll) {
        const reasonSpec = !fresh ? M('flow_watch.relay_reason.stale') : M('flow_watch.relay_reason.not_reported');
        value = { known: false, reason: en(reasonSpec), reasonSpec, ageMs };
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
        {
          const ev = pump.on ? this._latestEvent(eqId, cfg.pump_channel) : null;
          pump.automationId = ev && ev.state === 1 ? ev.automation_id ?? null : null;
        }
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
        // Latest switch (either direction) of the pump, mixing pump or a zone: the
        // pump no-flow grace counts from it (a zone switch-over dip is < 5 s).
        let lastSwitchMs = null;
        try {
          const chs = [...new Set([cfg.pump_channel, cfg.mixing_pump_channel, ...cfg.zone_channels])];
          const ev = this.db.prepare(`SELECT created_at FROM relay_events WHERE equipment_id = ? AND channel IN (${chs.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`).get(eqId, ...chs);
          lastSwitchMs = ev ? parseDbTs(ev.created_at) : null;
        } catch (_) { lastSwitchMs = null; }
        for (const z of [pump, ...zones]) if (z.on && z.openedAt !== null) lastSwitchMs = Math.max(lastSwitchMs ?? -Infinity, z.openedAt);
        value = { known: true, ageMs, pump, zones, lastSwitchMs };
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
    if (zone.baselineLph) {
      const basisSpec = M('flow_watch.basis.learned', { minutes: String(zone.baselineMinutes) });
      return { base: zone.baselineLph, pct: cfg.above_expected_pct, basis: en(basisSpec), basisSpec, threshold: zone.baselineLph * (1 + cfg.above_expected_pct / 100) };
    }
    if (zone.configuredLph) {
      const basisSpec = M('flow_watch.basis.configured');
      return { base: zone.configuredLph, pct: cfg.above_expected_fallback_pct, basis: en(basisSpec), basisSpec, threshold: zone.configuredLph * (1 + cfg.above_expected_fallback_pct / 100) };
    }
    const basisSpec = M('flow_watch.basis.none');
    return { base: null, pct: null, basis: en(basisSpec), basisSpec, threshold: Infinity };
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
      if (cfg.shutdown_enabled && this.instances.has(`pump_no_flow_shutdown:${cfg.irrigation_equipment_id}`)) {
        // The pump no-flow protection is timing this same no-water period and will
        // pause (or abort) dosing itself within grace + shutdown_no_flow_seconds;
        // an abort here would only cost the cold-restart retry its dosing.
        verdict = null;
      } else if (this.guard && GUARD_RETRY.has(this.guard.phase)) {
        // Cold-restart retry in progress: dosing is paused (valves held closed) and
        // the dosing meter still shows the last rates for ~40 s — not a real event.
        verdict = false;
        reason = 'dosing_stopped';
      } else if (meter.known && dosing.fresh) {
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

    // ── manual irrigation at the panel (no SenseHub pump / zone relay ON) ──
    const panel = this._evalManualPanel(cfg, nowMs, relays, meter, st, onZones);

    // ── water without a zone valve ──
    {
      const key = `water_without_valve:${cfg.irrigation_equipment_id}`;
      let verdict = null;
      let reason = 'recovered';
      let holdMs = cfg.water_without_valve_seconds * 1000;
      const ctx = { eqName: st.eqName, eqId: cfg.irrigation_equipment_id };
      if (panel.active) {
        // panel run: held while benign; fires at once (caution, panel wording) when escalated
        verdict = relays.known && meter.known ? !!panel.escalated : null;
        reason = panel.escalated ? 'recovered' : 'manual_panel';
        holdMs = 0;
        ctx.panel = panel.inst.ctx;
      } else if (this.instances.has(key) && this.instances.get(key).ctx.panel) {
        // the panel run this escalation belonged to is over: close it (a new episode may follow)
        verdict = relays.known && meter.known ? false : null;
      } else if (relays.known && meter.known) {
        verdict = onZones.length === 0 && flow > cfg.water_without_valve_lph;
        if (!verdict && onZones.length > 0) reason = 'ended';
      }
      this._step(key, 'water_without_valve', nowMs, verdict, {
        holdMs, gapMs: gap, clearMs: 10000, falseReason: reason, flow, ctx,
      });
    }

    // ── flow with the pump OFF ──
    {
      const key = `flow_after_pump_off:${cfg.irrigation_equipment_id}:${cfg.pump_channel}`;
      let verdict = null;
      let reason = 'recovered';
      if (panel.active || panel.now) {
        verdict = relays.known && meter.known ? false : null; // the panel run owns this (one alert, not two)
        reason = 'manual_panel';
      } else if (relays.known && meter.known) {
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

    // ── pump no-flow protection (shutdown / cold-restart retry) ──
    this._evalPumpGuard(cfg, nowMs, relays, meter, st, onZones, current);

    if (learn) this._learn(cfg, nowMs, relays, meter, current, onZones);

    this.lastEvaluation = { at: nowMs, enabled: true, relays, meter, dosing, current, onZones, settleEnd, cfg };
    return this.lastEvaluation;
  }

  // ─── manual irrigation at the panel ───────────────────────────────────────

  /**
   * Track a run started at the panel: water with the SenseHub pump relay OFF and
   * no zone relay ON. Keeps water / tank litres since the start (flow-meter net
   * total or integrated flow; dosing counters) and decides escalation.
   * Returns { now, active, escalated, inst }.
   */
  _evalManualPanel(cfg, nowMs, relays, meter, st, onZones) {
    const key = `manual_panel:${cfg.irrigation_equipment_id}`;
    if (!cfg.manual_panel_enabled) {
      const stale = this.instances.get(key);
      if (stale) { this.instances.delete(key); this._onEnd(stale, nowMs); }
      return { now: false, active: false, escalated: false, inst: null };
    }
    const flow = meter.flow;
    const relaysPanel = relays.known && !relays.pump.on && onZones.length === 0;
    let inst = this.instances.get(key);
    const tanks = this.dosing && nowMs - this.dosing.receivedMs <= cfg.dosing_fresh_seconds * 1000 ? this.dosing.tanks : null;
    const consumedSum = (m) => Object.values(m || {}).reduce((a, v) => a + (typeof v === 'number' ? v : 0), 0);
    // keep the episode alive while the dosing counters still move after the water stopped (escalation c)
    const ratesOn = !!tanks && tanks.some(t => typeof t.rate_lph === 'number' && t.rate_lph > cfg.dosing_rate_lph);
    const dosingMoving = !!inst && inst.fired && ratesOn && inst.ctx.lastDoseMoveMs !== undefined && nowMs - inst.ctx.lastDoseMoveMs <= 15000;
    const now = relaysPanel && meter.known && flow > cfg.water_without_valve_lph;
    let verdict = null;
    let reason = 'recovered';
    if (relays.known && meter.known) {
      verdict = now || (relaysPanel && dosingMoving);
      if (!verdict && !relaysPanel) reason = 'ended'; // SenseHub took over (pump / zone relay ON)
    }
    inst = this._step(key, 'manual_panel', nowMs, verdict, {
      holdMs: cfg.manual_panel_seconds * 1000, gapMs: cfg.gap_seconds * 1000, clearMs: 10000, falseReason: reason, flow,
      ctx: { eqName: st.eqName, eqId: cfg.irrigation_equipment_id },
    });
    if (!inst) return { now, active: false, escalated: false, inst: null };
    const c = inst.ctx;
    if (now) c.lastWaterMs = nowMs;
    // accumulate water + dosing since the start of the episode
    const net = this.flow && typeof this.flow.values.net_total_m3 === 'number' ? this.flow.values.net_total_m3 : null;
    if (c.startMs === undefined) {
      c.startMs = inst.start;
      c.startFlow = flow;
      c.net0 = net;
      c.waterIntL = 0;
      c.lastFlowMs = nowMs;
      c.lastFlow = flow;
      c.consumedStart = tanks ? Object.fromEntries(tanks.map(t => [t.id, t.consumed_l])) : null;
      c.tankNames = st.tankNames;
    }
    if (typeof flow === 'number' && meter.fresh) {
      const dt = Math.max(0, Math.min(nowMs - c.lastFlowMs, 30000)) / 1000;
      c.waterIntL += ((c.lastFlow || 0) * dt) / 3600;
      c.lastFlow = flow;
      c.lastFlowMs = nowMs;
      c.maxFlow = Math.max(c.maxFlow || 0, flow);
    }
    const netL = net !== null && c.net0 !== null && net >= c.net0 ? (net - c.net0) * 1000 : null;
    c.waterL = netL !== null && netL > 0 ? netL : c.waterIntL;
    if (tanks) {
      if (!c.consumedStart) c.consumedStart = Object.fromEntries(tanks.map(t => [t.id, t.consumed_l]));
      const nowMap = Object.fromEntries(tanks.map(t => [t.id, t.consumed_l]));
      if (c.consumedNow && consumedSum(nowMap) > consumedSum(c.consumedNow) + 1e-9) c.lastDoseMoveMs = nowMs;
      c.consumedNow = nowMap;
    }
    // (c) dosing with (almost) no water: counters moving while flow < dosing_max_flow_lph
    const lowFlow = typeof flow === 'number' && meter.known && flow < cfg.dosing_max_flow_lph;
    if (lowFlow) {
      if (c.lowFlowSince === undefined || c.lowFlowSince === null) { c.lowFlowSince = nowMs; c.lowFlowConsumed = consumedSum(c.consumedNow); }
    } else { c.lowFlowSince = null; }
    if (inst.fired && !c.escalated) {
      const dosed = this._panelDosed(c);
      const nutrient = dosed.filter(d => d.nutrient);
      const mean = nutrient.length ? nutrient.reduce((a, d) => a + d.litres, 0) / nutrient.length : 0;
      const ratio = mean > 0 && c.waterL > 0 ? c.waterL / mean : null;
      let why = null;
      if (nowMs - inst.start > cfg.manual_panel_max_minutes * 60000) why = { kind: 'long' };
      else if (ratio !== null && c.waterL >= 200 && Math.max(...nutrient.map(d => d.litres)) >= 1 && ratio < cfg.manual_panel_max_ratio) why = { kind: 'ratio', ratio };
      else if (lowFlow && c.lowFlowSince !== null && nowMs - c.lowFlowSince >= cfg.dosing_seconds * 1000
        && consumedSum(c.consumedNow) - c.lowFlowConsumed >= TANK_MOVED_L) why = { kind: 'dosing_low_flow', litres: consumedSum(c.consumedNow) - c.lowFlowConsumed, forMs: nowMs - c.lowFlowSince };
      if (why) {
        c.escalated = { ...why, at: nowMs };
        this.log.warn(`[FlowWatch] manual panel run escalated: ${why.kind}`);
        const base = inst.msg || this._fireSpec(inst, inst.firedAt || nowMs);
        inst.msg = withExtra(base, M('flow_watch.panel.escalated', { why: this._panelWhy(c, nowMs) }));
        inst.message = en(inst.msg);
        this._updateOpenAlert(this._fingerprint(inst), { ...keyArgs(inst.msg), severity: 'info' });
        if (inst.episodeId) {
          try { this.db.prepare('UPDATE irrigation_flow_episodes SET severity = ?, updated_at = ? WHERE id = ?').run('warning', iso(nowMs), inst.episodeId); } catch (_) { /* best-effort */ }
        }
      }
    }
    return { now, active: true, escalated: !!c.escalated, inst };
  }

  /** Litres per tank since the start of a panel run: [{ id, name, litres, nutrient }]. */
  /** End of a panel run = when the water stopped (not when a dosing tail stopped), unless that tail escalated it. */
  _panelEndAt(inst, fallback) {
    const c = inst.ctx || {};
    if (c.escalated && c.escalated.kind === 'dosing_low_flow') return fallback;
    return c.lastWaterMs !== undefined && c.lastWaterMs < fallback ? c.lastWaterMs : fallback;
  }

  _panelDosed(c) {
    const out = [];
    const s = c.consumedStart || {};
    const n = c.consumedNow || {};
    for (const [id, v0] of Object.entries(s)) {
      const v1 = n[id];
      if (typeof v0 !== 'number' || typeof v1 !== 'number') continue;
      const name = (c.tankNames || {})[id] || `Tank ${id}`;
      out.push({ id: Number(id), name, litres: Math.max(0, v1 - v0), nutrient: !/ph/i.test(name) });
    }
    return out;
  }

  _panelSummary(c) {
    const dosed = this._panelDosed(c).filter(d => d.litres > 0 || d.nutrient);
    const nutrient = dosed.filter(d => d.nutrient);
    const mean = nutrient.length ? nutrient.reduce((a, d) => a + d.litres, 0) / nutrient.length : 0;
    const ratio = mean > 0 && c.waterL > 0 ? Math.round(c.waterL / mean) : null;
    const items = dosed.filter(d => d.litres > 0).map(d => `${shortTankName(d.name, d.id)} ${fmtL2(d.litres)} L`);
    return { tanks: items.length ? i18n.list(items) : M('flow_watch.panel.no_dosing'), ratio, water: fmtLph(c.waterL) };
  }

  _panelWhy(c, nowMs) {
    const cfg = this.getConfig();
    const e = c.escalated || {};
    if (e.kind === 'long') return M('flow_watch.panel.why_long', { dur: i18n.dur(nowMs - c.startMs), max: String(cfg.manual_panel_max_minutes) });
    if (e.kind === 'ratio') return M('flow_watch.panel.why_ratio', { max: String(cfg.manual_panel_max_ratio), ratio: String(Math.round(e.ratio)) });
    if (e.kind === 'dosing_low_flow') return M('flow_watch.panel.why_dosing_low_flow', { litres: fmtL2(e.litres), dur: i18n.dur(e.forMs), max: fmtLph(cfg.dosing_max_flow_lph) });
    return M('flow_watch.panel.why_default');
  }

  _panelZoneHint(c) {
    const st = this._static;
    const exp = st ? Object.values(st.expected || {}).filter(v => v > 0) : [];
    const one = median(exp) || 8820;
    const f = c.startFlow;
    if (typeof f !== 'number' || !(f > 0)) return null;
    const k = f / one;
    if (Math.abs(k - 1) <= 0.15) return M('flow_watch.panel.hint_one');
    if (Math.abs(k - 2) <= 0.3) return M('flow_watch.panel.hint_two');
    return null;
  }

  // ─── pump no-flow protection: shutdown / cold-restart retry ──────────────

  /** Channels of the irrigation run on the irrigation board: pump, mixing pump, zones. */
  _runChannels(cfg) {
    return [...new Set([cfg.pump_channel, cfg.mixing_pump_channel, ...cfg.zone_channels])].filter(ch => Number.isInteger(ch));
  }

  _pumpChannels(cfg) {
    return [...new Set([cfg.pump_channel, cfg.mixing_pump_channel])].filter(ch => Number.isInteger(ch));
  }

  _noFlowThreshold(cfg, zone) {
    const exp = zone && zone.expectedLph ? zone.expectedLph : null;
    return Math.max(cfg.shutdown_flow_lph, exp ? (exp * cfg.shutdown_flow_pct) / 100 : 0);
  }

  _evalPumpGuard(cfg, nowMs, relays, meter, st, onZones, current) {
    const key = `pump_no_flow_shutdown:${cfg.irrigation_equipment_id}`;
    const reset = () => { if (this.instances.has(key)) this._step(key, 'pump_no_flow_shutdown', nowMs, false, { gapMs: 0, clearMs: 0, falseReason: 'ended' }); };
    let g = this.guard;

    // Forget a finished run: pump OFF, no zone ON for 60 s and nothing in progress.
    if (g && !GUARD_BUSY.has(g.phase) && relays.known && !relays.pump.on && onZones.length === 0) {
      if (g.idleSince == null) g.idleSince = nowMs;
      if (g.phase === 'retry_watch') this._retryEnded(g, nowMs, M('flow_watch.why.pump_off_early'));
      if (nowMs - g.idleSince >= 60000) { this.guard = null; g = null; }
    } else if (g) {
      g.idleSince = null;
    }

    if (!cfg.shutdown_enabled) { reset(); return; }

    if (g && GUARD_BUSY.has(g.phase)) {
      // Pumps are OFF on purpose (retry pause) or an action is on the wire.
      if (g.phase === 'retry_pause') {
        const op = this._operatorActionSince(cfg, g.retry && g.retry.eventMark);
        if (op) this._retryAbandoned(g, nowMs, M('flow_watch.why.operator_action', { equipment: st.eqName, source: String(op) }));
        else if (nowMs >= g.retry.restartAt) {
          g.phase = 'retry_restarting';
          this._track(this._retryRestart(g, nowMs));
        }
      }
      reset();
      return;
    }

    // Never act on a blind meter or an unknown relay board (monitor_blind covers it).
    if (!relays.known || !meter.known) { reset(); return; }

    const thr = this._noFlowThreshold(cfg, current);
    const flow = meter.flow;

    if (g && g.phase === 'retry_watch' && relays.pump.on) {
      const r = g.retry;
      const exp = r.zone && r.zone.expectedLph ? r.zone.expectedLph : null;
      const need = Math.max(thr, exp ? (exp * cfg.recovered_pct) / 100 : thr * 4);
      if (flow >= need) this._retryRecovered(g, nowMs, flow);
    }

    const pumpStart = relays.pump.on ? relays.pump.openedAt : null;
    const lastSwitch = relays.lastSwitchMs ?? pumpStart ?? nowMs;
    const coldStart = pumpStart !== null && pumpStart >= lastSwitch - 1500;
    const graceS = coldStart ? cfg.cold_start_grace_seconds : cfg.shutdown_grace_seconds;
    const notBefore = lastSwitch + graceS * 1000;
    const verdict = relays.pump.on && flow < thr;
    this._step(key, 'pump_no_flow_shutdown', nowMs, verdict, {
      holdMs: cfg.shutdown_no_flow_seconds * 1000, notBefore, gapMs: cfg.gap_seconds * 1000, clearMs: 0,
      falseReason: relays.pump.on ? 'recovered' : 'ended', flow,
      ctx: {
        eqName: st.eqName, eqId: cfg.irrigation_equipment_id, threshold: thr, notBefore, graceS, coldStart,
        zone: current ? { channel: current.channel, name: current.name, expectedLph: current.expectedLph, openedAt: current.openedAt } : null,
        pumpOpenedAt: pumpStart, automationId: relays.pump.automationId ?? null,
        otherZones: onZones.filter(z => !current || z.channel !== current.channel).map(z => z.channel),
      },
    });
    // Act on time even while the monitor is on its 10 s idle cadence (it drops to
    // it when the flow stops): wake up when the hold period would complete.
    const inst = this.instances.get(key);
    if (inst && !inst.fired) {
      const dueAt = Math.max(inst.start, notBefore) + cfg.shutdown_no_flow_seconds * 1000;
      if (dueAt > nowMs && this._guardWakeAt !== dueAt) {
        this._guardWakeAt = dueAt;
        this._setTimer(() => { try { this.evaluate(this.now(), { force: true }); } catch (e) { this.log.error(`[FlowWatch] evaluate failed: ${e.message}`); } }, dueAt - nowMs + 20);
      }
    }
  }

  /** Latest operator relay action (manual / stop-all) on the irrigation board after relay_events id `mark`. */
  _operatorActionSince(cfg, mark) {
    if (mark === null || mark === undefined) return null;
    try {
      const rows = this.db.prepare('SELECT source FROM relay_events WHERE equipment_id = ? AND id > ? ORDER BY id').all(cfg.irrigation_equipment_id, mark);
      const hit = rows.find(r => OPERATOR_SOURCES.has(r.source));
      return hit ? hit.source : null;
    } catch (_) { return null; }
  }

  _eventMark() {
    try { return this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM relay_events').get().id; } catch (_) { return 0; }
  }

  /** The guard for the run this detection belongs to (one per automation trigger). */
  _ensureGuard(cfg, nowMs, ctx) {
    if (this.guard) return this.guard;
    let automationName = null;
    let lastRun = null;
    if (ctx.automationId != null) {
      try {
        const row = this.db.prepare('SELECT name, last_run FROM automations WHERE id = ?').get(ctx.automationId);
        if (row) { automationName = row.name; lastRun = row.last_run; }
      } catch (_) { /* unnamed */ }
    }
    const runStart = parseDbTs(lastRun) ?? ctx.pumpOpenedAt ?? nowMs;
    this.guard = {
      runKey: `${ctx.automationId != null ? `a${ctx.automationId}` : 'manual'}@${new Date(runStart).toISOString().slice(0, 19)}`,
      automationId: ctx.automationId ?? null, automationName,
      phase: 'active', retries: new Map(), retry: null, idleSince: null, createdAt: nowMs,
    };
    return this.guard;
  }

  _guardFingerprint(cfg, g, zone) {
    return `flow_watch:pump_no_flow:${cfg.irrigation_equipment_id}:${g.runKey}:${zone ? zone.channel : 'none'}`;
  }

  _act() {
    if (this._actuator) return this._actuator;
    this._actuator = defaultActuator(this.db, this.log);
    return this._actuator;
  }

  /** Same fire-time gate as RelayTimerService for energising timers: the owning automation must still be enabled (fails closed). */
  _automationEnabled(automationId) {
    if (automationId == null) return true;
    try {
      const row = this.db.prepare('SELECT enabled FROM automations WHERE id = ?').get(automationId);
      return !!(row && row.enabled);
    } catch (_) { return false; }
  }

  _isDisarmed() {
    try { return !!this._act().isDisarmed(); } catch (_) { return true; } // fail closed: no retry
  }

  /** The zero-flow condition held: retry once per zone (cold restart) or shut the run down. */
  _onPumpNoFlow(inst, nowMs) {
    const cfg = this.getConfig();
    const c = inst.ctx;
    const g = this._ensureGuard(cfg, nowMs, c);
    const noFlowMs = nowMs - Math.max(inst.start, c.notBefore || 0);
    const zone = c.zone;
    const retried = zone ? (g.retries.get(zone.channel) || 0) : 0;
    const d = this._retryDecision(cfg, g, c, nowMs);
    const base = {
      zone, noFlowMs, noFlowSince: Math.max(inst.start, c.notBefore || 0), flow: this.flow ? this.flow.values.flow_lph : null,
      minFlow: inst.minFlow, threshold: c.threshold, retried,
    };
    if (d.retry) {
      g.phase = 'retry_stopping';
      g.retries.set(zone.channel, retried + 1);
      this._track(this._retryStart(g, { ...base, ...d }, nowMs));
    } else {
      g.phase = 'shutting_down';
      this._track(this._fullShutdown(g, { ...base, whyNoRetry: d.reason }, nowMs));
    }
  }

  _retryDecision(cfg, g, ctx, nowMs) {
    const zone = ctx.zone;
    if (cfg.max_retries <= 0) return { retry: false, reason: M('flow_watch.why.retry_off') };
    if (!zone) return { retry: false, reason: M('flow_watch.why.no_zone') };
    if ((g.retries.get(zone.channel) || 0) >= cfg.max_retries) return { retry: false, reason: M('flow_watch.why.retry_failed') };
    if ((ctx.otherZones || []).length) return { retry: false, reason: M('flow_watch.why.several_zones') };
    if (this._isDisarmed()) return { retry: false, reason: M('flow_watch.why.disarmed') };
    const act = this._act();
    const eqId = cfg.irrigation_equipment_id;
    const pumpOff = act.getOffTimer(eqId, cfg.pump_channel);
    if (!pumpOff) return { retry: false, reason: M('flow_watch.why.no_pump_end') };
    // Soft-switch: the zone valve opened >= 1 s before the pumps (no pressure) — keep it
    // energised and cycle only the pumps. Otherwise the valve was switched under
    // pressure: cycle it together with the pumps (cold start, as at 09:52).
    const valveCycle = !(zone.openedAt !== null && ctx.pumpOpenedAt !== null && zone.openedAt <= ctx.pumpOpenedAt - 1000);
    const zoneOff = act.getOffTimer(eqId, zone.channel);
    if (!zoneOff) return { retry: false, reason: M('flow_watch.why.no_zone_end') };
    const pumpEndMs = pumpOff.firesAt.getTime();
    const zoneEndMs = zoneOff.firesAt.getTime();
    const segEndMs = valveCycle ? zoneEndMs : Math.min(pumpEndMs, zoneEndMs);
    const left = (segEndMs - (nowMs + cfg.retry_pause_seconds * 1000)) / 1000;
    if (left < cfg.retry_min_remaining_seconds) return { retry: false, reason: M('flow_watch.why.too_little_left', { seconds: String(Math.max(0, Math.round(left))) }) };
    return { retry: true, valveCycle, pumpEndMs, zoneEndMs, segEndMs };
  }

  _labelZone(cfg, zone) {
    const st = this._staticInfo(cfg, this.now());
    return zone
      ? M('flow_watch.label.zone', { zone: zone.name, equipment: st.eqName, channel: String(zone.channel) })
      : M('flow_watch.label.pump', { equipment: st.eqName, channel: String(cfg.pump_channel) });
  }

  async _retryStart(g, info, nowMs) {
    const cfg = this.getConfig();
    const act = this._act();
    const eqId = cfg.irrigation_equipment_id;
    const zone = info.zone;
    const label = this._labelZone(cfg, zone);
    const fp = this._guardFingerprint(cfg, g, zone);
    g.retry = {
      zone, valveCycle: info.valveCycle, segEndMs: info.segEndMs, pumpEndMs: info.pumpEndMs, zoneEndMs: info.zoneEndMs,
      noFlowSince: info.noFlowSince, noFlowMs: info.noFlowMs, minFlow: info.minFlow, startedAt: nowMs, restartAt: null,
      restartedAt: null, attempt: g.retries.get(zone.channel), fingerprint: fp, eventMark: this._eventMark(), dose: null,
    };
    const chans = info.valveCycle ? [...this._pumpChannels(cfg), zone.channel] : this._pumpChannels(cfg);
    const startParams = {
      label, dur: i18n.dur(info.noFlowMs), flow: fmtLph(info.flow), threshold: fmtLph(info.threshold),
      pause: String(cfg.retry_pause_seconds), attempt: String(g.retry.attempt), max: String(cfg.max_retries),
    };
    const spec = info.valveCycle ? M('flow_watch.retry.start_valve', startParams) : M('flow_watch.retry.start_pumps', startParams);
    const msg = en(spec);
    g.retry.message = msg;
    g.retry.msg = spec;
    const row = this._createAlert({ severity: 'critical', source: 'flow_watch', equipment_id: eqId, fingerprint: fp, ...keyArgs(spec),
      metadata: { rule: 'pump_no_flow_shutdown', phase: 'retry', run_key: g.runKey } });
    g.retry.alertId = row && row.id ? row.id : null;
    this.log.warn(`[FlowWatch] ALARM pump_no_flow ${g.runKey}: ${msg}`);

    // 1. dosing: pause (closed-loop targets kept) — or abort a cycle that cannot pause
    g.retry.dose = await this._pauseOrAbortDosing(`flow watch cold-restart retry: ${zone.name} no water`, 'flow_watch_retry');
    // 2. pumps (+ zone) OFF
    const off = await this._writeOffSafe(eqId, chans, 'flow_watch_retry', g.automationId);
    if (!off.confirmed) {
      g.phase = 'shutting_down';
      await this._fullShutdown(g, { ...info, whyNoRetry: M('flow_watch.why.off_unconfirmed', { error: off.error || M('flow_watch.why.readback_disagrees') }) }, this.now());
      return;
    }
    // 3. pause, then restart from evaluate() (tick / samples) or the wake-up timer
    g.retry.restartAt = this.now() + cfg.retry_pause_seconds * 1000;
    g.phase = 'retry_pause';
    this._setTimer(() => { try { this.evaluate(this.now(), { force: true }); } catch (e) { this.log.error(`[FlowWatch] restart evaluate failed: ${e.message}`); } }, cfg.retry_pause_seconds * 1000 + 50);
    this._sendNotify(TITLES.pump_no_flow_shutdown, M('flow_watch.retry.notify', { message: spec, dose: g.retry.dose.spec || null }), 'critical');
  }

  async _pauseOrAbortDosing(reason, source) {
    const ds = this.doseScheduler;
    if (!ds) return { outcome: 'none', text: '' };
    let running = false;
    try { running = ds.isRunning(); } catch (_) { running = false; }
    if (!running) return { outcome: 'none', text: '' };
    try {
      if (typeof ds.pauseDosing === 'function' && ds.pauseDosing(reason)) return { outcome: 'paused', text: '' };
      const aborted = await ds.abortCycle(reason, { source });
      if (!aborted) return { outcome: 'none', text: '' };
      const spec = M('flow_watch.retry.dose_aborted');
      return { outcome: 'aborted', text: ` ${en(spec)}`, spec };
    } catch (e) {
      const spec = M('flow_watch.retry.dose_failed', { error: e.message });
      return { outcome: 'failed', text: ` ${en(spec)}`, spec };
    }
  }

  _resumeDosing(g) {
    const ds = this.doseScheduler;
    if (!ds || !g.retry || !g.retry.dose || g.retry.dose.outcome !== 'paused') return false;
    try { return typeof ds.resumeDosing === 'function' ? !!ds.resumeDosing('flow watch cold restart') : false; } catch (_) { return false; }
  }

  async _retryRestart(g, nowMs) {
    const cfg = this.getConfig();
    const act = this._act();
    const eqId = cfg.irrigation_equipment_id;
    const r = g.retry;
    const label = this._labelZone(cfg, r.zone);
    const info = { zone: r.zone, noFlowMs: r.noFlowMs, noFlowSince: r.noFlowSince, minFlow: r.minFlow, retried: r.attempt };
    if (this._isDisarmed()) {
      g.phase = 'shutting_down';
      await this._fullShutdown(g, { ...info, whyNoRetry: M('flow_watch.why.disarmed_in_pause') }, this.now());
      return;
    }
    if (!this._automationEnabled(g.automationId)) {
      g.phase = 'shutting_down';
      await this._fullShutdown(g, { ...info, whyNoRetry: M('flow_watch.why.automation_gone') }, this.now());
      return;
    }
    // Never two zones open: which zones are ON now?
    const relays = this._relays(cfg, nowMs);
    const onNow = relays.known ? relays.zones.filter(z => z.on).map(z => z.channel) : null;
    if (onNow === null) {
      g.phase = 'shutting_down';
      await this._fullShutdown(g, { ...info, whyNoRetry: M('flow_watch.why.relays_unknown') }, this.now());
      return;
    }
    const others = onNow.filter(ch => ch !== r.zone.channel);
    let zoneToo = r.valveCycle;
    let note = '';
    if (others.length && !r.valveCycle) {
      g.phase = 'shutting_down';
      await this._fullShutdown(g, { ...info, whyNoRetry: M('flow_watch.why.other_zone_opened') }, this.now());
      return;
    }
    let noteSpec = null;
    if (others.length) { zoneToo = false; noteSpec = M('flow_watch.retry.superseded', { zone: r.zone.name }); note = ` ${en(noteSpec)}`; }
    const left = (r.segEndMs - nowMs) / 1000;
    if (!others.length && left < cfg.retry_min_remaining_seconds) {
      g.phase = 'shutting_down';
      await this._fullShutdown(g, { ...info, whyNoRetry: M('flow_watch.why.too_little_left_at_restart', { seconds: String(Math.max(0, Math.round(left))) }) }, this.now());
      return;
    }
    const chans = zoneToo ? [r.zone.channel, ...this._pumpChannels(cfg)] : this._pumpChannels(cfg);
    if (g.operatorStopped) { this._retryAbandoned(g, this.now(), M('flow_watch.why.stop_pressed')); return; }
    let on;
    try {
      on = await act.writeOn(eqId, chans, { source: 'flow_watch_retry', automationId: g.automationId });
    } catch (e) {
      on = { confirmed: false, error: e.message };
    }
    if (g.operatorStopped) {
      // Stop irrigation landed while the restart ON was on the wire: undo it at once.
      const off = await this._writeOffSafe(eqId, this._runChannels(cfg), 'stop_irrigation', g.automationId, g.operatorStopped.by || null);
      this._retryAbandoned(g, this.now(), off.confirmed ? M('flow_watch.why.stop_pressed_restart') : M('flow_watch.why.stop_pressed_restart_unconfirmed'));
      return;
    }
    if (!on || !on.confirmed) {
      g.phase = 'shutting_down';
      await this._fullShutdown(g, { ...info, whyNoRetry: M('flow_watch.why.on_unconfirmed', { error: (on && on.error) || M('flow_watch.why.readback_disagrees') }) }, this.now());
      return;
    }
    const now2 = this.now();
    // Auto-offs: the run's own planned ends still stand; only fill in a missing one,
    // and extend the pumps (capped) when a valve-cycled zone ends after them.
    try {
      if (zoneToo && !act.getOffTimer(eqId, r.zone.channel)) act.scheduleOff(eqId, r.zone.channel, Math.max(1, (r.zoneEndMs - now2) / 1000), { source: 'flow_watch_retry_auto_off', automationId: g.automationId });
      const cap = r.pumpEndMs + (cfg.retry_pause_seconds + 5) * 1000;
      const wantPumpEnd = zoneToo && r.zoneEndMs > r.pumpEndMs ? Math.min(r.zoneEndMs, cap) : r.pumpEndMs;
      for (const ch of this._pumpChannels(cfg)) {
        const t = act.getOffTimer(eqId, ch);
        if (!t || (wantPumpEnd > r.pumpEndMs && t.firesAt.getTime() < wantPumpEnd)) {
          act.scheduleOff(eqId, ch, Math.max(1, (wantPumpEnd - now2) / 1000), { source: 'flow_watch_retry_auto_off', automationId: g.automationId });
        }
      }
    } catch (e) { this.log.error(`[FlowWatch] retry auto-off scheduling failed: ${e.message}`); }
    const resumed = this._resumeDosing(g);
    r.restartedAt = now2;
    r.note = note;
    r.noteSpec = noteSpec;
    r.resumed = resumed;
    g.phase = 'retry_watch';
    this._relayCache = null;
    this.log.warn(`[FlowWatch] cold restart: ${en(label)} — ${chans.join(',')} ON (dosing ${resumed ? 'resumed' : r.dose && r.dose.outcome === 'aborted' ? 'aborted' : 'n/a'})${note}`);
  }

  _retryRecovered(g, nowMs, flow) {
    const cfg = this.getConfig();
    const r = g.retry;
    g.phase = 'active';
    const label = this._labelZone(cfg, r.zone);
    const recParams = {
      label, dur: i18n.dur(r.noFlowMs), pause: String(cfg.retry_pause_seconds), flow: fmtLph(flow),
      after: i18n.dur(nowMs - (r.restartedAt || nowMs)), note: r.noteSpec || null,
      dose: r.dose && r.dose.outcome === 'aborted' ? M('flow_watch.retry.recovered_dose_aborted') : r.resumed ? M('flow_watch.retry.recovered_dose_resumed') : null,
    };
    const spec = r.valveCycle ? M('flow_watch.retry.recovered_valve', recParams) : M('flow_watch.retry.recovered_pumps', recParams);
    const msg = en(spec);
    r.outcome = 'recovered';
    this._updateOpenAlert(r.fingerprint, { ...keyArgs(spec), severity: 'warning' });
    this._recordGuardEpisode(cfg, g, 'retry_recovered', { zone: r.zone, since: r.noFlowSince, endMs: nowMs, recovered: 1, minFlow: r.minFlow, endFlow: flow, message: msg,
      severity: 'warning', alertId: r.alertId, doseAborted: r.dose && r.dose.outcome === 'aborted', detail: { retry: this._retryDetail(r), automation_id: g.automationId, automation_name: g.automationName, run_key: g.runKey } });
    this.log.log(`[FlowWatch] ${msg}`);
    this._sendNotify(M('flow_watch.title.retry_recovered'), spec, 'warning');
  }

  _retryEnded(g, nowMs, why) {
    const cfg = this.getConfig();
    const r = g.retry;
    g.phase = 'active';
    if (!r) return;
    r.outcome = 'ended';
    const spec = withExtra(this._retryBase(r), M('flow_watch.retry.ended', { why }));
    const msg = en(spec);
    this._updateOpenAlert(r.fingerprint, { ...keyArgs(spec), severity: 'warning' });
    this._recordGuardEpisode(cfg, g, 'retry_ended', { zone: r.zone, since: r.noFlowSince, endMs: nowMs, recovered: 0, minFlow: r.minFlow, message: msg,
      severity: 'warning', alertId: r.alertId, detail: { retry: this._retryDetail(r), run_key: g.runKey, automation_id: g.automationId } });
  }

  _retryAbandoned(g, nowMs, why) {
    const cfg = this.getConfig();
    const r = g.retry;
    g.phase = 'active';
    r.outcome = 'abandoned';
    this._resumeDosing(g); // the operator's stop aborts the dose cycle itself; a no-op then
    const spec = withExtra(this._retryBase(r), M('flow_watch.retry.abandoned', { why }));
    const msg = en(spec);
    this._updateOpenAlert(r.fingerprint, { ...keyArgs(spec), severity: 'critical' });
    this._recordGuardEpisode(cfg, g, 'retry_abandoned', { zone: r.zone, since: r.noFlowSince, endMs: nowMs, recovered: 0, minFlow: r.minFlow, message: msg,
      severity: 'critical', alertId: r.alertId, detail: { retry: this._retryDetail(r), run_key: g.runKey, automation_id: g.automationId } });
    this.log.warn(`[FlowWatch] ${msg}`);
  }

  /** The retry-start alert spec (a retry built without one — tests — falls back to its English text). */
  _retryBase(r) {
    return r.msg || M('flow_watch.retry.legacy', { message: r.message || '' });
  }

  _retryDetail(r) {
    return r ? {
      attempt: r.attempt, valve_cycled: r.valveCycle, started_at: iso(r.startedAt), restarted_at: iso(r.restartedAt),
      segment_end: iso(r.segEndMs), dose: r.dose ? r.dose.outcome : null, outcome: r.outcome || null,
    } : null;
  }

  /** OFF with one retry of the whole write on failure; never throws. */
  async _writeOffSafe(eqId, channels, source, automationId, userEmail = null) {
    const act = this._act();
    let res = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        res = await act.writeOff(eqId, channels, userEmail ? { source, automationId, userEmail } : { source, automationId });
      } catch (e) {
        res = { confirmed: false, error: e.message, items: [] };
      }
      if (res && res.confirmed) return { ...res, attempts: attempt };
    }
    return { ...(res || {}), confirmed: false, attempts: 2 };
  }

  async _fullShutdown(g, info, nowMs) {
    const cfg = this.getConfig();
    const act = this._act();
    const st = this._staticInfo(cfg, nowMs);
    const eqId = cfg.irrigation_equipment_id;
    const zone = info.zone || null;
    const fp = this._guardFingerprint(cfg, g, zone);
    const label = this._labelZone(cfg, zone);
    const retried = g.retry && zone && g.retry.zone && g.retry.zone.channel === zone.channel && g.retry.restartedAt ? g.retry : null;

    // 0. Nothing of this run may start again: cancel its delayed starts first (auto-offs stay until OFF is confirmed).
    let cancelled = [];
    try { cancelled = act.cancelRunTimers(g.automationId, eqId) || []; } catch (e) { this.log.error(`[FlowWatch] timer cancel failed: ${e.message}`); }
    // 1+2. pumps + zones OFF (first on the wire), dose cycle aborted right behind it.
    const { offs: [off], dose } = await this._shutdownWrites({
      first: [{ eqId, channels: this._runChannels(cfg) }], source: 'flow_watch_shutdown', automationId: g.automationId,
      abortReason: `flow_watch_shutdown: ${zone ? zone.name : 'pump'} no water flow`,
    });
    const confirmedChs = (off.items || []).filter(i => i.confirmed).map(i => i.channel);
    try { act.cancelOffTimers(eqId, confirmedChs, g.automationId); } catch (_) { /* the auto-off would only write OFF again */ }

    // zones that will not get water this run
    const notIrrigated = [];
    if (zone) notIrrigated.push(zone.name);
    const later = [...new Set(cancelled.filter(t => t.type === 'delay' && t.channel && cfg.zone_channels.includes(t.channel)).map(t => t.channel))];
    for (const ch of later) { const nm = st.names[ch] || `Relay ${ch}`; if (!notIrrigated.includes(nm)) notIrrigated.push(nm); }

    const whatSpec = zone
      ? M('flow_watch.shutdown.what_zone', { label, dur: i18n.dur(info.noFlowMs) })
      : M('flow_watch.shutdown.what_no_zone', { label, dur: i18n.dur(info.noFlowMs) });
    const what = en(whatSpec);
    let retrySpec = null;
    if (retried) {
      retrySpec = retried.valveCycle
        ? M('flow_watch.shutdown.retry_failed_valve', { pause: String(cfg.retry_pause_seconds) })
        : M('flow_watch.shutdown.retry_failed_pumps', { pause: String(cfg.retry_pause_seconds) });
    } else if (info.whyNoRetry && zone) retrySpec = M('flow_watch.shutdown.no_retry', { why: info.whyNoRetry });
    const outcome = [];
    if (off.confirmed) outcome.push(M('flow_watch.shutdown.off_confirmed', { relays: i18n.list(this._runChannels(cfg).map(String)) }));
    const nStarts = cancelled.filter(t => t.type !== 'off').length;
    outcome.push(M('flow_watch.shutdown.starts_cancelled', { count: nStarts }));
    if (dose.outcome === 'aborted') outcome.push(M('flow_watch.shutdown.dose_aborted', { cycle: cycleRef(dose.cycleLogId) }));
    else if (dose.outcome === 'failed') outcome.push(M('flow_watch.shutdown.dose_abort_failed', { error: String(dose.error) }));
    let warningSpec = null;
    if (!off.confirmed) {
      const bad = (off.items || []).filter(i => !i.confirmed).map(i => i.channel);
      const relays = (bad.length ? bad : this._runChannels(cfg)).map(String);
      warningSpec = M('flow_watch.shutdown.not_confirmed', {
        count: bad.length === 1 ? 1 : 2, equipment: st.eqName, relays: i18n.list(relays), error: off.error ? ` (${off.error})` : '',
      });
      const unconfSpec = M('flow_watch.shutdown.off_unconfirmed_alert', {
        equipment: st.eqName, relays: bad.length ? i18n.list(bad.map(String)) : M('flow_watch.all'), error: off.error ? `: ${off.error}` : '',
      });
      this._createAlert({ severity: 'critical', source: 'flow_watch', equipment_id: eqId, fingerprint: `flow_watch:shutdown_off_unconfirmed:${eqId}`,
        ...keyArgs(unconfSpec) });
    }
    const spec = M('flow_watch.shutdown.main', {
      what: whatSpec, retry: retrySpec,
      zones: notIrrigated.length ? i18n.list(notIrrigated) : M('common.none'),
      check: zone ? M('flow_watch.shutdown.check_valve') : M('flow_watch.shutdown.check_no_zone'),
      outcome: semi(outcome), warning: warningSpec,
    });
    const msg = en(spec);
    const existing = retried ? retried.fingerprint === fp : false;
    let alertId = retried ? retried.alertId : null;
    if (existing) this._updateOpenAlert(fp, { ...keyArgs(spec), severity: 'critical' });
    const row = existing ? null : this._createAlert({ severity: 'critical', source: 'flow_watch', equipment_id: eqId, fingerprint: fp, ...keyArgs(spec),
      metadata: { rule: 'pump_no_flow_shutdown', phase: 'shutdown', run_key: g.runKey } });
    if (row && row.id) alertId = row.id;
    if (retried) retried.outcome = 'failed';

    try {
      if (g.automationId != null) act.logAutomationRun(g.automationId, 'failure', `ABORTED by flow watch (pump_no_flow_shutdown): ${what}; pumps/zones/dosing switched off. Zones not irrigated: ${notIrrigated.join(', ') || 'none'}.${off.confirmed ? '' : ' OFF NOT confirmed.'}`);
    } catch (e) { this.log.error(`[FlowWatch] automation log failed: ${e.message}`); }

    this._recordGuardEpisode(cfg, g, 'run_shutdown', {
      zone, since: info.noFlowSince, endMs: this.now(), recovered: 0, minFlow: info.minFlow, message: msg, severity: 'critical', alertId,
      doseAborted: dose.outcome === 'aborted',
      detail: {
        automation_id: g.automationId, automation_name: g.automationName, run_key: g.runKey,
        zones_not_irrigated: notIrrigated, off_confirmed: !!off.confirmed, off_attempts: off.attempts || null,
        timers_cancelled: cancelled.map(t => t.key), dose: dose.outcome, no_retry_reason: retried ? null : (info.whyNoRetry ? en(info.whyNoRetry) : null),
        retry: this._retryDetail(retried),
      },
    });
    g.phase = 'done';
    g.lastShutdownAt = this.now();
    this.log.warn(`[FlowWatch] RUN SHUTDOWN ${g.runKey}: ${msg}`);
    this._sendNotify(TITLES.pump_no_flow_shutdown, spec, 'critical');
  }

  /**
   * The OFF half of a run shutdown, shared by the flow-watch pump protection and the
   * operator's Stop irrigation. `first` boards are written OFF at once (FC15 + read-back,
   * whole write re-sent once) in parallel with the dose-cycle abort; `afterDose` boards
   * (the dosing valves) are written OFF with read-back once the abort has returned, so
   * no dose-controller valve write can land after the confirming read-back. Never
   * throws; OFF is never blocked by disarm.
   * @returns {{ offs: Array<{eqId, channels, confirmed, items, error, attempts}>, dose: {outcome, cycleLogId?, error?} }}
   */
  async _shutdownWrites({ first = [], afterDose = [], source, automationId = null, userEmail = null, abortReason }) {
    const write = (w) => this._writeOffSafe(w.eqId, w.channels, source, automationId, userEmail).then(r => ({ ...r, eqId: w.eqId, channels: w.channels }));
    const firstP = Promise.all(first.map(write));
    const doseP = this._abortDoseCycle(abortReason, source);
    const afterP = doseP.then(() => Promise.all(afterDose.map(write)));
    const [a, dose, b] = await Promise.all([firstP, doseP, afterP]);
    return { offs: [...a, ...b], dose };
  }

  /** Abort the running dose cycle (valves closed by the scheduler's abort path). Never throws. */
  async _abortDoseCycle(reason, source) {
    const ds = this.doseScheduler;
    if (!ds) return { outcome: 'none' };
    try {
      if (!ds.isRunning()) return { outcome: 'none' };
      const cyc = ds.currentCycle ? ds.currentCycle() : null;
      const ok = await ds.abortCycle(reason, { source });
      return { outcome: ok ? 'aborted' : 'none', cycleLogId: cyc && cyc.cycleLogId, automationId: cyc ? cyc.automationId ?? null : null };
    } catch (e) { return { outcome: 'failed', error: e.message }; }
  }

  _recordGuardEpisode(cfg, g, kind, e) {
    try {
      const startMs = e.since ?? this.now();
      const endMs = e.endMs ?? this.now();
      this.db.prepare(`
        INSERT INTO irrigation_flow_episodes
          (kind, equipment_id, channel, zone_name, started_at, ended_at, duration_s, expected_lph, min_flow_lph, max_flow_lph,
           recovered, end_reason, alarmed, severity, alert_id, dosing_aborted, detail_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
      `).run(
        kind, cfg.irrigation_equipment_id, e.zone ? e.zone.channel : cfg.pump_channel, e.zone ? e.zone.name : null,
        iso(startMs), iso(endMs), Math.round((endMs - startMs) / 100) / 10, round(e.zone ? e.zone.expectedLph : null),
        round(e.minFlow), round(e.endFlow ?? null), e.recovered, kind, e.severity, e.alertId ?? null, e.doseAborted ? 1 : 0,
        JSON.stringify({ ...(e.detail || {}), message: e.message, end_flow_lph: round(e.endFlow ?? null) }), iso(this.now()), iso(this.now()),
      );
    } catch (err) {
      this.log.error(`[FlowWatch] could not record ${kind} episode: ${err.message}`);
    }
  }

  /** Stop-all / emergency stop: drop a pending cold restart so nothing re-energises afterwards. */
  cancelPendingRetry(why = 'stop-all') {
    const g = this.guard;
    if (!g || !GUARD_RETRY.has(g.phase) || !g.retry) return false;
    if (g.phase === 'retry_pause' || g.phase === 'retry_stopping') {
      // callers pass an i18n spec, or an English string ('Stop All' from stop-all is translated)
      this._retryAbandoned(g, this.now(), why === 'Stop All' ? M('flow_watch.why.stop_all') : why);
      return true;
    }
    return false;
  }

  // ─── operator "Stop irrigation" ───────────────────────────────────────────

  /**
   * Stop ONLY the irrigation side: irrigation pump, mixing pump, zones (irrigation
   * board) and the dosing valves (dosing board). Requirement 2026-09-27, after
   * operators used Stop All to end irrigation runs and it switched off all seven fan
   * boards at ~35 °C (2026-09-26 09:43 and 15:39, 2026-09-27 14:15:54 and 14:16:55;
   * boards 15/16 stayed off ~6 min).
   *
   * Same OFF path as the pump-protection run shutdown (_shutdownWrites): OFF writes
   * only, FC15 + read-back, re-sent once, never blocked by disarm; relay_events source
   * 'stop_irrigation' with the operator's email. Order: (0) drop a pending flow-watch
   * cold restart, (1) cancel every pending START on the two boards (any automation,
   * any manual timer — timers on other boards are never matched), (2) pumps + zones
   * OFF in parallel with the dose-cycle abort, then the dosing valves OFF, (3) a second
   * sweep for a start / dose cycle armed by an automation that was mid-trigger,
   * (4) auto-offs of confirmed channels cancelled (kept where OFF is unconfirmed, as a
   * backstop), (5) the runs marked in automation_logs, (6) one alert per press.
   * Idempotent: pressed when idle it just writes and confirms everything OFF.
   * Concurrent presses share one in-flight stop.
   *
   * @param {object} [opts] { userEmail }
   * @returns {Promise<object>} see _stopIrrigation
   */
  stopIrrigation(opts = {}) {
    if (this._stopInFlight) return this._stopInFlight;
    const p = this._stopIrrigation(opts).finally(() => { if (this._stopInFlight === p) this._stopInFlight = null; });
    this._stopInFlight = p;
    return p;
  }

  _boardInfo(eqId) {
    let row = null;
    try { row = this.db.prepare('SELECT id, name, register_mappings, last_reading FROM equipment WHERE id = ?').get(eqId); } catch (_) { row = null; }
    const names = {};
    let states = {};
    if (row) {
      try {
        for (const m of JSON.parse(row.register_mappings || '[]') || []) {
          const ch = parseInt(m.register ?? m.address, 10);
          if (Number.isInteger(ch) && (m.label || m.name)) names[ch] = m.label || m.name;
        }
      } catch (_) { /* unnamed */ }
      try { states = (JSON.parse(row.last_reading || '{}') || {}).relayStates || {}; } catch (_) { states = {}; }
    }
    return { exists: !!row, name: row ? row.name : `equipment ${eqId}`, names, states };
  }

  async _stopIrrigation({ userEmail = null } = {}) {
    const SOURCE = 'stop_irrigation';
    const cfg = this.getConfig();
    const act = this._act();
    const nowMs = this.now();
    const irrEq = cfg.irrigation_equipment_id;
    const dosEq = cfg.dosing_equipment_id;
    const boards = [irrEq, dosEq];
    const irrChs = this._runChannels(cfg);
    const dosChs = [...(cfg.dosing_channels || [])];
    const whoSpec = userEmail || M('common.an_operator');
    const who = en(whoSpec);
    const tz = getSystemTimezone(this.db);
    const hm = new Date(nowMs).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    const irrInfo = this._boardInfo(irrEq);
    const dosInfo = this._boardInfo(dosEq);
    const chName = (eqId, ch) => (eqId === irrEq ? irrInfo : dosInfo).names[ch] || `Relay ${ch}`;
    this.log.warn(`[FlowWatch] STOP IRRIGATION requested by ${who}: ${irrInfo.name} relays ${irrChs.join(',')} + ${dosInfo.name} relays ${dosChs.join(',')} OFF`);

    // 0. a flow-watch cold restart must not re-energise the pumps behind the stop
    const g = this.guard;
    if (g) g.operatorStopped = { at: nowMs, by: userEmail };
    let retryCancelled = false;
    try { retryCancelled = this.cancelPendingRetry(M('flow_watch.why.stop_irrigation_by', { who: whoSpec })); } catch (e) { this.log.error(`[FlowWatch] stop: retry cancel failed: ${e.message}`); }

    // Who is running: automations owning a pending timer on the two boards, the dose
    // cycle, the flow-watch guard, and whoever switched a channel that is ON now.
    const aids = new Set();
    let pending = [];
    try { pending = act.listEquipmentTimers(boards) || []; } catch (_) { pending = []; }
    for (const t of pending) if (t.automationId != null) aids.add(t.automationId);
    try { const cyc = this.doseScheduler && this.doseScheduler.isRunning() && this.doseScheduler.currentCycle ? this.doseScheduler.currentCycle() : null; if (cyc && cyc.automationId != null) aids.add(cyc.automationId); } catch (_) { /* none */ }
    if (g && g.automationId != null && g.phase !== 'done') aids.add(g.automationId);
    const wasOn = [];
    for (const [eqId, chs, info] of [[irrEq, irrChs, irrInfo], [dosEq, dosChs, dosInfo]]) {
      for (const ch of chs) {
        if (info.states[ch] !== true) continue;
        wasOn.push({ eqId, ch });
        try { const ev = this._latestEvent(eqId, ch); if (ev && ev.state === 1 && ev.automation_id != null) aids.add(ev.automation_id); } catch (_) { /* unknown owner */ }
      }
    }

    // 1. nothing on these boards may start again
    let cancelled = [];
    try { cancelled = act.cancelEquipmentTimers(boards, { kind: 'starts' }) || []; } catch (e) { this.log.error(`[FlowWatch] stop: timer cancel failed: ${e.message}`); }

    // 2. pumps + zones OFF with the dose abort alongside; dosing valves OFF behind the abort
    const abortReason = `${SOURCE}: Stop irrigation pressed by ${who}`;
    const plan = { first: [{ eqId: irrEq, channels: irrChs }], afterDose: dosChs.length ? [{ eqId: dosEq, channels: dosChs }] : [], source: SOURCE, userEmail, abortReason };
    let { offs, dose } = await this._shutdownWrites(plan);

    // 3. second sweep: an automation that was mid-trigger may have armed a start or a dose cycle after step 1
    let late = [];
    try { late = act.cancelEquipmentTimers(boards, { kind: 'starts' }) || []; } catch (_) { late = []; }
    let lateDose = { outcome: 'none' };
    try { if (this.doseScheduler && this.doseScheduler.isRunning()) lateDose = await this._abortDoseCycle(abortReason, SOURCE); } catch (_) { /* reported below */ }
    if (late.length || lateDose.outcome === 'aborted') {
      this.log.warn(`[FlowWatch] stop: second sweep found ${late.length} late start(s)${lateDose.outcome === 'aborted' ? ' and a late dose cycle' : ''} — writing OFF again`);
      cancelled = cancelled.concat(late);
      ({ offs } = await this._shutdownWrites(plan));
      if (dose.outcome !== 'aborted' && lateDose.outcome === 'aborted') dose = lateDose;
    }

    // per-channel result
    const channels = [];
    for (const o of offs) {
      const byCh = new Map((o.items || []).map(i => [i.channel, i]));
      for (const ch of o.channels) {
        const it = byCh.get(ch);
        channels.push({
          equipment_id: o.eqId, equipment: o.eqId === irrEq ? irrInfo.name : dosInfo.name, channel: ch, name: chName(o.eqId, ch),
          was_on: (o.eqId === irrEq ? irrInfo : dosInfo).states[ch] ?? null,
          confirmed: !!(it && it.confirmed), readback: it && typeof it.readback === 'boolean' ? it.readback : null,
        });
      }
    }
    const unconfirmed = channels.filter(c => !c.confirmed);
    const ok = unconfirmed.length === 0;

    // 4. auto-offs: cancel where OFF is confirmed; keep them as a backstop where it is not
    for (const o of offs) {
      const conf = (o.items || []).filter(i => i.confirmed).map(i => i.channel);
      if (!conf.length) continue;
      try { cancelled = cancelled.concat(act.cancelEquipmentTimers([o.eqId], { kind: 'offs', channels: conf, includeRaw: !!o.confirmed }) || []); } catch (_) { /* the auto-off would only write OFF again */ }
    }
    for (const t of cancelled) if (t.automationId != null) aids.add(t.automationId);

    // zones: open when pressed + those whose later start was cancelled
    const zoneSet = new Set(cfg.zone_channels);
    const interrupted = wasOn.filter(x => x.eqId === irrEq && zoneSet.has(x.ch)).map(x => chName(irrEq, x.ch));
    const notStarted = [...new Set(cancelled.filter(t => t.equipmentId === irrEq && (t.type === 'delay') && zoneSet.has(t.channel)).map(t => t.channel))]
      .map(ch => chName(irrEq, ch)).filter(n => !interrupted.includes(n));

    const runs = [...aids].map(id => {
      let name = null;
      try { const r = this.db.prepare('SELECT name FROM automations WHERE id = ?').get(id); name = r ? r.name : null; } catch (_) { /* unnamed */ }
      return { automation_id: id, name };
    });

    // 5. mark the runs (automation_logs has no 'stopped' status; 'skipped' = the rest of the run skipped)
    const starts = cancelled.filter(t => t.type === 'delay' || t.type === 'transition_delay');
    for (const r of runs) {
      try {
        act.logAutomationRun(r.automation_id, 'skipped',
          `STOPPED by operator (Stop irrigation, ${who}) at ${hm}: pumps, zones and dosing switched off; fans/climate not touched.`
          + ` Zones interrupted: ${interrupted.join(', ') || 'none'}; zones not started: ${notStarted.join(', ') || 'none'}.`
          + `${dose.outcome === 'aborted' && dose.automationId === r.automation_id ? ` Dose cycle${dose.cycleLogId ? ` #${dose.cycleLogId}` : ''} aborted.` : ''}${ok ? '' : ' OFF NOT confirmed on every channel.'}`);
      } catch (e) { this.log.error(`[FlowWatch] stop: automation log failed: ${e.message}`); }
    }

    // 6. one alert per press (info when confirmed; critical + Telegram when not)
    const detail = [];
    if (interrupted.length) detail.push(M('irrigation_stop.interrupted', { zones: i18n.list(interrupted) }));
    if (notStarted.length) detail.push(M('irrigation_stop.not_started', { zones: i18n.list(notStarted) }));
    if (starts.length) detail.push(M('irrigation_stop.starts_cancelled', { count: starts.length }));
    if (dose.outcome === 'aborted') detail.push(M('irrigation_stop.dose_aborted', { cycle: cycleRef(dose.cycleLogId) }));
    else if (dose.outcome === 'failed') detail.push(M('irrigation_stop.dose_abort_failed', { error: String(dose.error) }));
    if (retryCancelled) detail.push(M('irrigation_stop.retry_cancelled'));
    if (runs.length) detail.push(M('irrigation_stop.runs', { runs: i18n.list(runs.map(r => r.name || M('common.automation', { id: String(r.automation_id) }))) }));
    if (ok) {
      detail.push(M('irrigation_stop.off_confirmed', {
        irrigation: irrInfo.name, irrigation_channels: i18n.list(irrChs.map(ch => chName(irrEq, ch))),
        dosing: dosInfo.name, dosing_channels: i18n.list(dosChs.map(ch => chName(dosEq, ch))),
      }));
    }
    const spec = M('irrigation_stop.message', {
      who: whoSpec, time: hm,
      detail: detail.length ? M('irrigation_stop.detail', { items: semi(detail) }) : null,
      warning: ok ? null : M('irrigation_stop.not_confirmed', {
        channels: i18n.list(unconfirmed.map(c => M('irrigation_stop.channel', { equipment: c.equipment, channel: String(c.channel), name: c.name }))),
      }),
    });
    const message = en(spec);
    const errorSpec = ok ? null : M('irrigation_stop.error_not_confirmed', {
      channels: i18n.list(unconfirmed.map(c => M('irrigation_stop.error_channel', { name: c.name, equipment: c.equipment, channel: String(c.channel) }))),
    });
    const untouchedSpec = M('irrigation_stop.untouched');
    const row = this._createAlert({
      severity: ok ? 'info' : 'critical', source: 'stop_irrigation', equipment_id: irrEq,
      fingerprint: `stop_irrigation:${irrEq}:${nowMs}`, // one row per press
      ...keyArgs(spec), metadata: { user_email: userEmail, confirmed: ok },
    });
    if (!ok) this._sendNotify(M('flow_watch.title.stop_unconfirmed'), spec, 'critical');
    this.log.warn(`[FlowWatch] ${message}`);
    this._relayCache = null;

    return {
      ok,
      stopped_at: iso(nowMs),
      stopped_by: userEmail,
      message,
      // i18n: `message` / `error` / `untouched` are English; routes render the specs in the request language
      message_key: spec.$k,
      message_params: spec.$p,
      error: errorSpec ? en(errorSpec) : null,
      error_key: errorSpec ? errorSpec.$k : null,
      error_params: errorSpec ? errorSpec.$p : null,
      channels,
      unconfirmed,
      runs_cancelled: runs,
      zones_interrupted: interrupted,
      zones_not_started: notStarted,
      timers_cancelled: cancelled.map(t => ({ key: t.key, type: t.type, equipment_id: t.equipmentId, channel: t.channel, automation_id: t.automationId, fires_at: t.firesAt })),
      dose: { outcome: dose.outcome, cycle_log_id: dose.cycleLogId ?? null, error: dose.error || null },
      retry_cancelled: retryCancelled,
      untouched: en(untouchedSpec),
      untouched_key: untouchedSpec.$k,
      alert_id: row && row.id ? row.id : null,
    };
  }

  lastShutdown() {
    try {
      return this.formatEpisode(this.db.prepare("SELECT * FROM irrigation_flow_episodes WHERE kind IN ('run_shutdown', 'retry_recovered', 'retry_ended', 'retry_abandoned') ORDER BY started_at DESC, id DESC LIMIT 1").get());
    } catch (_) { return null; }
  }

  guardStatus() {
    const g = this.guard;
    if (!g) return null;
    const r = g.retry;
    return {
      phase: g.phase, run_key: g.runKey, automation_id: g.automationId, automation_name: g.automationName,
      retry: r ? { zone: r.zone ? { channel: r.zone.channel, name: r.zone.name } : null, attempt: r.attempt, restart_at: iso(r.restartAt), restarted_at: iso(r.restartedAt), outcome: r.outcome || null } : null,
    };
  }

  // ─── alerts + episodes ────────────────────────────────────────────────────

  _fingerprint(inst) { return `flow_watch:${inst.key}`; }

  _zoneLabel(ctx) {
    return ctx.zone
      ? M('flow_watch.label.zone', { zone: ctx.zone.name, equipment: ctx.eqName, channel: String(ctx.zone.channel) })
      : M('flow_watch.label.irrigation');
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

  /** English text of the fire message (kept for callers / logs). */
  _fireMessage(inst, nowMs) { return en(this._fireSpec(inst, nowMs)); }

  /** i18n spec of the alert text when a rule fires. */
  _fireSpec(inst, nowMs) {
    const cfg = this.getConfig();
    const c = inst.ctx;
    const dur = i18n.dur(nowMs - inst.start);
    const flow = this.flow ? this.flow.values.flow_lph : null;
    const tankRates = (list) => i18n.list((list || []).map(t => `${shortTankName(t.name, t.id)} ${fmtLph(t.rate_lph)} L/h`));
    switch (inst.rule) {
      case 'valve_no_flow':
        return M('flow_watch.fire.valve_no_flow', { label: this._zoneLabel(c), flow: fmtLph(flow), dur, expected: fmtLph(c.expected) });
      case 'low_flow':
        return M('flow_watch.fire.low_flow', { label: this._zoneLabel(c), flow: fmtLph(flow), pct: String(Math.round((flow / c.expected) * 100)), expected: fmtLph(c.expected), dur });
      case 'flow_above_expected': {
        const a = c.above || {};
        const pct = a.base ? Math.round(((a.mean - a.base) / a.base) * 1000) / 10 : null;
        return M('flow_watch.fire.flow_above_expected', {
          label: this._zoneLabel(c), mean: fmtLph(a.mean), window: String(cfg.above_expected_window_seconds), base: fmtLph(a.base),
          pct: String(pct), limit: String(a.pct), basis: a.basisSpec || (a.basis !== undefined ? String(a.basis) : 'undefined'), dur,
        });
      }
      case 'dosing_without_water':
        return M('flow_watch.fire.dosing_without_water', { tanks: tankRates(c.dosing.active), flow: fmtLph(flow), max: fmtLph(cfg.dosing_max_flow_lph), dur, extra: null });
      case 'water_without_valve':
        if (c.panel) {
          const p = c.panel;
          const sum = this._panelSummary(p);
          return M('flow_watch.fire.water_without_valve_panel', {
            why: this._panelWhy(p, nowMs), flow: fmtLph(flow), start: fmtHm(p.startMs), water: sum.water, tanks: sum.tanks, ratio: sum.ratio ? ` (1:${sum.ratio})` : '',
          });
        }
        return M('flow_watch.fire.water_without_valve', { flow: fmtLph(flow), dur, equipment: c.eqName });
      case 'manual_panel':
        return M('flow_watch.fire.manual_panel', { flow: fmtLph(c.startFlow ?? flow), start: fmtHm(inst.start), hint: this._panelZoneHint(c), extra: null });
      case 'flow_after_pump_off':
        return M('flow_watch.fire.flow_after_pump_off', { flow: fmtLph(flow), dur, equipment: c.eqName, channel: String(c.pumpChannel) });
      case 'monitor_blind': {
        const w = c.why || {};
        const why = w.kind === 'unhealthy'
          ? M('flow_watch.blind.unhealthy', { signal: String(w.signal ?? '?'), flags: String(w.errorFlags ?? '?'), dur: i18n.dur(w.forMs) })
          : M('flow_watch.blind.no_data', { dur: i18n.dur(w.forMs || 0) });
        return M('flow_watch.fire.monitor_blind', { why });
      }
      default:
        return M('flow_watch.fire.generic', { rule: `${inst.rule}` });
    }
  }

  /**
   * Alert text when a fired rule ends: { message (English), severity, messageKey, messageParams, spec }
   * — ready for updateOpenAlert().
   */
  _endMessage(inst, nowMs) {
    const c = inst.ctx;
    const endAt = inst.falseSince || nowMs;
    const dur = i18n.dur(endAt - inst.start);
    const endFlow = c.endFlow;
    const recovered = inst.falseReason === 'recovered';
    let severity = recovered ? 'info' : RULES[inst.rule].severity;
    let spec;
    const label = this._zoneLabel(c);
    switch (inst.rule) {
      case 'valve_no_flow':
        spec = recovered
          ? M('flow_watch.end.valve_no_flow_recovered', { label, dur, flow: fmtLph(endFlow), expected: fmtLph(c.expected) })
          : M('flow_watch.end.valve_no_flow', { label, dur, min: fmtLph(inst.minFlow), expected: fmtLph(c.expected), time: fmtClock(endAt) });
        break;
      case 'low_flow':
        if (recovered) spec = M('flow_watch.end.low_flow_recovered', { label, flow: fmtLph(endFlow), dur });
        else if (inst.falseReason === 'escalated') { spec = M('flow_watch.end.low_flow_escalated', { label, dur }); severity = 'warning'; }
        else spec = M('flow_watch.end.low_flow', { label, dur, min: fmtLph(inst.minFlow), expected: fmtLph(c.expected), time: fmtClock(endAt) });
        break;
      case 'flow_above_expected': {
        const a = c.above || {};
        spec = recovered
          ? M('flow_watch.end.flow_above_expected_recovered', { label, pct: String(a.pct), dur })
          : M('flow_watch.end.flow_above_expected', {
            label, dur, max: fmtLph(inst.maxFlow), time: fmtClock(endAt),
            baseline: a.base ? M('flow_watch.end.baseline', { base: fmtLph(a.base) }) : M('flow_watch.end.no_baseline'),
          });
        break;
      }
      case 'dosing_without_water': {
        const litres = this._litresDosed(c);
        const lit = litres === null ? null : M('flow_watch.end.litres', { litres: litres.toFixed(2) });
        const tanks = i18n.list(((c.firedTanks || (c.dosing && c.dosing.active)) || []).map(t => `${shortTankName(t.name, t.id)} ${fmtLph(t.rate_lph)} L/h`));
        const outcome = c.abort ? c.abort.outcome : null;
        const how = outcome === 'aborted'
          ? (c.abort.body ? M('flow_watch.end.how_aborted_detail', { body: c.abort.body })
            : c.abort.text ? `dosing stopped automatically —${c.abort.text.replace(/^ Dosing stopped automatically:/, '').replace(/\.$/, '')}`
              : M('flow_watch.end.how_aborted_plain'))
          : outcome === 'pending' ? M('flow_watch.end.how_pending')
            : outcome === 'failed' ? M('flow_watch.end.how_failed')
              : M('flow_watch.end.how_stopped');
        if (recovered) {
          spec = M('flow_watch.end.dosing_recovered', {
            tanks, dur, flow: fmtLph(endFlow), aborted: outcome === 'aborted' ? M('flow_watch.end.dosing_had_been_stopped') : null, litres: lit,
          });
        } else {
          spec = M('flow_watch.end.dosing', { tanks, dur, how, litres: lit });
          // an automatic stop (or a failed one) stays an alarm; a cycle that simply ended is a caution
          severity = outcome === 'aborted' || outcome === 'failed' || outcome === 'pending' ? 'critical' : 'warning';
        }
        break;
      }
      case 'water_without_valve':
        if (c.panel) {
          const p = c.panel;
          const sum = this._panelSummary(p);
          spec = M('flow_watch.end.panel_attention', {
            time: fmtClock(endAt), dur: i18n.dur(endAt - p.startMs), water: sum.water, tanks: sum.tanks, ratio: sum.ratio ? ` (1:${sum.ratio})` : '',
            why: this._panelWhy(p, (p.escalated && p.escalated.at) || endAt),
          });
          severity = 'warning';
          break;
        }
        spec = recovered
          ? M('flow_watch.end.water_without_valve_recovered', { dur })
          : M('flow_watch.end.water_without_valve', { dur, time: fmtClock(endAt), max: fmtLph(inst.maxFlow) });
        if (!recovered) severity = 'info';
        break;
      case 'manual_panel': {
        const sum = this._panelSummary(c);
        const endAt = this._panelEndAt(inst, inst.falseSince || nowMs);
        spec = M('flow_watch.end.manual_panel', {
          start: fmtHm(inst.start), end: fmtHm(endAt), dur: i18n.dur(endAt - inst.start), water: sum.water, tanks: sum.tanks,
          ratio: sum.ratio ? ` (1:${sum.ratio})` : '',
          taken: inst.falseReason === 'ended' ? M('flow_watch.end.relays_took_over') : null,
          escalated: c.escalated ? M('flow_watch.panel.escalated', { why: this._panelWhy(c, c.escalated.at) }) : null,
        });
        severity = 'info';
        break;
      }
      case 'flow_after_pump_off':
        spec = recovered
          ? M('flow_watch.end.flow_after_pump_off_recovered', { dur })
          : M('flow_watch.end.flow_after_pump_off', { dur, time: fmtClock(endAt), max: fmtLph(inst.maxFlow) });
        if (!recovered) severity = 'info';
        break;
      case 'monitor_blind':
        spec = recovered
          ? M('flow_watch.end.monitor_blind_recovered', { dur })
          : M('flow_watch.end.monitor_blind', { dur });
        if (!recovered) severity = 'warning';
        break;
      default:
        spec = M('flow_watch.end.generic', { rule: `${inst.rule}`, dur });
    }
    return { message: en(spec), severity, ...keyArgs(spec), spec };
  }

  _alertEquipmentId(inst) {
    const cfg = this.getConfig();
    if (inst.rule === 'dosing_without_water') return cfg.dosing_equipment_id;
    if (inst.rule === 'monitor_blind') return inst.ctx.monitorEquipmentId || null;
    return cfg.irrigation_equipment_id;
  }

  _onFire(inst, nowMs) {
    if (inst.rule === 'pump_no_flow_shutdown') { this._onPumpNoFlow(inst, nowMs); return; }
    const cfg = this.getConfig();
    const def = RULES[inst.rule];
    let spec = this._fireSpec(inst, nowMs);
    let abortPlanned = false;
    if (inst.rule === 'dosing_without_water') {
      const d = inst.ctx.dosing;
      inst.ctx.firedTanks = d.active;
      if (!cfg.abort_dosing_on_no_water) {
        spec = withExtra(spec, M('flow_watch.dosing.stop_disabled'));
        inst.ctx.abort = { outcome: 'disabled' };
      } else if (d.cycle && !d.cycle.dryRun && this.doseScheduler) {
        spec = withExtra(spec, M('flow_watch.dosing.stop_pending', { cycle: cycleRef(d.cycle.cycleLogId) }));
        abortPlanned = true;
        inst.ctx.abort = { outcome: 'pending' };
      } else {
        spec = withExtra(spec, M('flow_watch.dosing.not_running'));
        inst.ctx.abort = { outcome: 'not_running' };
      }
    }
    const message = en(spec);
    inst.message = message;
    inst.msg = spec;
    const row = this._createAlert({
      severity: def.severity,
      source: 'flow_watch',
      equipment_id: this._alertEquipmentId(inst),
      fingerprint: this._fingerprint(inst),
      ...keyArgs(spec),
      metadata: { rule: inst.rule, key: inst.key },
    });
    inst.alertId = row && row.id ? row.id : null;
    this.log.warn(`[FlowWatch] ${def.level.toUpperCase()} ${inst.key}: ${message}`);
    this._openEpisode(inst, nowMs);
    if (abortPlanned) this._track(this._abortDosing(inst));
    else if (def.severity === 'critical') this._sendNotify(TITLES[inst.rule], spec, def.severity);
  }

  /** Abort the running dose cycle via the scheduler's existing abort path, then report the outcome. */
  async _abortDosing(inst) {
    const def = RULES[inst.rule];
    const cycle = inst.ctx.dosing.cycle || {};
    const tanks = (cycle.schedule && cycle.schedule.tanks) || [];
    let outcome;
    let text;
    let textSpec;
    let body = null;
    try {
      const before = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM relay_events').get().id;
      const aborted = await this.doseScheduler.abortCycle('flow_watch: dosing without water flow', { source: 'flow_watch' });
      if (!aborted) {
        outcome = 'not_running';
        textSpec = M('flow_watch.abort.already_ended');
      } else {
        const closed = new Set(this.db.prepare(
          "SELECT equipment_id, channel FROM relay_events WHERE id > ? AND source = 'flow_watch' AND state = 0"
        ).all(before).map(r => `${r.equipment_id}:${r.channel}`));
        const missing = tanks.filter(t => !closed.has(`${t.equipment_id}:${t.channel}`));
        const names = tanks.map(t => shortTankName(t.tank_name, t.tank_id)).join(', ');
        outcome = 'aborted';
        body = missing.length === 0
          ? M('flow_watch.abort.closed_body', { cycle: cycleRef(cycle.cycleLogId), tanks: names ? i18n.list(tanks.map(t => shortTankName(t.tank_name, t.tank_id))) : M('flow_watch.abort.none_open') })
          : M('flow_watch.abort.missing_body', { cycle: cycleRef(cycle.cycleLogId), tanks: i18n.list(missing.map(t => shortTankName(t.tank_name, t.tank_id))) });
        textSpec = M('flow_watch.abort.stopped', { body });
      }
    } catch (e) {
      outcome = 'failed';
      textSpec = M('flow_watch.abort.failed', { error: e.message });
    }
    text = ` ${en(textSpec)}`;
    inst.ctx.abort = { outcome, text, spec: textSpec, body };
    // the fire message with the outcome in place of "Stopping dosing automatically…"
    inst.msg = withExtra(inst.msg || this._fireSpec(inst, inst.firedAt || this.now()), textSpec);
    inst.message = en(inst.msg);
    if (inst.ended) {
      // The condition already ended while the abort was in flight: the alert
      // carries the end summary, rebuilt now that the outcome is known.
      this._updateOpenAlert(this._fingerprint(inst), this._endMessage(inst, inst.endedAt));
    } else {
      this._updateOpenAlert(this._fingerprint(inst), { ...keyArgs(inst.msg), severity: def.severity });
    }
    if (inst.episodeId) {
      try {
        this.db.prepare("UPDATE irrigation_flow_episodes SET dosing_aborted = ?, updated_at = ? WHERE id = ?")
          .run(outcome === 'aborted' ? 1 : 0, iso(this.now()), inst.episodeId);
      } catch (_) { /* best-effort */ }
    }
    this.log.warn(`[FlowWatch] dosing abort outcome: ${outcome}`);
    this._sendNotify(TITLES[inst.rule], inst.msg, def.severity);
  }

  _onEnd(inst, nowMs) {
    if (inst.rule === 'pump_no_flow_shutdown') return; // its alert/episode are owned by the guard
    const cfg = this.getConfig();
    const def = RULES[inst.rule];
    const endAt = inst.rule === 'manual_panel' ? this._panelEndAt(inst, inst.falseSince || nowMs) : (inst.falseSince || nowMs);
    inst.ended = true;
    inst.endedAt = nowMs;
    if (inst.fired) {
      const end = this._endMessage(inst, nowMs);
      const { message, severity } = end;
      this._updateOpenAlert(this._fingerprint(inst), end);
      this.log.log(`[FlowWatch] ended ${inst.key} (${inst.falseReason}): ${message}`);
      if (def.severity === 'critical') {
        const title = inst.falseReason === 'recovered'
          ? M('flow_watch.title.resolved', { title: TITLES[inst.rule] })
          : M('flow_watch.title.ended', { title: TITLES[inst.rule] });
        this._sendNotify(title, end.spec, severity);
      }
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
    if (inst.rule === 'manual_panel') {
      const c = inst.ctx;
      detail.water_l = c.waterL !== undefined ? Math.round(c.waterL * 10) / 10 : null;
      detail.tanks = this._panelDosed(c).map(d => ({ id: d.id, name: d.name, litres: Math.round(d.litres * 100) / 100 }));
      detail.escalated = c.escalated ? { kind: c.escalated.kind, at: iso(c.escalated.at) } : null;
      detail.start_flow_lph = round(c.startFlow);
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

  /**
   * Telegram. `title` / `text` are i18n specs (or English strings). The default path
   * renders them in the configured telegram_language; an injected deps.notify (tests)
   * receives the English render plus { titleSpec, bodySpec }.
   */
  _sendNotify(title, text, severity) {
    const cfg = this.getConfig();
    if (!cfg.telegram) return;
    // Legacy Telegram Markdown chokes on _ * [ ` in free text.
    const clean = (s) => String(s).replace(/[_*`[\]]/g, ' ');
    const fn = this._notify;
    if (fn) {
      this._track(Promise.resolve().then(() => fn(clean(en(title)), clean(en(text)), severity, { titleSpec: title, bodySpec: text })));
      return;
    }
    this._track(Promise.resolve().then(async () => {
      const { telegramService } = require('./TelegramService');
      if (!telegramService.isConfigured()) return;
      const lang = typeof telegramService.getLanguage === 'function' ? telegramService.getLanguage() : 'en';
      await telegramService.sendAlert(clean(i18n.render(lang, title)), clean(i18n.render(lang, text)), severity);
    }));
  }

  // ─── read API ─────────────────────────────────────────────────────────────

  /**
   * @param {number} [nowMs]
   * @param {{lang?: 'en'|'tr'|'ar'}} [opts]  language of active[].message / relays.reason (default English);
   *        active[] also carries message_en / message_key / message_params.
   */
  getStatus(nowMs = this.now(), { lang = 'en' } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) return { enabled: false, state: 'disabled', evaluated_at: iso(nowMs), active: [], last_episode: this.lastEpisode(), last_shutdown: this.lastShutdown(), run_guard: this.guardStatus(), config: cfg };
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
      message: i.fired ? (i.msg ? i18n.render(lang, i.msg) : i.message) : null,
      message_en: i.fired ? i.message : null,
      message_key: i.fired && i.msg ? i.msg.$k : null,
      message_params: i.fired && i.msg ? i.msg.$p || {} : null,
    }));
    let state;
    const g = this.guard;
    if (g && GUARD_RETRY.has(g.phase)) state = 'alarm';
    else if (active.some(a => a.fired && a.level === 'alarm')) state = 'alarm';
    else if (active.some(a => a.fired && a.level === 'caution')) state = 'caution';
    else if (active.some(a => a.fired && a.level === 'info')) state = 'manual';
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
        reason: relays.known ? null : (relays.reasonSpec ? i18n.render(lang, relays.reasonSpec) : relays.reason),
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
      // pump no-flow protection: the run being acted on (retry pause / restart) and the latest outcome
      run_guard: this.guardStatus(),
      last_shutdown: this.lastShutdown(),
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
/** The singleton only if it was already created (never builds one — for the stop-all hook). */
function peekFlowWatchService() {
  return singleton;
}

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
  peekFlowWatchService,
  defaultActuator,
  validateConfigUpdate,
  DEFAULT_CONFIG,
  RULES,
  CONFIG_KEY,
  BASELINE_KEY,
};
