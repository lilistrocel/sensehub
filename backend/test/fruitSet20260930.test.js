/**
 * Operator request 2026-09-30 ("fruit set started"):
 *  - protocol revision 2026-09-30: flowering fed the fruit-set recipe, its 1:100 dilution
 *    STATED by the protocol (provenance), 2026-09-28 kept intact;
 *  - the tank recipe change at 12:00 recorded as a back-dated refill: the stock countdown
 *    anchors there and the feed calculator feeds each run the recipe its tanks held;
 *  - dated activation of schedule automations (the new program starts tomorrow, today's
 *    runs untouched): active_from / active_until in the scheduler and the watchdog.
 * In-memory DB, loopback HTTP only.
 */
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');

const src = (...p) => require(path.join(__dirname, '..', 'src', ...p));
const { db } = src('utils', 'database.js');
const P = src('services', 'cropProtocol.js');
const S = src('services', 'elementTargetScaling.js');
const FC = src('services', 'FeedCalculator.js');
const { CropProfileService } = src('services', 'CropProfileService.js');
const W = src('utils', 'scheduleWindow.js');
const { NOW, seedFarm, addRun } = require('./fixtures/nutritionFarm');

const near = (actual, expected, tol, label) => assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual} vs ${expected} (±${tol})`);

test('protocol 2026-09-30: flowering -> fruit_set recipe (= fruiting content), 1:100 stated by the protocol; 2026-09-28 unchanged', () => {
  const v2 = P.PROTOCOL_2026_09_30;
  assert.equal(v2.name, 'Human agronomist protocol (2026-09-30)');
  assert.equal(v2.data.stage_recipe.flowering, 'fruit_set');
  assert.deepEqual(v2.data.recipes.fruit_set.tanks, P.RECIPES.fruiting.tanks, 'same stock recipe as fruiting');
  assert.deepEqual(P.recipeDilution(v2.data, 'fruit_set'), { dilution: 100, source: 'protocol', note: "Protocol sheet 2026-09-30: 'Resulting solution (at 1:100)'" });
  assert.equal(P.recipeDilution(v2.data, 'vegetative').source, 'sensehub_assumption');
  assert.equal(P.recipeDilution(v2.data, 'vegetative').dilution, 150);
  // the old version is untouched
  assert.equal(P.PROTOCOL.data.stage_recipe.flowering, 'vegetative');
  assert.equal(P.PROTOCOL.data.daily_program.ml_per_plant_day, 930);
  assert.equal(P.PROTOCOLS.length, 2);
  // daily program from 2026-10-01: 11 runs, 34.5 min/section, ~1,150 mL/plant/day
  const prog = v2.data.daily_program;
  assert.equal(prog.runs.length, 11);
  assert.equal(prog.effective_from, '2026-10-01');
  near(prog.runs.reduce((a, r) => a + r.minutes, 0), 34.5, 1e-9, 'min/section');
  near(prog.runs.reduce((a, r) => a + r.ml_per_plant, 0), 1150, 5, 'mL/plant/day');
  assert.ok(prog.ml_per_plant_day >= v2.data.stage_targets.flowering.ml_per_plant_day.min, 'meets the flowering >= 930 mL');
});

test('flowering stage ppm: fruit-set recipe at 1:100 (protocol provenance) = fruiting at 1:150 × 1.5; prefill notes say where the dilution comes from', () => {
  const sp = S.protocolStagePpm(P.PROTOCOL_2026_09_30.data, 'flowering');
  assert.equal(sp.recipe, 'fruit_set');
  assert.equal(sp.design_dilution, 100);
  assert.equal(sp.dilution_source, 'protocol');
  const fr150 = S.protocolStagePpm(P.PROTOCOL.data, 'fruiting');
  assert.equal(fr150.dilution_source, 'sensehub_assumption');
  for (const el of ['N', 'K', 'Ca', 'Mg', 'Fe']) near(sp.ppm[el], fr150.ppm[el] * 1.5, 0.005, el);
  // Ca 90 kg × 19 % / 1000 L / 100 = 171 ppm ; K (15×41.5 + 18×28.2 + 68×38.2)/10 = 372.77
  near(sp.ppm.Ca, 171, 0.001, 'Ca'); near(sp.ppm.K, 372.77, 0.01, 'K');
  const rows = S.protocolElementRows(sp);
  assert.match(rows[0].notes, /fruit_set recipe at 1:100 \(stated by the protocol\)/);
  assert.match(S.protocolElementRows(S.protocolStagePpm(P.PROTOCOL.data, 'flowering'))[0].notes, /vegetative recipe at 1:150 \(SenseHub design assumption\)/);
  // scale to input EC 2.1 with source water 0.2: factor = 1.9 / EC(1:100) -> equivalent ratio ≈ 1:116
  const f = S.scaleFactor({ ecTarget: 2.1, sourceWaterEc: 0.2, stagePpm: sp });
  assert.equal(f.ok, true);
  assert.equal(f.math.dilution_source, 'protocol');
  assert.equal(f.math.recipe, 'fruit_set');
  near(f.math.protocol_fertilizer_ec, 2.21, 0.02, 'fertilizer EC at 1:100');
  assert.ok(f.math.equivalent_dilution >= 114 && f.math.equivalent_dilution <= 118, `ratio 1:${f.math.equivalent_dilution}`);
});

test('profile on the 2026-09-30 version: per-stage dilution + source in protocol_ppm; feed report protocol block says protocol', () => {
  seedFarm(db);
  const svc = new CropProfileService({ db, now: () => NOW });
  const v2 = db.prepare('SELECT id FROM crop_protocols WHERE key = ?').get(P.PROTOCOL_KEY_2026_09_30);
  assert.ok(v2, 'the new version is stored alongside the old one');
  const p0 = svc.getActive();
  svc.update(p0.id, { protocol_id: v2.id, stage_override: 'flowering', stage_override_note: 'fruit set started' });
  const p = svc.getActive();
  assert.equal(p.stage.effective, 'flowering');
  assert.equal(p.protocol_ppm.by_stage.flowering.recipe, 'fruit_set');
  assert.equal(p.protocol_ppm.by_stage.flowering.design_dilution, 100);
  assert.equal(p.protocol_ppm.by_stage.flowering.dilution_source, 'protocol');
  assert.equal(p.protocol_ppm.by_stage.vegetative.dilution_source, 'sensehub_assumption');
  const rep = FC.buildFeedReport(db, { profile: p, period: 'today', nowMs: NOW, tz: 'Asia/Dubai', protocolData: p.protocol.data });
  assert.equal(rep.protocol.recipe, 'fruit_set');
  assert.equal(rep.protocol.design_dilution, 100);
  assert.equal(rep.protocol.dilution_source, 'protocol');
});

test('feed report: a refill mid-day switches the recipe — runs before it are fed the old mixture, runs after it the new one', () => {
  seedFarm(db);
  db.exec('DELETE FROM irrigation_runs');
  const ing = db.prepare("SELECT id FROM fertigation_ingredients WHERE name = 'Calcium Nitrate'").get().id;
  const oldMix = db.prepare('SELECT mixture_id FROM fertigation_tanks WHERE id = 1').get().mixture_id;
  db.prepare("INSERT INTO fertigation_tank_refills (tank_id, refilled_at, water_liters_added, total_volume_after, mixture_id) VALUES (1, '2026-09-25 12:13:02', 1000, 1000, ?)").run(oldMix);
  const newMix = Number(db.prepare("INSERT INTO fertigation_mixtures (name) VALUES ('Tank A fruit set 90 kg')").run().lastInsertRowid);
  db.prepare("INSERT INTO fertigation_mixture_items (mixture_id, ingredient_id, parts, amount, unit) VALUES (?, ?, 1, 90, 'kg')").run(newMix, ing);
  // refill at 12:00 Dubai (08:00Z) with the new recipe; the tank now holds it
  db.prepare("INSERT INTO fertigation_tank_refills (tank_id, refilled_at, water_liters_added, total_volume_after, mixture_id) VALUES (1, '2026-09-28 08:00:00', 1000, 1000, ?)").run(newMix);
  db.prepare('UPDATE fertigation_tanks SET mixture_id = ? WHERE id = 1').run(newMix);
  addRun(db, { key: 'am', startedAt: '2026-09-28T03:30:00Z', localDate: '2026-09-28', water: 2000, tanks: { 1: 10, 2: 10, 3: 10, 4: 10 } });
  addRun(db, { key: 'pm', startedAt: '2026-09-28T09:00:00Z', localDate: '2026-09-28', water: 1000, tanks: { 1: 4, 2: 4, 3: 4, 4: 4 } });
  const rep = FC.buildFeedReport(db, { profile: null, period: 'today', nowMs: NOW, tz: 'Asia/Dubai' });
  assert.equal(rep.basis, 'measured');
  // Ca: old 100 kg -> 19,000 mg/L stock, new 90 kg -> 17,100 mg/L: (10×19000 + 4×17100) / 3000
  near(rep.ppm.Ca, (10 * 19000 + 4 * 17100) / 3000, 0.01, 'Ca from both recipes');
  near(rep.tanks.find(t => t.letter === 'A').ppm.Ca, (10 * 19000 + 4 * 17100) / 3000, 0.01, 'per tank');
  assert.equal(rep.recipe_changed_in_period, true);
  const segA = rep.recipe_segments.filter(s => s.tank_id === 1);
  assert.equal(segA.length, 2);
  assert.deepEqual(segA.map(s => [s.mixture_id, s.current, s.runs, s.dosed_l]), [[oldMix, false, 1, 10], [newMix, true, 1, 4]]);
  assert.equal(segA[1].since, '2026-09-28T08:00:00.000Z');
  // mixtureAt: no refill history -> the current mixture
  assert.equal(FC.mixtureAt(new Map(), { tank_id: 9, mixture_id: 77 }, Date.now()).mixture_id, 77);
});

test('refill route: refilled_at back-dates the refill (stock anchor + recipe from then); validated', async () => {
  seedFarm(db);
  db.exec('DELETE FROM tank_stock_ledger');
  const router = src('routes', 'fertigation.js');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { const role = req.headers['x-role']; if (role) req.user = { id: null, email: `${role}@farm.test`, role }; next(); });
  app.use('/api/fertigation', router);
  const server = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/fertigation`;
  const send = async (p, body, role = 'operator') => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-role': role }, body: JSON.stringify(body) });
  try {
    const mix = Number(db.prepare("INSERT INTO fertigation_mixtures (name) VALUES ('new A')").run().lastInsertRowid);
    const twoHoursAgo = new Date(Date.now() - 2 * 3600000);
    const local = new Date(twoHoursAgo.getTime() + 4 * 3600000).toISOString().slice(0, 19) + '+04:00';
    // validation
    assert.equal((await send('/tanks/1/refill', { water_liters_added: 1000, refilled_at: '2026-09-30 12:00' })).status, 400, 'no zone');
    assert.equal((await send('/tanks/1/refill', { water_liters_added: 1000, refilled_at: new Date(Date.now() + 3600000).toISOString() })).status, 400, 'future');
    assert.equal((await send('/tanks/1/refill', { water_liters_added: 1000, refilled_at: new Date(Date.now() - 8 * 86400000).toISOString() })).status, 400, '> 7 days');
    assert.equal((await send('/tanks/1/refill', { water_liters_added: 1000, total_volume_after: 1200, refilled_at: local })).status, 400, 'above capacity');
    assert.equal((await send('/tanks/1/refill', { water_liters_added: 1000, mixture_id: 999999, refilled_at: local })).status, 400, 'unknown mixture');
    assert.equal((await send('/tanks/1/refill', { water_liters_added: 1000, refilled_at: local }, 'viewer')).status, 403);
    const r = await send('/tanks/1/refill', { water_liters_added: 1000, total_volume_after: 1000, mixture_id: mix, refilled_at: local, notes: 'fruit set recipe' });
    assert.equal(r.status, 200, await r.clone().text());
    const body = await r.json();
    const row = db.prepare('SELECT * FROM fertigation_tank_refills WHERE id = ?').get(body.refill_id);
    assert.equal(row.refilled_at, twoHoursAgo.toISOString().slice(0, 19).replace('T', ' '), 'stored as UTC SQLite time');
    assert.equal(row.total_volume_after, 1000);
    assert.equal(row.mixture_id, mix);
    assert.equal(JSON.parse(row.composition_snapshot).mixture_id, mix);
    assert.equal(body.tank.mixture_id, mix);
    const led = db.prepare("SELECT * FROM tank_stock_ledger WHERE tank_id = 1 AND ref = ?").get(`refill:${body.refill_id}`);
    assert.equal(led.kind, 'refill');
    assert.equal(led.stock_after, 1000);
    assert.equal(Date.parse(led.occurred_at), Math.floor(twoHoursAgo.getTime() / 1000) * 1000, 'anchored at the refill time, not now');
    // a second refill must be after it
    assert.equal((await send('/tanks/1/refill', { water_liters_added: 100, refilled_at: new Date(twoHoursAgo.getTime() - 60000).toISOString() })).status, 400, 'before the previous refill');
    // no refilled_at: now (unchanged behaviour)
    const r2 = await send('/tanks/2/refill', { water_liters_added: 500 });
    assert.equal(r2.status, 200);
  } finally {
    server.close();
  }
});

test('dated activation: active_from / active_until validated; outside the window a daily schedule is neither due nor missed', () => {
  assert.equal(W.validateActiveWindow({ type: 'schedule', active_from: '2026-10-01' }), null);
  assert.equal(W.validateActiveWindow({ active_until: '2026-09-30' }), null);
  assert.match(W.validateActiveWindow({ active_from: '2026-13-01' }), /YYYY-MM-DD/);
  assert.match(W.validateActiveWindow({ active_until: '30/09/2026' }), /YYYY-MM-DD/);
  assert.match(W.validateActiveWindow({ active_from: '2026-10-02', active_until: '2026-10-01' }), /not be after/);
  const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 10);
  assert.equal(W.isWithinActiveWindow({ active_from: '2026-10-01' }, at(2026, 9, 30, 23, 59)), false);
  assert.equal(W.isWithinActiveWindow({ active_from: '2026-10-01' }, at(2026, 10, 1, 0, 0)), true);
  assert.equal(W.isWithinActiveWindow({ active_until: '2026-09-30' }, at(2026, 9, 30, 17, 0)), true);
  assert.equal(W.isWithinActiveWindow({ active_until: '2026-09-30' }, at(2026, 10, 1, 7, 30)), false);
  assert.equal(W.isWithinActiveWindow({}, at(2026, 10, 1, 7, 30)), true);

  const { automationSchedulerService: sched } = src('services', 'AutomationSchedulerService.js');
  const realNow = Date.now;
  const RealDate = Date;
  const withNow = (d, fn) => {
    global.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(d.getTime()); } static now() { return d.getTime(); } };
    try { return fn(); } finally { global.Date = RealDate; Date.now = realNow; }
  };
  const newRun = { type: 'schedule', schedule_type: 'daily', time: '08:45', active_from: '2026-10-01' };
  const oldRun = { type: 'schedule', schedule_type: 'daily', time: '13:45', active_until: '2026-09-30' };
  assert.equal(withNow(at(2026, 9, 30, 8, 45), () => sched._isScheduleDue(newRun, null)), false, 'new run not today');
  assert.equal(withNow(at(2026, 10, 1, 8, 45), () => sched._isScheduleDue(newRun, null)), true, 'new run from tomorrow');
  assert.equal(withNow(at(2026, 9, 30, 13, 45), () => sched._isScheduleDue(oldRun, null)), true, 'old run still fires today');
  assert.equal(withNow(at(2026, 10, 1, 13, 45), () => sched._isScheduleDue(oldRun, null)), false, 'old run retired tomorrow');

  const { watchdogService } = src('services', 'WatchdogService.js');
  assert.equal(watchdogService._isScheduleMissed(newRun, null, 5, at(2026, 9, 30, 14, 0)).missed, false, 'not missed before it starts');
  assert.equal(watchdogService._isScheduleMissed(newRun, null, 5, at(2026, 10, 1, 9, 0)).missed, true, 'missed once active');
  assert.equal(watchdogService._isScheduleMissed(oldRun, null, 5, at(2026, 10, 1, 14, 0)).missed, false, 'retired: not missed');
});
