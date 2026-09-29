/**
 * Crop & Nutrition API: roles (viewing for every logged-in role; editing the
 * profile / targets and running the advisor for admin + operator; advisor
 * settings admin only), validation, calculator + system endpoints, localized
 * advice. Stubbed Anthropic client, in-memory DB, loopback HTTP only.
 */
process.env.DB_PATH = ':memory:';
process.env.ANTHROPIC_API_KEY = 'test-key-not-used';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');

const src = (...p) => require(path.join(__dirname, '..', 'src', ...p));
const { db } = src('utils', 'database.js');
const { createNutritionRouter } = src('routes', 'nutrition.js');
const { CropProfileService } = src('services', 'CropProfileService.js');
const { FertilizerAdvisorService } = src('services', 'FertilizerAdvisorService.js');
const { FertigationSystemView } = src('services', 'FertigationSystemView.js');
const F = src('services', 'fertilizerAdviceFormat.js');
const { languageMiddleware } = src('middleware', 'language.js');
const { NOW, seedFarm, addRun, addSchedule } = require('./fixtures/nutritionFarm');

const quiet = { log() {}, warn() {}, error() {} };
const out = {
  analysis_markdown: 'N and K are low against the protocol vegetative feed because Tank C holds 38 kg KNO3 instead of 58 kg and dosing runs at 1:200 instead of the 1:150 design. Measured feed EC is about twice the recipe EC, so the source water or acid adds about 1 mS/cm that is not recorded. Drain is not measured, so the root-zone EC cannot be judged.',
  per_element: F.ELEMENTS.map(el => ({ element: el, status: 'ok', comment: `${el} fine.` })),
  warnings: [{ severity: 'warning', message: 'N and K low.' }],
  recommendations: [{ priority: 'high', action: 'Next refill of Tank C: 58 kg KNO3 per 1000 L.', rationale: 'Protocol value.', when: 'next refill', vs_protocol: 'agrees', vs_protocol_reason: 'Same as the protocol.' }],
  questions_for_operator: [],
  status: 'caution',
  summary: 'Feeding is below the human protocol: N and K about a third low.',
};
let gate = null; // when set, the model call waits for it (a run "in progress")
const client = {
  messages: {
    stream: () => ({ on() {}, finalMessage: async () => (gate && await gate, { model: 'claude-sonnet-5', stop_reason: 'end_turn', usage: { input_tokens: 9000, output_tokens: 6000 }, content: [{ type: 'text', text: JSON.stringify(out) }] }) }),
    create: async () => { throw new Error('translation not expected in this test'); },
  },
};

const profiles = new CropProfileService({ db, now: () => NOW });
const advisor = new FertilizerAdvisorService({
  db, now: () => NOW, log: quiet, getClient: () => client, profiles,
  getAgronomistConfig: () => ({ model: 'claude-sonnet-5', effort: 'medium', translation_enabled: false }),
  getAgronomistHealth: () => ({ paused: false }), createAlert: () => {},
});
const systemView = new FertigationSystemView({ db, now: () => NOW });

let server; let base;
test.before(async () => {
  seedFarm(db);
  addSchedule(db, { time: '07:30', min: 3 });
  addRun(db, { key: 'r1', startedAt: '2026-09-28T03:30:00Z', localDate: '2026-09-28', water: 2000, tanks: { 1: 10, 2: 10, 3: 10, 4: 10 } });
  const app = express();
  app.use(express.json());
  app.use('/api', languageMiddleware);
  app.use((req, res, next) => { const role = req.headers['x-role']; if (role) req.user = { id: 5, email: `${role}@farm.test`, role }; next(); });
  app.use('/api/nutrition', createNutritionRouter({ db, profiles, advisor, systemView, now: () => new Date(NOW).getTime() }));
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/nutrition`;
});
test.after(() => new Promise(r => server.close(r)));

const call = async (method, p, role, body, headers = {}) => {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(role ? { 'x-role': role } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch (_) { json = null; }
  return { status: res.status, body: json };
};

test('viewer: reads everything, cannot edit, cannot run the advisor', async () => {
  const active = await call('GET', '/profiles/active', 'viewer');
  assert.equal(active.status, 200);
  assert.equal(active.body.profile.crop, 'Cucumber');
  assert.equal((await call('GET', `/profiles/${active.body.profile.id}`, 'viewer')).body.stage.effective, 'vegetative');
  assert.equal((await call('GET', '/protocols', 'viewer')).body.length, 1);
  const sys = await call('GET', '/system', 'viewer');
  assert.equal(sys.status, 200);
  assert.equal(sys.body.source, 'live_system');
  const feed = await call('GET', '/feed?period=today', 'viewer');
  assert.equal(feed.status, 200);
  assert.equal(feed.body.basis, 'measured');
  assert.equal((await call('GET', '/feed?period=bogus', 'viewer')).body.period, 'today');
  assert.equal((await call('GET', '/advisor/config', 'viewer')).body.api_key_present, true);
  const est = await call('GET', '/advisor/estimate', 'viewer');
  assert.ok(est.body.usd_est > 0);
  assert.equal((await call('PUT', `/profiles/${active.body.profile.id}`, 'viewer', { variety: 'x' })).status, 403);
  assert.equal((await call('PUT', `/profiles/${active.body.profile.id}/targets`, 'viewer', {})).status, 403);
  assert.equal((await call('POST', '/profiles', 'viewer', { crop: 'x' })).status, 403);
  assert.equal((await call('POST', '/advice/run', 'viewer', {})).status, 403);
  assert.equal((await call('PUT', '/advisor/config', 'viewer', {})).status, 403);
});

test('operator: edits the profile + targets (validated) and runs the advisor; cannot change advisor settings', async () => {
  const id = (await call('GET', '/profiles/active', 'operator')).body.profile.id;
  const bad = await call('PUT', `/profiles/${id}`, 'operator', { source_water_ec: 99 });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.field, 'source_water_ec');
  const ok = await call('PUT', `/profiles/${id}`, 'operator', { source_water_ec: 0.4, plants_per_section: 4300 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.source_water_ec, 0.4);
  const t = await call('PUT', `/profiles/${id}/targets`, 'operator', { stage_targets: [{ stage: 'vegetative', ec_target: 1.7, ec_min: 1.6, ec_max: 1.8 }] });
  assert.equal(t.status, 200);
  assert.equal(t.body.stage_targets.vegetative.ec_min, 1.6);
  assert.equal((await call('POST', `/profiles/${id}/targets/reset`, 'operator')).body.stage_targets.vegetative.ec_min, null);
  assert.equal((await call('PUT', '/advisor/config', 'operator', { weekly_hour: 5 })).status, 403);
  let open;
  gate = new Promise(r => { open = r; });
  const run = await call('POST', '/advice/run', 'operator', {});
  assert.equal(run.status, 202);
  assert.equal(run.body.status, 'running');
  const again = await call('POST', '/advice/run', 'operator', {});
  assert.equal(again.status, 409, 'one run at a time');
  assert.equal(again.body.code, 'RUNNING');
  assert.equal((await call('GET', '/advice/latest', 'viewer')).body.running, true);
  open(); gate = null;
  await advisor.whenIdle();
  const latest = await call('GET', '/advice/latest', 'viewer');
  assert.equal(latest.body.advice.id, run.body.id);
  assert.equal(latest.body.advice.advice.status, 'caution');
  assert.equal(latest.body.advice.translation_status, 'original');
  const list = await call('GET', '/advice', 'viewer');
  assert.equal(list.body.total, 1);
  assert.equal(list.body.items[0].summary, out.summary);
  const one = await call('GET', `/advice/${run.body.id}`, 'viewer', null, { 'accept-language': 'tr' });
  assert.equal(one.body.translation_status, 'original', 'translation disabled in this test → English');
  assert.equal((await call('GET', '/advice/9999', 'viewer')).status, 404);
});

test('admin: advisor settings; translate requires admin; no API key → 400 before anything is stored', async () => {
  const cfg = await call('PUT', '/advisor/config', 'admin', { weekly_day: 6, weekly_hour: 18, weekly_minute: 45, auto_enabled: false });
  assert.equal(cfg.status, 200);
  assert.deepEqual([cfg.body.weekly_day, cfg.body.weekly_hour, cfg.body.weekly_minute, cfg.body.auto_enabled], [6, 18, 45, false]);
  assert.equal((await call('POST', '/advice/1/translate', 'operator', { lang: 'tr' })).status, 403);
  assert.equal((await call('POST', '/advice/1/translate', 'admin', { lang: 'fr' })).status, 400);
  const key = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const n = db.prepare('SELECT COUNT(*) AS n FROM fertilizer_advice').get().n;
  const r = await call('POST', '/advice/run', 'admin', {});
  process.env.ANTHROPIC_API_KEY = key;
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'NO_API_KEY');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fertilizer_advice').get().n, n);
});

test('new crop cycle via the API keeps history', async () => {
  const before = (await call('GET', '/profiles/active', 'admin')).body.profile;
  const created = await call('POST', '/profiles', 'admin', { crop: 'Cucumber', variety: 'Next F1', transplant_date: '2026-11-01', protocol_id: before.protocol_id });
  assert.equal(created.status, 201);
  const all = await call('GET', '/profiles?include_inactive=1', 'viewer');
  assert.equal(all.body.length, 2);
  assert.equal(all.body.filter(p => p.active).length, 1);
  assert.equal(all.body.find(p => p.id === before.id).active, false);
});
