// Soft-switch zone sequencing (operator approval 2026-09-26, "Part D"): per zone
// valve ON -> +3 s pumps ON for D s -> pumps OFF -> +5 s valve OFF -> +1 s next
// valve. The DoseController must key each zone's litre targets on the zone's
// planned FLOW window (the pump action), close the nutrient valves when the
// water stops at each planned pump-off without false trips/alerts, and gate the
// acid per pumping segment (45 s after each pump start, 30 s before each
// planned pump-off). Simulated monitor/venturi/pH plant; the valve writer is a
// stub — nothing reaches Modbus.
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const src = (...p) => require(path.join(__dirname, '..', 'src', ...p));
const { db } = src('utils', 'database.js');
const { DoseController } = src('services', 'DoseController.js');

const quiet = { log() {}, warn() {}, error() {} };
const dbTs = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const iso = (ms) => new Date(ms).toISOString();

const IRR_MAPPINGS = JSON.stringify([
  { name: 'Irrigation Pump', register: '1', type: 'coil' }, { name: 'Mixing Pump', register: '2', type: 'coil' },
  { name: 'Irrigation Zone 1', register: '3', type: 'coil' }, { name: 'Irrigation Zone 2', register: '4', type: 'coil' },
  { name: 'Irrigation Zone 3', register: '5', type: 'coil' }, { name: 'Irrigation Zone 4', register: '6', type: 'coil' },
]);
const IRR_EQ = Number(db.prepare("INSERT INTO equipment (name, type, protocol, address, slave_id, status, register_mappings) VALUES ('Irrigation 1 (soft sim)', 'relay', 'modbus', '192.0.2.99:502', 6, 'online', ?)").run(IRR_MAPPINGS).lastInsertRowid);
const DOSE_EQ = Number(db.prepare("INSERT INTO equipment (name, type, protocol, address, slave_id, status) VALUES ('Irrigation 2 (soft sim)', 'relay', 'modbus', '192.0.2.99:502', 2, 'online')").run().lastInsertRowid);
const PH_EQ = Number(db.prepare("INSERT INTO equipment (name, type, protocol, address, slave_id, status) VALUES ('SEKO (soft sim)', 'sensor', 'modbus', '192.0.2.99:502', 3, 'online')").run().lastInsertRowid);
// tanks 1-4 nutrients on ch 2-5, tank 5 pH Down on ch 1 of the dosing board
for (let id = 1; id <= 5; id++) {
  const ch = id === 5 ? 1 : id + 1;
  const role = id === 5 ? 'ph_down' : 'nutrient';
  const name = id === 5 ? 'Tank 5 — pH Down' : `Tank ${'ABCD'[id - 1]}`;
  if (db.prepare('SELECT id FROM fertigation_tanks WHERE id = ?').get(id)) {
    db.prepare('UPDATE fertigation_tanks SET name = ?, equipment_id = ?, channel = ?, role = ?, active = 1 WHERE id = ?').run(name, DOSE_EQ, ch, role, id);
  } else {
    db.prepare('INSERT INTO fertigation_tanks (id, name, equipment_id, channel, role) VALUES (?, ?, ?, ?, ?)').run(id, name, DOSE_EQ, ch, role);
  }
}

const LEAD = 3; const LAG = 5; const GAP = 1;

/** Automation 97 soft-switch structure: 4 zones x D s. */
function softSwitchActions(D) {
  const actions = [];
  const starts = [];
  for (let k = 0; k < 4; k++) {
    const t0 = k * (LEAD + D + LAG + GAP);
    starts.push(t0);
    actions.push({ type: 'control', action: 'on', equipment_id: IRR_EQ, channel: 3 + k, delay_seconds: t0, duration_seconds: D + LEAD + LAG });
    actions.push({ type: 'control', action: 'on', equipment_id: IRR_EQ, channel: 1, delay_seconds: t0 + LEAD, duration_seconds: D });
    actions.push({ type: 'control', action: 'on', equipment_id: IRR_EQ, channel: 2, delay_seconds: t0 + LEAD, duration_seconds: D });
  }
  return { actions, starts, duration: Math.max(...actions.map(a => a.delay_seconds + a.duration_seconds)) };
}

function noiseGen(seed = 11) {
  let s = seed >>> 0;
  const u = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
  return (sd) => sd * Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

/**
 * Plant: flow ramps 0 -> 8,800 L/h in 8 s at each pump start and decays
 * (tau 1.5 s) at pump-off; each open venturi draws ~1.1 L/min while the water
 * moves (>= 20 % of 8,800); 0.25 L consumed counters; pH first-order buffer
 * (tau 15 s) + 10 s dead time to the SEKO cup, sampled every 10 s.
 */
async function runSoftSwitch({ D = 270, pumpChannel = 1, ratio = 150 } = {}) {
  db.prepare('DELETE FROM dose_controller_runs').run();
  const plan = softSwitchActions(D);
  const auto = Number(db.prepare("INSERT INTO automations (name, trigger_config, actions, enabled) VALUES ('Fertigation 11:30 soft switch (sim)', '{}', ?, 0)")
    .run(JSON.stringify(plan.actions)).lastInsertRowid);
  const T0 = Date.parse('2026-09-27T07:30:00Z');
  let t = T0;
  const alerts = [];
  const ctl = new DoseController({
    db, now: () => t, autoTick: false, logger: quiet, arming: { isDisarmed: () => false },
    createAlert: (a) => { alerts.push(a); return { id: alerts.length }; }, updateOpenAlert: () => null,
    config: {
      ph: { sensor_equipment_id: PH_EQ, max_acid_s_per_cycle: 900, max_acid_s_per_day: 3000 },
      nutrients: { irrigation_equipment_id: IRR_EQ, expected_flow_lph: 8800, pump_channel: pumpChannel, ratio: { 1: ratio, 2: ratio, 3: ratio, 4: ratio } },
    },
  });
  const noise = noiseGen(5);
  const valve = {};
  const acidPulses = [];
  const tanks = [1, 2, 3, 4].map(id => ({ tank_id: id, tank_name: `Tank ${'ABCD'[id - 1]}`, equipment_id: DOSE_EQ, channel: id + 1, duty_pct: 100, valve_events: [] }));
  ctl.beginCycle({
    cycleLogId: 1, programId: null, automationId: auto, durationSeconds: plan.duration, schedule: { tanks }, tanks, valveStates: {},
    write: async (target, state) => {
      const rel = (t - T0) / 1000;
      if (target.channel === 1) {
        if (state && !valve[1]) acidPulses.push({ on: rel, off: null });
        if (!state && valve[1]) acidPulses[acidPulses.length - 1].off = rel;
      }
      valve[target.channel] = state;
      return true;
    },
    abort: async () => {},
  });
  const pumpWin = plan.starts.map(t0 => [t0 + LEAD, t0 + LEAD + D]);
  const valveWin = plan.starts.map(t0 => [t0, t0 + LEAD + D + LAG]);
  const consumed = { 1: 50, 2: 60, 3: 70, 4: 80 };
  const trueDose = { 1: 0, 2: 0, 3: 0, 4: 0 };
  let flow = 0; let net = 76000; let phX = 6.1; const phHist = [];
  const zoneTrue = valveWin.map(() => ({ water: 0, dose: { 1: 0, 2: 0, 3: 0, 4: 0 } }));
  let lastZoneState = {};
  const dt = 0.25;
  for (let step = 0; step * dt <= plan.duration + 10; step++) {
    const rel = step * dt;
    t = T0 + Math.round(rel * 1000);
    // zone relay events (valve windows)
    valveWin.forEach(([a, b], k) => {
      const on = rel >= a && rel < b;
      if (lastZoneState[k] !== on) {
        db.prepare('INSERT INTO relay_events (equipment_id, channel, state, source, automation_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(IRR_EQ, 3 + k, on ? 1 : 0, on ? 'automation' : 'automation_auto_off', auto, dbTs(t));
        lastZoneState[k] = on;
      }
    });
    const pumping = pumpWin.find(([a, b]) => rel >= a && rel < b);
    if (pumping) flow = Math.min(8800, 8800 * Math.max(0, rel - pumping[0]) / 8) + (rel - pumping[0] > 8 ? noise(60) : 0);
    else flow *= Math.exp(-dt / 1.5);
    flow = Math.max(0, flow);
    net += (flow / 3600) * dt;
    const zk = valveWin.findIndex(([a, b]) => rel >= a && rel < b);
    if (zk >= 0) zoneTrue[zk].water += (flow / 3600) * dt;
    const motive = flow >= 0.2 * 8800 ? Math.min(1.05, flow / 8800) : 0;
    const rates = {};
    for (const id of [1, 2, 3, 4]) {
      const r = valve[id + 1] ? 1.1 * motive * (1 + noise(0.03)) : 0; // L/min
      rates[id] = r;
      consumed[id] += (r / 60) * dt;
      trueDose[id] += (r / 60) * dt;
      if (zk >= 0) zoneTrue[zk].dose[id] += (r / 60) * dt;
    }
    if (flow > 1000) phX += ((6.1 - (valve[1] ? 1.5 : 0) - phX) * dt) / 15;
    phHist.push([rel, phX]);
    if (step % 2 === 0) ctl.ingest({ kind: 'flowmeter', farmId: '1021', receivedMs: t, live: true, values: { flow_lph: Math.round(flow * 10) / 10, net_total_m3: Math.floor(net * 10) / 10000, signal_quality: 95, error_flags: 0 } });
    if (step % 4 === 0) {
      ctl.ingest({ kind: 'dosing', farmId: '1021', receivedMs: t, live: true,
        tanks: [...[1, 2, 3, 4].map(id => ({ id, consumed_l: Math.floor(consumed[id] * 4) / 4, rate_lph: Math.round(rates[id] * 600) / 10 })), { id: 5, consumed_l: 0, rate_lph: null }] });
    }
    if (step % 40 === 0) {
      let cup = phHist[0][1];
      for (const [r, x] of phHist) { if (r <= rel - 10) cup = x; else break; }
      db.prepare('UPDATE equipment SET last_reading = ?, last_communication = ? WHERE id = ?')
        .run(JSON.stringify({ values: { pH: { value: Math.round(cup * 100) / 100, unit: 'pH' }, 'Water EC': { value: 2100, unit: 'µS/cm' } } }), iso(t), PH_EQ);
    }
    if (ctl.cycle) ctl.step(t);
    await ctl.flush();
  }
  const run = await ctl.endCycle({ status: 'completed' });
  ctl.stop();
  return { run, plan, pumpWin, valveWin, acidPulses, alerts, zoneTrue, trueDose };
}

test('soft switch (automation 97: 4 x 4.5 min, lead 3 / lag 5 / gap 1): one segment per zone, each zone within ±3 % of its target, dose cycle covers all four zones', async () => {
  const r = await runSoftSwitch({ D: 270 });
  const zones = r.run.zones;
  assert.deepEqual(zones.map(z => z.channel), [3, 4, 5, 6], 'one record per zone, in order');
  assert.deepEqual(r.run.zone_visits.map(z => z.status), ['ok', 'ok', 'ok', 'ok']);
  for (const [k, z] of zones.entries()) {
    const expected = 8800 / 3600 * (270 - 4); // ramp costs ~4 s of full flow
    assert.ok(z.water_l > expected * 0.97 && z.water_l < expected * 1.03, `zone ${k + 1} water ${z.water_l} vs ~${Math.round(expected)}`);
    // true litres (sim) vs the zone's ratio target on the true water
    const water = r.zoneTrue[k].water;
    for (const id of [1, 2, 3, 4]) {
      const dosed = r.zoneTrue[k].dose[id];
      const target = water / 150;
      assert.ok(Math.abs(dosed - target) / target <= 0.03, `zone ${k + 1} tank ${id}: ${dosed.toFixed(2)} L vs target ${target.toFixed(2)} L (${(((dosed - target) / target) * 100).toFixed(1)} %)`);
    }
  }
  // run totals
  const W = r.zoneTrue.reduce((s, z) => s + z.water, 0);
  for (const id of [1, 2, 3, 4]) assert.ok(Math.abs(r.trueDose[id] - W / 150) / (W / 150) <= 0.02, `run tank ${id} ${r.trueDose[id].toFixed(2)} vs ${(W / 150).toFixed(2)}`);
});

test('soft switch: the planned pump-offs are not water faults — no trips, no alerts, nutrients closed by target before each pump-off', async () => {
  const r = await runSoftSwitch({ D: 270 });
  const bad = (r.run.trips || []).filter(tr => !['acid_cap_cycle', 'acid_cap_day'].includes(tr.kind));
  assert.deepEqual(bad.map(tr => `${tr.kind}: ${tr.detail}`), []);
  assert.deepEqual(r.alerts.map(a => a.message), []);
  for (const z of r.run.zones) {
    for (const tk of z.tanks) assert.equal(tk.closed_by, 'target', `${z.name} ${tk.name} closed by ${tk.closed_by}`);
  }
});

test('soft switch: acid gated per pumping segment — none in the first 45 s after each pump start or the last 30 s before each planned pump-off; pulses in every zone', async () => {
  const r = await runSoftSwitch({ D: 270 });
  assert.ok(r.acidPulses.length > 0, 'the pH controller doses acid');
  for (const p of r.acidPulses) {
    const seg = r.pumpWin.find(([a, b]) => p.on >= a - 1 && p.on < b + 6);
    assert.ok(seg, `acid pulse at ${p.on} s outside any pumping segment`);
    assert.ok(p.on >= seg[0] + 45, `acid opened ${(p.on - seg[0]).toFixed(1)} s after the pump start at ${seg[0]} s`);
    assert.ok(p.off !== null && p.off <= seg[1] - 30 + 0.5, `acid still open at ${p.off} s, planned pump-off ${seg[1]} s`);
  }
  for (const [a, b] of r.pumpWin) assert.ok(r.acidPulses.some(p => p.on >= a && p.on < b), `no acid in the pumping segment ${a}-${b} s`);
});

test('soft switch without the pump window (plan bounded by the valve only): acid runs into the planned pump-offs and targets drift high — the pump window is what fixes both', async () => {
  const withPump = await runSoftSwitch({ D: 270 });
  const withoutPump = await runSoftSwitch({ D: 270, pumpChannel: 9 });
  const late = (r) => r.acidPulses.filter(p => {
    const seg = r.pumpWin.find(([a, b]) => p.on >= a - 1 && p.on < b + 6);
    return !seg || p.off === null || p.off > seg[1] - 30 + 0.5;
  }).length;
  const over = (r) => {
    let worst = -Infinity;
    for (const z of r.zoneTrue) for (const id of [1, 2, 3, 4]) worst = Math.max(worst, (z.dose[id] - z.water / 150) / (z.water / 150));
    return worst;
  };
  assert.equal(late(withPump), 0);
  assert.ok(late(withoutPump) > 0, 'without the pump window some acid pulses end inside the last 30 s before a pump-off');
  assert.ok(over(withoutPump) > over(withPump), `overshoot without pump window ${(over(withoutPump) * 100).toFixed(1)} % vs with ${(over(withPump) * 100).toFixed(1)} %`);
});
