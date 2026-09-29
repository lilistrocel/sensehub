'use strict';
/**
 * DoseController — closed-loop fertigation dosing (requirement 2026-09-26).
 *
 * WHY: the five dosing valves on "Waveshare Irrigation 2" feed venturis whose
 * draw is hydraulically COUPLED (shared suction: closing one valve raises the
 * others' rates) and varies run to run (09:30: A-D 1.68/1.42/1.51/1.54 L/min,
 * 1:87-103; 11:30/12:30: ~1.07/1.10/1.10/0.85 L/min, 1:135-174). Water flow,
 * venturis and needle valves cannot be adjusted, so an open-loop duty cannot
 * hold a ratio. This controller doses by MEASURED volumes instead.
 *
 * PLANT (operator, 2026-09-26): water + venturi concentrate (+ acid) enter a
 * small 20-50 L flow-through buffer/mixing tank, which is pushed straight on to
 * the zone valves (mixing pump eq 1 ch2, irrigation pump eq 1 ch1). The flow
 * meter measures the irrigation outflow; the SEKO pH/EC probes (eq 17) sit in a
 * small cup on the buffer tank's outlet. Mixing tau ~ 8-20 s (default 15 s) plus
 * a short transport delay (~10 s). Nothing circulates between runs: idle pH/EC
 * readings are stagnant cup liquid and are never used (or alerted on). The ~5
 * min settling in the 12:30 data is the dosing ramp (venturi draw building up)
 * seen through 30 s samples, not tank lag.
 *
 * NUTRIENTS (tanks with a ratio, i.e. A-D): per cycle, W(t) = water since the
 * cycle started (flowmeter accumulator high-water delta, fallback: integrated
 * flow_lph) and V_i(t) = concentrate drawn (reset-safe consumed_l deltas, 0.25 L
 * counter). Every eval_s:
 *     target_i = W(t + L) / ratio_i            (L = lookahead_s, current flow)
 *     error_i  = target_i - V_i(t) - rate_i * L (rate only while open)
 *     open if error_i > +deadband_l, close if < -deadband_l, min on / min off.
 * All nutrient valves open once water is established (>= min_flow_pct of the
 * expected flow). Coupling is handled implicitly (only measured volumes are
 * used). Hard limits: close when V_i > max_overdose_factor x target_i +
 * overdose_margin_l; never open below min_flow_pct; water stopped for
 * no_water_s -> close all at once (checked on every 0.5 s flow sample; the
 * debounce rides out the ~3 s dip at each zone switch-over). Monitor blind
 * (flow/dosing data older than stale_s, or meter unhealthy) -> the program's
 * fixed schedule for as long as it lasts (plants still get fed; caution alert),
 * then back to closed loop.
 *
 * pH (the pH Down tank, role 'ph_down', not metered): runs only while water
 * flows (>= min_flow_pct), not disarmed, >= start_delay_s after water was
 * established (the fresh-water flush of the stale cup liquid is ignored, also
 * for the integral) and not in the last stop_before_end_s. One decision per
 * window_s on the latest valid sample:
 *     e = pH - setpoint; e = 0 inside +/-deadband
 *     I += ki * e * window_s (clamped [0, max_duty]; frozen while saturated)
 *     duty = clamp(kp * e + I, 0, max_duty); pulse = duty * window_s at window
 *     start, dropped below min_pulse_s, capped by the per-cycle and daily acid
 *     budgets. With tau + dead time ~25 s the next decision sees ~75 % of the
 *     previous pulse's effect: a sampled PI that is stable for a 2x gain error.
 * Limits: pH < floor_ph -> acid off for the rest of the cycle + alarm; sample
 * stale (> stale_s), implausible (outside plausible_min..max) or frozen
 * (identical for frozen_s while water flows) -> acid off + caution; per-cycle
 * and daily open-second caps; hard max-on guard per pulse. Acid volume is an
 * ESTIMATE (acid_lpm_estimate, unverified).
 *
 * PER-ZONE PRECISION (operator approval 2026-09-28, run 10 at 07:30: 1:200,
 * 3 min zones, ~2.2 L per tank per zone, zones at 1:219 / 1:195 / 1:199):
 *  - substep_estimate: the 0.25 L counter is interpolated between steps by the
 *    monitor's rate_lph (smoothed, tau 2 s) — only while the valve is commanded
 *    OPEN and water moves (the monitor holds its last rate 20-50 s after a valve
 *    closes). Each new step re-anchors the estimate (at the midpoint of the 1 s
 *    report gap); the sub-step part is clamped to [0, 0.25 + 0.02] L. The phase of
 *    the counter at the cycle start (or after a counter reset / glitch) is unknown:
 *    the first step then re-bases the estimate without a jump, so zone differences
 *    stay exact. Rate stale/absent -> the zone's (then the run's) measured
 *    step-to-step rate (scaled by the motive flow) -> plain steps. Per-zone close
 *    checks run on every 1 s tick (close when est >= target - rate x latency_s).
 *    A counter re-base with no rate before it is back-filled from the measured
 *    step rate x flowing time (<= one step). Records keep the
 *    counter litres (dosed_l, ground truth) and the estimate (dosed_est_l).
 *  - open_at_pump_start: in soft-switch zones (the zone's pump starts after its
 *    valve) the nutrient valves open when the pump ON write is confirmed by
 *    read-back (relay_events), with the zone valve confirmed ON, in closed loop,
 *    not disarmed / paused. The zone target then assumes the planned pump time x
 *    the last measured (else expected) flow. The water gate is re-based on the
 *    pump start: no flow >= min_flow_pct within no_water_s -> all nutrient valves
 *    closed (trip 'pump_start_no_water'); the flow watch (dosing_without_water,
 *    pump_no_flow_shutdown + retry) stays the backstop. Continuous-pump runs keep
 *    opening once the flow registers.
 *  - stats.flush_seconds: SEKO samples in the first 40 s after the run's first
 *    pump start are reported as flush_* and kept out of the zone averages.
 *
 * TANK NOT DRAWING (requirement 2026-09-29, incident run 17 at 07:30: Tank D's valve open
 * 709 s with water, counter never moved, recorded only as 'cant_reach'; Tank B zone 3,
 * 4x: 0 L until its valve was closed and re-opened) — _drawWatch, every 1 s tick:
 *  - per metered nutrient tank: open + flowing time (closed loop, water >= min_flow_pct,
 *    monitor fresh, read-back not contradicting OPEN) since its last draw (a 0.25 L step,
 *    or rate >= 5 L/h while open);
 *  - automatic second try (nutrients.redraw_retry): >= redraw_retry_after_s of that in
 *    the current zone while another open tank draws -> close (source dose_controller_retry),
 *    min_off_s closed, re-open through the same guarded ON path; drew within
 *    redraw_verify_s -> note in the run record. One per tank per zone; never acid; not
 *    when disarmed / paused / without water / < redraw_min_zone_left_s of flow left;
 *  - >= not_drawing_seconds and another tank drew meanwhile -> ALARM (critical, one row
 *    per tank per run, Telegram), resolved when it draws again; no tank drawing at all ->
 *    ONE caution (monitor / venturi manifold); a tank at 0 L for the whole run -> summary.
 *
 * ACTUATION: every write goes through the scheduler's guarded path
 * (FertigationDoseScheduler._writeValve: guardEnergise/validateWriteSet on ON,
 * RelayEventLogger with source 'dose_controller' / 'ph_controller'). No ON write
 * while disarmed (checked here and again right before the coil write); disarm
 * holds every dosing valve closed. The end of the cycle (and any abort: flow
 * watch, stop-all, write failure) closes every dosing valve, acid included,
 * through the scheduler's existing end/abort path.
 */

const zoneStats = require('./DoseRunZoneStats');

const CONFIG_KEY = 'dose_controller';
const TICK_MS = 1000;
const CHECKPOINT_MS = 15000;
const PH_READ_GAP_MS = 900;
const RELAY_READ_GAP_MS = 5000;
const END_WAIT_MS = 20000;
const DAY_BASE_CACHE_MS = 60000;
const MAX_TRIPS = 50;
const DEFAULT_EXPECTED_FLOW_LPH = 8820;
const DRY_EVIDENCE_MS = 30000;
const ZONE_READ_GAP_MS = 1000;
const ZONE_TARGET = 'zone target reached';
const PULSE_OVERRUN_TOLERANCE_MS = 1000; // a later OFF than this is charged to the acid budget
// Sub-step volume estimate (nutrients.substep_estimate)
const COUNTER_STEP_L = 0.25;       // resolution of the monitor's consumed_l counters
const EST_MARGIN_L = 0.02;         // the sub-step part never exceeds one step + this
const EST_RATE_TAU_S = 2;          // light smoothing of the monitor's rate_lph
const EST_MOTIVE_FRACTION = 0.25;  // venturis draw only with water moving: integrate only while flow >= 25 % of expected
const EST_AVG_MIN_S = 5;           // a measured step rate needs >= 5 s of clean (open + flowing) step-to-step time
const PUMP_START_MAX_AGE_MS = 15000; // a pump ON event first seen later than this is not a "pump start"
// Tank not-drawing watch (incident 2026-09-29 07:30: Tank D open 709 s, counter never moved)
const DRAW_RATE_MIN_LPH = 5;       // a drawing venturi reads ~40-100 L/h; a dry / blocked tank reads 0.0
const DRAWING_RECENT_MS = 15000;   // "is drawing now": a counter step within 15 s (one 0.25 L step at ~60 L/h) or rate >= 5 L/h
const MAX_NOT_DRAWING_NOTIFY = 3;  // Telegram messages per tank per run (the alert row is one per tank per run)

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  nutrients: Object.freeze({
    // 'per_zone_target' (default, operator 2026-09-26): each tank opens once per zone and
    // closes when its zone litre target is reached (coupled suction: fewer switches).
    // 'tracking': continuous open/close tracking of W/ratio (kept, tested).
    mode: 'per_zone_target',
    ratio: Object.freeze({ 1: 150, 2: 150, 3: 150, 4: 150 }), // 1:150 = 6.67 L concentrate per m3
    irrigation_equipment_id: 1,  // zone relays (segments come from their relay events)
    zone_channels: Object.freeze([3, 4, 5, 6]),
    pump_channel: 1,             // irrigation pump on the same board: its planned ON window bounds each zone's flow
    slots_per_zone: 1,           // 2 = two half-zone targets (evens out weak feeds, e.g. 1:250)
    latency_s: 1.5,              // close when dosed >= target - rate x latency
    reopen_margin_l: 0.5,        // reopen a target-closed tank only if its target grew by more
    max_reopens_per_zone: 1,
    carry_clamp_pct: 50,         // shortfall/excess carried to the next zone, clamped to +/- % of a zone target
    flow_smooth_s: 5,
    deadband_l: 0.25,
    min_on_s: 10,
    min_off_s: 10,
    lookahead_s: 10,
    eval_s: 2,
    stale_s: 10,
    start_grace_s: 20,          // monitor may still be on its 10 s idle cadence at pump start
    min_flow_pct: 50,
    no_water_s: 5,
    expected_flow_lph: null,    // null = relay_channel_config zone flow (146.99 L/min), else 8,820
    min_signal_quality: 60,
    max_overdose_factor: 1.3,
    overdose_margin_l: 0.5,
    limited_after_s: 60,
    stop_before_end_s: 0,
    leak_l: 0.75,
    leak_after_s: 15,
    // Sub-step volume estimate (operator approval 2026-09-28, run 10 at 07:30: the
    // 0.25 L counter alone swung each ~2.2 L zone dose by +/-10 %): between two
    // counter steps each tank's litres are the last step + the integral of the
    // monitor's rate_lph while its valve is commanded OPEN and water moves
    // (fallback: the zone's / run's measured step rate, then plain steps). Used for
    // the per-zone close decision and the carry; the counter stays the recorded
    // ground truth (dosed_l; the estimate is dosed_est_l). false = the previous
    // behaviour (rate interpolation capped at 0.24 L since the last step).
    substep_estimate: true,
    // Soft-switch runs (a zone's pump starts after its valve): open the nutrient
    // valves the moment the zone's pump ON write is confirmed (relay_events
    // read-back) instead of waiting for the flow to register. The water gate still
    // closes them when the flow is not >= min_flow_pct within no_water_s of that
    // pump start. false = open only once the flow registers (previous behaviour).
    open_at_pump_start: true,
    // Water basis of the hard overdose cap (V > max_overdose_factor x W / ratio + overdose_margin_l):
    // 'delivered'     = water delivered so far (operator decision 2026-09-28: kept for now)
    // 'zone_expected' = (per-zone mode) water the cycle will have at the end of the CURRENT zone at
    //                   the measured flow — avoids the false trip ~66 s into zone 1 at high draw
    //                   (runs 1 + 3: "Tank B: 1.5 L dosed vs 0.73 L target"). Not enabled.
    overdose_basis: 'delivered',
    // Tank not-drawing alarm (incident 2026-09-29 07:30, Tank D): a nutrient valve commanded
    // OPEN (read-back not contradicting) with water >= min_flow_pct for not_drawing_seconds
    // (open + flowing time, accumulated until the tank draws) with no 0.25 L counter step and
    // rate ~0, while ANOTHER tank drew during that time (proves the monitor + water) -> ALARM
    // per tank per run (+ Telegram). No tank drawing at all -> ONE caution (monitor / venturi
    // manifold). Resolved when the tank draws again. A tank that delivered 0 L over a whole run
    // gets a run-summary alert.
    not_drawing_alarm: true,
    not_drawing_seconds: 60,
    not_drawing_telegram: true,
    // Automatic second try (incident Tank B zone 3, 2026-09-26/28: closing and re-opening the
    // valve made it draw at once): open + flowing redraw_retry_after_s in this zone with no draw
    // while another open tank draws -> close (source dose_controller_retry), wait min_off_s,
    // re-open through the guarded ON path; drawing within redraw_verify_s = recovered (run note).
    // At most one retry per tank per zone; never the acid tank; skipped when disarmed, paused,
    // without water, or with < redraw_min_zone_left_s of the zone's flow left.
    redraw_retry: true,
    redraw_retry_after_s: 20,
    redraw_verify_s: 20,
    redraw_min_zone_left_s: 25,
    // Optional slow outer loop (OFF): scale all ratios together, once per cycle,
    // from the previous run's feed EC toward target_us. Bounded 1:min..1:max.
    ec_trim: Object.freeze({
      enabled: false,
      target_us: 1700,
      water_us: 250,            // EC of the raw water (the part nutrients do not change)
      gain: 0.5,                // fraction of the log-correction applied per cycle
      max_step_pct: 15,
      min_ratio: 100,
      max_ratio: 250,
      min_samples: 5,
    }),
  }),
  // Feed-EC range cross-check for the SEKO auto-ranging EC register (ModbusAutoRange
  // hint): while >= 2 metered tanks dose at 1:min..1:max with water flowing, feed EC
  // must exceed fertilised_min_us; with water and no dosing for window_s, prefer the
  // reading closest to raw_water_ec_us (null until measured -> continuity only).
  ec_check: Object.freeze({
    enabled: true,
    window_s: 60,
    fertilised_min_us: 1000,
    min_ratio: 80,
    max_ratio: 250,
    raw_water_ec_us: null,
  }),
  ph: Object.freeze({
    enabled: true,
    setpoint: 5.65,
    deadband: 0.10,
    window_s: 30,
    min_pulse_s: 3,
    max_duty: 0.40,
    kp: 0.2,                    // duty per pH unit (tuned on a 15 s buffer + 10 s dead time, acid gain 1-3 pH/100 %)
    ki: 0.003,                  // duty per pH unit per second
    max_acid_s_per_cycle: 60,
    max_acid_s_per_day: 420,
    floor_ph: 5.30,
    floor_confirm_samples: 2,   // consecutive samples < floor that latch (1 = single sample); any < floor closes acid at once
    stale_s: 60,
    frozen_s: 180,
    plausible_min: 3,
    plausible_max: 9,
    start_delay_s: 45,
    stop_before_end_s: 30,
    sensor_equipment_id: 17,
    sensor_metric: 'pH',
    ec_metric: 'Water EC',      // recorded per run (µS/cm), not used for pH control
    sample_interval_s: 10,      // SEKO poll while a cycle runs (normally 30 s)
    sample_timeout_ms: 1500,    // bounds how long one SEKO read can hold the shared bus
    acid_lpm_estimate: 1.7,     // UNVERIFIED — acid is not metered
    tau_s: 15,                  // plant model (documentation / window sanity check)
    dead_time_s: 10,
  }),
  // Per-zone feed EC/pH statistics (DoseRunZoneStats).
  stats: Object.freeze({
    // SEKO samples in the first flush_seconds after the run's FIRST pump start are the
    // stale liquid in the lines, the 20-50 L buffer tank and the sensor cup: kept out of
    // the zone EC/pH averages and reported separately (flush_*). 0 = off.
    flush_seconds: 40,
  }),
});

// ─── config validation ──────────────────────────────────────────────────────

const NUM = (min, max) => ({ t: 'num', min, max });
const SCHEMA = {
  enabled: { t: 'bool' },
  nutrients: {
    t: 'obj',
    fields: {
      mode: { t: 'enum', values: ['per_zone_target', 'tracking'] },
      irrigation_equipment_id: { t: 'int', min: 1, max: 1e9 },
      zone_channels: { t: 'channels' },
      pump_channel: { t: 'int', min: 1, max: 64 },
      slots_per_zone: { t: 'int', min: 1, max: 4 },
      latency_s: NUM(0, 10),
      reopen_margin_l: NUM(0.1, 10),
      max_reopens_per_zone: { t: 'int', min: 0, max: 5 },
      carry_clamp_pct: NUM(0, 100),
      flow_smooth_s: NUM(0.5, 30),
      ratio: { t: 'ratio' },
      deadband_l: NUM(0.05, 5),
      min_on_s: NUM(3, 300),
      min_off_s: NUM(3, 300),
      lookahead_s: NUM(0, 60),
      eval_s: NUM(0.5, 30),
      stale_s: NUM(3, 120),
      start_grace_s: NUM(0, 300),
      min_flow_pct: NUM(10, 95),
      no_water_s: NUM(0, 60),
      expected_flow_lph: { t: 'nnum', min: 100, max: 100000 },
      min_signal_quality: NUM(0, 100),
      max_overdose_factor: NUM(1, 3),
      overdose_margin_l: NUM(0, 10),
      limited_after_s: NUM(10, 900),
      stop_before_end_s: NUM(0, 600),
      leak_l: NUM(0.25, 20),
      leak_after_s: NUM(5, 300),
      substep_estimate: { t: 'bool' },
      open_at_pump_start: { t: 'bool' },
      overdose_basis: { t: 'enum', values: ['delivered', 'zone_expected'] },
      not_drawing_alarm: { t: 'bool' },
      not_drawing_seconds: NUM(20, 300),
      not_drawing_telegram: { t: 'bool' },
      redraw_retry: { t: 'bool' },
      redraw_retry_after_s: NUM(10, 120),
      redraw_verify_s: NUM(5, 120),
      redraw_min_zone_left_s: NUM(10, 300),
      ec_trim: {
        t: 'obj',
        fields: {
          enabled: { t: 'bool' },
          target_us: NUM(200, 10000),
          water_us: NUM(0, 5000),
          gain: NUM(0, 1),
          max_step_pct: NUM(0, 50),
          min_ratio: NUM(20, 5000),
          max_ratio: NUM(20, 5000),
          min_samples: { t: 'int', min: 1, max: 1000 },
        },
      },
    },
  },
  ec_check: {
    t: 'obj',
    fields: {
      enabled: { t: 'bool' },
      window_s: NUM(20, 600),
      fertilised_min_us: NUM(100, 5000),
      min_ratio: NUM(20, 5000),
      max_ratio: NUM(20, 5000),
      raw_water_ec_us: { t: 'nnum', min: 1, max: 5000 },
    },
  },
  ph: {
    t: 'obj',
    fields: {
      enabled: { t: 'bool' },
      setpoint: NUM(4, 7.5),
      deadband: NUM(0.02, 1),
      window_s: NUM(10, 300),
      min_pulse_s: NUM(1, 60),
      max_duty: NUM(0, 0.6),
      kp: NUM(0, 5),
      ki: NUM(0, 0.1),
      max_acid_s_per_cycle: NUM(0, 600),
      max_acid_s_per_day: NUM(0, 3600),
      floor_ph: NUM(3, 7),
      floor_confirm_samples: { t: 'int', min: 1, max: 5 },
      stale_s: NUM(10, 600),
      frozen_s: NUM(30, 1800),
      plausible_min: NUM(0, 7),
      plausible_max: NUM(7, 14),
      start_delay_s: NUM(0, 600),
      stop_before_end_s: NUM(0, 600),
      sensor_equipment_id: { t: 'int', min: 1, max: 1e9 },
      sensor_metric: { t: 'str' },
      ec_metric: { t: 'str' },
      sample_interval_s: NUM(5, 60),
      sample_timeout_ms: NUM(300, 5000),
      acid_lpm_estimate: NUM(0, 20),
      tau_s: NUM(1, 600),
      dead_time_s: NUM(0, 600),
    },
  },
  stats: {
    t: 'obj',
    fields: {
      flush_seconds: NUM(0, 600),
    },
  },
};

function validateSection(updates, schema, path) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return { error: `${path || 'body'} must be a JSON object` };
  const out = {};
  for (const [k, v] of Object.entries(updates)) {
    const spec = schema[k];
    const name = path ? `${path}.${k}` : k;
    if (!spec) return { error: `unknown setting "${name}"` };
    switch (spec.t) {
      case 'bool':
        if (typeof v !== 'boolean') return { error: `${name} must be true or false` };
        out[k] = v; break;
      case 'num':
        if (typeof v !== 'number' || !Number.isFinite(v) || v < spec.min || v > spec.max) return { error: `${name} must be a number between ${spec.min} and ${spec.max}` };
        out[k] = v; break;
      case 'int':
        if (!Number.isInteger(v) || v < spec.min || v > spec.max) return { error: `${name} must be an integer between ${spec.min} and ${spec.max}` };
        out[k] = v; break;
      case 'nnum':
        if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < spec.min || v > spec.max)) return { error: `${name} must be null or a number between ${spec.min} and ${spec.max}` };
        out[k] = v; break;
      case 'str':
        if (typeof v !== 'string' || !v.trim() || v.length > 64) return { error: `${name} must be a non-empty string` };
        out[k] = v.trim(); break;
      case 'enum':
        if (!spec.values.includes(v)) return { error: `${name} must be one of ${spec.values.join(', ')}` };
        out[k] = v; break;
      case 'channels':
        if (!Array.isArray(v) || v.length === 0 || v.length > 32 || !v.every(ch => Number.isInteger(ch) && ch >= 1 && ch <= 64) || new Set(v).size !== v.length) {
          return { error: `${name} must be a non-empty list of distinct channel numbers 1-64` };
        }
        out[k] = [...v]; break;
      case 'ratio': {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: `${name} must be an object {tank_id: ratio}` };
        const r = {};
        for (const [tid, val] of Object.entries(v)) {
          const id = Number(tid);
          if (!Number.isInteger(id) || id < 1 || id > 1000) return { error: `${name}: "${tid}" is not a tank id` };
          if (val !== null && (typeof val !== 'number' || !Number.isFinite(val) || val < 20 || val > 5000)) {
            return { error: `${name}.${tid} must be null (not ratio-controlled) or a dilution 20-5000 (1:N)` };
          }
          r[id] = val;
        }
        out[k] = r; break;
      }
      case 'obj': {
        const sub = validateSection(v, spec.fields, name);
        if (sub.error) return sub;
        out[k] = sub.value; break;
      }
      default:
        return { error: `unsupported setting "${name}"` };
    }
  }
  return { value: out };
}

function mergeConfig(base, upd) {
  const out = {
    ...base, nutrients: { ...base.nutrients, ratio: { ...base.nutrients.ratio }, ec_trim: { ...base.nutrients.ec_trim } },
    ec_check: { ...base.ec_check }, ph: { ...base.ph }, stats: { ...(base.stats || DEFAULT_CONFIG.stats) },
  };
  if (!upd) return out;
  if (upd.ec_check) Object.assign(out.ec_check, upd.ec_check);
  if (upd.stats) Object.assign(out.stats, upd.stats);
  if (upd.enabled !== undefined) out.enabled = upd.enabled;
  if (upd.nutrients) {
    const { ratio, ec_trim: trim, ...rest } = upd.nutrients;
    Object.assign(out.nutrients, rest);
    if (trim) Object.assign(out.nutrients.ec_trim, trim);
    if (ratio) {
      for (const [k, v] of Object.entries(ratio)) {
        if (v === null) delete out.nutrients.ratio[k];
        else out.nutrients.ratio[k] = v;
      }
    }
  }
  if (upd.ph) Object.assign(out.ph, upd.ph);
  return out;
}

/** Cross-field rules on a merged config. Returns an error string or null. */
function crossCheck(cfg) {
  const p = cfg.ph;
  if (p.floor_ph >= p.setpoint - p.deadband) return `ph.floor_ph (${p.floor_ph}) must be below setpoint - deadband (${(p.setpoint - p.deadband).toFixed(2)})`;
  if (p.plausible_min >= p.floor_ph) return 'ph.plausible_min must be below ph.floor_ph';
  if (p.plausible_max <= p.setpoint) return 'ph.plausible_max must be above ph.setpoint';
  if (p.max_duty > 0 && p.min_pulse_s > p.window_s * p.max_duty) return `ph.min_pulse_s (${p.min_pulse_s}) exceeds window_s x max_duty (${(p.window_s * p.max_duty).toFixed(1)} s): acid could never pulse`;
  if (p.max_acid_s_per_cycle > p.max_acid_s_per_day) return 'ph.max_acid_s_per_cycle must not exceed ph.max_acid_s_per_day';
  const tr = cfg.nutrients.ec_trim;
  if (tr.min_ratio >= tr.max_ratio) return 'nutrients.ec_trim.min_ratio must be below max_ratio';
  if (tr.water_us >= tr.target_us) return 'nutrients.ec_trim.water_us must be below target_us';
  return null;
}

/**
 * EC trim (outer loop, OFF by default): one step per cycle from the previous
 * run's feed EC. Feed EC - water EC is proportional to sum(c_i / ratio_i), so
 * scaling every ratio by s scales the nutrient EC by 1/s:
 *   s = ((ec_prev - water) / (target - water)) ^ gain, limited to +/- max_step_pct,
 *   ratio_i = clamp(prev_ratio_i x s, min_ratio, max_ratio).
 * prevRun: { id, ec_avg, ec_samples, tanks: [{tank_id, ratio_target}] } or null.
 * baseRatios: {tank_id: ratio}. Returns { applied, factor, ratios, from_run, reason }.
 */
function computeEcTrim(prevRun, baseRatios, trim) {
  const out = { applied: false, factor: 1, ratios: { ...baseRatios }, from_run: prevRun ? prevRun.id : null, reason: null };
  if (!trim || !trim.enabled) { out.reason = 'disabled'; return out; }
  if (!prevRun || !(prevRun.ec_avg > 0) || !(prevRun.ec_samples >= trim.min_samples)) { out.reason = 'no previous run with feed EC'; return out; }
  const fert = prevRun.ec_avg - trim.water_us;
  const want = trim.target_us - trim.water_us;
  if (!(fert > 0) || !(want > 0)) { out.reason = 'feed EC not above water EC'; return out; }
  let s = Math.pow(fert / want, trim.gain);
  const lim = trim.max_step_pct / 100;
  s = clamp(s, 1 - lim, 1 + lim);
  const prevRatios = {};
  for (const t of prevRun.tanks || []) if (t && t.ratio_target > 0) prevRatios[t.tank_id] = t.ratio_target;
  for (const id of Object.keys(baseRatios)) {
    const from = prevRatios[id] || baseRatios[id];
    out.ratios[id] = Math.round(clamp(from * s, trim.min_ratio, trim.max_ratio) * 10) / 10;
  }
  out.applied = true;
  out.factor = Math.round(s * 1000) / 1000;
  out.reason = `previous run #${prevRun.id} feed EC ${Math.round(prevRun.ec_avg)} µS/cm vs target ${trim.target_us}`;
  return out;
}

/** Validate a partial (deep) config update. Returns { value } or { error }. */
function validateConfigUpdate(updates) {
  return validateSection(updates, SCHEMA, '');
}

// ─── helpers ────────────────────────────────────────────────────────────────

const iso = (ms) => (ms === null || ms === undefined || !Number.isFinite(ms) ? null : new Date(ms).toISOString());
const r1 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const r2 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const r3 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
function parseTs(s) {
  if (!s) return null;
  const str = String(s);
  const hasZone = /[zZ]|[+-]\d\d:?\d\d$/.test(str);
  const ms = Date.parse(hasZone ? str : `${str.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : null;
}
function shortName(name, id) {
  if (!name) return `Tank ${id}`;
  return String(name).split(' — ')[0] || String(name);
}
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const MODES = ['closed_loop', 'fallback', 'hold', 'waiting'];

/**
 * Not-drawing watch state of one tank (per run):
 *   accumS      open + flowing seconds since the tank last drew (the alarm clock)
 *   zoneAccumS  the same, counted in the current zone only (the retry clock)
 *   stretchMs   when the current not-drawing stretch started (proof: another tank drew since)
 */
function newNd() {
  return {
    accumS: 0, zoneAccumS: 0, zoneKey: null, stretchMs: null, lastTickMs: null, lastV: null, lastDrawMs: null,
    openFlowS: 0, maxAccumS: 0,
    alarmed: false, alarmOpen: false, alarmAt: null, alarms: 0, notifies: 0, resolvedAt: null,
  };
}

/**
 * Sub-step estimator state of one tank. Absolute estimate A = V + offset + extra:
 *   V       reset-safe counter litres (steps of 0.25 L)
 *   extra   litres integrated since the last step (clamped [0, step + margin])
 *   offset  constant re-base chosen at the first step after an unknown counter
 *           phase (cycle start, reset, glitch) so A never jumps there
 */
function newEst() {
  return {
    offset: 0, extra: 0, lastMs: null, phaseKnown: false, pre: { flowS: 0, blind: true }, backfill: null,
    rSm: null, rMs: null, prevSampleMs: null,
    cleanSinceMs: null, cleanV: null, avg: { v: 0, s: 0 },
    source: null, A0: null,
  };
}

// ─── i18n: alert texts + status reasons (en / tr / ar) ───────────────────────
// The controller keeps its English reason / why / gate strings internally (some
// are compared: ZONE_TARGET, closedBy). Alerts are built from catalog specs whose
// English render is byte-identical to the historical text; status reasons are
// mapped from the English strings to catalog keys at read time (localizeStatus).
const i18n = require('../i18n');
const { M } = i18n;
const S = (x) => `${x}`; // numbers exactly as template literals printed them

/** Exact English reason / why / gate strings → catalog descriptors. */
const REASON_TEXTS = {
  'controller switched off — fixed schedule': M('dose_controller.reason.switched_off_fixed'),
  'automations disarmed — dosing valves held closed': M('dose_controller.reason.disarmed_hold'),
  'no flowmeter data': M('dose_controller.reason.no_flowmeter'),
  'no dosing data': M('dose_controller.reason.no_dosing_data'),
  'no flow value': M('dose_controller.reason.no_flow_value'),
  'water stopped — nutrient valves closed': M('dose_controller.reason.water_stopped'),
  'waiting for water flow': M('dose_controller.reason.waiting_water_flow'),
  'cycle ended': M('dose_controller.reason.cycle_ended'),
  'backend restarted during the cycle': M('dose_controller.reason.backend_restarted'),
  'flow watch cold restart': M('dose_controller.reason.flow_watch_cold_restart'),
  'floor touched — one window skipped': M('dose_controller.reason.floor_skip'),
  'manual stop': M('dose_controller.reason.manual_stop'),
  'stop-all requested': M('dose_controller.reason.stop_all_requested'),
  'flow_watch: dosing without water flow': M('dose_controller.reason.flow_watch_dosing_no_water'),
  paused: M('dose_controller.why.paused'),
  disarmed: M('dose_controller.why.disarmed'),
  'waiting for monitor': M('dose_controller.why.waiting_monitor'),
  'no water': M('dose_controller.why.no_water'),
  'no water (monitor idle)': M('dose_controller.why.no_water_idle'),
  'waiting for water': M('dose_controller.why.waiting_water'),
  'low flow': M('dose_controller.why.low_flow'),
  'fixed schedule': M('dose_controller.why.fixed_schedule'),
  'fixed schedule (no ratio set)': M('dose_controller.why.fixed_schedule_no_ratio'),
  'cycle start': M('dose_controller.why.cycle_start'),
  'behind target': M('dose_controller.why.behind_target'),
  'target reached': M('dose_controller.why.target_reached'),
  'ahead of target': M('dose_controller.why.ahead_of_target'),
  'end of cycle': M('dose_controller.why.end_of_cycle'),
  'overdose cap': M('dose_controller.why.overdose_cap'),
  'waiting for a zone': M('dose_controller.why.waiting_zone'),
  [ZONE_TARGET]: M('dose_controller.why.zone_target_reached'),
  'filling zone target': M('dose_controller.why.filling_zone_target'),
  'zone target grew': M('dose_controller.why.zone_target_grew'),
  'zone start': M('dose_controller.why.zone_start'),
  'pump start': M('dose_controller.why.pump_start'),
  'redraw retry': M('dose_controller.why.redraw_retry'),
  'no pH Down tank bound to the dosing board': M('dose_controller.gate.no_ph_tank'),
  'controller switched off': M('dose_controller.gate.controller_off'),
  'pH control switched off': M('dose_controller.gate.ph_off'),
  'automations disarmed': M('dose_controller.gate.disarmed'),
  'flow not verifiable': M('dose_controller.gate.flow_not_verifiable'),
  'no water flow': M('dose_controller.gate.no_water_flow'),
  'start delay': M('dose_controller.gate.start_delay'),
  'start delay (cup flush)': M('dose_controller.gate.start_delay_flush'),
  'planned pump stop ahead': M('dose_controller.gate.pump_stop_ahead'),
  'pH sample stale': M('dose_controller.gate.sample_stale'),
  'waiting for a pH sample': M('dose_controller.gate.waiting_sample'),
  'pH below floor': M('dose_controller.gate.below_floor'),
};
const SENSOR_KIND = {
  frozen: M('dose_controller.sensor_kind.frozen'),
  implausible: M('dose_controller.sensor_kind.implausible'),
};
const sensorKind = (k) => SENSOR_KIND[k] || S(k);
/** English reasons with values → descriptors (first match wins; nested reasons recurse). */
const REASON_PATTERNS = [
  [/^dosing paused — (.+)$/s, (m) => M('dose_controller.reason.paused', { detail: reasonSpec(m[1]) })],
  [/^waiting for monitor data \((.+)\)$/s, (m) => M('dose_controller.reason.waiting_monitor', { why: reasonSpec(m[1]) })],
  [/^monitor blind: (.+) — fixed schedule$/s, (m) => M('dose_controller.reason.monitor_blind', { why: reasonSpec(m[1]) })],
  [/^no flowmeter data for (-?\d+) s$/, (m) => M('dose_controller.reason.no_flowmeter_for', { secs: m[1] })],
  [/^flowmeter unhealthy \(signal (.*), flags (.*)\)$/, (m) => M('dose_controller.reason.flowmeter_unhealthy', { signal: m[1], flags: m[2] })],
  [/^no dosing data for (-?\d+) s$/, (m) => M('dose_controller.reason.no_dosing_data_for', { secs: m[1] })],
  [/^closed loop resumed \((.+)\)$/, (m) => M('dose_controller.reason.closed_loop_resumed', { mode: m[1] })],
  [/^no pH sample since the start delay ended (-?\d+) s ago$/, (m) => M('dose_controller.reason.stale_since_delay', { secs: m[1] })],
  [/^last pH sample (-?\d+) s old$/, (m) => M('dose_controller.reason.stale_last_sample', { secs: m[1] })],
  [/^pH (.+) outside (.+)-(.+)$/, (m) => M('dose_controller.reason.implausible', { ph: m[1], min: m[2], max: m[3] })],
  [/^pH stuck at (.+) for (-?\d+) s while water flows$/, (m) => M('dose_controller.reason.frozen', { ph: m[1], secs: m[2] })],
  [/^flow watch cold-restart retry: (.+) no water$/s, (m) => M('dose_controller.reason.flow_watch_retry', { zone: m[1] })],
  [/^pH window (.+) s is shorter than the plant lag \(tau (.+) s \+ dead time (.+) s\)$/, (m) => M('dose_controller.reason.window_short', { window: m[1], tau: m[2], dead: m[3] })],
  [/^flow_watch_shutdown: (.+) no water flow$/s, (m) => M('dose_controller.reason.flow_watch_shutdown', { zone: m[1] })],
  [/^stop_irrigation: Stop irrigation pressed by (.+)$/s, (m) => M('dose_controller.reason.stop_irrigation_pressed', { who: m[1] })],
  [/^coil write failed: (.*)$/s, (m) => M('dose_controller.reason.coil_write_failed', { error: m[1] })],
  [/^pH fell below (.+) — locked out this cycle$/, (m) => M('dose_controller.gate.locked_out', { floor: m[1] })],
  [/^pH sensor (\w+)$/, (m) => M('dose_controller.gate.sensor_fault', { kind: sensorKind(m[1]) })],
  [/^acid cap reached \((.+) s this cycle\)$/, (m) => M('dose_controller.gate.cap_cycle', { cap: m[1] })],
  [/^daily acid cap reached \((.+) s\)$/, (m) => M('dose_controller.gate.cap_day', { cap: m[1] })],
];

/**
 * English reason text → i18n descriptor (whose English render equals the text),
 * or the text itself when unknown (free text from other services stays English).
 */
function reasonSpec(text) {
  if (text === null || text === undefined) return text;
  const str = String(text);
  if (Object.prototype.hasOwnProperty.call(REASON_TEXTS, str)) return REASON_TEXTS[str];
  for (const [re, build] of REASON_PATTERNS) {
    const m = str.match(re);
    if (m) {
      const spec = build(m);
      // only use the mapping when it reproduces the text exactly
      if (i18n.render('en', spec) === str) return spec;
    }
  }
  return str;
}

/** A controller reason / why / gate string in `lang` (English and unknown texts unchanged). */
function localizeReason(lang, text) {
  if (text === null || text === undefined || typeof text !== 'string') return text;
  const L = i18n.normalizeLang(lang) || 'en';
  if (L === 'en') return text;
  return i18n.render(L, reasonSpec(text));
}

/** Alert descriptors (English render = the historical English alert text). */
const ALERT_SPECS = {
  fallback: (reason) => M('dose_controller.alert.fallback', { reason: reasonSpec(reason) }),
  fallbackEnded: (secs, why, cause) => M('dose_controller.alert.fallback_ended', { secs: S(secs), why: reasonSpec(why), cause: reasonSpec(cause) }),
  overdose: (tank, dosed, target, factor, water) => M('dose_controller.alert.overdose', { tank: S(tank), dosed: S(dosed), target: S(target), factor: S(factor), water: S(water) }),
  valveLeak: (tank, litres, channel) => M('dose_controller.alert.valve_leak', { tank: S(tank), litres: S(litres), channel: S(channel) }),
  phFloor: (ph, floor, acidS) => M('dose_controller.alert.ph_floor', { ph: S(ph), floor: S(floor), acid_s: S(acidS) }),
  phNotVerifiable: (detail) => M('dose_controller.alert.ph_not_verifiable', { detail: reasonSpec(detail) }),
  phSensorFault: (kind, detail) => M('dose_controller.alert.ph_sensor_fault', { kind: sensorKind(kind), detail: reasonSpec(detail) }),
  acidCap: (which, cap, ph, setpoint) => (which === 'cycle'
    ? M('dose_controller.alert.acid_cap_cycle', { cap: S(cap), ph: S(ph), setpoint: S(setpoint) })
    : M('dose_controller.alert.acid_cap_day', { cap: S(cap), ph: S(ph), setpoint: S(setpoint) })),
  valveMismatch: (valve, channel) => M('dose_controller.alert.valve_mismatch', { valve: S(valve), channel: S(channel) }),
  underdose: (tank, ratio, openPct, achieved, dosed, water) => M('dose_controller.alert.underdose', {
    tank: S(tank), ratio: S(ratio), open_pct: S(openPct), achieved: S(achieved), dosed: S(dosed), water: S(water),
  }),
  // tank = "Tank D (Fe EDDHA + Fetrilon Combi 2)" (data, never translated); last = clock text or a descriptor
  notDrawing: (tank, secs, last) => M('dose_controller.alert.not_drawing', { tank: S(tank), secs: S(secs), last }),
  notDrawingResolved: (tank, secs) => M('dose_controller.alert.not_drawing_resolved', { tank: S(tank), secs: S(secs) }),
  noneDrawing: (tanks, secs) => M('dose_controller.alert.none_drawing', { tanks: S(tanks), secs: S(secs) }),
  noneDrawingResolved: () => M('dose_controller.alert.none_drawing_resolved'),
  runZero: (tank, openS, water) => M('dose_controller.alert.run_zero', { tank: S(tank), open_s: S(openS), water: S(water) }),
  lastDrawUnknown: () => M('dose_controller.alert.last_draw_unknown'),
};
const TELEGRAM_TITLES = {
  notDrawing: (tank) => M('dose_controller.telegram.not_drawing', { tank: S(tank) }),
  noneDrawing: () => M('dose_controller.telegram.none_drawing'),
  runZero: (tank) => M('dose_controller.telegram.run_zero', { tank: S(tank) }),
};

/**
 * getStatus() in `lang`: mode_reason, reason, paused.reason, warnings[],
 * tanks[].why, ph.gate and ph.acid.last_decision.skipped are rendered in `lang`;
 * each localized field keeps its English original in a sibling `*_en` field.
 * English (or a missing status) is returned unchanged.
 */
function localizeStatus(status, lang) {
  const L = i18n.normalizeLang(lang) || 'en';
  if (!status || typeof status !== 'object' || L === 'en') return status;
  const out = { ...status };
  const loc = (obj, field) => {
    if (obj && typeof obj[field] === 'string') { obj[`${field}_en`] = obj[field]; obj[field] = localizeReason(L, obj[field]); }
  };
  loc(out, 'mode_reason');
  loc(out, 'reason');
  if (Array.isArray(out.warnings)) { out.warnings_en = out.warnings; out.warnings = out.warnings.map(w => localizeReason(L, w)); }
  if (out.paused) { out.paused = { ...out.paused }; loc(out.paused, 'reason'); }
  if (Array.isArray(out.tanks)) out.tanks = out.tanks.map(t => { const x = { ...t }; loc(x, 'why'); return x; });
  if (out.ph) {
    out.ph = { ...out.ph };
    loc(out.ph, 'gate');
    if (out.ph.acid && out.ph.acid.last_decision && typeof out.ph.acid.last_decision.skipped === 'string') {
      out.ph.acid = { ...out.ph.acid, last_decision: { ...out.ph.acid.last_decision } };
      loc(out.ph.acid.last_decision, 'skipped');
    }
  }
  if (out.last_run) out.last_run = localizeRun(out.last_run, L);
  return out;
}

/** A run record in `lang`: end_reason localized (end_reason_en keeps the stored text). */
function localizeRun(run, lang) {
  const L = i18n.normalizeLang(lang) || 'en';
  if (!run || typeof run !== 'object' || L === 'en' || typeof run.end_reason !== 'string') return run;
  return { ...run, end_reason_en: run.end_reason, end_reason: localizeReason(L, run.end_reason) };
}

class DoseController {
  /**
   * @param {object} deps
   * @param {import('better-sqlite3').Database} deps.db
   * @param {Function} [deps.now]             () => epoch ms
   * @param {object}   [deps.mqtt]            { onLive(fn) } — MqttIngestService
   * @param {object}   [deps.arming]          { isDisarmed() } — AutomationArmingService
   * @param {Function} [deps.createAlert]
   * @param {Function} [deps.updateOpenAlert]
   * @param {object}   [deps.poller]          { setIntervalOverride, clearIntervalOverride } — ModbusPollingService
   * @param {Function} [deps.closeWriter]     async (equipmentId, channel, source) — OFF only, restart safe-close
   * @param {object}   [deps.config]          overrides on top of the stored config (tests)
   * @param {boolean}  [deps.autoTick]        false = tests drive step() themselves
   * @param {string}   [deps.tz]
   * @param {object}   [deps.logger]
   * @param {Function} [deps.notify]          (titleEn, bodyEn, severity, {titleSpec, bodySpec}) — tests; default TelegramService
   */
  constructor(deps = {}) {
    this.db = deps.db;
    this.now = deps.now || (() => Date.now());
    this.mqtt = deps.mqtt || null;
    this.arming = deps.arming || { isDisarmed: () => false };
    this._createAlert = deps.createAlert || (() => null);
    this._updateOpenAlert = deps.updateOpenAlert || (() => null);
    this.poller = deps.poller || null;
    this.closeWriter = deps.closeWriter || null;
    this.configOverride = deps.config || null;
    this.autoTick = deps.autoTick !== false;
    this.tz = deps.tz || null;
    this.log = deps.logger || console;
    this._notifyFn = deps.notify || null;

    this.flow = null;     // { values, receivedMs, farmId }
    this.dosing = null;   // { tanks, receivedMs, farmId }
    this.cycle = null;
    this._token = 0;
    this._unsub = null;
    this._config = null;
    this._configAt = 0;
    this._pending = new Set();
    this._expected = null;
    this._disarmCache = null;
    this._flowRing = [];  // [ms, flow_lph] of the last 30 s (smoothed flow for zone water forecasts)
    this._netRing = [];   // [ms, net litres, flow_lph] of the last 10 min (EC range cross-check)
    this._doseRing = [];  // [ms, {monitorTank: consumed_l}, {monitorTank: rate_lph}] of the last 10 min
  }

  // ─── lifecycle ────────────────────────────────────────────────────────────

  start() {
    this._subscribe();
    this._recoverInterrupted();
    const cfg = this.getConfig();
    this.log.log(`[DoseController] Started (enabled=${cfg.enabled}, pH ${cfg.ph.enabled ? `on, setpoint ${cfg.ph.setpoint}` : 'off'}, ratios ${JSON.stringify(cfg.nutrients.ratio)})`);
  }

  _subscribe() {
    if (this.mqtt && !this._unsub) this._unsub = this.mqtt.onLive(evt => this.ingest(evt));
  }

  stop() {
    if (this._unsub) { this._unsub(); this._unsub = null; }
    if (this.cycle && this.cycle.timer) { clearInterval(this.cycle.timer); this.cycle.timer = null; }
  }

  /** Resolves when in-flight valve writes are done (tests). */
  async flush() {
    while (this._pending.size) await Promise.allSettled([...this._pending]);
  }

  _track(p) {
    const q = Promise.resolve(p).catch(() => {}).finally(() => this._pending.delete(q));
    this._pending.add(q);
    return q;
  }

  /**
   * A run left 'running' means the backend died mid-cycle, possibly with a
   * valve (acid!) open. Close it out and write every bound dosing valve OFF
   * (safe direction for injector valves; OFF only, never ON).
   */
  _recoverInterrupted() {
    // A cycle may already have begun (the automation scheduler starts first):
    // never touch the live run or its valves.
    const liveRun = this.cycle ? this.cycle.runId ?? -1 : -1;
    let rows = [];
    try {
      rows = this.db.prepare("SELECT id FROM dose_controller_runs WHERE status = 'running' AND id <> ?").all(liveRun);
      if (!rows.length) return;
      const nowIso = iso(this.now());
      this.db.prepare("UPDATE dose_controller_runs SET status = 'interrupted', ended_at = ?, end_reason = 'backend restarted during the cycle', updated_at = ? WHERE status = 'running' AND id <> ?")
        .run(nowIso, nowIso, liveRun);
    } catch (e) {
      this.log.error(`[DoseController] could not close interrupted runs: ${e.message}`);
      return;
    }
    if (!this.closeWriter || this.cycle) return;
    let targets = [];
    try {
      targets = this.db.prepare('SELECT id, name, equipment_id, channel FROM fertigation_tanks WHERE equipment_id IS NOT NULL AND channel IS NOT NULL').all();
    } catch (_) { targets = []; }
    this.log.warn(`[DoseController] ${rows.length} run(s) interrupted by a restart — closing ${targets.length} dosing valve(s)`);
    for (const t of targets) {
      this._track(Promise.resolve().then(() => this.closeWriter(t.equipment_id, t.channel, 'dose_controller_restart'))
        .catch(e => this.log.error(`[DoseController] restart close of ${t.name} failed: ${e.message}`)));
    }
  }

  // ─── config ───────────────────────────────────────────────────────────────

  getStoredConfig() {
    try {
      const row = this.db.prepare('SELECT value FROM system_settings WHERE key = ?').get(CONFIG_KEY);
      if (row && row.value) {
        const { value, error } = validateConfigUpdate(JSON.parse(row.value));
        if (error) throw new Error(error);
        return value;
      }
    } catch (e) {
      this.log.error(`[DoseController] bad ${CONFIG_KEY} setting, using defaults: ${e.message}`);
    }
    return {};
  }

  getConfig(fresh = false) {
    const nowMs = this.now();
    if (fresh || !this._config || nowMs - this._configAt > 10000 || nowMs < this._configAt) {
      let cfg = mergeConfig(DEFAULT_CONFIG, this.getStoredConfig());
      if (this.configOverride) cfg = mergeConfig(cfg, this.configOverride);
      if (crossCheck(cfg)) {
        this.log.error(`[DoseController] stored config fails cross-checks (${crossCheck(cfg)}); using defaults`);
        cfg = mergeConfig(DEFAULT_CONFIG, this.configOverride || {});
      }
      this._config = cfg;
      this._configAt = nowMs;
    }
    return this._config;
  }

  isEnabled() {
    return this.getConfig(true).enabled === true;
  }

  saveConfig(updates) {
    const { value, error } = validateConfigUpdate(updates);
    if (error) { const e = new Error(error); e.status = 400; throw e; }
    const merged = mergeConfig(mergeConfig(DEFAULT_CONFIG, this.getStoredConfig()), value);
    const bad = crossCheck(merged);
    if (bad) { const e = new Error(bad); e.status = 400; throw e; }
    this.db.prepare(
      "INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).run(CONFIG_KEY, JSON.stringify(merged));
    this._config = null;
    return this.getConfig(true);
  }

  _expectedFlow(cfg) {
    if (cfg.nutrients.expected_flow_lph) return cfg.nutrients.expected_flow_lph;
    const nowMs = this.now();
    if (this._expected && nowMs - this._expected.at < 60000 && nowMs >= this._expected.at) return this._expected.lph;
    let lph = null;
    try {
      const rows = this.db.prepare("SELECT flow_rate, flow_unit FROM relay_channel_config WHERE LOWER(COALESCE(ingredient_name, '')) = 'water' AND flow_rate > 0").all();
      const vals = rows.map(r => {
        const unit = String(r.flow_unit || 'L/min').toLowerCase();
        const v = Number(r.flow_rate);
        return unit === 'l/h' ? v : (unit === 'm3/h' || unit === 'm³/h') ? v * 1000 : v * 60;
      }).filter(v => Number.isFinite(v) && v > 0);
      lph = median(vals);
    } catch (_) { lph = null; }
    this._expected = { at: nowMs, lph: lph || DEFAULT_EXPECTED_FLOW_LPH };
    return this._expected.lph;
  }

  _disarmed(nowMs, fresh = false) {
    const c = this._disarmCache;
    if (!fresh && c && nowMs - c.at < 1000 && nowMs >= c.at) return c.value;
    let value;
    try { value = !!this.arming.isDisarmed(); } catch (_) { value = true; } // fail closed
    this._disarmCache = { at: nowMs, value };
    return value;
  }

  _tz() {
    if (this.tz) return this.tz;
    try { return require('../utils/systemTimezone').getSystemTimezone(this.db); } catch (_) { return process.env.TZ || 'UTC'; }
  }

  _localDate(ms) {
    try { return require('../utils/systemTimezone').localDateStr(new Date(ms), this._tz()); } catch (_) { return new Date(ms).toISOString().slice(0, 10); }
  }

  /** monitor tank n -> fertigation tank id (system_settings mqtt_monitor_settings[farm].tank_map, default identity). */
  _monitorMap(farmId) {
    const map = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 };
    try {
      const row = this.db.prepare("SELECT value FROM system_settings WHERE key = 'mqtt_monitor_settings'").get();
      const cfg = row ? JSON.parse(row.value) : null;
      const tm = cfg && farmId && cfg[farmId] && cfg[farmId].tank_map;
      if (tm && typeof tm === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(tm)) {
          const n = parseInt(k, 10);
          if (Number.isInteger(n) && v !== null && Number.isInteger(Number(v))) out[n] = Number(v);
        }
        return out;
      }
    } catch (_) { /* default identity */ }
    return map;
  }

  // ─── input ────────────────────────────────────────────────────────────────

  /** One live event from MqttIngestService.onLive(). */
  ingest(evt) {
    if (!evt || evt.live === false) return;
    const ms = evt.receivedMs || this.now();
    if (evt.kind === 'flowmeter' && evt.values) {
      this.flow = { values: { ...(this.flow ? this.flow.values : {}), ...evt.values }, receivedMs: ms, farmId: evt.farmId };
      if (typeof evt.values.flow_lph === 'number' && Number.isFinite(evt.values.flow_lph)) {
        this._flowRing.push([ms, evt.values.flow_lph]);
        while (this._flowRing.length && this._flowRing[0][0] < ms - 30000) this._flowRing.shift();
        const net = typeof evt.values.net_total_m3 === 'number' && Number.isFinite(evt.values.net_total_m3) ? evt.values.net_total_m3 * 1000 : null;
        this._netRing.push([ms, net, evt.values.flow_lph]);
        while (this._netRing.length && this._netRing[0][0] < ms - 600000) this._netRing.shift();
      }
      const c = this.cycle;
      if (c && !c.ended) {
        this._accumulateWater(c, evt.values, ms);
        this._fastWaterGuard(c, ms);
      }
    } else if (evt.kind === 'dosing' && Array.isArray(evt.tanks)) {
      this.dosing = { tanks: evt.tanks, receivedMs: ms, farmId: evt.farmId, equipmentId: evt.equipmentId ?? null };
      const cons = {}; const rates = {};
      for (const t of evt.tanks) {
        if (!t || typeof t.rate_lph !== 'number') continue; // null rate = not metered (pH Down)
        if (typeof t.consumed_l === 'number') cons[t.id] = t.consumed_l;
        rates[t.id] = t.rate_lph;
      }
      this._doseRing.push([ms, cons, rates]);
      while (this._doseRing.length && this._doseRing[0][0] < ms - 600000) this._doseRing.shift();
      const c = this.cycle;
      if (c && !c.ended) this._accumulateDosing(c, evt.tanks, ms);
    }
  }

  _accumulateWater(c, v, ms) {
    const f = c.flowAcc;
    const flow = typeof v.flow_lph === 'number' && Number.isFinite(v.flow_lph) ? Math.max(0, v.flow_lph) : null;
    const net = typeof v.net_total_m3 === 'number' && Number.isFinite(v.net_total_m3) ? v.net_total_m3 * 1000 : null;
    if (f.lastMs === null) {
      f.lastMs = ms; f.lastFlow = flow; f.high = net;
      return;
    }
    const dt = Math.max(0, (ms - f.lastMs) / 1000);
    const prevFlow = f.lastFlow;
    const byFlow = flow !== null && prevFlow !== null ? ((flow + prevFlow) / 2 / 3600) * dt
      : ((flow !== null ? flow : (prevFlow || 0)) / 3600) * dt;
    let d = null;
    if (net !== null && f.high !== null) {
      const bound = Math.max(byFlow, (this._expectedFlow(this.getConfig()) / 3600) * dt) * 1.5 + 5;
      if (net >= f.high - 5) {
        const delta = Math.max(0, net - f.high); // high-water mark: reverse drift never counts twice
        if (delta <= bound) { d = delta; if (net > f.high) f.high = net; }
      }
      if (d === null) { f.high = net; c.waterGlitches++; } // accumulator reset / jump: re-base, integrate this step
    } else if (net !== null) {
      f.high = net;
    }
    if (d === null) { d = byFlow; c.waterByFlow += byFlow; }
    c.W += d;
    f.lastMs = ms;
    if (flow !== null) f.lastFlow = flow;
  }

  _accumulateDosing(c, tanks, ms) {
    if (c.mapFarm !== (this.dosing && this.dosing.farmId)) {
      c.mapFarm = this.dosing && this.dosing.farmId;
      c.monitorMap = this._monitorMap(c.mapFarm);
    }
    const cfg = this.getConfig();
    const sub = this._substep(cfg);
    for (const mt of tanks) {
      if (!mt) continue;
      const t = c.tankById.get(c.monitorMap[mt.id]);
      if (!t) continue;
      t.rateLph = typeof mt.rate_lph === 'number' && Number.isFinite(mt.rate_lph) ? mt.rate_lph : null;
      if (t.rateLph !== null) t.metered = true; // the monitor reports a rate for metered tanks (pH Down: null)
      t.monitorTank = mt.id;
      if (sub) {
        this._estIntegrate(c, t, ms, cfg); // up to this sample, with the previous rate
        this._estRate(t, ms);
      }
      const cur = mt.consumed_l;
      if (typeof cur !== 'number' || !Number.isFinite(cur)) continue;
      if (t.lastConsumed === null) { t.lastConsumed = cur; t.lastConsumedMs = ms; t.est.prevSampleMs = ms; continue; }
      const dt = Math.max(0, (ms - t.lastConsumedMs) / 1000);
      const bound = 0.5 + (5 * dt) / 60; // 5 L/min: > 2x any venturi here
      let d = cur - t.lastConsumed;
      let odd = false;
      if (d < 0) { d = cur <= bound ? cur : 0; t.counterResets++; odd = true; }
      else if (d > bound) { d = 0; t.counterGlitches++; odd = true; }
      if (odd) {
        // counter reset / jump: the phase inside the 0.25 L step is unknown again; keep A
        // continuous and start the sub-step part from 0 (it must not saturate before the next step)
        t.est.offset += t.est.extra - d;
        t.est.extra = 0;
        t.est.phaseKnown = false;
        t.est.pre = { flowS: 0, blind: true };
        t.est.cleanSinceMs = null;
      }
      t.V += d;
      if (d > 0) t.lastIncMs = ms;
      if (d > 0 && !odd) this._estStep(c, t, ms, d, cfg);
      t.lastConsumed = cur;
      t.lastConsumedMs = ms;
      t.est.prevSampleMs = ms;
      if (!t.open && t.closedAt !== null && ms - t.closedAt >= cfg.nutrients.leak_after_s * 1000) t.vLeak += d;
    }
  }

  // ─── sub-step volume estimate (nutrients.substep_estimate) ─────────────────

  _substep(cfg) {
    return cfg.nutrients.substep_estimate === true && cfg.nutrients.mode !== 'tracking';
  }

  /** Absolute estimate (litres, same base as t.V): counter + re-base + sub-step part. */
  _estAbs(t) {
    return t.V + t.est.offset + t.est.extra;
  }

  /** Water moving through the venturis (fresh + healthy meter, flow >= 25 % of expected). No side effects. */
  _estFlowing(cfg, now) {
    return this._estMotive(cfg, now) > 0;
  }

  /** Motive flow fraction (flow / expected, <= 1) while water moves, else 0. No side effects. */
  _estMotive(cfg, now) {
    const f = this.flow;
    if (!f || now - f.receivedMs > cfg.nutrients.stale_s * 1000 || now < f.receivedMs - 1000) return 0;
    const v = f.values || {};
    if (typeof v.signal_quality === 'number' && v.signal_quality < cfg.nutrients.min_signal_quality) return 0;
    if (typeof v.error_flags === 'number' && v.error_flags !== 0) return 0;
    if (typeof v.flow_lph !== 'number' || !Number.isFinite(v.flow_lph)) return 0;
    const frac = v.flow_lph / this._expectedFlow(cfg);
    return frac >= EST_MOTIVE_FRACTION ? Math.min(1, frac) : 0;
  }

  /**
   * Light smoothing of the monitor's rate (sample noise only: a change of more
   * than 20 % — valve opening, ramp — is followed at once, so the smoothing adds
   * no lag there). An explicit null rate is "absent" at once.
   */
  _estRate(t, ms) {
    const e = t.est;
    const r = t.rateLph;
    if (r === null || r < 0) { e.rSm = null; e.rMs = null; return; }
    const jump = e.rSm !== null && Math.abs(r - e.rSm) > 0.2 * Math.max(r, e.rSm, 1);
    if (e.rSm === null || e.rMs === null || jump || ms - e.rMs > 10000 || ms < e.rMs) e.rSm = r;
    else e.rSm += (r - e.rSm) * (1 - Math.exp(-((ms - e.rMs) / 1000) / EST_RATE_TAU_S));
    e.rMs = ms;
  }

  /**
   * Rate used to interpolate: the monitor's (smoothed, fresh), else the zone's
   * measured step-to-step rate, else the run's, else 0 (plain 0.25 L steps).
   */
  _estRateLps(c, t, now, cfg) {
    const e = t.est;
    if (e.rSm !== null && e.rMs !== null && now - e.rMs <= cfg.nutrients.stale_s * 1000 && now >= e.rMs - 1000) {
      return { lps: Math.max(0, e.rSm) / 3600, source: 'rate' };
    }
    const st = c.seg ? c.seg.tanks[t.tank_id] : null;
    if (st && st.avg && st.avg.s >= EST_AVG_MIN_S && st.avg.v > 0) return { lps: st.avg.v / st.avg.s, source: 'zone_avg' };
    if (e.avg.s >= EST_AVG_MIN_S && e.avg.v > 0) return { lps: e.avg.v / e.avg.s, source: 'run_avg' };
    return { lps: 0, source: 'quantised' };
  }

  /**
   * Integrate the sub-step part up to `now` — only while the valve is commanded
   * OPEN and water moves (never the rate the monitor holds after a close).
   */
  _estIntegrate(c, t, now, cfg) {
    const e = t.est;
    if (e.lastMs === null || now < e.lastMs) { e.lastMs = now; return; }
    const dt = (now - e.lastMs) / 1000;
    e.lastMs = now;
    if (dt <= 0) return;
    const motive = t.open ? this._estMotive(cfg, now) : 0;
    if (!motive) {
      e.cleanSinceMs = null;
      e.source = t.open ? 'no_water' : 'closed';
      return;
    }
    const r = this._estRateLps(c, t, now, cfg);
    e.source = r.source;
    // a measured (full-flow) step rate is scaled by the motive flow (venturi draw follows it);
    // the monitor's own rate already is the actual draw
    const w = r.source === 'rate' ? 1 : motive;
    if (!e.phaseKnown && e.pre) { e.pre.flowS += dt * motive; if (r.source !== 'quantised') e.pre.blind = false; }
    if (r.lps > 0) e.extra = clamp(e.extra + r.lps * w * dt, 0, COUNTER_STEP_L + EST_MARGIN_L);
  }

  /** A new counter step (d litres) arrived at ms: measured step rate + re-anchor. */
  _estStep(c, t, ms, d, cfg) {
    const e = t.est;
    const flowing = t.open && this._estFlowing(cfg, ms);
    // measured rate from clean step-to-step intervals (valve open + water moving throughout)
    if (flowing && e.cleanSinceMs !== null && e.cleanV !== null && ms > e.cleanSinceMs) {
      const dv = t.V - e.cleanV;
      const ds = (ms - e.cleanSinceMs) / 1000;
      if (dv > 0 && ds > 0) {
        e.avg.v += dv; e.avg.s += ds;
        const st = c.seg ? c.seg.tanks[t.tank_id] : null;
        if (st && st.avg) { st.avg.v += dv; st.avg.s += ds; }
      }
    }
    // No rate at all before the first step after an unknown phase (monitor rate absent):
    // once a step rate is measured, back-fill that first stretch as rate x flowing time
    // (<= one step) — otherwise up to 0.25 L of it would be lost to the re-base.
    if (e.backfill && e.avg.s >= EST_AVG_MIN_S && e.avg.v > 0) {
      const add = clamp((e.avg.v / e.avg.s) * e.backfill.flowS, 0, COUNTER_STEP_L) - e.backfill.integrated;
      if (add > 0) e.offset += add;
      e.backfill = null;
    }
    e.cleanSinceMs = flowing ? ms : null;
    e.cleanV = t.V;
    // the step was crossed somewhere in the last report gap: assume its midpoint
    const gapMs = e.prevSampleMs !== null && ms - e.prevSampleMs <= 2500 && ms >= e.prevSampleMs ? ms - e.prevSampleMs : 0;
    const lps = flowing ? this._estRateLps(c, t, ms, cfg).lps : 0;
    const extraNew = clamp((lps * gapMs) / 2000, 0, COUNTER_STEP_L / 2);
    if (!e.phaseKnown) {
      // unknown phase before this step: re-base so A does not jump (differences stay exact)
      e.offset = (t.V - d + e.offset + e.extra) - (t.V + extraNew);
      e.phaseKnown = true;
      e.backfill = e.pre && e.pre.blind && e.pre.flowS > 0 ? { flowS: e.pre.flowS, integrated: e.extra } : null;
      e.pre = null;
    }
    e.extra = extraNew;
  }

  /** Legacy interpolation (substep_estimate false): rate x time since the last step, capped at 0.24 L. */
  _vEstLegacy(t, now, ws) {
    if (!t.open || t.lastIncMs === null) return t.V;
    const rate = this._rateLps(t, ws);
    return t.V + Math.min(0.24, Math.max(0, rate * (now - t.lastIncMs) / 1000));
  }

  _waterState(c, cfg, now) {
    const n = cfg.nutrients;
    const f = this.flow;
    const flowAgeMs = f ? now - f.receivedMs : null;
    const fresh = flowAgeMs !== null && flowAgeMs <= n.stale_s * 1000;
    const v = f ? f.values : {};
    const signal = typeof v.signal_quality === 'number' ? v.signal_quality : null;
    const errorFlags = typeof v.error_flags === 'number' ? v.error_flags : null;
    const healthy = (signal === null || signal >= n.min_signal_quality) && (errorFlags === null || errorFlags === 0);
    const flow = typeof v.flow_lph === 'number' && Number.isFinite(v.flow_lph) ? v.flow_lph : null;
    const known = fresh && healthy && flow !== null;
    const expected = this._expectedFlow(cfg);
    const threshold = (expected * n.min_flow_pct) / 100;
    const ok = known && flow >= threshold;
    // A dry reading stays evidence for DRY_EVIDENCE_MS even when the monitor drops
    // to its 10 s idle cadence: "no water" never turns into "blind -> schedule".
    const dry = healthy && flow !== null && flow < threshold && flowAgeMs !== null && flowAgeMs <= DRY_EVIDENCE_MS;
    if (dry) { if (c.lowFlowSince === null) c.lowFlowSince = f.receivedMs <= now ? Math.min(now, f.receivedMs) : now; }
    else if (ok) c.lowFlowSince = null;
    const stopped = dry && c.lowFlowSince !== null && now - c.lowFlowSince >= n.no_water_s * 1000;
    const dosingAgeMs = this.dosing ? now - this.dosing.receivedMs : null;
    const dosingFresh = dosingAgeMs !== null && dosingAgeMs <= n.stale_s * 1000;
    return { fresh, healthy, known, flow, expected, threshold, ok, dry, stopped, dosingFresh, flowAgeMs, dosingAgeMs, signal, errorFlags };
  }

  /** On every flow sample: water gone -> close acid at once, nutrients after no_water_s. */
  _fastWaterGuard(c, ms) {
    const cfg = this.getConfig();
    const ws = this._waterState(c, cfg, ms);
    if (c.acid.open && !ws.ok) this._acidClose(c, ms, ws.known ? 'no water flow' : 'flow not verifiable');
    if (ws.stopped && c.tanks.some(t => t.open)) {
      for (const t of c.tanks) if (t.open) this._applyValve(c, t, false, { force: true, why: 'no water', now: ms, cfg });
      c.lastReason = 'water stopped — all nutrient valves closed';
    }
  }

  // ─── feed-EC range cross-check (hint for ModbusAutoRange) ──────────────────

  /**
   * Live-monitor state over the last window_s: did water flow the whole time,
   * how many metered tanks dosed at a plausible ratio, did anything dose at all.
   */
  _liveDosingWindow(now, cfg) {
    const ec = cfg.ec_check;
    const from = now - ec.window_s * 1000;
    const flows = this._netRing.filter(r => r[0] >= from && r[0] <= now);
    const doses = this._doseRing.filter(r => r[0] >= from && r[0] <= now);
    const threshold = (this._expectedFlow(cfg) * cfg.nutrients.min_flow_pct) / 100;
    const covered = flows.length >= 2 && flows[0][0] <= from + 10000 && now - flows[flows.length - 1][0] <= cfg.nutrients.stale_s * 1000
      && doses.length >= 2 && doses[0][0] <= from + 10000 && now - doses[doses.length - 1][0] <= cfg.nutrients.stale_s * 1000;
    if (!covered) return { covered: false };
    const flowOk = flows.every(r => r[2] >= threshold);
    const f0 = flows.find(r => r[1] !== null); const f1 = [...flows].reverse().find(r => r[1] !== null);
    const water = f0 && f1 ? f1[1] - f0[1] : flows.reduce((acc, r, i) => (i ? acc + ((r[2] + flows[i - 1][2]) / 2 / 3600) * ((r[0] - flows[i - 1][0]) / 1000) : 0), 0);
    const first = doses[0]; const last = doses[doses.length - 1];
    let plausible = 0; let anyDosing = false;
    for (const id of Object.keys(last[1])) {
      const dv = last[1][id] - (first[1][id] ?? last[1][id]);
      const rateNow = last[2][id];
      if (dv > 0 || rateNow > 5) anyDosing = true;
      if (dv >= 0.25 && water > 0) {
        const ratio = water / dv;
        if (ratio >= ec.min_ratio && ratio <= ec.max_ratio) plausible++;
      }
    }
    return { covered: true, flowOk, water, plausible, anyDosing };
  }

  /** Hint for the SEKO EC auto-range decoder (ModbusPollingService.setAutoRangeHintProvider). */
  ecRangeHint(equipmentId, metric) {
    const cfg = this.getConfig();
    if (!cfg.ec_check.enabled || equipmentId !== cfg.ph.sensor_equipment_id || metric !== cfg.ph.ec_metric) return null;
    const now = this.now();
    const w = this._liveDosingWindow(now, cfg);
    if (!w.covered || !w.flowOk) return null;
    const onOverride = (d) => this._onEcOverride(d);
    if (w.plausible >= 2) return { minValue: cfg.ec_check.fertilised_min_us, basis: 'dosing', onOverride };
    if (!w.anyDosing && cfg.ec_check.raw_water_ec_us) return { preferValue: cfg.ec_check.raw_water_ec_us, basis: 'raw_water', onOverride };
    return null;
  }

  _onEcOverride(d) {
    this.log.warn(`[DoseController] EC range cross-check (${d.basis}): raw ${d.raw} read as ${d.value} µS/cm (${d.range}) instead of ${d.continuity}`);
    const c = this.cycle;
    if (c && !c.ended) {
      c.ecOverrides = (c.ecOverrides || 0) + 1;
      this._trip(c, 'ec_range_override', this.now(), `${d.basis}: raw ${d.raw} -> ${d.value} µS/cm (${d.range} range), continuity said ${d.continuity}`);
    }
  }

  // ─── cycle ────────────────────────────────────────────────────────────────

  _resolvePhTank(nutrientTanks) {
    const eqIds = new Set(nutrientTanks.map(t => t.equipment_id));
    let rows = [];
    try {
      rows = this.db.prepare("SELECT id, name, equipment_id, channel FROM fertigation_tanks WHERE role = 'ph_down' AND COALESCE(active, 1) = 1 AND equipment_id IS NOT NULL AND channel IS NOT NULL ORDER BY id").all();
    } catch (_) { rows = []; }
    const row = rows.find(r => eqIds.has(r.equipment_id));
    if (!row) return null;
    if (nutrientTanks.some(t => t.equipment_id === row.equipment_id && Number(t.channel) === Number(row.channel))) return null;
    return {
      kind: 'acid', tank_id: row.id, tank_name: row.name, name: shortName(row.name, row.id),
      equipment_id: row.equipment_id, channel: Number(row.channel),
      open: false, chain: null, writes: 0, writeErrors: 0, lastSwitchMs: null, offRewritten: false,
    };
  }

  /**
   * Take over a dose cycle (called by FertigationDoseScheduler.startCycle for a
   * closed_loop program). ctx: { cycleLogId, programId, automationId,
   * durationSeconds, schedule, tanks, write(target, state, opts), abort(reason),
   * valveStates }. Returns { runId, phTank }.
   */
  beginCycle(ctx) {
    if (this.cycle) throw new Error('dose controller already runs a cycle');
    this._subscribe();
    const cfg = this.getConfig(true);
    const now = this.now();
    const schedTanks = (ctx.tanks || []).filter(t => t && t.equipment_id && t.channel != null);
    const baseRatios = {};
    for (const t of schedTanks) {
      const v = cfg.nutrients.ratio[t.tank_id] ?? cfg.nutrients.ratio[String(t.tank_id)];
      if (typeof v === 'number' && v > 0) baseRatios[t.tank_id] = v;
    }
    const trim = computeEcTrim(cfg.nutrients.ec_trim.enabled ? this._previousRunForTrim(ctx.programId) : null, baseRatios, cfg.nutrients.ec_trim);
    const ratioOf = (id) => (trim.ratios[id] > 0 ? trim.ratios[id] : null);
    const roles = {};
    try { for (const r of this.db.prepare('SELECT id, role FROM fertigation_tanks').all()) roles[r.id] = r.role || 'nutrient'; } catch (_) { /* unknown roles: nutrient */ }
    const tanks = schedTanks.map(t => ({
      kind: 'nutrient',
      tank_id: t.tank_id, tank_name: t.tank_name, name: shortName(t.tank_name, t.tank_id),
      equipment_id: t.equipment_id, channel: Number(t.channel), duty_pct: t.duty_pct,
      ratio: ratioOf(t.tank_id),
      events: Array.isArray(t.valve_events) ? t.valve_events : [],
      open: false, openSince: null, openMs: 0, lastSwitchMs: null, switches: 0, closedAt: null,
      V: 0, lastConsumed: null, lastConsumedMs: null, lastIncMs: null, rateLph: null, counterResets: 0, counterGlitches: 0,
      vLeak: 0, leakFlagged: false, target: 0, err: null, limited: false, limitedSince: null, limitedMs: 0,
      overdoseTrips: 0, overdoseActive: false, chain: null, writes: 0, writeErrors: 0, offRewritten: false, lastWhy: null,
      est: newEst(),
      role: roles[t.tank_id] || 'nutrient', metered: false, monitorTank: null,
      nd: newNd(), retry: null, retries: [],
    }));
    const phTank = this._resolvePhTank(schedTanks);
    const token = ++this._token;
    const c = {
      token, ctx, cfgAtStart: cfg,
      startedAt: now, endsAt: now + Math.round(ctx.durationSeconds * 1000), durationS: ctx.durationSeconds,
      tanks, tankById: new Map(tanks.map(t => [t.tank_id, t])), phTank,
      monitorMap: this._monitorMap((this.dosing && this.dosing.farmId) || (this.flow && this.flow.farmId) || null),
      mapFarm: (this.dosing && this.dosing.farmId) || null,
      flowAcc: { lastMs: null, lastFlow: null, high: null }, W: 0, waterByFlow: 0, waterGlitches: 0,
      mode: null, modeSince: now, modeReason: null, modeMs: { closed_loop: 0, fallback: 0, hold: 0, waiting: 0 },
      fallbackPeriods: [], fallbackAlerted: false, lastAccountMs: now,
      monitorSeenOk: false, waterEstablishedAt: null, phFlowSince: null, initialOpened: false, lowFlowSince: null,
      lastEvalMs: -Infinity, lastCheckpointMs: now, lastReason: null,
      acid: {
        open: false, openAt: null, closeAt: null, usedMs: 0, pulses: 0, windowStart: null,
        integral: 0, saturated: false, lastDecision: null, decisions: 0, gate: 'start delay',
        tripped: false, faultLatched: null, sampleState: 'idle', sample: null, lastTs: null, valid: null,
        frozen: null, stats: { min: null, max: null, sum: 0, n: 0, last: null }, capAlerted: false, staleAlerted: false,
        ecStats: { min: null, max: null, sum: 0, n: 0, last: null },
        recent: [], floorLow: 0, skipUntil: null,
      },
      trips: [], alerts: new Set(),
      phRead: { at: -Infinity, value: null },
      relayRead: { at: -Infinity, states: null, pollMs: null },
      localDate: this._localDate(now), dayBase: null,
      ended: false, aborting: false, timer: null, acidTimer: null,
      trim,
      seg: null, zoneRecords: [], carry: {}, zoneRead: { at: -Infinity, zone: null },
      zonePlan: this._loadZonePlan(cfg, ctx.automationId), zoneNames: this._zoneNames(cfg),
      pumpRead: { at: -Infinity, ev: null }, pumpStart: null, pumpArmed: false, firstPumpMs: null, lastGoodFlowLph: null,
      noneDrawing: { alerted: false, open: false, alertedAt: null }, drawWatchMs: null,
    };

    // Baseline from the latest idle samples (the monitor reports every 10 s when idle),
    // so water/concentrate between pump start and the first live sample is counted.
    if (this.flow && now - this.flow.receivedMs <= 30000) this._accumulateWater(c, this.flow.values, this.flow.receivedMs);
    if (this.dosing && now - this.dosing.receivedMs <= 30000) this._accumulateDosing(c, this.dosing.tanks, this.dosing.receivedMs);
    for (const t of tanks) { t.est.lastMs = now; t.est.A0 = this._estAbs(t); }

    try {
      const info = this.db.prepare(`
        INSERT INTO dose_controller_runs (cycle_log_id, program_id, automation_id, started_at, local_date, status, water_l, acid_s, acid_pulses, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'running', 0, 0, 0, ?, ?)
      `).run(ctx.cycleLogId ?? null, ctx.programId ?? null, ctx.automationId ?? null, iso(now), c.localDate, iso(now), iso(now));
      c.runId = Number(info.lastInsertRowid);
    } catch (e) {
      this.log.error(`[DoseController] could not record run: ${e.message}`);
      c.runId = null;
    }

    // Faster feed-pH samples while the cycle runs (10 s instead of 30 s), with a
    // short read timeout so one slow SEKO read cannot hold the shared gateway queue.
    if (this.poller && cfg.ph.enabled && phTank) {
      try {
        c.boosted = this.poller.setIntervalOverride(cfg.ph.sensor_equipment_id, cfg.ph.sample_interval_s * 1000, {
          untilMs: c.endsAt + 60000,
          requestOptions: { timeout: cfg.ph.sample_timeout_ms, retries: 1 },
        });
      } catch (e) { this.log.error(`[DoseController] pH poll boost failed: ${e.message}`); }
    }

    this.cycle = c;
    if (this.autoTick) {
      c.timer = setInterval(() => {
        try { this.step(); } catch (e) { this.log.error(`[DoseController] step failed: ${e.message}`); }
      }, TICK_MS);
      if (c.timer.unref) c.timer.unref();
    }
    this.log.log(`[DoseController] cycle #${ctx.cycleLogId} started (run ${c.runId}): ${tanks.map(t => `${t.name} ${t.ratio ? `1:${t.ratio}` : 'schedule'}`).join(', ')}; pH ${phTank ? `${phTank.name} ch${phTank.channel}` : 'no pH Down tank bound'}`);
    return { runId: c.runId, phTank };
  }

  /** Latest finished closed-loop run of this program with feed EC samples (EC trim input). */
  _previousRunForTrim(programId) {
    try {
      const row = this.db.prepare(`
        SELECT id, ec_avg, ec_samples, tanks_json FROM dose_controller_runs
        WHERE status IN ('completed', 'aborted') AND ec_avg IS NOT NULL AND (? IS NULL OR program_id = ?)
        ORDER BY started_at DESC, id DESC LIMIT 1
      `).get(programId ?? null, programId ?? null);
      if (!row) return null;
      let tanks = [];
      try { tanks = JSON.parse(row.tanks_json || '[]'); } catch (_) { tanks = []; }
      return { id: row.id, ec_avg: row.ec_avg, ec_samples: row.ec_samples, tanks };
    } catch (_) { return null; }
  }

  /** Stop controlling (the scheduler then closes every dosing valve). Idempotent. */
  async endCycle({ status = 'completed', reason = null, source = null } = {}) {
    const c = this.cycle;
    if (!c || c.ended) return null;
    const now = this.now();
    c.endInfo = { status, reason, source }; // per-zone status on the final record (shutdown / not run)
    c.ended = true;
    this.cycle = null;
    if (c.timer) { clearInterval(c.timer); c.timer = null; }
    if (c.acidTimer) { clearTimeout(c.acidTimer); c.acidTimer = null; }
    this._accountTime(c, now);
    const endCfg = this.getConfig();
    if (this._substep(endCfg)) for (const t of c.tanks) this._estIntegrate(c, t, now, endCfg);
    if (c.seg) {
      try { this._finishSegment(c, this.getConfig(), now, this._waterState(c, this.getConfig(), now)); } catch (e) { this.log.error(`[DoseController] segment close failed: ${e.message}`); }
    }
    // The valves are about to be written OFF by the end/abort path: close the books now,
    // so an in-flight ON sees open === false and is dropped before its coil write.
    for (const t of c.tanks) {
      if (t.open) { t.openMs += now - t.openSince; t.openSince = null; t.open = false; }
    }
    if (c.acid.open) {
      c.acid.usedMs += now - c.acid.openAt;
      c.acid.open = false; c.acid.openAt = null;
      if (c.phTank) c.phTank.open = false;
    }
    if (c.mode === 'fallback') this._closeFallback(c, now, 'cycle ended');
    let timer = null;
    await Promise.race([
      Promise.allSettled([...this._pending]),
      new Promise(res => { timer = setTimeout(res, END_WAIT_MS); if (timer.unref) timer.unref(); }),
    ]);
    if (timer) clearTimeout(timer);
    if (c.boosted && this.poller) {
      try { this.poller.clearIntervalOverride(c.cfgAtStart.ph.sensor_equipment_id); } catch (_) { /* expires anyway */ }
    }
    const row = this._finalize(c, now, status, reason);
    this.log.log(`[DoseController] cycle #${c.ctx.cycleLogId} ${status}${reason ? ` (${reason})` : ''}: water ${r1(c.W)} L, ${c.tanks.map(t => `${t.name} ${r2(t.V)} L${t.V > 0 ? ` 1:${Math.round(c.W / t.V)}` : ''}`).join(', ')}, acid ${r1(c.acid.usedMs / 1000)} s`);
    return row;
  }

  /**
   * Hold every dosing valve closed without ending the cycle (flow-watch cold-restart
   * retry, 2026-09-26): mode 'hold', nutrients + acid closed at once through the
   * normal close path, no ON write until resumeDosing(). Segments, per-zone targets
   * and carry are kept, so dosing picks up the same zone's litre target when the
   * water comes back. Returns false when no cycle runs.
   */
  pauseDosing(reason = 'paused') {
    const c = this.cycle;
    if (!c || c.ended) return false;
    const now = this.now();
    if (!c.paused) {
      c.paused = { reason: String(reason), since: now };
      this._trip(c, 'dosing_paused', now, String(reason));
      this.log.warn(`[DoseController] dosing paused: ${reason}`);
    }
    try { this.step(now); } catch (e) { this.log.error(`[DoseController] step on pause failed: ${e.message}`); }
    return true;
  }

  /** End a pauseDosing() hold. Returns false when no cycle runs or it was not paused. */
  resumeDosing(reason = 'resumed') {
    const c = this.cycle;
    if (!c || c.ended || !c.paused) return false;
    const now = this.now();
    const secs = r1((now - c.paused.since) / 1000);
    c.paused = null;
    this._trip(c, 'dosing_resumed', now, `${reason} after ${secs} s`);
    this.log.log(`[DoseController] dosing resumed (${reason}) after ${secs} s`);
    try { this.step(now); } catch (e) { this.log.error(`[DoseController] step on resume failed: ${e.message}`); }
    return true;
  }

  isPaused() {
    return !!(this.cycle && !this.cycle.ended && this.cycle.paused);
  }

  /** One control step. Production: every 1 s; tests call it directly. */
  step(now = this.now()) {
    const c = this.cycle;
    if (!c || c.ended) return;
    const cfg = this.getConfig();
    const n = cfg.nutrients;
    let ws = this._waterState(c, cfg, now);
    const disarmed = this._disarmed(now);

    let mode;
    let reason = null;
    if (!cfg.enabled) { mode = 'fallback'; reason = 'controller switched off — fixed schedule'; }
    else if (disarmed) { mode = 'hold'; reason = 'automations disarmed — dosing valves held closed'; }
    else if (c.paused) { mode = 'hold'; reason = `dosing paused — ${c.paused.reason}`; }
    else if (ws.dry && !ws.known) {
      // monitor on its idle cadence (or silent) and its last word was "no water": hold closed
      mode = 'closed_loop';
      c.monitorSeenOk = true;
    } else if (!ws.known || !ws.dosingFresh) {
      const why = !ws.fresh ? (ws.flowAgeMs === null ? 'no flowmeter data' : `no flowmeter data for ${Math.round(ws.flowAgeMs / 1000)} s`)
        : !ws.healthy ? `flowmeter unhealthy (signal ${ws.signal ?? '?'}, flags ${ws.errorFlags ?? '?'})`
          : !ws.dosingFresh ? (ws.dosingAgeMs === null ? 'no dosing data' : `no dosing data for ${Math.round(ws.dosingAgeMs / 1000)} s`)
            : 'no flow value';
      if (!c.monitorSeenOk && now - c.startedAt < n.start_grace_s * 1000) { mode = 'waiting'; reason = `waiting for monitor data (${why})`; }
      else { mode = 'fallback'; reason = `monitor blind: ${why} — fixed schedule`; }
    } else {
      mode = 'closed_loop';
      c.monitorSeenOk = true;
    }
    this._accountTime(c, now);
    this._setMode(c, mode, reason, now);
    const sub = this._substep(cfg);
    if (sub) for (const t of c.tanks) this._estIntegrate(c, t, now, cfg);
    let justArmed = false;
    if (n.mode !== 'tracking') {
      justArmed = this._trackPumpStart(c, cfg, now, ws, mode, disarmed);
      if (justArmed) ws = this._waterState(c, cfg, now); // the water gate was re-based on the pump start
    }
    if (mode === 'closed_loop' && !c.waterEstablishedAt && ws.ok) c.waterEstablishedAt = now;
    if (ws.ok) c.lastGoodFlowLph = this._smoothedFlowLph(now, n.flow_smooth_s, ws);
    // pH start delay restarts after every water stop: the cup is flushed again.
    if (ws.stopped || !ws.known) c.phFlowSince = null;
    else if (ws.ok && c.phFlowSince === null && c.waterEstablishedAt) c.phFlowSince = now;
    if (n.mode !== 'tracking' && (c.waterEstablishedAt || c.pumpArmed)) {
      this._updateSegment(c, cfg, now, ws);
      this._sampleZoneQuality(c, cfg, now, ws);
    }

    const due = now - c.lastEvalMs >= n.eval_s * 1000 - 1;
    if (due || justArmed || mode === 'hold' || ws.stopped) {
      this._evalNutrients(c, cfg, now, ws, mode);
      c.lastEvalMs = now;
    } else if (sub && mode === 'closed_loop') {
      this._perZoneCloseCheck(c, cfg, now, ws); // close decisions on every 1 s tick (open decisions keep eval_s)
    }
    this._drawWatch(c, cfg, now, ws, mode, disarmed);
    this._processPh(c, cfg, now, ws);
    this._evalAcid(c, cfg, now, ws, disarmed);
    this._checkActualStates(c, cfg, now);
    if (now - c.lastCheckpointMs >= CHECKPOINT_MS) {
      c.lastCheckpointMs = now;
      this._checkpoint(c, now);
    }
  }

  _accountTime(c, now) {
    if (c.mode && MODES.includes(c.mode)) c.modeMs[c.mode] += Math.max(0, now - c.lastAccountMs);
    c.lastAccountMs = now;
  }

  _setMode(c, mode, reason, now) {
    c.modeReason = reason;
    if (c.mode === mode) return;
    const prev = c.mode;
    if (prev === 'fallback') this._closeFallback(c, now, `closed loop resumed (${mode})`);
    c.mode = mode;
    c.modeSince = now;
    if (mode === 'fallback') {
      c.fallbackPeriods.push({ from: iso(now), to: null, reason });
      this._trip(c, 'fallback', now, reason);
      this.log.warn(`[DoseController] FALLBACK to the fixed schedule: ${reason}`);
      this._alert(c, 'fallback', 'warning', ALERT_SPECS.fallback(reason),
        { equipment_id: this._dosingEq(c) });
      c.fallbackAlerted = true;
    } else if (prev) {
      this.log.log(`[DoseController] mode ${prev} -> ${mode}${reason ? ` (${reason})` : ''}`);
    }
  }

  _closeFallback(c, now, why) {
    const p = c.fallbackPeriods[c.fallbackPeriods.length - 1];
    if (p && !p.to) {
      p.to = iso(now);
      const secs = Math.round((now - Date.parse(p.from)) / 1000);
      if (c.fallbackAlerted) {
        const spec = ALERT_SPECS.fallbackEnded(secs, why, p.reason);
        this._updateOpenAlert('dose_controller:fallback', {
          message: i18n.render('en', spec), messageKey: spec.$k, messageParams: spec.$p,
          severity: 'info',
        });
      }
    }
  }

  _dosingEq(c) {
    return (c.tanks[0] && c.tanks[0].equipment_id) || (c.phTank && c.phTank.equipment_id) || null;
  }

  // ─── nutrients ────────────────────────────────────────────────────────────

  _scheduleState(t, elapsedS) {
    let state = false;
    for (const ev of t.events) {
      if (ev.at_sec <= elapsedS + 1e-9) state = !!ev.state;
      else break;
    }
    return state;
  }

  _rateLps(t, ws) {
    return ws.dosingFresh && typeof t.rateLph === 'number' ? t.rateLph / 3600 : 0;
  }

  _evalNutrients(c, cfg, now, ws, mode) {
    const n = cfg.nutrients;
    const L = n.lookahead_s;
    const db = n.deadband_l;
    const elapsedS = (now - c.startedAt) / 1000;
    const endStop = n.stop_before_end_s > 0 && c.endsAt - now <= n.stop_before_end_s * 1000;
    const flowLps = ws.known ? ws.flow / 3600 : 0;
    const initial = mode === 'closed_loop' && !!c.waterEstablishedAt && !c.initialOpened && ws.ok;
    let reason = null;

    for (const t of c.tanks) {
      let want = t.open;
      let force = false;
      let why = null;
      t.target = t.ratio ? c.W / t.ratio : null;
      t.err = null;

      if (mode === 'hold') { want = false; force = true; why = c.paused && !this._disarmed(now) ? 'paused' : 'disarmed'; }
      else if (mode === 'waiting') { want = false; why = 'waiting for monitor'; }
      else if (ws.stopped) { want = false; force = true; why = 'no water'; reason = 'water stopped — nutrient valves closed'; }
      else if (ws.dry && !ws.known) { want = false; why = 'no water (monitor idle)'; }
      else if (mode === 'fallback') {
        if (ws.known && !ws.ok && !c.waterEstablishedAt) { want = false; why = 'waiting for water'; }
        else if (ws.known && !ws.ok) { want = want && true; why = 'low flow'; } // dip: hold, never open
        else { want = this._scheduleState(t, elapsedS); why = 'fixed schedule'; }
      } else if (c.pumpArmed && t.ratio && n.mode !== 'tracking' && !ws.ok) {
        // soft-switch zone, pump ON confirmed, flow still ramping: open now (water gate re-based on the pump start)
        const d = this._perZoneWant(c, cfg, t, now, ws);
        want = d.want; why = d.why === 'zone start' ? 'pump start' : d.why;
      } else if (!c.waterEstablishedAt) { want = false; why = 'waiting for water'; reason = 'waiting for water flow'; }
      else if (!ws.ok) { want = t.open; why = 'low flow'; } // short dip: hold, never open below min flow
      else if (!t.ratio) { want = this._scheduleState(t, elapsedS); why = 'fixed schedule (no ratio set)'; }
      else if (n.mode !== 'tracking') { const d = this._perZoneWant(c, cfg, t, now, ws); want = d.want; why = d.why; }
      else if (initial) { want = true; why = 'cycle start'; }
      else {
        const targetAhead = (c.W + flowLps * L) / t.ratio;
        const rate = t.open ? this._rateLps(t, ws) : 0;
        const err = targetAhead - t.V - rate * L;
        t.err = err;
        want = t.open ? !(err < -db) : err > db;
        why = t.open ? (want ? 'behind target' : 'target reached') : (want ? 'behind target' : 'ahead of target');
        // Physics limit: valve open for limited_after_s and still > 2 deadbands behind.
        const openFor = t.open && t.openSince !== null ? now - t.openSince : 0;
        if (t.open && openFor >= n.limited_after_s * 1000 && err > 2 * db) {
          if (!t.limited) { t.limited = true; t.limitedSince = now; }
        } else if (err <= db) {
          if (t.limited) { t.limitedMs += now - t.limitedSince; t.limited = false; t.limitedSince = null; }
        }
      }

      // automatic second try: the valve stays closed for min_off_s, then _drawWatch re-opens it
      if (t.retry && t.retry.phase === 'off') { want = false; why = 'redraw retry'; }
      if (endStop && want) { want = false; why = 'end of cycle'; }

      // Hard overdose cap (needs measured water + concentrate). Basis: nutrients.overdose_basis
      // ('delivered' = water so far, default; 'zone_expected' = water by the end of the current
      // zone — per-zone mode doses each zone's target ahead of its water, see _overdoseBasisW).
      const capW = this._overdoseBasisW(c, n);
      if (t.ratio && ws.dosingFresh && t.V > n.max_overdose_factor * (capW / t.ratio) + n.overdose_margin_l) {
        if (!t.overdoseActive) {
          t.overdoseActive = true;
          t.overdoseTrips++;
          const detail = `${t.name}: ${r2(t.V)} L dosed vs ${r2(capW / t.ratio)} L target (> ${n.max_overdose_factor}x)`;
          this._trip(c, 'overdose', now, detail);
          this._alert(c, `overdose:${t.tank_id}`, 'warning', ALERT_SPECS.overdose(t.name, r2(t.V), r2(capW / t.ratio), n.max_overdose_factor, r1(capW)),
            { equipment_id: t.equipment_id });
        }
        want = false; force = true; why = 'overdose cap';
      } else if (t.overdoseActive && t.ratio && t.V <= (capW / t.ratio)) {
        t.overdoseActive = false;
      }

      // Concentrate still drawn while commanded closed -> valve not closing.
      if (!t.open && !t.leakFlagged && t.vLeak >= n.leak_l) {
        t.leakFlagged = true;
        const detail = `${t.name} drew ${r2(t.vLeak)} L while commanded closed`;
        this._trip(c, 'valve_not_closing', now, detail);
        this._alert(c, `valve_leak:${t.tank_id}`, 'warning', ALERT_SPECS.valveLeak(t.name, r2(t.vLeak), t.channel),
          { equipment_id: t.equipment_id });
        this._command(c, t, false, 'dose_controller');
      }

      const switched = this._applyValve(c, t, want, { force, why, now, cfg });
      if (switched && want && why === 'pump start' && c.seg) c.seg.pumpStartOpen = true;
    }
    if (initial) c.initialOpened = true;
    c.lastReason = reason;
  }

  /**
   * Water basis of the overdose cap (see _evalNutrients): nutrients.overdose_basis
   * 'delivered' (default) = water so far; 'zone_expected' (per-zone mode only) =
   * water by the end of the current zone at the measured flow (no flow -> so far).
   */
  _overdoseBasisW(c, n) {
    if (n.overdose_basis !== 'zone_expected' || n.mode === 'tracking' || !c.seg || !(c.seg.expectedW > 0)) return c.W;
    return Math.max(c.W, c.seg.W0 + c.seg.expectedW);
  }

  // ─── per-zone litre targets (default nutrient mode) ───────────────────────

  _smoothedFlowLph(now, seconds, ws) {
    let sum = 0; let n = 0;
    for (let i = this._flowRing.length - 1; i >= 0; i--) {
      const [ms, v] = this._flowRing[i];
      if (ms < now - seconds * 1000) break;
      if (ms <= now) { sum += v; n++; }
    }
    return n ? sum / n : (ws.flow || 0);
  }

  /**
   * Dosed volume used for the per-zone decisions: the sub-step estimate (already
   * integrated up to this tick by step()) or, with substep_estimate off, the
   * legacy interpolation.
   */
  _vEst(t, now, ws) {
    const cfg = this.getConfig();
    return this._substep(cfg) ? this._estAbs(t) : this._vEstLegacy(t, now, ws);
  }

  /**
   * Zone plan of the triggering automation: per zone channel the ON actions
   * { delay, duration } plus the planned FLOW window inside the zone (seconds
   * after the zone opens), bounded by the irrigation pump's ON action(s):
   *   flowStart = pump start - zone start (0 when the pump already runs)
   *   flowEnd   = min(zone end, pump end) - zone start
   *   pumpStop  = pump end - zone start when a pump action ENDS inside this zone
   *               (soft-switch sequencing: pump OFF, then the valve), else null.
   * Today's structure (one pump action for the whole run) gives flowStart 0,
   * flowEnd = duration, pumpStop null except where the run itself ends —
   * i.e. exactly the previous behaviour.
   */
  _loadZonePlan(cfg, automationId) {
    const plan = {};
    if (!automationId) return plan;
    try {
      const row = this.db.prepare('SELECT actions FROM automations WHERE id = ?').get(automationId);
      const actions = row && row.actions ? JSON.parse(row.actions) : [];
      const n = cfg.nutrients;
      const eq = n.irrigation_equipment_id;
      const zones = new Set(n.zone_channels);
      const pumps = [];
      for (const a of Array.isArray(actions) ? actions : []) {
        if (!a || a.type !== 'control' || a.action !== 'on' || Number(a.equipment_id) !== eq) continue;
        const ch = parseInt(a.channel, 10);
        const dur = parseFloat(a.duration_seconds);
        const delay = parseFloat(a.delay_seconds) || 0;
        if (ch === n.pump_channel && dur > 0) pumps.push({ start: delay, end: delay + dur });
        if (!zones.has(ch) || !(dur > 0)) continue;
        (plan[ch] = plan[ch] || []).push({ delay, duration: dur });
      }
      for (const opts of Object.values(plan)) {
        for (const o of opts) {
          const zEnd = o.delay + o.duration;
          const overlap = pumps.filter(pw => pw.start < zEnd && pw.end > o.delay);
          if (!overlap.length) { o.flowStart = 0; o.flowEnd = o.duration; o.pumpStop = null; continue; }
          const start = Math.min(...overlap.map(pw => pw.start));
          const end = Math.max(...overlap.map(pw => pw.end));
          o.flowStart = Math.max(0, start - o.delay);
          o.flowEnd = Math.max(o.flowStart, Math.min(o.duration, end - o.delay));
          o.pumpStop = end <= zEnd + 2 ? end - o.delay : null;
        }
      }
    } catch (_) { /* unknown plan: live relay state decides */ }
    return plan;
  }

  _zoneNames(cfg) {
    const names = {};
    try {
      const row = this.db.prepare('SELECT register_mappings FROM equipment WHERE id = ?').get(cfg.nutrients.irrigation_equipment_id);
      for (const m of (row && row.register_mappings ? JSON.parse(row.register_mappings) : []) || []) {
        const ch = parseInt(m.register ?? m.address, 10);
        if (Number.isInteger(ch) && m.name) names[ch] = m.name;
      }
    } catch (_) { /* unnamed */ }
    return names;
  }

  /** The zone that most recently opened and is still ON (relay events of the irrigation board). */
  _currentZone(c, cfg, now) {
    if (now - c.zoneRead.at < ZONE_READ_GAP_MS && now >= c.zoneRead.at) return c.zoneRead.zone;
    c.zoneRead.at = now;
    const n = cfg.nutrients;
    let zone = null;
    try {
      const since = new Date(c.startedAt - 15000).toISOString().replace('T', ' ').slice(0, 19);
      const marks = n.zone_channels.map(() => '?').join(',');
      const rows = this.db.prepare(`SELECT channel, state, created_at FROM relay_events WHERE equipment_id = ? AND channel IN (${marks}) AND created_at >= ? ORDER BY id`)
        .all(n.irrigation_equipment_id, ...n.zone_channels, since);
      const latest = new Map();
      for (const r of rows) latest.set(r.channel, { on: r.state === 1, ms: parseTs(r.created_at) });
      for (const [ch, v] of latest) {
        if (v.on && v.ms !== null && v.ms <= now + 2000 && (!zone || v.ms > zone.openedAt || (v.ms === zone.openedAt && ch > zone.channel))) zone = { channel: ch, openedAt: v.ms };
      }
      if (zone) {
        const options = c.zonePlan[zone.channel] || [];
        const at = (zone.openedAt - c.startedAt) / 1000;
        let best = null;
        for (const o of options) if (!best || Math.abs(o.delay - at) < Math.abs(best.delay - at)) best = o;
        zone.plannedDurS = best ? best.duration : null;
        zone.softSwitch = !!(best && best.flowStart > 0); // the zone's pump starts after its valve
        if (best) {
          // Planned flow window, anchored on the relay ON time; a zone re-opened well
          // after its planned start (flow-watch retry) keeps the plan's absolute times.
          const anchor = at - best.delay > 15 ? c.startedAt + best.delay * 1000 : zone.openedAt;
          zone.flowStartMs = anchor + (best.flowStart ?? 0) * 1000;
          zone.flowEndMs = anchor + (best.flowEnd ?? best.duration) * 1000;
          zone.pumpStopMs = best.pumpStop === null || best.pumpStop === undefined ? null : anchor + best.pumpStop * 1000;
        }
      }
    } catch (_) { zone = null; }
    c.zoneRead.zone = zone;
    return zone;
  }

  _updateSegment(c, cfg, now, ws) {
    const n = cfg.nutrients;
    const z = this._currentZone(c, cfg, now);
    let key; let slot = 0; let plannedEndMs;
    if (z) {
      const dur = z.plannedDurS;
      const slots = dur ? n.slots_per_zone : 1;
      // the zone's planned FLOW window (pump ON inside the valve window); = the valve window today
      const fStart = z.flowStartMs ?? z.openedAt;
      const fEnd = z.flowEndMs ?? (dur ? z.openedAt + dur * 1000 : null);
      if (dur && slots > 1 && fEnd > fStart) {
        const len = (fEnd - fStart) / slots;
        slot = clamp(Math.floor((now - fStart) / len), 0, slots - 1);
        plannedEndMs = fStart + (slot + 1) * len;
      } else {
        plannedEndMs = fEnd !== null ? fEnd : c.endsAt;
      }
      key = `${z.channel}@${z.openedAt}#${slot}`;
    } else if (c.seg) {
      key = c.seg.key; plannedEndMs = c.seg.plannedEndMs; // gap between zones: keep the segment
    } else {
      key = 'cycle'; plannedEndMs = c.endsAt;
    }
    plannedEndMs = Math.min(plannedEndMs, c.endsAt); // the dose cycle ends with the pump
    if (!c.seg || c.seg.key !== key) {
      if (c.seg) this._finishSegment(c, cfg, now, ws);
      this._startSegment(c, cfg, now, ws, key, z, slot, plannedEndMs);
    }
    const seg = c.seg;
    seg.plannedEndMs = plannedEndMs;
    const water = c.W - seg.W0;
    const remainingS = Math.max(0, (plannedEndMs - now) / 1000);
    // pump just started in a soft-switch zone (flow still ramping): the zone's water will arrive —
    // assume the last measured flow (else the expected flow) over the planned pump time
    const flowLps = ws.ok ? this._smoothedFlowLph(now, n.flow_smooth_s, ws) / 3600
      : (c.pumpArmed ? (c.lastGoodFlowLph || this._expectedFlow(cfg)) / 3600 : 0);
    seg.water = water;
    seg.remainingS = remainingS;
    seg.expectedW = water + remainingS * flowLps;
    for (const t of c.tanks) {
      const st = seg.tanks[t.tank_id];
      if (!st || !t.ratio) continue;
      st.base = seg.expectedW / t.ratio;
      st.target = Math.max(0, st.base + st.carryIn);
      st.dosed = this._vEst(t, now, ws) - st.V0;
      st.limited = t.open && st.dosed + this._rateLps(t, ws) * remainingS < st.target - n.deadband_l;
    }
  }

  _startSegment(c, cfg, now, ws, key, z, slot, plannedEndMs) {
    const seg = {
      idx: c.zoneRecords.length + 1, key, channel: z ? z.channel : null,
      name: z ? (c.zoneNames[z.channel] || `Zone relay ${z.channel}`) : 'Cycle', slot,
      openedAt: z ? z.openedAt : now, startMs: now, plannedEndMs, plannedDurS: z ? z.plannedDurS : null,
      pumpStopMs: z && z.pumpStopMs !== undefined ? z.pumpStopMs : null, // planned pump OFF inside this zone (soft switch)
      W0: c.W, water: 0, expectedW: 0, remainingS: null, tanks: {},
      q: zoneStats.newAcc(), // per-zone feed EC/pH (see _sampleZoneQuality)
    };
    for (const t of c.tanks) {
      seg.tanks[t.tank_id] = {
        V0: this._vEst(t, now, ws), V0q: t.V, avg: { v: 0, s: 0 }, carryIn: c.carry[t.tank_id] || 0, base: 0, target: 0, dosed: 0,
        closedAt: null, closedBy: null, targetAtClose: null, reopens: 0, limited: false, openedAt: t.open ? now : null,
      };
    }
    c.seg = seg;
  }

  _finishSegment(c, cfg, now, ws) {
    const seg = c.seg;
    if (!seg) return;
    const n = cfg.nutrients;
    const water = c.W - seg.W0;
    const sub = this._substep(cfg);
    // a retry still in progress belongs to this zone: it ends with it
    for (const t of c.tanks) {
      if (t.retry && !t.retry.done && t.retry.zoneKey === seg.key) this._retryFinish(c, t, now, 'interrupted', 'zone ended');
    }
    const rec = {
      zone: seg.idx, channel: seg.channel, name: seg.name, slot: seg.slot,
      started_at: iso(seg.startMs), ended_at: iso(now), planned_s: seg.plannedDurS, water_l: r1(water), tanks: [],
    };
    if (seg.pumpStartOpen) rec.opened_at_pump_start = true;
    for (const t of c.tanks) {
      const st = seg.tanks[t.tank_id];
      if (!st || !t.ratio) continue;
      const base = water / t.ratio;
      const target = base + st.carryIn;
      // decisions + carry: the estimate (sub-step, or legacy); record: the counter (ground truth) + the estimate
      const dosed = this._vEst(t, now, ws) - st.V0;
      const dosedCounter = t.V - st.V0q;
      const short = target - dosed;
      const cantReach = st.closedBy !== 'target' && short > n.deadband_l && water > 0;
      const lim = (n.carry_clamp_pct / 100) * base;
      const carryOut = clamp(short, -lim, lim);
      c.carry[t.tank_id] = carryOut;
      rec.tanks.push({
        tank_id: t.tank_id, name: t.name, target_l: r2(target), dosed_l: r2(dosedCounter),
        ...(sub ? { dosed_est_l: r2(dosed) } : {}),
        carry_in_l: r2(st.carryIn), carry_out_l: r2(carryOut),
        opened_at_s: st.openedAt !== null ? r1((st.openedAt - seg.startMs) / 1000) : null,
        closed_at_s: st.closedAt !== null && st.closedBy ? r1((st.closedAt - seg.startMs) / 1000) : null,
        closed_by: st.closedBy, reopens: st.reopens, cant_reach: cantReach,
        ...(st.redrawRetry ? { redraw_retry: { ...st.redrawRetry } } : {}),
        ...(t.nd && t.nd.zoneKey === seg.key && t.nd.zoneAccumS >= 1 ? { not_drawing_s: r1(t.nd.zoneAccumS) } : {}),
      });
      if (cantReach) {
        t.cantReachZones = (t.cantReachZones || 0) + 1;
        this._trip(c, 'cant_reach', now, `${t.name}: ${r2(dosed)} of ${r2(target)} L in ${seg.name}${seg.slot ? ` slot ${seg.slot + 1}` : ''}`);
      }
    }
    Object.assign(rec, zoneStats.accFields(seg.q), { stats_source: 'live' });
    c.zoneRecords.push(rec);
    // A SEKO sample taken before this switch but first seen after it still belongs here.
    c.prevSeg = { rec, q: seg.q, startMs: seg.startMs, endMs: now };
    c.seg = null;
  }

  /**
   * Per-zone feed quality: each NEW SEKO sample (pH + EC from the sensor's
   * last_reading) is added to the zone whose window contains it, only while the
   * flow at the sample time is >= 50 % of expected (stagnant cup otherwise).
   */
  _sampleZoneQuality(c, cfg, now, ws) {
    const s = this._readPh(cfg, now, c);
    if (!s || !c.seg || s.tsMs === c.lastZoneSampleTs) return;
    c.lastZoneSampleTs = s.tsMs;
    let target = null;
    if (s.tsMs >= c.seg.startMs) target = c.seg.q;
    else if (c.prevSeg && s.tsMs >= c.prevSeg.startMs && s.tsMs <= c.prevSeg.endMs) target = c.prevSeg.q;
    if (!target) return;
    let flow = null;
    for (let i = this._flowRing.length - 1; i >= 0; i--) {
      const [ms, v] = this._flowRing[i];
      if (ms <= s.tsMs + 500) { flow = s.tsMs - ms <= 5000 ? v : null; break; }
    }
    if (flow === null && ws.known && Math.abs(now - s.tsMs) <= 2000) flow = ws.flow;
    // line flush: the first flush_seconds after the run's FIRST pump start (fallback: when water was first established)
    const fs = cfg.stats ? cfg.stats.flush_seconds : 0;
    const anchor = c.firstPumpMs !== null ? c.firstPumpMs : c.waterEstablishedAt;
    const flush = fs > 0 && anchor !== null && anchor !== undefined && s.tsMs < anchor + fs * 1000;
    zoneStats.addSample(target, {
      ph: s.value, ec: s.ec, flowLph: flow, expectedLph: ws.expected,
      phMin: cfg.ph.plausible_min, phMax: cfg.ph.plausible_max, flush, flushSeconds: fs,
    });
    if (target === (c.prevSeg && c.prevSeg.q)) Object.assign(c.prevSeg.rec, zoneStats.accFields(target));
  }

  _perZoneWant(c, cfg, t, now, ws) {
    const n = cfg.nutrients;
    const st = c.seg ? c.seg.tanks[t.tank_id] : null;
    if (!st) return { want: false, why: 'waiting for a zone' };
    // latency_s covers the OFF write + half a 1 s tick (the estimate removes the monitor's report delay)
    const rate = this._substep(cfg) ? this._estRateLps(c, t, now, cfg).lps : this._rateLps(t, ws);
    const dosed = st.dosed;
    if (t.open) {
      return dosed >= st.target - rate * n.latency_s ? { want: false, why: ZONE_TARGET } : { want: true, why: 'filling zone target' };
    }
    if (st.closedBy === 'target') {
      const grown = st.target - (st.targetAtClose ?? st.target);
      if (grown > n.reopen_margin_l && st.reopens < n.max_reopens_per_zone && st.target - dosed > n.deadband_l) return { want: true, why: 'zone target grew' };
      return { want: false, why: ZONE_TARGET };
    }
    return st.target - dosed > n.deadband_l ? { want: true, why: 'zone start' } : { want: false, why: ZONE_TARGET };
  }

  /** Per-zone close decisions between the eval_s evaluations (substep_estimate: every tick). */
  _perZoneCloseCheck(c, cfg, now, ws) {
    if (!c.seg || !ws.ok || ws.stopped || c.paused) return;
    for (const t of c.tanks) {
      if (!t.open || !t.ratio) continue;
      const d = this._perZoneWant(c, cfg, t, now, ws);
      if (!d.want) this._applyValve(c, t, false, { why: d.why, now, cfg });
    }
  }

  /**
   * Pump + zone relay events of this cycle (irrigation board), cached ~1 s.
   * { pump: { on, ms, confirmed } | null, zoneConfirmed: { [ch]: bool } };
   * also records the run's FIRST pump ON (c.firstPumpMs, flush window).
   * "Confirmed" = the ON write's read-back agreed (relay_events.confirmed = 1).
   */
  _pumpEvents(c, cfg, now) {
    if (now - c.pumpRead.at < ZONE_READ_GAP_MS && now >= c.pumpRead.at) return c.pumpRead.ev;
    c.pumpRead.at = now;
    const n = cfg.nutrients;
    let ev = null;
    try {
      const since = new Date(c.startedAt - 15000).toISOString().replace('T', ' ').slice(0, 19);
      const chans = [n.pump_channel, ...n.zone_channels.filter(ch => ch !== n.pump_channel)];
      const rows = this.db.prepare(`SELECT * FROM relay_events WHERE equipment_id = ? AND channel IN (${chans.map(() => '?').join(',')}) AND created_at >= ? ORDER BY id`)
        .all(n.irrigation_equipment_id, ...chans, since);
      const latest = new Map();
      for (const r of rows) {
        const ms = parseTs(r.created_at);
        if (ms === null || ms > now + 2000) continue;
        const on = r.state === 1;
        latest.set(r.channel, { on, ms, confirmed: on && r.confirmed === 1 });
        // the run's FIRST pump start: never a later zone's pump start (flush window anchor)
        if (r.channel === n.pump_channel && on && c.firstPumpMs === null && (c.waterEstablishedAt === null || ms <= c.waterEstablishedAt + 1000)) c.firstPumpMs = ms;
      }
      const zoneConfirmed = {};
      for (const ch of n.zone_channels) { const z = latest.get(ch); zoneConfirmed[ch] = !!(z && z.on && z.confirmed); }
      ev = { pump: latest.get(n.pump_channel) || null, zoneConfirmed };
    } catch (_) { ev = null; }
    c.pumpRead.ev = ev;
    return ev;
  }

  /**
   * open_at_pump_start: arm the current soft-switch zone when its pump ON write
   * is confirmed (zone valve confirmed ON, event <= 15 s old, after the valve).
   * Arming re-bases the water gate (c.lowFlowSince) on the pump start, so
   * ws.stopped closes every nutrient valve when the flow is not >= min_flow_pct
   * within no_water_s. Disarmed once the flow is established (normal rules) or
   * the gate tripped. c.pumpArmed additionally needs closed loop, not disarmed,
   * not paused and a known flow. Returns true on the tick a pump start arms.
   */
  _trackPumpStart(c, cfg, now, ws, mode, disarmed) {
    const n = cfg.nutrients;
    // look for the first pump ON until 5 s after water was established (then the flush anchor stays waterEstablishedAt)
    const flushOpen = c.firstPumpMs === null && cfg.stats && cfg.stats.flush_seconds > 0
      && (c.waterEstablishedAt === null || now - c.waterEstablishedAt < 5000);
    if (!n.open_at_pump_start) {
      c.pumpArmed = false;
      if (flushOpen) this._pumpEvents(c, cfg, now);
      return false;
    }
    const ev = this._pumpEvents(c, cfg, now);
    const p = ev ? ev.pump : null;
    let justArmed = false;
    if (p && p.on && (!c.pumpStart || c.pumpStart.eventMs !== p.ms)) {
      const z = this._currentZone(c, cfg, now);
      const eligible = !!(p.confirmed && z && z.softSwitch && ev.zoneConfirmed[z.channel] === true
        && p.ms >= z.openedAt - 1000 && now - p.ms <= PUMP_START_MAX_AGE_MS);
      c.pumpStart = { eventMs: p.ms, seenMs: now, channel: z ? z.channel : null, eligible, active: eligible, established: false, failed: false };
      if (eligible && !ws.ok) c.lowFlowSince = now; // water gate: no_water_s counted from this pump start
      justArmed = eligible;
    } else if (c.pumpStart && c.pumpStart.active && (!p || !p.on)) {
      c.pumpStart.active = false; // pump OFF again
    }
    const ps = c.pumpStart;
    if (ps && ps.active && !justArmed) {
      if (ws.ok) { ps.active = false; ps.established = true; } else if (ws.stopped) {
        ps.active = false; ps.failed = true;
        const zn = ps.channel !== null ? (c.zoneNames[ps.channel] || `Zone relay ${ps.channel}`) : 'zone';
        this._trip(c, 'pump_start_no_water', now, `${zn}: flow not >= ${n.min_flow_pct} % within ${n.no_water_s} s of the pump start — nutrient valves closed`);
      }
    }
    c.pumpArmed = !!(ps && ps.active && mode === 'closed_loop' && !disarmed && !c.paused && ws.known);
    return justArmed && c.pumpArmed;
  }

  _applyValve(c, t, want, { force = false, why = null, now, cfg, source = 'dose_controller' }) {
    if (want === t.open) return false;
    if (want && this._disarmed(now)) return false;
    if (!force && t.lastSwitchMs !== null) {
      const n = cfg.nutrients;
      const minMs = (t.open ? n.min_on_s : n.min_off_s) * 1000;
      if (now - t.lastSwitchMs < minMs) return false;
    }
    if (t.est && this._substep(cfg)) this._estIntegrate(c, t, now, cfg); // close the books on the old valve state
    const st = c.seg && t.kind === 'nutrient' ? c.seg.tanks[t.tank_id] : null;
    if (t.open) {
      t.openMs += now - t.openSince;
      t.openSince = null;
      t.closedAt = now;
      if (t.limited) { t.limitedMs += now - t.limitedSince; t.limited = false; t.limitedSince = null; }
      if (st) { st.closedAt = now; st.closedBy = why === ZONE_TARGET ? 'target' : (why || 'other'); st.targetAtClose = st.target; }
    } else {
      t.openSince = now;
      t.vLeak = 0;
      t.leakFlagged = false;
      if (st) { if (st.closedBy === 'target') st.reopens++; st.closedBy = null; if (st.openedAt === null) st.openedAt = now; }
    }
    t.open = want;
    t.lastSwitchMs = now;
    t.switches++;
    t.lastWhy = why;
    this._command(c, t, want, source);
    return true;
  }

  /** Serialised, guarded coil write through the scheduler (per valve, in order). */
  _command(c, target, state, source) {
    if (c.ctx.valveStates) c.ctx.valveStates[`${target.equipment_id}:${target.channel}`] = state;
    const run = async () => {
      if (state && (this.cycle !== c || c.ended || target.open !== true)) return 'dropped';
      try {
        const res = await c.ctx.write(target, state, {
          source,
          automationId: c.ctx.automationId ?? null,
          stillValid: () => this.cycle === c && !c.ended && !c.paused && target.open === true && !this._disarmed(this.now(), true),
        });
        target.writes++;
        return res;
      } catch (e) {
        target.writeErrors++;
        this.log.error(`[DoseController] ${state ? 'ON' : 'OFF'} write failed for ${target.name} (eq ${target.equipment_id} ch ${target.channel}): ${e.message}`);
        this._trip(c, 'write_failed', this.now(), `${target.name} ${state ? 'ON' : 'OFF'}: ${e.message}`);
        if (!c.ended && !c.aborting && c.ctx.abort) {
          c.aborting = true;
          setImmediate(() => {
            Promise.resolve(c.ctx.abort(`dose controller: coil write failed (${target.name} ch ${target.channel}): ${e.message}`))
              .catch(err => this.log.error(`[DoseController] abort failed: ${err.message}`));
          });
        }
        return 'failed';
      }
    };
    const p = (target.chain || Promise.resolve()).then(run, run);
    target.chain = p;
    this._track(p);
    return p;
  }

  // ─── tank not-drawing watch + automatic second try ─────────────────────────
  //
  // Incident 2026-09-29 07:30 (run 17): Tank D's valve opened at every zone start and
  // stayed open 709 s with water flowing, but its counter never moved — recorded only as
  // 'cant_reach' trips, nobody was told; micros delivered 0. Incident Tank B zone 3
  // (2026-09-26 17:00, 09-28 09:30/12:30/13:45): 0 L with its valve open; closing and
  // re-opening it in the next zone made it draw at once (~65-70 L/h).

  /** Valve read-back (15 s board poll) does not contradict "open": true / unknown = open. */
  _actualNotOff(c, t) {
    const states = c.relayRead.states;
    if (!states) return true;
    const a = states[t.channel] ?? states[String(t.channel)];
    if (a !== false) return true;
    // an OFF read taken before the valve was (re)opened says nothing
    return !(c.relayRead.pollMs !== null && t.lastSwitchMs !== null && c.relayRead.pollMs > t.lastSwitchMs + 3000);
  }

  /** Counter step within DRAWING_RECENT_MS, or (valve open) a fresh monitor rate >= DRAW_RATE_MIN_LPH. */
  _drawingNow(t, now, ws) {
    if (t.lastIncMs !== null && now - t.lastIncMs <= DRAWING_RECENT_MS && now >= t.lastIncMs - 1000) return true;
    return !!(t.open && ws.dosingFresh && typeof t.rateLph === 'number' && t.rateLph >= DRAW_RATE_MIN_LPH);
  }

  /** "Tank D (Fe EDDHA + Fetrilon Combi 2)" — data, never translated. */
  _tankLabel(t) {
    const parts = String(t.tank_name || '').split(' — ');
    return parts.length > 1 && parts[1].trim() ? `${t.name} (${parts.slice(1).join(' — ').trim()})` : t.name;
  }

  /** Local "YYYY-MM-DD HH:MM" in the farm zone (language-neutral clock text). */
  _localClock(ms) {
    try {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
        timeZone: this._tz(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
      return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
    } catch (_) { return new Date(ms).toISOString().slice(0, 16).replace('T', ' '); }
  }

  /**
   * When the tank last drew: in this run (last counter step), else from the monitor's
   * stored counter history (first sample at the current value after the last lower one).
   * Returns epoch ms or null.
   */
  _lastDrawMs(c, t) {
    if (t.lastIncMs !== null && t.V > 0) return t.lastIncMs;
    const eqId = this.dosing ? this.dosing.equipmentId : null;
    const n = t.monitorTank;
    const cur = t.lastConsumed;
    if (!eqId || n === null || n === undefined || typeof cur !== 'number') return null;
    try {
      const name = `Tank ${n} Consumed`;
      const since = new Date(this.now() - 14 * 86400000).toISOString();
      const lower = this.db.prepare('SELECT MAX(timestamp) AS ts FROM readings WHERE equipment_id = ? AND name = ? AND timestamp >= ? AND value < ?')
        .get(eqId, name, since, cur - 0.001);
      if (!lower || !lower.ts) return null;
      const reached = this.db.prepare('SELECT MIN(timestamp) AS ts FROM readings WHERE equipment_id = ? AND name = ? AND timestamp > ? AND value >= ?')
        .get(eqId, name, lower.ts, cur - 0.001);
      return reached && reached.ts ? parseTs(reached.ts) : null;
    } catch (_) { return null; }
  }

  /** Remaining planned flow time of the current zone (ms), bounded by the cycle end. */
  _zoneLeftMs(c, now) {
    const end = c.seg && c.seg.plannedEndMs ? Math.min(c.seg.plannedEndMs, c.endsAt) : c.endsAt;
    return end - now;
  }

  /**
   * Every 1 s tick: per nutrient tank, the open + flowing time without a draw; the
   * automatic second try; the not-drawing ALARM / no-tank-drawing caution; resolution.
   */
  _drawWatch(c, cfg, now, ws, mode, disarmed) {
    const n = cfg.nutrients;
    const flowOk = mode === 'closed_loop' && ws.ok && !ws.stopped && ws.dosingFresh && !c.paused && !disarmed;
    const segKey = c.seg ? c.seg.key : 'cycle';
    let drewNow = null;
    for (const t of c.tanks) {
      const nd = t.nd;
      const dt = nd.lastTickMs === null ? 0 : clamp((now - nd.lastTickMs) / 1000, 0, 5);
      nd.lastTickMs = now;
      if (nd.zoneKey !== segKey) { nd.zoneKey = segKey; nd.zoneAccumS = 0; }
      const stepped = nd.lastV !== null && t.V > nd.lastV + 1e-9;
      nd.lastV = t.V;
      const rateDraw = t.open && ws.dosingFresh && typeof t.rateLph === 'number' && t.rateLph >= DRAW_RATE_MIN_LPH;
      if (stepped || rateDraw) {
        if (nd.accumS > 0 || nd.alarmOpen) this._drawResumed(c, t, now, n);
        if (!drewNow) drewNow = t;
        nd.accumS = 0; nd.zoneAccumS = 0; nd.stretchMs = null; nd.lastDrawMs = now;
      } else if (flowOk && t.open && t.metered && this._actualNotOff(c, t)) {
        if (nd.stretchMs === null) nd.stretchMs = now - dt * 1000;
        nd.accumS += dt; nd.zoneAccumS += dt; nd.openFlowS += dt;
        nd.maxAccumS = Math.max(nd.maxAccumS, nd.accumS);
      }
    }
    if (drewNow && c.noneDrawing.open) {
      c.noneDrawing.open = false;
      this._trip(c, 'none_drawing_resolved', now, `${drewNow.name} is drawing`);
      const spec = ALERT_SPECS.noneDrawingResolved();
      this._updateOpenAlert(`dose_controller:none_drawing:${c.runId ?? c.token}`, {
        message: i18n.render('en', spec), messageKey: spec.$k, messageParams: spec.$p, severity: 'info',
      });
    }
    for (const t of c.tanks) this._retryStep(c, cfg, t, now, ws, mode, disarmed);
    if (!n.not_drawing_alarm) return;
    // ALARM per tank (another tank drew during this tank's stretch) / ONE caution (none drew)
    const T = n.not_drawing_seconds;
    const due = c.tanks.filter(t => t.open && t.metered && !this._isAcid(t) && t.nd.accumS >= T
      && !(t.retry && !t.retry.done)); // the retry window suspends the alarm, never beyond it
    if (!due.length) return;
    const proven = (t) => c.tanks.some(u => u !== t && u.metered && ((u.lastIncMs !== null && t.nd.stretchMs !== null && u.lastIncMs >= t.nd.stretchMs) || this._drawingNow(u, now, ws)));
    const lone = due.filter(t => !proven(t));
    for (const t of due) if (proven(t) && !t.nd.alarmOpen) this._notDrawingAlarm(c, t, now, n);
    if (lone.length && !c.noneDrawing.open && !c.tanks.some(t => this._drawingNow(t, now, ws))) this._noneDrawingCaution(c, lone, now, n);
  }

  _isAcid(t) {
    return t.kind === 'acid' || t.role === 'ph_down' || t.role === 'ph_up';
  }

  _notDrawingAlarm(c, t, now, n) {
    const nd = t.nd;
    const secs = Math.round(nd.accumS);
    const lastMs = this._lastDrawMs(c, t);
    const last = lastMs !== null ? this._localClock(lastMs) : ALERT_SPECS.lastDrawUnknown();
    const spec = ALERT_SPECS.notDrawing(this._tankLabel(t), secs, last);
    nd.alarmOpen = true;
    nd.alarms++;
    if (!nd.alarmed) { nd.alarmed = true; nd.alarmAt = now; }
    nd.resolvedAt = null;
    this._trip(c, 'not_drawing', now, `${t.name}: valve open ${secs} s with water flowing, counter did not move (last draw ${lastMs !== null ? iso(lastMs) : 'unknown'})`);
    this._alert(c, this._notDrawingKey(c, t), 'critical', spec, { equipment_id: t.equipment_id });
    this.log.warn(`[DoseController] ${t.name} NOT DRAWING: open ${secs} s with water, no counter step`);
    if (n.not_drawing_telegram && nd.notifies < MAX_NOT_DRAWING_NOTIFY) {
      nd.notifies++;
      this._notify(TELEGRAM_TITLES.notDrawing(t.name), spec, 'critical');
    }
  }

  _notDrawingKey(c, t) {
    return `not_drawing:${t.tank_id}:${c.runId ?? c.token}`;
  }

  /** The tank drew again: resolve its open alarm (and the no-tank-drawing caution). */
  _drawResumed(c, t, now, n) {
    const nd = t.nd;
    if (nd.alarmOpen) {
      const secs = Math.round(nd.accumS);
      nd.alarmOpen = false;
      nd.resolvedAt = now;
      this._trip(c, 'not_drawing_resolved', now, `${t.name} drew again after ${secs} s`);
      const spec = ALERT_SPECS.notDrawingResolved(t.name, secs);
      this._updateOpenAlert(`dose_controller:${this._notDrawingKey(c, t)}`, {
        message: i18n.render('en', spec), messageKey: spec.$k, messageParams: spec.$p, severity: 'info',
      });
    }
  }

  _noneDrawingCaution(c, lone, now, n) {
    const secs = Math.round(Math.min(...lone.map(t => t.nd.accumS)));
    const names = lone.map(t => t.name).join(', ');
    c.noneDrawing.open = true;
    if (c.noneDrawing.alerted) {
      // one caution per run: a repeat re-opens the same row without a new Telegram
      this._trip(c, 'none_drawing', now, `${names}: open ${secs} s with water, no tank drew`);
      this._alert(c, `none_drawing:${c.runId ?? c.token}`, 'warning', ALERT_SPECS.noneDrawing(names, secs), { equipment_id: this._dosingEq(c) });
      return;
    }
    c.noneDrawing.alerted = true;
    c.noneDrawing.alertedAt = now;
    const spec = ALERT_SPECS.noneDrawing(names, secs);
    this._trip(c, 'none_drawing', now, `${names}: open ${secs} s with water, no tank drew — dosing monitor / venturi manifold`);
    this._alert(c, `none_drawing:${c.runId ?? c.token}`, 'warning', spec, { equipment_id: this._dosingEq(c) });
    if (n.not_drawing_telegram) this._notify(TELEGRAM_TITLES.noneDrawing(), spec, 'warning');
  }

  /**
   * Automatic second try (nutrients.redraw_retry). Phases: off (closed through the
   * normal close path, source dose_controller_retry; held closed min_off_s) -> verify
   * (re-opened through the guarded ON path; drawing within redraw_verify_s = 'drew')
   * -> done. At most one per tank per zone; never the acid tank.
   */
  _retryStep(c, cfg, t, now, ws, mode, disarmed) {
    const n = cfg.nutrients;
    const r = t.retry;
    const zoneKey = c.seg ? c.seg.key : 'cycle';
    if (r && !r.done) {
      const blocked = disarmed ? 'disarmed' : c.paused ? 'paused' : mode !== 'closed_loop' ? `mode ${mode}`
        : (ws.stopped || !ws.ok) ? 'no water' : r.zoneKey !== zoneKey ? 'zone ended'
          : c.endsAt - now < 5000 ? 'end of cycle' : null;
      if (r.phase === 'off') {
        if (blocked) { this._retryFinish(c, t, now, 'skipped', blocked); return; }
        if (now - r.offAt < n.min_off_s * 1000) return;
        // re-open: guarded ON path (guardEnergise / validateWriteSet, arming re-checked before the coil write)
        r.phase = 'verify';
        r.reopenAt = now;
        r.v0 = t.V;
        const ok = this._applyValve(c, t, true, { force: true, why: 'redraw retry', now, cfg, source: 'dose_controller_retry' });
        if (!ok) this._retryFinish(c, t, now, 'skipped', 'reopen refused');
        return;
      }
      // verify
      const fresh = this.dosing && this.dosing.receivedMs > r.reopenAt;
      const drew = t.V > r.v0 + 1e-9 || (fresh && t.open && typeof t.rateLph === 'number' && t.rateLph >= DRAW_RATE_MIN_LPH);
      if (drew) { this._retryFinish(c, t, now, 'drew'); return; }
      if (!t.open) { this._retryFinish(c, t, now, 'interrupted', t.lastWhy || 'valve closed'); return; }
      if (blocked) { this._retryFinish(c, t, now, 'interrupted', blocked); return; }
      if (now - r.reopenAt >= n.redraw_verify_s * 1000) this._retryFinish(c, t, now, 'no_draw');
      return;
    }
    if (!n.redraw_retry || this._isAcid(t) || !t.metered || !t.open) return;
    if (t.nd.zoneAccumS < n.redraw_retry_after_s) return;
    if (mode !== 'closed_loop' || disarmed || c.paused || !ws.ok || ws.stopped || !ws.dosingFresh) return;
    const st = c.seg ? c.seg.tanks[t.tank_id] : null;
    const count = st ? (st.redrawRetries || 0) : t.retries.filter(x => x.zoneKey === zoneKey).length;
    if (count >= 1) return;
    if (!c.tanks.some(u => u !== t && u.open && u.metered && this._drawingNow(u, now, ws))) return;
    if (this._zoneLeftMs(c, now) < n.redraw_min_zone_left_s * 1000) {
      if (st && !st.redrawSkipLogged) {
        st.redrawSkipLogged = true;
        st.redrawRetry = { at: iso(now), result: 'skipped', detail: 'zone end' };
        this._trip(c, 'redraw_retry_skipped', now, `${t.name}: < ${n.redraw_min_zone_left_s} s of the zone left`);
      }
      return;
    }
    const secs = Math.round(t.nd.zoneAccumS);
    t.retry = { phase: 'off', at: now, offAt: now, zoneKey, st, secs, done: false, zone: c.seg ? c.seg.name : null };
    if (st) { st.redrawRetries = (st.redrawRetries || 0) + 1; st.redrawRetry = { at: iso(now), result: 'pending', not_drawing_s: secs }; }
    this._trip(c, 'redraw_retry', now, `${t.name}: open ${secs} s with water and no draw${c.seg ? ` in ${c.seg.name}` : ''} — valve closed for a re-open`);
    this.log.warn(`[DoseController] ${t.name} not drawing ${secs} s — automatic second try (close, re-open)`);
    this._applyValve(c, t, false, { force: true, why: 'redraw retry', now, cfg, source: 'dose_controller_retry' });
  }

  _retryFinish(c, t, now, result, detail = null) {
    const r = t.retry;
    if (!r || r.done) return;
    r.done = true;
    r.phase = 'done';
    r.result = result;
    const drewAfter = result === 'drew' && r.reopenAt ? r1((now - r.reopenAt) / 1000) : null;
    const rec = { at: iso(r.at), result, ...(drewAfter !== null ? { drew_after_s: drewAfter } : {}), ...(detail ? { detail } : {}), not_drawing_s: r.secs };
    if (r.st) r.st.redrawRetry = rec;
    t.retries.push({ zoneKey: r.zoneKey, zone: r.zone, ...rec });
    if (result === 'drew') {
      this._trip(c, 'redraw_retry_ok', now, `${t.name} drew after a valve re-open (${drewAfter} s)`);
      this.log.log(`[DoseController] ${t.name} drew after a valve re-open (${drewAfter} s)`);
    } else if (result === 'no_draw') {
      this._trip(c, 'redraw_retry_failed', now, `${t.name} did not draw after a valve re-open`);
    } else {
      this._trip(c, 'redraw_retry_skipped', now, `${t.name}: second try ${result}${detail ? ` (${detail})` : ''}`);
    }
  }

  /**
   * Telegram. `title` / `body` are i18n specs. Tests inject deps.notify (receives the
   * English render + the specs); production renders in the configured telegram_language.
   */
  _notify(title, body, severity) {
    const clean = (s) => String(s).replace(/[_*`[\]]/g, ' ');
    if (this._notifyFn) {
      try { this._notifyFn(clean(i18n.render('en', title)), clean(i18n.render('en', body)), severity, { titleSpec: title, bodySpec: body }); } catch (e) { this.log.error(`[DoseController] notify failed: ${e.message}`); }
      return;
    }
    this._track(Promise.resolve().then(async () => {
      const { telegramService } = require('./TelegramService');
      if (!telegramService.isConfigured()) return;
      const lang = typeof telegramService.getLanguage === 'function' ? telegramService.getLanguage() : 'en';
      await telegramService.sendAlert(clean(i18n.render(lang, title)), clean(i18n.render(lang, body)), severity);
    }).catch(e => this.log.error(`[DoseController] Telegram failed: ${e.message}`)));
  }

  // ─── pH ───────────────────────────────────────────────────────────────────

  _readPh(cfg, now, c) {
    if (now - c.phRead.at < PH_READ_GAP_MS && now >= c.phRead.at) return c.phRead.value;
    c.phRead.at = now;
    let value = null;
    try {
      const row = this.db.prepare('SELECT last_reading, last_communication FROM equipment WHERE id = ?').get(cfg.ph.sensor_equipment_id);
      if (row) {
        const lr = row.last_reading ? JSON.parse(row.last_reading) : null;
        const m = lr && lr.values && lr.values[cfg.ph.sensor_metric];
        const v = m && typeof m === 'object' ? Number(m.value) : Number(m);
        const em = lr && lr.values && lr.values[cfg.ph.ec_metric];
        const ec = em && typeof em === 'object' ? Number(em.value) : Number(em);
        const tsMs = parseTs(row.last_communication);
        if (m !== undefined && m !== null && Number.isFinite(v) && tsMs !== null) {
          value = { value: v, tsMs, ec: em !== undefined && em !== null && Number.isFinite(ec) ? ec : null };
        }
      }
    } catch (_) { value = null; }
    c.phRead.value = value;
    return value;
  }

  _phDelayEnd(c, cfg) {
    if (!c.waterEstablishedAt || c.phFlowSince === null) return Infinity;
    return Math.max(c.phFlowSince, c.startedAt) + cfg.ph.start_delay_s * 1000;
  }

  /**
   * Classify the latest feed-pH sample. Only while water flows and after the
   * start delay: idle / flush samples are stagnant cup liquid (never used,
   * never alerted on).
   */
  _processPh(c, cfg, now, ws) {
    const p = cfg.ph;
    const a = c.acid;
    const s = this._readPh(cfg, now, c);
    a.sample = s;
    if (!ws.known || ws.stopped || !c.waterEstablishedAt || c.phFlowSince === null) { a.frozen = null; if (!a.faultLatched) a.sampleState = 'idle'; return; }
    const delayEnd = this._phDelayEnd(c, cfg);
    if (now < delayEnd) { if (!a.faultLatched) a.sampleState = 'start_delay'; return; }
    if (a.faultLatched) { a.sampleState = a.faultLatched; }
    if (!s || s.tsMs < delayEnd) {
      if (now - delayEnd > p.stale_s * 1000) this._sensorStale(c, now, `no pH sample since the start delay ended ${Math.round((now - delayEnd) / 1000)} s ago`);
      else if (!a.faultLatched) a.sampleState = 'waiting';
      return;
    }
    const age = now - s.tsMs;
    if (age > p.stale_s * 1000) { this._sensorStale(c, now, `last pH sample ${Math.round(age / 1000)} s old`); return; }
    if (a.lastTs === s.tsMs) { if (a.sampleState === 'stale' && !a.faultLatched) a.sampleState = 'ok'; return; }
    a.lastTs = s.tsMs;
    if (!(s.value >= p.plausible_min && s.value <= p.plausible_max)) {
      this._sensorFault(c, now, 'implausible', `pH ${s.value} outside ${p.plausible_min}-${p.plausible_max}`);
      return;
    }
    a.valid = { value: s.value, tsMs: s.tsMs };
    a.recent.push({ value: s.value, tsMs: s.tsMs });
    while (a.recent.length && a.recent[0].tsMs < s.tsMs - 5 * p.window_s * 1000) a.recent.shift();
    const st = a.stats;
    st.min = st.min === null ? s.value : Math.min(st.min, s.value);
    st.max = st.max === null ? s.value : Math.max(st.max, s.value);
    st.sum += s.value; st.n++; st.last = s.value;
    if (s.ec !== null && s.ec !== undefined && s.ec > 0) {
      const e = a.ecStats;
      e.min = e.min === null ? s.ec : Math.min(e.min, s.ec);
      e.max = e.max === null ? s.ec : Math.max(e.max, s.ec);
      e.sum += s.ec; e.n++; e.last = s.ec;
    }
    // Floor: any sample below it closes the acid at once and trims the integral.
    // It LATCHES (acid off for the rest of the cycle + alarm) when confirmed by
    // floor_confirm_samples consecutive samples, or when a sample is 0.15 below.
    // (A 3 s pulse into the 20-50 L buffer swings the cup +/-0.3 pH for a strong
    // acid; a single ripple trough is not a sustained low feed pH.)
    if (s.value < p.floor_ph && !a.tripped) {
      a.floorLow++;
      if (a.open) this._acidClose(c, now, 'pH below floor');
      a.integral *= 0.8;
      if (a.floorLow >= p.floor_confirm_samples || s.value < p.floor_ph - 0.15) {
        a.tripped = true;
        const detail = `pH ${s.value} < floor ${p.floor_ph}${a.floorLow > 1 ? ` (${a.floorLow} consecutive samples)` : ''}`;
        this._trip(c, 'ph_floor', now, detail);
        this._alert(c, 'ph_floor', 'critical', ALERT_SPECS.phFloor(s.value, p.floor_ph, r1(this._acidUsedS(c, now))),
          { equipment_id: c.phTank ? c.phTank.equipment_id : null });
      } else {
        this._trip(c, 'ph_floor_touch', now, `pH ${s.value} < floor ${p.floor_ph} (one sample): acid closed, integral trimmed 20 %`);
      }
    } else if (s.value >= p.floor_ph) {
      a.floorLow = 0;
    }
    if (a.frozen && Math.abs(s.value - a.frozen.value) < 1e-6) {
      if (s.tsMs - a.frozen.sinceMs >= p.frozen_s * 1000) {
        this._sensorFault(c, now, 'frozen', `pH stuck at ${s.value} for ${Math.round((s.tsMs - a.frozen.sinceMs) / 1000)} s while water flows`);
        return;
      }
    } else {
      a.frozen = { value: s.value, sinceMs: s.tsMs };
    }
    if (!a.faultLatched) a.sampleState = 'ok';
  }

  _sensorStale(c, now, detail) {
    const a = c.acid;
    if (!a.faultLatched) a.sampleState = 'stale';
    if (a.open) this._acidClose(c, now, 'pH sample stale');
    if (!a.staleAlerted) {
      a.staleAlerted = true;
      this._trip(c, 'ph_stale', now, detail);
      this._alert(c, 'ph_sensor', 'warning', ALERT_SPECS.phNotVerifiable(detail),
        { equipment_id: c.cfgAtStart.ph.sensor_equipment_id });
    }
  }

  _sensorFault(c, now, kind, detail) {
    const a = c.acid;
    if (a.faultLatched) return;
    a.faultLatched = kind;
    a.sampleState = kind;
    if (a.open) this._acidClose(c, now, `pH sensor ${kind}`);
    this._trip(c, `ph_${kind}`, now, detail);
    this._alert(c, 'ph_sensor', 'warning', ALERT_SPECS.phSensorFault(kind, detail),
      { equipment_id: c.cfgAtStart.ph.sensor_equipment_id });
  }

  _acidUsedS(c, now) {
    const a = c.acid;
    return (a.usedMs + (a.open && a.openAt !== null ? now - a.openAt : 0)) / 1000;
  }

  _acidDayUsedS(c, now) {
    if (!c.dayBase || now - c.dayBase.at > DAY_BASE_CACHE_MS || now < c.dayBase.at) {
      let s = 0;
      try {
        s = this.db.prepare('SELECT COALESCE(SUM(acid_s), 0) AS s FROM dose_controller_runs WHERE local_date = ? AND id <> ?')
          .get(c.localDate, c.runId ?? -1).s || 0;
      } catch (_) { s = 0; }
      c.dayBase = { at: now, s };
    }
    return c.dayBase.s + this._acidUsedS(c, now);
  }

  _acidGate(c, cfg, now, ws, disarmed) {
    const p = cfg.ph;
    const a = c.acid;
    if (!c.phTank) return 'no pH Down tank bound to the dosing board';
    if (!cfg.enabled) return 'controller switched off';
    if (!p.enabled) return 'pH control switched off';
    if (disarmed) return 'automations disarmed';
    if (c.paused) return `dosing paused — ${c.paused.reason}`;
    if (!ws.known) return 'flow not verifiable';
    if (!ws.ok) return 'no water flow';
    if (!c.waterEstablishedAt) return 'waiting for water';
    if (now < this._phDelayEnd(c, cfg)) return 'start delay (cup flush)';
    if (c.endsAt - now <= p.stop_before_end_s * 1000) return 'end of cycle';
    const pumpStop = this._plannedPumpStop(c, now);
    if (pumpStop !== null && pumpStop - now <= p.stop_before_end_s * 1000) return 'planned pump stop ahead';
    if (a.tripped) return `pH fell below ${p.floor_ph} — locked out this cycle`;
    if (a.faultLatched) return `pH sensor ${a.faultLatched}`;
    if (a.sampleState === 'stale') return 'pH sample stale';
    if (a.sampleState !== 'ok' || !a.valid) return 'waiting for a pH sample';
    const aboveBand = a.valid.value > p.setpoint + p.deadband;
    // a budget smaller than one minimum pulse is a reached cap
    if (!a.open && p.max_acid_s_per_cycle - this._acidUsedS(c, now) < p.min_pulse_s) { this._capAlert(c, now, 'cycle', aboveBand); return `acid cap reached (${p.max_acid_s_per_cycle} s this cycle)`; }
    if (!a.open && p.max_acid_s_per_day - this._acidDayUsedS(c, now) < p.min_pulse_s) { this._capAlert(c, now, 'day', aboveBand); return `daily acid cap reached (${p.max_acid_s_per_day} s)`; }
    return null;
  }

  /**
   * Planned pump OFF of the current pumping segment (soft-switch sequencing:
   * each zone has its own pump action), or null. Acid gets the same
   * stop_before_end_s margin before every planned pump stop as before the end
   * of the cycle (the next pump start restarts the start delay via phFlowSince).
   * Ignored once > 15 s past (the plan is then unreliable).
   */
  _plannedPumpStop(c, now) {
    const ps = c.seg ? c.seg.pumpStopMs : null;
    if (ps === null || ps === undefined || ps >= c.endsAt || now > ps + 15000) return null;
    return ps;
  }

  _capAlert(c, now, which, aboveBand) {
    const a = c.acid;
    if (a.capAlerted) return;
    a.capAlerted = true;
    const p = c.cfgAtStart.ph;
    const detail = which === 'cycle' ? `${p.max_acid_s_per_cycle} s per cycle` : `${p.max_acid_s_per_day} s per day`;
    this._trip(c, which === 'cycle' ? 'acid_cap_cycle' : 'acid_cap_day', now, detail);
    if (aboveBand) {
      this._alert(c, `acid_cap:${which}`, 'warning', ALERT_SPECS.acidCap(which, which === 'cycle' ? p.max_acid_s_per_cycle : p.max_acid_s_per_day, a.valid.value, p.setpoint),
        { equipment_id: c.phTank ? c.phTank.equipment_id : null });
    }
  }

  _evalAcid(c, cfg, now, ws, disarmed) {
    const p = cfg.ph;
    const a = c.acid;
    const gate = this._acidGate(c, cfg, now, ws, disarmed);
    a.gate = gate;
    if (gate) {
      if (a.open) this._acidClose(c, now, gate);
      a.windowStart = null;
      return;
    }
    if (a.open && now >= a.closeAt) this._acidClose(c, now, 'pulse complete');
    if (a.open && now - a.openAt > (p.window_s * p.max_duty + 2) * 1000) {
      this._acidClose(c, now, 'max pulse length exceeded');
      this._trip(c, 'acid_max_on', now, 'pulse exceeded window x max_duty');
    }
    const winMs = p.window_s * 1000;
    // First 5 s of a zone: the switch-over dip is still coming — anchor the window after it.
    if (a.windowStart === null && c.seg && now - c.seg.startMs < 5000) return;
    if (a.windowStart === null || now >= a.windowStart + winMs) {
      a.windowStart = a.windowStart === null ? now : a.windowStart + winMs * Math.floor((now - a.windowStart) / winMs);
      if (!a.open) this._decideWindow(c, cfg, now);
    }
  }

  _decideWindow(c, cfg, now) {
    const p = cfg.ph;
    const a = c.acid;
    if (a.skipUntil !== null && now < a.skipUntil) {
      a.lastDecision = { at: iso(now), skipped: 'floor touched — one window skipped' };
      return;
    }
    // Mean of the valid samples of the last window: cancels the PWM ripple of the
    // previous pulse (samples every 10 s land at different phases of a 30 s window).
    const win = a.recent.filter(x => x.tsMs > now - p.window_s * 1000);
    const ph = win.length ? win.reduce((acc, x) => acc + x.value, 0) / win.length : a.valid.value;
    const e = ph - p.setpoint;
    const eEff = Math.abs(e) > p.deadband ? e : 0;
    if (!(a.saturated && eEff > 0)) a.integral = clamp(a.integral + p.ki * eEff * p.window_s, 0, p.max_duty);
    const raw = p.kp * eEff + a.integral;
    const duty = clamp(raw, 0, p.max_duty);
    a.saturated = raw > p.max_duty;
    let pulse = duty * p.window_s;
    const budget = Math.min(
      p.max_acid_s_per_cycle - this._acidUsedS(c, now),
      p.max_acid_s_per_day - this._acidDayUsedS(c, now),
      (c.endsAt - now) / 1000 - p.stop_before_end_s,
      (() => { const ps = this._plannedPumpStop(c, now); return ps === null ? Infinity : (ps - now) / 1000 - p.stop_before_end_s; })(),
    );
    let budgetLimited = false;
    if (pulse > budget) { pulse = Math.max(0, budget); budgetLimited = true; if (eEff > 0) a.saturated = true; }
    // Do not start a pulse the zone switch-over dip (~0.5-3.5 s after the relay switch)
    // would cut: none in the first 5 s of a zone, and end it >= 1 s before the planned
    // zone end (ignored once the zone is > 10 s overdue — the plan is then unreliable).
    if (c.seg) {
      if (c.seg.plannedEndMs && c.seg.plannedEndMs < c.endsAt && now < c.seg.plannedEndMs + 10000) {
        const toSwitch = (c.seg.plannedEndMs - now) / 1000 - 1;
        if (pulse > toSwitch) pulse = Math.max(0, toSwitch);
      }
    }
    if (pulse < p.min_pulse_s) pulse = 0;
    a.decisions++;
    a.lastDecision = { at: iso(now), ph: r3(ph), samples: win.length || 1, error: r3(e), integral: r3(a.integral), duty: r3(pulse / p.window_s), pulse_s: r1(pulse), budget_limited: budgetLimited };
    if (pulse > 0) this._acidOpen(c, now, pulse);
  }

  _acidOpen(c, now, pulseS) {
    const a = c.acid;
    if (!c.phTank || a.open || this._disarmed(now)) return;
    a.open = true;
    a.openAt = now;
    a.closeAt = now + pulseS * 1000;
    a.pulses++;
    c.phTank.open = true;
    c.phTank.lastSwitchMs = now;
    // Actual ON time is measured from the coil writes, not from these decisions:
    // an OFF that queues behind other traffic on the shared gateway keeps the
    // valve open longer than planned (incident 2026-09-26 15:32:35: 12 s pulse,
    // OFF landed after 17 s). See _acidClose.
    const pulse = { onReqMs: now, onOk: false, onDoneMs: null };
    a.pulse = pulse;
    const onP = this._command(c, c.phTank, true, 'ph_controller');
    if (onP && typeof onP.then === 'function') {
      onP.then((res) => { if (res === true) { pulse.onOk = true; pulse.onDoneMs = this.now(); } }, () => {});
    }
    if (this.autoTick) {
      if (c.acidTimer) clearTimeout(c.acidTimer);
      c.acidTimer = setTimeout(() => { try { this.step(); } catch (_) { /* next tick */ } }, Math.ceil(pulseS * 1000) + 5);
      if (c.acidTimer.unref) c.acidTimer.unref();
    }
  }

  _acidClose(c, now, why) {
    const a = c.acid;
    if (!a.open) return;
    const plannedMs = now - a.openAt;
    a.usedMs += plannedMs;
    a.open = false;
    a.openAt = null;
    a.closeAt = null;
    a.lastCloseWhy = why;
    const pulse = a.pulse || null;
    a.pulse = null;
    if (c.phTank) {
      c.phTank.open = false;
      c.phTank.lastSwitchMs = now;
      const offP = this._command(c, c.phTank, false, 'ph_controller');
      if (pulse && offP && typeof offP.then === 'function') {
        offP.then((res) => { if (res === true) this._accountPulseOverrun(c, pulse, plannedMs, this.now()); }, () => {});
      }
    }
  }

  /**
   * Charge a late OFF to the acid budgets. actual = OFF write done - ON write done
   * (both coil writes, so the normal write latency cancels out); anything beyond
   * the planned pulse by more than PULSE_OVERRUN_TOLERANCE_MS is added to usedMs
   * (cycle + daily caps) and recorded as a 'pulse_overrun' trip. A pulse whose ON
   * never reached the coil is not charged.
   */
  _accountPulseOverrun(c, pulse, plannedMs, offDoneMs) {
    if (!pulse || !pulse.onOk || pulse.onDoneMs === null) return 0;
    const a = c.acid;
    const actualMs = offDoneMs - pulse.onDoneMs;
    const overMs = actualMs - plannedMs;
    if (!(overMs > PULSE_OVERRUN_TOLERANCE_MS)) return 0;
    a.usedMs += overMs;
    a.overrunMs = (a.overrunMs || 0) + overMs;
    a.overruns = (a.overruns || 0) + 1;
    const detail = `planned ${r1(plannedMs / 1000)} s, valve open ${r1(actualMs / 1000)} s (OFF late by ${r1(overMs / 1000)} s) — ${r1(overMs / 1000)} s charged to the acid budget`;
    this._trip(c, 'pulse_overrun', offDoneMs, detail);
    this.log.warn(`[DoseController] pH Down pulse overrun: ${detail}`);
    return overMs;
  }

  // ─── actual state (read-back via the 15 s board poll) ──────────────────────

  _checkActualStates(c, cfg, now) {
    if (now - c.relayRead.at < RELAY_READ_GAP_MS && now >= c.relayRead.at) return;
    c.relayRead.at = now;
    const eqId = this._dosingEq(c);
    if (!eqId) return;
    let states = null;
    let pollMs = null;
    try {
      const row = this.db.prepare('SELECT last_reading, last_communication FROM equipment WHERE id = ?').get(eqId);
      if (row) {
        pollMs = parseTs(row.last_communication);
        states = (JSON.parse(row.last_reading || '{}') || {}).relayStates || null;
      }
    } catch (_) { states = null; }
    const fresh = pollMs !== null && now - pollMs <= 40000;
    c.relayRead.states = fresh ? states : null;
    c.relayRead.pollMs = pollMs;
    if (!fresh || !states) return;
    const valves = [...c.tanks, ...(c.phTank ? [c.phTank] : [])];
    for (const v of valves) {
      const actual = states[v.channel] ?? states[String(v.channel)];
      if (typeof actual !== 'boolean') continue;
      // Commanded OFF, board still reads ON in a poll taken >= 3 s after the command: re-send OFF once.
      const settled = v.lastSwitchMs === null ? pollMs > c.startedAt + 3000 : pollMs > v.lastSwitchMs + 3000;
      if (!v.open && actual === true && settled && !v.offRewritten) {
        v.offRewritten = true;
        const detail = `${v.name} (ch ${v.channel}) reads ON while commanded OFF`;
        this._trip(c, 'valve_mismatch', now, detail);
        this._alert(c, `valve_mismatch:${v.equipment_id}:${v.channel}`, 'warning', ALERT_SPECS.valveMismatch(v.name, v.channel), { equipment_id: v.equipment_id });
        this._command(c, v, false, v.kind === 'acid' ? 'ph_controller' : 'dose_controller');
      }
    }
  }

  // ─── records / alerts ─────────────────────────────────────────────────────

  _trip(c, kind, now, detail) {
    if (c.trips.length >= MAX_TRIPS) return;
    c.trips.push({ kind, at: iso(now), detail: detail || null });
  }

  /** `spec` = i18n descriptor (ALERT_SPECS); the stored English message is its English render. */
  _alert(c, key, severity, spec, { equipment_id = null } = {}) {
    try {
      const message = i18n.render('en', spec);
      this._createAlert({
        severity, source: 'dose_controller', equipment_id,
        automation_id: c && c.ctx ? c.ctx.automationId ?? null : null,
        fingerprint: `dose_controller:${key}`,
        message, messageKey: spec.$k, messageParams: spec.$p,
      });
      if (c) c.alerts.add(key);
    } catch (e) {
      this.log.error(`[DoseController] alert failed: ${e.message}`);
    }
  }

  _summary(c, now) {
    const established = c.waterEstablishedAt;
    const flowingMs = established ? Math.max(1, now - established) : null;
    const tanks = c.tanks.map(t => {
      const openMs = t.openMs + (t.open && t.openSince !== null ? now - t.openSince : 0);
      const limitedMs = t.limitedMs + (t.limited && t.limitedSince !== null ? now - t.limitedSince : 0);
      const targetL = t.ratio ? c.W / t.ratio : null;
      const achieved = t.V > 0 ? c.W / t.V : null;
      const openPct = flowingMs ? Math.min(100, (openMs / flowingMs) * 100) : null;
      return {
        tank_id: t.tank_id, name: t.name, tank_name: t.tank_name, channel: t.channel,
        ratio_target: t.ratio, target_l: r2(targetL), dosed_l: r2(t.V),
        achieved_ratio: achieved === null ? null : Math.round(achieved),
        deviation_pct: targetL ? r1(((t.V - targetL) / targetL) * 100) : null,
        switches: t.switches, open_s: r1(openMs / 1000), open_pct: r1(openPct), limited_s: r1(limitedMs / 1000),
        physics_limited: !!(t.ratio && targetL > 1 && t.V < targetL * 0.95 && openPct !== null && openPct >= 90),
        overdose_trips: t.overdoseTrips, counter_resets: t.counterResets, write_errors: t.writeErrors,
        cant_reach_zones: t.cantReachZones || 0,
        ...(this._substep(c.cfgAtStart) && t.est.A0 !== null ? { dosed_est_l: r2(this._estAbs(t) - t.est.A0) } : {}),
        ...(t.nd && (t.nd.maxAccumS >= 1 || t.nd.alarmed) ? {
          not_drawing: {
            max_s: r1(t.nd.maxAccumS), alarms: t.nd.alarms,
            alarm_at: iso(t.nd.alarmAt), resolved_at: iso(t.nd.resolvedAt), open: !!t.nd.alarmOpen,
          },
        } : {}),
        ...(t.retries && t.retries.length ? { redraw_retries: t.retries.map(({ zoneKey, ...x }) => x) } : {}),
      };
    });
    const a = c.acid;
    const acidS = this._acidUsedS(c, now);
    return {
      water_l: r1(c.W),
      tanks,
      modes: {
        closed_loop_s: r1(c.modeMs.closed_loop / 1000), fallback_s: r1(c.modeMs.fallback / 1000),
        hold_s: r1(c.modeMs.hold / 1000), waiting_s: r1(c.modeMs.waiting / 1000),
        fallback_periods: c.fallbackPeriods, water_integrated_l: r1(c.waterByFlow), water_glitches: c.waterGlitches,
        options: {
          substep_estimate: !!c.cfgAtStart.nutrients.substep_estimate,
          open_at_pump_start: !!c.cfgAtStart.nutrients.open_at_pump_start,
          flush_seconds: c.cfgAtStart.stats ? c.cfgAtStart.stats.flush_seconds : 0,
          first_pump_at: iso(c.firstPumpMs),
        },
      },
      ph: {
        min: a.stats.min, max: a.stats.max, avg: a.stats.n ? r2(a.stats.sum / a.stats.n) : null, last: a.stats.last, samples: a.stats.n,
      },
      ec: {
        min: a.ecStats.min, max: a.ecStats.max, avg: a.ecStats.n ? r1(a.ecStats.sum / a.ecStats.n) : null, last: a.ecStats.last, samples: a.ecStats.n,
        range_overrides: c.ecOverrides || 0,
      },
      trim: c.trim,
      zones: zoneStats.decorateZones(c.zoneRecords, {
        expectedLph: this._expectedFlow(c.cfgAtStart), final: !!c.endInfo,
        endSource: c.endInfo ? c.endInfo.source : null, endReason: c.endInfo ? c.endInfo.reason : null,
        plan: c.zonePlan, startedAtMs: c.startedAt, names: c.zoneNames,
      }),
      acid_s: r1(acidS),
      acid_est_l: r2((acidS / 60) * c.cfgAtStart.ph.acid_lpm_estimate),
      acid_pulses: a.pulses,
      acid_overrun_s: r1((a.overrunMs || 0) / 1000),
      acid_overruns: a.overruns || 0,
      trips: c.trips,
    };
  }

  _checkpoint(c, now) {
    if (!c.runId) return;
    const s = this._summary(c, now);
    try {
      this.db.prepare(`
        UPDATE dose_controller_runs SET water_l = ?, tanks_json = ?, modes_json = ?, ph_min = ?, ph_avg = ?, ph_max = ?, ph_last = ?, ph_samples = ?,
          ec_min = ?, ec_avg = ?, ec_max = ?, ec_last = ?, ec_samples = ?, trim_json = ?, zones_json = ?,
          acid_s = ?, acid_est_l = ?, acid_pulses = ?, trips_json = ?, duration_s = ?, updated_at = ? WHERE id = ?
      `).run(s.water_l, JSON.stringify(s.tanks), JSON.stringify(s.modes), s.ph.min, s.ph.avg, s.ph.max, s.ph.last, s.ph.samples,
        s.ec.min, s.ec.avg, s.ec.max, s.ec.last, s.ec.samples, JSON.stringify(s.trim), JSON.stringify(s.zones),
        s.acid_s, s.acid_est_l, s.acid_pulses, JSON.stringify(s.trips), r1((now - c.startedAt) / 1000), iso(now), c.runId);
    } catch (e) {
      this.log.error(`[DoseController] checkpoint failed: ${e.message}`);
    }
  }

  _finalize(c, now, status, reason) {
    const s = this._summary(c, now);
    this._runZeroCheck(c, now, s);
    for (const t of s.tanks) {
      if (t.physics_limited) {
        this._alert(c, `underdose:${t.tank_id}`, 'warning',
          ALERT_SPECS.underdose(t.name, t.ratio_target, t.open_pct, t.achieved_ratio ?? '—', t.dosed_l, s.water_l),
          { equipment_id: this._dosingEq(c) });
      }
    }
    if (c.runId) {
      try {
        this.db.prepare(`
          UPDATE dose_controller_runs SET ended_at = ?, status = ?, end_reason = ?, duration_s = ?, water_l = ?, tanks_json = ?, modes_json = ?,
            ph_min = ?, ph_avg = ?, ph_max = ?, ph_last = ?, ph_samples = ?, ec_min = ?, ec_avg = ?, ec_max = ?, ec_last = ?, ec_samples = ?, trim_json = ?, zones_json = ?,
            acid_s = ?, acid_est_l = ?, acid_pulses = ?, trips_json = ?, updated_at = ?
          WHERE id = ?
        `).run(iso(now), status, reason, r1((now - c.startedAt) / 1000), s.water_l, JSON.stringify(s.tanks), JSON.stringify(s.modes),
          s.ph.min, s.ph.avg, s.ph.max, s.ph.last, s.ph.samples, s.ec.min, s.ec.avg, s.ec.max, s.ec.last, s.ec.samples, JSON.stringify(s.trim), JSON.stringify(s.zones),
          s.acid_s, s.acid_est_l, s.acid_pulses, JSON.stringify(s.trips), iso(now), c.runId);
      } catch (e) {
        this.log.error(`[DoseController] could not finalise run ${c.runId}: ${e.message}`);
      }
    }
    return c.runId ? this.getRun(c.runId) : { status, ...s };
  }

  /**
   * Run summary: a metered nutrient tank whose counter did not move for the whole run
   * while its valve was open with water for >= not_drawing_seconds -> "delivered 0 L".
   * Telegram only when no live not-drawing alarm went out for that tank this run.
   */
  _runZeroCheck(c, now, s) {
    const n = c.cfgAtStart.nutrients;
    if (!n.not_drawing_alarm || !(c.W > 0)) return;
    for (const t of c.tanks) {
      if (!t.metered || this._isAcid(t) || t.V > 1e-9 || !t.nd || t.nd.openFlowS < n.not_drawing_seconds) continue;
      const openS = Math.round(t.nd.openFlowS);
      const spec = ALERT_SPECS.runZero(this._tankLabel(t), openS, r1(c.W));
      this._trip(c, 'run_zero', now, `${t.name} delivered 0 L (valve open ${openS} s with water, ${r1(c.W)} L of water)`);
      this._alert(c, `run_zero:${t.tank_id}:${c.runId ?? c.token}`, 'warning', spec, { equipment_id: t.equipment_id });
      // Telegram only when nothing about this tank went out live (its alarm / the no-tank-drawing caution)
      if (n.not_drawing_telegram && !t.nd.notifies && !c.noneDrawing.alerted) this._notify(TELEGRAM_TITLES.runZero(t.name), spec, 'warning');
      const row = s.tanks.find(x => x.tank_id === t.tank_id);
      if (row) row.delivered_zero = true;
    }
    s.trips = c.trips;
  }

  // ─── read API ─────────────────────────────────────────────────────────────

  formatRun(row) {
    if (!row) return null;
    const j = (s, d) => { try { return s ? JSON.parse(s) : d; } catch (_) { return d; } };
    const run = {
      id: row.id, cycle_log_id: row.cycle_log_id, program_id: row.program_id, automation_id: row.automation_id,
      automation_name: row.automation_name || null,
      started_at: row.started_at, ended_at: row.ended_at, local_date: row.local_date, status: row.status, end_reason: row.end_reason,
      duration_s: row.duration_s, water_l: row.water_l, tanks: j(row.tanks_json, []), modes: j(row.modes_json, null),
      ph: { min: row.ph_min, avg: row.ph_avg, max: row.ph_max, last: row.ph_last, samples: row.ph_samples },
      ec_us: { min: row.ec_min, avg: row.ec_avg, max: row.ec_max, last: row.ec_last, samples: row.ec_samples },
      trim: j(row.trim_json, null),
      zones: j(row.zones_json, []),
      acid_s: row.acid_s, acid_est_l: row.acid_est_l, acid_est_unverified: true, acid_pulses: row.acid_pulses,
      trips: j(row.trips_json, []),
    };
    return this._withZoneStats(run, row);
  }

  /**
   * Per-zone EC/pH, status and ratio on every run read. Runs recorded before
   * these fields existed get them computed from stored readings (read-only,
   * cached per run + updated_at); a running run is decorated without the
   * end-of-run rules.
   */
  _withZoneStats(run, row) {
    try {
      const cfg = this.getConfig();
      const expectedLph = this._expectedFlow(cfg);
      let zones = Array.isArray(run.zones) ? run.zones : [];
      const final = run.status !== 'running';
      const missing = zones.some(z => !z.not_run && !('samples' in z));
      if (missing && final && zones.length) {
        const key = `${run.id}|${row.updated_at || ''}`;
        if (!this._zoneStatsCache) this._zoneStatsCache = new Map();
        let stats = this._zoneStatsCache.get(key);
        if (stats === undefined) {
          stats = zoneStats.statsFromHistory(this.db, run, {
            sensorEquipmentId: cfg.ph.sensor_equipment_id, phMetric: cfg.ph.sensor_metric, ecMetric: cfg.ph.ec_metric,
            expectedLph, phMin: cfg.ph.plausible_min, phMax: cfg.ph.plausible_max,
          });
          if (this._zoneStatsCache.size > 100) this._zoneStatsCache.clear();
          this._zoneStatsCache.set(key, stats);
        }
        if (stats) {
          let i = 0;
          zones = zones.map(z => (z.not_run ? z : ('samples' in z ? (i++, z) : { ...z, ...stats[i++], stats_source: 'history' })));
        }
      }
      const { zones: decorated, visits } = zoneStats.analyseZones(zones, {
        expectedLph, final, endReason: run.end_reason,
        endSource: zoneStats.isShutdownEnd({ endReason: run.end_reason }) ? zoneStats.SHUTDOWN_SOURCE : null,
      });
      // zones = segment records (API as before); zone_visits = one row per zone visit (dashboard table)
      const out = { ...run, zones: decorated, zone_visits: visits };
      out.zone_totals = zoneStats.zoneTotals(out, visits);
      out.ratio_target = (() => {
        const r = (run.tanks || []).map(t => t.ratio_target).filter(x => x > 0);
        return r.length && r.every(x => x === r[0]) ? r[0] : (r.length ? r : null);
      })();
      return out;
    } catch (e) {
      this.log.error(`[DoseController] zone stats for run ${run.id} failed: ${e.message}`);
      return run;
    }
  }

  getRun(id) {
    try {
      return this.formatRun(this.db.prepare('SELECT r.*, a.name AS automation_name FROM dose_controller_runs r LEFT JOIN automations a ON a.id = r.automation_id WHERE r.id = ?').get(id));
    } catch (_) { return null; }
  }

  lastRun() {
    try {
      return this.formatRun(this.db.prepare("SELECT r.*, a.name AS automation_name FROM dose_controller_runs r LEFT JOIN automations a ON a.id = r.automation_id WHERE r.status <> 'running' ORDER BY r.started_at DESC, r.id DESC LIMIT 1").get());
    } catch (_) { return null; }
  }

  listRuns({ limit = 50, offset = 0, from = null, to = null, date = null } = {}) {
    const where = [];
    const params = [];
    if (from) { where.push('r.started_at >= ?'); params.push(from); }
    if (to) { where.push('r.started_at <= ?'); params.push(to); }
    if (date) { where.push('r.local_date = ?'); params.push(date); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM dose_controller_runs r ${w}`).get(...params).n;
    const rows = this.db.prepare(`SELECT r.*, a.name AS automation_name FROM dose_controller_runs r LEFT JOIN automations a ON a.id = r.automation_id ${w} ORDER BY r.started_at DESC, r.id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    return { total, runs: rows.map(r => this.formatRun(r)) };
  }

  getStatus(now = this.now()) {
    const cfg = this.getConfig();
    const base = {
      enabled: cfg.enabled,
      ph_enabled: cfg.ph.enabled,
      evaluated_at: iso(now),
      setpoints: {
        ratio: cfg.nutrients.ratio, ph_setpoint: cfg.ph.setpoint, ph_deadband: cfg.ph.deadband, ph_floor: cfg.ph.floor_ph,
        acid_cap_cycle_s: cfg.ph.max_acid_s_per_cycle, acid_cap_day_s: cfg.ph.max_acid_s_per_day,
      },
      warnings: cfg.ph.window_s < cfg.ph.tau_s + cfg.ph.dead_time_s ? [`pH window ${cfg.ph.window_s} s is shorter than the plant lag (tau ${cfg.ph.tau_s} s + dead time ${cfg.ph.dead_time_s} s)`] : [],
    };
    const c = this.cycle;
    if (!c) {
      let dayUsed = null;
      try {
        dayUsed = this.db.prepare('SELECT COALESCE(SUM(acid_s), 0) AS s FROM dose_controller_runs WHERE local_date = ?').get(this._localDate(now)).s;
      } catch (_) { dayUsed = null; }
      return { ...base, running: false, mode: cfg.enabled ? 'idle' : 'off', acid_day_used_s: r1(dayUsed), last_run: this.lastRun() };
    }
    const ws = this._waterState(c, cfg, now);
    const s = this._summary(c, now);
    const a = c.acid;
    const relay = c.relayRead.states;
    const actualOf = (v) => {
      const x = relay ? (relay[v.channel] ?? relay[String(v.channel)]) : undefined;
      return typeof x === 'boolean' ? x : null;
    };
    let names = {};
    try {
      const pr = c.ctx.programId ? this.db.prepare('SELECT name FROM fertigation_dose_programs WHERE id = ?').get(c.ctx.programId) : null;
      const au = c.ctx.automationId ? this.db.prepare('SELECT name FROM automations WHERE id = ?').get(c.ctx.automationId) : null;
      names = { program_name: pr ? pr.name : null, automation_name: au ? au.name : null };
    } catch (_) { names = {}; }
    const sample = a.sample;
    return {
      ...base,
      running: true,
      mode: c.mode || 'waiting',
      mode_reason: c.modeReason || c.lastReason,
      reason: c.lastReason,
      cycle: {
        run_id: c.runId, cycle_log_id: c.ctx.cycleLogId, program_id: c.ctx.programId, automation_id: c.ctx.automationId, ...names,
        started_at: iso(c.startedAt), ends_at: iso(c.endsAt),
        elapsed_s: Math.max(0, Math.round((now - c.startedAt) / 1000)), remaining_s: Math.max(0, Math.round((c.endsAt - now) / 1000)),
        water_established_at: iso(c.waterEstablishedAt),
      },
      water: {
        litres: s.water_l, flow_lph: ws.flow === null ? null : Math.round(ws.flow), expected_lph: Math.round(ws.expected),
        min_flow_lph: Math.round(ws.threshold), flow_ok: ws.ok, known: ws.known,
        flow_age_s: ws.flowAgeMs === null ? null : Math.round(ws.flowAgeMs / 1000),
        dosing_age_s: ws.dosingAgeMs === null ? null : Math.round(ws.dosingAgeMs / 1000),
        healthy: ws.healthy, fresh: ws.fresh, dosing_fresh: ws.dosingFresh,
      },
      nutrient_mode: cfg.nutrients.mode,
      zone: c.seg ? {
        index: c.seg.idx, channel: c.seg.channel, name: c.seg.name, slot: c.seg.slot,
        slots: c.seg.plannedDurS ? cfg.nutrients.slots_per_zone : 1,
        started_at: iso(c.seg.startMs), planned_end: iso(c.seg.plannedEndMs),
        remaining_s: c.seg.remainingS === null ? null : Math.round(c.seg.remainingS),
        water_l: r1(c.seg.water), expected_water_l: r1(c.seg.expectedW),
        planned_pump_stop: iso(c.seg.pumpStopMs),
      } : null,
      zones_done: c.zoneRecords.length,
      pump_start: c.pumpStart ? {
        at: iso(c.pumpStart.eventMs), seen_at: iso(c.pumpStart.seenMs), channel: c.pumpStart.channel,
        eligible: c.pumpStart.eligible, armed: !!c.pumpArmed, established: c.pumpStart.established, failed: c.pumpStart.failed,
      } : null,
      paused: c.paused ? { reason: c.paused.reason, since: iso(c.paused.since) } : null,
      tanks: s.tanks.map((st, i) => {
        const t = c.tanks[i];
        const zs = c.seg ? c.seg.tanks[t.tank_id] : null;
        return {
          ...st, valve: t.open ? 'open' : 'closed', actual: actualOf(t), error_l: r2(t.err),
          limited: !!(t.limited || (zs && zs.limited)),
          zone_target_l: zs ? r2(zs.target) : null, zone_dosed_l: zs ? r2(zs.dosed) : null, zone_closed_by: zs ? zs.closedBy : null,
          zone_dosed_counter_l: zs && zs.V0q !== undefined ? r2(t.V - zs.V0q) : null,
          est_source: this._substep(cfg) ? t.est.source : null,
          rate_lph: ws.dosingFresh ? t.rateLph : null, why: t.lastWhy,
          drawing: {
            state: !t.metered || !ws.dosingFresh ? 'unknown' : this._drawingNow(t, now, ws) ? 'drawing'
              : (t.open && t.nd.accumS >= 1 ? 'not_drawing' : 'idle'),
            not_drawing_s: r1(t.nd.accumS), alarm: !!t.nd.alarmOpen,
            last_draw_at: iso(t.lastIncMs),
          },
          redraw_retry: t.retry ? { phase: t.retry.phase, result: t.retry.result || null, at: iso(t.retry.at) } : null,
        };
      }),
      ph: {
        enabled: cfg.ph.enabled && !!c.phTank,
        tank: c.phTank ? { tank_id: c.phTank.tank_id, name: c.phTank.name, channel: c.phTank.channel, actual: actualOf(c.phTank) } : null,
        value: sample ? sample.value : null,
        sample_at: sample ? iso(sample.tsMs) : null,
        age_s: sample ? Math.round((now - sample.tsMs) / 1000) : null,
        sample_state: a.sampleState,
        setpoint: cfg.ph.setpoint, deadband: cfg.ph.deadband, floor: cfg.ph.floor_ph,
        tripped: a.tripped, fault: a.faultLatched,
        gate: a.gate,
        min: s.ph.min, avg: s.ph.avg, max: s.ph.max, samples: s.ph.samples,
        ec_us: sample && sample.ec !== null && sample.ec !== undefined ? sample.ec : null,
        ec: s.ec,
        acid: {
          open: a.open, used_s: s.acid_s, cap_s: cfg.ph.max_acid_s_per_cycle,
          day_used_s: r1(this._acidDayUsedS(c, now)), day_cap_s: cfg.ph.max_acid_s_per_day,
          pulses: a.pulses, est_l: s.acid_est_l, est_unverified: true,
          overrun_s: s.acid_overrun_s, overruns: s.acid_overruns,
          integral: r3(a.integral), last_decision: a.lastDecision,
        },
      },
      modes: s.modes,
      trips: s.trips,
      trim: c.trim,
      last_run: this.lastRun(),
    };
  }
}

let singleton = null;
function getDoseController() {
  if (!singleton) {
    const { db } = require('../utils/database');
    const { createAlert, updateOpenAlert } = require('../utils/alertBroadcast');
    const { automationArmingService } = require('./AutomationArmingService');
    const { getMqttIngestService } = require('./MqttIngestService');
    const { modbusPollingService } = require('./ModbusPollingService');
    const closeWriter = async (equipmentId, channel, source) => {
      const { modbusTcpClient } = require('./ModbusTcpClient');
      const { logRelayEvent } = require('./RelayEventLogger');
      const eq = db.prepare('SELECT address, slave_id, write_only FROM equipment WHERE id = ?').get(equipmentId);
      if (!eq) return;
      const [host, portStr] = String(eq.address || '').split(':');
      const port = parseInt(portStr, 10);
      if (!host || !Number.isFinite(port)) return;
      if (eq.write_only) await modbusTcpClient.writeSingleCoilFireAndForget(host, port, eq.slave_id || 1, channel, false);
      else await modbusTcpClient.writeSingleCoil(host, port, eq.slave_id || 1, channel, false);
      logRelayEvent(equipmentId, channel, false, source, null);
    };
    singleton = new DoseController({
      db, createAlert, updateOpenAlert, arming: automationArmingService, mqtt: getMqttIngestService(),
      poller: modbusPollingService, closeWriter,
    });
    const ctl = singleton;
    modbusPollingService.setAutoRangeHintProvider((eqId, metric) => ctl.ecRangeHint(eqId, metric));
  }
  return singleton;
}

module.exports = {
  DoseController,
  localizeStatus,
  localizeRun,
  localizeReason,
  reasonSpec,
  ALERT_SPECS,
  computeEcTrim,
  getDoseController,
  validateConfigUpdate,
  mergeConfig,
  crossCheck,
  DEFAULT_CONFIG,
  CONFIG_KEY,
};
