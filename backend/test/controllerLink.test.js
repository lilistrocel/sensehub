/**
 * "Follow crop targets" (operator decision 2026-09-30): crop stage targets -> dose
 * controller through approved proposals.
 *  - pH / ratio derivation, bounds, blocked without source water EC
 *  - proposal lifecycle + roles (viewer cannot approve), alerts, dedupe, stale approval
 *  - apply at the NEXT cycle start only; a mid-run save never alters a running cycle
 *  - EC fine-tuning stays disabled (separate, verified control); trim re-bases on a base change
 *  - element best fit (advisory) solver sanity
 * In-memory DB, stubbed alerts / Telegram, no Modbus, no coil writes.
 */
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');

const src = (...p) => require(path.join(__dirname, '..', 'src', ...p));
const { db } = src('utils', 'database.js');
const { seedFarm, NOW } = require('./fixtures/nutritionFarm');
const { CropProfileService } = src('services', 'CropProfileService.js');
const { ControllerLinkService } = src('services', 'ControllerLinkService.js');
const { DoseController, computeEcTrim, crossCheck, mergeConfig, DEFAULT_CONFIG, CONFIG_KEY } = src('services', 'DoseController.js');
const L = src('services', 'controllerLinkMath.js');
const S = src('services', 'elementTargetScaling.js');
const { createNutritionRouter } = src('routes', 'nutrition.js');
const { languageMiddleware } = src('middleware', 'language.js');

const quiet = { log() {}, warn() {}, error() {} };
let clock = NOW;
const alerts = [];
const updates = [];
const notes = [];
const profiles = new CropProfileService({ db, now: () => clock });
const ctl = new DoseController({ db, autoTick: false, logger: quiet, now: () => clock, beforeCycle: (c) => link.applyApprovedForCycle(c) });
const link = new ControllerLinkService({
  db, now: () => clock, doseController: ctl, profiles, log: quiet,
  createAlert: (o) => { alerts.push(o); return { id: alerts.length }; },
  updateOpenAlert: (fp, ch) => { updates.push({ fp, ...ch }); return null; },
  notify: (title, body, severity) => notes.push({ title, body, severity }),
});

const storedConfig = () => db.prepare('SELECT value FROM system_settings WHERE key = ?').get(CONFIG_KEY).value;
const LIVE_TARGETS = { stage: 'vegetative', ec_min: 1.8, ec_target: 1.9, ec_max: 2.0, ph_min: 5.8, ph_max: 6.2, drain_pct_min: 20, drain_pct_target: 25, drain_pct_max: 30, drain_ec_delta_max: 0.6, drain_ph_min: 5.8, drain_ph_max: 6.5, ml_target: 930 };

let server; let base; let PID;
test.before(async () => {
  seedFarm(db);
  PID = profiles.activeRow().id;
  // the live 2026-09-30 state: operator vegetative targets, no source water EC
  profiles.setTargets(PID, { stage_targets: [LIVE_TARGETS] });
  const app = express();
  app.use(express.json());
  app.use('/api', languageMiddleware);
  app.use((req, res, next) => { const role = req.headers['x-role']; if (role) req.user = { id: role === 'admin' ? 1 : 7, email: `${role}@farm.test`, role }; next(); });
  app.use('/api/nutrition', createNutritionRouter({ db, profiles, link, now: () => clock }));
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/nutrition`;
});
test.after(() => new Promise(r => server.close(r)));

const call = async (method, p, role, body) => {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(role ? { 'x-role': role } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch (_) { json = null; }
  return { status: res.status, body: json };
};

function stagePpm() {
  const p = profiles.getProfile(PID);
  return S.protocolStagePpm(p.protocol.data, 'vegetative', profiles._library());
}
const cfg0 = () => mergeConfig(DEFAULT_CONFIG, { nutrients: { ratio: { 1: 200, 2: 200, 3: 200, 4: 200 } } });

// ─── derivation ─────────────────────────────────────────────────────────────

test('pH: midpoint of the stage range (5.80-6.20 -> 6.00), floor = max(5.0, min - 0.2), cross-checked', () => {
  const r = L.proposePh({ stageTarget: LIVE_TARGETS, cfg: cfg0(), crossCheck, mergeConfig });
  assert.equal(r.ok, true);
  assert.equal(r.setpoint, 6);
  assert.equal(r.floor_ph, 5.6);
  assert.equal(r.math.basis, 'midpoint');
  // an explicit pH target wins over the midpoint
  assert.equal(L.proposePh({ stageTarget: { ...LIVE_TARGETS, ph_target: 5.9 }, cfg: cfg0(), crossCheck, mergeConfig }).setpoint, 5.9);
  // floor never below 5.0
  assert.equal(L.proposePh({ stageTarget: { ph_min: 5.1, ph_max: 5.9 }, cfg: cfg0(), crossCheck, mergeConfig }).floor_ph, 5);
  // a floor that would fail the cross-checks keeps the current floor; if that fails too -> blocked
  const tight = L.proposePh({ stageTarget: { ph_min: 5.0, ph_max: 5.2 }, cfg: cfg0(), crossCheck, mergeConfig });
  assert.equal(tight.ok, false);
  assert.equal(tight.reason, 'cross_check');
  assert.equal(L.proposePh({ stageTarget: { ph_min: null, ph_max: null }, cfg: cfg0(), crossCheck, mergeConfig }).reason, 'no_ph_target');
});

test('EC: uniform base ratio from the element-target helper; 0.25 water -> ~1:132; blocked without source water EC; bounds', () => {
  const sp = stagePpm();
  assert.ok(Math.abs(sp.fertilizer_ec_ms_cm - 1.449) < 0.001, `protocol EC ${sp.fertilizer_ec_ms_cm}`);
  const ids = [1, 2, 3, 4];
  const noWater = L.proposeEc({ stageTarget: LIVE_TARGETS, sourceWaterEc: null, stagePpm: sp, cfg: cfg0(), tankIds: ids });
  assert.equal(noWater.ok, false);
  assert.equal(noWater.reason, 'source_water_missing');
  assert.equal(noWater.math.equivalent_dilution, 114); // what it WOULD be with water = 0 (not proposed)
  const w = L.proposeEc({ stageTarget: LIVE_TARGETS, sourceWaterEc: 0.25, stagePpm: sp, cfg: cfg0(), tankIds: ids });
  assert.equal(w.ok, true);
  assert.equal(w.ratio, 132);
  assert.equal(w.target_us, 1900);
  assert.equal(w.water_us, 250);
  // the same factor as the element-target scaling (ebf8d4a) -> both agree
  assert.equal(S.scaleFactor({ ecTarget: 1.9, sourceWaterEc: 0.25, stagePpm: sp }).math.equivalent_dilution, w.ratio);
  // richer than 1:100 -> not proposed, reason given
  const hot = L.proposeEc({ stageTarget: { ec_target: 3.2 }, sourceWaterEc: 0.25, stagePpm: sp, cfg: cfg0(), tankIds: ids });
  assert.equal(hot.ok, false);
  assert.equal(hot.reason, 'ratio_out_of_bounds');
  assert.ok(hot.ratio < 100);
  // weaker than 1:250 -> not proposed
  assert.equal(L.proposeEc({ stageTarget: { ec_target: 1.0 }, sourceWaterEc: 0.25, stagePpm: sp, cfg: cfg0(), tankIds: ids }).reason, 'ratio_out_of_bounds');
  // ec_check bounds narrow the hard bounds
  assert.deepEqual(L.ratioBounds(mergeConfig(cfg0(), { ec_check: { min_ratio: 120, max_ratio: 240 } })).min, 120);
  assert.equal(L.proposeEc({ stageTarget: LIVE_TARGETS, sourceWaterEc: 0.25, stagePpm: sp, cfg: mergeConfig(cfg0(), { ec_check: { min_ratio: 140 } }), tankIds: ids }).reason, 'ratio_out_of_bounds');
  // water at / above the target
  assert.equal(L.proposeEc({ stageTarget: LIVE_TARGETS, sourceWaterEc: 2.0, stagePpm: sp, cfg: cfg0(), tankIds: ids }).reason, 'source_water_exceeds_target');
});

test('proposal without source water EC: pH part proposed, EC part blocked (the live vegetative case)', () => {
  const c = link.compute(PID);
  assert.deepEqual(c.proposal.update, { ph: { setpoint: 6, floor_ph: 5.6 } });
  assert.deepEqual(c.proposal.blocked.map(b => [b.part, b.reason]), [['ec', 'source_water_missing']]);
  const v = link.view(PID);
  assert.equal(v.mode, 'manual');
  assert.equal(v.source_water.discrepancy, 'profile_missing');
  assert.equal(v.source_water.trim_water_us, 250);
  assert.equal(v.source_water.trim_water_origin, 'default'); // SenseHub code default, never measured
  assert.equal(v.controller.provenance['nutrients.ratio.1'].origin, 'operator_unrecorded');
  assert.equal(v.controller.provenance['ph.setpoint'].origin, 'default');
});

// ─── governance ─────────────────────────────────────────────────────────────

test('manual mode (default): target edits never create proposals and never touch the controller', async () => {
  const before = storedConfig();
  const r = await call('PUT', `/profiles/${PID}/targets`, 'operator', { stage_targets: [{ ...LIVE_TARGETS, ph_min: 5.7 }] });
  assert.equal(r.status, 200);
  await call('PUT', `/profiles/${PID}/targets`, 'operator', { stage_targets: [LIVE_TARGETS] });
  assert.equal(link.tick().length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM controller_link_proposals').get().n, 0);
  assert.equal(storedConfig(), before);
  assert.equal(alerts.length, 0);
});

test('roles: viewer reads the link but cannot link, approve, reject or enable EC fine-tuning', async () => {
  const v = await call('GET', '/controller-link', 'viewer');
  assert.equal(v.status, 200);
  assert.equal(v.body.view.profile.id, PID);
  assert.equal((await call('PUT', `/profiles/${PID}/controller-link`, 'viewer', { mode: 'follow_crop_targets' })).status, 403);
  assert.equal((await call('POST', '/controller-link/proposals/1/approve', 'viewer', {})).status, 403);
  assert.equal((await call('POST', '/controller-link/proposals/1/reject', 'viewer', {})).status, 403);
  assert.equal((await call('POST', `/profiles/${PID}/controller-link/ec-trim`, 'viewer', { enable: true, confirm: true })).status, 403);
  assert.equal((await call('PUT', `/profiles/${PID}/controller-link`, 'operator', { mode: 'bogus' })).status, 400);
});

let firstId;
test('linking creates ONE pending proposal + an info alert with a stable fingerprint; the controller is unchanged', async () => {
  const before = storedConfig();
  const r = await call('PUT', `/profiles/${PID}/controller-link`, 'operator', { mode: 'follow_crop_targets' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mode, 'follow_crop_targets');
  const p = r.body.proposal;
  firstId = p.id;
  assert.equal(p.status, 'pending');
  assert.equal(p.trigger, 'link_enabled');
  assert.deepEqual(p.diff.map(d => [d.field, d.current, d.proposed]), [['ph.setpoint', 5.65, 6], ['ph.floor_ph', 5.3, 5.6]]);
  assert.equal(p.blocked[0].reason, 'source_water_missing');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'info');
  assert.equal(alerts[0].fingerprint, `crop_link_proposal:${PID}`);
  assert.equal(alerts[0].messageKey, 'crop_link.alert.pending');
  assert.equal(notes.length, 1);
  // the controller keeps its values until approval
  assert.equal(storedConfig(), before);
  // re-evaluation (tick / same write) does not duplicate it
  assert.equal(link.tick().length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM controller_link_proposals WHERE status = 'pending'").get().n, 1);
});

test('source water entered -> new proposal supersedes the pending one, EC part now included (1:132)', async () => {
  const r = await call('PUT', `/profiles/${PID}`, 'operator', { source_water_ec: 0.25 });
  assert.equal(r.status, 200);
  const v = link.view(PID);
  assert.equal(v.pending.trigger, 'source_water_changed');
  assert.notEqual(v.pending.id, firstId);
  assert.equal(link.getProposal(firstId).status, 'superseded');
  assert.deepEqual(v.pending.update.nutrients.ratio, { 1: 132, 2: 132, 3: 132, 4: 132 });
  assert.deepEqual(v.pending.update.nutrients.ec_trim, { target_us: 1900 });
  assert.equal(v.pending.update.nutrients.ec_trim.enabled, undefined); // never proposed
  assert.equal(v.pending.update.ec_check.raw_water_ec_us, 250);
  assert.equal(v.source_water.discrepancy, 'ok'); // profile 0.25 = the 250 µS/cm the trim assumed
  assert.equal(v.source_water.raw_water_ec_us, null); // not propagated until approved
  assert.ok(v.crop.stock_ec_at_ratio && v.crop.stock_ec_at_ratio.ratio === 132);
});

test('rejection is audited and not re-raised; approval of a stale proposal is refused', async () => {
  const pend = link.view(PID).pending;
  const rej = await call('POST', `/controller-link/proposals/${pend.id}/reject`, 'operator', { note: 'wait for the handheld EC' });
  assert.equal(rej.status, 200);
  assert.equal(rej.body.proposal.status, 'rejected');
  assert.equal(rej.body.proposal.decided_by_email, 'operator@farm.test');
  assert.equal(rej.body.proposal.decided_role, 'operator');
  assert.equal(rej.body.proposal.decision_note, 'wait for the handheld EC');
  assert.equal(link.tick().length, 0); // identical proposal is not raised again
  assert.equal((await call('POST', `/controller-link/proposals/${pend.id}/approve`, 'admin', {})).status, 409);
  // targets change -> a new one
  await call('PUT', `/profiles/${PID}/targets`, 'operator', { stage_targets: [{ ...LIVE_TARGETS, ph_min: 5.7, ph_max: 6.1 }] });
  const p2 = link.view(PID).pending;
  assert.equal(p2.trigger, 'targets_changed');
  assert.equal(p2.update.ph.setpoint, 5.9);
  // targets change again before approval -> approving p2 is stale
  await call('PUT', `/profiles/${PID}/targets`, 'operator', { stage_targets: [LIVE_TARGETS] });
  const stale = await call('POST', `/controller-link/proposals/${p2.id}/approve`, 'admin', {});
  assert.equal(stale.status, 409);
  assert.ok(['PROPOSAL_STALE', 'PROPOSAL_NOT_OPEN'].includes(stale.body.code), JSON.stringify(stale.body));
});

function tanksCtx() {
  return db.prepare("SELECT id AS tank_id, name AS tank_name, equipment_id, channel FROM fertigation_tanks WHERE role = 'nutrient' ORDER BY id").all().map(t => ({ ...t, duty_pct: 100 }));
}
const ctx = (n) => ({ cycleLogId: n, programId: null, automationId: null, durationSeconds: 600, tanks: tanksCtx(), write: async () => ({}), abort: () => {} });

test('approval applies at the START of the next dose cycle, never mid-cycle; the run records version + proposal', async () => {
  const pend = link.view(PID).pending;
  const beforeCfg = storedConfig();
  // a cycle is RUNNING when the operator approves
  const r1 = ctl.beginCycle(ctx(101));
  assert.ok(r1.runId);
  const setpointRunning = ctl.getStatus(clock).ph.setpoint;
  assert.equal(setpointRunning, 5.65);
  const ok = await call('POST', `/controller-link/proposals/${pend.id}/approve`, 'admin', { note: 'agreed with agronomist' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.proposal.status, 'approved');
  assert.equal(ok.body.proposal.decided_by_email, 'admin@farm.test');
  // approved != applied: config untouched, running cycle untouched
  assert.equal(storedConfig(), beforeCfg);
  ctl.step(clock + 1000);
  assert.equal(ctl.getStatus(clock + 1000).ph.setpoint, 5.65);
  await ctl.endCycle({ status: 'completed' });
  assert.equal(storedConfig(), beforeCfg); // ending a cycle applies nothing either
  assert.equal(link.getProposal(pend.id).status, 'approved');

  // NEXT cycle start: applied before the cycle reads its config
  clock += 3600000;
  const r2 = ctl.beginCycle(ctx(102));
  const applied = link.getProposal(pend.id);
  assert.equal(applied.status, 'applied');
  assert.ok(applied.applied_config_version_id);
  assert.equal(applied.applied_run_id, r2.runId);
  const cfg = JSON.parse(storedConfig());
  assert.equal(cfg.ph.setpoint, 6);
  assert.equal(cfg.ph.floor_ph, 5.6);
  assert.deepEqual(cfg.nutrients.ratio, { 1: 132, 2: 132, 3: 132, 4: 132 });
  assert.equal(cfg.nutrients.ec_trim.target_us, 1900);
  assert.equal(cfg.nutrients.ec_trim.water_us, 250);
  assert.equal(cfg.nutrients.ec_trim.enabled, false); // EC fine-tuning stays OFF
  assert.equal(cfg.ec_check.raw_water_ec_us, 250);
  const st = ctl.getStatus(clock);
  assert.equal(st.ph.setpoint, 6);
  assert.ok(st.tanks.every(t => t.ratio_target === 132), JSON.stringify(st.tanks.map(t => t.ratio_target)));
  assert.equal(st.link_proposal_id, pend.id);
  assert.equal(st.config_version_id, applied.applied_config_version_id);
  await ctl.endCycle({ status: 'completed' });
  const run = ctl.getRun(r2.runId);
  assert.equal(run.link_proposal_id, pend.id);
  assert.equal(run.config_version_id, applied.applied_config_version_id);
  // provenance: calculated from crop targets
  const v = link.view(PID);
  assert.equal(v.controller.provenance['ph.setpoint'].origin, 'crop_link');
  assert.equal(v.controller.provenance['ph.setpoint'].proposal_id, pend.id);
  assert.equal(v.controller.provenance['nutrients.ratio.3'].origin, 'crop_link');
  assert.ok(v.comparison.every(x => x.match === true), JSON.stringify(v.comparison));
  assert.equal(v.source_water.discrepancy, 'ok');
  assert.equal(v.pending, null);
  assert.ok(updates.some(u => u.messageKey === 'crop_link.alert.applied'));
});

test('a mid-run operator save cannot alter the running cycle (pH targets frozen, ratios fixed); it applies next cycle', async () => {
  const r = ctl.beginCycle(ctx(103));
  assert.equal(ctl.getStatus(clock).ph.setpoint, 6);
  ctl.saveConfig({ ph: { setpoint: 5.9, floor_ph: 5.5 }, nutrients: { ratio: { 1: 150, 2: 150, 3: 150, 4: 150 } } }, { source: 'operator', user: { id: 1, email: 'admin@farm.test' } });
  clock += 20000; // past the 10 s config cache
  ctl.step(clock);
  const view = ctl._cycleConfig(ctl.cycle);
  assert.equal(view.ph.setpoint, 6);
  assert.equal(view.ph.floor_ph, 5.6);
  const st = ctl.getStatus(clock);
  assert.equal(st.ph.setpoint, 6);
  assert.ok(st.tanks.every(t => t.ratio_target === 132));
  await ctl.endCycle({ status: 'completed' });
  assert.ok(ctl.getRun(r.runId));
  const r2 = ctl.beginCycle(ctx(104));
  assert.equal(ctl.getStatus(clock).ph.setpoint, 5.9);
  assert.ok(ctl.getStatus(clock).tanks.every(t => t.ratio_target === 150));
  await ctl.endCycle({ status: 'completed' });
  // the operator's edit is recorded as such; the run no longer claims the crop-target proposal for those fields
  const prov = ctl.getFieldProvenance();
  assert.equal(prov['ph.setpoint'].kind, 'operator');
  assert.equal(prov['nutrients.ratio.1'].kind, 'operator');
  assert.ok(ctl.getRun(r2.runId).config_version_id > 0);
  // linked: the drift back from the crop targets raises a new proposal (controller_changed)
  const p = link.evaluate(PID);
  assert.equal(p.trigger, 'controller_changed');
});

test('a proposal that no longer fits at cycle start fails closed (config untouched, warning alert)', async () => {
  const p = link.view(PID).pending;
  const ok = await call('POST', `/controller-link/proposals/${p.id}/approve`, 'operator', {});
  assert.equal(ok.status, 200);
  // someone narrows the pH plausibility so the approved setpoint fails the cross-checks
  ctl.saveConfig({ ph: { plausible_max: 7 } }, { source: 'operator' });
  db.prepare('UPDATE controller_link_proposals SET update_json = ? WHERE id = ?').run(JSON.stringify({ ph: { setpoint: 7.2 } }), p.id);
  const before = storedConfig();
  const r = ctl.beginCycle(ctx(105));
  assert.equal(storedConfig(), before);
  assert.equal(link.getProposal(p.id).status, 'failed');
  assert.ok(alerts.some(a => a.fingerprint === `crop_link_apply_failed:${PID}` && a.severity === 'warning'));
  await ctl.endCycle({ status: 'completed' });
  assert.ok(r.runId);
});

test('EC fine-tuning: never proposed; enabling needs link + EC in sync + a SEKO vs handheld check within 10 %', async () => {
  // re-sync the controller with the crop targets
  const p = link.evaluate(PID) || link.view(PID).pending;
  assert.ok(p, 'expected a pending proposal');
  await call('POST', `/controller-link/proposals/${p.id}/approve`, 'operator', {});
  ctl.beginCycle(ctx(106));
  await ctl.endCycle({ status: 'completed' });
  assert.equal(JSON.parse(storedConfig()).nutrients.ec_trim.enabled, false);
  const path_ = `/profiles/${PID}/controller-link/ec-trim`;
  assert.equal((await call('POST', path_, 'operator', { enable: true })).body.code, 'NOT_CONFIRMED');
  assert.equal((await call('POST', path_, 'operator', { enable: true, confirm: true })).status, 400);
  const bad = await call('POST', path_, 'operator', { enable: true, confirm: true, handheld_ec_ms: 1.9, seko_ec_ms: 2.9, measured_at: new Date(clock).toISOString() });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.code, 'SEKO_DISAGREES');
  assert.equal(JSON.parse(storedConfig()).nutrients.ec_trim.enabled, false);
  const good = await call('POST', path_, 'operator', { enable: true, confirm: true, handheld_ec_ms: 1.9, seko_ec_ms: 1.95, measured_at: new Date(clock - 600000).toISOString(), note: 'Hanna HI98331' });
  assert.equal(good.status, 200, JSON.stringify(good.body));
  assert.equal(JSON.parse(storedConfig()).nutrients.ec_trim.enabled, true);
  const checks = good.body.view.ec_trim.checks;
  assert.equal(checks[0].action, 'enable');
  assert.equal(checks[0].user_email, 'operator@farm.test');
  assert.equal(checks[0].handheld_ec_ms, 1.9);
  assert.equal(checks[1].action, 'refused');
  assert.equal(good.body.view.controller.provenance['nutrients.ec_trim.enabled'].origin, 'ec_trim_check');
  // disabling is always allowed
  const off = await call('POST', path_, 'viewer', { enable: false, confirm: true });
  assert.equal(off.status, 403);
  const off2 = await call('POST', path_, 'operator', { enable: false, confirm: true });
  assert.equal(off2.status, 200);
  assert.equal(JSON.parse(storedConfig()).nutrients.ec_trim.enabled, false);
});

test('stage transition (transplant date) on a linked profile -> stage_changed proposal via the 60 s tick', () => {
  // flowering from day 25: EC 2.2 target in the fixture? set the operator flowering targets
  profiles.setTargets(PID, { stage_targets: [{ stage: 'flowering', ec_min: 2.0, ec_target: 2.2, ec_max: 2.4, ph_min: 5.8, ph_max: 6.2 }] });
  link.evaluate(PID); // vegetative unchanged -> nothing
  clock = Date.parse('2026-10-03T06:00:00Z'); // day 26
  const made = link.tick();
  assert.equal(made.length, 1);
  assert.equal(made[0].trigger, 'stage_changed');
  assert.equal(made[0].stage, 'flowering');
  // 2.2 with 0.25 water: factor 1.3457 -> 1:111
  assert.equal(made[0].update.nutrients.ratio[1], 111);
});

test('switching back to manual cancels open proposals and leaves the controller alone', async () => {
  const before = storedConfig();
  const r = await call('PUT', `/profiles/${PID}/controller-link`, 'admin', { mode: 'manual' });
  assert.equal(r.status, 200);
  assert.equal(r.body.view.mode, 'manual');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM controller_link_proposals WHERE status IN ('pending', 'approved')").get().n, 0);
  assert.equal(storedConfig(), before);
  assert.equal(link.tick().length, 0);
  const hist = await call('GET', `/profiles/${PID}/controller-link/proposals?limit=3`, 'viewer');
  assert.equal(hist.status, 200);
  assert.equal(hist.body.items.length, 3);
  assert.ok(hist.body.total >= 6);
});

test('default DoseController hook: no approved proposal -> config and run untouched', async () => {
  const plain = new DoseController({ db, autoTick: false, logger: quiet, now: () => clock });
  const before = storedConfig();
  const r = plain.beginCycle(ctx(107));
  assert.equal(storedConfig(), before);
  await plain.endCycle({ status: 'completed' });
  assert.ok(plain.getRun(r.runId).config_version_id > 0);
});

// ─── EC trim base change ────────────────────────────────────────────────────

test('EC trim restarts from the new base ratio when the base changed; unchanged base keeps stepping', () => {
  const trim = { ...DEFAULT_CONFIG.nutrients.ec_trim, enabled: true, target_us: 1900, water_us: 250 };
  const prev = { id: 3, ec_avg: 2200, ec_samples: 40, tanks: [1, 2].map(id => ({ tank_id: id, ratio_target: 160 })), base_ratios: { 1: 150, 2: 150 } };
  const same = computeEcTrim(prev, { 1: 150, 2: 150 }, trim);
  assert.equal(same.applied, true);
  assert.ok(same.ratios[1] > 160); // steps from the previous trimmed ratio
  const moved = computeEcTrim(prev, { 1: 132, 2: 132 }, trim);
  assert.deepEqual(moved.rebased, [1, 2]);
  assert.ok(Math.abs(moved.ratios[1] - Math.round(132 * moved.factor * 10) / 10) < 1e-9, JSON.stringify(moved));
  assert.deepEqual(moved.base_ratios, { 1: 132, 2: 132 });
  // runs recorded before base_ratios existed: previous behaviour
  const legacy = computeEcTrim({ ...prev, base_ratios: null }, { 1: 132, 2: 132 }, trim);
  assert.equal(legacy.rebased, undefined);
  assert.ok(legacy.ratios[1] > 160);
});

// ─── best fit (advisory) ────────────────────────────────────────────────────

test('bounded least squares: exact interior solution, bound-constrained solution', () => {
  // two tanks, two elements, exact solution x = (1/150, 1/200)
  const A = [[1000, 0], [0, 1000]];
  const b = [1000 / 150, 1000 / 200];
  const s = L.boundedLeastSquares(A, b, [1 / 250, 1 / 250], [1 / 100, 1 / 100]);
  assert.ok(Math.abs(s.x[0] - 1 / 150) < 1e-12 && Math.abs(s.x[1] - 1 / 200) < 1e-12);
  // wanting 1:80 on tank 1 -> clamps at the 1:100 bound
  const c = L.boundedLeastSquares([[1000, 0], [0, 1000]], [1000 / 80, 1000 / 200], [1 / 250, 1 / 250], [1 / 100, 1 / 100]);
  assert.ok(Math.abs(c.x[0] - 1 / 100) < 1e-12);
});

test('best fit with the current stock: ratios in bounds, weighted by priority, unreachable elements flagged', () => {
  const FC = src('services', 'FeedCalculator.js');
  const tanks = FC.loadCurrentTanks(db).filter(t => t.role === 'nutrient').map(t => ({ tank_id: t.tank_id, letter: t.letter, stock: FC.tankStock(t).mg }));
  const targets = [
    { element: 'N', soft_target: 154.3, hard_min: 131.2, hard_max: 177.4, priority: 2 },
    { element: 'K', soft_target: 213, hard_min: 181, hard_max: 244.9, priority: 2 },
    { element: 'Ca', soft_target: 126.7, hard_min: 107.7, hard_max: 145.7, priority: 2 },
    { element: 'Mg', soft_target: 26.1, hard_min: 22.2, hard_max: 30.1, priority: 3 },
    { element: 'Mo', soft_target: 0.05, hard_min: 0.035, hard_max: 0.075, priority: 5 }, // far more than the stock can give
  ];
  const r = L.bestFit({ tanks, targets, bounds: { min: 100, max: 250 }, currentRatios: { 1: 200, 2: 200, 3: 200, 4: 200 } });
  assert.equal(r.ok, true);
  for (const v of Object.values(r.ratios)) assert.ok(v >= 100 && v <= 250, JSON.stringify(r.ratios));
  const by = Object.fromEntries(r.elements.map(e => [e.element, e]));
  assert.equal(by.N.status, 'ok');
  assert.equal(by.Ca.status, 'ok');
  assert.equal(by.K.status, 'ok');
  assert.equal(by.Mo.unreachable, true);
  assert.equal(by.Mo.reason, 'too_low_even_richest');
  assert.deepEqual(r.unreachable, ['Mo']);
  // the view carries it, clearly advisory
  const v = link.view(PID);
  assert.equal(v.best_fit.advisory, true);
  assert.equal(v.best_fit.ok, true);
});
