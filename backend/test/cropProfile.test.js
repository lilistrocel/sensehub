/**
 * Crop profiles: seed from crop_assignments + the human agronomist protocol
 * (idempotent), stage from days after transplant (timeline + override), CRUD with
 * history, targets (stage + element, via crop_element_targets), AI compact view.
 * In-memory DB only.
 */
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const src = (...p) => require(path.join(__dirname, '..', 'src', ...p));
const { db } = src('utils', 'database.js');
const { seedCropNutrition, ensureCropNutritionSchema } = src('utils', 'cropNutritionSchema.js');
const { CropProfileService, computeStage } = src('services', 'CropProfileService.js');
const { PROTOCOL_NAME } = src('services', 'cropProtocol.js');
const { NOW, seedFarm } = require('./fixtures/nutritionFarm');

const svc = new CropProfileService({ db, now: () => NOW });
let farm;

test('seed: protocol baseline + one profile from the active cucumber crop, with protocol defaults', () => {
  farm = seedFarm(db);
  assert.equal(farm.seed.profiles, 1);
  const protocols = db.prepare('SELECT * FROM crop_protocols ORDER BY id').all();
  // both versions stored (a revision is a new row); the first-run seed follows the first
  assert.equal(protocols.length, 2);
  assert.equal(protocols[0].name, PROTOCOL_NAME);
  assert.equal(protocols[1].name, 'Human agronomist protocol (2026-09-30)');
  assert.equal(protocols[0].author, 'human agronomist');
  const p = svc.getActive();
  assert.equal(p.crop, 'Cucumber');
  assert.equal(p.crop_assignment_id, farm.cropId);
  assert.equal(p.variety, 'S13-06 F1');
  assert.equal(p.breeder, 'Sakata');
  assert.equal(p.plants_per_m2, 3.5);
  assert.equal(p.transplant_date, '2026-09-07', 'planted 04:00Z = 08:00 Dubai');
  assert.equal(p.substrate_type, 'Coco Coir', 'crop row substrate wins over the protocol text');
  assert.equal(p.dripper_flow_lph, 2);
  assert.equal(p.protocol.name, PROTOCOL_NAME);
  // stage targets exactly as the protocol states them
  const veg = p.stage_targets.vegetative;
  assert.equal(veg.ec_target, 1.7);
  assert.equal(veg.ec_min, null);
  assert.deepEqual([veg.ph_min, veg.ph_max], [5.5, 5.8]);
  assert.deepEqual([veg.drain_pct_min, veg.drain_pct_target, veg.drain_pct_max], [20, 25, 30]);
  assert.equal(veg.drain_ec_delta_max, 0.6);
  assert.deepEqual([veg.drain_ph_min, veg.drain_ph_max], [5.0, 6.8]);
  assert.equal(veg.ml_target, 930);
  const fr = p.stage_targets.fruiting;
  assert.deepEqual([fr.ec_min, fr.ec_max, fr.ml_min, fr.ml_max], [2.0, 2.2, 2000, 3000]);
  // element targets in the existing crop_element_targets table, prefilled at 1:150
  const n = p.element_targets.vegetative.find(e => e.element === 'N');
  assert.ok(Math.abs(n.soft_target - 154.3) < 0.2, `N ${n.soft_target}`);
  assert.ok(Math.abs(n.hard_min - 131.2) < 0.2 && Math.abs(n.hard_max - 177.4) < 0.2);
  assert.equal(p.element_targets.vegetative.length, 12);
  assert.equal(p.element_targets.fruiting.find(e => e.element === 'K').soft_target, 248.5);
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM crop_element_targets WHERE crop_assignment_id = ? AND priority = 1').get(farm.cropId).n === 0,
    'no priority-1 rows (the planner turns those into guardrails)');
});

test('seed is idempotent: a second run (and a schema re-run) changes nothing; operator edits survive', () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM crop_element_targets').get().n;
  db.prepare("UPDATE crop_stage_targets SET ec_target = 1.8, source = 'operator' WHERE stage = 'vegetative'").run();
  assert.equal(seedCropNutrition(db, { log: { log() {} } }).profiles, 0);
  ensureCropNutritionSchema(db, { log: { log() {} } });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM crop_profiles').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM crop_protocols').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM crop_element_targets').get().n, before);
  assert.equal(db.prepare("SELECT ec_target FROM crop_stage_targets WHERE stage = 'vegetative'").get().ec_target, 1.8);
  db.prepare("UPDATE crop_stage_targets SET ec_target = 1.7, source = 'protocol' WHERE stage = 'vegetative'").run();
});

test('stage: auto from days after transplant, next stage + date, manual override wins', () => {
  const p = svc.getActive();
  assert.equal(p.stage.today, '2026-09-28');
  assert.equal(p.stage.days_after_transplant, 21);
  assert.equal(p.stage.auto_stage, 'vegetative');
  assert.equal(p.stage.effective, 'vegetative');
  assert.equal(p.stage.source, 'auto');
  assert.deepEqual({ stage: p.stage.next.stage, date: p.stage.next.date, in_days: p.stage.next.in_days }, { stage: 'flowering', date: '2026-10-02', in_days: 4 });
  const tl = JSON.stringify(p.stage_timeline);
  const at = (today) => computeStage({ transplant_date: '2026-09-07', stage_timeline: tl }, { today });
  assert.equal(at('2026-09-07').days_after_transplant, 0);
  assert.equal(at('2026-09-07').effective, 'vegetative');
  assert.equal(at('2026-10-01').effective, 'vegetative', 'day 24');
  assert.equal(at('2026-10-02').effective, 'flowering', 'day 25');
  assert.equal(at('2026-10-07').effective, 'fruiting', 'day 30');
  assert.equal(at('2026-10-07').next, null);
  assert.equal(at('2026-09-01').effective, null, 'before transplant: no stage');
  const ov = computeStage({ transplant_date: '2026-09-07', stage_timeline: tl, stage_override: 'fruiting', stage_override_note: 'early fruit set' }, { today: '2026-09-28' });
  assert.equal(ov.effective, 'fruiting');
  assert.equal(ov.auto_stage, 'vegetative');
  assert.equal(ov.source, 'override');
  assert.equal(ov.override.note, 'early fruit set');
  assert.equal(computeStage({ transplant_date: null, stage_timeline: tl }, { today: '2026-09-28' }).source, 'none');
});

test('update: validates, syncs crop_assignments (legacy readers), override stamps a time', () => {
  assert.throws(() => svc.update(1, { plants_per_m2: -1 }), /plants_per_m2/);
  assert.throws(() => svc.update(1, { transplant_date: '07/09/2026' }), /YYYY-MM-DD/);
  assert.throws(() => svc.update(1, { stage_override: 'blooming' }), /stage_override/);
  assert.throws(() => svc.update(1, { stage_timeline: [{ stage: 'vegetative', from_day: 0 }, { stage: 'fruiting', from_day: 0 }] }), /unique/);
  assert.throws(() => svc.update(999, { crop: 'x' }), /not found/);
  const p = svc.update(1, { plants_per_section: 4300, source_water_ec: 0.35, buffer_tank_l: 40, stage_override: 'flowering', stage_override_note: 'first female flowers open' }, { userId: 7 });
  assert.equal(p.plants.source, 'entered');
  assert.equal(p.plants.per_section, 4300);
  assert.equal(p.plants.total, 17200, '4 sections from the dose-controller zone channels');
  assert.equal(p.stage.effective, 'flowering');
  assert.ok(p.stage_override_at);
  const ca = db.prepare('SELECT * FROM crop_assignments WHERE id = ?').get(farm.cropId);
  assert.equal(ca.current_stage, 'flowering');
  assert.equal(ca.variety, 'S13-06 F1');
  assert.equal(ca.plant_count, 17200);
  const cleared = svc.update(1, { stage_override: null });
  assert.equal(cleared.stage.source, 'auto');
  assert.equal(cleared.stage_override_note, null);
  assert.equal(db.prepare('SELECT current_stage FROM crop_assignments WHERE id = ?').get(farm.cropId).current_stage, 'vegetative');
});

test('targets: upsert stage + element targets (into crop_element_targets), bounds checked, reset to the protocol', () => {
  assert.throws(() => svc.setTargets(1, { stage_targets: [{ stage: 'vegetative', ec_min: 2, ec_max: 1.5 }] }), /must not exceed/);
  assert.throws(() => svc.setTargets(1, { element_targets: [{ stage: 'vegetative', element: 'Zz', soft_target: 1 }] }), /element/);
  assert.throws(() => svc.setTargets(1, { element_targets: [{ stage: 'vegetative', element: 'N', hard_min: 200, soft_target: 150 }] }), /min above target/);
  const p = svc.setTargets(1, {
    stage_targets: [{ stage: 'vegetative', ec_min: 1.6, ec_target: 1.7, ec_max: 1.8, ph_min: 5.5, ph_max: 5.8, ml_target: 930 }],
    element_targets: [{ stage: 'vegetative', element: 'K', hard_min: 190, soft_target: 220, hard_max: 250 }, { stage: 'seedling', element: 'N', soft_target: 120 }],
  }, { userId: 7 });
  assert.equal(p.stage_targets.vegetative.ec_min, 1.6);
  assert.equal(p.stage_targets.vegetative.source, 'operator');
  const k = p.element_targets.vegetative.find(e => e.element === 'K');
  assert.deepEqual([k.hard_min, k.soft_target, k.hard_max, k.priority], [190, 220, 250, 2], 'priority kept when not sent');
  assert.equal(p.element_targets.seedling.length, 1);
  const r = svc.resetTargetsToProtocol(1);
  assert.equal(r.stage_targets.vegetative.ec_min, null);
  assert.equal(r.stage_targets.vegetative.source, 'protocol');
  assert.equal(r.element_targets.vegetative.find(e => e.element === 'K').soft_target, 213);
  assert.equal(r.element_targets.seedling.length, 1, 'stages the protocol does not cover are left alone');
});

test('create: a new crop cycle closes the previous one (history kept), one active profile per zone', () => {
  const before = svc.getActive();
  assert.throws(() => svc.create({ crop: '' }), /crop is required/);
  const p = svc.create({ crop: 'Cucumber', variety: 'Test F1', transplant_date: '2026-10-20', protocol_id: before.protocol_id, plants_per_section: 4000 }, { userId: 3 });
  assert.notEqual(p.id, before.id);
  assert.equal(p.active, true);
  assert.equal(p.stage.days_after_transplant, -22);
  assert.equal(p.stage.effective, null);
  assert.equal(p.stage_targets.vegetative.ec_target, 1.7, 'protocol defaults prefilled');
  const all = svc.list({ includeInactive: true });
  assert.equal(all.length, 2);
  assert.equal(all.filter(x => x.active).length, 1);
  const old = svc.getProfile(before.id);
  assert.equal(old.active, false);
  assert.ok(old.ended_at);
  assert.equal(db.prepare('SELECT active FROM crop_assignments WHERE id = ?').get(farm.cropId).active, 0);
  const ca = db.prepare('SELECT * FROM crop_assignments WHERE id = ?').get(p.crop_assignment_id);
  assert.equal(ca.active, 1);
  assert.equal(ca.crop_name, 'Cucumber');
  assert.equal(ca.variety, 'Test F1');
  assert.throws(() => db.prepare("INSERT INTO crop_profiles (zone_id, crop, active) VALUES (1, 'x', 1)").run(), /UNIQUE/);
  // back to the seeded cycle for the other tests
  db.prepare('UPDATE crop_profiles SET active = 0 WHERE id = ?').run(p.id);
  db.prepare('UPDATE crop_assignments SET active = 0 WHERE id = ?').run(p.crop_assignment_id);
  db.prepare('UPDATE crop_profiles SET active = 1, ended_at = NULL WHERE id = ?').run(before.id);
  db.prepare('UPDATE crop_assignments SET active = 1 WHERE id = ?').run(farm.cropId);
});

test('AI readers: crop rows get the compact profile; syncStage keeps crop_assignments in step', () => {
  const rows = db.prepare('SELECT * FROM crop_assignments WHERE active = 1').all();
  const out = svc.enrichCropRows(rows);
  assert.equal(out.length, 1);
  const pr = out[0].profile;
  assert.equal(pr.variety, 'S13-06 F1');
  assert.equal(pr.days_after_transplant, 21);
  assert.equal(pr.stage, 'vegetative');
  assert.deepEqual(pr.next_stage, { stage: 'flowering', date: '2026-10-02' });
  assert.deepEqual(pr.stage_targets.input_ph, [5.5, 5.8]);
  assert.equal(pr.protocol, PROTOCOL_NAME);
  db.prepare("UPDATE crop_assignments SET current_stage = 'seedling' WHERE id = ?").run(farm.cropId);
  assert.equal(svc.syncStage(1), true);
  assert.equal(svc.syncStage(1), false);
  assert.equal(db.prepare('SELECT current_stage FROM crop_assignments WHERE id = ?').get(farm.cropId).current_stage, 'vegetative');
  // the agronomist snapshot carries it
  const { agronomistService } = src('services', 'AgronomistService.js');
  const snap = agronomistService.aggregateDailyData('2026-09-28');
  assert.equal(snap.crops[0].profile.variety, 'S13-06 F1');
});
