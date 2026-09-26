// Closed-loop dose controller (services/DoseController.js) against a simulated
// coupled venturi plant, the irrigation monitor stream, a mixing-tank pH plant
// and the SEKO poll. All Modbus writes are stubbed; nothing reaches hardware.
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const src = (...p) => require(path.join(__dirname, '..', 'src', ...p));
const { db } = src('utils', 'database.js');
const { createAlert, updateOpenAlert } = src('utils', 'alertBroadcast.js');
const { modbusTcpClient } = src('services', 'ModbusTcpClient.js');
const { FertigationDoseScheduler } = src('services', 'FertigationDoseScheduler.js');
const { DoseController, validateConfigUpdate, mergeConfig, crossCheck, computeEcTrim, DEFAULT_CONFIG } = src('services', 'DoseController.js');
const { automationArmingService } = src('services', 'AutomationArmingService.js');
const { IrrigationFlowWatchService } = src('services', 'IrrigationFlowWatchService.js');

// Fresh-DB quirk (see flowWatch.test.js): re-add the read-back columns.
{
  const cols = db.pragma('table_info(relay_events)').map(c => c.name);
  if (!cols.includes('confirmed')) db.exec('ALTER TABLE relay_events ADD COLUMN confirmed INTEGER');
  if (!cols.includes('readback_state')) db.exec('ALTER TABLE relay_events ADD COLUMN readback_state INTEGER');
  if (!cols.includes('user_email')) db.exec('ALTER TABLE relay_events ADD COLUMN user_email TEXT');
}

const quiet = { log() {}, warn() {}, error() {} };

// ─── Modbus stub: every coil write lands in the current simulation ──────────
let CURRENT = null;
const realModbus = {
  w: modbusTcpClient.writeSingleCoil, f: modbusTcpClient.writeSingleCoilFireAndForget, r: modbusTcpClient.readCoils,
  q: modbusTcpClient.queueRequest,
};
modbusTcpClient.writeSingleCoil = async (host, port, unit, ch, state) => {
  if (!CURRENT) throw new Error('coil write outside a simulation');
  return CURRENT.onWrite(host, unit, ch, state);
};
modbusTcpClient.writeSingleCoilFireAndForget = modbusTcpClient.writeSingleCoil;
modbusTcpClient.readCoils = async () => { throw new Error('readCoils must not be needed (no interlock pairs on the dosing board)'); };
modbusTcpClient.queueRequest = async () => { throw new Error('no real Modbus traffic in tests'); };
test.after(() => Object.assign(modbusTcpClient, { writeSingleCoil: realModbus.w, writeSingleCoilFireAndForget: realModbus.f, readCoils: realModbus.r, queueRequest: realModbus.q }));

// ─── fixtures: dosing board, SEKO sensor, tanks 1-5, programs ──────────────
const COILS = JSON.stringify([1, 2, 3, 4, 5, 6].map(ch => ({ name: `Relay ${ch}`, register: String(ch), type: 'coil' })));
const nowIso = () => new Date().toISOString();
const DOSE_EQ = Number(db.prepare("INSERT INTO equipment (name, type, protocol, address, slave_id, status, register_mappings, last_reading, last_communication) VALUES ('Waveshare Irrigation 2 (sim)', 'relay', 'modbus', '192.0.2.77:502', 2, 'online', ?, ?, ?)")
  .run(COILS, JSON.stringify({ relayStates: { 1: false, 2: false, 3: false, 4: false, 5: false, 6: false } }), nowIso()).lastInsertRowid);
const IRR_MAPPINGS = JSON.stringify([
  { name: 'Irrigation Pump', register: '1', type: 'coil' }, { name: 'Mixing Pump', register: '2', type: 'coil' },
  { name: 'Irrigation Zone 1', register: '3', type: 'coil' }, { name: 'Irrigation Zone 2', register: '4', type: 'coil' },
  { name: 'Irrigation Zone 3', register: '5', type: 'coil' }, { name: 'Irrigation Zone 4', register: '6', type: 'coil' },
]);
const IRR_EQ = Number(db.prepare("INSERT INTO equipment (name, type, protocol, address, slave_id, status, register_mappings) VALUES ('Waveshare Irrigation 1 (sim)', 'relay', 'modbus', '192.0.2.77:502', 6, 'online', ?)").run(IRR_MAPPINGS).lastInsertRowid);
const dbTs = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const PH_EQ = Number(db.prepare("INSERT INTO equipment (name, type, protocol, address, slave_id, status) VALUES ('SEKO Kontrol 800 (sim)', 'sensor', 'modbus', '192.0.2.77:502', 3, 'online')").run().lastInsertRowid);
const TANK_NAMES = ['Tank A — Calcium nitrate', 'Tank B — Mg + MKP + K2SO4', 'Tank C — Potassium nitrate', 'Tank D — Fe EDDHA + Fetrilon', 'Tank 5 — pH Down'];
for (let id = 1; id <= 5; id++) {
  const ch = id === 5 ? 1 : id + 1;
  const role = id === 5 ? 'ph_down' : 'nutrient';
  if (db.prepare('SELECT id FROM fertigation_tanks WHERE id = ?').get(id)) {
    db.prepare('UPDATE fertigation_tanks SET name = ?, equipment_id = ?, channel = ?, role = ?, active = 1 WHERE id = ?').run(TANK_NAMES[id - 1], DOSE_EQ, ch, role, id);
  } else {
    db.prepare('INSERT INTO fertigation_tanks (id, name, equipment_id, channel, role) VALUES (?, ?, ?, ?, ?)').run(id, TANK_NAMES[id - 1], DOSE_EQ, ch, role);
  }
}
function makeProgram(name, mode) {
  const id = Number(db.prepare("INSERT INTO fertigation_dose_programs (name, window_seconds, min_valve_on_seconds, min_valve_off_seconds, compatibility_strategy, status, control_mode) VALUES (?, 60, 5, 5, 'permissive', 'published', ?)")
    .run(name, mode).lastInsertRowid);
  for (const [i, tid] of [1, 2, 3, 4].entries()) {
    db.prepare('INSERT INTO fertigation_dose_program_tanks (program_id, tank_id, duty_pct, priority) VALUES (?, ?, 100, ?)').run(id, tid, i % 2);
  }
  return id;
}
const CLOSED_PROGRAM = makeProgram('Full Strength Permissive — nutrients only (sim, closed loop)', 'closed_loop');
const OPEN_PROGRAM = makeProgram('Full Strength Permissive (sim, open loop)', 'open_loop');
const CH_OF_TANK = { 1: 2, 2: 3, 3: 4, 4: 5, 5: 1 };
const NUTRIENT_CH = [2, 3, 4, 5];
const ACID_CH = 1;

// Deterministic noise (LCG + Box-Muller).
function noiseGen(seed = 42) {
  let s = seed >>> 0;
  const u = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
  return (sd) => sd * Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}
const lerp = (a, b, x) => a + (b - a) * Math.max(0, Math.min(1, x));

/** Irrigation flow (L/h): pump start ramp, 3 s dip at each zone switch-over, optional stop. */
function flowProfile({ lph = 8820, sd = 80, switches = [210, 420, 630], stops = [], end = 840, zoneLph = null } = {}) {
  return (rel, sim) => {
    if (rel < 2 || rel >= end) return 0;
    if (rel < 8) return lerp(0, lph, (rel - 2) / 6);
    for (const [a, b] of stops) if (rel >= a && rel < b) return 0;
    for (const sw of switches) if (rel >= sw + 0.5 && rel < sw + 3.5) return rel < sw + 2 ? 300 : 1200;
    let base = lph;
    if (zoneLph) { let acc = 0; for (let i = 0; i < switches.length; i++) if (rel >= switches[i]) acc = i + 1; base = zoneLph[acc] ?? lph; }
    return base + sim.noise(sd);
  };
}

/**
 * Coupled venturi plant: open valve i draws base_i x gain x k(n_open) x ramp
 * (L/min) while water flows; k rises as fewer valves share the suction. The
 * monitor reports 0.25 L consumed_l counters (1 s) and the net accumulator at
 * 0.0001 m3 (0.5 s) — 10 s cadence when idle. pH: 20-50 L flow-through buffer
 * (first order, tau) + transport dead time to the SEKO cup, sampled every 10 s
 * while boosted (else 30 s); stagnant between runs.
 */
class Sim {
  constructor(o = {}) {
    this.o = {
      duration: 840, base: [1.68, 1.42, 1.51, 1.54], gain: 1, k: { 4: 1, 3: 1.12, 2: 1.25, 1: 1.4 },
      flow: null, dryDraw: false, stuck: {}, monitorDown: [], sekoDown: [], sekoFn: null,
      ph: null, config: {}, seed: 7, flowWatch: false, t0: Date.parse('2026-09-26T05:30:00Z'),
      program: CLOSED_PROGRAM, automationId: null, rateNoise: 0.03, idleHoldS: 30, zoneS: 210, zoneCount: 4, keepRuns: false, ...o,
    };
    if (!o.duration) this.o.duration = this.o.zoneS * this.o.zoneCount;
    // zone plan like automation 98: pump + mixing pump for the whole run, zones 3-6 one after the other
    this.zoneStarts = Array.from({ length: this.o.zoneCount }, (_, i) => i * this.o.zoneS);
    const actions = [
      { type: 'control', action: 'on', equipment_id: IRR_EQ, channel: 1, duration_seconds: this.o.duration },
      { type: 'control', action: 'on', equipment_id: IRR_EQ, channel: 2, duration_seconds: this.o.duration },
      ...this.zoneStarts.map((at, i) => ({ type: 'control', action: 'on', equipment_id: IRR_EQ, channel: 3 + (i % 4), delay_seconds: at, duration_seconds: this.o.zoneS })),
    ];
    if (this.o.automationId === null) {
      this.o.automationId = Number(db.prepare("INSERT INTO automations (name, trigger_config, actions, enabled) VALUES (?, '{}', ?, 0)")
        .run(`Fertigation sim ${Math.random().toString(36).slice(2, 8)}`, JSON.stringify(actions)).lastInsertRowid);
    }
    if (!this.o.keepRuns) db.prepare('DELETE FROM dose_controller_runs').run();
    db.prepare("DELETE FROM alerts WHERE source IN ('dose_controller', 'flow_watch')").run();
    // the test DB's SEKO row is not id 17
    this.o.config = {
      ...this.o.config,
      ph: { sensor_equipment_id: PH_EQ, ...((o.config && o.config.ph) || {}) },
      nutrients: { irrigation_equipment_id: IRR_EQ, ...((o.config && o.config.nutrients) || {}) },
    };
    this.partialSteps = 0;
    this.lastWetRel = -Infinity;
    this.o.flow = this.o.flow || flowProfile({ end: this.o.duration, switches: this.zoneStarts.slice(1) });
    this.t0 = this.o.t0;
    this.t = this.t0 - 30000;
    this.noise = noiseGen(this.o.seed);
    this.valve = { 1: false, 2: false, 3: false, 4: false, 5: false, 6: false };
    this.consumed = { 1: 221, 2: 208.25, 3: 192.75, 4: 104, 5: 0 };
    this.rates = { 1: 0, 2: 0, 3: 0, 4: 0 };
    this.net = 76281.1; // litres
    this.writes = [];
    this.waterSince = null;
    this.flowNow = 0;
    this.lastFlowEmit = -Infinity;
    this.lastDoseEmit = -Infinity;
    this.lastSeko = -Infinity;
    this.lastRelayPoll = -Infinity;
    this.acidOpenS = 0;
    this.phLog = [];
    this.override = null;
    const sim = this;
    this.poller = {
      calls: [],
      setIntervalOverride(eq, ms, opts) { this.calls.push(['set', eq, ms, opts]); sim.override = { eq, ms, opts }; return true; },
      clearIntervalOverride(eq) { this.calls.push(['clear', eq]); sim.override = null; return true; },
    };
    if (this.o.ph) {
      this.phX = this.o.ph.stagnant ?? 5.82;
      this.phHist = [];
    }
    db.prepare('UPDATE equipment SET last_reading = NULL, last_communication = NULL WHERE id = ?').run(PH_EQ);
    db.prepare('UPDATE equipment SET last_reading = ?, last_communication = ? WHERE id = ?')
      .run(JSON.stringify({ relayStates: { ...this.valve } }), new Date(this.t).toISOString(), DOSE_EQ);
    this.ctl = new DoseController({
      db, now: () => this.t, createAlert, updateOpenAlert, arming: automationArmingService,
      poller: this.poller, autoTick: false, logger: quiet, config: this.o.config, tz: 'Asia/Dubai',
    });
    this.sched = new FertigationDoseScheduler({ controller: this.ctl });
    if (this.o.flowWatch) {
      const { fertigationDoseScheduler: _unused } = { fertigationDoseScheduler: null };
      this.fw = new IrrigationFlowWatchService({
        db, now: () => this.t, createAlert, updateOpenAlert, logger: quiet, notify: async () => {},
        doseScheduler: this.sched,
        config: { irrigation_equipment_id: 999999, dosing_equipment_id: DOSE_EQ },
      });
    }
    this.alertMark = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM alerts').get().id;
    this.eventMark = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM relay_events').get().id;
    CURRENT = this;
  }

  rel() { return (this.t - this.t0) / 1000; }

  zoneEvent(ch, on) {
    db.prepare('INSERT INTO relay_events (equipment_id, channel, state, source, automation_id, confirmed, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
      .run(IRR_EQ, ch, on ? 1 : 0, on ? 'automation' : 'automation_auto_off', this.o.automationId, dbTs(this.t));
  }

  onWrite(host, unit, ch, state) {
    this.writes.push({ rel: this.rel(), ch, state });
    if (this.o.stuck[ch] && !state) return;
    if (ch === ACID_CH && this.valve[ch] && !state) this.acidOpenS += this.rel() - this.acidOpenedAt;
    if (ch === ACID_CH && !this.valve[ch] && state) this.acidOpenedAt = this.rel();
    this.valve[ch] = state;
  }

  down(list, rel) { return list.some(([a, b]) => rel >= a && rel < b); }

  plant(dt) {
    const rel = this.rel();
    const flow = Math.max(0, this.o.flow(rel, this));
    this.flowNow = flow;
    this.net += (flow / 3600) * dt;
    if (flow > 4410 && this.waterSince === null) this.waterSince = rel;
    if (flow < 100 && rel > 10 && rel >= this.o.duration) this.waterSince = null;
    const nOpen = NUTRIENT_CH.filter(ch => this.valve[ch]).length;
    if (nOpen > 0 && nOpen < 4) this.partialSteps++;
    const k = this.o.k[nOpen] || 1;
    const motive = flow >= 0.2 * 8820 ? Math.min(1.1, flow / 8820) : (this.o.dryDraw && rel < this.o.duration ? 1 : 0);
    const since = this.waterSince === null ? 0 : rel - this.waterSince;
    const ramp = 0.75 + 0.25 * (1 - Math.exp(-since / 60)); // venturi draw builds up over the first minutes
    for (let i = 0; i < 4; i++) {
      const ch = NUTRIENT_CH[i];
      const r = this.valve[ch] ? this.o.base[i] * this.o.gain * k * ramp * motive * (1 + this.noise(this.o.rateNoise)) : 0;
      this.rates[i + 1] = Math.max(0, r);
      this.consumed[i + 1] += (this.rates[i + 1] / 60) * dt;
    }
    if (this.o.ph) {
      const p = this.o.ph;
      if (flow > 1000) {
        const w = this.waterSince === null ? 0 : rel - this.waterSince;
        const feed = p.feed(w, rel);
        const pin = feed - (this.valve[ACID_CH] ? p.Ka : 0);
        this.phX += ((pin - this.phX) * dt) / (p.tau ?? 15);
      }
      this.phHist.push([rel, this.phX]);
      if (this.phHist.length > 400) this.phHist.shift();
    }
  }

  cupPh() {
    const dead = this.o.ph.dead ?? 10;
    const target = this.rel() - dead;
    let v = this.phHist.length ? this.phHist[0][1] : this.phX;
    for (const [r, x] of this.phHist) { if (r <= target) v = x; else break; }
    return v;
  }

  emit() {
    const rel = this.rel();
    if (this.flowNow > 50) this.lastWetRel = rel;
    const active = rel - this.lastWetRel <= this.o.idleHoldS; // device keeps its live cadence a while after flow stops
    const monitorUp = !this.down(this.o.monitorDown, rel);
    if (monitorUp && rel - this.lastFlowEmit >= (active ? 0.5 : 10) - 1e-9) {
      this.lastFlowEmit = rel;
      const evt = { kind: 'flowmeter', farmId: '1021', equipmentId: 19, receivedMs: this.t, live: true,
        values: { flow_lph: Math.round(this.flowNow * 10) / 10, net_total_m3: Math.floor((this.net / 1000) * 10000) / 10000, signal_quality: 95, error_flags: 0 } };
      this.ctl.ingest(evt);
      if (this.fw) this.fw.ingest(evt);
    }
    if (monitorUp && rel - this.lastDoseEmit >= (active ? 1 : 10) - 1e-9) {
      this.lastDoseEmit = rel;
      const tanks = [1, 2, 3, 4].map(id => ({ id, consumed_l: Math.floor(this.consumed[id] * 4) / 4, rate_lph: Math.round(this.rates[id] * 600) / 10 }));
      tanks.push({ id: 5, consumed_l: 0, rate_lph: null });
      const evt = { kind: 'dosing', farmId: '1021', equipmentId: 19, receivedMs: this.t, live: true, tanks };
      this.ctl.ingest(evt);
      if (this.fw) this.fw.ingest(evt);
    }
    if (this.o.ph) {
      const every = this.override ? this.override.ms / 1000 : 30;
      if (rel - this.lastSeko >= every - 1e-9) {
        this.lastSeko = rel;
        if (!this.down(this.o.sekoDown, rel)) {
          const cup = this.cupPh();
          const v = this.o.sekoFn ? this.o.sekoFn(rel, cup, this) : Math.round((cup + this.noise(0.01)) * 100) / 100;
          const ec = this.o.ecFn ? this.o.ecFn(rel, this) : 2900;
          db.prepare('UPDATE equipment SET last_reading = ?, last_communication = ? WHERE id = ?')
            .run(JSON.stringify({ values: { pH: { value: v, unit: 'pH' }, 'Water EC': { value: ec, unit: 'µS/cm' } } }), new Date(this.t).toISOString(), PH_EQ);
          this.phLog.push({ rel, v });
        }
      }
    }
    if (rel - this.lastRelayPoll >= 15 - 1e-9) {
      this.lastRelayPoll = rel;
      db.prepare('UPDATE equipment SET last_reading = ?, last_communication = ? WHERE id = ?')
        .run(JSON.stringify({ relayStates: { ...this.valve } }), new Date(this.t).toISOString(), DOSE_EQ);
    }
  }

  async start() {
    this.startResult = await this.sched.startCycle({ programId: this.o.program, durationSeconds: this.o.duration, automationId: this.o.automationId });
    // the scheduler's real end timer must never keep the test process alive (the sim ends the cycle itself)
    if (this.sched._active) for (const tm of this.sched._active.timers) if (tm && tm.unref) tm.unref();
  }

  async run({ to, actions = {}, dt = 0.25 } = {}) {
    const acts = new Map(Object.entries(actions).map(([k, fn]) => [Math.round(Number(k) * 100), fn]));
    const end = Math.round(to * 100);
    while (Math.round(this.rel() * 100) <= end) {
      const key = Math.round(this.rel() * 100);
      for (const [i, at] of this.zoneStarts.entries()) {
        const ch = 3 + (i % 4);
        if (key === Math.round(at * 100)) this.zoneEvent(ch, true);
        const offAt = i === this.zoneStarts.length - 1 ? at + this.o.zoneS : at + this.o.zoneS + 1; // 1 s overlap at switch-over
        if (key === Math.round(offAt * 100)) this.zoneEvent(ch, false);
      }
      if (key === 0 && !this.startResult) await this.start();
      if (acts.has(key)) await acts.get(key)(this);
      this.plant(dt);
      this.emit();
      if (this.ctl.cycle) this.ctl.step(this.t);
      if (this.fw && key % 500 === 0) this.fw.evaluate(this.t);
      await this.ctl.flush();
      if (this.fw) await this.fw.flush();
      if (key === Math.round(this.o.duration * 100) && this.sched.isRunning()) await this.sched._completeCycle();
      this.t += Math.round(dt * 1000);
    }
    await this.ctl.flush();
  }

  run_() { return this.ctl.getRun(this.runId()); }
  runId() { return db.prepare('SELECT MAX(id) AS id FROM dose_controller_runs').get().id; }
  alerts() { return db.prepare("SELECT * FROM alerts WHERE id > ? AND source = 'dose_controller' ORDER BY id").all(this.alertMark); }
  events(where = '1=1') { return db.prepare(`SELECT channel, state, source, created_at FROM relay_events WHERE id > ? AND equipment_id = ? AND ${where} ORDER BY id`).all(this.eventMark, DOSE_EQ); }
  writesFor(ch) { return this.writes.filter(w => w.ch === ch); }
  onWrites(ch, from = -Infinity, to = Infinity) { return this.writes.filter(w => w.ch === ch && w.state && w.rel >= from && w.rel < to); }
  dispose() {
    if (this.sched._active) for (const t of this.sched._active.timers) clearTimeout(t); // a failed test must not leave the real end timer running
    this.ctl.stop();
    if (this.fw) this.fw.stop();
    db.prepare("DELETE FROM alerts WHERE source IN ('dose_controller', 'flow_watch')").run();
    CURRENT = null;
  }
}

function tankOf(run, id) { return run.tanks.find(t => t.tank_id === id); }
function devPct(t) { return ((t.dosed_l - t.target_l) / t.target_l) * 100; }

/** Intervals between consecutive state changes on one channel (from the stubbed coil writes). */
function minIntervals(sim, ch) {
  const w = sim.writesFor(ch).filter(x => x.rel < sim.o.duration - 0.01); // the end-of-cycle close is not a control decision
  let minOn = Infinity; let minOff = Infinity;
  for (let i = 1; i < w.length; i++) {
    const d = w[i].rel - w[i - 1].rel;
    if (w[i - 1].state && !w[i].state) minOn = Math.min(minOn, d);
    if (!w[i - 1].state && w[i].state) minOff = Math.min(minOff, d);
  }
  return { minOn, minOff, switches: w.length };
}

// ─── per-zone litre targets (default nutrient mode) ────────────────────────

function onCounts(sim) { return Object.fromEntries(NUTRIENT_CH.map(ch => [ch, sim.onWrites(ch, 0, sim.o.duration - 0.01).length])); }

test('(a) 09:30-like high draw, 4 x 3.5-min zones: run totals within ±3 % of 1:150, each tank opens once and closes once per zone', async () => {
  const sim = new Sim({ base: [1.68, 1.42, 1.51, 1.54] });
  await sim.run({ to: 845 });
  const run = sim.run_();
  assert.equal(run.status, 'completed');
  assert.ok(run.water_l > 1950 && run.water_l < 2100, `water ${run.water_l} L`);
  for (const id of [1, 2, 3, 4]) {
    const t = tankOf(run, id);
    assert.ok(Math.abs(devPct(t)) <= 3, `${t.name}: ${t.dosed_l} L vs ${t.target_l} L (${devPct(t).toFixed(1)} %, 1:${t.achieved_ratio})`);
    assert.equal(t.cant_reach_zones, 0);
    assert.equal(t.overdose_trips, 0);
  }
  // zone records: 4 zones, every tank closed by its target in every zone
  const zones = sim.run_().zones;
  assert.equal(zones.length, 4);
  for (const z of zones) {
    assert.equal(z.tanks.length, 4);
    for (const zt of z.tanks) {
      assert.equal(zt.closed_by, 'target', `${z.name} ${zt.name} closed by ${zt.closed_by}`);
      assert.equal(zt.cant_reach, false);
      assert.ok(Math.abs(zt.dosed_l - zt.target_l) <= 0.35, `${z.name} ${zt.name}: ${zt.dosed_l} vs ${zt.target_l} L`);
    }
  }
  assert.equal(zones[1].tanks[0].carry_in_l, zones[0].tanks[0].carry_out_l, 'carry-over passed to the next zone');
  // ~1 open + 1 close per tank per zone
  const ons = onCounts(sim);
  for (const ch of NUTRIENT_CH) assert.ok(ons[ch] >= 4 && ons[ch] <= 6, `ch${ch}: ${ons[ch]} opens in 4 zones`);
  // measured water from the accumulator, not the integral
  assert.ok(run.modes.water_integrated_l < 30, `integrated fallback ${run.modes.water_integrated_l} L`);
  // every valve closed at the end through the scheduler end path; controller writes carry their sources
  assert.deepEqual(sim.events("source = 'dose_program_end'").map(e => e.channel).sort(), [1, 2, 3, 4, 5]);
  for (const ch of [1, 2, 3, 4, 5]) assert.equal(sim.valve[ch], false, `ch${ch} closed`);
  assert.equal(sim.events("source NOT IN ('dose_controller', 'dose_program_end', 'ph_controller')").length, 0);
  sim.dispose();
});

test('(a2) tracking mode (nutrients.mode = "tracking") still lands ±5 % (continuous open/close, bounded by min on/off)', async () => {
  const sim = new Sim({ base: [1.68, 1.42, 1.51, 1.54], config: { nutrients: { mode: 'tracking' } } });
  await sim.run({ to: 845 });
  const run = sim.run_();
  for (const id of [1, 2, 3, 4]) assert.ok(Math.abs(devPct(tankOf(run, id))) <= 5, `tank ${id} ${devPct(tankOf(run, id)).toFixed(1)} %`);
  for (const ch of NUTRIENT_CH) {
    const { minOn, minOff, switches } = minIntervals(sim, ch);
    assert.ok(minOn >= 10 - 1e-6 && minOff >= 10 - 1e-6, `ch${ch} min on ${minOn} / off ${minOff}`);
    assert.ok(switches <= 2 * (840 / 20) + 2, `ch${ch} ${switches} writes`);
  }
  sim.dispose();
});

test('(b) 12:30-like low draw (1.07/1.10/1.10/0.85), flow ~9,150: A-C within ±3 %; slow D flagged "can\'t reach" per zone, shortfall carried and alerted', async () => {
  const sim = new Sim({ base: [1.07, 1.10, 1.10, 0.85], flow: flowProfile({ lph: 9150, switches: [210, 420, 630] }) });
  await sim.run({ to: 845 });
  const run = sim.run_();
  for (const id of [1, 2, 3]) {
    const t = tankOf(run, id);
    assert.ok(Math.abs(devPct(t)) <= 3, `${t.name}: ${devPct(t).toFixed(1)} % (1:${t.achieved_ratio}, can't reach in ${t.cant_reach_zones} zones)`);
  }
  const d = tankOf(run, 4);
  if (Math.abs(devPct(d)) > 3) {
    assert.ok(d.cant_reach_zones >= 2, `D can't reach in ${d.cant_reach_zones} zones`);
    assert.ok(d.open_pct >= 90, `D open ${d.open_pct} %`);
    assert.equal(d.physics_limited, true);
    assert.ok(sim.alerts().some(a => a.fingerprint === 'dose_controller:underdose:4'), 'underdose alert for D');
    assert.ok(run.trips.some(t => t.kind === 'cant_reach' && /Tank D/.test(t.detail)));
  }
  const zones = sim.run_().zones;
  const dz = zones.map(z => z.tanks.find(t => t.tank_id === 4));
  assert.ok(dz[1].carry_in_l > 0, 'D shortfall carried into zone 2');
  assert.ok(dz[1].carry_in_l <= 0.5 * (zones[0].water_l / 150) + 0.01, 'carry clamped to 50 % of a zone target');
  sim.dispose();
});

test('(c) coupled suction (k 1/1.25/1.5/1.8) + run gain ±40 %: closing one valve speeds up the others; reachable tanks within ±3 %, others flagged', async () => {
  for (const gain of [1.4, 0.6]) {
    const sim = new Sim({ base: [1.68, 1.42, 1.51, 1.54], gain, k: { 4: 1, 3: 1.25, 2: 1.5, 1: 1.8 }, seed: 11 });
    await sim.run({ to: 845 });
    const run = sim.run_();
    if (gain === 1.4) assert.ok(sim.partialSteps > 200, 'coupled regime exercised (1-3 valves open)');
    for (const id of [1, 2, 3, 4]) {
      const t = tankOf(run, id);
      if (t.cant_reach_zones === 0) assert.ok(Math.abs(devPct(t)) <= 3, `gain ${gain} ${t.name}: ${devPct(t).toFixed(1)} %`);
      else assert.ok(devPct(t) < -1 && t.open_pct > 80, `gain ${gain} ${t.name}: flagged but ${devPct(t).toFixed(1)} %, open ${t.open_pct} %`);
    }
    if (gain === 1.4) for (const id of [1, 2, 3, 4]) assert.equal(tankOf(run, id).cant_reach_zones, 0);
    sim.dispose();
  }
});

test('(c2) short 2-min zones and long 4.5-min zones: run totals within ±3 %, ~1 open per tank per zone', async () => {
  for (const zoneS of [120, 270]) {
    const sim = new Sim({ base: [1.5, 1.42, 1.51, 1.45], zoneS, seed: 13 });
    await sim.run({ to: zoneS * 4 + 5 });
    const run = sim.run_();
    for (const id of [1, 2, 3, 4]) assert.ok(Math.abs(devPct(tankOf(run, id))) <= 3, `${zoneS} s zones, tank ${id}: ${devPct(tankOf(run, id)).toFixed(1)} %`);
    const ons = onCounts(sim);
    for (const ch of NUTRIENT_CH) assert.ok(ons[ch] >= 4 && ons[ch] <= 6, `${zoneS} s zones ch${ch}: ${ons[ch]} opens`);
    sim.dispose();
  }
});

test('(c3) per-zone flow differences (zone flows 8,500-9,300 L/h) and slots_per_zone = 2 (half-zone targets) still within ±3 %', async () => {
  const flow = flowProfile({ switches: [210, 420, 630], zoneLph: [8500, 9300, 8800, 9100] });
  const sim = new Sim({ base: [1.68, 1.42, 1.51, 1.54], flow, config: { nutrients: { slots_per_zone: 2 } }, seed: 17 });
  await sim.run({ to: 845 });
  const run = sim.run_();
  for (const id of [1, 2, 3, 4]) assert.ok(Math.abs(devPct(tankOf(run, id))) <= 3, `tank ${id}: ${devPct(tankOf(run, id)).toFixed(1)} %`);
  const zones = sim.run_().zones;
  assert.equal(zones.length, 8, '4 zones x 2 slots');
  const ons = onCounts(sim);
  for (const ch of NUTRIENT_CH) assert.ok(ons[ch] >= 8 && ons[ch] <= 11, `ch${ch}: ${ons[ch]} opens in 8 half-zones`);
  sim.dispose();
});

// ─── (d) water stops ───────────────────────────────────────────────────────

test('(d) water stops mid-zone: acid closes at once, nutrient valves within no_water_s (+1 sample); nothing opens without water; they reopen when it returns', async () => {
  const stopAt = 230; const resumeAt = 300; // early in zone 2 (210-420 s): valves still filling
  const sim = new Sim({ flow: flowProfile({ stops: [[stopAt, resumeAt]] }), ph: phPlant({ base: 6.1, Ka: 1.5 }) });
  await sim.run({ to: 845 });
  const noWater = DEFAULT_CONFIG.nutrients.no_water_s;
  let reopened = 0;
  for (const ch of NUTRIENT_CH) {
    const w = sim.writesFor(ch).filter(x => x.rel >= stopAt && x.rel < resumeAt);
    const before = sim.writesFor(ch).filter(x => x.rel < stopAt).slice(-1)[0];
    if (before && before.state) {
      assert.ok(w.length && w[0].state === false, `ch${ch} closed`);
      assert.ok(w[0].rel <= stopAt + noWater + 0.75, `ch${ch} closed at +${(w[0].rel - stopAt).toFixed(2)} s`);
      if (sim.onWrites(ch, resumeAt, resumeAt + 30).length) reopened++;
    }
    assert.equal(w.filter(x => x.state).length, 0, `ch${ch}: no ON while no water`);
  }
  assert.ok(reopened >= 1, 'valves closed by the water stop reopen when water returns');
  assert.equal(sim.onWrites(ACID_CH, stopAt, resumeAt + 45).length, 0, 'no acid while dry and not until the start delay after water returns');
  const run = sim.run_();
  for (const id of [1, 2, 3, 4]) assert.ok(Math.abs(devPct(tankOf(run, id))) <= 4, `tank ${id} ${devPct(tankOf(run, id)).toFixed(1)} % after the stop`);
  sim.dispose();
});

test('(d2) zone switch-over dips (3 s below 50 %) do not close the nutrient valves as a water stop', async () => {
  const sim = new Sim({ base: [1.07, 1.10, 1.10, 0.85] });
  await sim.run({ to: 845 });
  const run = sim.run_();
  const zones = sim.run_().zones;
  for (const z of zones) for (const t of z.tanks) assert.notEqual(t.closed_by, 'no water', `${z.name} ${t.name}`);
  assert.ok(!run.trips.some(t => /no water/.test(t.detail || '')));
  sim.dispose();
});

// ─── (e) monitor stale -> fallback -> resume ───────────────────────────────

test('(e) monitor silent 60 s mid-zone: fixed-schedule fallback after 10 s (all open), caution alert, closed loop resumes; totals within ±5 %', async () => {
  const sim = new Sim({ monitorDown: [[300, 360]] });
  let modeAt320 = null; let modeAt370 = null; let valvesAt330 = null;
  await sim.run({
    to: 845,
    actions: {
      320: (s) => { modeAt320 = s.ctl.getStatus(s.t).mode; },
      330: (s) => { valvesAt330 = NUTRIENT_CH.map(ch => s.valve[ch]); },
      370: (s) => { modeAt370 = s.ctl.getStatus(s.t).mode; },
    },
  });
  assert.equal(modeAt320, 'fallback');
  assert.deepEqual(valvesAt330, [true, true, true, true], 'program 100 % duty -> all open in fallback');
  assert.equal(modeAt370, 'closed_loop');
  const run = sim.run_();
  assert.equal(run.modes.fallback_periods.length, 1);
  assert.ok(run.modes.fallback_s >= 45 && run.modes.fallback_s <= 55, `fallback ${run.modes.fallback_s} s`);
  const al = sim.alerts().filter(a => a.fingerprint === 'dose_controller:fallback');
  assert.equal(al.length, 1);
  assert.equal(al[0].severity, 'info', 'alert rewritten on resume');
  assert.match(al[0].message, /fallback ended after \d+ s/);
  for (const id of [1, 2, 3, 4]) assert.ok(Math.abs(devPct(tankOf(run, id))) <= 5, `tank ${id} ${devPct(tankOf(run, id)).toFixed(1)} %`);
  sim.dispose();
});

test('(e2) monitor dead from the start: waits for start_grace_s, then fixed schedule for the whole cycle (plants still fed)', async () => {
  const sim = new Sim({ monitorDown: [[-100, 2000]] });
  await sim.run({ to: 845 });
  const run = sim.run_();
  assert.ok(run.modes.fallback_s > 800);
  for (const ch of NUTRIENT_CH) assert.ok(sim.onWrites(ch).length >= 1 && sim.onWrites(ch)[0].rel <= 25, `ch${ch} opened by the schedule`);
  sim.dispose();
});

test('(e3) monitor on its idle cadence with a DRY last reading is not "blind": valves stay closed, no schedule fallback', async () => {
  const sim = new Sim({ flow: flowProfile({ stops: [[300, 2000]] }), idleHoldS: 0 });
  await sim.run({ to: 845 });
  for (const ch of NUTRIENT_CH) assert.equal(sim.onWrites(ch, 300).length, 0, `ch${ch} opened after water stopped`);
  assert.equal(sim.run_().modes.fallback_s, 0);
  sim.dispose();
});

// ─── (f) switch count / chatter ────────────────────────────────────────────

test('(f) noisy draw (±15 %) and 0.25 L counters: per-zone mode keeps ~1 open per tank per zone, min on/off respected', async () => {
  const sim = new Sim({ base: [1.9, 1.7, 1.8, 1.75], rateNoise: 0.15, seed: 5 });
  await sim.run({ to: 845 });
  const ons = onCounts(sim);
  for (const ch of NUTRIENT_CH) {
    const { minOn, minOff } = minIntervals(sim, ch);
    assert.ok(minOn >= 10 - 1e-6 && minOff >= 10 - 1e-6, `ch${ch} min on ${minOn} / off ${minOff}`);
    assert.ok(ons[ch] <= 8, `ch${ch}: ${ons[ch]} opens in 4 zones`);
  }
  const run = sim.run_();
  for (const id of [1, 2, 3, 4]) assert.ok(Math.abs(devPct(tankOf(run, id))) <= 3, `tank ${id} ${devPct(tankOf(run, id)).toFixed(1)} %`);
  sim.dispose();
});

// ─── pH plant ──────────────────────────────────────────────────────────────

/**
 * Feed pH seen by the buffer tank: stale-cup/fresh-water flush for the first
 * ~30 s of water (6.5), then the dosing ramp (+0.3 decaying over ~90 s) onto
 * `base`; acid (valve open) lowers the inflow by Ka pH units.
 */
function phPlant({ base = 6.1, Ka = 3, tau = 15, dead = 10, stagnant = 5.82 } = {}) {
  return { Ka, tau, dead, stagnant, feed: (w) => (w < 30 ? 6.5 : base + 0.3 * Math.exp(-(w - 30) / 90)) };
}

/** Mean of the SEKO samples in (a, b] s — the feed pH the plants get, without the PWM ripple. */
function windowMean(sim, a, b) {
  const w = sim.phLog.filter(x => x.rel > a && x.rel <= b);
  return w.length ? w.reduce((acc, x) => acc + x.v, 0) / w.length : NaN;
}
function firstInBand(sim) {
  for (let t = 90; t <= 810; t += 10) if (Math.abs(windowMean(sim, t - 30, t) - 5.65) <= 0.1) return t;
  return null;
}

function acidPulses(sim) {
  const w = sim.writesFor(ACID_CH);
  const pulses = [];
  for (let i = 0; i < w.length; i++) {
    if (w[i].state) {
      const off = w.slice(i + 1).find(x => !x.state);
      pulses.push({ at: w[i].rel, len: off ? off.rel - w[i].rel : null });
    }
  }
  return pulses;
}

test('(g) pH 6.1: acid pulses (>= 3 s, <= 40 % of 30 s) bring the sampled pH into 5.65 ± 0.1; 60 s/cycle cap holds', async () => {
  for (const Ka of [3, 1.5]) {
    const sim = new Sim({ ph: phPlant({ base: 6.1, Ka }), seed: 3 });
    await sim.run({ to: 845 });
    const pulses = acidPulses(sim);
    assert.ok(pulses.length >= 3, `Ka ${Ka}: ${pulses.length} pulses`);
    for (const p of pulses) {
      assert.ok(p.len >= 3 - 0.3 && p.len <= 12 + 0.3, `Ka ${Ka}: pulse ${p.len} s`);
      assert.ok(p.at >= 45 + 5, `Ka ${Ka}: pulse at ${p.at} inside the start delay`);
      assert.ok(p.at < 840 - 30, `Ka ${Ka}: pulse at ${p.at} in the last 30 s`);
    }
    const total = pulses.reduce((s, p) => s + p.len, 0);
    assert.ok(total <= 60 + 0.3, `Ka ${Ka}: ${total.toFixed(1)} s acid`);
    const first = firstInBand(sim);
    assert.ok(first !== null && first <= 400, `Ka ${Ka}: 30 s mean pH reached 5.65 ± 0.1 at ${first} s`);
    const minS = Math.min(...sim.phLog.filter(x => x.rel > 60).map(x => x.v));
    // Ka 3: a 4-5 s pulse into the 15 s buffer swings the cup ~±0.35 pH; single ripple troughs
    // may touch the floor (acid closed, not latched). Ka 1.5 stays clear of it.
    assert.ok(minS >= (Ka >= 3 ? 5.15 : 5.30), `Ka ${Ka}: min sample ${minS}`);
    const run = sim.run_();
    assert.ok(Math.abs(run.acid_s - total) < 1, `recorded ${run.acid_s} vs ${total}`);
    assert.equal(run.acid_est_unverified, true);
    assert.ok(Math.abs(run.acid_est_l - (run.acid_s / 60) * 1.7) < 0.02);
    assert.ok(run.trips.some(t => t.kind === 'acid_cap_cycle'), 'cap reached and recorded (feed stays at 6.1)');
    assert.ok(!run.trips.some(t => t.kind === 'ph_floor'), `Ka ${Ka}: floor not latched`);
    if (Ka < 3) assert.ok(!run.trips.some(t => t.kind === 'ph_floor_touch'), `Ka ${Ka}: no floor touch`);
    assert.ok(run.ph.samples > 50 && run.ph.last !== null);
    assert.ok(run.ec_us.avg > 2800 && run.ec_us.avg < 3000 && run.ec_us.samples > 50, `EC recorded ${JSON.stringify(run.ec_us)}`);
    assert.equal(sim.events("channel = 1 AND source = 'ph_controller'").length, pulses.length * 2);
    // boosted SEKO poll for the cycle, cleared at the end
    assert.deepEqual(sim.poller.calls.map(c => c[0]), ['set', 'clear']);
    assert.equal(sim.poller.calls[0][1], PH_EQ);
    assert.equal(sim.poller.calls[0][2], 10000);
    assert.deepEqual(sim.poller.calls[0][3].requestOptions, { timeout: 1500, retries: 1 });
    sim.dispose();
  }
});

test('(g2) loop stability: with the acid caps lifted the PI holds the 30 s mean at 5.65 ± 0.1 for the rest of the run (Ka 1.5-3, tau 15 s + 10 s dead time; Ka 1 is max-duty limited)', async () => {
  for (const Ka of [1.5, 3]) {
    const sim = new Sim({ ph: phPlant({ base: 6.1, Ka }), config: { ph: { max_acid_s_per_cycle: 600, max_acid_s_per_day: 3600 } }, seed: 9 });
    await sim.run({ to: 845 });
    const means = [];
    for (let t = 330; t <= 800; t += 30) means.push(windowMean(sim, t - 30, t));
    assert.ok(means.every(m => Math.abs(m - 5.65) <= 0.1), `Ka ${Ka}: 30 s means ${means.map(m => m.toFixed(2)).join(' ')}`);
    for (const p of acidPulses(sim)) assert.ok(p.len <= 12.3);
    sim.dispose();
  }
});

// ─── (h) pH limits ─────────────────────────────────────────────────────────

test('(h1) pH 5.2 below the 5.30 floor: acid never opens, critical alarm, locked out for the cycle', async () => {
  const sim = new Sim({ ph: phPlant({ base: 5.2, Ka: 3 }) });
  // pH 5.2 after the flush: feed at 5.2 (fresh-water spike 6.5 first 30 s)
  await sim.run({ to: 845 });
  const run = sim.run_();
  assert.ok(run.trips.some(t => t.kind === 'ph_floor'));
  const al = sim.alerts().filter(a => a.fingerprint === 'dose_controller:ph_floor');
  assert.equal(al.length, 1);
  assert.equal(al[0].severity, 'critical');
  // the dosing ramp (+0.3) keeps feed above 5.30 for a while; after the floor trip no acid at all
  const trip = Date.parse(run.trips.find(t => t.kind === 'ph_floor').at);
  const tripRel = (trip - sim.t0) / 1000;
  assert.equal(sim.onWrites(ACID_CH, tripRel).length, 0, 'no acid after the floor trip');
  sim.dispose();
});

test('(h2) floor trip during dosing: a strong acid (Ka 8) that overshoots below 5.30 closes the valve and locks out; caps still hold', async () => {
  const sim = new Sim({ ph: phPlant({ base: 6.1, Ka: 8 }), seed: 21 });
  await sim.run({ to: 845 });
  const run = sim.run_();
  const pulses = acidPulses(sim);
  assert.ok(pulses.reduce((s, p) => s + p.len, 0) <= 60.3);
  const trip = run.trips.find(t => t.kind === 'ph_floor');
  if (trip) {
    const tripRel = (Date.parse(trip.at) - sim.t0) / 1000;
    assert.equal(sim.onWrites(ACID_CH, tripRel).length, 0);
    assert.equal(sim.valve[ACID_CH], false);
  }
  sim.dispose();
});

test('(h3) pH sensor stale (SEKO silent > 60 s while water flows): acid off + caution; recovers when samples return', async () => {
  const sim = new Sim({ ph: phPlant({ base: 6.1, Ka: 1.5 }), sekoDown: [[150, 260]] });
  await sim.run({ to: 845 });
  const run = sim.run_();
  assert.ok(run.trips.some(t => t.kind === 'ph_stale'));
  const al = sim.alerts().filter(a => a.fingerprint === 'dose_controller:ph_sensor');
  assert.equal(al.length, 1);
  assert.equal(al[0].severity, 'warning');
  // the last sample before the outage is at <= 150 s; acid may finish a pulse within 60 s, never after 150+60+1
  assert.equal(sim.onWrites(ACID_CH, 150 + 61, 260).length, 0, 'no acid on a stale sample');
  assert.ok(sim.onWrites(ACID_CH, 260, 800).length > 0 || run.trips.some(t => t.kind === 'acid_cap_cycle'), 'acid resumes after samples return (or cap)');
  sim.dispose();
});

test('(h4) pH frozen (identical value 3 min while water flows) and implausible (9.5): acid off + caution, latched for the cycle', async () => {
  const frozen = new Sim({ ph: phPlant({ base: 6.1, Ka: 1.5 }), sekoFn: (rel, cup) => (rel > 120 ? 6.02 : Math.round(cup * 100) / 100) });
  await frozen.run({ to: 845 });
  let run = frozen.run_();
  const tf = run.trips.find(t => t.kind === 'ph_frozen');
  assert.ok(tf, 'frozen detected');
  const tfRel = (Date.parse(tf.at) - frozen.t0) / 1000;
  assert.ok(tfRel >= 120 + 180 && tfRel <= 120 + 200, `frozen after ${tfRel - 120} s`);
  assert.equal(frozen.onWrites(ACID_CH, tfRel).length, 0);
  frozen.dispose();

  const bad = new Sim({ ph: phPlant({ base: 6.1, Ka: 1.5 }), sekoFn: (rel, cup) => (rel > 200 && rel < 230 ? 9.5 : Math.round(cup * 100) / 100) });
  await bad.run({ to: 845 });
  run = bad.run_();
  assert.ok(run.trips.some(t => t.kind === 'ph_implausible'));
  assert.equal(bad.onWrites(ACID_CH, 231).length, 0, 'latched after an implausible sample');
  assert.equal(bad.alerts().filter(a => a.fingerprint === 'dose_controller:ph_sensor').length, 1);
  bad.dispose();
});

test('(h5) idle / stagnant cup: frozen and implausible values while no water flows raise nothing', async () => {
  const sim = new Sim({ ph: phPlant({ base: 6.1, Ka: 1.5 }), flow: flowProfile({ stops: [[100, 500]] }), sekoFn: (rel, cup) => (rel > 100 && rel < 500 ? 9.9 : Math.round(cup * 100) / 100) });
  await sim.run({ to: 845 });
  const run = sim.run_();
  assert.ok(!run.trips.some(t => /ph_(implausible|frozen|stale)/.test(t.kind)), JSON.stringify(run.trips));
  assert.equal(sim.alerts().filter(a => a.fingerprint === 'dose_controller:ph_sensor').length, 0);
  sim.dispose();
});

test('(h6) disarmed mid-cycle: every dosing valve closed at once, NO ON writes while disarmed (nutrients or acid); resumes when re-armed', async () => {
  const sim = new Sim({ ph: phPlant({ base: 6.1, Ka: 1.5 }) });
  await sim.run({
    to: 845,
    actions: {
      200: () => automationArmingService.disarm({ by: 'test', reason: 'test e-stop' }),
      400: () => automationArmingService.reArm({ by: 'test' }),
    },
  });
  for (const ch of [...NUTRIENT_CH, ACID_CH]) {
    assert.equal(sim.onWrites(ch, 200, 400).length, 0, `ch${ch} ON while disarmed`);
    const openBefore = sim.writesFor(ch).filter(w => w.rel < 200).slice(-1)[0];
    if (openBefore && openBefore.state) {
      const close = sim.writesFor(ch).find(w => w.rel >= 200 && !w.state);
      assert.ok(close && close.rel <= 201.5, `ch${ch} closed at ${close && close.rel}`);
    }
  }
  const run = sim.run_();
  assert.ok(run.modes.hold_s >= 195 && run.modes.hold_s <= 205, `hold ${run.modes.hold_s}`);
  assert.ok(NUTRIENT_CH.some(ch => sim.onWrites(ch, 400).length > 0), 'dosing resumed after re-arm');
  sim.dispose();
});

test('(h7) acid timing: nothing in the first 45 s of water or the last 30 s; daily 420 s cap counts earlier runs', async () => {
  // earlier runs today already used 400 s
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.parse('2026-09-26T05:30:00Z')));
  db.prepare('DELETE FROM dose_controller_runs').run();
  const prior = Number(db.prepare("INSERT INTO dose_controller_runs (started_at, local_date, status, acid_s) VALUES ('2026-09-26T04:00:00Z', ?, 'completed', 400)").run(date).lastInsertRowid);
  const sim = new Sim({ ph: phPlant({ base: 6.1, Ka: 1.5 }), keepRuns: true });
  await sim.run({ to: 845 });
  const pulses = acidPulses(sim);
  const total = pulses.reduce((s, p) => s + p.len, 0);
  assert.ok(total <= 20 + 0.3, `daily cap: ${total.toFixed(1)} s used with 400 s already today`);
  assert.ok(pulses.length >= 1);
  const water = sim.waterSince ?? 5;
  for (const p of pulses) assert.ok(p.at >= 45 && p.at < 810, `pulse at ${p.at}`);
  assert.ok(sim.run_().trips.some(t => t.kind === 'acid_cap_day'));
  db.prepare('DELETE FROM dose_controller_runs WHERE id = ?').run(prior);
  assert.ok(water < 10);
  sim.dispose();
});

// ─── (i) flow watch still aborts with the controller active ────────────────

test('(i) water stops with tank A\'s valve stuck open (mixing pump keeps the venturi drawing): controller closes B-D + acid, flow watch fires dosing_without_water and aborts through the scheduler; run recorded aborted', async () => {
  const stopAt = 100; // valves still filling their zone 1 targets
  const sim = new Sim({
    flowWatch: true, dryDraw: true, stuck: { 2: true }, ph: phPlant({ base: 6.1, Ka: 1.5 }),
    flow: flowProfile({ stops: [[stopAt, 2000]] }),
  });
  await sim.run({ to: 200 });
  assert.equal(sim.sched.isRunning(), false, 'cycle aborted');
  const run = sim.run_();
  assert.equal(run.status, 'aborted');
  assert.match(run.end_reason, /flow_watch/);
  const fwEv = sim.events("source = 'flow_watch' AND state = 0");
  assert.deepEqual(fwEv.map(e => e.channel).sort(), [1, 2, 3, 4, 5], 'abort closes every dosing valve incl. pH Down');
  for (const ch of [3, 4, 5]) {
    const close = sim.writesFor(ch).find(w => w.rel >= stopAt && !w.state);
    assert.ok(close && close.rel <= stopAt + 6, `ch${ch} closed by the controller at ${close && close.rel}`);
  }
  const fwAlert = db.prepare("SELECT * FROM alerts WHERE source = 'flow_watch' AND fingerprint LIKE 'flow_watch:dosing_without_water:%'").get();
  assert.ok(fwAlert, 'flow watch alarm');
  assert.equal(sim.ctl.cycle, null);
  sim.dispose();
});

// ─── scheduler integration / regression ────────────────────────────────────

test('scheduler: open-loop programs keep the fixed timer schedule (controller not involved)', async () => {
  const fake = { isEnabled: () => true, beginCycle: () => { throw new Error('must not be called'); } };
  const s = new FertigationDoseScheduler({ controller: fake });
  CURRENT = { onWrite() {} };
  const r = await s.startCycle({ programId: OPEN_PROGRAM, durationSeconds: 120, dryRun: true });
  assert.equal(r.control_mode, 'open_loop');
  assert.ok(s._active.timers.length > 3, 'valve timers scheduled');
  await s.abortCycle('test');
  CURRENT = null;
});

test('scheduler: closed-loop program with the controller disabled uses the fixed schedule; a refusing controller falls back too', async () => {
  CURRENT = { onWrite() {} };
  const off = new FertigationDoseScheduler({ controller: { isEnabled: () => false, beginCycle: () => { throw new Error('no'); } } });
  let r = await off.startCycle({ programId: CLOSED_PROGRAM, durationSeconds: 120 });
  assert.equal(r.control_mode, 'open_loop');
  assert.ok(off._active.timers.length > 3);
  await off.abortCycle('test');
  const refusing = new FertigationDoseScheduler({ controller: { isEnabled: () => true, beginCycle: () => { throw new Error('busy'); } } });
  r = await refusing.startCycle({ programId: CLOSED_PROGRAM, durationSeconds: 120 });
  assert.equal(r.control_mode, 'open_loop');
  await refusing.abortCycle('test');
  CURRENT = null;
});

test('scheduler: _writeValve refuses ON while disarmed (OFF still written), logs every write with its source', async () => {
  const sim = new Sim({});
  const s = sim.sched;
  const target = { equipment_id: DOSE_EQ, channel: 3, name: 'B' };
  automationArmingService.disarm({ by: 'test', reason: 'unit' });
  assert.equal(await s._writeValve(target, true, { source: 'dose_controller' }), false);
  assert.equal(await s._writeValve(target, false, { source: 'dose_controller' }), true);
  automationArmingService.reArm({ by: 'test' });
  assert.equal(await s._writeValve(target, true, { source: 'ph_controller', stillValid: () => false }), false, 'superseded ON dropped after the guard');
  assert.equal(await s._writeValve(target, true, { source: 'dose_controller', stillValid: () => true }), true);
  assert.deepEqual(sim.writes.map(w => [w.ch, w.state]), [[3, false], [3, true]]);
  assert.deepEqual(sim.events().map(e => [e.channel, e.state, e.source]), [[3, 0, 'dose_controller'], [3, 1, 'dose_controller']]);
  sim.dispose();
});

test('controller: a failed coil write aborts the cycle (all valves closed via the abort path)', async () => {
  const sim = new Sim({});
  let failed = false;
  const orig = sim.onWrite.bind(sim);
  sim.onWrite = (host, unit, ch, state) => {
    if (!failed && state && ch === 4 && sim.rel() > 100) { failed = true; throw new Error('Request timeout'); }
    return orig(host, unit, ch, state);
  };
  await sim.run({ to: 400 });
  if (failed) {
    await new Promise(r => setImmediate(r));
    await sim.ctl.flush();
    for (let i = 0; i < 5 && sim.sched.isRunning(); i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(sim.sched.isRunning(), false);
    const run = sim.run_();
    assert.equal(run.status, 'aborted');
    assert.ok(run.trips.some(t => t.kind === 'write_failed'));
    assert.deepEqual(sim.events("source = 'dose_controller' AND state = 0").map(e => e.channel).filter((v, i, a) => a.indexOf(v) === i).sort(), [1, 2, 3, 4, 5]);
  }
  assert.ok(failed, 'the failure was injected');
  sim.dispose();
});

test('controller: overdose cap closes a valve that keeps drawing too much (valve stuck on / never switched off by the plant)', async () => {
  const sim = new Sim({ stuck: { 5: true }, base: [1.68, 1.42, 1.51, 2.6] });
  await sim.run({ to: 845 });
  const run = sim.run_();
  const d = tankOf(run, 4);
  assert.ok(d.dosed_l > d.target_l * 1.3, 'stuck valve overdosed (physically)');
  assert.ok(run.trips.some(t => t.kind === 'overdose'));
  assert.ok(run.trips.some(t => t.kind === 'valve_not_closing' || t.kind === 'valve_mismatch'));
  assert.ok(sim.alerts().some(a => /dose_controller:(overdose|valve_leak|valve_mismatch)/.test(a.fingerprint)));
  sim.dispose();
});

test('controller: interrupted run (backend restart) is closed and every dosing valve written OFF at start; a live run is never touched', async () => {
  const id = Number(db.prepare("INSERT INTO dose_controller_runs (started_at, local_date, status) VALUES ('2026-09-26T09:00:00Z', '2026-09-26', 'running')").run().lastInsertRowid);
  const closes = [];
  const ctl = new DoseController({ db, logger: quiet, autoTick: false, closeWriter: async (eq, ch, source) => { closes.push([eq, ch, source]); } });
  ctl.start();
  await ctl.flush();
  ctl.stop();
  assert.equal(db.prepare('SELECT status FROM dose_controller_runs WHERE id = ?').get(id).status, 'interrupted');
  assert.deepEqual(closes.filter(c => c[0] === DOSE_EQ).map(c => c[1]).sort(), [1, 2, 3, 4, 5]);
  assert.ok(closes.every(c => c[2] === 'dose_controller_restart'));
});

test('status: live payload has per-tank target vs dosed, valve + actual state, pH and acid, mode; idle payload has the last run', async () => {
  const sim = new Sim({ ph: phPlant({ base: 6.1, Ka: 3 }) });
  let st = null;
  await sim.run({ to: 845, actions: {
    200: (s) => { st = s.ctl.getStatus(s.t); },
    300: (s) => s.ctl._onEcOverride({ basis: 'dosing', raw: 2500, value: 2500, range: 'high', continuity: 250 }),
  } });
  assert.equal(st.running, true);
  assert.equal(st.mode, 'closed_loop');
  assert.equal(st.tanks.length, 4);
  for (const t of st.tanks) {
    assert.ok(t.target_l > 0 && t.dosed_l > 0 && t.achieved_ratio > 0);
    assert.ok(['open', 'closed'].includes(t.valve));
    assert.ok(t.actual === true || t.actual === false);
  }
  assert.equal(st.ph.enabled, true);
  assert.equal(st.ph.tank.channel, 1);
  assert.ok(st.ph.value > 5 && st.ph.value < 7);
  assert.equal(st.ph.ec_us, 2900);
  assert.equal(st.ph.acid.cap_s, 60);
  assert.equal(st.ph.acid.est_unverified, true);
  assert.ok(st.water.litres > 400 && st.water.flow_ok === true);
  const idle = sim.ctl.getStatus(sim.t);
  assert.equal(idle.running, false);
  assert.equal(idle.last_run.status, 'completed');
  assert.ok(idle.last_run.ph.last !== null);
  assert.ok(idle.last_run.ec_us.avg > 0);
  assert.ok(idle.last_run.trips.some(t => t.kind === 'ec_range_override'), 'EC cross-check override recorded in the run');
  sim.dispose();
});

// ─── config / EC trim ──────────────────────────────────────────────────────

test('config: defaults match the operator decisions; validation rejects bad and unsafe values', () => {
  assert.deepEqual(DEFAULT_CONFIG.nutrients.ratio, { 1: 150, 2: 150, 3: 150, 4: 150 });
  assert.equal(DEFAULT_CONFIG.ph.enabled, true);
  assert.equal(DEFAULT_CONFIG.ph.setpoint, 5.65);
  assert.equal(DEFAULT_CONFIG.ph.max_duty, 0.4);
  assert.equal(DEFAULT_CONFIG.ph.max_acid_s_per_cycle, 60);
  assert.equal(DEFAULT_CONFIG.ph.max_acid_s_per_day, 420);
  assert.equal(DEFAULT_CONFIG.ph.floor_ph, 5.3);
  assert.equal(DEFAULT_CONFIG.nutrients.stop_before_end_s, 0);
  assert.equal(DEFAULT_CONFIG.ph.stop_before_end_s, 30);
  assert.equal(DEFAULT_CONFIG.nutrients.ec_trim.enabled, false);
  assert.equal(crossCheck(mergeConfig(DEFAULT_CONFIG, {})), null);
  assert.ok(validateConfigUpdate({ ph: { max_duty: 0.9 } }).error);
  assert.ok(validateConfigUpdate({ nutrients: { ratio: { 1: 5 } } }).error);
  assert.ok(validateConfigUpdate({ bogus: 1 }).error);
  assert.ok(validateConfigUpdate({ ph: { setpoint: '5.6' } }).error);
  assert.equal(validateConfigUpdate({ nutrients: { ratio: { 4: 160 } }, ph: { kp: 0.2 } }).error, undefined);
  const merged = mergeConfig(DEFAULT_CONFIG, validateConfigUpdate({ nutrients: { ratio: { 4: 160 }, ec_trim: { enabled: true } } }).value);
  assert.equal(merged.nutrients.ratio[4], 160);
  assert.equal(merged.nutrients.ratio[1], 150);
  assert.equal(merged.nutrients.ec_trim.enabled, true);
  assert.equal(merged.nutrients.ec_trim.target_us, 1700, 'partial nested update keeps the other trim fields');
  assert.match(crossCheck(mergeConfig(DEFAULT_CONFIG, { ph: { floor_ph: 5.6 } })), /floor_ph/);
  assert.match(crossCheck(mergeConfig(DEFAULT_CONFIG, { ph: { min_pulse_s: 20 } })), /min_pulse_s/);
  const ctl = new DoseController({ db, logger: quiet, autoTick: false });
  assert.throws(() => ctl.saveConfig({ ph: { floor_ph: 5.6 } }), /floor_ph/);
  const saved = ctl.saveConfig({ nutrients: { ratio: { 4: 160 } } });
  assert.equal(saved.nutrients.ratio[4], 160);
  ctl.saveConfig({ nutrients: { ratio: { 4: 150 } } });
});

test('EC trim (off by default): one bounded, slow step per cycle toward the target EC', () => {
  const trim = { ...DEFAULT_CONFIG.nutrients.ec_trim, enabled: true };
  const base = { 1: 150, 2: 150, 3: 150, 4: 150 };
  assert.equal(computeEcTrim(null, base, DEFAULT_CONFIG.nutrients.ec_trim).applied, false);
  assert.equal(computeEcTrim(null, base, trim).applied, false);
  // feed 2950 µS vs target 1700 (water 250): s = (2700/1450)^0.5 = 1.36 -> limited to +15 %
  let r = computeEcTrim({ id: 9, ec_avg: 2950, ec_samples: 60, tanks: [1, 2, 3, 4].map(id => ({ tank_id: id, ratio_target: 150 })) }, base, trim);
  assert.equal(r.applied, true);
  assert.equal(r.factor, 1.15);
  assert.deepEqual(r.ratios, { 1: 172.5, 2: 172.5, 3: 172.5, 4: 172.5 });
  // repeated steps are bounded at 1:250
  r = computeEcTrim({ id: 10, ec_avg: 2950, ec_samples: 60, tanks: [1, 2, 3, 4].map(id => ({ tank_id: id, ratio_target: 240 })) }, base, trim);
  assert.deepEqual(r.ratios, { 1: 250, 2: 250, 3: 250, 4: 250 });
  // low EC -> richer, bounded at 1:100
  r = computeEcTrim({ id: 11, ec_avg: 900, ec_samples: 60, tanks: [1, 2, 3, 4].map(id => ({ tank_id: id, ratio_target: 105 })) }, base, trim);
  assert.deepEqual(r.ratios, { 1: 100, 2: 100, 3: 100, 4: 100 });
  // too few samples -> no trim
  assert.equal(computeEcTrim({ id: 12, ec_avg: 2950, ec_samples: 2, tanks: [] }, base, trim).applied, false);
});

test('EC trim enabled: the next cycle starts with the trimmed ratios and records it', async () => {
  const first = new Sim({ ph: phPlant({ base: 5.8, Ka: 1.5 }), ecFn: () => 2950, config: { nutrients: { ec_trim: { enabled: true } } } });
  await first.run({ to: 845 });
  const r1 = first.run_();
  assert.equal(r1.trim.applied, false);
  first.dispose();
  const second = new Sim({ ph: phPlant({ base: 5.8, Ka: 1.5 }), ecFn: () => 2950, config: { nutrients: { ec_trim: { enabled: true } } }, keepRuns: true });
  await second.run({ to: 60 });
  const st = second.ctl.getStatus(second.t);
  assert.equal(st.trim.applied, true);
  assert.equal(st.trim.from_run, r1.id);
  assert.ok(st.tanks.every(t => t.ratio_target === 172.5), JSON.stringify(st.tanks.map(t => t.ratio_target)));
  await second.run({ to: 845 });
  assert.equal(second.run_().trim.applied, true);
  second.dispose();
});
