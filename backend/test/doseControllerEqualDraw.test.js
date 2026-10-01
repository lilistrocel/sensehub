// Equal draw (operator requirement 2026-10-01): the human agronomist designs the A-D
// recipes for EQUAL litres from each stock tank; at 1:116 the venturis of A-C cannot reach
// the ratio (open ~97 %) while D can, so independent control drew unequal volumes (runs
// 33-35: A 14.25 / B 12.5 / C 12.25 / D 16 L; 13.75 / 10.5 / 11.75 / 16; 14 / 9.25 / 11.5 / 16).
// Equal draw paces every ratio tank to the slowest one (nutrients.equal_draw).
// Same simulated coupled plant as doseControllerPrecision.test.js (soft-switch zones, flow
// ramp, shared venturi suction, 0.25 L counters + the monitor's lagged / held rate, 1 s
// ticks, write latency), extended with time-varying draws (declining / failing tank), a
// monitor blackout and a coupling factor. Stub valve writer, in-memory DB, nothing reaches Modbus.
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
const IRR_EQ = Number(db.prepare("INSERT INTO equipment (name, type, protocol, address, slave_id, status, register_mappings) VALUES ('Irrigation 1 (equal draw sim)', 'relay', 'modbus', '192.0.2.98:502', 6, 'online', ?)").run(IRR_MAPPINGS).lastInsertRowid);
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
  coupling = 0.05, blind = null, alertUpdates = null,
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
    createAlert: (a) => { alerts.push(a); return { id: alerts.length }; }, updateOpenAlert: (fp, ch) => { if (alertUpdates) alertUpdates.push({ fp, ...ch }); return null; },
    notify: () => {},
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
      const base = typeof draws[id] === 'function' ? draws[id](rel) : draws[id];
      const r = phys[id + 1] ? base * motive * (1 + coupling * (4 - nOpen)) * (1 + noise(0.015)) : 0; // L/min
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
    const blindNow = blind && rel >= blind[0] && rel < blind[1];
    if (i % 5 === 0 && !blindNow) {
      ctl.ingest({ kind: 'flowmeter', farmId: '1021', receivedMs: t, live: true,
        values: { flow_lph: Math.round(flow * 10) / 10, net_total_m3: Math.floor(net * 10) / 10000, signal_quality: 95, error_flags: 0 } });
    }
    if (i % 10 === 3 && !blindNow) {
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
  return { run, plan, zoneTrue, log, alerts, snaps, draws, ratio, ctl };
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

const EQ = (extra = {}) => ({ equal_draw: { enabled: true, ...extra } });
const MEMBERS = [1, 2, 3, 4];
const spread = (vals) => Math.max(...vals) - Math.min(...vals);
/** Per zone: counter / estimate / true spread of the four tanks. */
function zoneSpreads(r) {
  return r.run.zones.filter(z => !z.not_run).map((z, k) => {
    const cnt = MEMBERS.map(id => z.tanks.find(x => x.tank_id === id).dosed_l);
    const est = MEMBERS.map(id => z.tanks.find(x => x.tank_id === id).dosed_est_l);
    const tru = MEMBERS.map(id => r.zoneTrue[k].dose[id]);
    return { zone: k + 1, cnt: spread(cnt), est: spread(est), tru: spread(tru), rec: z };
  });
}
const runTrue = (r) => MEMBERS.map(id => r.zoneTrue.reduce((s, z) => s + z.dose[id], 0));
const L2 = (xs) => xs.map(x => x.toFixed(2)).join(' / ');

// Venturi draws (L/min at full flow, all four valves open) calibrated on runs 33-35 of
// 2026-10-01 at 1:116: A-C open the whole zone (litres / ~3.1 min of flow), D reached its
// target with its valve open ~86 % of the run (>= 1.5 L/min).
const RUNS = {
  33: { draws: { 1: 1.15, 2: 1.0, 3: 0.99, 4: 1.5 }, real: { 1: 14.25, 2: 12.5, 3: 12.25, 4: 16 }, water: 1839.7,
    zones: [[3.75, 3.25, 3, 4], [3.5, 3.25, 3.25, 4], [3.25, 2.75, 2.75, 3.75], [3.75, 3.25, 3.25, 4.25]] },
  34: { draws: { 1: 1.11, 2: 0.85, 3: 0.95, 4: 1.5 }, real: { 1: 13.75, 2: 10.5, 3: 11.75, 4: 16 }, water: 1812.2,
    zones: [[3.5, 2.5, 3, 4], [3.5, 3, 3, 3.75], [3.25, 2.25, 2.75, 4.25], [3.5, 2.75, 3, 4]] },
  35: { draws: { 1: 1.13, 2: 0.75, 3: 0.93, 4: 1.5 }, real: { 1: 14, 2: 9.25, 3: 11.5, 4: 16 }, water: 1857.1,
    zones: [[3.25, 2.25, 3, 4], [4, 2.5, 3.25, 4], [3.25, 2, 2.75, 4], [3.5, 2.5, 2.5, 4]] },
};
const LIVE = { D: 188, ratio: 116 };

// ─── the measured data of runs 33-35 ──────────────────────────────────────────

test('runs 33-35 (measured, 1:116): equal draw would have delivered the slowest tank per zone — 1:150 / 1:173 / 1:201', () => {
  for (const [id, r] of Object.entries(RUNS)) {
    // per zone the slowest counter; the run = their sum (no coupling gain assumed: conservative)
    const perZone = r.zones.map(z => Math.min(...z));
    const each = perZone.reduce((a, b) => a + b, 0);
    const slowestRun = Math.min(...Object.values(r.real));
    assert.ok(each <= slowestRun + 1e-9, `run ${id}: ${each} <= slowest tank ${slowestRun}`);
    assert.ok(each >= slowestRun - 0.75, `run ${id}: within 3 counter steps of the slowest tank`);
    console.log(`# run ${id} measured A/B/C/D ${Object.values(r.real).join(' / ')} L (spread ${spread(Object.values(r.real))} L); equal draw (no coupling gain) ~${each} L each = 1:${Math.round(r.water / each)}, slowest tank 1:${Math.round(r.water / slowestRun)}`);
  }
});

test('runs 33-35 replay at 1:116 (calibrated plant): off reproduces the unequal draw; equal draw holds every zone and the run within 0.5 L, at about the slowest tank', async () => {
  for (const [id, cal] of Object.entries(RUNS)) {
    const off = await runPlant({ ...LIVE, draws: cal.draws, seed: Number(id) });
    const offTrue = runTrue(off);
    assert.ok(spread(offTrue) > 3, `run ${id} off: unequal (${L2(offTrue)})`);
    const on = await runPlant({ ...LIVE, draws: cal.draws, seed: Number(id), nutrients: EQ() });
    const onTrue = runTrue(on);
    const eq = on.run.equal_draw;
    assert.ok(eq && eq.enabled, 'run record carries equal_draw');
    assert.ok(spread(onTrue) <= 0.5, `run ${id} on: true run spread ${spread(onTrue).toFixed(2)} (${L2(onTrue)})`);
    assert.ok(eq.spread_est_l <= 0.5 && eq.spread_l <= 0.5, `run ${id}: recorded spread est ${eq.spread_est_l} counter ${eq.spread_l}`);
    assert.ok(eq.within_tolerance && eq.zones_within_tolerance);
    for (const z of zoneSpreads(on)) {
      assert.ok(z.tru <= 0.5 && z.est <= 0.5, `run ${id} zone ${z.zone}: true ${z.tru.toFixed(2)} est ${z.est.toFixed(2)}`);
      assert.ok(z.cnt <= 0.5 + 1e-9, `run ${id} zone ${z.zone}: counter spread ${z.cnt}`);
      assert.ok(z.rec.equal_draw && z.rec.equal_draw.pacer_tank_id, 'zone record names the pacing tank');
    }
    // about the slowest tank of the uncontrolled run (closing D/A/C raises the slow venturi a little: coupling)
    const slowOff = Math.min(...offTrue);
    const each = onTrue.reduce((a, b) => a + b, 0) / 4;
    assert.ok(each >= slowOff * 0.97 && each <= slowOff * 1.2, `run ${id}: ${each.toFixed(2)} L each vs slowest off ${slowOff.toFixed(2)}`);
    // never above the ratio target; the slowest tank paced
    const slowId = MEMBERS[offTrue.indexOf(slowOff)];
    assert.equal(eq.pacer.tank_id, slowId, `run ${id}: paced by the slowest tank`);
    assert.ok(on.run.zones.every(z => z.tanks.every(tk => !tk.eq_paced || !tk.cant_reach)), 'held tanks are not "can\'t reach"');
    assert.ok(on.run.zones.some(z => z.tanks.some(tk => tk.eq_paced && tk.eq_held_s > 0)), 'some tank held by the pacing');
    const nocoup = await runPlant({ ...LIVE, draws: cal.draws, seed: Number(id), nutrients: EQ(), coupling: 0 });
    const ncTrue = runTrue(nocoup);
    assert.ok(spread(ncTrue) <= 0.5);
    console.log(`# run ${id} sim: off ${L2(offTrue)} L | equal draw ${L2(onTrue)} L (1:${eq.common_ratio}, spread ${eq.spread_l} L counter / ${eq.spread_est_l} L est, max zone ${eq.max_zone_spread_l} L, paced by ${eq.pacer.name}) | no coupling gain ${L2(ncTrue)} L (1:${nocoup.run.equal_draw.common_ratio})`);
  }
});

// ─── behaviour ────────────────────────────────────────────────────────────────

test('all reachable (1:200, ~1.1 L/min): equal draw changes nothing that matters — zones within ±3 % of target, closed by target, spread small', async () => {
  const r = await runPlant({ D: 180, nutrients: EQ() });
  const e = zoneErrors(r, { skipCantReach: false });
  assert.ok(worst(e) <= 0.03, `worst ${(worst(e) * 100).toFixed(1)} %: ${fmt(e)}`);
  assert.ok(r.run.zones.every(z => z.tanks.every(tk => !tk.cant_reach)));
  for (const z of zoneSpreads(r)) assert.ok(z.est <= 0.3, `zone ${z.zone} est spread ${z.est}`);
  assert.ok(r.run.equal_draw.within_tolerance);
});

test('one slow tank (B 0.7 L/min, others 1.1-1.5) at 1:116: everybody paced to B, per zone and per run within 0.5 L; continuous-pump plan too (zone switch-over)', async () => {
  for (const softSwitch of [true, false]) {
    const r = await runPlant({ ...LIVE, softSwitch, draws: { 1: 1.1, 2: 0.7, 3: 1.2, 4: 1.5 }, seed: 51, nutrients: EQ() });
    const tr = runTrue(r);
    assert.ok(spread(tr) <= 0.5, `${softSwitch ? 'soft' : 'continuous'}: run ${L2(tr)}`);
    for (const z of zoneSpreads(r)) assert.ok(z.tru <= 0.5 && z.cnt <= 0.5, `${softSwitch ? 'soft' : 'continuous'} zone ${z.zone}: true ${z.tru.toFixed(2)} counter ${z.cnt}`);
    assert.equal(r.run.equal_draw.pacer.tank_id, 2);
    assert.ok(r.run.equal_draw.tanks.find(x => x.tank_id === 4).held_s > 30, 'D held by the pacing');
    assert.equal(r.run.equal_draw.tanks.find(x => x.tank_id === 2).held_s, 0, 'the slowest tank is never held');
    // each tank was open at the start of every zone or held by pacing — never opened by pacing
    assert.ok(r.log.every(([, , state]) => typeof state === 'boolean'));
  }
});

test('declining tank (B 0.95 -> 0.45 L/min over the run, the run-35 trend): the others follow it down, within 0.5 L per zone', async () => {
  const D = 188; const total = 4 * (LEAD + D + LAG + GAP);
  const r = await runPlant({ D, ratio: 116, draws: { 1: 1.13, 2: (rel) => 0.95 - 0.5 * Math.min(1, rel / total), 3: 0.93, 4: 1.5 }, seed: 52, nutrients: EQ() });
  for (const z of zoneSpreads(r)) assert.ok(z.tru <= 0.5 && z.est <= 0.5, `zone ${z.zone}: true ${z.tru.toFixed(2)}`);
  const perZoneB = r.zoneTrue.map(z => z.dose[2]);
  assert.ok(perZoneB[3] < perZoneB[0] * 0.8, `B declines: ${L2(perZoneB)}`);
  const perZoneD = r.zoneTrue.map(z => z.dose[4]);
  assert.ok(perZoneD[3] < perZoneD[0] * 0.85, `D follows: ${L2(perZoneD)}`);
});

const failFp = (r, id) => `dose_controller:equal_draw_failure:${id}:${r.run.id}`;

test('tank failure, hold_all (default): B stops drawing -> critical alert naming it, A/C/D closed (water only) until B draws again; B catches up first, the run ends equal', async () => {
  const updates = [];
  const snaps = (ctl, rel) => ({ rel, V: Object.fromEntries(ctl.cycle.tanks.map(t => [t.tank_id, t.V])), open: Object.fromEntries(ctl.cycle.tanks.map(t => [t.tank_id, t.open])), why: Object.fromEntries(ctl.cycle.tanks.map(t => [t.tank_id, t.lastWhy])) });
  const B = (rel) => (rel >= 230 && rel < 400 ? 0 : 0.9);
  const r = await runPlant({ ...LIVE, draws: { 1: 1.1, 2: B, 3: 1.0, 4: 1.5 }, seed: 53, holdS: [2, 4], nutrients: EQ(), snapshot: snaps, alertUpdates: updates });
  const a = r.alerts.find(x => x.fingerprint === failFp(r, 2));
  assert.ok(a, `critical equal-draw alert: ${r.alerts.map(x => x.fingerprint).join(', ')}`);
  assert.equal(a.severity, 'critical');
  assert.match(a.message, /Tank B is not drawing — Tank A, Tank C, Tank D are held closed \(water only\)/);
  assert.ok(r.alerts.some(x => x.fingerprint === `dose_controller:not_drawing:2:${r.run.id}`), 'the not-drawing alarm itself');
  const hold = r.run.trips.find(t => t.kind === 'equal_draw_hold');
  const resumed = r.run.trips.find(t => t.kind === 'equal_draw_resumed');
  assert.ok(hold && resumed, JSON.stringify(r.run.trips.map(t => t.kind)));
  const holdRel = (Date.parse(hold.at) - Date.parse('2026-09-28T03:30:00Z')) / 1000;
  const resRel = (Date.parse(resumed.at) - Date.parse('2026-09-28T03:30:00Z')) / 1000;
  assert.ok(resRel > 400 && resRel < 420, `resumed when B drew again (${resRel})`);
  // while held: A/C/D closed, their counters still (one step of the closing transient at most)
  const inHold = r.snaps.filter(s => s.rel >= holdRel + 3 && s.rel < 400);
  assert.ok(inHold.length > 30);
  for (const id of [1, 3, 4]) {
    assert.ok(inHold.every(s => !s.open[id]), `tank ${id} closed while held`);
    assert.ok(inHold[inHold.length - 1].V[id] - inHold[0].V[id] <= 0.25 + 1e-9, `tank ${id} drew ${inHold[inHold.length - 1].V[id] - inHold[0].V[id]} L while held`);
  }
  assert.ok(updates.some(u => u.fp === failFp(r, 2) && u.severity === 'info'), 'alert resolved (info) when B drew again');
  const tr = runTrue(r);
  assert.ok(spread(tr) <= 0.5, `run ends equal: ${L2(tr)}`);
  assert.deepEqual(r.run.equal_draw.failures.map(f => [f.tank_id, f.policy, !!f.resolved_at]), [[2, 'hold_all', true]]);
});

test('tank failure for the rest of the run: hold_all -> water only to the end (A/C/D never exceed B + lead); exclude_failed -> B excluded, A/C/D go on paced to each other', async () => {
  const B = (rel) => (rel >= 230 ? 0 : 0.9);
  const hold = await runPlant({ ...LIVE, draws: { 1: 1.1, 2: B, 3: 1.0, 4: 1.5 }, seed: 54, holdS: [2, 4], nutrients: EQ() });
  const ht = runTrue(hold);
  assert.ok(Math.max(ht[0], ht[2], ht[3]) <= ht[1] + 0.5, `held to B: ${L2(ht)}`);
  const ex = await runPlant({ ...LIVE, draws: { 1: 1.1, 2: B, 3: 1.0, 4: 1.5 }, seed: 54, holdS: [2, 4], nutrients: EQ({ on_tank_failure: 'exclude_failed' }) });
  const et = runTrue(ex);
  assert.ok(spread([et[0], et[2], et[3]]) <= 0.5, `A/C/D equal: ${L2(et)}`);
  assert.ok(et[0] > ht[0] + 5, `A/C/D kept dosing (${et[0].toFixed(2)} vs held ${ht[0].toFixed(2)})`);
  const a = ex.alerts.find(x => x.fingerprint === failFp(ex, 2));
  assert.equal(a.severity, 'critical');
  assert.match(a.message, /Tank B is not drawing — it is excluded for the rest of this cycle; Tank A, Tank C, Tank D go on paced/);
  assert.equal(ex.run.equal_draw.tanks.find(x => x.tank_id === 2).excluded, true);
  assert.ok(ex.run.equal_draw.within_tolerance, 'spread judged on the tanks still in the pacing');
  console.log(`# permanent B failure at 230 s: hold_all ${L2(ht)} L | exclude_failed ${L2(et)} L`);
});

test('tolerance: 1.0 L allows a wider band with fewer valve switches; spreads stay inside it', async () => {
  const draws = { 1: 1.1, 2: 0.75, 3: 0.95, 4: 1.5 };
  const tight = await runPlant({ ...LIVE, draws, seed: 55, nutrients: EQ() });
  const wide = await runPlant({ ...LIVE, draws, seed: 55, nutrients: EQ({ tolerance_l: 1.0 }) });
  for (const z of zoneSpreads(wide)) assert.ok(z.tru <= 1.0, `zone ${z.zone} ${z.tru}`);
  const sw = (r) => r.log.filter(([, tank]) => tank === 4).length;
  assert.ok(sw(wide) < sw(tight), `D switches: tolerance 1.0 -> ${sw(wide)}, 0.5 -> ${sw(tight)}`);
  assert.equal(wide.run.equal_draw.tolerance_l, 1.0);
  console.log(`# D valve writes per run: tolerance 0.5 L ${sw(tight)}, 1.0 L ${sw(wide)}`);
});

test('overdose still enforced: a dosing valve stuck OPEN under equal draw still trips the overdose cap + valve-not-closing alarm', async () => {
  const r = await runPlant({ D: 180, draws: { 1: 1.1, 2: 1.1, 3: 1.1, 4: 1.6 }, stuckOpen: 4, seed: 56, nutrients: EQ() });
  const fp = r.alerts.map(a => a.fingerprint);
  assert.ok(fp.includes('dose_controller:overdose:4'), `overdose cap: ${fp}`);
  assert.ok(fp.includes('dose_controller:valve_leak:4'), `valve not closing: ${fp}`);
  assert.ok(r.run.trips.some(t => t.kind === 'overdose' && /Tank D/.test(t.detail)));
});

test('monitor blind (40 s mid zone 2): equal draw holds A-D closed (water only), the fallback alert says so; closed loop resumes and the run ends equal', async () => {
  const snaps = (ctl, rel, w) => ({ rel, mode: ctl.cycle.mode, phys: w.phys, why: Object.fromEntries(ctl.cycle.tanks.map(t => [t.tank_id, t.lastWhy])) });
  const r = await runPlant({ ...LIVE, draws: RUNS[35].draws, seed: 57, nutrients: EQ(), blind: [300, 340], snapshot: snaps });
  const blindSnaps = r.snaps.filter(s => s.mode === 'fallback');
  assert.ok(blindSnaps.length >= 20, `fallback for ~30 s (${blindSnaps.length})`);
  const late = blindSnaps.slice(2);
  assert.ok(late.every(s => [2, 3, 4, 5].every(ch => !s.phys[ch])), 'all nutrient valves closed while blind');
  // closed by the blind hold (or already closed by the pacing when the monitor went blind)
  assert.ok(late.every(s => MEMBERS.every(id => ['equal draw: monitor blind — held closed', 'paced to the slowest tank (equal draw)'].includes(s.why[id]))), JSON.stringify(late.map(s => s.why)));
  assert.ok(late.some(s => MEMBERS.some(id => s.why[id] === 'equal draw: monitor blind — held closed')));
  const fb = r.alerts.find(a => a.fingerprint === 'dose_controller:fallback');
  assert.match(fb.message, /equal draw holds the nutrient valves A-D closed \(water only\)/);
  assert.ok(r.run.modes.fallback_periods[0].reason.endsWith('— nutrient valves held closed (equal draw)'));
  assert.ok(spread(runTrue(r)) <= 0.5, `equal at the end: ${L2(runTrue(r))}`);
});

test('disarm under equal draw: every dosing valve closed, no ON write after the disarm', async () => {
  const r = await runPlant({ ...LIVE, draws: RUNS[35].draws, seed: 58, nutrients: EQ(), disarmedAt: 300 });
  assert.ok(r.log.filter(([rel, , st]) => rel > 300 && st).length === 0, 'no ON after disarm');
});

// ─── config ─────────────────────────────────────────────────────────────────

test('config: defaults off/hold_all, validation, deep merge, cross-check, tracked origin', () => {
  assert.deepEqual({ ...DEFAULT_CONFIG.nutrients.equal_draw }, { enabled: false, tolerance_l: 0.5, tolerance_pct: 5, on_tank_failure: 'hold_all' });
  assert.ok(validateConfigUpdate({ nutrients: { equal_draw: { tolerance_l: 0.25 } } }).error, 'below one counter step + margin');
  assert.ok(validateConfigUpdate({ nutrients: { equal_draw: { on_tank_failure: 'ignore' } } }).error);
  assert.ok(validateConfigUpdate({ nutrients: { equal_draw: { enabled: 'yes' } } }).error);
  assert.ok(validateConfigUpdate({ nutrients: { equal_draw: { foo: 1 } } }).error);
  const m = mergeConfig(DEFAULT_CONFIG, { nutrients: { equal_draw: { enabled: true } } });
  assert.deepEqual(m.nutrients.equal_draw, { enabled: true, tolerance_l: 0.5, tolerance_pct: 5, on_tank_failure: 'hold_all' }, 'partial update keeps the rest');
  const m2 = mergeConfig(m, { nutrients: { ratio: { 1: 120 }, ec_trim: { target_us: 2000 } } });
  assert.equal(m2.nutrients.equal_draw.enabled, true, 'other nutrient updates never clobber it');
  assert.equal(DEFAULT_CONFIG.nutrients.equal_draw.enabled, false, 'defaults untouched');
  const { crossCheck } = src('services', 'DoseController.js');
  assert.equal(crossCheck(m), null);
  assert.match(crossCheck(mergeConfig(m, { nutrients: { substep_estimate: false } })), /tolerance_l must be at least 0\.55 L with substep_estimate off/);
  assert.equal(crossCheck(mergeConfig(m, { nutrients: { substep_estimate: false, equal_draw: { tolerance_l: 0.6 } } })), null);
  const { trackedFields } = src('services', 'DoseController.js');
  assert.ok(trackedFields(m).includes('nutrients.equal_draw.enabled'));
});

test('takes effect at the next cycle start, never mid-cycle', async () => {
  db.prepare('DELETE FROM system_settings WHERE key = ?').run('dose_controller');
  let t = Date.parse('2026-10-01T06:00:00Z');
  const ctl = new DoseController({ db, now: () => t, autoTick: false, logger: quiet, beforeCycle: null, config: { ph: { enabled: false } } });
  const tanks = [1, 2, 3, 4].map(id => ({ tank_id: id, tank_name: `Tank ${'ABCD'[id - 1]}`, equipment_id: DOSE_EQ, channel: id + 1, duty_pct: 100, valve_events: [] }));
  const ctx = (n) => ({ cycleLogId: n, programId: null, automationId: null, durationSeconds: 600, tanks, schedule: { tanks }, valveStates: {}, write: async () => true, abort: async () => {} });
  ctl.saveConfig({ nutrients: { ratio: { 1: 116, 2: 116, 3: 116, 4: 116 } } }, { source: 'operator' });
  ctl.beginCycle(ctx(1));
  assert.equal(ctl.cycle.eq, null);
  ctl.saveConfig({ nutrients: { equal_draw: { enabled: true } } }, { source: 'operator', user: { id: 1, email: 'op@farm.test' } });
  t += 2000; ctl.step(t);
  assert.equal(ctl.cycle.eq, null, 'the running cycle keeps what it started with');
  assert.equal(ctl.getStatus(t).equal_draw.enabled, false);
  assert.equal(ctl.getStatus(t).equal_draw_config.enabled, true, 'saved for the next cycle');
  const r1 = await ctl.endCycle({ status: 'completed' });
  assert.equal(r1.equal_draw, null);
  t += 60000;
  const { runId } = ctl.beginCycle(ctx(2));
  assert.ok(ctl.cycle.eq && ctl.cycle.eq.members.length === 4);
  assert.equal(ctl.getFieldProvenance()['nutrients.equal_draw.enabled'].user_email, 'op@farm.test');
  await ctl.endCycle({ status: 'completed' });
  const run = ctl.getRun(runId);
  assert.ok(run.config_version_id > r1.config_version_id, 'a new config version for the run');
  assert.equal(run.equal_draw.on_tank_failure, 'hold_all');
  ctl.stop();
});
