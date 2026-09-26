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
      paused: false,
      canPause: true,
      pauses: [],
      resumes: [],
      pauseDosing(reason) {
        if (!this.running || !this.canPause) return false;
        this.paused = true; this.pauses.push({ reason, at: sim.t });
        for (const t of sim.tanks) sim.relayEvent(sim.dos, t.channel, false, 'dose_controller');
        return true;
      },
      resumeDosing(reason) { if (!this.paused) return false; this.paused = false; this.resumes.push({ reason, at: sim.t }); return true; },
      isPaused() { return this.paused; },
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
    this.timers = [];   // the run's RelayTimer: { at, ch, on, type: 'delay'|'off', aid }
    this.wakeups = [];  // service setTimer() callbacks
    this.act = this._fakeActuator();
    this.svc = new IrrigationFlowWatchService({
      db, now: () => this.t, createAlert, updateOpenAlert, logger: quiet,
      notify: async (title, text, severity) => { this.notifications.push({ title, text, severity }); },
      doseScheduler: this.sched,
      actuator: this.act,
      setTimer: (fn, ms) => { this.wakeups.push({ at: this.t + ms, fn }); return null; },
      // pump no-flow protection is OFF in the legacy replays; its own tests switch it on
      config: { irrigation_equipment_id: this.irr, dosing_equipment_id: this.dos, shutdown_enabled: false, ...config },
    });
    this.consumed = { 1: 100, 2: 100, 3: 100, 4: 100 };
    this.dosingStoppedAt = null;
    this.firedAt = {};
  }

  relayEvent(eqId, ch, on, source, atMs = this.t, aid = null) {
    db.prepare('INSERT INTO relay_events (equipment_id, channel, state, source, automation_id, confirmed, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
      .run(eqId, ch, on ? 1 : 0, source, aid, dbTs(atMs));
  }

  /** Switch an irrigation relay the way AutomationExecutor + RelayStateCache would: event + read-back into the cache. */
  setRelay(ch, on, source = 'automation', atMs = this.t, aid = null) {
    const row = db.prepare('SELECT last_reading FROM equipment WHERE id = ?').get(this.irr);
    const r = JSON.parse(row.last_reading);
    r.relayStates[ch] = on;
    db.prepare('UPDATE equipment SET last_reading = ?, last_communication = ? WHERE id = ?').run(JSON.stringify(r), new Date(this.t).toISOString(), this.irr);
    this.relayEvent(this.irr, ch, on, source, atMs, aid);
    if (this.onSwitch) this.onSwitch(ch, on, source);
  }

  relayStates() {
    return JSON.parse(db.prepare('SELECT last_reading FROM equipment WHERE id = ?').get(this.irr).last_reading).relayStates;
  }

  /** The automation's RelayTimer entries (delayed starts / auto-offs), fired by run(). */
  timer(atRel, ch, on, aid = null) {
    this.timers.push({ at: this.base + atRel * 1000, ch, on, type: on ? 'delay' : 'off', aid });
  }

  _fireDue() {
    for (const w of this.wakeups.filter(x => x.at <= this.t)) { this.wakeups.splice(this.wakeups.indexOf(w), 1); w.fn(); }
    for (const tm of this.timers.filter(x => x.at <= this.t).sort((a, b) => a.at - b.at)) {
      this.timers.splice(this.timers.indexOf(tm), 1);
      this.setRelay(tm.ch, tm.on, tm.on ? 'automation' : 'automation_auto_off', this.t, tm.aid);
    }
  }

  /** Fake actuator: records every call, writes go straight into the relay cache + relay_events. */
  _fakeActuator() {
    const sim = this;
    return {
      calls: [], disarmed: false, failOff: 0, failOn: false,
      isDisarmed() { return this.disarmed; },
      async writeOff(eqId, channels, o) {
        this.calls.push({ op: 'off', eqId, channels: [...channels], source: o.source, automationId: o.automationId, at: sim.t });
        if (this.failOff > 0) { this.failOff--; return { confirmed: false, error: 'Request timeout', items: channels.map(ch => ({ channel: ch, confirmed: false })) }; }
        for (const ch of channels) sim.setRelay(ch, false, o.source, sim.t, o.automationId);
        return { confirmed: true, items: channels.map(ch => ({ channel: ch, confirmed: true, readback: false })) };
      },
      async writeOn(eqId, channels, o) {
        this.calls.push({ op: 'on', eqId, channels: [...channels], source: o.source, automationId: o.automationId, at: sim.t });
        if (this.disarmed) throw new Error('automations are disarmed');
        if (this.failOn) return { confirmed: false, error: 'read-back disagrees', items: [] };
        for (const ch of channels) sim.setRelay(ch, true, o.source, sim.t, o.automationId);
        return { confirmed: true, items: channels.map(ch => ({ channel: ch, confirmed: true, readback: true })) };
      },
      cancelRunTimers(aid, eqId) {
        const gone = sim.timers.filter(tm => tm.type === 'delay');
        sim.timers = sim.timers.filter(tm => tm.type !== 'delay');
        this.calls.push({ op: 'cancel', automationId: aid, eqId, keys: gone.map(tm => `delay:${eqId}:${tm.ch}`), at: sim.t });
        return gone.map(tm => ({ key: `delay:${eqId}:${tm.ch}`, type: 'delay', equipmentId: eqId, channel: tm.ch }));
      },
      cancelOffTimers(eqId, channels) {
        sim.timers = sim.timers.filter(tm => !(tm.type === 'off' && channels.includes(tm.ch)));
      },
      getOffTimer(eqId, ch) {
        const tm = sim.timers.filter(x => x.type === 'off' && x.ch === ch).sort((a, b) => a.at - b.at)[0];
        return tm ? { firesAt: new Date(tm.at) } : null;
      },
      scheduleOff(eqId, ch, seconds, o) {
        sim.timers = sim.timers.filter(tm => !(tm.type === 'off' && tm.ch === ch));
        sim.timers.push({ at: sim.t + seconds * 1000, ch, on: false, type: 'off', aid: o.automationId });
        this.calls.push({ op: 'scheduleOff', ch, seconds, at: sim.t });
      },
      logAutomationRun(aid, status, message) { this.calls.push({ op: 'log', automationId: aid, status, message, at: sim.t }); },
    };
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
      this._fireDue();
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

// ─── pump no-flow protection: run shutdown + cold-restart retry (2026-09-26) ─

/**
 * Hydraulic plant driven by the relay cache: flow ramps 0 -> 8,850 L/h in ~7 s
 * when the irrigation pump runs into an open valve and falls to 0 in ~3 s
 * otherwise. A zone valve switched ON while the pump is running (under
 * pressure) sticks shut when it is in `stuck`; switched ON with the pump OFF
 * (cold) it opens — unless in `alwaysStuck`. Zone 4 on 2026-09-26: stuck when
 * switched on mid-run (09:40, 15:37), fine from a cold start (09:52 test).
 */
function hydraulicPlant(sim, { stuck = [], alwaysStuck = [], full = 8850, noise = noiseGen(5) } = {}) {
  const open = new Map(); // ch -> physically open?
  let flow = null;
  let lastRel = null;
  const states = () => sim.relayStates();
  // decide a valve's fate the moment its relay switches ON
  sim.onSwitch = (ch, on) => {
    if (![3, 4, 5, 6].includes(ch)) return;
    if (!on) { open.delete(ch); return; }
    const pumpRunning = states()[1] === true;
    open.set(ch, !(alwaysStuck.includes(ch) || (stuck.includes(ch) && pumpRunning)));
  };
  for (const [ch, on] of Object.entries(states())) if (on && [3, 4, 5, 6].includes(Number(ch))) open.set(Number(ch), true);
  const flowAt = (rel) => {
    const r = states();
    const target = r[1] === true && [...open.values()].some(Boolean) ? full : 0;
    if (flow === null) flow = target;
    const dt = lastRel === null ? 0 : rel - lastRel;
    lastRel = rel;
    if (flow < target) flow = Math.min(target, flow + (full / 7) * dt);
    else if (flow > target) flow = Math.max(target, flow - (full / 3) * dt);
    return flow > 0 && target > 0 ? Math.max(0, flow + noise(40)) : flow;
  };
  return { flowAt, open };
}

/** Longest stretch with the pump relay ON and flow below 500 L/h, from the replay's samples. */
function trackDeadHead(sim, flowAt) {
  let since = null; let worst = 0;
  const wrapped = (rel) => {
    const f = flowAt(rel);
    const pump = sim.relayStates()[1] === true;
    if (pump && f !== null && f < 500) { if (since === null) since = rel; worst = Math.max(worst, rel - since); } else since = null;
    return f;
  };
  return { flowAt: wrapped, worst: () => worst };
}

const AID = 100; // automation 100, "Fertigation 15:30 — 2.5 min/zone"
function ensureAutomation(id, name) {
  if (!db.prepare('SELECT id FROM automations WHERE id = ?').get(id)) {
    db.prepare("INSERT INTO automations (id, name, enabled, trigger_config, actions, last_run) VALUES (?, ?, 1, '{}', '[]', ?)").run(id, name, '2026-09-26 11:30:04');
  }
}

/**
 * 15:30 run (automation 100), relative to Zone 4 ON at 15:37:34 (= rel 0):
 * pumps ON since 15:30:04 (rel -450), Zone 3 ON since 15:35:11 and switched OFF
 * at 15:37:41 (rel +7); Zone 4 and both pumps end at 15:40:04 (rel +150).
 */
function run1530Sim(config = {}, plantOpts = { stuck: [6] }) {
  ensureAutomation(AID, 'Fertigation 15:30 — 2.5 min/zone, full strength');
  const base = Date.parse('2026-09-26T11:37:34Z');
  const sim = new Sim({ base, relays: { 1: true, 2: true, 5: true }, config: { shutdown_enabled: true, ...config } });
  sim.relayEvent(sim.irr, 1, true, 'automation', base - 450000, AID);
  sim.relayEvent(sim.irr, 2, true, 'automation', base - 450000, AID);
  sim.relayEvent(sim.irr, 5, true, 'automation', base - 143000, AID);
  sim.timer(0, 6, true, AID);   // zone 4 delayed start
  sim.timer(7, 5, false, AID);  // zone 3 auto-off (landed 7 s late on the day)
  sim.timer(150, 6, false, AID);
  sim.timer(150, 1, false, AID);
  sim.timer(150, 2, false, AID);
  const plant = hydraulicPlant(sim, plantOpts);
  return { sim, plant };
}

const irrigationOffCalls = (sim) => sim.act.calls.filter(c => c.op === 'off');
const guardAlerts = (sim) => db.prepare("SELECT * FROM alerts WHERE fingerprint LIKE ? ORDER BY id").all(`flow_watch:pump_no_flow:${sim.irr}:%`);
const guardEpisodes = (sim) => db.prepare("SELECT * FROM irrigation_flow_episodes WHERE equipment_id = ? AND kind IN ('run_shutdown','retry_recovered','retry_ended','retry_abandoned') ORDER BY id").all(sim.irr);

test('pump protection, 15:30 replay, stuck Zone 4 + cold-restart retry that WORKS: pumps+zone OFF at ~15 s of no flow, 10 s pause, cold restart, flow back, zone completes, dosing paused then resumed, one alert downgraded to "recovered"', async () => {
  const { sim, plant } = run1530Sim();
  const dh = trackDeadHead(sim, plant.flowAt);
  await sim.run({ from: -20, to: 170, flowAt: dh.flowAt, dosingAt: NORMAL_RATES, actions: { 150: s => { s.sched.running = false; } } });

  const off = irrigationOffCalls(sim);
  const on = sim.act.calls.filter(c => c.op === 'on');
  assert.equal(off.length, 1, JSON.stringify(sim.act.calls));
  assert.deepEqual(off[0].channels, [1, 2, 6], 'pause: both pumps + the stuck zone');
  assert.equal(off[0].source, 'flow_watch_retry');
  const tOff = (off[0].at - sim.base) / 1000;
  assert.ok(tOff >= 25 && tOff <= 30, `retry pause at +${tOff}s (zone 3 off +7, grace 5, 15 s below threshold)`);
  assert.equal(on.length, 1);
  assert.deepEqual(on[0].channels, [6, 1, 2], 'cold restart: zone first, then the pumps');
  assert.equal(on[0].source, 'flow_watch_retry');
  assert.equal(on[0].automationId, AID);
  const pause = (on[0].at - off[0].at) / 1000;
  assert.ok(pause >= 10 && pause <= 10.6, `pause ${pause}s`);
  // dosing paused (no abort) and resumed at the restart
  assert.equal(sim.sched.aborts.length, 0, JSON.stringify(sim.sched.aborts) + JSON.stringify(sim.act.calls.map(c => [c.op, c.channels, (c.at - sim.base) / 1000])));
  assert.equal(sim.sched.pauses.length, 1);
  assert.equal(sim.sched.resumes.length, 1);
  // the zone ran to its planned end (auto-off +150) with water
  assert.equal(sim.relayStates()[6], false);
  const f140 = db.prepare("SELECT 1").get(); assert.ok(f140);
  // one alert, downgraded
  const a = guardAlerts(sim);
  assert.equal(a.length, 1);
  assert.equal(a[0].occurrence_count, 1);
  assert.equal(a[0].severity, 'warning');
  assert.match(a[0].message, /^Irrigation Zone 4 \(Waveshare Irrigation 1 relay 6\) recovered after a cold restart \(retry\)/);
  const ep = guardEpisodes(sim);
  assert.deepEqual(ep.map(e => e.kind), ['retry_recovered']);
  assert.equal(ep[0].channel, 6);
  // never two zones open, pump never dead-headed for longer than grace + hold
  assert.ok(dh.worst() <= 15 + 5 + 2, `pump ON with < 500 L/h for ${dh.worst()} s at most`);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM relay_events WHERE equipment_id = ? AND source = 'flow_watch_shutdown'").get(sim.irr).n, 0);
  assert.equal(sim.svc.getStatus().last_shutdown.kind, 'retry_recovered');
  sim.dispose();
});

test('pump protection, 15:30 replay, retry FAILS (valve stuck even from cold): full shutdown — OFF ch1-6, pending timers cancelled, dose cycle aborted, run marked aborted, ONE critical alert + Telegram, episode run_shutdown', async () => {
  const { sim, plant } = run1530Sim({}, { alwaysStuck: [6] });
  const dh = trackDeadHead(sim, plant.flowAt);
  await sim.run({ from: -20, to: 170, flowAt: dh.flowAt, dosingAt: NORMAL_RATES });

  const off = irrigationOffCalls(sim);
  assert.equal(off.length, 2, JSON.stringify(off));
  assert.deepEqual(off[0].channels, [1, 2, 6]);
  assert.deepEqual(off[1].channels, [1, 2, 3, 4, 5, 6], 'shutdown: every pump + zone of the run');
  assert.equal(off[1].source, 'flow_watch_shutdown');
  const restart = sim.act.calls.find(c => c.op === 'on');
  const tShut = (off[1].at - restart.at) / 1000;
  assert.ok(tShut >= 24 && tShut <= 27, `second no-flow after the restart: cold grace 10 s + 15 s -> +${tShut}s`);
  assert.equal(sim.act.calls.filter(c => c.op === 'cancel').length, 1, 'run timers cancelled');
  assert.equal(sim.sched.aborts.length, 1);
  assert.equal(sim.sched.aborts[0].source, 'flow_watch_shutdown');
  const log = sim.act.calls.find(c => c.op === 'log');
  assert.equal(log.automationId, AID);
  assert.equal(log.status, 'failure');
  assert.match(log.message, /^ABORTED by flow watch/);
  const a = guardAlerts(sim);
  assert.equal(a.length, 1, a.map(x => x.message).join('\n'));
  assert.equal(a[0].severity, 'critical');
  assert.match(a[0].message, /^Irrigation stopped: Irrigation Zone 4 \(Waveshare Irrigation 1 relay 6\) had no water for 1\d s with the pumps running — pumps, zones and dosing switched off to prevent over-pressure\. A cold restart .* did not bring water\. Zones not irrigated this run: Irrigation Zone 4\. Check the valve\./);
  assert.match(a[0].message, /OFF confirmed on relays 1, 2, 3, 4, 5, 6/);
  assert.ok(sim.notifications.some(n => n.severity === 'critical' && /Irrigation stopped/.test(n.text)));
  assert.deepEqual(guardEpisodes(sim).map(e => e.kind), ['run_shutdown']);
  const all = sim.relayStates();
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(ch => all[ch]), [false, false, false, false, false, false]);
  assert.ok(dh.worst() <= 15 + 10 + 2, `pump ON with < 500 L/h for ${dh.worst()} s at most`);
  const st = sim.svc.getStatus();
  assert.equal(st.last_shutdown.kind, 'run_shutdown');
  assert.equal(st.last_shutdown.detail.automation_id, AID);
  sim.dispose();
});

test('pump protection, 15:30 replay with max_retries = 0: shutdown at ~15 s of no flow with exactly dose abort, OFF ch1-6 on eq1, timers cancelled, one critical alert', async () => {
  const { sim, plant } = run1530Sim({ max_retries: 0 });
  await sim.run({ from: -20, to: 120, flowAt: plant.flowAt, dosingAt: NORMAL_RATES });
  const off = irrigationOffCalls(sim);
  assert.equal(off.length, 1);
  assert.deepEqual(off[0].channels, [1, 2, 3, 4, 5, 6]);
  const t = (off[0].at - sim.base) / 1000;
  assert.ok(t >= 25 && t <= 30, `shutdown at +${t}s`);
  assert.equal(sim.act.calls.filter(c => c.op === 'on').length, 0);
  assert.equal(sim.sched.aborts.length, 1);
  assert.equal(guardAlerts(sim).length, 1);
  assert.match(guardAlerts(sim)[0].message, /No cold restart: cold-restart retry is switched off/);
  sim.dispose();
});

test('pump protection, 09:40 replay (automation 96, 3.5 min zones): Zone 4 stuck, flow 8,837 -> 0 in 18 s -> retry at ~15 s below threshold; with max_retries 0 -> shutdown and Zone 4 listed as not irrigated', async () => {
  ensureAutomation(96, 'Fertigation 09:30 — 3.5 min/zone, full strength');
  for (const retries of [1, 0]) {
    const base = Date.parse('2026-09-26T05:40:55Z');
    const sim = new Sim({ base, relays: { 1: true, 2: true, 5: true }, config: { shutdown_enabled: true, max_retries: retries } });
    sim.relayEvent(sim.irr, 1, true, 'automation', base - 630000, 96);
    sim.relayEvent(sim.irr, 5, true, 'automation', base - 209000, 96);
    sim.timer(0, 6, true, 96); sim.timer(1, 5, false, 96); sim.timer(210, 6, false, 96); sim.timer(210, 1, false, 96); sim.timer(210, 2, false, 96);
    const noise = noiseGen(7);
    let stopped = false;
    const flowAt = (rel) => {
      const r = sim.relayStates();
      if (!r[1]) stopped = true;
      if (stopped) return 0;
      if (rel < 0) return 8837 + noise(90);
      if (rel <= 5) return lerp(8837, 2157, rel / 5);
      if (rel <= 18) return lerp(2157, 0, (rel - 5) / 13);
      return 0;
    };
    await sim.run({ from: -30, to: 90, flowAt, dosingAt: INCIDENT_RATES });
    const first = sim.act.calls.find(c => c.op === 'off');
    assert.ok(first, 'acted');
    const t = (first.at - sim.base) / 1000;
    // below max(500 L/h, 10 % of 8,819) = 882 L/h from ~+12.7 s (grace ended +6 s) -> +27.7 s
    assert.ok(t >= 27 && t <= 29, `acted at +${t}s (retries=${retries})`);
    assert.deepEqual(first.channels, retries ? [1, 2, 6] : [1, 2, 3, 4, 5, 6]);
    if (!retries) assert.match(guardAlerts(sim)[0].message, /Zones not irrigated this run: Irrigation Zone 4\./);
    sim.dispose();
  }
});

test('pump protection: stuck Zone 3 with Zone 4 still pending -> full shutdown lists BOTH zones as not irrigated and cancels Zone 4\'s delayed start', async () => {
  ensureAutomation(AID, 'Fertigation 15:30');
  const base = Date.parse('2026-09-26T11:35:04Z');
  const sim = new Sim({ base, relays: { 1: true, 2: true, 4: true }, config: { shutdown_enabled: true, max_retries: 0 } });
  sim.relayEvent(sim.irr, 1, true, 'automation', base - 300000, AID);
  sim.relayEvent(sim.irr, 4, true, 'automation', base - 150000, AID);
  sim.timer(0, 5, true, AID); sim.timer(0.5, 4, false, AID); sim.timer(150, 5, false, AID);
  sim.timer(150, 6, true, AID); sim.timer(300, 6, false, AID); sim.timer(300, 1, false, AID);
  const plant = hydraulicPlant(sim, { stuck: [5] });
  await sim.run({ from: -10, to: 200, flowAt: plant.flowAt, dosingAt: NORMAL_RATES });
  const a = guardAlerts(sim);
  assert.equal(a.length, 1);
  assert.match(a[0].message, /Zones not irrigated this run: Irrigation Zone 3, Irrigation Zone 4\./);
  assert.match(a[0].message, /1 pending start\(s\) cancelled/);
  assert.equal(sim.relayStates()[6], false, 'zone 4 never opened');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM relay_events WHERE equipment_id = ? AND channel = 6 AND state = 1").get(sim.irr).n, 0);
  sim.dispose();
});

test('pump protection: DISARMED -> no cold restart (it would energise), the OFF writes still happen and the run is shut down', async () => {
  const { sim, plant } = run1530Sim();
  sim.act.disarmed = true;
  await sim.run({ from: -20, to: 100, flowAt: plant.flowAt, dosingAt: NORMAL_RATES });
  const off = irrigationOffCalls(sim);
  assert.equal(off.length, 1);
  assert.deepEqual(off[0].channels, [1, 2, 3, 4, 5, 6]);
  assert.equal(sim.act.calls.filter(c => c.op === 'on').length, 0);
  assert.match(guardAlerts(sim)[0].message, /No cold restart: automations are disarmed/);
  assert.deepEqual([1, 2, 6].map(ch => sim.relayStates()[ch]), [false, false, false]);
  sim.dispose();
});

test('pump protection: disarmed DURING the retry pause -> no restart, full shutdown', async () => {
  const { sim, plant } = run1530Sim();
  await sim.run({ from: -20, to: 100, flowAt: plant.flowAt, dosingAt: NORMAL_RATES,
    actions: { 32: s => { s.act.disarmed = true; } } });
  assert.equal(sim.act.calls.filter(c => c.op === 'on').length, 0);
  const off = irrigationOffCalls(sim);
  assert.equal(off.length, 2);
  assert.deepEqual(off[1].channels, [1, 2, 3, 4, 5, 6]);
  assert.match(guardAlerts(sim)[0].message, /disarmed during the retry pause/);
  sim.dispose();
});

test('pump protection: < 20 s of the zone left -> no retry, shutdown', async () => {
  ensureAutomation(AID, 'Fertigation 15:30');
  const base = Date.parse('2026-09-26T11:37:34Z');
  const sim = new Sim({ base, relays: { 1: true, 2: true, 5: true }, config: { shutdown_enabled: true } });
  sim.relayEvent(sim.irr, 1, true, 'automation', base - 450000, AID);
  sim.relayEvent(sim.irr, 5, true, 'automation', base - 143000, AID);
  sim.timer(0, 6, true, AID); sim.timer(7, 5, false, AID);
  sim.timer(55, 6, false, AID); sim.timer(55, 1, false, AID); sim.timer(55, 2, false, AID); // zone ends at +55
  const plant = hydraulicPlant(sim, { stuck: [6] });
  await sim.run({ from: -10, to: 80, flowAt: plant.flowAt, dosingAt: NORMAL_RATES });
  assert.equal(sim.act.calls.filter(c => c.op === 'on').length, 0);
  const off = irrigationOffCalls(sim);
  assert.equal(off.length, 1);
  assert.deepEqual(off[0].channels, [1, 2, 3, 4, 5, 6]);
  assert.match(guardAlerts(sim)[0].message, /No cold restart: only \d+ s of the zone would be left after the pause/);
  sim.dispose();
});

test('pump protection: pump dead-heading with NO zone open -> no retry, full shutdown at grace + 15 s', async () => {
  ensureAutomation(AID, 'Fertigation 15:30');
  const base = Date.parse('2026-09-26T09:00:00Z');
  const sim = new Sim({ base, doseRunning: false, config: { shutdown_enabled: true } });
  sim.timer(0, 1, true, AID); sim.timer(0, 2, true, AID); sim.timer(600, 1, false, AID);
  const plant = hydraulicPlant(sim, {});
  await sim.run({ from: -5, to: 60, flowAt: plant.flowAt });
  const off = irrigationOffCalls(sim);
  assert.equal(off.length, 1);
  const t = (off[0].at - sim.base) / 1000;
  assert.ok(t >= 25 && t <= 26.5, `shutdown at +${t}s (pump start = cold grace 10 s + 15 s)`);
  assert.match(guardAlerts(sim)[0].message, /^Irrigation stopped: the irrigation pump \(Waveshare Irrigation 1 relay 1\) ran with no zone open and no water flowing for 1\d s/);
  assert.equal(sim.act.calls.filter(c => c.op === 'on').length, 0);
  sim.dispose();
});

test('pump protection: meter BLIND (signal 20) with the pump on and "0 L/h" -> never shuts down (monitor_blind instead)', async () => {
  const { sim, plant } = run1530Sim();
  await sim.run({ from: -20, to: 120, flowAt: plant.flowAt, dosingAt: NORMAL_RATES, flowExtra: (rel) => (rel >= 3 ? { signal_quality: 20 } : {}) });
  assert.equal(sim.act.calls.length, 0, JSON.stringify(sim.act.calls));
  assert.ok(sim.alerts().some(a => a.fingerprint === 'flow_watch:monitor_blind:irrigation_monitor'));
  sim.dispose();
});

test('pump protection stays silent: switch-over dip (3 s), cold start ramp (0 -> 8,800 in ~8 s), drain-back blips with pumps OFF', async () => {
  // switch-over dip
  {
    const base = Date.parse('2026-09-26T07:34:38Z');
    const sim = new Sim({ base, relays: { 1: true, 2: true, 3: true }, config: { shutdown_enabled: true } });
    sim.relayEvent(sim.irr, 1, true, 'automation', base - 270000);
    sim.relayEvent(sim.irr, 3, true, 'automation', base - 270000);
    const noise = noiseGen(3);
    await sim.run({ from: -30, to: 120, flowAt: (rel) => (rel >= 0.5 && rel < 3.5 ? (rel < 2 ? 0 : 400) : 8880 + noise(100)), dosingAt: NORMAL_RATES,
      actions: { 0: s => s.setRelay(4, true), 1: s => s.setRelay(3, false, 'automation_auto_off') } });
    assert.equal(sim.act.calls.length, 0, 'dip');
    sim.dispose();
  }
  // cold start: flow 0 for 2 s, ramp to 8,800 by 8 s — and a slow one (0 for 5 s, 8,800 at 13 s)
  for (const [z, r] of [[2, 8], [5, 13]]) {
    const base = Date.parse('2026-09-26T07:30:08Z');
    const sim = new Sim({ base, doseRunning: true, config: { shutdown_enabled: true } });
    await sim.run({ from: -20, to: 90, flowAt: (rel) => (rel < z ? 0 : rel <= r ? lerp(0, 8800, (rel - z) / (r - z)) : 8850), activeAt: (rel) => rel >= 1.5,
      dosingAt: NORMAL_RATES, actions: { 0: s => { s.setRelay(1, true); s.setRelay(2, true); s.setRelay(3, true); } } });
    assert.equal(sim.act.calls.length, 0, `cold start ${z}-${r}`);
    sim.dispose();
  }
  // drain-back after a run
  {
    const base = Date.parse('2026-09-26T07:48:14Z');
    const sim = new Sim({ base, relays: { 1: true, 2: true, 6: true }, config: { shutdown_enabled: true } });
    sim.relayEvent(sim.irr, 1, true, 'automation', base - 1080000);
    sim.relayEvent(sim.irr, 6, true, 'automation', base - 276000);
    const blips = [[20, 26, 2500], [45, 54, 1800], [80, 82, 3000]];
    await sim.run({ from: -20, to: 120, flowAt: (rel) => { if (rel < 0) return 8900; if (rel < 6) return lerp(8900, 0, rel / 6); for (const [a, b, v] of blips) if (rel >= a && rel < b) return v; return 0; },
      activeAt: (rel) => rel < 6, dosingAt: (rel) => (rel < 50 ? NORMAL_RATES() : [0, 0, 0, 0]),
      actions: { 0: s => { for (const ch of [1, 2, 6]) s.setRelay(ch, false, 'automation_auto_off'); s.sched.running = false; } } });
    assert.equal(sim.act.calls.length, 0, 'drain-back');
    sim.dispose();
  }
});

test('pump protection: 11:30 late-opening valve (~25 s of zero flow) is now retried at ~20 s — accepted by the operator; the cold restart opens it', async () => {
  const sim = lateOpenSim({ shutdown_enabled: true });
  sim.timer(270, 6, false); sim.timer(270, 1, false); sim.timer(270, 2, false);
  const sc = lateOpenScenario(sim, 31.7);
  let stopped = false; let restarted = null;
  const flowAt = (rel) => {
    const r = sim.relayStates();
    if (!r[1]) { stopped = true; return 0; }
    if (stopped) { if (restarted === null) restarted = rel; return rel - restarted < 2 ? 0 : lerp(0, 8900, (rel - restarted - 2) / 6); }
    return sc.flowAt(rel);
  };
  await sim.run({ from: -30, to: 90, ...sc, flowAt });
  const off = irrigationOffCalls(sim);
  assert.equal(off.length, 1);
  const t = (off[0].at - sim.base) / 1000;
  assert.ok(t >= 21 && t <= 23, `late-open valve retried at +${t}s (zone 3 off +1, grace to +6, below 882 L/h from +6.5)`);
  assert.equal(guardAlerts(sim)[0].severity, 'warning', 'recovered after the cold restart');
  sim.dispose();
});

test('pump protection under SOFT-SWITCH (valve leads the pumps by 3 s): stuck zone -> retry cycles the PUMPS only (valve stays energised), recovers', async () => {
  ensureAutomation(97, 'Fertigation 11:30 — 4.5 min/zone');
  const base = Date.parse('2026-09-26T07:44:00Z'); // zone 4 valve ON at rel 0, pumps at +3
  const sim = new Sim({ base, config: { shutdown_enabled: true } });
  sim.timer(0, 6, true, 97); sim.timer(3, 1, true, 97); sim.timer(3, 2, true, 97);
  sim.timer(273, 1, false, 97); sim.timer(273, 2, false, 97); sim.timer(278, 6, false, 97);
  // valve opened with no pressure, yet stuck: it frees once the pumps restart (pressure pulse)
  let freed = false;
  const plant = hydraulicPlant(sim, {});
  const plantSwitch = sim.onSwitch;
  sim.onSwitch = (ch, on, source) => { plantSwitch(ch, on, source); if (ch === 1 && on && source === 'flow_watch_retry') freed = true; };
  const flowAt = (rel) => { const f = plant.flowAt(rel); return freed ? f : 0; };
  await sim.run({ from: -5, to: 120, flowAt, dosingAt: NORMAL_RATES });
  const off = irrigationOffCalls(sim);
  assert.equal(off.length, 1, JSON.stringify(sim.act.calls.map(c => [c.op, c.channels, (c.at - sim.base) / 1000])) + guardAlerts(sim).map(a => a.message));
  assert.deepEqual(off[0].channels, [1, 2], 'valve that led the pumps stays energised');
  const on = sim.act.calls.filter(c => c.op === 'on');
  assert.deepEqual(on[0].channels, [1, 2]);
  const t = (off[0].at - sim.base) / 1000;
  assert.ok(t >= 27.5 && t <= 29, `retry at +${t}s (pump start +3, cold grace 10 s, hold 15 s)`);
  assert.equal(sim.relayStates()[6], true, 'zone valve never dropped');
  assert.equal(on[0].automationId, 97);
  assert.equal(sim.sched.resumes.length, 1, 'dosing resumed');
  assert.equal(guardAlerts(sim)[0].severity, 'warning');
  sim.dispose();
});

test('pump protection: an operator Stop All during the retry pause cancels the cold restart (nothing re-energises)', async () => {
  const { sim, plant } = run1530Sim();
  await sim.run({ from: -20, to: 90, flowAt: plant.flowAt, dosingAt: NORMAL_RATES,
    actions: { 32: s => { for (const ch of [1, 2, 3, 4, 5, 6]) s.setRelay(ch, false, 'stop_all'); } } });
  assert.equal(sim.act.calls.filter(c => c.op === 'on').length, 0);
  assert.match(guardAlerts(sim)[0].message, /Cold restart cancelled: operator action/);
  assert.equal(guardAlerts(sim)[0].severity, 'critical');
  sim.dispose();
});

test('pump protection: OFF not confirmed -> retried once, then an extra critical "switch off at the panel" alert', async () => {
  const { sim, plant } = run1530Sim({ max_retries: 0 });
  sim.act.failOff = 2;
  await sim.run({ from: -20, to: 60, flowAt: plant.flowAt, dosingAt: NORMAL_RATES });
  assert.equal(irrigationOffCalls(sim).length, 2, 'one retry of the OFF');
  const extra = db.prepare("SELECT * FROM alerts WHERE fingerprint = ?").get(`flow_watch:shutdown_off_unconfirmed:${sim.irr}`);
  assert.ok(extra);
  assert.equal(extra.severity, 'critical');
  assert.match(guardAlerts(sim)[0].message, /OFF NOT CONFIRMED/);
  sim.dispose();
});

test('pump protection config: validated ranges (no_flow 10-60 s, pause 5-60 s, retries 0-3)', () => {
  assert.ok(validateConfigUpdate({ shutdown_no_flow_seconds: 9 }).error);
  assert.ok(validateConfigUpdate({ shutdown_no_flow_seconds: 61 }).error);
  assert.deepEqual(validateConfigUpdate({ shutdown_no_flow_seconds: 30 }).value, { shutdown_no_flow_seconds: 30 });
  assert.ok(validateConfigUpdate({ retry_pause_seconds: 4 }).error);
  assert.ok(validateConfigUpdate({ max_retries: 1.5 }).error);
  assert.deepEqual(validateConfigUpdate({ max_retries: 0, shutdown_enabled: false }).value, { max_retries: 0, shutdown_enabled: false });
});

test('soft-switch: a full automation 97 run (4 x 4.5 min, lead 3 / lag 5 / gap 1) through every flow-watch rule incl. the pump protection -> no alerts, no action, never two zones, pumps only ON with a zone valve ON', async () => {
  const { buildSoftSwitchActions } = require(path.join(__dirname, '..', 'scripts', 'soft-switch-sequences.js'));
  const legacy = [
    { type: 'control', action: 'on', equipment_id: 1, channel: 1, duration_seconds: 1080 },
    { type: 'control', action: 'on', equipment_id: 1, channel: 2, duration_seconds: 1080 },
    ...[3, 4, 5, 6].map((ch, i) => ({ type: 'control', action: 'on', equipment_id: 1, channel: ch, delay_seconds: i * 270, duration_seconds: 270 })),
  ];
  const { actions, totalS } = buildSoftSwitchActions(legacy);
  assert.equal(totalS, 1115);
  ensureAutomation(97, 'Fertigation 11:30 — 4.5 min/zone');
  const base = Date.parse('2026-09-26T07:30:04Z');
  const sim = new Sim({ base, config: { shutdown_enabled: true } });
  for (const a of actions) { sim.timer(a.delay_seconds || 0, a.channel, true, 97); sim.timer((a.delay_seconds || 0) + a.duration_seconds, a.channel, false, 97); }
  const plant = hydraulicPlant(sim, { stuck: [6] }); // zone 4 sticks only under pressure — soft-switch never opens it under pressure
  let twoZones = 0; let pumpNoValve = 0;
  const flowAt = (rel) => {
    const r = sim.relayStates();
    const zonesOn = [3, 4, 5, 6].filter(ch => r[ch]).length;
    if (zonesOn > 1) twoZones++;
    if ((r[1] || r[2]) && zonesOn === 0) pumpNoValve++;
    return plant.flowAt(rel);
  };
  await sim.run({ from: -5, to: totalS + 30, flowAt, activeAt: () => true, dosingAt: (rel) => (sim.relayStates()[1] ? NORMAL_RATES() : [0, 0, 0, 0]),
    actions: { [totalS]: s => { s.sched.running = false; } } });
  assert.deepEqual(sim.alerts().map(a => a.message), []);
  assert.equal(sim.act.calls.length, 0, 'the pump protection never acted');
  assert.equal(twoZones, 0, 'never two zones open');
  assert.equal(pumpNoValve, 0, 'pumps never ON without an open zone valve');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM relay_events WHERE equipment_id = ? AND channel = 1 AND state = 1").get(sim.irr).n, 4, 'four pump windows');
  sim.dispose();
});

test('pump protection: automation DISABLED during the retry pause -> no restart, shutdown', async () => {
  const { sim, plant } = run1530Sim();
  try {
    await sim.run({ from: -20, to: 100, flowAt: plant.flowAt, dosingAt: NORMAL_RATES,
      actions: { 32: () => { db.prepare('UPDATE automations SET enabled = 0 WHERE id = ?').run(AID); } } });
    assert.equal(sim.act.calls.filter(c => c.op === 'on').length, 0);
    assert.match(guardAlerts(sim)[0].message, /disabled or deleted during the retry pause/);
  } finally {
    db.prepare('UPDATE automations SET enabled = 1 WHERE id = ?').run(AID);
    sim.dispose();
  }
});
