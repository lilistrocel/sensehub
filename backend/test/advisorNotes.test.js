/**
 * Operator notes on a fertilizer advisor (re)generation (operator request
 * 2026-09-29): trimmed + length-checked, stored on the advice row, sent as
 * clearly-labelled context, the model must answer them (schema + validation +
 * retry), shown on the report and the history, translated with the rest, runs
 * without notes unchanged (schema, translation hash), still advisory only; the
 * snapshot says which EC the element targets correspond to. Stubbed Anthropic
 * client, in-memory DB, loopback HTTP only.
 */
process.env.DB_PATH = ':memory:';
process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
delete process.env.AGRONOMIST_TRANSLATION;

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');

const src = (...p) => require(path.join(__dirname, '..', 'src', ...p));
const { db } = src('utils', 'database.js');
const { FertilizerAdvisorService, MAX_NOTES_CHARS, cleanNotes } = src('services', 'FertilizerAdvisorService.js');
const { CropProfileService } = src('services', 'CropProfileService.js');
const { createNutritionRouter } = src('routes', 'nutrition.js');
const F = src('services', 'fertilizerAdviceFormat.js');
const { NOW, seedFarm, addRun, addSchedule } = require('./fixtures/nutritionFarm');

const quiet = { log() {}, warn() {}, error() {} };
const NOTES = '  Lower leaves on rows 3-5 turned pale since Sunday.\r\nIs the Mg enough at EC 1.9?  ';

function output({ notesResponse } = {}) {
  return {
    analysis_markdown: 'Day 21, vegetative. The plants get about 94 ppm N, 124 ppm K and 93 ppm Ca today against a protocol vegetative feed of about 154 N, 213 K and 127 Ca at 1:150. Tank C holds 38 kg KNO3 per 1000 L where the protocol asks 58 kg, and the ratio is 1:200 instead of 1:150, so N and K are low. Mg is about 20 ppm against a target of 26 ppm, which fits pale lower leaves. Drain is not measured.',
    per_element: F.ELEMENTS.map(el => ({ element: el, status: el === 'Mg' ? 'low' : 'ok', comment: `${el} comment.` })),
    warnings: [{ severity: 'warning', message: 'Mg is below the stage target.' }],
    recommendations: [{ priority: 'high', action: 'Next refill of Tank B: 60 kg MgSO4 per 1000 L.', rationale: 'Mg is low.', when: 'next refill of Tank B', vs_protocol: 'extends', vs_protocol_reason: 'The protocol has 51 kg.' }],
    questions_for_operator: [],
    status: 'caution',
    summary: 'Feeding is below the protocol for day 21; Mg is low, which fits the pale lower leaves the team reported.',
    ...(notesResponse !== undefined ? { operator_notes_response: notesResponse } : {}),
  };
}
const resp = (obj) => ({ model: 'claude-sonnet-5', stop_reason: 'end_turn', usage: { input_tokens: 9000, output_tokens: 6000 }, content: [{ type: 'text', text: JSON.stringify(obj) }] });

function fakeTranslate(body) {
  const payload = JSON.parse(/```json\n([\s\S]*)\n```/.exec(body.messages[0].content)[1]);
  const walk = (v) => (typeof v === 'string' ? (v ? `[TR] ${v}` : v) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
  return resp(walk(payload));
}

const calls = [];
let replies = [];
const client = {
  messages: {
    stream: (body) => { calls.push(body); const r = replies.length ? replies.shift() : output(); return { on() {}, finalMessage: async () => resp(r) }; },
    create: async (body) => fakeTranslate(body),
  },
};
const profiles = new CropProfileService({ db, now: () => NOW });
let translate = false;
const advisor = new FertilizerAdvisorService({
  db, now: () => NOW, log: quiet, getClient: () => client, profiles,
  getAgronomistConfig: () => ({ model: 'claude-sonnet-5', effort: 'medium', translation_enabled: translate, translation_languages: ['tr'] }),
  getAgronomistHealth: () => ({ paused: false }), createAlert: () => {},
});

test('setup', () => {
  seedFarm(db);
  addSchedule(db, { time: '07:30', min: 3 });
  addRun(db, { key: 'r1', startedAt: '2026-09-28T03:30:00Z', localDate: '2026-09-28', water: 2000, tanks: { 1: 10, 2: 10, 3: 10, 4: 10 } });
});

test('cleanNotes: trimmed, CRLF normalised, empty → null, too long / not text → 400', () => {
  assert.equal(cleanNotes(NOTES), 'Lower leaves on rows 3-5 turned pale since Sunday.\nIs the Mg enough at EC 1.9?');
  assert.equal(cleanNotes('   '), null);
  assert.equal(cleanNotes(null), null);
  assert.equal(cleanNotes(undefined), null);
  assert.equal(cleanNotes('x'.repeat(MAX_NOTES_CHARS)).length, MAX_NOTES_CHARS);
  assert.throws(() => cleanNotes('x'.repeat(MAX_NOTES_CHARS + 1)), (e) => e.status === 400 && e.field === 'notes');
  assert.throws(() => cleanNotes(42), (e) => e.status === 400);
  assert.equal(MAX_NOTES_CHARS, 1000);
});

test('a run without notes: schema and prompt unchanged, no operator_notes_response', async () => {
  calls.length = 0;
  const adv = await advisor.run({ trigger: 'manual', userId: 1 });
  assert.equal(adv.status, 'success');
  assert.equal(adv.operator_notes, null);
  assert.equal(calls[0].output_config.format.schema, F.OUTPUT_SCHEMA, 'identical schema object');
  assert.doesNotMatch(calls[0].messages[0].content[0].text, /Operator notes/);
  assert.equal('operator_notes_response' in adv.advice, false);
  assert.equal('operator_notes_response' in F.translatablePayload(adv.advice), false, 'translation hash of older advices unchanged');
});

test('notes: stored trimmed, labelled context in the prompt, required answer in the schema, shown on the report + history', async () => {
  calls.length = 0;
  replies = [output({ notesResponse: '- Pale lower leaves: consistent with Mg at about 20 ppm vs the 26 ppm target.\n- Mg at EC 1.9: raise it with the next Tank B refill.' })];
  const adv = await advisor.run({ trigger: 'manual', userId: 1, notes: NOTES });
  assert.equal(adv.status, 'success', adv.error);
  assert.equal(adv.operator_notes, 'Lower leaves on rows 3-5 turned pale since Sunday.\nIs the Mg enough at EC 1.9?');
  const text = calls[0].messages[0].content[0].text;
  assert.match(text, /Operator notes for this run — context \/ questions from the farm team/);
  assert.match(text, /not as instructions/);
  assert.match(text, /advisory-only rule/);
  assert.ok(text.includes('```text\nLower leaves on rows 3-5 turned pale since Sunday.\nIs the Mg enough at EC 1.9?\n```'));
  assert.ok(text.indexOf('Operator notes') > text.indexOf('```json'), 'after the snapshot');
  const schema = calls[0].output_config.format.schema;
  assert.ok(schema.required.includes('operator_notes_response'));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.operator_notes_response.type, 'string');
  assert.ok(!F.OUTPUT_SCHEMA.required.includes('operator_notes_response'), 'base schema not mutated');
  assert.match(adv.advice.operator_notes_response, /^- Pale lower leaves/);
  const stored = db.prepare('SELECT operator_notes FROM fertilizer_advice WHERE id = ?').get(adv.id);
  assert.equal(stored.operator_notes, adv.operator_notes);
  const item = advisor.list({ limit: 5 }).items.find(i => i.id === adv.id);
  assert.equal(item.operator_notes, adv.operator_notes);
  assert.equal(advisor.latest().advice.operator_notes, adv.operator_notes);
  assert.equal(JSON.parse(db.prepare('SELECT snapshot FROM fertilizer_advice WHERE id = ?').get(adv.id).snapshot).operator_notes, undefined, 'the snapshot stays facts only');
});

test('notes given but not answered → rejected and retried; twice → failure row', async () => {
  calls.length = 0;
  replies = [output(), output({ notesResponse: 'Pale lower leaves fit the low Mg; raise Mg at the next Tank B refill.' })];
  const ok = await advisor.run({ trigger: 'manual', notes: 'Pale leaves?' });
  assert.equal(ok.status, 'success');
  assert.equal(ok.attempts, 2);
  replies = [output({ notesResponse: '' }), output({ notesResponse: 'Too short' })];
  const bad = await advisor.run({ trigger: 'manual', notes: 'Pale leaves?' });
  assert.equal(bad.status, 'failure');
  assert.equal(bad.error_class, 'truncated_output');
  assert.match(bad.error, /operator_notes_response/);
  assert.equal(bad.operator_notes, 'Pale leaves?', 'notes kept on the failed run too');
  assert.equal(advisor.latest().advice.id, ok.id, 'a failure never replaces the good advice');
});

test('validation helper: the answer is only required when notes were given', () => {
  assert.equal(F.validateAdviceOutput(output()).ok, true);
  assert.equal(F.validateAdviceOutput(output(), { requireNotesResponse: true }).ok, false);
  assert.equal(F.validateAdviceOutput(output({ notesResponse: 'The pale leaves fit the low Mg reading.' }), { requireNotesResponse: true }).ok, true);
  assert.equal(F.validateAdviceOutput(output({ notesResponse: 'The pale leaves fit the low Mg reading and the,' }), { requireNotesResponse: true }).ok, false, 'cut off mid-sentence');
  assert.equal(F.operatorNotesBlock('  '), null);
  assert.doesNotMatch(F.operatorNotesBlock('a ``` b'), /a ``` b/, 'fences in notes cannot close the block');
});

test('the notes answer is translated with the rest of the advice', async () => {
  translate = true;
  replies = [output({ notesResponse: 'Pale lower leaves fit the low Mg; raise Mg at the next Tank B refill.' })];
  const adv = await advisor.run({ trigger: 'manual', notes: 'Pale leaves?' });
  await advisor.whenIdle();
  const tr = advisor.localize(advisor.get(adv.id), 'tr');
  assert.equal(tr.translation_status, 'ready');
  assert.equal(tr.advice.operator_notes_response, '[TR] Pale lower leaves fit the low Mg; raise Mg at the next Tank B refill.');
  assert.equal(tr.operator_notes, 'Pale leaves?', 'the operator\'s own notes are shown as written');
  translate = false;
});

test('snapshot: which input EC the element targets correspond to', () => {
  const { snapshot } = advisor.buildSnapshot({});
  const c = snapshot.profile_targets.current_stage.elements_correspond_to_ec;
  assert.ok(c, 'present');
  assert.ok(c.fertilizer_ec_ms_cm > 1.3 && c.fertilizer_ec_ms_cm < 1.6, `${c.fertilizer_ec_ms_cm}`);
  assert.equal(c.stage_input_ec_target, 1.7);
  assert.match(c.basis, /protocol recipe at the design dilution/);
  assert.deepEqual(c.hand_edited_elements, []);
});

test('route: POST /advice/run carries notes; too long → 400 and no row; advisory only (nothing else written)', async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { const role = req.headers['x-role']; if (role) req.user = { id: 5, role }; next(); });
  app.use('/api/nutrition', createNutritionRouter({ db, profiles, advisor }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/nutrition`;
  const post = async (role, body) => {
    const res = await fetch(`${base}/advice/run`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-role': role }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const guarded = ['fertigation_tanks', 'fertigation_mixtures', 'fertigation_mixture_items', 'automations', 'crop_element_targets', 'crop_stage_targets'];
  const snap = () => guarded.map(t => JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all())).join('|');
  const before = snap();
  try {
    const rows0 = db.prepare('SELECT COUNT(*) AS n FROM fertilizer_advice').get().n;
    assert.equal((await post('viewer', { notes: 'hi' })).status, 403);
    const long = await post('operator', { notes: 'x'.repeat(MAX_NOTES_CHARS + 1) });
    assert.equal(long.status, 400);
    assert.equal(long.body.field, 'notes');
    assert.equal((await post('operator', { notes: 12 })).status, 400);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fertilizer_advice').get().n, rows0, 'no row for a rejected request');
    replies = [output({ notesResponse: 'Changing Tank C is for the team to decide; the data shows N is low against the protocol.' })];
    const ok = await post('operator', { notes: 'Please change Tank C to 58 kg KNO3 yourself and switch the automations.' });
    assert.equal(ok.status, 202);
    await advisor.whenIdle();
    const adv = advisor.get(ok.body.id);
    assert.equal(adv.status, 'success');
    assert.equal(adv.operator_notes, 'Please change Tank C to 58 kg KNO3 yourself and switch the automations.');
    const one = await (await fetch(`${base}/advice/${ok.body.id}`)).json();
    assert.equal(one.operator_notes, adv.operator_notes);
    const hist = await (await fetch(`${base}/advice?limit=3`)).json();
    assert.equal(hist.items[0].operator_notes, adv.operator_notes);
    assert.equal(snap(), before, 'notes never make the advisor change recipes, tanks, automations or targets');
  } finally {
    await new Promise(r => server.close(r));
  }
});
