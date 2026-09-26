// In-memory DB: utils/database builds the full schema (incl. irrigation_flow_episodes).
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const src = (...p) => require(path.join(__dirname, '..', 'src', ...p));
const { db } = src('utils', 'database.js');
const { createAlert, updateOpenAlert } = src('utils', 'alertBroadcast.js');
const { IrrigationFlowWatchService, validateConfigUpdate } = src('services', 'IrrigationFlowWatchService.js');
const { MqttIngestService } = src('services', 'MqttIngestService.js');

// Fresh-DB quirk (pre-existing): the relay_events CHECK-drop migration runs after
// the read-back column migration and recreates the table without them; the next
// start re-adds them. Mimic that second start so RelayEventLogger works here.
{
  const cols = db.pragma('table_info(relay_events)').map(c => c.name);
  if (!cols.includes('confirmed')) db.exec('ALTER TABLE relay_events ADD COLUMN confirmed INTEGER');
  if (!cols.includes('readback_state')) db.exec('ALTER TABLE relay_events ADD COLUMN readback_state INTEGER');
  if (!cols.includes('user_email')) db.exec('ALTER TABLE relay_events ADD COLUMN user_email TEXT');
}

const quiet = { log() {}, warn() {}, error() {} };
const MAPPINGS = JSON.stringify([
  { name: 'Irrigation Pump', register: '1', type: 'coil' },
  { name: 'Mixing Pump', register: '2', type: 'coil' },
  { name: 'Irrigation Zone 1', register: '3', type: 'coil' },
  { name: 'Irrigation Zone 2', register: '4', type: 'coil' },
  { name: 'Irrigation Zone 3', register: '5', type: 'coil' },
  { name: 'Irrigation Zone 4', register: '6', type: 'coil' },
]);
const TANK_NAMES = ['Tank A — Calcium nitrate', 'Tank B — Mg + MKP + K2SO4', 'Tank C — Potassium nitrate', 'Tank D — Fe EDDHA', 'Tank 5 — pH Down'];
const dbTs = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

// Deterministic noise (LCG + Box-Muller) so replays are repeatable.
function noiseGen(seed = 42) {
  let s = seed >>> 0;
  const u = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
  return (sd) => sd * Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

/**
 * One isolated replay: its own irrigation + dosing equipment rows (so alert
 * fingerprints / relay events never collide between tests), the real
 * createAlert/updateOpenAlert against the in-memory DB, a fake dose scheduler
 * (records aborts, writes the OFF relay_events the real abort path would) and
 * a fake clock. Nothing here can reach Modbus or MQTT.
 */
class Sim {
  constructor({ base, doseRunning = true, config = {}, relays = {} } = {}) {
    this.base = base;
    this.t = base;
    const eq = db.prepare("INSERT INTO equipment (name, type, protocol, address, status, register_mappings, last_reading, last_communication) VALUES (?, 'relay', 'modbus', '192.0.2.7:502', 'online', ?, ?, ?)");
    const states = { 1: false, 2: false, 3: false, 4: false, 5: false, 6: false, ...relays };
    this.irr = Number(eq.run('Waveshare Irrigation 1', MAPPINGS, JSON.stringify({ relayStates: states }), new Date(base).toISOString()).lastInsertRowid);
    this.dos = Number(eq.run('Waveshare Irrigation 2', null, JSON.stringify({ relayStates: {} }), new Date(base).toISOString()).lastInsertRowid);
    for (const ch of [3, 4, 5, 6]) {
      db.prepare("INSERT INTO relay_channel_config (equipment_id, channel, ingredient_name, flow_rate, flow_unit) VALUES (?, ?, 'Water', 146.99, 'L/min')").run(this.irr, ch);
    }
    // monitor tank id n == fertigation_tanks.id n; rebind tanks 1-5 to this sim's dosing board
    for (let id = 1; id <= 5; id++) {
      const ch = id === 5 ? 1 : id + 1;
      db.prepare('DELETE FROM fertigation_tanks WHERE equipment_id = ? AND channel = ? AND id <> ?').run(this.dos, ch, id);
      if (db.prepare('SELECT id FROM fertigation_tanks WHERE id = ?').get(id)) {
        db.prepare('UPDATE fertigation_tanks SET name = ?, equipment_id = ?, channel = ? WHERE id = ?').run(TANK_NAMES[id - 1], this.dos, ch, id);
      } else {
        db.prepare('INSERT INTO fertigation_tanks (id, name, equipment_id, channel) VALUES (?, ?, ?, ?)').run(id, TANK_NAMES[id - 1], this.dos, ch);
      }
    }
    this.tanks = [1, 2, 3, 4].map(id => ({ tank_id: id, tank_name: TANK_NAMES[id - 1], equipment_id: this.dos, channel: id + 1 }));
    const sim = this;
    this.sched = {
      running: doseRunning,
      aborts: [],
      isRunning() { return this.running; },
      currentCycle() { return this.running ? { cycleLogId: 85, dryRun: false, schedule: { tanks: sim.tanks } } : null; },
      async abortCycle(reason, opts = {}) {
        if (!this.running) return false;
        this.aborts.push({ reason, source: opts.source, at: sim.t });
        for (const t of sim.tanks) sim.relayEvent(sim.dos, t.channel, false, opts.source || 'dose_program_abort');
        this.running = false;
        sim.dosingStoppedAt = sim.t;
        return true;
      },
    };
    if (doseRunning) for (const t of this.tanks) this.relayEvent(this.dos, t.channel, true, 'dose_program', base - 600000);
    this.notifications = [];
    this.svc = new IrrigationFlowWatchService({
      db, now: () => this.t, createAlert, updateOpenAlert, logger: quiet,
      notify: async (title, text, severity) => { this.notifications.push({ title, text, severity }); },
      doseScheduler: this.sched,
      config: { irrigation_equipment_id: this.irr, dosing_equipment_id: this.dos, ...config },
    });
    this.consumed = { 1: 100, 2: 100, 3: 100, 4: 100 };
    this.dosingStoppedAt = null;
    this.firedAt = {};
  }

  relayEvent(eqId, ch, on, source, atMs = this.t) {
    db.prepare('INSERT INTO relay_events (equipment_id, channel, state, source, automation_id, confirmed, created_at) VALUES (?, ?, ?, ?, NULL, 1, ?)')
      .run(eqId, ch, on ? 1 : 0, source, dbTs(atMs));
  }

  /** Switch an irrigation relay the way AutomationExecutor + RelayStateCache would: event + read-back into the cache. */
  setRelay(ch, on, source = 'automation', atMs = this.t) {
    const row = db.prepare('SELECT last_reading FROM equipment WHERE id = ?').get(this.irr);
    const r = JSON.parse(row.last_reading);
    r.relayStates[ch] = on;
    db.prepare('UPDATE equipment SET last_reading = ?, last_communication = ? WHERE id = ?').run(JSON.stringify(r), new Date(this.t).toISOString(), this.irr);
    this.relayEvent(this.irr, ch, on, source, atMs);
  }

  poll() {
    db.prepare('UPDATE equipment SET last_communication = ? WHERE id IN (?, ?)').run(new Date(this.t).toISOString(), this.irr, this.dos);
  }

  flow(lph, extra = {}) {
    this.svc.ingest({ kind: 'flowmeter', farmId: '1021', equipmentId: 19, receivedMs: this.t, live: true,
      values: { flow_lph: Math.max(0, lph), net_total_m3: 70.1, signal_quality: 95, error_flags: 0, ...extra } });
  }

  dosing(rates, dtS) {
    const tanks = [1, 2, 3, 4].map((id, i) => {
      const rate = rates ? rates[i] : 0;
      if (rate > 0 && this.sched.running) this.consumed[id] += (rate / 3600) * dtS;
      return { id, consumed_l: Math.floor(this.consumed[id] * 4) / 4, rate_lph: rate };
    });
    tanks.push({ id: 5, consumed_l: 0, rate_lph: null });
    this.svc.ingest({ kind: 'dosing', farmId: '1021', equipmentId: 19, receivedMs: this.t, live: true, tanks });
  }

  /**
   * Replay rel seconds [from, to] in 0.5 s steps. flowAt(rel) -> L/h or null
   * (no message). activeAt(rel) -> monitor's irrigation state: 0.5 s flow / 1 s
   * dosing cadence when true, 10 s when false (as the device does). actions:
   * { [rel]: fn }. Ticks every 5 s, relay poll every 15 s.
   */
  async run({ from, to, flowAt, dosingAt = () => null, activeAt = () => true, actions = {}, flowExtra = () => ({}) }) {
    const acts = new Map(Object.entries(actions).map(([k, fn]) => [Math.round(Number(k) * 10), fn]));
    let lastFlow = -Infinity;
    let lastDose = -Infinity;
    for (let i = Math.round(from * 10); i <= Math.round(to * 10); i += 5) {
      const rel = i / 10;
      this.t = this.base + rel * 1000;
      if (acts.has(i)) acts.get(i)(this, rel);
      if (i % 150 === 0) this.poll();
      const active = activeAt(rel);
      const f = flowAt(rel);
      if (f !== null && f !== undefined && rel - lastFlow >= (active ? 0.5 : 10) - 1e-9) { this.flow(f, flowExtra(rel)); lastFlow = rel; }
      const d = dosingAt(rel);
      if (rel - lastDose >= (active ? 1 : 10) - 1e-9) { this.dosing(d, lastDose === -Infinity ? 1 : rel - lastDose); lastDose = rel; }
      if (i % 50 === 0) this.svc.evaluate(this.t);
      await this.svc.flush();
      for (const inst of this.svc.instances.values()) if (inst.fired && !(inst.key in this.firedAt)) this.firedAt[inst.key] = (inst.firedAt - this.base) / 1000;
    }
  }

  alerts() {
    return db.prepare("SELECT * FROM alerts WHERE source = 'flow_watch' AND (fingerprint LIKE ? OR fingerprint LIKE ? OR fingerprint = 'flow_watch:monitor_blind:irrigation_monitor') ORDER BY id")
      .all(`flow_watch:%:${this.irr}%`, `flow_watch:dosing_without_water:${this.dos}`);
  }

  episodes() {
    return db.prepare('SELECT * FROM irrigation_flow_episodes WHERE equipment_id IN (?, ?) OR (kind = ? ) ORDER BY id')
      .all(this.irr, this.dos, 'monitor_blind');
  }

  dispose() {
    this.svc.stop();
    // monitor_blind has a board-independent fingerprint; close it so the next sim starts clean
    db.prepare("DELETE FROM alerts WHERE fingerprint = 'flow_watch:monitor_blind:irrigation_monitor'").run();
    db.prepare("DELETE FROM irrigation_flow_episodes WHERE kind = 'monitor_blind'").run();
  }
}

const lerp = (a, b, x) => a + (b - a) * Math.max(0, Math.min(1, x));
// 2026-09-26 zone 4 incident dosing rates (65-137 L/h, all four tanks)
const INCIDENT_RATES = (rel) => {
  const k = Math.floor(rel / 7);
  return [77 + (k % 3) * 20, 65 + (k % 4) * 18, 90 + (k % 2) * 47, 70 + (k % 5) * 10];
};
const NORMAL_RATES = () => [68, 63, 66, 52];

// ─── the real incident ──────────────────────────────────────────────────────

test('replay 09:40:55 zone 4 incident: one valve_no_flow alarm (zone 4) + one dosing_without_water alarm, dosing stopped automatically', async () => {
  const base = Date.parse('2026-09-26T05:40:55Z'); // 09:40:55 Asia/Dubai
  const sim = new Sim({ base, relays: { 1: true, 2: true, 5: true } });
  sim.relayEvent(sim.irr, 1, true, 'automation', base - 630000); // pump 09:30:25
  sim.relayEvent(sim.irr, 2, true, 'automation', base - 630000);
  sim.relayEvent(sim.irr, 5, true, 'automation', base - 209000); // zone 3 09:37:26
  const noise = noiseGen(7);
  const flowAt = (rel) => {
    if (rel < 0) return 8837 + noise(90);
    if (rel <= 5) return lerp(8837, 2157, rel / 5);
    if (rel <= 18) return lerp(2157, 0, (rel - 5) / 13);
    if (rel >= 80 && rel < 81) return 176; // the single blip
    return 0;
  };
  const dosingAt = (rel) => {
    if (sim.sched.running) return INCIDENT_RATES(rel);
    // the meter holds the last pulse rate ~40 s after the valves close
    return (sim.t - sim.dosingStoppedAt) < 40000 ? INCIDENT_RATES(rel) : [0, 0, 0, 0];
  };
  await sim.run({
    from: -60, to: 260, flowAt, dosingAt,
    activeAt: (rel) => rel < 9, // monitor reported irrigation_active=false at 09:41:04
    actions: {
      0: s => s.setRelay(6, true),                // Zone 4 ON (confirmed)
      1: s => s.setRelay(5, false, 'automation_auto_off'),
      169: s => { for (const ch of [1, 2, 6]) s.setRelay(ch, false, 'stop_all'); }, // 09:43:44 stop_all
    },
  });

  const alerts = sim.alerts();
  assert.equal(alerts.length, 2, alerts.map(a => a.fingerprint).join(', '));
  const noFlow = alerts.find(a => a.fingerprint === `flow_watch:valve_no_flow:${sim.irr}:6`);
  const dosing = alerts.find(a => a.fingerprint === `flow_watch:dosing_without_water:${sim.dos}`);
  assert.ok(noFlow, 'valve_no_flow alarm for zone 4');
  assert.ok(dosing, 'dosing_without_water alarm');
  assert.equal(noFlow.occurrence_count, 1);
  assert.equal(dosing.occurrence_count, 1);
  assert.equal(noFlow.equipment_id, sim.irr);

  // timing: valve alarm at settle 20 s + 15 s = 09:41:30; dosing alarm 15 s after the line stopped
  const tNoFlow = sim.firedAt[`valve_no_flow:${sim.irr}:6`];
  const tDosing = sim.firedAt[`dosing_without_water:${sim.dos}`];
  assert.ok(tNoFlow >= 35 && tNoFlow <= 41, `valve_no_flow fired at +${tNoFlow}s`);
  assert.ok(tDosing >= 30 && tDosing <= 41, `dosing_without_water fired at +${tDosing}s`);

  // auto-abort through the scheduler's abort path, exactly once, source flow_watch
  assert.equal(sim.sched.aborts.length, 1);
  assert.equal(sim.sched.aborts[0].source, 'flow_watch');
  const offEvents = db.prepare("SELECT channel FROM relay_events WHERE equipment_id = ? AND source = 'flow_watch' AND state = 0").all(sim.dos);
  assert.deepEqual(offEvents.map(r => r.channel).sort(), [2, 3, 4, 5]);
  // never touched pumps or zone valves
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM relay_events WHERE equipment_id = ? AND source = 'flow_watch'").get(sim.irr).n, 0);

  // messages: the zone ended without water (stays critical), dosing says it was stopped automatically
  assert.equal(noFlow.severity, 'critical');
  assert.match(noFlow.message, /Irrigation Zone 4 \(Waveshare Irrigation 1 relay 6\) ran 2 min \d+ s with no water flowing/);
  assert.match(noFlow.message, /expected ~8,819 L\/h/);
  assert.match(dosing.message, /dosing stopped automatically/i);
  assert.match(dosing.message, /injector valves closed \(Tank A, Tank B, Tank C, Tank D\)/);
  assert.equal(dosing.severity, 'critical', 'an automatic stop stays an alarm');
  assert.match(dosing.message, /Tank A 1?\d\d L\/h/);

  const eps = sim.episodes();
  const ep = eps.find(e => e.kind === 'valve_no_flow');
  assert.ok(ep, 'no-flow episode recorded');
  assert.equal(ep.channel, 6);
  assert.equal(ep.zone_name, 'Irrigation Zone 4');
  assert.equal(ep.alarmed, 1);
  assert.equal(ep.recovered, 0);
  assert.ok(ep.duration_s > 150 && ep.duration_s < 165, `episode ${ep.duration_s}s`);
  const dep = eps.find(e => e.kind === 'dosing_without_water');
  assert.equal(dep.dosing_aborted, 1);
  // Telegram: the two alarms (+ their end notices), nothing for cautions
  assert.ok(sim.notifications.length >= 2 && sim.notifications.every(n => n.severity !== 'warning' || /ended|resolved/i.test(n.title)));
  sim.dispose();
});

// ─── 11:30 late-opening valve ───────────────────────────────────────────────

function lateOpenScenario(sim, gapEndRel) {
  // 11:43:38 zone 4 ON; flow 0 from ~11:43:45 until the valve opens at gapEndRel
  const noise = noiseGen(11);
  return {
    flowAt: (rel) => {
      if (rel < 0) return 8900 + noise(90);
      if (rel <= 3) return lerp(8900, 6417, rel / 3);
      if (rel <= 7) return lerp(6417, 0, (rel - 3) / 4);
      if (rel < gapEndRel) return 0;
      if (rel < gapEndRel + 0.5) return 152.9;
      if (rel <= gapEndRel + 8) return lerp(152.9, 9003, (rel - gapEndRel) / 8);
      return 8950 + noise(90);
    },
    activeAt: (rel) => rel < 7.7 || rel >= gapEndRel,
    dosingAt: () => (sim.sched.running ? [69, 103, 77, 95] : (sim.t - sim.dosingStoppedAt < 40000 ? [69, 103, 77, 95] : [0, 0, 0, 0])),
    actions: { 0: s => s.setRelay(6, true), 1: s => s.setRelay(5, false, 'automation_auto_off') },
  };
}

function lateOpenSim(config) {
  const base = Date.parse('2026-09-26T07:43:38Z');
  const sim = new Sim({ base, relays: { 1: true, 2: true, 5: true }, config });
  sim.relayEvent(sim.irr, 1, true, 'automation', base - 810000);
  sim.relayEvent(sim.irr, 5, true, 'automation', base - 270000);
  return sim;
}

test('replay 11:30 late-open (0 flow ~25 s then recovery): NO valve_no_flow alarm, episode recorded as recovered', async () => {
  const sim = lateOpenSim({ abort_dosing_on_no_water: false });
  await sim.run({ from: -30, to: 150, ...lateOpenScenario(sim, 31.7) });
  const alerts = sim.alerts();
  assert.equal(alerts.filter(a => /valve_no_flow|low_flow/.test(a.fingerprint)).length, 0, alerts.map(a => a.message).join('\n'));
  const ep = sim.episodes().find(e => e.kind === 'valve_no_flow');
  assert.ok(ep, 'late opening recorded as an episode');
  assert.equal(ep.channel, 6);
  assert.equal(ep.recovered, 1);
  assert.equal(ep.alarmed, 0);
  assert.ok(ep.duration_s >= 24 && ep.duration_s <= 30, `episode ${ep.duration_s}s`);
  sim.dispose();
});

test('11:30 late-open with default thresholds: dosing kept running with no flow for ~26 s, so dosing_without_water fires and aborts the dose cycle (documented trade-off)', async () => {
  const sim = lateOpenSim({});
  await sim.run({ from: -30, to: 150, ...lateOpenScenario(sim, 31.7) });
  const alerts = sim.alerts();
  assert.equal(alerts.filter(a => /valve_no_flow/.test(a.fingerprint)).length, 0);
  const dosing = alerts.find(a => /dosing_without_water/.test(a.fingerprint));
  assert.ok(dosing, 'dosing_without_water fired');
  assert.equal(sim.sched.aborts.length, 1);
  assert.equal(sim.sched.aborts[0].source, 'flow_watch');
  assert.match(dosing.message, /dosing (had been )?stopped automatically/i);
  sim.dispose();
});

test('11:30 late-open, abort off: dosing alarm then resolved as "water flow recovered"', async () => {
  const sim = lateOpenSim({ abort_dosing_on_no_water: false });
  await sim.run({ from: -30, to: 150, ...lateOpenScenario(sim, 31.7) });
  const dosing = sim.alerts().find(a => /dosing_without_water/.test(a.fingerprint));
  assert.ok(dosing);
  assert.equal(sim.sched.aborts.length, 0);
  assert.equal(dosing.severity, 'info');
  assert.match(dosing.message, /^Resolved: dosing without water .* water flow recovered/);
  sim.dispose();
});

test('valve opening ~40 s late: valve_no_flow alarm, then resolved "recovered after ~Ns" (info), one alert row', async () => {
  const sim = lateOpenSim({ abort_dosing_on_no_water: false });
  await sim.run({ from: -30, to: 150, ...lateOpenScenario(sim, 42) });
  const a = sim.alerts().filter(x => x.fingerprint === `flow_watch:valve_no_flow:${sim.irr}:6`);
  assert.equal(a.length, 1);
  assert.equal(a[0].occurrence_count, 1);
  assert.equal(a[0].severity, 'info');
  assert.match(a[0].message, /^Resolved: Irrigation Zone 4 \(Waveshare Irrigation 1 relay 6\) — water flow recovered after 3\d s with no flow/);
  const ep = sim.episodes().find(e => e.kind === 'valve_no_flow');
  assert.equal(ep.alarmed, 1);
  assert.equal(ep.recovered, 1);
  sim.dispose();
});

// ─── normal operation must stay silent ──────────────────────────────────────

test('normal zone switch-over (3 s dip, 1 s relay overlap) with dosing running: no alerts', async () => {
  const base = Date.parse('2026-09-26T07:34:38Z');
  const sim = new Sim({ base, relays: { 1: true, 2: true, 3: true } });
  sim.relayEvent(sim.irr, 1, true, 'automation', base - 270000);
  sim.relayEvent(sim.irr, 3, true, 'automation', base - 270000);
  const noise = noiseGen(3);
  await sim.run({
    from: -30, to: 200,
    flowAt: (rel) => (rel >= 0.5 && rel < 3.5 ? (rel < 2 ? 300 : 1200) : 8880 + noise(100)),
    dosingAt: NORMAL_RATES,
    actions: { 0: s => s.setRelay(4, true), 1: s => s.setRelay(3, false, 'automation_auto_off') },
  });
  assert.deepEqual(sim.alerts().map(a => a.message), []);
  assert.equal(sim.sched.aborts.length, 0);
  assert.equal(sim.episodes().length, 0);
  sim.dispose();
});

test('10 s zone test / cold start ramp 0 -> 8,800 in ~8 s with dosing from t=0: no alerts', async () => {
  const base = Date.parse('2026-09-26T07:30:08Z');
  const sim = new Sim({ base, doseRunning: true });
  await sim.run({
    from: -20, to: 120,
    flowAt: (rel) => (rel < 2 ? 0 : rel <= 8 ? lerp(0, 8800, (rel - 2) / 6) : 8850),
    activeAt: (rel) => rel >= 1.5,
    dosingAt: (rel) => (rel < 0 ? [0, 0, 0, 0] : rel < 3 ? [2, 3, 1, 2] : NORMAL_RATES()),
    actions: { 0: s => { s.setRelay(1, true); s.setRelay(2, true); s.setRelay(3, true); } },
  });
  assert.deepEqual(sim.alerts().map(a => a.message), []);
  assert.equal(sim.sched.aborts.length, 0);
  sim.dispose();
});

test('drain-back after a run (pumps OFF, 2-9 s blips of a few litres, dosing meter holding its last rate): no alerts', async () => {
  const base = Date.parse('2026-09-26T07:48:14Z');
  const sim = new Sim({ base, relays: { 1: true, 2: true, 6: true } });
  sim.relayEvent(sim.irr, 1, true, 'automation', base - 1080000);
  sim.relayEvent(sim.irr, 6, true, 'automation', base - 276000);
  const blips = [[20, 26, 2500], [45, 54, 1800], [80, 82, 3000], [120, 127, 1500]];
  await sim.run({
    from: -20, to: 200,
    flowAt: (rel) => {
      if (rel < 0) return 8900;
      if (rel < 6) return lerp(8900, 0, rel / 6);
      for (const [a, b, v] of blips) if (rel >= a && rel < b) return v;
      return 0;
    },
    activeAt: (rel) => rel < 6,
    // rates held ~50 s after the end of the dose program, as seen 07:48:33
    dosingAt: (rel) => (rel < 50 ? NORMAL_RATES() : [0, 0, 0, 0]),
    actions: {
      0: s => {
        for (const ch of [1, 2, 6]) s.setRelay(ch, false, 'automation_auto_off');
        s.sched.running = false; // dose program ends with the run
        for (const t of s.tanks) s.relayEvent(s.dos, t.channel, false, 'dose_program_end');
      },
    },
  });
  assert.deepEqual(sim.alerts().map(a => a.message), []);
  assert.equal(sim.sched.aborts.length, 0);
  sim.dispose();
});

// ─── other rules ────────────────────────────────────────────────────────────

test('flow with no zone relay ON (pump ON): water_without_valve after 30 s, resolved when it stops', async () => {
  const base = Date.parse('2026-09-26T09:00:00Z');
  const sim = new Sim({ base, doseRunning: false, relays: { 1: true } });
  sim.relayEvent(sim.irr, 1, true, 'manual', base - 60000);
  await sim.run({ from: 0, to: 90, flowAt: (rel) => (rel < 60 ? 4200 : 0), activeAt: () => true });
  const a = sim.alerts();
  assert.equal(a.length, 1, a.map(x => x.fingerprint).join(','));
  assert.equal(a[0].fingerprint, `flow_watch:water_without_valve:${sim.irr}`);
  const t = sim.firedAt[`water_without_valve:${sim.irr}`];
  assert.ok(t >= 30 && t <= 31, `fired at ${t}`);
  assert.equal(a[0].severity, 'info');
  assert.match(a[0].message, /^Resolved: water flow with no zone open stopped after/);
  sim.dispose();
});

test('flow with the pump relay OFF (pump run by hand at the panel, zone relay ON): flow_after_pump_off after 20 s', async () => {
  const base = Date.parse('2026-09-26T08:23:10Z');
  const sim = new Sim({ base, doseRunning: false, relays: { 6: true } });
  sim.relayEvent(sim.irr, 6, true, 'manual', base);
  await sim.run({ from: 0, to: 60, flowAt: () => 8557, activeAt: () => true });
  const a = sim.alerts();
  assert.equal(a.length, 1, a.map(x => x.fingerprint).join(','));
  assert.equal(a[0].fingerprint, `flow_watch:flow_after_pump_off:${sim.irr}:1`);
  assert.equal(a[0].severity, 'warning');
  assert.match(a[0].message, /irrigation pump relay \(Waveshare Irrigation 1 relay 1\) is OFF/);
  const t = sim.firedAt[`flow_after_pump_off:${sim.irr}:1`];
  assert.ok(t >= 20 && t <= 21, `fired at ${t}`);
  sim.dispose();
});

test('monitor goes silent while the pump is ON: monitor_blind after 60 s, resolved when data returns', async () => {
  const base = Date.parse('2026-09-26T08:00:00Z');
  const sim = new Sim({ base, doseRunning: false, relays: { 1: true, 2: true, 3: true } });
  sim.relayEvent(sim.irr, 1, true, 'automation', base - 100000);
  sim.relayEvent(sim.irr, 3, true, 'automation', base - 100000);
  await sim.run({
    from: 0, to: 140,
    flowAt: (rel) => (rel < 10 || rel >= 110 ? 8880 : null), // silent 10 s .. 110 s
    dosingAt: () => null,
  });
  const a = sim.alerts();
  assert.equal(a.length, 1, a.map(x => x.message).join('\n'));
  assert.equal(a[0].fingerprint, 'flow_watch:monitor_blind:irrigation_monitor');
  const t = sim.firedAt['monitor_blind:irrigation_monitor'];
  assert.ok(t >= 70 && t <= 75, `fired at ${t}`);
  assert.equal(a[0].severity, 'info');
  assert.match(a[0].message, /^Resolved: flow meter data is back/);
  // zone rules stayed frozen while blind (no false no-flow alarm)
  assert.equal(a.filter(x => /valve_no_flow/.test(x.fingerprint)).length, 0);
  sim.dispose();
});

test('unhealthy meter (signal < 60) during irrigation: monitor_blind, no no-flow alarm on its bogus 0 L/h', async () => {
  const base = Date.parse('2026-09-26T08:10:00Z');
  const sim = new Sim({ base, doseRunning: false, relays: { 1: true, 3: true } });
  sim.relayEvent(sim.irr, 1, true, 'automation', base - 100000);
  sim.relayEvent(sim.irr, 3, true, 'automation', base - 100000);
  await sim.run({
    from: 0, to: 80,
    flowAt: (rel) => (rel < 10 ? 8880 : 0),
    flowExtra: (rel) => (rel < 10 ? {} : { signal_quality: 20 }),
  });
  const a = sim.alerts();
  assert.deepEqual(a.map(x => x.fingerprint), ['flow_watch:monitor_blind:irrigation_monitor']);
  assert.match(a[0].message, /flow meter is unhealthy \(signal 20/);
  sim.dispose();
});

test('low flow (50 % of expected) for 60 s: low_flow caution for that zone', async () => {
  const base = Date.parse('2026-09-26T08:20:00Z');
  const sim = new Sim({ base, doseRunning: false, relays: { 1: true, 4: true } });
  sim.relayEvent(sim.irr, 1, true, 'automation', base - 100000);
  sim.relayEvent(sim.irr, 4, true, 'automation', base - 100000);
  await sim.run({ from: 0, to: 90, flowAt: () => 4400 });
  const a = sim.alerts();
  assert.deepEqual(a.map(x => x.fingerprint), [`flow_watch:low_flow:${sim.irr}:4`]);
  assert.equal(a[0].severity, 'warning');
  assert.match(a[0].message, /Irrigation Zone 2 \(Waveshare Irrigation 1 relay 4\): low flow — 4,400 L\/h is 50 %/);
  sim.dispose();
});

// ─── flow_above_expected + baseline learning ────────────────────────────────

test('flow_above_expected: learns a per-zone baseline from steady runs; +4 % with one zone ON raises a caution, normal noise does not', async () => {
  const base = Date.parse('2026-09-26T05:30:00Z');
  const sim = new Sim({ base, doseRunning: false });
  const noise = noiseGen(99);
  // run 1: zone 1, 5 min at 8,885 +- 100 (real steady-state noise) -> learns the baseline
  await sim.run({
    from: 0, to: 330,
    flowAt: (rel) => (rel < 3 ? 0 : 8885 + noise(100)),
    actions: { 0: s => { s.setRelay(1, true); s.setRelay(3, true); }, 320: s => { s.setRelay(3, false); s.setRelay(1, false); } },
  });
  const b = sim.svc.getBaselines().find(x => x.channel === 3);
  assert.ok(b.minutes >= 3, `learned ${b.minutes} minute(s)`);
  assert.ok(Math.abs(b.baseline_lph - 8885) < 30, `baseline ${b.baseline_lph}`);
  assert.deepEqual(sim.alerts().map(a => a.message), []);

  // run 2: same zone, normal again -> silent
  await sim.run({
    from: 400, to: 700,
    flowAt: (rel) => (rel < 403 ? 0 : 8885 + noise(100)),
    actions: { 400: s => { s.setRelay(1, true); s.setRelay(3, true); }, 690: s => { s.setRelay(3, false); s.setRelay(1, false); } },
  });
  assert.deepEqual(sim.alerts().map(a => a.message), []);

  // run 3: a second valve mechanically open -> ~9,240 L/h (+4 %) with only zone 1's relay ON
  await sim.run({
    from: 800, to: 1000,
    flowAt: (rel) => (rel < 803 ? 0 : 9240 + noise(100)),
    actions: { 800: s => { s.setRelay(1, true); s.setRelay(3, true); } },
  });
  const a = sim.alerts();
  assert.equal(a.length, 1, a.map(x => x.message).join('\n'));
  assert.equal(a[0].fingerprint, `flow_watch:flow_above_expected:${sim.irr}:3`);
  assert.equal(a[0].severity, 'warning');
  assert.match(a[0].message, /more water than one zone should take/);
  assert.match(a[0].message, /learned from \d+ steady minute/);
  const t = sim.firedAt[`flow_above_expected:${sim.irr}:3`] - 800;
  assert.ok(t >= 80 && t <= 100, `fired ${t}s after the zone opened (20 s settle + 60 s)`);
  // the elevated flow must not have been learned as the new normal
  const b2 = sim.svc.getBaselines().find(x => x.channel === 3);
  assert.ok(b2.baseline_lph < 8950, `baseline ${b2.baseline_lph}`);
  sim.dispose();
});

test('flow_above_expected without a learned baseline uses configured flow + 5 %: zone 3 normal (~9,006 L/h) stays silent', async () => {
  const base = Date.parse('2026-09-26T07:39:08Z');
  const sim = new Sim({ base, doseRunning: false });
  const noise = noiseGen(5);
  await sim.run({
    from: 0, to: 270,
    flowAt: (rel) => (rel < 3 ? 0 : 9006 + noise(105)),
    actions: { 0: s => { s.setRelay(1, true); s.setRelay(5, true); } },
  });
  assert.deepEqual(sim.alerts().map(a => a.message), []);
  sim.dispose();
});

// ─── plumbing ───────────────────────────────────────────────────────────────

test('MqttIngestService.onLive delivers full-rate live flowmeter/dosing samples (not retained replays) to the watch', () => {
  const svc = new MqttIngestService({ db, logger: quiet, now: () => Date.parse('2026-09-26T09:00:00Z'), config: { enabled: false }, broadcast: () => {} });
  const got = [];
  const off = svc.onLive(e => got.push(e));
  svc.onLive(() => { throw new Error('listener bug'); }); // must not break ingest
  const flow = { v: 1, flow_lph: 8820.4, net_total_m3: 70.7, signal_quality: 91, error_flags: 0 };
  assert.equal(svc.handleMessage('farm/7777/flowmeter/live', Buffer.from(JSON.stringify(flow)), {}).ok, true);
  svc.handleMessage('farm/7777/flowmeter/live', Buffer.from(JSON.stringify(flow)), { retain: true });
  svc.handleMessage('farm/7777/dosing/live', Buffer.from(JSON.stringify({ v: 1, tanks: [{ id: 1, consumed_l: 1, rate_lph: 60 }] })), {});
  assert.deepEqual(got.map(e => [e.kind, e.live, e.farmId]), [['flowmeter', true, '7777'], ['dosing', true, '7777']]);
  assert.equal(got[0].values.flow_lph, 8820.4);
  off();
});

test('FertigationDoseScheduler.abortCycle(reason, {source}) logs the valve-close events with that source (Modbus stubbed)', async () => {
  const { modbusTcpClient } = src('services', 'ModbusTcpClient.js');
  const { FertigationDoseScheduler } = src('services', 'FertigationDoseScheduler.js');
  const writes = [];
  const orig = { w: modbusTcpClient.writeSingleCoil, f: modbusTcpClient.writeSingleCoilFireAndForget };
  modbusTcpClient.writeSingleCoil = async (host, port, unit, ch, state) => { writes.push({ host, ch, state }); };
  modbusTcpClient.writeSingleCoilFireAndForget = async (host, port, unit, ch, state) => { writes.push({ host, ch, state }); };
  try {
    const eqId = Number(db.prepare("INSERT INTO equipment (name, protocol, address, slave_id) VALUES ('Dose test board', 'modbus', '192.0.2.9:502', 2)").run().lastInsertRowid);
    const logId = Number(db.prepare("INSERT INTO fertigation_dose_cycle_log (status, cycle_started_at) VALUES ('running', datetime('now'))").run().lastInsertRowid);
    const s = new FertigationDoseScheduler();
    s._active = { programId: null, automationId: null, cycleLogId: logId, startedAt: Date.now(), endsAt: Date.now() + 60000, timers: [], valveStates: {}, dryRun: false,
      schedule: { tanks: [{ tank_id: 1, tank_name: 'A', equipment_id: eqId, channel: 2 }, { tank_id: 2, tank_name: 'B', equipment_id: eqId, channel: 3 }] } };
    assert.equal(s.currentCycle().cycleLogId, logId);
    assert.equal(await s.abortCycle('flow_watch: test', { source: 'flow_watch' }), true);
    assert.deepEqual(writes.map(w => [w.ch, w.state]), [[2, false], [3, false]]);
    const ev = db.prepare('SELECT channel, state, source FROM relay_events WHERE equipment_id = ? ORDER BY id').all(eqId);
    assert.deepEqual(ev.map(e => [e.channel, e.state, e.source]), [[2, 0, 'flow_watch'], [3, 0, 'flow_watch']]);
    const log = db.prepare('SELECT status, notes FROM fertigation_dose_cycle_log WHERE id = ?').get(logId);
    assert.deepEqual(log, { status: 'aborted', notes: 'flow_watch: test' });
    // default source unchanged for the existing callers
    s._active = { programId: null, automationId: null, cycleLogId: logId, startedAt: Date.now(), endsAt: Date.now() + 60000, timers: [], valveStates: {}, dryRun: false,
      schedule: { tanks: [{ tank_id: 1, tank_name: 'A', equipment_id: eqId, channel: 2 }, { tank_id: 2, tank_name: 'B', equipment_id: eqId, channel: 3 }] } };
    await s.abortCycle('manual stop');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM relay_events WHERE equipment_id = ? AND source = 'dose_program_abort'").get(eqId).n, 2);
  } finally {
    modbusTcpClient.writeSingleCoil = orig.w;
    modbusTcpClient.writeSingleCoilFireAndForget = orig.f;
  }
});

test('config validation rejects bad values and unknown keys; defaults have abort ON', () => {
  const { DEFAULT_CONFIG } = src('services', 'IrrigationFlowWatchService.js');
  assert.equal(DEFAULT_CONFIG.abort_dosing_on_no_water, true);
  assert.ok(validateConfigUpdate({ no_flow_pct: 15, zone_channels: [3, 4, 5, 6], monitor_farm_id: '1021' }).value);
  assert.match(validateConfigUpdate({ no_flow_pct: 'x' }).error, /no_flow_pct/);
  assert.match(validateConfigUpdate({ bogus: 1 }).error, /unknown setting/);
  assert.match(validateConfigUpdate({ zone_channels: [3, 3] }).error, /distinct/);
  assert.match(validateConfigUpdate({ abort_dosing_on_no_water: 'yes' }).error, /true or false/);
  const svc = new IrrigationFlowWatchService({ db, logger: quiet });
  assert.throws(() => svc.saveConfig({ no_flow_pct: 80 }), /below low_flow_pct/);
  const saved = svc.saveConfig({ dosing_seconds: 20 });
  assert.equal(saved.dosing_seconds, 20);
  assert.equal(saved.abort_dosing_on_no_water, true);
  db.prepare("DELETE FROM system_settings WHERE key = 'irrigation_flow_watch'").run();
});

test('status: idle when all OFF, unknown when the relay board is stale or the pump runs without flow data, then monitor_blind', () => {
  const base = Date.parse('2026-09-26T10:00:00Z');
  const sim = new Sim({ base, doseRunning: false });
  assert.equal(sim.svc.getStatus(base).state, 'idle');
  sim.t = base + 120000; // board not polled for 2 min
  const st = sim.svc.getStatus(sim.t);
  assert.equal(st.state, 'unknown');
  assert.equal(st.relays.known, false);
  // fresh service, pump + zone ON, no flow data yet: unknown (never "ok")
  const sim2 = new Sim({ base, doseRunning: false });
  sim2.setRelay(1, true); sim2.setRelay(3, true);
  sim2.t = base + 6000;
  const st2 = sim2.svc.getStatus(sim2.t);
  assert.equal(st2.state, 'unknown', 'pump ON but no flow data yet');
  assert.equal(st2.current_zone.name, 'Irrigation Zone 1');
  assert.equal(st2.current_zone.expected_lph, 8819);
  // still nothing after 60 s: monitor_blind caution
  sim2.t = base + 66000; sim2.poll();
  const st3 = sim2.svc.getStatus(sim2.t);
  assert.equal(st3.state, 'caution');
  assert.deepEqual(st3.active.map(a => [a.rule, a.fired]), [['monitor_blind', true]]);
  sim.dispose();
  sim2.dispose();
});
