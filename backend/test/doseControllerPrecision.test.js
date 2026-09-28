// Per-zone dosing precision (operator approval 2026-09-28, after run 10 at 07:30:
// 1:200, 3 min soft-switch zones, ~2.2 L per tank per zone, zones at 1:219 /
// 1:195 / 1:199 — the 0.25 L counter alone is ±11 % of such a dose):
//   1. sub-step volume estimate (rate-integrated between 0.25 L counter steps)
//   2. nutrient valves open at the confirmed pump start in soft-switch zones
//   3. the run-start line flush kept out of the per-zone EC/pH averages
// Simulated coupled hydraulic plant: soft-switch zones (valve -> +3 s pump ->
// pump off -> +5 s valve off -> +1 s next), flow ramp 0 -> 8,800 L/h in 8 s,
// venturis on a shared suction (closing one raises the others), 0.25 L
// quantised consumed counters every 1 s with the monitor's own rate (lagged,
// noisy, HELD 20-50 s after a valve closes), flow every 0.5 s, controller tick
// every 1 s, valve write latency. The valve writer is a stub: nothing reaches
// Modbus; the DB is in memory.
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const src = (...p) => require(path.join(__dirname, '..', 'src', ...p));
const { db } = src('utils', 'database.js');
const { DoseController, validateConfigUpdate, DEFAULT_CONFIG, mergeConfig } = src('services', 'DoseController.js');

// Fresh-DB quirk (see flowWatch.test.js): re-add the read-back columns the CHECK-drop migration loses.
{
  const cols = db.pragma('table_info(relay_events)').map(c => c.name);
  if (!cols.includes('confirmed')) db.exec('ALTER TABLE relay_events ADD COLUMN confirmed INTEGER');
  if (!cols.includes('readback_state')) db.exec('ALTER TABLE relay_events ADD COLUMN readback_state INTEGER');
  if (!cols.includes('user_email')) db.exec('ALTER TABLE relay_events ADD COLUMN user_email TEXT');
}

const quiet = { log() {}, warn() {}, error() {} };
const dbTs = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const iso = (ms) => new Date(ms).toISOString();

const IRR_MAPPINGS = JSON.stringify([
  { name: 'Irrigation Pump', register: '1', type: 'coil' }, { name: 'Mixing Pump', register: '2', type: 'coil' },
  { name: 'Irrigation Zone 1', register: '3', type: 'coil' }, { name: 'Irrigation Zone 2', register: '4', type: 'coil' },
  { name: 'Irrigation Zone 3', register: '5', type: 'coil' }, { name: 'Irrigation Zone 4', register: '6', type: 'coil' },
]);
const IRR_EQ = Number(db.prepare("INSERT INTO equipment (name, type, protocol, address, slave_id, status, register_mappings) VALUES ('Irrigation 1 (precision sim)', 'relay', 'modbus', '192.0.2.98:502', 6, 'online', ?)").run(IRR_MAPPINGS).lastInsertRowid);
const DOSE_EQ = Number(db.prepare("INSERT INTO equipment (name, type, protocol, address, slave_id, status) VALUES ('Irrigation 2 (precision sim)', 'relay', 'modbus', '192.0.2.98:502', 2, 'online')").run().lastInsertRowid);
const PH_EQ = Number(db.prepare("INSERT INTO equipment (name, type, protocol, address, slave_id, status) VALUES ('SEKO (precision sim)', 'sensor', 'modbus', '192.0.2.98:502', 3, 'online')").run().lastInsertRowid);
for (let id = 1; id <= 4; id++) {
  const name = `Tank ${'ABCD'[id - 1]}`;
  if (db.prepare('SELECT id FROM fertigation_tanks WHERE id = ?').get(id)) {
    db.prepare("UPDATE fertigation_tanks SET name = ?, equipment_id = ?, channel = ?, role = 'nutrient', active = 1 WHERE id = ?").run(name, DOSE_EQ, id + 1, id);
  } else {
    db.prepare("INSERT INTO fertigation_tanks (id, name, equipment_id, channel, role) VALUES (?, ?, ?, ?, 'nutrient')").run(id, name, DOSE_EQ, id + 1);
  }
}
db.prepare("DELETE FROM fertigation_tanks WHERE role = 'ph_down'").run(); // no acid in these replays

const LEAD = 3; const LAG = 5; const GAP = 1;
const FULL = 8800;

function noiseGen(seed) {
  let s = seed >>> 0;
  const u = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
  const n = (sd) => sd * Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
  n.u = u;
  return n;
}

/** Soft-switch (automation 95-101 structure) or continuous-pump plan for 4 zones x D s of pumping. */
function planActions(D, softSwitch) {
  const actions = []; const zones = []; const pumps = [];
  if (softSwitch) {
    for (let k = 0; k < 4; k++) {
      const t0 = k * (LEAD + D + LAG + GAP);
      actions.push({ type: 'control', action: 'on', equipment_id: IRR_EQ, channel: 3 + k, delay_seconds: t0, duration_seconds: D + LEAD + LAG });
      actions.push({ type: 'control', action: 'on', equipment_id: IRR_EQ, channel: 1, delay_seconds: t0 + LEAD, duration_seconds: D });
      actions.push({ type: 'control', action: 'on', equipment_id: IRR_EQ, channel: 2, delay_seconds: t0 + LEAD, duration_seconds: D });
      zones.push([t0, t0 + LEAD + D + LAG]);
      pumps.push([t0 + LEAD, t0 + LEAD + D]);
    }
  } else {
    actions.push({ type: 'control', action: 'on', equipment_id: IRR_EQ, channel: 1, delay_seconds: 0, duration_seconds: 4 * D });
    actions.push({ type: 'control', action: 'on', equipment_id: IRR_EQ, channel: 2, delay_seconds: 0, duration_seconds: 4 * D });
    for (let k = 0; k < 4; k++) {
      actions.push({ type: 'control', action: 'on', equipment_id: IRR_EQ, channel: 3 + k, delay_seconds: k * D, duration_seconds: D + (k < 3 ? 1 : 0) });
      zones.push([k * D, (k + 1) * D + (k < 3 ? 1 : 0)]);
    }
    pumps.push([0, 4 * D]);
  }
  return { actions, zones, pumps, duration: Math.max(...actions.map(a => a.delay_seconds + a.duration_seconds)) };
}

/**
 * One run of the coupled plant. Returns the run record + the TRUE per-zone water
 * and litres (what actually went to each zone), valve command log, alerts.
 */
async function runPlant({
  D = 180, ratio = 200, draws = { 1: 1.10, 2: 1.12, 3: 1.08, 4: 1.05 }, softSwitch = true, seed = 3,
  nutrients = {}, stats = {}, rateMode = 'normal', rateBias = 1, counterReset = null, stuck = [],
  pumpConfirmed = true, zoneConfirmed = true, disarmedAt = null, latencyS = 0.4, holdS = [20, 50], stuckOpen = null, skipFirstPumpEvent = false,
  seko = (rel, flow) => (flow < 1000 ? [700, 7.3] : [1850, 6.1]), snapshot = null, until = null,
} = {}) {
  db.prepare('DELETE FROM dose_controller_runs').run();
  db.prepare('DELETE FROM relay_events').run();
  const plan = planActions(D, softSwitch);
  const auto = Number(db.prepare("INSERT INTO automations (name, trigger_config, actions, enabled) VALUES ('Fertigation (precision sim)', '{}', ?, 0)")
    .run(JSON.stringify(plan.actions)).lastInsertRowid);
  const T0 = Date.parse('2026-09-28T03:30:00Z'); // 07:30 Asia/Dubai
  let t = T0;
  const alerts = [];
  let disarmed = false;
  const ctl = new DoseController({
    db, now: () => t, autoTick: false, logger: quiet, arming: { isDisarmed: () => disarmed },
    createAlert: (a) => { alerts.push(a); return { id: alerts.length }; }, updateOpenAlert: () => null,
    config: {
      ph: { enabled: false, sensor_equipment_id: PH_EQ },
      nutrients: { irrigation_equipment_id: IRR_EQ, expected_flow_lph: FULL, pump_channel: 1, ratio: { 1: ratio, 2: ratio, 3: ratio, 4: ratio }, ...nutrients },
      stats,
    },
  });
  const noise = noiseGen(seed);
  const cmd = {};      // commanded dosing valve state (by channel)
  const phys = {};     // physical dosing valve state
  const pending = [];  // [atRel, ch, state]
  const log = [];      // valve commands [rel, tank, state]
  const tanks = [1, 2, 3, 4].map(id => ({ tank_id: id, tank_name: `Tank ${'ABCD'[id - 1]}`, equipment_id: DOSE_EQ, channel: id + 1, duty_pct: 100, valve_events: [] }));
  let rel = 0;
  ctl.beginCycle({
    cycleLogId: 1, programId: null, automationId: auto, durationSeconds: plan.duration, schedule: { tanks }, tanks, valveStates: {},
    write: async (target, state) => {
      if (state && disarmed) return false;
      cmd[target.channel] = state;
      log.push([rel, target.channel - 1, state]);
      pending.push([rel + latencyS, target.channel, state]);
      return true;
    },
    abort: async () => {},
  });

  const consumed = { 1: 40.13, 2: 51.02, 3: 60.2, 4: 70.07 }; // random phases inside the 0.25 L steps
  let resetBase = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const monRate = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const held = { 1: null, 2: null, 3: null, 4: null }; // { value, until }
  const zoneTrue = plan.zones.map(() => ({ water: 0, dose: { 1: 0, 2: 0, 3: 0, 4: 0 } }));
  const snaps = [];
  let flow = 0; let net = 76000;
  const rampStart = {};
  const dt = 0.1;
  const zoneOn = (k, r) => r >= plan.zones[k][0] && r < plan.zones[k][1];
  const pumpOn = (r) => plan.pumps.some(([a, b]) => r >= a && r < b);
  const lastState = {};
  const holdFor = () => holdS[0] + (holdS[1] - holdS[0]) * noise.u();
  const end = until ?? plan.duration + 15;
  let sekoLast = -Infinity;
  for (let i = 0; i * dt <= end + 1e-9; i++) {
    rel = Math.round(i * dt * 10) / 10;
    t = T0 + Math.round(rel * 1000);
    if (disarmedAt !== null && rel >= disarmedAt) disarmed = true;
    // relay events (read-back confirmed) — pump events land 0.3 s after the switch (write + FC01)
    for (let k = 0; k < 4; k++) {
      const on = zoneOn(k, rel);
      if (lastState[`z${k}`] !== on) {
        db.prepare('INSERT INTO relay_events (equipment_id, channel, state, source, automation_id, confirmed, readback_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(IRR_EQ, 3 + k, on ? 1 : 0, on ? 'automation' : 'automation_auto_off', auto, zoneConfirmed ? 1 : 0, zoneConfirmed ? (on ? 1 : 0) : null, dbTs(t));
        lastState[`z${k}`] = on;
      }
    }
    const p = pumpOn(rel);
    if (lastState.pump !== p) { lastState.pump = p; lastState.pumpEventAt = rel + 0.3; lastState.pumpEventState = p; if (p) rampStart.at = rel; }
    if (lastState.pumpEventAt !== undefined && rel >= lastState.pumpEventAt - 1e-9) {
      for (const ch of (skipFirstPumpEvent && lastState.pumpEventState && rampStart.at === plan.pumps[0][0] ? [] : [1, 2])) {
        db.prepare('INSERT INTO relay_events (equipment_id, channel, state, source, automation_id, confirmed, readback_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(IRR_EQ, ch, lastState.pumpEventState ? 1 : 0, lastState.pumpEventState ? 'automation' : 'automation_auto_off', auto,
            pumpConfirmed ? 1 : 0, pumpConfirmed ? (lastState.pumpEventState ? 1 : 0) : null, dbTs(t));
      }
      lastState.pumpEventAt = undefined;
    }
    // dosing valves: physical state follows the command after the write latency
    for (let j = pending.length - 1; j >= 0; j--) {
      if (pending[j][0] > rel + 1e-9) continue;
      if (!(stuckOpen && pending[j][1] === stuckOpen + 1 && phys[pending[j][1]])) phys[pending[j][1]] = pending[j][2]; // a stuck valve never closes
      pending.splice(j, 1);
    }
    // flow: ramp 0 -> FULL in 8 s at a pump start (needs an open zone valve that is not stuck), decay tau 1.5 s
    const zk = plan.zones.findIndex((_, k) => zoneOn(k, rel));
    const openZone = [0, 1, 2, 3].filter(k => zoneOn(k, rel) && !stuck.includes(k)).length > 0;
    if (p && openZone) flow = Math.min(FULL, Math.max(flow, FULL * Math.max(0, rel - rampStart.at) / 8)) + (rel - rampStart.at > 8 ? noise(8) : 0);
    else flow *= Math.exp(-dt / 1.5);
    flow = Math.max(0, Math.min(FULL * 1.03, flow));
    net += (flow / 3600) * dt;
    if (zk >= 0) zoneTrue[zk].water += (flow / 3600) * dt;
    // venturis: draw only with motive water; shared suction couples the tanks
    const motive = flow >= 0.2 * FULL ? Math.min(1.03, flow / FULL) : 0;
    const nOpen = [1, 2, 3, 4].filter(id => phys[id + 1]).length;
    for (const id of [1, 2, 3, 4]) {
      const r = phys[id + 1] ? draws[id] * motive * (1 + 0.05 * (4 - nOpen)) * (1 + noise(0.015)) : 0; // L/min
      consumed[id] += (r / 60) * dt;
      if (zk >= 0) zoneTrue[zk].dose[id] += (r / 60) * dt;
      // the monitor's rate: lagged (tau 1.5 s), held 20-50 s after the flow through the meter stops
      const target = r * 60 * rateBias;
      if (r > 0) { monRate[id] += (target - monRate[id]) * (1 - Math.exp(-dt / 1.5)); held[id] = null; } else if (monRate[id] > 0) {
        if (!held[id]) held[id] = { value: monRate[id], until: rel + holdFor() };
        if (rel >= held[id].until) { monRate[id] = 0; held[id] = null; }
      }
    }
    if (counterReset && Math.abs(rel - counterReset.at) < 1e-6) resetBase[counterReset.tank] = consumed[counterReset.tank];
    // monitor messages: flow every 0.5 s, dosing every 1 s (phase 0.3 s)
    if (i % 5 === 0) {
      ctl.ingest({ kind: 'flowmeter', farmId: '1021', receivedMs: t, live: true,
        values: { flow_lph: Math.round(flow * 10) / 10, net_total_m3: Math.floor(net * 10) / 10000, signal_quality: 95, error_flags: 0 } });
    }
    if (i % 10 === 3) {
      ctl.ingest({ kind: 'dosing', farmId: '1021', receivedMs: t, live: true,
        tanks: [1, 2, 3, 4].map(id => {
          let rate = Math.round(monRate[id] * (1 + noise(0.03)) * 10) / 10;
          if (rateMode === 'null' || (rateMode === 'null_after' && rel >= plan.zones[1][0])) rate = null;
          return { id, consumed_l: Math.floor((consumed[id] - resetBase[id]) * 4) / 4, rate_lph: rate };
        }) });
    }
    if (seko && rel - sekoLast >= 10 - 1e-9) {
      sekoLast = rel;
      const [ec, ph] = seko(rel, flow);
      db.prepare('UPDATE equipment SET last_reading = ?, last_communication = ? WHERE id = ?')
        .run(JSON.stringify({ values: { pH: { value: ph, unit: 'pH' }, 'Water EC': { value: ec, unit: 'µS/cm' } } }), iso(t), PH_EQ);
    }
    if (i % 10 === 0 && ctl.cycle) {
      ctl.step(t);
      if (snapshot) snaps.push(snapshot(ctl, rel, { phys: { ...phys }, cmd: { ...cmd }, monRate: { ...monRate }, flow }));
    }
    await ctl.flush();
  }
  const run = await ctl.endCycle({ status: 'completed' });
  ctl.stop();
  return { run, plan, zoneTrue, log, alerts, snaps, draws, ratio };
}

/** Per zone + tank: true litres vs the ratio target on the true zone water (fraction). */
function zoneErrors(r, { skipCantReach = true } = {}) {
  const out = [];
  r.zoneTrue.forEach((z, k) => {
    if (!(z.water > 50)) return;
    const rec = r.run.zones.find(x => x.channel === 3 + k);
    for (const id of [1, 2, 3, 4]) {
      const trec = rec && rec.tanks.find(x => x.tank_id === id);
      if (skipCantReach && trec && trec.cant_reach) continue;
      const target = z.water / r.ratio;
      out.push({ zone: k + 1, tank: id, err: (z.dose[id] - target) / target, dosed: z.dose[id], target, rec: trec });
    }
  });
  return out;
}
const worst = (errs) => Math.max(...errs.map(e => Math.abs(e.err)));
const fmt = (errs) => errs.map(e => `Z${e.zone}${'ABCD'[e.tank - 1]} ${(e.err * 100).toFixed(1)}%`).join(' ');
const LEGACY = { substep_estimate: false, open_at_pump_start: false };

// ─── precision ─────────────────────────────────────────────────────────────

test('07:30 replay (1:200, 3 min soft-switch zones, ~1.1 L/min): every zone within ±3 % of target (legacy: the 0.25 L counter swings it far wider)', async () => {
  const r = await runPlant({ D: 180 });
  const e = zoneErrors(r, { skipCantReach: false });
  assert.equal(e.length, 16);
  assert.ok(worst(e) <= 0.03, `worst ${(worst(e) * 100).toFixed(1)} %: ${fmt(e)}`);
  assert.ok(r.run.zones.every(z => z.tanks.every(tk => tk.closed_by === 'target' && !tk.cant_reach)), 'closed by target, reachable');
  const legacy = await runPlant({ D: 180, nutrients: LEGACY });
  const el = zoneErrors(legacy, { skipCantReach: false });
  assert.ok(worst(el) > 0.05, `legacy worst ${(worst(el) * 100).toFixed(1)} %: ${fmt(el)}`);
  assert.ok(worst(el) > 2 * worst(e));
  console.log(`# 07:30 shape: estimate worst ${(worst(e) * 100).toFixed(1)} % | legacy worst ${(worst(el) * 100).toFixed(1)} %`);
});

test('records: dosed_l is the counter (0.25 L steps, ground truth), dosed_est_l the estimate (within 0.06 L of the true litres); run totals carry both', async () => {
  const r = await runPlant({ D: 180 });
  for (const [k, z] of r.run.zones.entries()) {
    for (const tk of z.tanks) {
      assert.ok(Math.abs(tk.dosed_l * 4 - Math.round(tk.dosed_l * 4)) < 1e-9, `${z.name} ${tk.name} counter ${tk.dosed_l} is a 0.25 L multiple`);
      const truth = r.zoneTrue[k].dose[tk.tank_id];
      assert.ok(Math.abs(tk.dosed_l - truth) <= 0.25 + 1e-9, `counter ${tk.dosed_l} vs true ${truth.toFixed(3)}`);
      assert.ok(Math.abs(tk.dosed_est_l - truth) <= 0.06, `${z.name} ${tk.name}: estimate ${tk.dosed_est_l} vs true ${truth.toFixed(3)}`);
    }
  }
  for (const tk of r.run.tanks) {
    assert.ok(typeof tk.dosed_est_l === 'number' && typeof tk.dosed_l === 'number');
    assert.ok(Math.abs(tk.dosed_est_l - tk.dosed_l) <= 0.3, `${tk.name} run est ${tk.dosed_est_l} vs counter ${tk.dosed_l}`);
  }
  assert.deepEqual(r.run.modes.options, { substep_estimate: true, open_at_pump_start: true, flush_seconds: 40, first_pump_at: r.run.modes.options.first_pump_at });
  assert.ok(r.run.modes.options.first_pump_at, 'first pump start recorded');
});

const HI = { 1: 1.68, 2: 1.42, 3: 1.51, 4: 1.54 };
const ZONE_EXPECTED = { overdose_basis: 'zone_expected' };
const overdoseTrips = (r) => r.run.trips.filter(t => t.kind === 'overdose');

test('09:30-like high draw (1.42-1.68 L/min) and 12:30-like low draw (Tank D 0.85 L/min): within ±3 % or flagged can\'t-reach (high draw: overdose_basis zone_expected, see the overdose-cap tests for the default)', async () => {
  const hi = await runPlant({ D: 180, draws: HI, seed: 9, nutrients: ZONE_EXPECTED });
  const eh = zoneErrors(hi);
  assert.equal(eh.length, 16, 'nothing flagged at 1:200');
  assert.ok(worst(eh) <= 0.03, `high draw worst ${(worst(eh) * 100).toFixed(1)} %: ${fmt(eh)}`);
  const lo = await runPlant({ D: 180, draws: { 1: 1.07, 2: 1.10, 3: 1.10, 4: 0.85 }, seed: 12 });
  const el = zoneErrors(lo);
  assert.ok(worst(el) <= 0.03, `low draw worst ${(worst(el) * 100).toFixed(1)} %: ${fmt(el)}`);
  // 1:150 (~2.9 L per zone) is beyond a 0.85 L/min venturi in 3 min: flagged, never silently short
  const weak = await runPlant({ D: 180, ratio: 150, draws: { 1: 1.07, 2: 1.10, 3: 1.10, 4: 0.85 }, seed: 12 });
  const all = zoneErrors(weak, { skipCantReach: false });
  const short = all.filter(x => x.err < -0.03);
  assert.ok(short.length > 0 && short.every(x => x.tank === 4 && x.rec.cant_reach), `short and flagged: ${fmt(short)}`);
  assert.ok(zoneErrors(weak).every(x => Math.abs(x.err) <= 0.03), `reachable tanks within 3 %: ${fmt(zoneErrors(weak))}`);
  console.log(`# high draw worst ${(worst(eh) * 100).toFixed(1)} %, low draw worst ${(worst(el) * 100).toFixed(1)} %`);
});

test('2 min and 4.5 min zones: within ±3 % (4.5 min: overdose_basis zone_expected — the default cap false-trips late in zone 1, see below)', async () => {
  for (const [D, seed, nutrients] of [[120, 21, {}], [270, 22, ZONE_EXPECTED]]) {
    const r = await runPlant({ D, seed, nutrients });
    const e = zoneErrors(r, { skipCantReach: false });
    assert.ok(worst(e) <= 0.03, `${D} s zones worst ${(worst(e) * 100).toFixed(1)} %: ${fmt(e)}`);
  }
});

test('robustness: seeds, rate bias ±10 % (monitor rate vs counter), slower write latency — within ±3 %', async () => {
  const cases = [
    { seed: 31 }, { seed: 32 }, { seed: 33, rateBias: 1.1 }, { seed: 34, rateBias: 0.9 }, { seed: 35, latencyS: 1.2 },
    { seed: 36, draws: HI, rateBias: 1.1, nutrients: ZONE_EXPECTED }, // high draw: see the overdose-cap tests
  ];
  for (const cs of cases) {
    const r = await runPlant({ D: 180, ...cs });
    const e = zoneErrors(r, { skipCantReach: false });
    assert.ok(worst(e) <= 0.03, `${JSON.stringify(cs)} worst ${(worst(e) * 100).toFixed(1)} %: ${fmt(e)}`);
  }
});

test('rate absent (monitor rate null) -> the measured step rate (zone, then run) carries the estimate; still within ±3 %', async () => {
  const r = await runPlant({ D: 180, rateMode: 'null', seed: 41 });
  const e = zoneErrors(r, { skipCantReach: false });
  assert.ok(worst(e) <= 0.03, `rate null worst ${(worst(e) * 100).toFixed(1)} %: ${fmt(e)}`);
  const late = await runPlant({ D: 180, rateMode: 'null_after', seed: 42 });
  const el = zoneErrors(late, { skipCantReach: false });
  assert.ok(worst(el) <= 0.03, `rate lost from zone 2 worst ${(worst(el) * 100).toFixed(1)} %: ${fmt(el)}`);
});

test('estimator sources: rate while open + flowing, zone/run average when the rate is absent, nothing integrated while closed', async () => {
  const seen = new Set();
  await runPlant({ D: 120, rateMode: 'null_after', seed: 43, snapshot: (ctl) => { for (const t of ctl.cycle.tanks) seen.add(t.est.source); return null; } });
  for (const s of ['rate', 'closed']) assert.ok(seen.has(s), `saw ${[...seen]}`);
  assert.ok(seen.has('zone_avg') || seen.has('run_avg'), `fallback used: ${[...seen]}`);
  assert.ok(!seen.has('quantised'), 'a measured rate was always available after zone 1');
});

test('counter reset mid-zone: no phantom litres, zone still within ±3 %', async () => {
  const r = await runPlant({ D: 180, counterReset: { tank: 2, at: 60 }, seed: 51 });
  const e = zoneErrors(r, { skipCantReach: false });
  assert.ok(worst(e) <= 0.03, `worst ${(worst(e) * 100).toFixed(1)} %: ${fmt(e)}`);
  assert.equal(r.run.tanks.find(t => t.tank_id === 2).counter_resets, 1);
});

test('valve closed while the monitor still holds its rate (20-50 s): the estimate does not grow', async () => {
  const r = await runPlant({
    D: 180, seed: 61,
    snapshot: (ctl, rel, plant) => ({ rel, tanks: ctl.cycle.tanks.map(t => ({ id: t.tank_id, open: t.open, A: ctl._estAbs(t), V: t.V, rate: t.rateLph })), plant }),
  });
  let heldClosed = 0;
  for (let i = 1; i < r.snaps.length; i++) {
    for (const tk of r.snaps[i].tanks) {
      const prev = r.snaps[i - 1].tanks.find(x => x.id === tk.id);
      if (!tk.open && !prev.open && tk.V === prev.V) {
        assert.ok(tk.A <= prev.A + 1e-9, `tank ${tk.id} closed at ${r.snaps[i].rel} s: estimate grew ${prev.A} -> ${tk.A}`);
        if (tk.rate > 0) heldClosed++;
      }
    }
  }
  assert.ok(heldClosed > 30, `the held rate was present while closed (${heldClosed} samples)`);
});

// ─── overdose cap basis (operator decision 2026-09-28: keep 'delivered' for now) ─

test('overdose cap, default basis "delivered" (water so far): the 07:30 / 12:30 shapes never trip; high draw false-trips zone 1 (as runs 1 + 3) — the tank chatters against the cap, zone 1 can end short, the carry recovers it in zone 2; run totals within ±3 %', async () => {
  for (const [draws, seed] of [[{ 1: 1.10, 2: 1.12, 3: 1.08, 4: 1.05 }, 81], [{ 1: 1.07, 2: 1.10, 3: 1.10, 4: 0.85 }, 82]]) {
    const r = await runPlant({ D: 180, draws, seed });
    assert.deepEqual(overdoseTrips(r), [], 'no trip at ~1.1 L/min in 3 min zones');
    const e = zoneErrors(r, { skipCantReach: false });
    assert.ok(worst(e) <= 0.03, fmt(e));
  }
  const hi = await runPlant({ D: 180, draws: HI, seed: 9 });
  const trips = overdoseTrips(hi);
  assert.equal(trips.length, 4, `all four tanks trip once: ${trips.map(t => t.detail)}`);
  const p0 = hi.plan.pumps[0][0];
  for (const tr of trips) {
    const at = (Date.parse(tr.at) - Date.parse('2026-09-28T03:30:00Z')) / 1000 - p0;
    assert.ok(at >= 30 && at <= 90, `trip ${at} s after the zone 1 pump start (runs 1 + 3: ~66 s): ${tr.detail}`);
  }
  assert.deepEqual(hi.alerts.map(a => a.fingerprint).sort(), [1, 2, 3, 4].map(id => `dose_controller:overdose:${id}`), 'one (false) overdose warning per tank');
  // the cap only forces the valve shut while dosed > 1.3 x target + 0.5 L: after min_off_s it reopens and chatters
  const z1 = hi.plan.zones[0];
  for (const id of [1, 2, 3, 4]) {
    const ons = hi.log.filter(([rel, tank, st]) => tank === id && st && rel < z1[1]).length;
    assert.ok(ons >= 2, `tank ${id}: reopened after the forced close (${ons} opens in zone 1)`);
  }
  const e = zoneErrors(hi, { skipCantReach: false });
  const z34 = e.filter(x => x.zone >= 3);
  assert.ok(worst(z34) <= 0.03, `zones 3-4 back within ±3 %: ${fmt(z34)}`);
  assert.ok(worst(e) <= 0.08, `worst zone ${(worst(e) * 100).toFixed(1)} %: ${fmt(e)}`);
  const W = hi.zoneTrue.reduce((a, z) => a + z.water, 0);
  for (const id of [1, 2, 3, 4]) {
    const total = hi.zoneTrue.reduce((a, z) => a + z.dose[id], 0);
    assert.ok(Math.abs(total / (W / 200) - 1) <= 0.03, `tank ${id} run total ${(total / (W / 200) * 100 - 100).toFixed(1)} %`);
  }
  // shortfall carried: the zone that ended short hands its carry to zone 2
  const b = hi.run.zones.map(z => z.tanks.find(t => t.tank_id === 2));
  if (e.find(x => x.zone === 1 && x.tank === 2).err < -0.03) assert.ok(b[1].carry_in_l >= 0.1, `B carry into zone 2 ${b[1].carry_in_l}`);
  console.log(`# delivered basis, 09:30 shape: ${trips.length} false trips, worst zone ${(worst(e) * 100).toFixed(1)} %: ${fmt(e)}`);
});

test('overdose cap, basis "zone_expected" (opt-in): no false trip at high draw; a dosing valve stuck OPEN still trips it + the valve-not-closing alarm; the default basis trips it earlier', async () => {
  const hi = await runPlant({ D: 180, draws: HI, seed: 9, nutrients: ZONE_EXPECTED });
  assert.deepEqual(overdoseTrips(hi), [], 'zone 1 doses ahead of its water by design (runs 1 + 3: false trip ~66 s in)');
  assert.deepEqual(hi.alerts.map(a => a.fingerprint), []);
  const at = {};
  for (const [name, nutrients] of [['zone_expected', ZONE_EXPECTED], ['delivered', {}]]) {
    const stuck = await runPlant({ D: 180, stuckOpen: 1, seed: 71, nutrients });
    const fp = stuck.alerts.map(a => a.fingerprint);
    assert.ok(fp.includes('dose_controller:valve_leak:1'), `${name}: valve-not-closing alarm: ${fp}`);
    assert.ok(fp.includes('dose_controller:overdose:1'), `${name}: overdose cap: ${fp}`);
    assert.ok(fp.every(f => /:1$/.test(f)), `${name}: only the stuck tank: ${fp}`);
    const trip = overdoseTrips(stuck)[0];
    at[name] = (Date.parse(trip.at) - Date.parse('2026-09-28T03:30:00Z')) / 1000;
    assert.ok(at[name] < stuck.plan.zones[1][1], `${name}: cap tripped at +${at[name]} s, inside zone 2`);
  }
  assert.ok(at.delivered < at.zone_expected, `delivered trips first (${at.delivered} s vs ${at.zone_expected} s)`);
});

// ─── open at pump start ──────────────────────────────────────────────────────

test('soft switch: nutrient valves open at the confirmed pump start (before the flow registers), each zone', async () => {
  const r = await runPlant({ D: 180 });
  for (const [k, [a]] of r.plan.pumps.entries()) {
    const opens = r.log.filter(([rel, , s]) => s && rel >= a && rel < a + 10);
    assert.equal(new Set(opens.map(o => o[1])).size, 4, `zone ${k + 1}: all four tanks opened in the first 10 s: ${JSON.stringify(opens)}`);
    // flow reaches 50 % (min_flow_pct) at ~4 s after the pump start: the valves were open before it
    assert.ok(opens.every(o => o[0] <= a + 3), `zone ${k + 1} opened at ${opens.map(o => (o[0] - a).toFixed(1))} s after the pump start`);
  }
  assert.ok(r.run.zones.every(z => z.opened_at_pump_start === true));
  const legacy = await runPlant({ D: 180, nutrients: { open_at_pump_start: false } });
  for (const [k, [a]] of legacy.plan.pumps.entries()) {
    const first = legacy.log.find(([rel, , s]) => s && rel >= a);
    assert.ok(first[0] - a >= 4, `without it zone ${k + 1} opens once the flow registers (+${(first[0] - a).toFixed(1)} s)`);
  }
});

test('pump start: water does not come (stuck zone 2) -> the water gate closes all nutrient valves within no_water_s of the pump start; no alert storm; zone 3 unaffected', async () => {
  const r = await runPlant({ D: 180, stuck: [1] });
  const [a] = r.plan.pumps[1];
  const opens = r.log.filter(([rel, , s]) => s && rel >= a && rel < a + 3);
  assert.equal(opens.length, 4, 'opened at the confirmed pump start');
  const closes = r.log.filter(([rel, , s]) => !s && rel >= a && rel < a + 30);
  assert.equal(closes.length, 4);
  for (const c of closes) assert.ok(c[0] - a <= 5 + 1.5, `closed ${(c[0] - a).toFixed(1)} s after the pump start (no_water_s 5 + event/sample lag)`);
  assert.equal(r.log.filter(([rel, , s]) => s && rel >= a + 3 && rel < r.plan.pumps[1][1]).length, 0, 'never reopened without water');
  assert.ok(r.run.trips.some(tr => tr.kind === 'pump_start_no_water'), JSON.stringify(r.run.trips));
  assert.equal(r.run.trips.filter(tr => tr.kind === 'pump_start_no_water').length, 1);
  assert.deepEqual(r.alerts.map(x => x.fingerprint), [], 'the controller raises no alert (the flow watch owns no-water)');
  // no concentrate was drawn without water
  for (const id of [1, 2, 3, 4]) assert.ok(r.zoneTrue[1].dose[id] < 0.01, `zone 2 tank ${id} drew ${r.zoneTrue[1].dose[id]}`);
  // zone 3 afterwards: normal and on target
  const e3 = zoneErrors(r, { skipCantReach: false }).filter(x => x.zone === 3 || x.zone === 4);
  assert.ok(worst(e3) <= 0.03, fmt(e3));
});

test('pump start: not opened when the pump write is unconfirmed, the zone valve is unconfirmed, or automations are disarmed', async () => {
  for (const opts of [{ pumpConfirmed: false }, { zoneConfirmed: false }]) {
    const r = await runPlant({ D: 120, ...opts });
    for (const [k, [a]] of r.plan.pumps.entries()) {
      const first = r.log.find(([rel, , s]) => s && rel >= a);
      assert.ok(first && first[0] - a >= 4, `${JSON.stringify(opts)} zone ${k + 1}: opened +${first && (first[0] - a).toFixed(1)} s (only once the flow registered)`);
    }
    assert.ok(r.run.zones.every(z => !z.opened_at_pump_start));
  }
  const d = await runPlant({ D: 120, disarmedAt: 0 });
  assert.equal(d.log.filter(([, , s]) => s).length, 0, 'disarmed: no ON write at all');
});

test('continuous-pump run (no soft switch): unchanged — valves open once the flow registers, no pump-start opening', async () => {
  const r = await runPlant({ D: 180, softSwitch: false });
  const first = r.log.find(([, , s]) => s);
  assert.ok(first[0] >= 4, `first open +${first[0]} s`);
  assert.ok(r.run.zones.every(z => !z.opened_at_pump_start));
  const e = zoneErrors(r, { skipCantReach: false });
  assert.ok(worst(e) <= 0.03, `continuous worst ${(worst(e) * 100).toFixed(1)} %: ${fmt(e)}`);
});

// ─── flush exclusion ────────────────────────────────────────────────────────

test('flush: SEKO samples in the first 40 s after the FIRST pump start are kept out of zone 1\'s EC/pH (reported as flush_*); later zones count normally', async () => {
  // stale line / buffer / cup liquid: plain water EC 450 µS/cm, pH 7.2 for ~40 s, then the feed
  const firstPump = LEAD;
  const seko = (rel, flow) => (rel < firstPump + 38 ? [450, 7.2] : (flow < 1000 ? [700, 7.3] : [1850, 6.1]));
  const r = await runPlant({ D: 180, seko });
  const z1 = r.run.zone_visits[0];
  assert.equal(z1.ec_avg_us, 1850, `zone 1 EC ${z1.ec_avg_us}`);
  assert.equal(z1.ph_avg, 6.1);
  assert.equal(z1.ec_min_us, 1850, 'flush values are not in min/max either');
  assert.ok(z1.flush_samples >= 3 && z1.flush_samples <= 4, `flush samples ${z1.flush_samples}`);
  assert.equal(z1.flush_ec_avg_us, 450);
  assert.equal(z1.flush_ph_avg, 7.2);
  assert.equal(z1.flush_s, 40);
  for (const z of r.run.zone_visits.slice(1)) {
    assert.ok(!z.flush_samples, `${z.name}: no flush (only the run's first pump start)`);
    assert.equal(z.ec_avg_us, 1850);
    assert.ok(z.samples >= 14, `${z.name} samples ${z.samples}`);
  }
  assert.equal(r.run.zone_totals.ec_avg_us, 1850, 'totals use the zone averages');
  // switched off: the flush drags zone 1 down as before
  const off = await runPlant({ D: 180, seko, stats: { flush_seconds: 0 } });
  assert.ok(off.run.zone_visits[0].ec_avg_us < 1700, `without the exclusion zone 1 EC ${off.run.zone_visits[0].ec_avg_us}`);
  assert.ok(!off.run.zone_visits[0].flush_samples);
});

test('flush anchor: without a pump relay event for the first start, the anchor is when water was established — never a later zone\'s pump start', async () => {
  const seko = (rel, flow) => (rel < LEAD + 38 ? [450, 7.2] : (flow < 1000 ? [700, 7.3] : [1850, 6.1]));
  for (const opts of [{ nutrients: { pump_channel: 7 } }, { skipFirstPumpEvent: true }]) { // no pump events at all / zone 1's missing
    const r = await runPlant({ D: 120, seko, ...opts });
    assert.equal(r.run.modes.options.first_pump_at, null, JSON.stringify(opts));
    const v = r.run.zone_visits;
    assert.ok(v[0].flush_samples >= 3, `zone 1 flush ${v[0].flush_samples}`);
    assert.equal(v[0].ec_avg_us, 1850);
    assert.ok(v.slice(1).every(z => !z.flush_samples), `later zones never flagged: ${v.map(z => z.flush_samples)}`);
  }
});

// ─── config ─────────────────────────────────────────────────────────────────

test('config: new switches validated, defaults on, kill switches false, flush_seconds 0-600', () => {
  assert.equal(DEFAULT_CONFIG.nutrients.substep_estimate, true);
  assert.equal(DEFAULT_CONFIG.nutrients.open_at_pump_start, true);
  assert.equal(DEFAULT_CONFIG.stats.flush_seconds, 40);
  assert.equal(DEFAULT_CONFIG.nutrients.overdose_basis, 'delivered', 'operator decision 2026-09-28');
  assert.deepEqual(validateConfigUpdate({ nutrients: { overdose_basis: 'zone_expected' } }).value, { nutrients: { overdose_basis: 'zone_expected' } });
  assert.ok(validateConfigUpdate({ nutrients: { overdose_basis: 'expected' } }).error);
  assert.equal(mergeConfig(DEFAULT_CONFIG, { nutrients: { substep_estimate: false } }).nutrients.overdose_basis, 'delivered', 'independent of substep_estimate');
  assert.deepEqual(validateConfigUpdate({ nutrients: { substep_estimate: false, open_at_pump_start: false } }).value,
    { nutrients: { substep_estimate: false, open_at_pump_start: false } });
  assert.deepEqual(validateConfigUpdate({ stats: { flush_seconds: 0 } }).value, { stats: { flush_seconds: 0 } });
  assert.ok(validateConfigUpdate({ nutrients: { substep_estimate: 'yes' } }).error);
  assert.ok(validateConfigUpdate({ stats: { flush_seconds: -1 } }).error);
  assert.ok(validateConfigUpdate({ stats: { flush_seconds: 601 } }).error);
  assert.ok(validateConfigUpdate({ stats: { other: 1 } }).error);
  const merged = mergeConfig(DEFAULT_CONFIG, { stats: { flush_seconds: 60 }, nutrients: { open_at_pump_start: false } });
  assert.equal(merged.stats.flush_seconds, 60);
  assert.equal(merged.nutrients.open_at_pump_start, false);
  assert.equal(merged.nutrients.substep_estimate, true);
  // a stored config written before these keys existed gets the defaults
  const old = mergeConfig(DEFAULT_CONFIG, { nutrients: { ratio: { 1: 200 } } });
  assert.equal(old.stats.flush_seconds, 40);
  assert.equal(old.nutrients.substep_estimate, true);
});

test('config round-trip through saveConfig (GET/PUT /api/dose-controller/config path)', () => {
  const ctl = new DoseController({ db, logger: quiet, autoTick: false });
  const saved = ctl.saveConfig({ nutrients: { substep_estimate: false }, stats: { flush_seconds: 30 } });
  assert.equal(saved.nutrients.substep_estimate, false);
  assert.equal(saved.nutrients.open_at_pump_start, true);
  assert.equal(saved.stats.flush_seconds, 30);
  assert.equal(ctl.getConfig(true).stats.flush_seconds, 30);
  assert.throws(() => ctl.saveConfig({ stats: { flush_seconds: 'x' } }), /flush_seconds/);
  db.prepare("DELETE FROM system_settings WHERE key = 'dose_controller'").run();
});
