/**
 * FertigationSystemView — the fertigation system as SenseHub already knows it,
 * derived LIVE from its own config and records (operator 2026-09-28: "the system
 * already is aware since it's monitoring it"). Read-only: shown in the crop
 * profile with a "from live system" label and fed to the fertilizer advisor.
 *
 *   tanks        fertigation_tanks + current mixture + analysis, dosing relay,
 *                stock level, last refill, configured and MEASURED venturi draw
 *   injection    venturi per tank on a solenoid (relay) valve, pH Down line
 *   dosing       dose program(s) used by the enabled irrigation automations,
 *                DoseController mode + target ratio per tank + pH setpoint / limits
 *   sections     zone valves + pump / mixing pump (relay labels) and measured flow
 *   schedule     enabled daily irrigation automations: minutes per section (pump ON
 *                time inside each zone window), soft-switch lead / lag, totals
 *   protection   flow watch / pump protection flags + episodes of the last 7 days
 *   feed_trend   per run: water, feed EC / pH, acid seconds, achieved ratio
 *
 * Only DB reads; no live service is started or queried.
 */

const { db: defaultDb } = require('../utils/database');
const FC = require('./FeedCalculator');

const DAY_MS = 86400000;
const r1 = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 10) / 10);
const r2 = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100);

function parseJson(v, dflt) {
  if (v === null || v === undefined || v === '') return dflt;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return dflt; }
}

function median(arr) {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function coilLabels(eq) {
  const out = {};
  for (const m of parseJson(eq && eq.register_mappings, [])) {
    if (!m) continue;
    if (m.type && m.type !== 'coil') continue;
    out[Number(m.register)] = m.name || m.label || null;
  }
  return out;
}

/** Overlap in seconds of [a0, a1) and [b0, b1). */
function overlap(a0, a1, b0, b1) { return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)); }

/**
 * One scheduled automation → per-section irrigation plan.
 * minutes = pump ON time inside the zone valve window; lead = pump start − valve open,
 * lag = valve close − pump stop (soft switch: valve opens before and closes after the pump).
 */
function planFromActions(actions, { equipmentId, zoneChannels, pumpChannel }) {
  const on = (actions || []).filter(a => a && (a.action === 'on' || a.type === 'control') && Number(a.equipment_id) === Number(equipmentId) && a.action !== 'off');
  const win = (a) => { const d = Number(a.delay_seconds) || 0; return [d, d + (Number(a.duration_seconds) || 0)]; };
  const pumps = on.filter(a => Number(a.channel) === Number(pumpChannel)).map(win);
  const zones = [];
  for (const a of on) {
    const ch = Number(a.channel);
    if (!zoneChannels.includes(ch)) continue;
    const [z0, z1] = win(a);
    let pumpS = 0; let first = null; let last = null;
    for (const [p0, p1] of pumps) {
      const ov = overlap(z0, z1, p0, p1);
      if (ov > 0) { pumpS += ov; first = first === null ? Math.max(z0, p0) : Math.min(first, Math.max(z0, p0)); last = last === null ? Math.min(z1, p1) : Math.max(last, Math.min(z1, p1)); }
    }
    zones.push({
      channel: ch,
      valve_s: z1 - z0,
      pump_s: pumps.length ? pumpS : null,
      minutes: r2((pumps.length ? pumpS : z1 - z0) / 60),
      lead_s: first !== null ? r1(first - z0) : null,
      lag_s: last !== null ? r1(z1 - last) : null,
      start_offset_s: z0,
    });
  }
  return zones.sort((a, b) => a.start_offset_s - b.start_offset_s);
}

class FertigationSystemView {
  constructor(deps = {}) {
    this._db = deps.db || null;
    this.now = deps.now || (() => Date.now());
  }

  get db() { return this._db || defaultDb; }

  build({ profile = null, nowMs = this.now() } = {}) {
    const db = this.db;
    const cfg = FC.doseConfig(db);
    const n = cfg.nutrients || {};
    const ph = cfg.ph || {};
    const irrEqId = n.irrigation_equipment_id || 1;
    const zoneChannels = (Array.isArray(n.zone_channels) ? n.zone_channels : []).map(Number);
    const pumpChannel = Number(n.pump_channel || 1);
    const irrEq = db.prepare('SELECT id, name, register_mappings FROM equipment WHERE id = ?').get(irrEqId) || null;
    const irrLabels = coilLabels(irrEq);
    const since = new Date(nowMs - 7 * DAY_MS).toISOString();

    // ---- tanks ----
    const tanks = FC.loadCurrentTanks(db);
    const chanRows = db.prepare('SELECT equipment_id, channel, flow_rate, flow_unit FROM relay_channel_config').all();
    const chanFlow = (eq, ch) => { const r = chanRows.find(x => x.equipment_id === eq && x.channel === ch); return r && r.flow_rate > 0 ? r.flow_rate : null; };
    const dosingEqIds = [...new Set(tanks.map(t => t.equipment_id).filter(Boolean))];
    const dosingLabels = {};
    for (const id of dosingEqIds) dosingLabels[id] = coilLabels(db.prepare('SELECT register_mappings FROM equipment WHERE id = ?').get(id));
    const lastRefill = db.prepare('SELECT tank_id, MAX(refilled_at) AS at FROM fertigation_tank_refills GROUP BY tank_id').all();
    // measured venturi draw: dosed L / valve open s of recent closed-loop runs
    const draw = {};
    try {
      for (const r of db.prepare("SELECT tanks_json FROM dose_controller_runs WHERE started_at >= ? AND status <> 'running'").all(since)) {
        for (const t of parseJson(r.tanks_json, [])) {
          if (!t || !(t.open_s > 30) || !(t.dosed_l > 0)) continue;
          (draw[t.tank_id] = draw[t.tank_id] || []).push((t.dosed_l / t.open_s) * 60);
        }
      }
    } catch (_) { /* table missing */ }
    const ratioCfg = n.ratio || {};
    // stock countdown (measured / estimated level, days left, low-stock state) — read only
    let stocks = new Map();
    try {
      const { TankStockService } = require('./TankStockService');
      stocks = new Map(new TankStockService({ db, now: () => nowMs, logger: { log() {}, warn() {}, error() {} } }).viewAll().map(v => [v.tank_id, v]));
    } catch (_) { stocks = new Map(); }
    const tankView = tanks.map(t => ({
      tank_id: t.tank_id,
      letter: t.letter,
      name: t.name,
      role: t.role,
      mixture_id: t.mixture_id,
      mixture_name: t.mixture_name,
      pending_mixture_id: t.pending_mixture_id,
      items: t.items.map(i => ({ name: i.name, amount: i.amount, unit: i.unit, composition: i.composition, notes: i.notes || null })),
      per_liters: t.water_base_liters,
      relay: t.equipment_id ? { equipment_id: t.equipment_id, equipment_name: t.equipment_name, channel: t.channel, label: (dosingLabels[t.equipment_id] || {})[t.channel] || null } : null,
      stock_l: t.current_stock_liters,
      capacity_l: t.capacity_liters,
      stock: stocks.get(t.tank_id) || null,
      last_refill_at: (lastRefill.find(x => x.tank_id === t.tank_id) || {}).at || null,
      configured_draw_lpm: t.equipment_id ? chanFlow(t.equipment_id, t.channel) : null,
      measured_draw_lpm: draw[t.tank_id] ? r2(median(draw[t.tank_id])) : null,
      measured_draw_runs: draw[t.tank_id] ? draw[t.tank_id].length : 0,
      target_ratio: t.role === 'nutrient' ? (Number(ratioCfg[t.tank_id] ?? ratioCfg[String(t.tank_id)]) || null) : null,
    }));

    // ---- dose programs used by enabled automations ----
    const autos = db.prepare("SELECT id, name, enabled, trigger_config, actions, dose_program_id FROM automations WHERE enabled = 1").all();
    const programIds = [...new Set(autos.map(a => a.dose_program_id).filter(Boolean))];
    const programs = programIds.map(id => {
      const p = db.prepare('SELECT * FROM fertigation_dose_programs WHERE id = ?').get(id);
      if (!p) return null;
      return { id: p.id, name: p.name, status: p.status, control_mode: p.control_mode || 'open_loop', automations: autos.filter(a => a.dose_program_id === id).map(a => a.id) };
    }).filter(Boolean);

    // ---- schedule ----
    const runs = [];
    for (const a of autos) {
      const tc = parseJson(a.trigger_config, {});
      if (tc.type !== 'schedule') continue;
      const zones = planFromActions(parseJson(a.actions, []), { equipmentId: irrEqId, zoneChannels, pumpChannel });
      if (!zones.length) continue;
      runs.push({
        automation_id: a.id,
        name: a.name,
        schedule: tc.schedule_type || 'daily',
        time: tc.time || null,
        days: Array.isArray(tc.days) ? tc.days : null,
        dose_program_id: a.dose_program_id || null,
        zones: zones.map(z => ({ ...z, name: irrLabels[z.channel] || `ch ${z.channel}` })),
        minutes_per_section: r2(median(zones.map(z => z.minutes))),
      });
    }
    runs.sort((x, y) => String(x.time || '').localeCompare(String(y.time || '')));
    const perSection = {};
    for (const ch of zoneChannels) {
      perSection[ch] = r2(runs.filter(r => r.schedule === 'daily').reduce((s, r) => s + ((r.zones.find(z => z.channel === ch) || {}).minutes || 0), 0));
    }
    const dailyMinutes = r2(median(Object.values(perSection)));
    const dripper = profile && profile.dripper_flow_lph > 0 ? profile.dripper_flow_lph * (profile.drippers_per_plant > 0 ? profile.drippers_per_plant : 1) : null;

    // ---- measured zone flow (irrigation monitor), last 7 days ----
    const zoneFlow = {};
    const trend = [];
    try {
      for (const r of db.prepare('SELECT id, type, status, started_at, local_date, water_l, detail_json FROM irrigation_runs WHERE started_at >= ? ORDER BY started_at').all(since)) {
        const d = parseJson(r.detail_json, {});
        for (const v of (Array.isArray(d.zone_visits) ? d.zone_visits : [])) {
          if (!v || v.zone_unknown || !(v.water_l > 20)) continue;
          const from = Date.parse(v.pumped_from || v.started_at); const to = Date.parse(v.pumped_to || v.ended_at);
          const s = (to - from) / 1000;
          if (s >= 30) (zoneFlow[v.channel] = zoneFlow[v.channel] || []).push(v.water_l / s * 3600);
        }
        if (r.water_l >= 20) {
          trend.push({
            started_at: r.started_at, type: r.type, status: r.status, water_l: r1(r.water_l),
            ec_ms: d.ec_ms ? r2(d.ec_ms.avg) : null, ph: d.ph ? r2(d.ph.avg) : null,
            acid_s: d.acid_s != null ? r1(d.acid_s) : null, achieved_ratio: d.achieved_ratio ?? null,
            dosed_l: Array.isArray(d.tanks) ? r2(d.tanks.reduce((s, t) => s + (Number(t.dosed_l) || 0), 0)) : null,
            uncontrolled_dosing: !!d.uncontrolled_dosing,
          });
        }
      }
    } catch (_) { /* table missing */ }

    const sections = zoneChannels.map(ch => ({
      channel: ch,
      name: irrLabels[ch] || `ch ${ch}`,
      configured_flow_lpm: chanFlow(irrEqId, ch),
      measured_flow_lph: zoneFlow[ch] ? Math.round(median(zoneFlow[ch])) : null,
      measured_visits: zoneFlow[ch] ? zoneFlow[ch].length : 0,
      scheduled_minutes_per_day: perSection[ch] ?? null,
    }));

    // ---- protection ----
    const fw = parseJson((db.prepare("SELECT value FROM system_settings WHERE key = 'irrigation_flow_watch'").get() || {}).value, {});
    let episodes = [];
    try {
      episodes = db.prepare(`
        SELECT kind, zone_name, started_at, duration_s, severity, recovered, dosing_aborted FROM irrigation_flow_episodes
        WHERE started_at >= ? ORDER BY started_at DESC LIMIT 200
      `).all(since);
    } catch (_) { episodes = []; }
    const byKind = {};
    for (const e of episodes) byKind[e.kind] = (byKind[e.kind] || 0) + 1;

    const phTank = tankView.find(t => t.role === 'ph_down') || null;
    return {
      computed_at: new Date(nowMs).toISOString(),
      source: 'live_system',
      irrigation_board: irrEq ? { equipment_id: irrEq.id, name: irrEq.name, pump: irrLabels[pumpChannel] || `ch ${pumpChannel}`, mixing_pump: irrLabels[2] || null } : null,
      injection: {
        type: 'venturi',
        valves: 'solenoid valve per tank (relay channel)',
        tanks: tankView.filter(t => t.role === 'nutrient').length,
        buffer_tank_l: profile ? profile.buffer_tank_l ?? null : null,
      },
      tanks: tankView,
      ph_line: {
        tank: phTank ? { tank_id: phTank.tank_id, name: phTank.name, relay: phTank.relay, mixture_name: phTank.mixture_name } : null,
        enabled: ph.enabled !== false,
        setpoint: ph.setpoint ?? null,
        deadband: ph.deadband ?? null,
        floor_ph: ph.floor_ph ?? null,
        max_acid_s_per_cycle: ph.max_acid_s_per_cycle ?? null,
        max_acid_s_per_day: ph.max_acid_s_per_day ?? null,
        acid_lpm_estimate: ph.acid_lpm_estimate ?? null,
        acid_metered: false,
        sensor_equipment_id: ph.sensor_equipment_id ?? null,
      },
      dosing: {
        controller_enabled: cfg.enabled !== false,
        mode: n.mode || null,
        ratio_by_tank: tankView.filter(t => t.role === 'nutrient').map(t => ({ tank_id: t.tank_id, letter: t.letter, ratio: t.target_ratio })),
        ec_trim_enabled: !!(n.ec_trim && n.ec_trim.enabled),
        programs,
      },
      sections,
      schedule: {
        runs,
        runs_per_day: runs.filter(r => r.schedule === 'daily').length,
        minutes_per_section_per_day: dailyMinutes,
        per_section_minutes: perSection,
        ml_per_plant_day_from_dripper: dripper && dailyMinutes != null ? Math.round(dailyMinutes * dripper / 60 * 1000) : null,
        dripper_basis_lph: dripper,
      },
      protection: {
        flow_watch_enabled: fw.enabled !== false,
        abort_dosing_on_no_water: fw.abort_dosing_on_no_water !== false,
        no_flow_seconds: fw.no_flow_seconds ?? null,
        episodes_7d: episodes.length,
        episodes_by_kind: byKind,
        recent_episodes: episodes.slice(0, 8),
      },
      feed_trend: trend.slice(-60),
    };
  }
}

const fertigationSystemView = new FertigationSystemView();

module.exports = { fertigationSystemView, FertigationSystemView, planFromActions, coilLabels };
