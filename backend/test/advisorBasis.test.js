/**
 * Provenance of the AI fertilizer advisor's items (operator request 2026-09-30:
 * "visual markings to know when the AI generates data that is based on the human
 * inputs and the ones generated"). Every element verdict, warning and
 * recommendation carries a `basis` array from a fixed enum: schema (required,
 * enum), validation (missing / empty / unknown → rejected → retry), normalisation
 * (dedupe, fixed order), translation (never translated, hash unchanged, kept on
 * merge) and backward compatibility (advices saved before 2026-09-30 have no
 * basis and still load, localize and serve). Stubbed Anthropic client, in-memory DB.
 */
process.env.DB_PATH = ':memory:';
process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
delete process.env.AGRONOMIST_TRANSLATION;

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const crypto = require('crypto');

const src = (...p) => require(path.join(__dirname, '..', 'src', ...p));
const { db } = src('utils', 'database.js');
const { FertilizerAdvisorService } = src('services', 'FertilizerAdvisorService.js');
const F = src('services', 'fertilizerAdviceFormat.js');
const { NOW, seedFarm, addRun, addSchedule } = require('./fixtures/nutritionFarm');

const quiet = { log() {}, warn() {}, error() {} };

function output(overrides = {}) {
  return {
    analysis_markdown: 'Day 21, vegetative. The plants get about 94 ppm N, 124 ppm K and 93 ppm Ca today against a protocol vegetative feed of about 154 N, 213 K and 127 Ca at 1:150. Tank C holds 38 kg KNO3 per 1000 L where the protocol asks 58 kg, and the ratio is 1:200 instead of the 1:150 design, so N and K are both well under target. Measured feed EC is about 2.0 mS/cm while the recipe accounts for only about 1.0 mS/cm. Drain is not measured.',
    per_element: F.ELEMENTS.map(el => ({ element: el, status: el === 'N' ? 'low' : 'ok', comment: `${el} comment.`, basis: ['senseHub_calculation', 'protocol', 'senseHub_calculation'] })),
    warnings: [{ severity: 'warning', message: 'Nitrogen is about 35 % under the protocol target.', basis: ['protocol', 'measured'] }],
    recommendations: [
      { priority: 'high', action: 'Next refill of Tank C: 58 kg KNO3 per 1000 L as in the protocol.', rationale: 'N is low.', when: 'next refill of Tank C', vs_protocol: 'agrees', vs_protocol_reason: 'The protocol vegetative recipe has 58 kg KNO3.', basis: ['operator_targets', 'protocol'] },
      { priority: 'low', action: 'Keep the slab temperature below 28 C in the afternoon.', rationale: 'Root uptake of Ca drops in warm slabs.', when: 'this week', vs_protocol: 'extends', vs_protocol_reason: 'The protocol does not cover root-zone temperature.', basis: ['ai_general_knowledge'] },
    ],
    questions_for_operator: [],
    status: 'caution',
    summary: 'Feeding is below the human protocol for day 21: N about 35 % low because Tank C has 38 kg KNO3 and dosing runs at 1:200.',
    ...overrides,
  };
}

const resp = (obj) => ({ model: 'claude-sonnet-5', stop_reason: 'end_turn', usage: { input_tokens: 9000, output_tokens: 7000 }, content: [{ type: 'text', text: JSON.stringify(obj) }] });

function fakeTranslate(body) {
  const lang = /Turkish/.test(body.system) ? 'TR' : 'AR';
  const payload = JSON.parse(/```json\n([\s\S]*)\n```/.exec(body.messages[0].content)[1]);
  const walk = (v) => (typeof v === 'string' ? (v ? `[${lang}] ${v}` : v) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
  return { ...resp(walk(payload)), usage: { input_tokens: 1500, output_tokens: 2500 } };
}

const calls = { stream: [], create: [] };
let streamImpl = null;
const client = {
  messages: {
    stream: (body) => { calls.stream.push(body); const n = calls.stream.length; return { on() {}, finalMessage: async () => (streamImpl ? streamImpl(body, n) : resp(output())) }; },
    create: async (body) => { calls.create.push(body); return fakeTranslate(body); },
  },
};
const advisor = new FertilizerAdvisorService({
  db, now: () => NOW, log: quiet,
  getClient: () => client,
  getAgronomistConfig: () => ({ model: 'claude-sonnet-5', effort: 'medium', translation_enabled: true, translation_languages: ['tr', 'ar'], reference_temperature_equipment_id: null }),
  getAgronomistHealth: () => ({ paused: false }),
  classifyProviderError: () => 'other',
  createAlert: () => {},
});

test('setup farm', () => {
  seedFarm(db);
  addSchedule(db, { time: '07:30', min: 3 });
  addRun(db, { key: 'r1', startedAt: '2026-09-28T03:30:00Z', localDate: '2026-09-28', water: 2000, tanks: { 1: 10, 2: 10, 3: 10, 4: 10 } });
});

test('schema: basis is a required enum array on element verdicts, warnings and recommendations (with and without notes)', () => {
  assert.deepEqual(F.BASIS, ['protocol', 'operator_targets', 'operator_notes', 'measured', 'senseHub_calculation', 'ai_general_knowledge']);
  for (const schema of [F.outputSchema(), F.outputSchema({ withNotes: true })]) {
    for (const key of ['per_element', 'warnings', 'recommendations']) {
      const item = schema.properties[key].items;
      assert.ok(item.required.includes('basis'), `${key}.basis required`);
      assert.equal(item.properties.basis.type, 'array');
      assert.deepEqual(item.properties.basis.items.enum, F.BASIS);
      assert.equal(item.additionalProperties, false);
      assert.equal(item.properties.basis.minItems, undefined, 'no array constraints in the structured-output schema (validated instead)');
    }
  }
  assert.match(F.SYSTEM_PROMPT, /ai_general_knowledge alone only when nothing in the snapshot supports the item/);
  const { snapshot } = advisor.buildSnapshot({ nowMs: NOW });
  const { requestBody } = advisor.buildRequest({ snapshot });
  assert.match(requestBody.messages[0].content[0].text, /give every verdict, warning and recommendation its basis/);
  assert.ok(requestBody.output_config.format.schema.properties.recommendations.items.required.includes('basis'));
});

test('validation: missing, empty or unknown basis is rejected; a valid one passes', () => {
  assert.equal(F.validateAdviceOutput(output()).ok, true);
  const noBasis = output();
  delete noBasis.recommendations[0].basis;
  let v = F.validateAdviceOutput(noBasis);
  assert.equal(v.ok, false);
  assert.ok(v.problems.includes('recommendations[0].basis missing'));
  v = F.validateAdviceOutput(output({ warnings: [{ severity: 'info', message: 'x y z', basis: [] }] }));
  assert.ok(v.problems.includes('warnings[0].basis empty'));
  const bad = output();
  bad.per_element[2].basis = ['measured', 'gut_feeling'];
  v = F.validateAdviceOutput(bad);
  assert.ok(v.problems.some(p => p === "per_element K basis has unknown value(s) 'gut_feeling'"), v.problems.join('; '));
  assert.equal(F.basisProblem(['protocol']), null);
  assert.equal(F.basisProblem(undefined), 'missing');
});

test('normalise: basis de-duplicated in the fixed order; absent basis stays absent', () => {
  const n = F.normaliseAdvice(output());
  assert.deepEqual(n.per_element[0].basis, ['protocol', 'senseHub_calculation']);
  assert.deepEqual(n.recommendations[0].basis, ['protocol', 'operator_targets']);
  assert.deepEqual(n.recommendations[1].basis, ['ai_general_knowledge']);
  assert.deepEqual(n.warnings[0].basis, ['protocol', 'measured']);
  const old = output();
  for (const k of ['per_element', 'warnings', 'recommendations']) for (const it of old[k]) delete it.basis;
  const on = F.normaliseAdvice(old);
  assert.ok(!('basis' in on.recommendations[0]) && !('basis' in on.warnings[0]) && !('basis' in on.per_element[0]));
  assert.equal(F.normaliseBasis(['nope']), null);
});

test('translation: basis never translated, not in the payload (hash unchanged), kept on merge', () => {
  const withB = F.normaliseAdvice(output());
  const without = JSON.parse(JSON.stringify(withB));
  for (const k of ['per_element', 'warnings', 'recommendations']) for (const it of without[k]) delete it.basis;
  const hash = (o) => crypto.createHash('sha256').update(JSON.stringify(F.translatablePayload(o))).digest('hex');
  assert.equal(hash(withB), hash(without), 'older advices keep their translation hash');
  assert.ok(!JSON.stringify(F.translatablePayload(withB)).includes('senseHub_calculation'));
  const merged = F.mergeTranslation(withB, { recommendations: [{ action: '[TR] a' }, { action: '[TR] b' }], warnings: [{ message: '[TR] w' }] });
  assert.equal(merged.recommendations[1].action, '[TR] b');
  assert.deepEqual(merged.recommendations[1].basis, ['ai_general_knowledge']);
  assert.deepEqual(merged.warnings[0].basis, ['protocol', 'measured']);
});

test('run: output without basis → rejected → retry with basis → saved; tr keeps the basis', async () => {
  calls.stream.length = 0;
  const first = output();
  for (const it of first.recommendations) delete it.basis;
  streamImpl = (b, n) => (n === 1 ? resp(first) : resp(output()));
  const adv = await advisor.run({ trigger: 'manual' });
  streamImpl = null;
  await advisor.whenIdle();
  assert.equal(adv.status, 'success');
  assert.equal(adv.attempts, 2, 'the missing basis cost one retry');
  assert.deepEqual(adv.advice.recommendations[0].basis, ['protocol', 'operator_targets']);
  const tr = advisor.localize(advisor.get(adv.id), 'tr');
  assert.equal(tr.translation_status, 'ready');
  assert.match(tr.advice.recommendations[1].action, /^\[TR\] /);
  assert.deepEqual(tr.advice.recommendations[1].basis, ['ai_general_knowledge'], 'enum list never translated');
  assert.deepEqual(tr.advice.per_element[0].basis, ['protocol', 'senseHub_calculation']);
});

test('backward compatibility: an advice saved before 2026-09-30 (no basis) loads, localizes and serves as latest', () => {
  const old = F.normaliseAdvice((() => { const o = output(); for (const k of ['per_element', 'warnings', 'recommendations']) for (const it of o[k]) delete it.basis; return o; })());
  const profileId = db.prepare('SELECT id FROM crop_profiles WHERE active = 1').get().id;
  const later = new Date(NOW + 60000).toISOString();
  const id = Number(db.prepare(`
    INSERT INTO fertilizer_advice (profile_id, trigger, status, snapshot, calc, model, output, created_at, completed_at)
    VALUES (?, 'weekly', 'success', '{}', '{}', 'claude-sonnet-5', ?, ?, ?)
  `).run(profileId, JSON.stringify(old), later, later).lastInsertRowid);
  const got = advisor.get(id);
  assert.equal(got.status, 'success');
  assert.equal(got.advice.recommendations[0].basis, undefined);
  assert.equal(got.advice.recommendations.length, 2);
  const tr = advisor.localize(got, 'tr');
  assert.ok(['original', 'pending'].includes(tr.translation_status));
  assert.equal(advisor.latest().advice.id, id);
  assert.equal(advisor.list({ limit: 5 }).items[0].id, id);
});
