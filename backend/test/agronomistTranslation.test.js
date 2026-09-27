/**
 * Agronomist report translations (tr / ar) — stubbed Anthropic client, in-memory DB.
 * No real API call is ever made.
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
const { agronomistService } = src('services', 'AgronomistService.js');
const T = src('services', 'AgronomistTranslationService.js');
const { agronomistTranslationService: svc } = T;
const { languageMiddleware } = src('middleware', 'language.js');

const quiet = { log() {}, warn() {}, error() {} };
svc.log = quiet;

// ----- fixtures ---------------------------------------------------------------

function sec(name, extra = '') {
  return {
    status: 'caution',
    headline: `${name} headline: drain EC is 3.4 mS/cm, up 0.6 in 3 days${extra}.`,
    key_numbers: [{ label: `${name} Drain EC`, value: '3.4', unit: 'mS/cm', state: 'caution' }, { label: `${name} Feed`, value: '1,176', unit: 'L', state: 'ok' }],
    details_markdown: `- ${name} detail one with Tank A 9 L and Zone 4 at 12:00${extra}.\n- ${name} detail two, EC 1.75 and pH 5.8.`,
  };
}
function reportOutput(tag = '') {
  return {
    opinion: `The farm is stable today but root-zone heat is building${tag}.`,
    sections: { crop: sec('Crop', tag), irrigation: sec('Irrigation', tag), nutrients: sec('Nutrients', tag), risks: sec('Risks', tag) },
    recommendations: [
      { priority: 'high', action: `Inspect the Zone 4 valve on relay 6 today${tag}.`, rationale: 'Five dry-run shutdowns today.' },
      { priority: 'low', action: 'Keep monitoring drain EC daily.', rationale: 'Drain EC is drifting up.' },
    ],
    recommendations_notes: `Dose ratio stays at 1:200${tag}.`,
    summary: `Stable day with 1,176 L fed across four zones; drain EC climbed to 3.4 mS/cm and Zone 4 had repeated no-flow shutdowns${tag}.`,
    operator_tasks_requests: JSON.stringify([
      { title: `Check Zone 4 valve${tag}`, description: 'The valve sticks.', category: 'physical', priority: 'high', instructions: '1. Close the manual valve.\n2. Inspect.', expected_outcome: 'Flow above 8,000 L/h.', target_entity: 'Zone 4' },
      { title: 'Calibrate the pH probe', description: null, category: 'measurement', priority: 'medium', instructions: null, expected_outcome: null, target_entity: 'AMIC CH1' },
    ]),
  };
}

// "Translator": prefixes every string value with [TR] / [AR] (keeps ids / structure).
function fakeTranslate(body) {
  const lang = /Turkish/.test(body.messages[0].content) ? 'TR' : 'AR';
  const json = /```json\n([\s\S]*)\n```/.exec(body.messages[0].content)[1];
  const payload = JSON.parse(json);
  const walk = (v, key) => {
    if (typeof v === 'string') return v ? `[${lang}] ${v}` : v;
    if (Array.isArray(v)) return v.map(x => walk(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'id' ? x : walk(x, k)]));
    return v;
  };
  return walk(payload);
}

const calls = { create: [], stream: 0 };
let createImpl = null;
let reportTag = '';
const fakeClient = {
  messages: {
    create: async (body) => {
      calls.create.push(body);
      if (createImpl) return createImpl(body, calls.create.length);
      return okResponse(body);
    },
    stream: () => {
      calls.stream++;
      const out = reportOutput(reportTag);
      return {
        on() {},
        finalMessage: async () => ({ model: 'claude-sonnet-5', stop_reason: 'end_turn', usage: { input_tokens: 20000, output_tokens: 8000 }, content: [{ type: 'text', text: JSON.stringify(out) }] }),
      };
    },
  },
};
function okResponse(body, usage = { input_tokens: 4000, output_tokens: 5000 }) {
  return { model: body.model, stop_reason: 'end_turn', usage, content: [{ type: 'text', text: JSON.stringify(fakeTranslate(body)) }] };
}
agronomistService._client = fakeClient;
// A configured agronomist (defaults: model claude-sonnet-5, translation tr + ar).
agronomistService.saveConfig({ enabled: true, model: 'claude-sonnet-5' });

function reset() { calls.create = []; calls.stream = 0; createImpl = null; }

/** Insert a successful report + tasks directly (no generate). */
function insertReport(date, tag = '') {
  const out = reportOutput(tag);
  const { normaliseSections, composeFullMarkdown } = src('services', 'agronomistReportFormat.js');
  const sections = normaliseSections(out.sections);
  const info = db.prepare(`INSERT INTO agronomist_reports (report_date, model, summary, full_markdown, recommendations, opinion, status, sections)
    VALUES (?, 'claude-sonnet-5', ?, ?, ?, ?, 'success', ?)`).run(date, out.summary, composeFullMarkdown({ sections, recommendations_notes: out.recommendations_notes }),
    JSON.stringify(out.recommendations), out.opinion, JSON.stringify(sections));
  const id = Number(info.lastInsertRowid);
  for (const t of JSON.parse(out.operator_tasks_requests)) {
    db.prepare("INSERT INTO operator_tasks (source, source_report_id, title, description, instructions, expected_outcome) VALUES ('agronomist', ?, ?, ?, ?, ?)")
      .run(id, t.title, t.description, t.instructions, t.expected_outcome);
  }
  return id;
}

// ----- HTTP harness (fake auth, real language middleware + routers) -------------
let server; let base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', languageMiddleware);
  app.use('/api', (req, res, next) => { req.user = { id: 1, role: req.headers['x-role'] || 'admin', email: 'a@b.c', name: 'A' }; next(); });
  app.use('/api/agronomist', src('routes', 'agronomist.js'));
  app.use('/api/operator-tasks', src('routes', 'operatorTasks.js'));
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise(r => server.close(r)));

async function get(url, lang = 'en', headers = {}) {
  const res = await fetch(base + url, { headers: { 'Accept-Language': lang, ...headers } });
  return { status: res.status, json: await res.json() };
}
async function post(url, body, { role = 'admin', lang = 'en' } = {}) {
  const res = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Role': role, 'Accept-Language': lang }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

// ----- unit ----------------------------------------------------------------------

test('request shape: model from config, structured output schema, effort low, thinking disabled, sized max_tokens', () => {
  const id = insertReport('2026-01-01');
  const report = db.prepare('SELECT * FROM agronomist_reports WHERE id = ?').get(id);
  const tasks = db.prepare('SELECT * FROM operator_tasks WHERE source_report_id = ?').all(id);
  const payload = T.extractPayload(report, tasks);
  assert.deepEqual(Object.keys(payload), ['opinion', 'summary', 'sections', 'recommendations_notes', 'recommendations', 'tasks']);
  assert.deepEqual(payload.sections.crop.key_number_labels, ['Crop Drain EC', 'Crop Feed']);
  assert.equal(payload.recommendations_notes, 'Dose ratio stays at 1:200.');
  assert.ok(!JSON.stringify(payload).includes('mS/cm"'), 'values / units are not sent');
  const body = T.buildRequest({ lang: 'ar', payload, model: 'claude-sonnet-5' });
  assert.equal(body.model, 'claude-sonnet-5');
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.output_config.effort, 'low');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.equal(body.output_config.format.schema.additionalProperties, false);
  assert.deepEqual(body.output_config.format.schema.required, ['opinion', 'summary', 'sections', 'recommendations_notes', 'recommendations', 'tasks']);
  assert.ok(body.max_tokens >= 2000 && body.max_tokens <= 16000);
  assert.match(body.system, /Western digits 0-9/);
  assert.match(body.system, /Modern Standard Arabic/);
  assert.match(body.system, /المرحّل/); // glossary
  // Haiku: no effort / thinking controls
  const h = T.buildRequest({ lang: 'tr', payload, model: 'claude-haiku-4-5' });
  assert.equal(h.thinking, undefined);
  assert.equal(h.output_config.effort, undefined);
});

test('cost accounting: Sonnet 5 $2 in / $10 out per MTok, cache read 0.1x, write 1.25x', () => {
  assert.equal(T.estimateCost('claude-sonnet-5', { input: 4500, output: 4500 }), 0.054);
  assert.equal(T.estimateCost('claude-sonnet-5', { input: 1e6, output: 0 }), 2);
  assert.equal(T.estimateCost('claude-sonnet-5', { input: 0, output: 1e6 }), 10);
  assert.equal(T.estimateCost('claude-sonnet-5', { cacheRead: 1e6, cacheWrite: 1e6 }), 2.7);
  assert.equal(T.estimateCost('claude-opus-5', { input: 1e6 }), 5);
  assert.equal(T.estimateCost('unknown-model', { output: 1e6 }), 10); // falls back to Sonnet 5 prices
});

test('Arabic-Indic digits in a translation are normalised to Western digits', () => {
  assert.equal(T.westernDigits('EC ١٫٧٥ و ٣٤'), 'EC 1٫75 و 34');
  assert.deepEqual(T.westernDigits({ a: ['۱۲'] }), { a: ['12'] });
});

// ----- translateReport -----------------------------------------------------------

test('success: fields, tokens and cost stored; tasks translated and served by the tasks API', async () => {
  reset();
  const id = insertReport('2026-01-02');
  const r = await svc.translateReport(id, 'tr');
  assert.equal(r.status, 'ready');
  assert.equal(calls.create.length, 1);
  const row = svc.getRow(id, 'tr');
  assert.equal(row.status, 'ready');
  assert.equal(row.input_tokens, 4000);
  assert.equal(row.output_tokens, 5000);
  assert.equal(row.cost_estimate, 0.058);
  assert.equal(row.attempts, 1);
  assert.equal(row.model, 'claude-sonnet-5');
  const f = JSON.parse(row.fields);
  assert.match(f.opinion, /^\[TR\] /);

  const tr = await get(`/api/agronomist/reports/${id}`, 'tr');
  assert.equal(tr.json.translation_status, 'ready');
  assert.equal(tr.json.translated_from, 'en');
  assert.match(tr.json.opinion, /^\[TR\] The farm/);
  assert.match(tr.json.sections.crop.headline, /^\[TR\] /);
  assert.equal(tr.json.sections.crop.key_numbers[0].label, '[TR] Crop Drain EC');
  assert.equal(tr.json.sections.crop.key_numbers[0].value, '3.4');       // values untouched
  assert.equal(tr.json.sections.crop.status, 'caution');
  assert.equal(tr.json.recommendations[0].priority, 'high');
  assert.match(tr.json.recommendations[0].action, /^\[TR\] Inspect/);
  assert.match(tr.json.full_markdown, /## State of the Crop/);            // same composer / headings
  assert.match(tr.json.full_markdown, /\[TR\] Dose ratio/);

  const orig = await get(`/api/agronomist/reports/${id}?original=1`, 'tr');
  assert.equal(orig.json.translation_status, 'original');
  assert.match(orig.json.opinion, /^The farm/);

  const en = await get(`/api/agronomist/reports/${id}`, 'en');
  assert.equal(en.json.translation_status, 'original');
  assert.match(en.json.opinion, /^The farm/);

  const byDate = await get('/api/agronomist/reports/by-date/2026-01-02', 'tr');
  assert.equal(byDate.json.translation_status, 'ready');

  const list = await get('/api/agronomist/reports?limit=100', 'tr');
  const item = list.json.find(x => x.id === id);
  assert.equal(item.translation_status, 'ready');
  assert.match(item.summary, /^\[TR\] /);

  const tasks = await get(`/api/operator-tasks?source_report_id=${id}&status=all`, 'tr');
  assert.equal(tasks.json.length, 2);
  const t1 = tasks.json.find(t => /Check Zone 4/.test(t.title));
  assert.match(t1.title, /^\[TR\] Check Zone 4 valve/);
  assert.match(t1.instructions, /^\[TR\] 1\. Close/);
  assert.equal(t1.translation_status, 'ready');
  const t2 = tasks.json.find(t => /pH probe/.test(t.title));
  assert.equal(t2.description, null, 'null stays null');
  const one = await get(`/api/operator-tasks/${t1.id}`, 'tr');
  assert.match(one.json.title, /^\[TR\] /);
  const oneOrig = await get(`/api/operator-tasks/${t1.id}?original=1`, 'tr');
  assert.equal(oneOrig.json.title, 'Check Zone 4 valve');
  const oneAr = await get(`/api/operator-tasks/${t1.id}`, 'ar');
  assert.equal(oneAr.json.title, 'Check Zone 4 valve');
  assert.equal(oneAr.json.translation_status, 'original');
});

test('retry once: a provider error then success → ready, 2 attempts, tokens summed', async () => {
  reset();
  const id = insertReport('2026-01-03');
  createImpl = (body, n) => {
    if (n === 1) { const e = new Error('overloaded'); e.status = 529; throw e; }
    return okResponse(body, { input_tokens: 4100, output_tokens: 4900 });
  };
  const r = await svc.translateReport(id, 'ar');
  assert.equal(r.status, 'ready');
  assert.equal(calls.create.length, 2);
  const row = svc.getRow(id, 'ar');
  assert.equal(row.attempts, 2);
  assert.equal(row.output_tokens, 4900);
});

test('retry once: invalid output (task ids changed) then success', async () => {
  reset();
  const id = insertReport('2026-01-04');
  createImpl = (body, n) => {
    const res = okResponse(body);
    if (n === 1) { const o = JSON.parse(res.content[0].text); o.tasks = []; res.content[0].text = JSON.stringify(o); }
    return res;
  };
  assert.equal((await svc.translateReport(id, 'tr')).status, 'ready');
  assert.equal(calls.create.length, 2);
  assert.equal(svc.getRow(id, 'tr').input_tokens, 8000, 'both attempts are billed and counted');
});

test('failure after the retry → failed row; API serves English with a localized note', async () => {
  reset();
  const id = insertReport('2026-01-05');
  createImpl = () => ({ model: 'claude-sonnet-5', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'not json' }] });
  const r = await svc.translateReport(id, 'ar');
  assert.equal(r.status, 'failed');
  assert.equal(calls.create.length, 2);
  const row = svc.getRow(id, 'ar');
  assert.equal(row.status, 'failed');
  assert.match(row.error, /invalid JSON/);
  const res = await get(`/api/agronomist/reports/${id}`, 'ar');
  assert.equal(res.json.translation_status, 'failed');
  assert.match(res.json.opinion, /^The farm/);
  assert.equal(res.json.translation_note, 'الترجمة غير متاحة حاليًا — يُعرض النص الإنجليزي الأصلي.');
  const tasks = await get(`/api/operator-tasks?source_report_id=${id}&status=all`, 'ar');
  assert.ok(tasks.json.every(t => t.translation_status === 'failed' && !/^\[AR\]/.test(t.title)));
});

test('billing errors are not retried', async () => {
  reset();
  const id = insertReport('2026-01-06');
  createImpl = () => { const e = new Error('400 Your credit balance is too low to access the Anthropic API.'); e.status = 400; throw e; };
  const r = await svc.translateReport(id, 'tr');
  assert.equal(r.status, 'failed');
  assert.equal(calls.create.length, 1);
});

test('max_tokens stop → retried with a larger budget', async () => {
  reset();
  const id = insertReport('2026-01-07');
  createImpl = (body, n) => (n === 1 ? { model: body.model, stop_reason: 'max_tokens', usage: { input_tokens: 4000, output_tokens: body.max_tokens }, content: [] } : okResponse(body));
  assert.equal((await svc.translateReport(id, 'tr')).status, 'ready');
  assert.ok(calls.create[1].max_tokens > calls.create[0].max_tokens);
});

// ----- the generate hook -----------------------------------------------------------

test('generate: English report returns before the translation; pending → ready for tr and ar; regenerate re-translates', async () => {
  reset();
  reportTag = '';
  // Hold the translation calls until released, to prove generate does not wait for them.
  let release;
  const gate = new Promise(r => { release = r; });
  createImpl = async (body) => { await gate; return okResponse(body); };

  const saved = await agronomistService.generateDailyReport('2026-02-01');
  assert.equal(saved.status, 'success');
  assert.equal(calls.stream, 1);
  // translation rows exist and are pending right away; nothing translated yet
  assert.equal(svc.getRow(saved.id, 'tr').status, 'pending');
  assert.equal(svc.getRow(saved.id, 'ar').status, 'pending');
  const pending = await get(`/api/agronomist/reports/${saved.id}`, 'tr');
  assert.equal(pending.json.translation_status, 'pending');
  assert.match(pending.json.opinion, /^The farm/);
  assert.match(pending.json.translation_note, /çevirisi hazırlanıyor/);

  release();
  await svc.whenIdle();
  assert.equal(calls.create.length, 2, 'one call per language');
  assert.equal(svc.getRow(saved.id, 'tr').status, 'ready');
  assert.equal(svc.getRow(saved.id, 'ar').status, 'ready');
  const ar = await get(`/api/agronomist/reports/${saved.id}`, 'ar');
  assert.match(ar.json.opinion, /^\[AR\] The farm/);
  const tasks = await get(`/api/operator-tasks?source_report_id=${saved.id}&status=all`, 'ar');
  assert.equal(tasks.json.length, 2);
  assert.ok(tasks.json.every(t => /^\[AR\] /.test(t.title)));

  // Regenerate (force): new English text → old translation is stale immediately, then re-translated.
  reset();
  reportTag = ' (v2)';
  let release2;
  const gate2 = new Promise(r => { release2 = r; });
  createImpl = async (body) => { await gate2; return okResponse(body); };
  const again = await agronomistService.generateDailyReport('2026-02-01', { force: true });
  assert.equal(again.id, saved.id);
  const stale = await get(`/api/agronomist/reports/${saved.id}`, 'ar');
  assert.equal(stale.json.translation_status, 'pending');
  assert.match(stale.json.opinion, /building \(v2\)\.$/);
  assert.ok(!/\[AR\]/.test(stale.json.opinion), 'never serves the translation of the previous version');
  release2();
  await svc.whenIdle();
  const fresh = await get(`/api/agronomist/reports/${saved.id}`, 'ar');
  assert.equal(fresh.json.translation_status, 'ready');
  assert.match(fresh.json.opinion, /^\[AR\] .*\(v2\)\.$/);
  // the regenerate's new tasks are translated; the old ones kept theirs
  const tasks2 = await get(`/api/operator-tasks?source_report_id=${saved.id}&status=all`, 'ar');
  assert.equal(tasks2.json.length, 4);
  assert.ok(tasks2.json.every(t => t.translation_status === 'ready'));
  reportTag = '';
});

test('a throwing translator never fails or blocks the English report', async () => {
  reset();
  const orig = svc.enqueueReport;
  svc.enqueueReport = () => { throw new Error('boom'); };
  const origErr = console.error; console.error = () => {};
  try {
    const saved = await agronomistService.generateDailyReport('2026-02-02');
    assert.equal(saved.status, 'success');
  } finally { svc.enqueueReport = orig; console.error = origErr; }

  // and a client that throws inside the background job only marks the rows failed
  reset();
  createImpl = () => { throw new Error('network down'); };
  const saved2 = await agronomistService.generateDailyReport('2026-02-03');
  assert.equal(saved2.status, 'success');
  await svc.whenIdle();
  assert.equal(svc.getRow(saved2.id, 'tr').status, 'failed');
  assert.equal(svc.getRow(saved2.id, 'ar').status, 'failed');
});

test('translation can be switched off in the agronomist config (and via env)', async () => {
  reset();
  agronomistService.saveConfig({ translation_enabled: false });
  const saved = await agronomistService.generateDailyReport('2026-02-04');
  await svc.whenIdle();
  assert.equal(svc.getRow(saved.id, 'tr'), null);
  assert.equal(calls.create.length, 0);
  agronomistService.saveConfig({ translation_enabled: true, translation_languages: ['ar'] });
  assert.deepEqual(svc.autoLanguages(), ['ar']);
  process.env.AGRONOMIST_TRANSLATION = 'off';
  assert.deepEqual(svc.autoLanguages(), []);
  delete process.env.AGRONOMIST_TRANSLATION;
  agronomistService.saveConfig({ translation_languages: ['tr', 'ar', 'fr'] });
  assert.deepEqual(agronomistService.getConfig().translation_languages, ['tr', 'ar']);
});

// ----- admin endpoint ------------------------------------------------------------------

test('POST /reports/:id/translate: validation, role, wait and queued modes', async () => {
  reset();
  const id = insertReport('2026-03-01');
  assert.equal((await post(`/api/agronomist/reports/${id}/translate`, { lang: 'fr' })).status, 400);
  assert.equal((await post(`/api/agronomist/reports/${id}/translate`, {})).status, 400);
  assert.equal((await post(`/api/agronomist/reports/${id}/translate`, { lang: 'tr' }, { role: 'operator' })).status, 403);
  assert.equal((await post('/api/agronomist/reports/999999/translate', { lang: 'tr' })).status, 404);
  const failedId = Number(db.prepare("INSERT INTO agronomist_reports (report_date, status, error, summary, full_markdown) VALUES ('2026-03-02', 'failure', 'x', '', '')").run().lastInsertRowid);
  assert.equal((await post(`/api/agronomist/reports/${failedId}/translate`, { lang: 'tr' })).status, 409);

  const w = await post(`/api/agronomist/reports/${id}/translate`, { lang: 'all', wait: true });
  assert.equal(w.status, 200);
  assert.equal(w.json.ok, true);
  assert.deepEqual(w.json.results.map(r => [r.lang, r.status]), [['tr', 'ready'], ['ar', 'ready']]);
  assert.deepEqual(w.json.statuses, { tr: 'ready', ar: 'ready' });
  assert.equal(calls.create.length, 2);

  const q = await post(`/api/agronomist/reports/${id}/translate`, { lang: 'tr' });
  assert.equal(q.status, 202);
  assert.deepEqual(q.json.queued, ['tr']);
  await svc.whenIdle();
  assert.equal(calls.create.length, 3, 'force re-translates');
});

test('older reports without a translation are served in English with translation_status original', async () => {
  const id = insertReport('2025-12-01');
  const res = await get(`/api/agronomist/reports/${id}`, 'tr');
  assert.equal(res.json.translation_status, 'original');
  assert.match(res.json.opinion, /^The farm/);
});

// ----- clarifications in any language ---------------------------------------------------

test('clarification block tells the model notes may be in any language and to answer in English', () => {
  const block = agronomistService._formatClarificationsBlock([{ created_at: '2026-09-27 10:00:00', user_name: 'Ali', message: 'pH sensörü kalibre edilmedi' }]);
  assert.match(block, /any language \(for example Turkish or Arabic\)/);
  assert.match(block, /write the whole report in English/);
  assert.match(block, /pH sensörü kalibre edilmedi/, 'the note itself is passed through untranslated');
});
