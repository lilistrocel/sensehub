/**
 * Element targets follow the input EC target (operator request 2026-09-29):
 * factor math (fertilizer EC = target − source water, ÷ protocol EC at the design
 * dilution), ratios kept, bands / rounding / priorities as the prefill, guards,
 * manual-edit protection (basis columns), preview writes nothing, apply records
 * the basis, reset + prefill consistent, backfill of pre-existing rows, the EC
 * correspondence shown in the UI / advisor snapshot, and the route's roles.
 * In-memory DB only.
 */
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');

const src = (...p) => require(path.join(__dirname, '..', 'src', ...p));
const { db } = src('utils', 'database.js');
const S = src('services', 'elementTargetScaling.js');
const FC = src('services', 'FeedCalculator.js');
const { PROTOCOL } = src('services', 'cropProtocol.js');
const { backfillElementBasis, elementTargetsFromProtocol } = src('utils', 'cropNutritionSchema.js');
const { CropProfileService } = src('services', 'CropProfileService.js');
const { createNutritionRouter } = src('routes', 'nutrition.js');
const { NOW, seedFarm } = require('./fixtures/nutritionFarm');

const svc = new CropProfileService({ db, now: () => NOW });
const lib = (name) => db.prepare('SELECT composition FROM fertigation_ingredients WHERE name = ?').get(name) || null;
let farm;
let profileId;
const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

test('setup', () => {
  farm = seedFarm(db);
  profileId = svc.getActive().id;
});

// ---------- pure helper ----------

test('factor = (EC target − source water) ÷ protocol fertilizer EC; every element scaled, ratios kept', () => {
  const sp = S.protocolStagePpm(PROTOCOL.data, 'vegetative', lib);
  assert.ok(sp.fertilizer_ec_ms_cm > 1.3 && sp.fertilizer_ec_ms_cm < 1.6, `protocol EC ${sp.fertilizer_ec_ms_cm}`);
  assert.equal(sp.design_dilution, 150);
  const r = S.scaleElementTargets({ stagePpm: sp, ecTarget: 1.9, sourceWaterEc: null, current: [] });
  assert.equal(r.ok, true);
  const expected = 1.9 / sp.fertilizer_ec_ms_cm;
  assert.ok(close(r.factor, expected), `factor ${r.factor} vs ${expected}`);
  assert.equal(r.math.factor, Math.round(expected * 1e4) / 1e4);
  assert.equal(r.math.source_water_known, false);
  assert.equal(r.math.fertilizer_ec_target, 1.9);
  assert.equal(r.math.equivalent_dilution, Math.round(150 / expected));
  assert.equal(r.rows.length, 12, 'macros and micros');
  for (const x of r.rows) {
    assert.equal(x.action, 'insert');
    const dp = FC.MICROS.includes(x.element) ? 3 : 1;
    assert.equal(x.new.soft_target, Math.round(sp.ppm[x.element] * expected * 10 ** dp) / 10 ** dp, x.element);
    const band = FC.MICROS.includes(x.element) ? S.MICRO_BAND : S.MACRO_BAND;
    assert.ok(close(x.new.hard_min, Math.round(sp.ppm[x.element] * expected * band.lo * 10 ** dp) / 10 ** dp), `${x.element} min`);
    assert.ok(close(x.new.hard_max, Math.round(sp.ppm[x.element] * expected * band.hi * 10 ** dp) / 10 ** dp), `${x.element} max`);
    assert.ok(x.priority >= 2, `${x.element} never priority 1`);
  }
  const n = r.rows.find(x => x.element === 'N').new.soft_target;
  const k = r.rows.find(x => x.element === 'K').new.soft_target;
  assert.ok(Math.abs(n / k - sp.ppm.N / sp.ppm.K) < 0.002, 'N:K ratio of the protocol kept');
  // the scaled set corresponds to the EC target (cations linear in ppm)
  const scaled = Object.fromEntries(Object.entries(sp.ppm).map(([el, v]) => [el, v * expected]));
  assert.ok(Math.abs(FC.cationEc(scaled) - 1.9) < 1e-9);
});

test('source water EC is subtracted before scaling', () => {
  const sp = S.protocolStagePpm(PROTOCOL.data, 'vegetative', lib);
  const r = S.scaleElementTargets({ stagePpm: sp, ecTarget: 1.9, sourceWaterEc: 0.4, current: [] });
  assert.equal(r.ok, true);
  assert.ok(close(r.math.fertilizer_ec_target, 1.5));
  assert.ok(Math.abs(r.factor - 1.5 / sp.fertilizer_ec_ms_cm) < 1e-4);
  assert.equal(r.math.source_water_known, true);
  assert.match(r.rows[0].notes, /source water 0\.4/);
});

test('guards: no EC target, no recipe, source water ≥ target, factor out of 0.3-3 → not scaled, with the reason', () => {
  const sp = S.protocolStagePpm(PROTOCOL.data, 'vegetative', lib);
  const reason = (o) => S.scaleElementTargets({ stagePpm: sp, current: [], ...o });
  assert.equal(reason({ ecTarget: null }).reason, 'no_ec_target');
  assert.equal(reason({ ecTarget: '' }).reason, 'no_ec_target');
  assert.equal(S.scaleElementTargets({ stagePpm: null, ecTarget: 1.9 }).reason, 'no_protocol_recipe');
  assert.equal(reason({ ecTarget: 1.0, sourceWaterEc: 1.2 }).reason, 'source_water_exceeds_target');
  assert.equal(reason({ ecTarget: 1.0, sourceWaterEc: 1.0 }).reason, 'source_water_exceeds_target');
  const tooLow = reason({ ecTarget: 0.3 });
  assert.equal(tooLow.reason, 'factor_out_of_range');
  assert.ok(tooLow.math.factor < 0.3, 'the factor is still reported');
  assert.equal(reason({ ecTarget: 6 }).reason, 'factor_out_of_range');
  assert.deepEqual(reason({ ecTarget: 6 }).rows, []);
  assert.equal(S.scaleElementTargets({ stagePpm: { ...sp, fertilizer_ec_ms_cm: 0 }, ecTarget: 1.9 }).reason, 'protocol_ec_unknown');
  assert.equal(S.scaleElementTargets({ stagePpm: sp, ecTarget: sp.fertilizer_ec_ms_cm * 2.9 }).ok, true, '2.9 is inside the limits');
});

test('manual-edit detection: values vs basis; no basis = hand-written', () => {
  const base = { hard_min: 10, soft_target: 12, hard_max: 14, basis_hard_min: 10, basis_soft_target: 12, basis_hard_max: 14, basis_source: 'protocol' };
  assert.equal(S.isManuallyEdited(base), false);
  assert.equal(S.isManuallyEdited({ ...base, soft_target: 12.5 }), true);
  assert.equal(S.isManuallyEdited({ ...base, hard_max: null }), true);
  assert.equal(S.isManuallyEdited({ ...base, basis_source: null }), true);
  const sp = S.protocolStagePpm(PROTOCOL.data, 'vegetative', lib);
  const current = S.protocolElementRows(sp).map(r => ({ ...r, basis_hard_min: r.hard_min, basis_soft_target: r.soft_target, basis_hard_max: r.hard_max, basis_source: 'protocol' }));
  current.find(r => r.element === 'K').soft_target = 250; // hand edit
  const r = S.scaleElementTargets({ stagePpm: sp, ecTarget: 1.9, current });
  const k = r.rows.find(x => x.element === 'K');
  assert.equal(k.action, 'kept_manual');
  assert.equal(k.manual, true);
  assert.deepEqual(r.kept_manual, ['K']);
  assert.equal(r.rows.find(x => x.element === 'N').action, 'update');
  assert.equal(S.scaleElementTargets({ stagePpm: sp, ecTarget: 1.9, current, include: ['K'] }).rows.find(x => x.element === 'K').action, 'update');
  assert.equal(S.scaleElementTargets({ stagePpm: sp, ecTarget: 1.9, current, include: true }).kept_manual.length, 0);
  // at the protocol EC itself nothing changes
  const same = S.scaleElementTargets({ stagePpm: sp, ecTarget: sp.fertilizer_ec_ms_cm, current: S.protocolElementRows(sp).map(r2 => ({ ...r2, basis_hard_min: r2.hard_min, basis_soft_target: r2.soft_target, basis_hard_max: r2.hard_max, basis_source: 'protocol' })) });
  assert.ok(same.rows.every(x => x.action === 'unchanged'), same.rows.filter(x => x.action !== 'unchanged').map(x => x.element).join());
});

test('correspondence: the stored ppm → fertilizer EC (+ source water)', () => {
  const sp = S.protocolStagePpm(PROTOCOL.data, 'vegetative', lib);
  const rows = S.protocolElementRows(sp);
  const c = S.targetsCorrespondence({ rows, stagePpm: sp, sourceWaterEc: 0.3, ecTarget: 1.9 });
  assert.ok(Math.abs(c.fertilizer_ec_ms_cm - sp.fertilizer_ec_ms_cm) < 0.011, `${c.fertilizer_ec_ms_cm} vs ${sp.fertilizer_ec_ms_cm}`);
  assert.ok(close(c.total_ec_ms_cm, Math.round((c.fertilizer_ec_ms_cm + 0.3) * 100) / 100, 0.011));
  assert.equal(c.nh4_basis, 'protocol_share');
  assert.ok(Math.abs(c.factor_vs_protocol - 1) < 0.01);
  assert.equal(S.targetsCorrespondence({ rows: [] }), null);
});

// ---------- DB: prefill, preview, apply, reset, backfill ----------

test('prefill records the protocol basis on every seeded row', () => {
  const rows = db.prepare('SELECT * FROM crop_element_targets WHERE crop_assignment_id = ?').all(farm.cropId);
  assert.ok(rows.length >= 24);
  for (const r of rows) {
    assert.equal(r.basis_source, 'protocol');
    assert.equal(r.basis_factor, 1);
    assert.equal(r.basis_soft_target, r.soft_target);
  }
  const p = svc.getActive();
  assert.ok(p.element_targets.vegetative.every(r => r.manual === false));
  const c = p.element_targets_ec.vegetative;
  assert.ok(Math.abs(c.fertilizer_ec_ms_cm - p.protocol_ppm.by_stage.vegetative.ec_ms_cm) < 0.011);
  assert.equal(c.ec_target, 1.7, 'protocol vegetative EC target');
  assert.deepEqual(c.manual_elements, []);
});

test('service: preview writes nothing; apply writes, keeps hand edits, records the basis', () => {
  svc.setTargets(profileId, { stage_targets: [{ stage: 'vegetative', ec_min: 1.8, ec_target: 1.9, ec_max: 2.0 }] }, { userId: 1 });
  // the operator hand-edits Ca
  const ca = svc.getActive().element_targets.vegetative.find(e => e.element === 'Ca');
  svc.setTargets(profileId, { element_targets: [{ stage: 'vegetative', element: 'Ca', hard_min: ca.hard_min, soft_target: 140, hard_max: ca.hard_max }] });
  const before = JSON.stringify(db.prepare('SELECT * FROM crop_element_targets ORDER BY id').all());
  const pv = svc.scaleTargetsToEc(profileId, { stage: 'vegetative' });
  assert.equal(pv.ok, true);
  assert.equal(pv.applied, false);
  assert.deepEqual(pv.kept_manual, ['Ca']);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM crop_element_targets ORDER BY id').all()), before, 'preview writes nothing');
  const nOld = pv.rows.find(x => x.element === 'N');
  assert.ok(nOld.new.soft_target > nOld.old.soft_target);

  const ap = svc.scaleTargetsToEc(profileId, { stage: 'vegetative', preview: false }, { userId: 1 });
  assert.equal(ap.applied, true);
  assert.equal(ap.written, 11);
  const rows = ap.profile.element_targets.vegetative;
  const n = rows.find(e => e.element === 'N');
  assert.equal(n.soft_target, nOld.new.soft_target);
  assert.equal(n.basis_source, 'scaled');
  assert.equal(n.basis_ec, 1.9);
  assert.equal(n.basis_factor, pv.factor);
  assert.equal(n.manual, false);
  assert.match(n.notes, /^Scaled: .*×/);
  assert.equal(rows.find(e => e.element === 'Ca').soft_target, 140, 'hand edit kept');
  assert.equal(rows.find(e => e.element === 'Ca').manual, true);
  assert.ok(ap.profile.element_targets_ec.vegetative.factor_vs_protocol < pv.factor - 0.02, 'the kept hand-edited Ca shows as a lower EC correspondence');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM crop_element_targets WHERE crop_assignment_id = ? AND priority = 1').get(farm.cropId).n, 0);
  // other stages untouched
  assert.ok(ap.profile.element_targets.fruiting.every(e => e.basis_source === 'protocol'));

  // including Ca explicitly overwrites it
  const inc = svc.scaleTargetsToEc(profileId, { stage: 'vegetative', preview: false, include: ['Ca'] });
  assert.equal(inc.written, 1);
  assert.equal(inc.profile.element_targets.vegetative.find(e => e.element === 'Ca').manual, false);
  assert.ok(Math.abs(inc.profile.element_targets_ec.vegetative.factor_vs_protocol - pv.factor) < 0.01, 'now the ppm correspond to EC 1.9');
  assert.ok(Math.abs(inc.profile.element_targets_ec.vegetative.fertilizer_ec_ms_cm - 1.9) < 0.02);
  // a second EC change follows from the scaled basis (not "hand-edited")
  svc.setTargets(profileId, { stage_targets: [{ stage: 'vegetative', ec_min: 1.9, ec_target: 2.0, ec_max: 2.1 }] });
  const again = svc.scaleTargetsToEc(profileId, { stage: 'vegetative' });
  assert.deepEqual(again.kept_manual, []);
  assert.ok(again.rows.every(x => x.action === 'update'));
});

test('service: guards surface as reasons (preview) and 409 (apply)', () => {
  // fruiting: the protocol gives EC min/max but no target
  const pv = svc.scaleTargetsToEc(profileId, { stage: 'fruiting' });
  assert.equal(pv.ok, false);
  assert.equal(pv.reason, 'no_ec_target');
  assert.throws(() => svc.scaleTargetsToEc(profileId, { stage: 'fruiting', preview: false }), (e) => e.status === 409 && e.code === 'SCALE_NOT_POSSIBLE' && e.reason === 'no_ec_target');
  assert.throws(() => svc.scaleTargetsToEc(profileId, { stage: 'bogus' }), (e) => e.status === 400);
  assert.throws(() => svc.scaleTargetsToEc(profileId, { stage: 'vegetative', include: ['Xx'] }), (e) => e.status === 400);
  assert.throws(() => svc.scaleTargetsToEc(99999, { stage: 'vegetative' }), (e) => e.status === 404);
  svc.update(profileId, { source_water_ec: 5 });
  assert.equal(svc.scaleTargetsToEc(profileId, { stage: 'vegetative' }).reason, 'source_water_exceeds_target');
  svc.update(profileId, { source_water_ec: null });
});

test('reset = protocol at the design dilution, basis back to protocol; prefill and reset agree', () => {
  const p = svc.resetTargetsToProtocol(profileId);
  const expected = elementTargetsFromProtocol(db, PROTOCOL.data, 'vegetative');
  for (const e of expected) {
    const r = p.element_targets.vegetative.find(x => x.element === e.element);
    assert.equal(r.soft_target, e.soft_target, e.element);
    assert.equal(r.basis_source, 'protocol');
    assert.equal(r.manual, false);
  }
  assert.equal(p.stage_targets.vegetative.ec_target, 1.7);
});

test('backfill: rows written before the basis columns get the protocol basis once; changed ones read as hand-edited', () => {
  db.prepare("UPDATE crop_element_targets SET basis_hard_min = NULL, basis_soft_target = NULL, basis_hard_max = NULL, basis_source = NULL, basis_factor = NULL WHERE crop_assignment_id = ?").run(farm.cropId);
  db.prepare("UPDATE crop_element_targets SET soft_target = soft_target + 5 WHERE crop_assignment_id = ? AND growth_stage = 'vegetative' AND element = 'K'").run(farm.cropId);
  const n = backfillElementBasis(db);
  assert.ok(n >= 24, `backfilled ${n}`);
  assert.equal(backfillElementBasis(db), 0, 'idempotent');
  const p = svc.getActive();
  assert.equal(p.element_targets.vegetative.find(e => e.element === 'K').manual, true);
  assert.equal(p.element_targets.vegetative.find(e => e.element === 'N').manual, false);
  assert.deepEqual(p.element_targets_ec.vegetative.manual_elements, ['K']);
});

// ---------- route ----------

test('route: POST /profiles/:id/targets/scale-to-ec — roles, preview default, apply, 409 reason', async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { const role = req.headers['x-role']; if (role) req.user = { id: 5, role }; next(); });
  app.use('/api/nutrition', createNutritionRouter({ db, profiles: svc }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/nutrition/profiles/${profileId}/targets/scale-to-ec`;
  const call = async (role, body) => {
    const res = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', ...(role ? { 'x-role': role } : {}) }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    svc.setTargets(profileId, { stage_targets: [{ stage: 'vegetative', ec_target: 1.9 }] });
    assert.equal((await call('viewer', { stage: 'vegetative' })).status, 403);
    const pv = await call('operator', { stage: 'vegetative' });
    assert.equal(pv.status, 200);
    assert.equal(pv.body.applied, false, 'preview is the default');
    assert.deepEqual(pv.body.kept_manual, ['K']);
    const ap = await call('admin', { stage: 'vegetative', preview: false, include: ['K'] });
    assert.equal(ap.status, 200);
    assert.equal(ap.body.applied, true);
    assert.equal(ap.body.written, 12);
    const bad = await call('operator', { stage: 'fruiting', preview: false });
    assert.equal(bad.status, 409);
    assert.equal(bad.body.reason, 'no_ec_target');
    assert.equal((await call('operator', { stage: 'vegetative', include: 'K' })).status, 400);
  } finally {
    await new Promise(r => server.close(r));
  }
});
