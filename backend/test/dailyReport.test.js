// Daily report: estimated (relay ON-time x flow) vs measured (MQTT irrigation monitor).
// In-memory DB built by utils/database; fixtures mirror the 2026-09-26 set-up.
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const src = (...p) => require(path.join(__dirname, '..', 'src', ...p));
const R = src('services', 'DailyReportService.js');
const { db } = src('utils', 'database.js');

const Z = (s) => Date.parse(s);
const iso = (ms) => new Date(ms).toISOString();
const sql = (ms) => iso(ms).slice(0, 19).replace('T', ' ');
const NOW = Z('2026-09-26T06:30:00Z'); // 10:30 Dubai

function seed() {
  db.exec(`
    DELETE FROM readings; DELETE FROM relay_events; DELETE FROM irrigation_cycles; DELETE FROM mqtt_monitors;
    DELETE FROM relay_channel_config; DELETE FROM fertigation_tanks; DELETE FROM automations; DELETE FROM equipment;
    DELETE FROM system_settings;
  `);
  db.prepare("INSERT INTO system_settings (key, value) VALUES ('timezone', ?)").run(JSON.stringify({ timezone: 'Asia/Dubai' }));
  const eq = db.prepare('INSERT INTO equipment (id, name, type, protocol) VALUES (?, ?, ?, ?)');
  eq.run(1, 'Waveshare Irrigation 1', 'relay', 'modbus');
  eq.run(2, 'Waveshare Irrigation 2', 'relay', 'modbus');
  eq.run(19, 'Irrigation Monitor 1021', 'sensor', 'mqtt');
  db.prepare("INSERT INTO automations (id, name) VALUES (96, 'Fertigation 09:30 — 3.5 min/zone, full strength')").run();
  db.prepare("INSERT INTO mqtt_monitors (farm_id, equipment_id, created_at) VALUES ('1021', 19, '2026-09-26 05:07:03')").run();

  const cfg = db.prepare('INSERT INTO relay_channel_config (equipment_id, channel, ingredient_name, flow_rate, flow_unit, tank_id) VALUES (?, ?, ?, ?, ?, ?)');
  for (const ch of [3, 4, 5, 6]) cfg.run(1, ch, 'Water', 146.99, 'L/min', null);
  cfg.run(2, 1, null, 0.991, 'L/min', 5);
  cfg.run(2, 2, null, 1.0, 'L/min', 1);
  cfg.run(2, 3, null, 1.0, 'L/min', 2);
  cfg.run(2, 4, null, 1.0, 'L/min', 3);
  cfg.run(2, 5, null, 1.5, 'L/min', 4);
  const tank = db.prepare('INSERT INTO fertigation_tanks (id, name, equipment_id, channel, role, active) VALUES (?, ?, 2, ?, ?, 1)');
  tank.run(1, 'Tank A', 2, 'nutrient');
  tank.run(2, 'Tank B', 3, 'nutrient');
  tank.run(3, 'Tank C', 4, 'nutrient');
  tank.run(4, 'Tank D', 5, 'nutrient');
  tank.run(5, 'pH Down', 1, 'ph_down');

  // Relay events for the 09:30 run (05:30Z): 4 zones x 210 s, dosing on Tank A/B/D relays.
  const re = db.prepare('INSERT INTO relay_events (equipment_id, channel, state, source, automation_id, created_at) VALUES (?, ?, ?, ?, 96, ?)');
  const t0 = Z('2026-09-26T05:30:00Z');
  [3, 4, 5, 6].forEach((ch, i) => {
    re.run(1, ch, 1, 'automation', sql(t0 + i * 210000));
    re.run(1, ch, 0, 'automation', sql(t0 + (i + 1) * 210000));
  });
  re.run(2, 2, 1, 'dose_program', sql(t0)); re.run(2, 2, 0, 'dose_program', sql(t0 + 600000)); // Tank A 10 min -> est 10 L
  re.run(2, 3, 1, 'dose_program', sql(t0)); re.run(2, 3, 0, 'dose_program', sql(t0 + 300000)); // Tank B 5 min, nothing measured
  re.run(2, 5, 1, 'dose_program', sql(t0)); re.run(2, 5, 0, 'dose_program', sql(t0 + 120000)); // Tank D 2 min -> est 3 L
  // Tank C relay (ch 4) never ON, yet its counter moves: the miswire fault class.

  // Monitor readings: 5-min heartbeat from 05:07Z, 10 s while irrigating.
  const rd = db.prepare('INSERT INTO readings (equipment_id, name, value, unit, timestamp) VALUES (19, ?, ?, ?, ?)');
  const series = (name, unit, fn, from, to, step) => { for (let t = from; t <= to; t += step) rd.run(name, fn(t), unit, iso(t)); };
  const start = Z('2026-09-26T05:07:00Z');
  const end = Z('2026-09-26T06:25:00Z');
  const runA = Z('2026-09-26T05:30:00Z');
  const runB = Z('2026-09-26T05:44:00Z');
  const frac = (t) => Math.max(0, Math.min(1, (t - runA) / (runB - runA)));
  const pts = [];
  for (let t = start; t <= end; t += (t >= runA - 60000 && t <= runB + 60000 ? 10000 : 300000)) pts.push(t);
  for (const t of pts) {
    // net total with a one-LSB flicker while idle; +2.0 m³ over the run
    rd.run('Net Total', 72.0383 + (t < runA && (t / 1000) % 2 ? 0.0001 : 0) + 2.0 * frac(t), 'm³', iso(t));
    rd.run('Tank 1 Consumed', 179 + 9.0 * frac(t), 'L', iso(t));
    rd.run('Tank 2 Consumed', 170, 'L', iso(t));
    rd.run('Tank 3 Consumed', 150.5 + 3.0 * frac(t), 'L', iso(t));
    rd.run('Tank 4 Consumed', 67.75 + 3.25 * frac(t), 'L', iso(t));
    rd.run('Tank 5 Consumed', 0, 'L', iso(t));
    for (const n of [1, 2, 3, 4]) rd.run(`Tank ${n} Rate`, 0, 'L/h', iso(t));
  }
  void series;

  db.prepare(`INSERT INTO irrigation_cycles (farm_id, equipment_id, cycle_id, start_time, end_time, duration_s, water_m3, dosing_json, raw_payload, received_at)
    VALUES ('1021', 19, '20260926T093000', '2026-09-26T09:30:00+04:00', '2026-09-26T09:44:00+04:00', 840, 2.0, ?, '{}', '2026-09-26T05:44:10.000Z')`)
    .run(JSON.stringify([{ id: 1, consumed_l: 9.0 }, { id: 2, consumed_l: 0 }, { id: 3, consumed_l: 3.0 }, { id: 4, consumed_l: 3.25 }, { id: 5, consumed_l: 0 }]));
}

test('farm-local day windows (Asia/Dubai)', () => {
  seed();
  const out = R.buildDailyReport(db, { days: 2, nowMs: NOW });
  assert.equal(out.timezone, 'Asia/Dubai');
  assert.equal(out.report[0].date, '2026-09-26');
  assert.equal(out.report[0].day_start, '2026-09-25T20:00:00.000Z');
  assert.equal(out.report[0].day_end, '2026-09-26T20:00:00.000Z');
});

test('estimated fields stay backward compatible', () => {
  seed();
  const d = R.buildDailyReport(db, { days: 1, nowMs: NOW }).report[0];
  assert.equal(d.water.total_seconds, 840);
  assert.equal(d.water.total_liters, Math.round(840 / 60 * 146.99 * 100) / 100);
  assert.equal(d.fertigation.total_seconds, 600 + 300 + 120);
  for (const k of ['total_minutes', 'events', 'by_channel', 'liters_by_channel', 'channel_details']) assert.ok(k in d.water, k);
  assert.ok('automations' in d && 'power' in d && 'drift_events' in d);
});

test('measured water: counter delta primary, cycle reports cross-check, jitter ignored', () => {
  seed();
  const m = R.buildDailyReport(db, { days: 1, nowMs: NOW }).report[0].measured;
  assert.equal(m.available, true);
  assert.equal(m.water.source, 'flowmeter_counter');
  assert.ok(Math.abs(m.water.liters - 2000) < 1, `water ${m.water.liters}`);
  assert.equal(m.water.cycles_liters, 2000);
  assert.equal(m.water.cycles_count, 1);
  assert.equal(m.water.counter_resets, 0);
  // estimate compared over the covered window only
  assert.ok(Math.abs(m.comparison.water.estimated_liters - 840 / 60 * 146.99) < 0.5);
  assert.equal(m.comparison.water.flags.length, 0);
  assert.equal(m.coverage.first_reading, '2026-09-26T05:07:00.000Z');
  assert.equal(m.coverage.complete, false); // monitor only came online at 09:07 local
});

test('per-tank flags: deviation, relay without dosing, dosing without relay; unmetered tank is null not 0', () => {
  seed();
  const m = R.buildDailyReport(db, { days: 1, nowMs: NOW }).report[0].measured;
  const by = Object.fromEntries(m.comparison.tanks.map(t => [t.tank_id, t]));
  assert.equal(by[1].measured_liters, 9);
  assert.equal(by[1].estimated_liters, 10);
  assert.deepEqual(by[1].flags, []); // -10 % is inside the 15 % threshold
  assert.deepEqual(by[2].flags, ['relay_without_dosing']);
  assert.deepEqual(by[3].flags, ['dosing_without_relay']);
  assert.equal(by[4].deviation_pct, 8.3);
  assert.equal(by[5].metered, false);
  assert.equal(by[5].measured_liters, null);
  assert.deepEqual(by[5].flags, []);
  assert.equal(m.comparison.fertigation.measured_liters, 15.25);
  assert.deepEqual(m.comparison.fertigation.tanks_included, [1, 2, 3, 4]);
  assert.ok(m.comparison.flags.some(f => f.type === 'dosing_without_relay' && f.tank_id === 3));
});

test('cycles are matched to the automation and carry the window estimate', () => {
  seed();
  const m = R.buildDailyReport(db, { days: 1, nowMs: NOW }).report[0].measured;
  assert.equal(m.cycles.length, 1);
  const c = m.cycles[0];
  assert.equal(c.automation.id, 96);
  assert.equal(c.water.measured_liters, 2000);
  assert.equal(c.water.measured_source, 'cycle_report');
  assert.ok(Math.abs(c.water.estimated_liters - 2057.9) < 0.5);
  assert.equal(c.estimate_mapping_caveat, false);
  assert.deepEqual(c.tanks.find(t => t.tank_id === 3).flags, ['dosing_without_relay']);
});

test('days before the monitor existed say "no measurement", never 0', () => {
  seed();
  const out = R.buildDailyReport(db, { days: 2, nowMs: NOW });
  assert.deepEqual(out.report[1].measured, { available: false, reason: 'no_measurement' });
  assert.equal(out.report[1].fertigation.mapping_caveat, true);
  assert.equal(out.measured_totals.days_with_measurement, 1);
});

test('calibration hint: implied venturi flow for the current relay, post-remap only', () => {
  seed();
  const out = R.buildDailyReport(db, { days: 1, nowMs: NOW });
  const a = out.calibration.find(c => c.tank_id === 1);
  assert.equal(a.channel, 2);
  assert.equal(a.relay_on_minutes, 10);
  assert.equal(a.implied_flow_lpm, 0.9);
  assert.equal(a.configured_flow_lpm, 1);
  assert.equal(out.calibration.find(c => c.tank_id === 3).implied_flow_lpm, null); // relay never ON
});

test('tank_map from system_settings re-attributes monitor counters', () => {
  seed();
  db.prepare("INSERT INTO system_settings (key, value) VALUES ('mqtt_monitor_settings', ?)")
    .run(JSON.stringify({ 1021: { tank_map: { 1: 2, 2: 1, 3: 3, 4: 4, 5: null } } }));
  const out = R.buildDailyReport(db, { days: 1, nowMs: NOW });
  assert.equal(out.monitor.tank_map_source, 'system_settings');
  assert.equal(out.monitor.tank_map_confirmed, true);
  const tanks = out.report[0].measured.comparison.tanks;
  assert.equal(tanks.find(t => t.monitor_tank === 1).tank_id, 2);
  assert.equal(tanks.find(t => t.monitor_tank === 5).tank_id, null);
});

test('positiveDelta: resets, glitches and jitter', () => {
  const t0 = Z('2026-09-26T05:00:00Z');
  const s = (a) => a.map(([sec, v]) => ({ timestamp: iso(t0 + sec * 1000), value: v }));
  assert.equal(R.positiveDelta(s([[0, 179], [10, 180], [20, 0], [30, 3]]), 0.34, 0.5, 0.3).delta, 4);
  const g = R.positiveDelta(s([[0, 10], [10, 500], [20, 10.5]]), 0.34, 0.5, 0.3);
  assert.equal(g.delta, 0);
  assert.equal(g.rejected, 1);
  assert.equal(R.positiveDelta(s([[0, 1]]), 1, 1).delta, null);
  const j = R.positiveDelta(s([[0, 72.0383], [30, 72.0384], [60, 72.0383], [90, 72.0384]]), 30 / 3600, 0.05, 0.005);
  assert.ok(Math.abs(j.delta - 0.0001) < 1e-9);
  assert.equal(j.resets, 0);
});
