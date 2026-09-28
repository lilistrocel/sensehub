/**
 * Fertilizer advisor with a STUBBED Anthropic client (no real API call ever):
 * success + translation, invalid output → retry → failure record, billing error,
 * stop_reason max_tokens, auto-trigger debounce (stage / tank / ratio changes, max
 * once per 24 h), weekly schedule, the agronomist snapshot carrying the latest
 * advice, data-source policy, and "advisory only" (nothing else is written).
 * In-memory DB only.
 */
process.env.DB_PATH = ':memory:';
process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
delete process.env.AGRONOMIST_TRANSLATION;

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const src = (...p) => require(path.join(__dirname, '..', 'src', ...p));
const { db } = src('utils', 'database.js');
const { FertilizerAdvisorService } = src('services', 'FertilizerAdvisorService.js');
const { FertilizerAdvisorSchedulerService } = src('services', 'FertilizerAdvisorSchedulerService.js');
const F = src('services', 'fertilizerAdviceFormat.js');
const { NOW, seedFarm, addRun, addSchedule, setSetting } = require('./fixtures/nutritionFarm');

const quiet = process.env.DEBUG_ADVISOR ? console : { log() {}, warn() {}, error() {} };

function goodOutput(tag = '') {
  return {
    analysis_markdown: `Day 21, vegetative. The plants get about 94 ppm N, 124 ppm K and 93 ppm Ca today against a protocol vegetative feed of about 154 N, 213 K and 127 Ca at 1:150${tag}. Tank C holds 38 kg KNO3 per 1000 L where the protocol asks 58 kg, and the ratio is 1:200 instead of the 1:150 design, so N and K are both well under target. Measured feed EC is about 2.0 mS/cm while the recipe accounts for only about 1.0 mS/cm, so roughly 1 mS/cm comes from source water or acid, which is not recorded. Drain is not measured.`,
    per_element: F.ELEMENTS.map(el => ({ element: el, status: ['N', 'K'].includes(el) ? 'low' : 'ok', comment: `${el} comment${tag}.` })),
    warnings: [{ severity: 'warning', message: `Nitrogen and potassium are about 35 % under the protocol target${tag}.` }],
    recommendations: [
      { priority: 'high', action: `Next refill of Tank C: 58 kg KNO3 per 1000 L as in the protocol${tag}.`, rationale: 'N and K are low.', when: 'next refill of Tank C', vs_protocol: 'agrees', vs_protocol_reason: 'The protocol vegetative recipe has 58 kg KNO3.' },
      { priority: 'medium', action: 'Measure the source water EC once.', rationale: 'The EC gap of 1 mS/cm is unexplained.', when: 'this week', vs_protocol: 'extends', vs_protocol_reason: 'The protocol does not cover source water.' },
    ],
    questions_for_operator: ['What is the EC of the source water?'],
    status: 'caution',
    summary: `Feeding is below the human protocol for day 21: N and K about 35 % low because Tank C has 38 kg KNO3 and dosing runs at 1:200${tag}.`,
  };
}

const resp = (obj, extra = {}) => ({ model: 'claude-sonnet-5', stop_reason: 'end_turn', usage: { input_tokens: 9000, output_tokens: 7000 }, content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }], ...extra });

function fakeTranslate(body) {
  const lang = /Turkish/.test(body.system) ? 'TR' : 'AR';
  const payload = JSON.parse(/```json\n([\s\S]*)\n```/.exec(body.messages[0].content)[1]);
  const walk = (v) => (typeof v === 'string' ? (v ? `[${lang}] ${v}` : v) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
  return resp(walk(payload), { usage: { input_tokens: 1500, output_tokens: 2500 } });
}

const calls = { stream: [], create: [] };
let streamImpl = null;
const client = {
  messages: {
    stream: (body) => {
      calls.stream.push(body);
      const n = calls.stream.length;
      return { on() {}, finalMessage: async () => (streamImpl ? streamImpl(body, n) : resp(goodOutput())) };
    },
    create: async (body) => { calls.create.push(body); return fakeTranslate(body); },
  },
};

const alerts = [];
let now = NOW;
const advisor = new FertilizerAdvisorService({
  db, now: () => now, log: quiet,
  getClient: () => client,
  getAgronomistConfig: () => ({ model: 'claude-sonnet-5', effort: 'medium', translation_enabled: true, translation_languages: ['tr', 'ar'], reference_temperature_equipment_id: null }),
  getAgronomistHealth: () => ({ paused: false }),
  classifyProviderError: (err) => (/credit balance/i.test(err.message) ? 'billing' : 'other'),
  createAlert: (o) => alerts.push(o),
});

const snapshotOf = (table) => JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());

test('setup farm', () => {
  seedFarm(db);
  addSchedule(db, { time: '07:30', min: 3 });
  addRun(db, { key: 'r1', startedAt: '2026-09-28T03:30:00Z', localDate: '2026-09-28', water: 2000, tanks: { 1: 10, 2: 10, 3: 10, 4: 10 } });
  addRun(db, { key: 'r0', startedAt: '2026-09-27T03:30:00Z', localDate: '2026-09-27', water: 2000, tanks: { 1: 10, 2: 10, 3: 10, 4: 10 } });
});

test('snapshot: facts only (no calculator verdicts), protocol + targets + live system + missing data; request shape', () => {
  const { snapshot, calc } = advisor.buildSnapshot({ nowMs: NOW });
  assert.equal(snapshot.crop_profile.days_after_transplant, 21);
  assert.equal(snapshot.crop_profile.stage, 'vegetative');
  assert.deepEqual(snapshot.crop_profile.next_stage, { stage: 'flowering', date: '2026-10-02', in_days: 4 });
  assert.equal(snapshot.human_protocol.authoritative, true);
  assert.equal(snapshot.human_protocol.recipes.vegetative.tanks.C, 'Potassium nitrate (KNO3) 58 kg');
  assert.equal(snapshot.fertigation_system.tanks.find(t => t.tank === 'C').contents, 'Potassium Nitrate (13-0-46) 38 kg');
  assert.equal(snapshot.delivered.today.calc_basis, 'measured');
  assert.ok(snapshot.delivered.today.ppm.N > 0);
  assert.equal(snapshot.drain.measured, false);
  assert.ok(snapshot.missing_data.some(m => /source water EC/.test(m)));
  assert.ok(snapshot.missing_data.some(m => /pH Down acid type/.test(m)));
  assert.ok(snapshot.fertigation_system.tanks.find(t => t.tank === 'D').analysis_notes.length === 1, 'Fetrilon "verify" note passed on');
  const text = JSON.stringify(snapshot);
  assert.ok(!/"status":"(low|high)"/.test(text) && !/diff_kg|comparisons|severity":"caution/.test(text), 'no pre-written conclusions in the snapshot');
  assert.ok(calc.today.comparisons, 'the UI calculator keeps its statuses');
  const { requestBody } = advisor.buildRequest({ snapshot });
  assert.equal(requestBody.model, 'claude-sonnet-5');
  assert.equal(requestBody.output_config.effort, 'medium');
  assert.equal(requestBody.output_config.format.type, 'json_schema');
  assert.ok(requestBody.max_tokens >= 16000);
  assert.match(requestBody.system[0].text, /ADVISORY ONLY/);
  assert.match(requestBody.system[0].text, /vs_protocol/);
  const est = advisor.estimate({});
  assert.ok(est.usd_est > 0.05 && est.usd_est < 0.5, `estimate ${est.usd_est}`);
  assert.deepEqual(est.translation_languages, ['tr', 'ar']);
});

test('success: stored as its own row, normalised, tokens + cost; tr/ar translated; nothing else written', async () => {
  const before = ['fertigation_tanks', 'fertigation_mixtures', 'fertigation_mixture_items', 'fertigation_dose_programs', 'automations', 'relay_channel_config'].map(snapshotOf);
  const doseCfg = db.prepare("SELECT value FROM system_settings WHERE key = 'dose_controller'").get().value;
  const adv = await advisor.run({ trigger: 'manual', userId: 1 });
  await advisor.whenIdle();
  assert.equal(adv.status, 'success');
  assert.equal(adv.trigger, 'manual');
  assert.equal(adv.attempts, 1);
  assert.equal(adv.input_tokens, 9000);
  assert.ok(adv.cost_estimate > 0);
  assert.equal(adv.advice.status, 'caution');
  assert.equal(adv.advice.per_element[0].element, 'N');
  assert.equal(adv.advice.recommendations[0].vs_protocol, 'agrees');
  assert.equal(adv.snapshot.crop_profile.crop, 'Cucumber');
  assert.equal(calls.stream.length, 1);
  assert.equal(calls.create.length, 2, 'one translation call per language');
  const tr = advisor.localize(advisor.get(adv.id), 'tr');
  assert.equal(tr.translation_status, 'ready');
  assert.match(tr.advice.summary, /^\[TR\] /);
  assert.match(tr.advice.recommendations[0].vs_protocol_reason, /^\[TR\] /);
  assert.equal(tr.advice.recommendations[0].vs_protocol, 'agrees', 'enums are never translated');
  assert.equal(tr.advice.per_element[3].element, 'Ca');
  const ar = advisor.localize(advisor.get(adv.id), 'ar');
  assert.match(ar.advice.warnings[0].message, /^\[AR\] /);
  assert.equal(advisor.localize(advisor.get(adv.id), 'tr', { original: true }).translation_status, 'original');
  const after = ['fertigation_tanks', 'fertigation_mixtures', 'fertigation_mixture_items', 'fertigation_dose_programs', 'automations', 'relay_channel_config'].map(snapshotOf);
  assert.deepEqual(after, before, 'ADVISORY ONLY: recipes, tanks, programs, automations untouched');
  assert.equal(db.prepare("SELECT value FROM system_settings WHERE key = 'dose_controller'").get().value, doseCfg, 'ratio config untouched');
  assert.equal(alerts.length, 0);
});

test('invalid output → one retry → failure record; the good advice is kept and still served as latest', async () => {
  calls.stream.length = 0;
  streamImpl = () => resp({ ...goodOutput(), recommendations: [], summary: 'short' });
  const adv = await advisor.run({ trigger: 'manual' });
  streamImpl = null;
  assert.equal(adv.status, 'failure');
  assert.equal(adv.error_class, 'truncated_output');
  assert.equal(adv.attempts, 2);
  assert.equal(calls.stream.length, 2);
  assert.equal(adv.input_tokens, 18000, 'tokens summed over attempts');
  assert.match(adv.error, /no recommendations/);
  const latest = advisor.latest();
  assert.equal(latest.advice.status, 'success', 'failure never replaces the good advice');
  assert.equal(latest.newer.id, adv.id);
  assert.equal(latest.newer.status, 'failure');
  assert.equal(alerts.at(-1).fingerprint, 'fertilizer_advisor_provider_error');
  assert.equal(alerts.at(-1).messageKey, 'fertilizer_advisor.provider_alert');
  // invalid JSON also counts
  streamImpl = (b, n) => (n % 2 ? resp('{"analysis_markdown": "cut') : resp(goodOutput(' retry')));
  const ok = await advisor.run({ trigger: 'manual' });
  streamImpl = null;
  await advisor.whenIdle();
  assert.equal(ok.status, 'success');
  assert.equal(ok.attempts, 2);
  assert.match(ok.advice.summary, / retry/);
});

test('stop_reason max_tokens / refusal are rejected (not saved as success)', async () => {
  streamImpl = () => resp(goodOutput(), { stop_reason: 'max_tokens' });
  const a = await advisor.run({ trigger: 'manual' });
  assert.equal(a.status, 'failure');
  assert.equal(a.error_class, 'max_tokens');
  assert.equal(a.stop_reason, 'max_tokens');
  streamImpl = () => resp(goodOutput(), { stop_reason: 'refusal', stop_details: { category: 'cyber' } });
  const b = await advisor.run({ trigger: 'manual' });
  assert.equal(b.error_class, 'refusal');
  streamImpl = null;
});

test('billing error: no retry, classified, fingerprinted alert, pause after 3 in a row until settings are saved', async () => {
  calls.stream.length = 0;
  alerts.length = 0;
  streamImpl = () => { const e = new Error('400 Your credit balance is too low to access the Anthropic API.'); e.status = 400; throw e; };
  for (let i = 0; i < 3; i++) {
    const a = await advisor.run({ trigger: 'manual' });
    assert.equal(a.status, 'failure');
    assert.equal(a.error_class, 'billing');
    assert.equal(a.attempts, 1);
  }
  assert.equal(calls.stream.length, 3, 'no retry on a provider error');
  assert.equal(alerts.length, 3);
  assert.equal(alerts.at(-1).severity, 'critical');
  assert.equal(alerts.at(-1).messageKey, 'fertilizer_advisor.provider_alert_paused');
  assert.match(alerts.at(-1).messageParams.error, /credit balance/);
  const h = advisor.getHealth();
  assert.equal(h.paused, true);
  assert.equal(h.consecutive_failures, 5, 'max_tokens + refusal + 3 billing since the last success');
  assert.equal(advisor._canRunScheduled(), false, 'scheduled / automatic runs are paused');
  // saving the settings clears the pause (updated_at newer than the last failure)
  db.prepare("UPDATE fertilizer_advice SET created_at = '2026-01-01T00:00:00.000Z' WHERE status = 'failure'").run();
  advisor.saveConfig({ weekly_hour: 19 });
  assert.equal(advisor.getHealth().paused, false);
  streamImpl = null;
});

test('the daily agronomist snapshot carries the latest advice (compact) and drops it with the fertigation source', () => {
  const c = advisor.compactForAgronomist(Date.now());
  assert.ok(c, 'latest success is fresh');
  assert.equal(c.status, 'caution');
  assert.ok(c.summary.length <= 400);
  assert.ok(c.warnings.length >= 1 && c.warnings[0].startsWith('warning: '));
  const { agronomistService } = src('services', 'AgronomistService.js');
  const snap = agronomistService.aggregateDailyData('2026-09-28');
  assert.equal(snap.fertilizer_advice.advice_id, c.advice_id);
  setSetting(db, 'ai_data_sources', { sources: { fertigation: { enabled: false, reason: 'test', until: null } }, excluded_equipment_ids: [] });
  const off = agronomistService.aggregateDailyData('2026-09-28');
  assert.equal(off.fertilizer_advice, undefined);
  assert.throws(() => advisor.buildSnapshot({}), /out of service/);
  db.prepare("DELETE FROM system_settings WHERE key = 'ai_data_sources'").run();
  assert.equal(advisor.compactForAgronomist(Date.now() + 20 * 86400000), null, 'older than 14 days → omitted');
});

test('data sources: out-of-service lab / water controller are omitted, with the OUT OF SERVICE note', () => {
  setSetting(db, 'ai_data_sources', { sources: { amic: { enabled: false, reason: 'down', until: null }, lab: { enabled: false, reason: null, until: null }, water_controller: { enabled: false, reason: 'probe out', until: null } }, excluded_equipment_ids: [] });
  const { snapshot, dataSources } = advisor.buildSnapshot({ nowMs: NOW });
  assert.equal(snapshot.lab, undefined);
  assert.equal(snapshot.delivered.today.ec_measured_ms_cm, undefined);
  assert.ok(!snapshot.feed_runs_7d.some(l => /EC |pH /.test(l)));
  assert.ok(snapshot.missing_data.some(m => /out of service/.test(m)));
  const { requestBody } = advisor.buildRequest({ snapshot, dataSources });
  assert.match(requestBody.messages[0].content[0].text, /OUT OF SERVICE/);
  db.prepare("DELETE FROM system_settings WHERE key = 'ai_data_sources'").run();
});

test('auto triggers: first tick records, changes are debounced, max once per 24 h, a manual run covers them', async () => {
  db.prepare("DELETE FROM system_settings WHERE key = 'fertilizer_advisor_state'").run();
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM fertilizer_advice').get().n;
  const base = Date.parse('2026-10-05T10:00:00Z');
  now = base;
  const n0 = count();
  assert.equal(advisor.checkAutoTriggers(now), null, 'first tick only records the signatures');
  assert.equal(advisor.checkAutoTriggers(now + 60000), null, 'nothing changed');
  // a tank refill is logged
  db.prepare("INSERT INTO fertigation_tank_refills (tank_id, water_liters_added, notes) VALUES (3, 1000, 'refill')").run();
  now = base + 2 * 60000;
  assert.equal(advisor.checkAutoTriggers(now), null, 'change recorded, still debouncing');
  assert.deepEqual(advisor.getState().pending.reasons, ['tank_change']);
  // ratio changes 5 min later → debounce restarts
  const cfg = JSON.parse(db.prepare("SELECT value FROM system_settings WHERE key = 'dose_controller'").get().value);
  cfg.nutrients.ratio = { 1: 180, 2: 180, 3: 180, 4: 180 };
  setSetting(db, 'dose_controller', cfg);
  now = base + 7 * 60000;
  assert.equal(advisor.checkAutoTriggers(now), null);
  now = base + 12 * 60000;
  assert.equal(advisor.checkAutoTriggers(now), null, '5 min after the last change: still settling');
  assert.equal(count(), n0);
  now = base + 18 * 60000;
  const id = advisor.checkAutoTriggers(now);
  assert.ok(id, 'fires 10 min after the last change');
  await advisor.whenIdle();
  const adv = advisor.get(id);
  assert.equal(adv.trigger, 'tank_change');
  assert.deepEqual(adv.trigger_detail.reasons, ['tank_change', 'ratio_change']);
  // stage change a day later is within 24 h of the last automatic run → waits
  db.prepare("UPDATE crop_profiles SET stage_override = 'fruiting' WHERE active = 1").run();
  now = base + 20 * 3600000;
  advisor.checkAutoTriggers(now);
  now = base + 21 * 3600000;
  assert.equal(advisor.checkAutoTriggers(now), null, 'max once per 24 h');
  now = base + 24 * 3600000 + 20 * 60000;
  const id2 = advisor.checkAutoTriggers(now);
  assert.ok(id2);
  await advisor.whenIdle();
  assert.equal(advisor.get(id2).trigger, 'stage_change');
  // a manual run after a change covers it (no automatic run afterwards)
  db.prepare("INSERT INTO fertigation_tank_refills (tank_id, water_liters_added) VALUES (1, 1000)").run();
  now = base + 49 * 3600000;
  advisor.checkAutoTriggers(now);
  await advisor.run({ trigger: 'manual' });
  now = base + 50 * 3600000;
  const before = count();
  assert.equal(advisor.checkAutoTriggers(now), null);
  assert.equal(advisor.getState().pending, null);
  assert.equal(count(), before);
  // never while a dose cycle is running
  db.prepare("INSERT INTO fertigation_tank_refills (tank_id, water_liters_added) VALUES (2, 1000)").run();
  now = base + 80 * 3600000;
  advisor.checkAutoTriggers(now);
  const run = db.prepare("INSERT INTO dose_controller_runs (started_at, status) VALUES ('2026-10-08T10:00:00Z', 'running')").run();
  now += 30 * 60000;
  assert.equal(advisor.checkAutoTriggers(now), null, 'dose cycle running → postponed');
  db.prepare("UPDATE dose_controller_runs SET status = 'completed' WHERE id = ?").run(run.lastInsertRowid);
  now += 60000;
  assert.ok(advisor.checkAutoTriggers(now), 'fires once the cycle ended');
  await advisor.whenIdle();
  db.prepare("UPDATE crop_profiles SET stage_override = NULL WHERE active = 1").run();
});

test('weekly schedule: Sunday 19:30 local (30 min grace), once per week; scheduler tick also syncs the stage', async () => {
  const sched = new FertilizerAdvisorSchedulerService({ advisor });
  const sunday1930 = Date.parse('2026-10-11T15:30:00Z'); // Sunday 19:30 Dubai
  assert.equal(advisor.checkWeekly(Date.parse('2026-10-11T15:29:00Z')), null, '19:29: not yet');
  assert.equal(advisor.checkWeekly(Date.parse('2026-10-10T15:30:00Z')), null, 'Saturday');
  now = sunday1930;
  const out = sched.tick(sunday1930);
  assert.ok(out.weekly, 'weekly run started');
  await advisor.whenIdle();
  assert.equal(advisor.get(out.weekly).trigger, 'weekly');
  assert.equal(advisor.checkWeekly(sunday1930 + 5 * 60000), null, 'once per date');
  assert.equal(advisor.checkWeekly(Date.parse('2026-10-11T16:05:00Z')), null, 'after the grace window');
  advisor.saveConfig({ weekly_enabled: false });
  assert.equal(advisor.checkWeekly(Date.parse('2026-10-18T15:30:00Z')), null, 'disabled');
  advisor.saveConfig({ weekly_enabled: true, weekly_day: 3, weekly_hour: 6, weekly_minute: 0 });
  now = Date.parse('2026-10-14T02:10:00Z'); // Wednesday 06:10 Dubai
  assert.ok(advisor.checkWeekly(now));
  await advisor.whenIdle();
  // stage sync on the tick
  db.prepare("UPDATE crop_assignments SET current_stage = 'seedling' WHERE active = 1").run();
  const t = sched.tick(Date.parse('2026-10-14T03:00:00Z'));
  assert.equal(t.stages_synced, 1);
  assert.equal(db.prepare('SELECT current_stage FROM crop_assignments WHERE active = 1').get().current_stage, 'fruiting', 'day 37');
});

test('a second run while one is in progress is refused', async () => {
  let release;
  streamImpl = () => new Promise(r => { release = () => r(resp(goodOutput())); });
  const { id, promise } = advisor.start({ trigger: 'manual' });
  assert.throws(() => advisor.start({ trigger: 'manual' }), (e) => e.code === 'RUNNING' && e.running_id === id);
  assert.equal(advisor.get(id).status, 'running');
  await new Promise(r => setImmediate(r));
  release();
  await promise;
  streamImpl = null;
  await advisor.whenIdle();
  assert.equal(advisor.isRunning(), false);
});
