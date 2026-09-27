// Irrigation runs: monitor cycles + relay events -> automated / manual_app / manual_panel runs.
// Fixture = real data 2026-09-26 05:00Z .. 2026-09-27 04:30Z (Asia/Dubai), extracted read-only
// from a copy of the live DB (test/fixtures/irrigation-runs-2026-09-27.json).
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const http = require('http');

const src = (...p) => require(path.join(__dirname, '..', 'src', ...p));
const { db } = src('utils', 'database.js');
const B = src('services', 'IrrigationRunBuilder.js');
const { IrrigationRunsService } = src('services', 'IrrigationRunsService.js');
const DR = src('services', 'DailyReportService.js');
const FIX = require('./fixtures/irrigation-runs-2026-09-27.json');

{
  const cols = db.pragma('table_info(relay_events)').map(c => c.name);
  if (!cols.includes('confirmed')) db.exec('ALTER TABLE relay_events ADD COLUMN confirmed INTEGER');
  if (!cols.includes('readback_state')) db.exec('ALTER TABLE relay_events ADD COLUMN readback_state INTEGER');
  if (!cols.includes('user_email')) db.exec('ALTER TABLE relay_events ADD COLUMN user_email TEXT');
}

const Z = (s) => Date.parse(s);
const quiet = { log() {}, warn() {}, error() {} };
const DAY26 = [Z('2026-09-25T20:00:00Z'), Z('2026-09-26T20:00:00Z')];
const DAY27 = [Z('2026-09-26T20:00:00Z'), Z('2026-09-27T20:00:00Z')];
const NOW = Z('2026-09-27T04:25:00Z'); // 08:25 Dubai, after the panel run

/**
 * Load the fixture. `until` (ms) keeps only cycles that had ENDED and relay
 * events that had happened by then (replays the live, incremental state).
 */
function seed({ until = Infinity } = {}) {
  db.exec(`
    DELETE FROM readings; DELETE FROM relay_events; DELETE FROM irrigation_cycles; DELETE FROM mqtt_monitors;
    DELETE FROM relay_channel_config; DELETE FROM fertigation_tanks; DELETE FROM automations; DELETE FROM equipment;
    DELETE FROM system_settings; DELETE FROM dose_controller_runs; DELETE FROM irrigation_runs;
  `);
  db.prepare("INSERT INTO system_settings (key, value) VALUES ('timezone', ?)").run(JSON.stringify({ timezone: 'Asia/Dubai' }));
  const eq = db.prepare("INSERT INTO equipment (id, name, type, protocol, register_mappings) VALUES (?, ?, 'relay', 'modbus', ?)");
  for (const e of FIX.equipment) eq.run(e.id, e.name, e.register_mappings);
  db.prepare("UPDATE equipment SET protocol = 'mqtt', type = 'sensor' WHERE id = 19").run();
  db.prepare("INSERT INTO mqtt_monitors (farm_id, equipment_id, created_at) VALUES ('1021', 19, '2026-09-26 05:07:03')").run();
  const au = db.prepare('INSERT INTO automations (id, name, updated_at) VALUES (?, ?, ?)');
  for (const a of FIX.automations) au.run(a.id, a.name, a.updated_at);
  const rc = db.prepare('INSERT INTO relay_channel_config (equipment_id, channel, ingredient_name, flow_rate, flow_unit) VALUES (?, ?, ?, ?, ?)');
  for (const r of FIX.relay_channel_config) rc.run(r.equipment_id, r.channel, r.ingredient_name, r.flow_rate, r.flow_unit);
  const tk = db.prepare('INSERT INTO fertigation_tanks (id, name, equipment_id, channel, role, active) VALUES (?, ?, ?, ?, ?, ?)');
  for (const t of FIX.fertigation_tanks) tk.run(t.id, t.name, t.equipment_id, t.channel, t.role, t.active);
  const cy = db.prepare(`INSERT INTO irrigation_cycles (id, farm_id, equipment_id, cycle_id, start_time, end_time, duration_s, water_m3, dosing_json, raw_payload, received_at)
    VALUES (?, '1021', 19, ?, ?, ?, ?, ?, ?, '{}', ?)`);
  for (const c of FIX.irrigation_cycles) if (Z(c.end_time) <= until) cy.run(c.id, c.cycle_id, c.start_time, c.end_time, c.duration_s, c.water_m3, c.dosing_json, c.end_time);
  const re = db.prepare('INSERT INTO relay_events (equipment_id, channel, state, source, automation_id, user_email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const r of FIX.relay_events) if (Z(`${r[6].replace(' ', 'T')}Z`) <= until) re.run(...r);
  const rd = db.prepare('INSERT INTO readings (equipment_id, name, value, timestamp) VALUES (?, ?, ?, ?)');
  for (const r of FIX.readings) if (Z(r[3]) <= until) rd.run(...r);
  for (const d of FIX.dose_controller_runs) {
    if (Z(d.started_at) > until) continue;
    const cols = Object.keys(d);
    db.prepare(`INSERT INTO dose_controller_runs (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map(k => d[k]));
  }
}

const local = (iso) => new Date(Date.parse(iso) + 4 * 3600000).toISOString().slice(11, 19);
const runAt = (runs, hhmm) => runs.find(r => local(r.started_at).startsWith(hhmm));

// ─── the builder on the real data ───────────────────────────────────────────

test('2026-09-27 07:30 soft-switch run: 4 zone cycles + blip -> ONE automated run (automation 95), zones 1-3 ok, zone 4 shut down after its retry', () => {
  seed();
  const { runs } = B.buildRuns(db, { fromMs: DAY27[0], toMs: DAY27[1], nowMs: NOW });
  const r = runAt(runs, '07:30');
  assert.ok(r, runs.map(x => local(x.started_at)).join(','));
  assert.equal(r.type, 'automated');
  assert.equal(r.automation_id, 95);
  assert.match(r.automation_name, /^Fertigation 07:30/);
  assert.equal(r.status, 'shutdown');
  assert.equal(r.provisional, false);
  assert.deepEqual(r.cycle_ids, ['20260927T073012', '20260927T073328', '20260927T073630', '20260927T073939']);
  assert.equal(r.water_l, 1314.8);
  assert.equal(r.dose_controller_run_id, 3);
  assert.equal(r.zone_visits.length, 4);
  const [z1, z2, z3, z4] = r.zone_visits;
  assert.deepEqual([z1.channel, z2.channel, z3.channel, z4.channel], [3, 4, 5, 6]);
  assert.deepEqual([z1.status, z2.status, z3.status], ['ok', 'ok', 'ok']);
  assert.deepEqual([z1.water_l, z2.water_l, z3.water_l], [435.6, 435.1, 444]);
  assert.equal(z4.status, 'shutdown');
  assert.equal(z4.retries, 1);
  assert.ok(z4.water_l < 1, `zone 4 got ${z4.water_l} L`);
  // per-zone A-D from each zone's own cycle report; EC/pH reused from the dose-controller run
  assert.deepEqual(z1.tanks.map(t => t.dosed_l), [2, 2.25, 2, 2]);
  assert.equal(z1.stats_source, 'dose_controller');
  assert.ok(z1.ec_avg_us > 1500 && z1.ec_avg_us < 2200, `EC ${z1.ec_avg_us}`);
  assert.ok(z1.ph_avg > 5 && z1.ph_avg < 7);
  assert.equal(r.zone_totals.water_l, 1314.8);
  assert.equal(r.uncontrolled_dosing, false);
  assert.equal(r.type_label, 'Scheduled');
});

test('2026-09-27 08:07 PANEL run: manual_panel, zone unknown ("one zone\'s flow"), 1,787 L, A-D dosed with no SenseHub dosing command -> uncontrolled_dosing', () => {
  seed();
  const { runs } = B.buildRuns(db, { fromMs: DAY27[0], toMs: DAY27[1], nowMs: NOW });
  const r = runAt(runs, '08:07');
  assert.ok(r);
  assert.equal(r.type, 'manual_panel');
  assert.equal(r.type_label, 'Manual — panel');
  assert.equal(local(r.started_at), '08:07:00');
  assert.equal(local(r.ended_at), '08:18:59');
  assert.equal(r.duration_s, 720);
  assert.ok(Math.abs(r.water_l - 1786.9) < 1, `water ${r.water_l}`); // + 0.3 L of absorbed drain-back blips
  assert.equal(r.blips_absorbed, 2);
  assert.deepEqual(r.tanks.map(t => t.dosed_l), [9, 9, 9.25, 5.75]);
  assert.equal(r.achieved_ratio, 217);
  assert.equal(r.uncontrolled_dosing, true);
  assert.deepEqual(r.uncontrolled_tanks.map(t => t.tank_id), [1, 2, 3, 4]);
  assert.deepEqual(r.operators, []);
  assert.equal(r.zone_visits.length, 1);
  const z = r.zone_visits[0];
  assert.equal(z.zone_unknown, true);
  assert.equal(z.status, 'manual');
  assert.equal(z.zone_hint, "one zone's flow");
  assert.ok(r.avg_flow_lph > 8500 && r.avg_flow_lph < 9300, `flow ${r.avg_flow_lph}`);
  // EC/pH from the SEKO while water flowed
  assert.ok(r.ec_ms.avg > 1.5 && r.ec_ms.avg < 2.2, `EC ${r.ec_ms.avg}`);
  assert.ok(r.ph.samples > 10);
  // the 08:16 app toggles (a few seconds) did not turn it into an app run, but are noted
  assert.ok(r.app_relay_coverage_pct < 5);
  assert.ok(r.notes.some(n => /App relay switches during the run/.test(n) && /lilistrocel@gmail\.com/.test(n)), r.notes.join(' | '));
  assert.ok(r.notes.some(n => /Dosing outside SenseHub control/.test(n)));
});

test('2026-09-26 app-manual relay-6 tests: the 12:23 test -> manual_app, zone 4, operator ismail@a20core.com; the 09:45 / 11:50 / 11:51 test blips are dropped as drain-back', () => {
  seed();
  const { runs, dropped } = B.buildRuns(db, { fromMs: DAY26[0], toMs: DAY26[1], nowMs: NOW });
  const r = runAt(runs, '12:23');
  assert.ok(r);
  assert.equal(r.type, 'manual_app');
  assert.equal(r.type_label, 'Manual — app');
  assert.deepEqual(r.operators, ['ismail@a20core.com']);
  assert.equal(r.zone_visits.length, 1);
  assert.equal(r.zone_visits[0].channel, 6);
  assert.equal(r.zone_visits[0].status, 'manual');
  assert.equal(r.water_l, 21.6);
  assert.deepEqual(r.cycle_ids, ['20260926T122331', '20260926T122351']);
  assert.equal(r.status, 'manual');
  const d = dropped.map(x => x.cycle_id);
  for (const id of ['20260926T094552', '20260926T094624', '20260926T115050', '20260926T115154']) assert.ok(d.includes(id), `${id} not dropped: ${d}`);
  assert.ok(!runs.some(x => ['09:45', '09:46', '11:50', '11:51'].some(h => local(x.started_at).startsWith(h))));
});

test('2026-09-26 12:30 automated run with relay 6 left ON by hand (12:23:47-12:32:07): automated run, manual overlap noted on the run and on Zone 1, per-zone water split on the counters', () => {
  seed();
  const { runs } = B.buildRuns(db, { fromMs: DAY26[0], toMs: DAY26[1], nowMs: NOW });
  const r = runAt(runs, '12:30');
  assert.ok(r);
  assert.equal(r.type, 'automated');
  assert.equal(r.automation_id, 98);
  assert.equal(r.status, 'ok', r.notes.join(' | ')); // the manual OFF of relay 6 is not an operator stop of the run
  assert.equal(r.manual_overlap.length, 1);
  const m = r.manual_overlap[0];
  assert.equal(m.channel, 6);
  assert.equal(m.opened_by, 'ismail@a20core.com');
  assert.equal(m.closed_by, 'lilistrocel@gmail.com');
  assert.ok(r.notes.some(n => /Zone 4 was open manually during this run: opened 12:23:47 by ismail@a20core\.com, closed 12:32:07 by lilistrocel@gmail\.com/.test(n)), r.notes.join(' | '));
  const z1 = r.zone_visits.find(v => v.channel === 3);
  assert.deepEqual(z1.also_open.map(x => x.channel), [6]);
  // one monitor cycle spanned all 4 zones: split on the Net Total counter, sums back to the cycle
  const sum = r.zone_visits.reduce((s, v) => s + v.water_l, 0);
  assert.ok(Math.abs(sum - 2091.9) < 1, `zones sum ${sum}`);
  assert.ok(r.zone_visits.every(v => v.water_l > 450 && v.water_l < 600), r.zone_visits.map(v => v.water_l).join(','));
  const tankA = r.zone_visits.reduce((s, v) => s + v.tanks[0].dosed_l, 0);
  assert.ok(Math.abs(tankA - 15.25) < 0.1, `tank A ${tankA}`);
});

test('drain-back blips are dropped and the day reconciles: runs water + dropped blips = all cycle reports', () => {
  seed();
  for (const [a, b] of [DAY26, DAY27]) {
    const { runs, dropped } = B.buildRuns(db, { fromMs: a, toMs: b, nowMs: NOW });
    const s = B.summariseRuns(runs, dropped);
    const all = FIX.irrigation_cycles.filter(c => Z(c.start_time) >= a && Z(c.start_time) < b);
    const total = all.reduce((x, c) => x + (c.water_m3 || 0) * 1000, 0);
    assert.ok(Math.abs(s.cycles_water_l - total) < 0.5, `${s.cycles_water_l} vs ${total}`);
    assert.equal(s.cycles, all.length);
    for (const d of dropped) assert.ok(d.water_l < 5 || d.duration_s < 10, JSON.stringify(d));
  }
  const { runs, dropped } = B.buildRuns(db, { fromMs: DAY27[0], toMs: DAY27[1], nowMs: NOW });
  assert.deepEqual(runs.map(r => r.type), ['automated', 'manual_panel']);
  assert.equal(dropped.length, 0); // 07:39:39 is inside the 07:30 run, 08:06:45 / 08:19:00 absorbed by the panel run
});

test('builder helpers: union of intervals, counter interpolation, automation sources', () => {
  assert.equal(B.unionMs([[0, 10], [5, 20], [30, 40]], 0, 100), 30);
  assert.equal(B.unionMs([[0, 10]], 5, 8), 3);
  assert.equal(B.valueAt([[0, 0], [10, 100]], 5), 50);
  assert.equal(B.valueAt([[0, 1]], 99), 1);
  assert.equal(B.isAutoSource('automation_auto_off'), true);
  assert.equal(B.isAutoSource('flow_watch_shutdown'), true);
  assert.equal(B.isAutoSource('manual'), false);
  assert.equal(B.isAutoSource('stop_all'), false);
});

// ─── the service (table, incremental build, backfill, API) ───────────────────

test('service: backfill is idempotent (second pass writes nothing, ids stable) and the table serves list / last / get', () => {
  seed();
  const svc = new IrrigationRunsService({ db, now: () => NOW, logger: quiet, setTimer: () => null, broadcast: () => {} });
  const a = svc.backfill(7);
  assert.equal(a.inserted, 10);
  const ids = db.prepare('SELECT id, run_key FROM irrigation_runs ORDER BY id').all();
  const b = svc.backfill(7);
  assert.equal(b.inserted, 0);
  assert.equal(b.updated, 0);
  assert.equal(b.deleted, 0);
  assert.deepEqual(db.prepare('SELECT id, run_key FROM irrigation_runs ORDER BY id').all(), ids);
  const last = svc.last();
  assert.equal(last.type, 'manual_panel');
  assert.equal(svc.get(last.id).key, last.key);
  const today = svc.list({ date: 'today' });
  assert.equal(today.date, '2026-09-27');
  assert.deepEqual(today.runs.map(r => r.type), ['manual_panel', 'automated']);
  assert.equal(svc.list({ type: 'manual_app' }).runs.length, 1);
  assert.equal(svc.list({ from: '2026-09-26T08:00:00Z', to: '2026-09-26T09:00:00Z' }).runs.length, 2);
});

test('service: built incrementally on each cycle report — the 07:30 run is ONE row that grows zone by zone (provisional), then closes as shutdown with the same id', () => {
  seed({ until: Z('2026-09-27T03:33:20Z') }); // zone 1's cycle reported, zone 2 running
  let now = Z('2026-09-27T03:33:20Z');
  const timers = [];
  const svc = new IrrigationRunsService({ db, now: () => now, logger: quiet, setTimer: (fn) => { timers.push(fn); return 1; }, broadcast: () => {} });
  svc.rebuild(Z('2026-09-26T20:00:00Z'), now + 60000);
  let row = db.prepare('SELECT * FROM irrigation_runs').all();
  assert.equal(row.length, 1);
  const id = row[0].id;
  let run = svc.get(id);
  assert.equal(run.provisional, true);
  assert.equal(run.status, 'running');
  assert.deepEqual(run.cycle_ids, ['20260927T073012']);

  // the rest of the run arrives; onCycle() debounces and rebuilds around the report
  seed({ until: Z('2026-09-27T03:45:00Z') });
  db.prepare('INSERT INTO irrigation_runs (id, run_key, type, status, started_at, detail_json) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, row[0].run_key, row[0].type, row[0].status, row[0].started_at, row[0].detail_json);
  now = Z('2026-09-27T03:45:00Z');
  svc.onCycle({ start: '2026-09-27T07:39:39+04:00', end: '2026-09-27T07:39:41+04:00' });
  svc.onCycle({ start: '2026-09-27T07:36:30+04:00', end: '2026-09-27T07:39:35+04:00' });
  assert.equal(timers.length, 1, 'debounced to one rebuild');
  timers[0]();
  row = db.prepare('SELECT * FROM irrigation_runs').all();
  assert.equal(row.length, 1);
  assert.equal(row[0].id, id);
  run = svc.get(id);
  assert.equal(run.provisional, false);
  assert.equal(run.status, 'shutdown');
  assert.equal(run.cycle_ids.length, 4);
});

test('API: GET /api/irrigation/runs, /runs/last, /runs/:id (read-only routes on the service singleton)', async () => {
  seed();
  const { getIrrigationRunsService } = src('services', 'IrrigationRunsService.js');
  const svc = getIrrigationRunsService();
  svc.now = () => NOW;
  svc._setTimer = () => null;
  svc.log = quiet;
  svc.backfill(7);
  const express = require('express');
  const app = express();
  app.use('/api/irrigation', src('routes', 'irrigationRuns.js'));
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/irrigation`;
  try {
    const last = await (await fetch(`${base}/runs/last`)).json();
    assert.equal(last.run.type, 'manual_panel');
    const one = await (await fetch(`${base}/runs/${last.run.id}`)).json();
    assert.equal(one.run.id, last.run.id);
    const list = await (await fetch(`${base}/runs?date=2026-09-26&type=automated&limit=5`)).json();
    assert.equal(list.total, 7);
    assert.equal(list.runs.length, 5);
    assert.ok(list.runs.every(r => r.type === 'automated'));
    assert.equal((await fetch(`${base}/runs?type=bogus`)).status, 400);
    assert.equal((await fetch(`${base}/runs?from=yesterday`)).status, 400);
    assert.equal((await fetch(`${base}/runs/999999`)).status, 404);
  } finally {
    server.close();
  }
});

test('daily report: the day lists RUNS (grouped, typed) next to the raw cycles, and they reconcile with the cycle reports', () => {
  seed();
  const rep = DR.buildDailyReport(db, { days: 2, nowMs: NOW });
  const d27 = rep.report.find(d => d.date === '2026-09-27');
  assert.ok(d27.measured.available, d27.measured.reason);
  assert.deepEqual(d27.measured.runs.map(r => r.type), ['automated', 'manual_panel']);
  assert.equal(d27.measured.runs_summary.runs, 2);
  assert.equal(d27.measured.runs_summary.by_type.manual_panel.count, 1);
  assert.ok(Math.abs(d27.measured.runs_summary.cycles_water_l - d27.measured.water.cycles_liters) < 0.5);
  assert.equal(d27.measured.water.runs_liters, d27.measured.runs_summary.water_l);
  assert.ok(!('tanks' in d27.measured.runs[0].cycles[0]), 'report runs carry slim cycles');
  assert.equal(rep.measured_totals.manual_runs >= 1, true);
});

test('agronomist snapshot: one compact line per manual run (panel run -> zone unknown, dosing outside SenseHub control)', () => {
  seed();
  const { manualRunLine } = src('services', 'AgronomistService.js');
  const { runs } = B.buildRuns(db, { fromMs: DAY27[0], toMs: DAY27[1], nowMs: NOW });
  const line = manualRunLine(runAt(runs, '08:07'));
  assert.match(line, /^\d\d:\d\d-\d\d:\d\d manual \(panel\) 1787 L, A 9 B 9 C 9\.25 D 5\.75 L \(1:217\), EC 1\.\d+ pH [\d.]+, zone unknown \(one zone's flow\), dosing outside SenseHub control$/);
  const app = manualRunLine(runAt(B.buildRuns(db, { fromMs: DAY26[0], toMs: DAY26[1], nowMs: NOW }).runs, '12:23'));
  assert.match(app, /manual \(app, ismail@a20core\.com\) 22 L, no dosing/);
});
