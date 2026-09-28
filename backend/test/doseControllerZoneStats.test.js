// Per-zone feed EC/pH, status and ratio in dose_controller_runs (operator
// request 2026-09-26: "last cycle per-zone stats on the dashboard").
// Pure helpers (services/DoseRunZoneStats.js) + the DoseController driven by a
// small simulated monitor/SEKO stream. No Modbus: the valve writer is a stub.
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const src = (...p) => require(path.join(__dirname, '..', 'src', ...p));
const { db } = src('utils', 'database.js');
const zs = src('services', 'DoseRunZoneStats.js');
const { DoseController } = src('services', 'DoseController.js');

const quiet = { log() {}, warn() {}, error() {} };
const dbTs = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const iso = (ms) => new Date(ms).toISOString();

const IRR_MAPPINGS = JSON.stringify([
  { name: 'Irrigation Pump', register: '1', type: 'coil' }, { name: 'Mixing Pump', register: '2', type: 'coil' },
  { name: 'Irrigation Zone 1', register: '3', type: 'coil' }, { name: 'Irrigation Zone 2', register: '4', type: 'coil' },
  { name: 'Irrigation Zone 3', register: '5', type: 'coil' }, { name: 'Irrigation Zone 4', register: '6', type: 'coil' },
]);
const IRR_EQ = Number(db.prepare("INSERT INTO equipment (name, type, protocol, address, slave_id, status, register_mappings) VALUES ('Irrigation 1 (zs sim)', 'relay', 'modbus', '192.0.2.88:502', 6, 'online', ?)").run(IRR_MAPPINGS).lastInsertRowid);
const DOSE_EQ = Number(db.prepare("INSERT INTO equipment (name, type, protocol, address, slave_id, status) VALUES ('Irrigation 2 (zs sim)', 'relay', 'modbus', '192.0.2.88:502', 2, 'online')").run().lastInsertRowid);
const PH_EQ = Number(db.prepare("INSERT INTO equipment (name, type, protocol, address, slave_id, status) VALUES ('SEKO (zs sim)', 'sensor', 'modbus', '192.0.2.88:502', 3, 'online')").run().lastInsertRowid);
const MON_EQ = Number(db.prepare("INSERT INTO equipment (name, type, protocol, address, status) VALUES ('Irrigation Monitor (zs sim)', 'sensor', 'mqtt', 'farm/1021', 'online')").run().lastInsertRowid);

// ─── pure helpers ───────────────────────────────────────────────────────────

test('addSample: skips samples while flow < 50 % of expected or unknown; averages the rest; no sample = null (not 0)', () => {
  const acc = zs.newAcc();
  assert.equal(zs.addSample(acc, { ph: 6.0, ec: 2300, flowLph: 8800, expectedLph: 8820 }), true);
  assert.equal(zs.addSample(acc, { ph: 6.2, ec: 2100, flowLph: 4500, expectedLph: 8820 }), true);   // 51 %
  assert.equal(zs.addSample(acc, { ph: 7.5, ec: 400, flowLph: 4300, expectedLph: 8820 }), false);   // 49 %: stagnant cup
  assert.equal(zs.addSample(acc, { ph: 7.5, ec: 400, flowLph: null, expectedLph: 8820 }), false);   // meter blind
  assert.equal(zs.addSample(acc, { ph: 12, ec: null, flowLph: 8800, expectedLph: 8820 }), false);   // implausible pH, no EC
  const f = zs.accFields(acc);
  assert.deepEqual(
    { ec_avg_us: f.ec_avg_us, ec_min_us: f.ec_min_us, ec_max_us: f.ec_max_us, ec_samples: f.ec_samples, ph_avg: f.ph_avg, ph_min: f.ph_min, ph_max: f.ph_max, samples: f.samples, skipped: f.skipped_samples },
    { ec_avg_us: 2200, ec_min_us: 2100, ec_max_us: 2300, ec_samples: 2, ph_avg: 6.1, ph_min: 6.0, ph_max: 6.2, samples: 2, skipped: 3 },
  );
  const empty = zs.accFields(zs.newAcc());
  assert.equal(empty.ec_avg_us, null);
  assert.equal(empty.ph_avg, null);
  assert.equal(empty.samples, 0);
});

const T0 = Date.parse('2026-09-26T11:30:13Z');
const rec = (i, { ch, startS, endS, water, planned = 150, dosed = [1.75, 1.75, 1.75, 1.75], ...rest }) => ({
  zone: i, channel: ch, name: `Irrigation Zone ${ch - 2}`, slot: 0,
  started_at: iso(T0 + startS * 1000), ended_at: iso(T0 + endS * 1000), planned_s: planned, water_l: water,
  tanks: dosed.map((d, k) => ({ tank_id: k + 1, name: `Tank ${'ABCD'[k]}`, target_l: d, dosed_l: d })),
  ...rest,
});

test('zone status: ok / no_water (< 40 % of expected water over its open time) / cut_short / shutdown; ratio = water / mean A-D', () => {
  const zones = zs.decorateZones([
    rec(1, { ch: 3, startS: 0, endS: 141, water: 355.9 }),
    rec(2, { ch: 4, startS: 141, endS: 300, water: 389.1 }),
    rec(3, { ch: 5, startS: 300, endS: 380, water: 190 }),                                   // stopped 70 s early
    rec(4, { ch: 6, startS: 441, endS: 484.4, water: 25.5, dosed: [0.25, 0.5, 0.25, 0.2] }), // the 15:30 Zone 4
  ], { expectedLph: 8820, final: true, endReason: 'flow_watch: dosing without water flow' });
  assert.deepEqual(zones.map(z => z.status), ['ok', 'ok', 'cut_short', 'no_water']);
  assert.equal(zones[0].achieved_ratio, 203);
  assert.equal(zones[1].achieved_ratio, 222);
  assert.equal(zones[0].tanks[0].achieved_ratio, 203);

  const shut = zs.decorateZones([
    rec(1, { ch: 3, startS: 0, endS: 150, water: 367 }),
    rec(2, { ch: 4, startS: 150, endS: 180, water: 20 }),
  ], {
    expectedLph: 8820, final: true, endSource: 'flow_watch_shutdown', endReason: 'flow_watch_shutdown: no flow 15 s',
    plan: { 3: [{ delay: 0, duration: 150 }], 4: [{ delay: 150, duration: 150 }], 5: [{ delay: 300, duration: 150 }], 6: [{ delay: 450, duration: 150 }] },
    startedAtMs: T0, names: { 5: 'Irrigation Zone 3', 6: 'Irrigation Zone 4' },
  });
  assert.deepEqual(shut.map(z => [z.channel, z.status]), [[3, 'ok'], [4, 'shutdown'], [5, 'not_run'], [6, 'not_run']]);
  assert.equal(shut[2].name, 'Irrigation Zone 3');
  assert.equal(shut[2].water_l, null, 'a zone that never ran has unknown water, not 0');
  assert.equal(shut[2].ec_avg_us, null);

  // not final (checkpoint while running): the last zone is not judged shut down
  const live = zs.decorateZones([rec(1, { ch: 3, startS: 0, endS: 30, water: 20 })], { expectedLph: 8820, final: false, endSource: 'flow_watch_shutdown' });
  assert.equal(live[0].status, 'no_water');
});

test('flow-watch cold-restart retry: two consecutive segments of the same zone merge into one visit row (water/litres summed, samples pooled, segments kept); segment records stay', () => {
  const { zones: segs, visits: zones } = zs.analyseZones([
    rec(1, { ch: 3, startS: 0, endS: 150, water: 367, ec_avg_us: 2300, ec_samples: 10, ec_min_us: 2200, ec_max_us: 2400, ph_avg: 6.0, samples: 10, ph_min: 5.9, ph_max: 6.1 }),
    rec(2, { ch: 6, startS: 150, endS: 178, water: 12, dosed: [0.25, 0.25, 0.25, 0], ec_avg_us: null, ec_samples: 0, ph_avg: null, samples: 0, skipped_samples: 2 }),
    rec(3, { ch: 6, startS: 178, endS: 300, water: 290, dosed: [1.5, 1.5, 1.5, 1.75], ec_avg_us: 1900, ec_samples: 10, ec_min_us: 1800, ec_max_us: 2000, ph_avg: 6.3, samples: 10, ph_min: 6.2, ph_max: 6.4 }),
  ], { expectedLph: 8820, final: true, endReason: null });
  assert.equal(segs.length, 3, 'the stored segment records are kept');
  assert.deepEqual(segs.map(r => r.status), ['ok', 'no_water', 'ok']);
  assert.equal(zones.length, 2);
  const z4 = zones[1];
  assert.equal(z4.channel, 6);
  assert.equal(z4.retries, 1);
  assert.deepEqual(z4.segments.map(s => s.status), ['no_water', 'ok']);
  assert.equal(z4.water_l, 302);
  assert.deepEqual(z4.tanks.map(t => t.dosed_l), [1.75, 1.75, 1.75, 1.75]);
  assert.equal(z4.ec_avg_us, 1900);
  assert.equal(z4.samples, 10);
  assert.equal(z4.skipped_samples, 2);
  assert.equal(z4.status, 'ok');
  assert.equal(z4.achieved_ratio, Math.round(302 / 1.75));
  // idempotent on the stored records
  assert.deepEqual(zs.analyseZones(segs, { expectedLph: 8820, final: true }).visits, zones);
});

test('history (legacy run record without zone stats): EC/pH per zone from stored SEKO readings, flow filter from the monitor series', () => {
  const ins = db.prepare('INSERT INTO readings (equipment_id, name, value, unit, timestamp) VALUES (?, ?, ?, ?, ?)');
  // zone 1: 0-141 s, zone 2: 141-300 s; flow 8,800 except 0 from 280 s on
  ins.run(MON_EQ, 'Flow Rate', 8800, 'L/h', iso(T0 - 5000));
  ins.run(MON_EQ, 'Flow Rate', 8790, 'L/h', iso(T0 + 100000));
  ins.run(MON_EQ, 'Flow Rate', 8810, 'L/h', iso(T0 + 190000));
  ins.run(MON_EQ, 'Flow Rate', 0, 'L/h', iso(T0 + 280000));
  for (const [s, ph, ec] of [[10, 6.0, 2300], [40, 6.1, 2310], [130, 6.05, 2290], [150, 6.3, 2000], [200, 6.35, 1980], [290, 7.2, 600]]) {
    ins.run(PH_EQ, 'pH', ph, 'pH', iso(T0 + s * 1000));
    ins.run(PH_EQ, 'Water EC', ec, 'µS/cm', iso(T0 + s * 1000));
  }
  const run = { started_at: iso(T0 - 9000), ended_at: iso(T0 + 300000), zones: [rec(1, { ch: 3, startS: 0, endS: 141, water: 355 }), rec(2, { ch: 4, startS: 141, endS: 300, water: 360 })] };
  const stats = zs.statsFromHistory(db, run, { sensorEquipmentId: PH_EQ, phMetric: 'pH', ecMetric: 'Water EC', expectedLph: 8820 });
  assert.equal(stats[0].ec_avg_us, 2300);
  assert.equal(stats[0].ph_avg, 6.05);
  assert.equal(stats[0].samples, 3);
  assert.equal(stats[1].ec_avg_us, 1990, 'the stagnant sample at 290 s (flow 0) is skipped');
  assert.equal(stats[1].samples, 2);
  assert.equal(stats[1].skipped_samples, 1);
});

// ─── DoseController: live per-zone sampling ─────────────────────────────────

/**
 * 4 zones x 150 s (like automation 100). Flow 8,820 L/h with a 3 s dip at each
 * switch-over; SEKO sample every 10 s whose EC/pH depends on the zone. Zone 4's
 * valve sticks: flow 0 after 10 s. `endAt` (s) ends the cycle with `end`.
 */
async function simulate({ endAt, end, zone4Stuck = true, dipSample = true }) {
  db.prepare('DELETE FROM dose_controller_runs').run();
  const auto = Number(db.prepare("INSERT INTO automations (name, trigger_config, actions, enabled) VALUES ('Fertigation 15:30 (zs sim)', '{}', ?, 0)")
    .run(JSON.stringify([3, 4, 5, 6].map((ch, i) => ({ type: 'control', action: 'on', equipment_id: IRR_EQ, channel: ch, delay_seconds: i * 150, duration_seconds: 150 })))).lastInsertRowid);
  let t = T0;
  const ctl = new DoseController({
    db, now: () => t, autoTick: false, logger: quiet, arming: { isDisarmed: () => false },
    config: { ph: { enabled: false, sensor_equipment_id: PH_EQ }, nutrients: { irrigation_equipment_id: IRR_EQ, expected_flow_lph: 8820 } },
  });
  const valves = {};
  const tanks = [1, 2, 3, 4].map(id => ({ tank_id: id, tank_name: `Tank ${'ABCD'[id - 1]}`, equipment_id: DOSE_EQ, channel: id + 1, duty_pct: 100, valve_events: [] }));
  const consumed = { 1: 10, 2: 10, 3: 10, 4: 10 };
  ctl.beginCycle({
    cycleLogId: 1, programId: null, automationId: auto, durationSeconds: 600, schedule: { tanks }, tanks,
    write: async (target, state) => { valves[target.channel] = state; return true; }, abort: async () => {}, valveStates: {},
  });
  const ZQ = { 3: [2300, 6.05], 4: [1990, 6.32], 5: [1820, 6.39], 6: [1600, 6.45] };
  const zoneAt = (rel) => (rel < 150 ? 3 : rel < 300 ? 4 : rel < 450 ? 5 : 6);
  const flowAt = (rel) => {
    if (rel < 3) return rel * 2900;
    for (const sw of [150, 300, 450]) if (rel >= sw + 0.5 && rel < sw + 3.5) return 300;
    if (zone4Stuck && rel >= 460) return 0;
    return 8820;
  };
  let lastZone = null;
  let net = 76000; // litres on the meter's accumulator
  for (let step = 0; step <= endAt * 4; step++) {
    const rel = step / 4;
    t = T0 + step * 250;
    const z = zoneAt(rel);
    if (z !== lastZone) {
      if (lastZone) db.prepare('INSERT INTO relay_events (equipment_id, channel, state, source, created_at) VALUES (?, ?, 0, ?, ?)').run(IRR_EQ, lastZone, 'automation_auto_off', dbTs(t));
      db.prepare('INSERT INTO relay_events (equipment_id, channel, state, source, automation_id, created_at) VALUES (?, ?, 1, ?, ?, ?)').run(IRR_EQ, z, 'automation', auto, dbTs(t));
      lastZone = z;
    }
    const flow = flowAt(rel);
    net += (flow / 3600) * 0.25;
    if (step % 2 === 0) ctl.ingest({ kind: 'flowmeter', farmId: '1021', receivedMs: t, live: true, values: { flow_lph: flow, net_total_m3: Math.floor(net * 10) / 10000, signal_quality: 95, error_flags: 0 } });
    if (step % 4 === 0) {
      for (const id of [1, 2, 3, 4]) if (valves[id + 1] && flow > 4000) consumed[id] += 1.6 / 60;
      ctl.ingest({ kind: 'dosing', farmId: '1021', receivedMs: t, live: true, tanks: [1, 2, 3, 4].map(id => ({ id, consumed_l: Math.floor(consumed[id] * 4) / 4, rate_lph: valves[id + 1] && flow > 4000 ? 96 : 0 })) });
    }
    // SEKO every 10 s (+ one sample inside the 300 s switch-over dip, and stagnant-cup values once the water stops)
    const seko = (step % 40 === 20) || (dipSample && step === 301 * 4);
    if (seko) {
      const [ec, ph] = flow < 1000 ? [700, 7.3] : ZQ[z];
      db.prepare('UPDATE equipment SET last_reading = ?, last_communication = ? WHERE id = ?')
        .run(JSON.stringify({ values: { pH: { value: ph, unit: 'pH' }, 'Water EC': { value: ec, unit: 'µS/cm' } } }), iso(t), PH_EQ);
    }
    ctl.step(t);
    await ctl.flush();
  }
  const run = await ctl.endCycle(end);
  ctl.stop();
  return run;
}

test('controller (15:30 replay): per-zone EC/pH stored live; switch-over dip and no-water samples skipped; Zone 4 no_water; totals row', async () => {
  const run = await simulate({ endAt: 490, end: { status: 'aborted', reason: 'flow_watch: dosing without water flow', source: 'flow_watch' } });
  const z = run.zones;
  assert.deepEqual(run.zone_visits.map(r => [r.channel, r.status]), z.map(r => [r.channel, r.status]), "one visit row per zone");
  assert.deepEqual(z.map(r => r.channel), [3, 4, 5, 6]);
  assert.deepEqual(z.map(r => r.status), ['ok', 'ok', 'ok', 'no_water']);
  assert.deepEqual(z.map(r => r.ec_avg_us), [2300, 1990, 1820, 1600]);
  assert.deepEqual(z.map(r => r.ph_avg), [6.05, 6.32, 6.39, 6.45]);
  assert.ok(z.every(r => r.stats_source === 'live'));
  // Zone 1: the first 40 s after the run's first pump start (here: water established, no pump
  // relay events in this replay) are the line flush -> reported as flush_*, not in the average
  assert.ok(z[0].samples >= 10 && z[1].samples >= 13, `samples ${z.map(r => r.samples)}`);
  assert.equal(z[0].flush_samples, 4, 'SEKO samples at +5/15/25/35 s are the start flush');
  assert.equal(z[0].flush_s, 40);
  assert.ok(z.slice(1).every(r => !r.flush_samples), 'only the first pump start of the run is a flush');
  assert.ok(z[1].skipped_samples + z[2].skipped_samples >= 1, 'the sample in the 3 s Zone 2 -> 3 switch-over dip is skipped');
  assert.equal(z[3].samples, 1, 'only the Zone 4 sample while water still flowed counts');
  assert.ok(z[3].skipped_samples >= 1, 'stagnant-cup samples after the water stopped are skipped');
  assert.ok(z[0].achieved_ratio > 0);
  assert.equal(run.zone_totals.zones_ok, 3);
  assert.equal(run.zone_totals.samples, z.reduce((s, r) => s + r.samples, 0));
  // totals water = the run's metered water (includes the few litres before the first zone segment)
  const zoneSum = z.reduce((s, r) => s + r.water_l, 0);
  assert.equal(run.zone_totals.water_l, run.water_l);
  assert.ok(run.water_l >= zoneSum - 0.5 && run.water_l - zoneSum < 15, `run ${run.water_l} vs zones ${zoneSum}`);
  // the stored record carries the fields (not only the read decoration)
  const stored = JSON.parse(db.prepare('SELECT zones_json FROM dose_controller_runs WHERE id = ?').get(run.id).zones_json);
  assert.deepEqual(stored.map(r => r.status), ['ok', 'ok', 'ok', 'no_water']);
  assert.equal(stored[2].ec_avg_us, 1820);
});

test('controller: flow-watch pump shutdown during Zone 3 -> Zone 3 "shutdown", Zone 4 "not_run" (from the automation plan)', async () => {
  const run = await simulate({ endAt: 330, zone4Stuck: false, end: { status: 'aborted', reason: 'flow_watch_shutdown: no flow 15 s with the pumps running', source: 'flow_watch_shutdown' } });
  assert.deepEqual(run.zones.map(r => [r.channel, r.status]), [[3, 'ok'], [4, 'ok'], [5, 'shutdown'], [6, 'not_run']]);
  assert.equal(run.zones[3].water_l, null);
  assert.equal(run.zone_totals.zones_total, 4);
  assert.deepEqual(run.zone_visits.map(r => r.status), ['ok', 'ok', 'shutdown', 'not_run']);
});
