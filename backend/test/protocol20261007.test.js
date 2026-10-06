/**
 * Operator request 2026-10-06: the human agronomist's daily program from 2026-10-07
 * (13 runs, each watering the 4 sections back-to-back, 47.5 min per section,
 * ~1,580 mL/plant/day) as protocol version "Human agronomist protocol (2026-10-07)".
 *  - everything but the daily program is the 2026-09-30 version (recipes, stage
 *    targets, stage recipes, the 1:100 stated fruit-set dilution);
 *  - 2026-09-28 and 2026-09-30 stay intact (a revision is a NEW row);
 *  - pointing a profile at it never re-prefills operator-edited targets and, with the
 *    profile linked to the dose controller, raises no proposal (dosing unchanged);
 *  - the advisor snapshot carries the new program and version.
 * In-memory DB, stubbed alerts / Telegram / AI client, no Modbus.
 */
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const src = (...p) => require(path.join(__dirname, '..', 'src', ...p));
const { db } = src('utils', 'database.js');
const P = src('services', 'cropProtocol.js');
const S = src('services', 'elementTargetScaling.js');
const { ensureCropNutritionSchema } = src('utils', 'cropNutritionSchema.js');
const { CropProfileService } = src('services', 'CropProfileService.js');
const { ControllerLinkService } = src('services', 'ControllerLinkService.js');
const { DoseController } = src('services', 'DoseController.js');
const { FertilizerAdvisorService } = src('services', 'FertilizerAdvisorService.js');
const { NOW, seedFarm } = require('./fixtures/nutritionFarm');

const quiet = { log() {}, warn() {}, error() {} };
const near = (actual, expected, tol, label) => assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual} vs ${expected} (±${tol})`);
const strip = (d) => { const { daily_program, previous_version, changes, ...rest } = d; return rest; };

test('protocol 2026-10-07: the agronomist program (13 runs, 47.5 min/section, ~1,580 mL/plant/day); all else = 2026-09-30', () => {
  const v3 = P.PROTOCOL_2026_10_07;
  assert.equal(v3.name, 'Human agronomist protocol (2026-10-07)');
  assert.equal(v3.key, 'cucumber_1021_2026_10_07');
  assert.equal(v3.author, 'human agronomist');
  assert.equal(v3.source_date, '2026-10-07');
  assert.equal(v3.data.previous_version, P.PROTOCOL_KEY_2026_09_30);
  // identical to 2026-09-30 except the program
  assert.deepEqual(strip(v3.data), strip(P.PROTOCOL_2026_09_30.data));
  assert.deepEqual(v3.data.recipes, P.PROTOCOL_2026_09_30.data.recipes);
  assert.deepEqual(v3.data.stage_targets, P.PROTOCOL_2026_09_30.data.stage_targets);
  assert.deepEqual(v3.data.stage_recipe, { vegetative: 'vegetative', flowering: 'fruit_set', fruiting: 'fruiting' });
  assert.deepEqual(P.recipeDilution(v3.data, 'fruit_set'), P.recipeDilution(P.PROTOCOL_2026_09_30.data, 'fruit_set'));
  assert.equal(v3.data.senseHub_design_dilution, 150);
  // the program exactly as sent
  const prog = v3.data.daily_program;
  assert.equal(prog.effective_from, '2026-10-07');
  assert.equal(prog.stage, 'flowering');
  assert.deepEqual(prog.sections_order, [1, 2, 3, 4]);
  assert.deepEqual(prog.runs.map(r => [r.time, r.minutes]), [
    ['07:30', 3.5], ['08:30', 3.5], ['09:30', 4], ['10:15', 4], ['11:00', 4], ['11:40', 4], ['12:20', 4],
    ['13:00', 4], ['13:40', 4], ['14:20', 4], ['15:10', 3.5], ['16:00', 3], ['17:00', 2],
  ]);
  assert.deepEqual(prog.runs.filter(r => r.last).map(r => r.time), ['17:00']);
  near(prog.runs.reduce((a, r) => a + r.minutes, 0), 47.5, 1e-9, 'min/section');
  assert.equal(prog.minutes_per_section, 47.5);
  near(prog.runs.reduce((a, r) => a + r.ml_per_plant, 0), 1580, 5, 'mL/plant/day (33 mL/min)');
  assert.equal(prog.ml_per_plant_day, 1580);
  assert.ok(prog.runs.every(r => Math.abs(r.ml_per_plant - r.minutes * 100 / 3) <= 0.5), '1 min = 33.3 mL/plant');
  assert.ok(prog.ml_per_plant_day >= v3.data.stage_targets.flowering.ml_per_plant_day.min);
  // older versions intact
  assert.equal(P.PROTOCOLS.length, 3);
  assert.deepEqual(P.PROTOCOLS.map(x => x.key), [P.PROTOCOL_KEY, P.PROTOCOL_KEY_2026_09_30, P.PROTOCOL_KEY_2026_10_07]);
  assert.equal(P.PROTOCOL_2026_09_30.data.daily_program.runs.length, 11);
  assert.equal(P.PROTOCOL_2026_09_30.data.daily_program.ml_per_plant_day, 1150);
  assert.equal(P.PROTOCOL.data.daily_program.ml_per_plant_day, 930);
  // same flowering feed (fruit set at 1:100, protocol provenance) as 2026-09-30
  assert.deepEqual(S.protocolStagePpm(v3.data, 'flowering'), S.protocolStagePpm(P.PROTOCOL_2026_09_30.data, 'flowering'));
});

test('stored as a new crop_protocols row; a schema re-run inserts nothing and never rewrites a stored version', () => {
  seedFarm(db);
  const rows = db.prepare('SELECT key, name, data FROM crop_protocols ORDER BY id').all();
  assert.deepEqual(rows.map(r => r.name), ['Human agronomist protocol (2026-09-28)', 'Human agronomist protocol (2026-09-30)', 'Human agronomist protocol (2026-10-07)']);
  assert.equal(JSON.parse(rows[2].data).daily_program.runs.length, 13);
  assert.equal(JSON.parse(rows[1].data).daily_program.runs.length, 11);
  ensureCropNutritionSchema(db, { log: quiet });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM crop_protocols').get().n, 3);
});

test('switching the linked profile 2026-09-30 -> 2026-10-07: operator targets untouched, no re-prefill, no controller-link proposal, controller config unchanged', () => {
  seedFarm(db);
  const clock = NOW;
  const profiles = new CropProfileService({ db, now: () => clock });
  const ctl = new DoseController({ db, autoTick: false, logger: quiet, now: () => clock });
  const alerts = [];
  const link = new ControllerLinkService({
    db, now: () => clock, doseController: ctl, profiles, log: quiet,
    createAlert: (o) => { alerts.push(o); return { id: alerts.length }; }, updateOpenAlert: () => null, notify: () => {},
  });
  const v2 = db.prepare('SELECT id FROM crop_protocols WHERE key = ?').get(P.PROTOCOL_KEY_2026_09_30).id;
  const v3 = db.prepare('SELECT id FROM crop_protocols WHERE key = ?').get(P.PROTOCOL_KEY_2026_10_07).id;
  const PID = profiles.activeRow().id;
  profiles.update(PID, { protocol_id: v2, stage_override: 'flowering', stage_override_note: 'fruit set started', source_water_ec: 0.2 });
  // operator-edited flowering targets + one hand-edited element target (differs from its basis)
  profiles.setTargets(PID, { stage_targets: [{ stage: 'flowering', ec_min: 2.0, ec_target: 2.1, ec_max: 2.2, ph_min: 5.8, ph_max: 6.2, ml_target: 1600 }] });
  const caId = profiles.activeRow().crop_assignment_id;
  const kRow = db.prepare("SELECT * FROM crop_element_targets WHERE crop_assignment_id = ? AND growth_stage = 'flowering' AND element = 'K'").get(caId);
  assert.ok(kRow, 'flowering K target exists');
  profiles.setTargets(PID, { element_targets: [{ stage: 'flowering', element: 'K', hard_min: 300, soft_target: 333, hard_max: 380 }] });
  // the controller follows the crop targets (linked, pending proposal approved and applied)
  link.setMode(PID, 'follow_crop_targets', { id: 1, email: 'admin@farm.test', role: 'admin' });
  const pend = link.view(PID).pending;
  if (pend) {
    link.approve(pend.id, { id: 1, email: 'admin@farm.test', role: 'admin' });
    assert.ok(link.applyApprovedForCycle(ctl), 'applied');
  }
  assert.equal(link.view(PID).now.diff.length, 0, 'controller matches the crop targets');

  const snap = (sql, ...a) => JSON.stringify(db.prepare(sql).all(...a));
  const stageBefore = snap('SELECT * FROM crop_stage_targets WHERE profile_id = ? ORDER BY id', PID);
  const elBefore = snap('SELECT * FROM crop_element_targets WHERE crop_assignment_id = ? ORDER BY id', caId);
  const cfgBefore = JSON.stringify(ctl.getConfig(true));
  const versionsBefore = db.prepare('SELECT COUNT(*) AS n FROM dose_controller_config_versions').get().n;
  const proposalsBefore = db.prepare('SELECT COUNT(*) AS n FROM controller_link_proposals').get().n;
  const hashBefore = link.compute(PID).hash;

  const p = profiles.update(PID, { protocol_id: v3 });
  assert.equal(p.protocol.name, 'Human agronomist protocol (2026-10-07)');
  assert.equal(p.protocol.data.daily_program.runs.length, 13);
  assert.equal(p.stage.effective, 'flowering');
  assert.equal(p.protocol_ppm.by_stage.flowering.design_dilution, 100);
  assert.equal(p.protocol_ppm.by_stage.flowering.dilution_source, 'protocol');
  // targets untouched (no prefill on a version switch), the hand-edited K kept
  assert.equal(snap('SELECT * FROM crop_stage_targets WHERE profile_id = ? ORDER BY id', PID), stageBefore);
  assert.equal(snap('SELECT * FROM crop_element_targets WHERE crop_assignment_id = ? ORDER BY id', caId), elBefore);
  assert.equal(db.prepare("SELECT soft_target FROM crop_element_targets WHERE crop_assignment_id = ? AND growth_stage = 'flowering' AND element = 'K'").get(caId).soft_target, 333);
  // the link sees the same controller values: same hash, no diff, evaluate + tick raise nothing
  const c = link.compute(PID);
  assert.equal(c.inputs.protocol_name, 'Human agronomist protocol (2026-10-07)');
  assert.equal(c.hash, hashBefore);
  assert.equal(c.proposal.diff.length, 0);
  assert.equal(link.evaluate(PID), null);
  assert.deepEqual(link.tick(), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM controller_link_proposals').get().n, proposalsBefore);
  assert.equal(JSON.stringify(ctl.getConfig(true)), cfgBefore);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dose_controller_config_versions').get().n, versionsBefore);
});

test('advisor snapshot: human_protocol is the 2026-10-07 version with its 13-run program', () => {
  const advisor = new FertilizerAdvisorService({
    db, now: () => NOW, log: quiet,
    getClient: () => { throw new Error('no AI call in this test'); },
    getAgronomistConfig: () => ({ model: 'claude-sonnet-5', effort: 'medium', translation_enabled: false, translation_languages: [], reference_temperature_equipment_id: null }),
    getAgronomistHealth: () => ({ paused: false }),
    classifyProviderError: () => 'other',
    createAlert: () => {},
  });
  const { snapshot } = advisor.buildSnapshot({ nowMs: NOW });
  const hp = snapshot.human_protocol;
  assert.equal(hp.name, 'Human agronomist protocol (2026-10-07)');
  assert.equal(hp.date, '2026-10-07');
  assert.equal(hp.authoritative, true);
  assert.equal(hp.daily_program.runs.length, 13);
  assert.equal(hp.daily_program.minutes_per_section, 47.5);
  assert.equal(hp.daily_program.ml_per_plant_day, 1580);
  assert.equal(hp.recipes.fruit_set.design_dilution, 100);
  assert.equal(hp.recipes.fruit_set.design_dilution_source, 'stated by the human protocol');
});
