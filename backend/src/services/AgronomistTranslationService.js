/**
 * AgronomistTranslationService — Turkish / Arabic versions of the daily agronomist report.
 *
 * The agronomist keeps writing in ENGLISH (canonical: rolling history, long-term
 * memory, clarifications and the agronomist's own context stay English). Right
 * after a report is saved (generate, force-regenerate, clarification-regenerate)
 * AgronomistService calls enqueueReport(), which marks the report's tr / ar rows
 * 'pending' at once and translates them in the background — never blocking or
 * failing the English report.
 *
 * One Anthropic call per language carries only the user-visible text:
 *   opinion, summary, sections.{crop,irrigation,nutrients,risks}.{headline,
 *   key_numbers[].label, details_markdown}, recommendations[].{action, rationale},
 *   recommendations_notes, full_markdown (legacy reports without sections only),
 *   and the report's operator tasks {title, description, instructions, expected_outcome}.
 * Values, units, states, priorities, dates and ids are never sent — they are merged
 * back from the English report. Structured output (output_config.format json_schema)
 * mirrors the payload; effort 'low', thinking disabled; one retry; on failure the row
 * is 'failed' and readers get the English text with a note.
 *
 * Storage: agronomist_report_translations (report_id, lang UNIQUE; fields JSON,
 * status pending|ready|failed, source_hash of the English payload so a regenerate
 * makes an old translation stale, model, tokens summed over attempts, cost_estimate
 * USD, attempts, error). Task translations: operator_task_translations.
 *
 * No automatic backfill (it costs money): older reports are translated only on an
 * admin request (POST /api/agronomist/reports/:id/translate).
 */
const crypto = require('crypto');
const { db: defaultDb } = require('../utils/database');
const i18n = require('../i18n');
const { SECTION_KEYS, composeFullMarkdown } = require('./agronomistReportFormat');

const TRANSLATION_LANGS = ['tr', 'ar'];
const LANG_NAMES = { tr: 'Turkish', ar: 'Modern Standard Arabic' };
const MAX_ATTEMPTS = 2;
const MAX_TASKS = 20;
const MIN_MAX_TOKENS = 2000;
const MAX_MAX_TOKENS = 16000;   // non-streaming create() stays well under the SDK's ~21k limit
const RETRY_MAX_TOKENS = 20000;

// USD per million tokens (input, output). Anthropic first-party list prices.
const PRICING = {
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};
const DEFAULT_PRICING = PRICING['claude-sonnet-5'];

/** USD estimate. Cache reads bill at 0.1x input, cache writes at 1.25x (5-min cache). */
function estimateCost(model, { input = 0, output = 0, cacheRead = 0, cacheWrite = 0 } = {}) {
  const key = Object.keys(PRICING).find(k => String(model || '').startsWith(k));
  const p = key ? PRICING[key] : DEFAULT_PRICING;
  const usd = (input * p.input + output * p.output + cacheRead * p.input * 0.1 + cacheWrite * p.input * 1.25) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

const GLOSSARY = [
  ['irrigation', 'sulama', 'الري'],
  ['irrigation zone', 'sulama bölgesi', 'منطقة الري'],
  ['fertigation', 'fertigasyon', 'التسميد بالري'],
  ['dosing', 'dozlama', 'الحقن'],
  ['dosing tank', 'dozlama tankı', 'خزان الحقن'],
  ['pump', 'pompa', 'المضخة'],
  ['valve', 'vana', 'الصمام'],
  ['relay', 'röle', 'المرحّل'],
  ['flow', 'debi', 'التدفق'],
  ['drain', 'drenaj', 'الصرف'],
  ['substrate', 'substrat', 'الوسط الزراعي'],
  ['canopy', 'bitki örtüsü', 'المجموع الخضري'],
  ['Stop All', 'Tümünü Durdur', 'إيقاف الكل'],
  ['Stop irrigation', 'Sulamayı Durdur', 'إيقاف الري'],
  ['emergency stop', 'acil durdurma', 'إيقاف الطوارئ'],
  ['second opinion', 'ikinci görüş', 'رأي ثانٍ'],
  ['agronomist protocol', 'agronomistin protokolü', 'بروتوكول المهندس الزراعي'],
  ['stock solution', 'stok çözelti', 'المحلول المركّز'],
  ['dripper', 'damlatıcı', 'النقاط'],
  ['source water', 'kaynak suyu', 'مياه المصدر'],
];

const REPORT_SUBJECT = 'a daily agronomist report for a hydroponic greenhouse in the UAE';

function systemPrompt(lang, subject = REPORT_SUBJECT) {
  const col = lang === 'tr' ? 1 : 2;
  const glossary = GLOSSARY.map(g => `- ${g[0]} → ${g[col]}`).join('\n');
  return `You are a professional agronomy translator for greenhouse and farm operators. You translate ${subject} from English into ${LANG_NAMES[lang]}.

Rules:
- Translate every string value faithfully and completely. Add nothing, omit nothing, do not summarise, do not comment, do not answer questions in the text.
- Keep EXACTLY as written: every number, decimal and range; units and abbreviations (EC, pH, VPD, mS/cm, µS/cm, mg/L, ppm, L, L/h, m³, kPa, °C, %); ratios such as 1:200; tank letters (Tank A, B, C, D); zone, relay, channel, tank and equipment numbers; equipment and sensor names; product and fertiliser names; chemical formulas and element symbols (Ca, Mg, K, NO3, Na, Cl); dates and clock times (e.g. 2026-09-27, 12:00).
- Use Western digits 0-9 only${lang === 'ar' ? ' — never Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩)' : ''}.
- Keep the markdown structure identical: bullets, numbering, bold/italic markers, tables, line breaks. In full_markdown keep every line that starts with '#' unchanged in English (the app uses those headings).
- Use this farm glossary consistently:
${glossary}
- Tone: clear, direct, practical — the reader is a farm operator acting on it today.${lang === 'ar' ? '\n- Write Modern Standard Arabic; keep Latin-script names, units and numbers left as they are.' : ''}
- Return JSON with exactly the same structure, keys, array lengths and ids as the input; only the text values change.`;
}

function str(v) { return typeof v === 'string' ? v : (v === null || v === undefined ? '' : String(v)); }

/** Arabic-Indic / Persian digits → Western (operator decision), in every string of a tree. */
function westernDigits(v) {
  if (typeof v === 'string') {
    return v.replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
      .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0));
  }
  if (Array.isArray(v)) return v.map(westernDigits);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, westernDigits(x)]));
  return v;
}

function parseJson(v, dflt) {
  if (v === null || v === undefined || v === '') return dflt;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return dflt; }
}

/** Notes = the text after "## Recommendations" in a sectioned report's full_markdown. */
function notesFromMarkdown(md) {
  const m = /(?:^|\n)## Recommendations\s*\n([\s\S]*)$/.exec(str(md));
  return m ? m[1].trim() : '';
}

/**
 * The translatable payload of a report (+ its tasks). Deterministic key order,
 * so its hash identifies the English text.
 */
function extractPayload(report, tasks = []) {
  const sections = parseJson(report.sections, null);
  const recs = parseJson(report.recommendations, []);
  const payload = {
    opinion: str(report.opinion),
    summary: str(report.summary),
  };
  if (sections && typeof sections === 'object') {
    payload.sections = {};
    for (const k of SECTION_KEYS) {
      const s = sections[k] || {};
      payload.sections[k] = {
        headline: str(s.headline),
        key_number_labels: (Array.isArray(s.key_numbers) ? s.key_numbers : []).map(n => str(n && n.label)),
        details_markdown: str(s.details_markdown),
      };
    }
    payload.recommendations_notes = notesFromMarkdown(report.full_markdown);
  } else {
    payload.full_markdown = str(report.full_markdown);
  }
  payload.recommendations = (Array.isArray(recs) ? recs : []).map(r => ({ action: str(r && r.action), rationale: str(r && r.rationale) }));
  payload.tasks = tasks.slice(0, MAX_TASKS).map(t => ({
    id: Number(t.id),
    title: str(t.title),
    description: str(t.description),
    instructions: str(t.instructions),
    expected_outcome: str(t.expected_outcome),
  }));
  return payload;
}

/** Hash of the report text only (tasks excluded — they are keyed per task). */
function sourceHash(payload) {
  const { tasks: _t, ...rest } = payload;
  return crypto.createHash('sha1').update(JSON.stringify(rest)).digest('hex');
}

/** JSON schema mirroring the payload (strict: additionalProperties false, all required). */
function buildSchema(payload) {
  const S = { type: 'string' };
  const obj = (props) => ({ type: 'object', properties: props, required: Object.keys(props), additionalProperties: false });
  const props = { opinion: S, summary: S };
  if (payload.sections) {
    const sec = obj({ headline: S, key_number_labels: { type: 'array', items: S }, details_markdown: S });
    props.sections = obj(Object.fromEntries(Object.keys(payload.sections).map(k => [k, sec])));
    props.recommendations_notes = S;
  } else {
    props.full_markdown = S;
  }
  props.recommendations = { type: 'array', items: obj({ action: S, rationale: S }) };
  props.tasks = { type: 'array', items: obj({ id: { type: 'integer' }, title: S, description: S, instructions: S, expected_outcome: S }) };
  return obj(props);
}

/** max_tokens from the payload size: ~3.5 chars/token, 2.5x for tr/ar expansion + JSON, clamped. */
function maxTokensFor(payload) {
  const chars = JSON.stringify(payload).length;
  return Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, Math.ceil((chars / 3.5) * 2.5)));
}

function buildRequest({ lang, payload, model, maxTokens }) {
  const noThinkingControls = /haiku/i.test(model);
  // Thinking off where the model accepts {type:'disabled'} (Sonnet 5 / Opus 4.x / 5);
  // Opus 5.5 / Fable reject it — there effort 'low' is the only control.
  const canDisableThinking = !noThinkingControls && !/opus-5-5|fable|mythos/i.test(model);
  return {
    model,
    max_tokens: maxTokens || maxTokensFor(payload),
    system: systemPrompt(lang),
    ...(canDisableThinking ? { thinking: { type: 'disabled' } } : {}),
    output_config: {
      ...(noThinkingControls ? {} : { effort: 'low' }),
      format: { type: 'json_schema', schema: buildSchema(payload) },
    },
    messages: [{
      role: 'user',
      content: `Translate the string values of this JSON from English into ${LANG_NAMES[lang]}. Return the same JSON structure.\n\n\`\`\`json\n${JSON.stringify(payload, null, 1)}\n\`\`\``,
    }],
  };
}

/**
 * Validate a translated object against the source payload.
 * @returns {{ok:true, fields} | {ok:false, message}}
 */
function validateTranslation(payload, out) {
  if (!out || typeof out !== 'object') return { ok: false, message: 'not an object' };
  const problems = [];
  const need = (src, dst, path) => {
    if (src && !str(dst).trim()) problems.push(`${path} empty`);
  };
  need(payload.opinion, out.opinion, 'opinion');
  need(payload.summary, out.summary, 'summary');
  if (payload.sections) {
    for (const k of Object.keys(payload.sections)) {
      const s = payload.sections[k];
      const d = out.sections && out.sections[k];
      if (!d) { problems.push(`sections.${k} missing`); continue; }
      need(s.headline, d.headline, `sections.${k}.headline`);
      need(s.details_markdown, d.details_markdown, `sections.${k}.details_markdown`);
      if (!Array.isArray(d.key_number_labels) || d.key_number_labels.length !== s.key_number_labels.length) problems.push(`sections.${k}.key_number_labels length`);
    }
    need(payload.recommendations_notes, out.recommendations_notes, 'recommendations_notes');
  } else {
    need(payload.full_markdown, out.full_markdown, 'full_markdown');
  }
  if (!Array.isArray(out.recommendations) || out.recommendations.length !== payload.recommendations.length) problems.push('recommendations length');
  else payload.recommendations.forEach((r, i) => { need(r.action, out.recommendations[i].action, `recommendations[${i}].action`); });
  const want = payload.tasks.map(t => t.id).join(',');
  const got = Array.isArray(out.tasks) ? out.tasks.map(t => Number(t && t.id)).join(',') : null;
  if (got !== want) problems.push('tasks ids differ');
  else payload.tasks.forEach((t, i) => need(t.title, out.tasks[i].title, `tasks[${i}].title`));
  return problems.length ? { ok: false, message: problems.slice(0, 6).join('; ') } : { ok: true, fields: westernDigits(out) };
}

// ---------------------------------------------------------------------------
// Generic payload translation (used by the fertilizer advisor): any JSON of
// strings / arrays / objects is translated value by value, same shape back.
// ---------------------------------------------------------------------------

/** Strict JSON schema mirroring an arbitrary payload (arrays typed by their first item). */
function genericSchema(v) {
  if (Array.isArray(v)) return { type: 'array', items: v.length ? genericSchema(v[0]) : { type: 'string' } };
  if (v && typeof v === 'object') {
    const props = {};
    for (const [k, x] of Object.entries(v)) props[k] = genericSchema(x);
    return { type: 'object', properties: props, required: Object.keys(props), additionalProperties: false };
  }
  if (typeof v === 'number') return { type: Number.isInteger(v) ? 'integer' : 'number' };
  return { type: 'string' };
}

/** Same keys, same array lengths, no empty string where the English has text. */
function validateGenericTranslation(payload, out) {
  const problems = [];
  const walk = (src, dst, path) => {
    if (Array.isArray(src)) {
      if (!Array.isArray(dst) || dst.length !== src.length) { problems.push(`${path} length`); return; }
      src.forEach((x, i) => walk(x, dst[i], `${path}[${i}]`));
    } else if (src && typeof src === 'object') {
      if (!dst || typeof dst !== 'object') { problems.push(`${path} missing`); return; }
      for (const k of Object.keys(src)) walk(src[k], dst[k], path ? `${path}.${k}` : k);
    } else if (typeof src === 'string') {
      if (src.trim() && !str(dst).trim()) problems.push(`${path} empty`);
    }
  };
  walk(payload, out, '');
  return problems.length ? { ok: false, message: problems.slice(0, 6).join('; ') } : { ok: true, fields: westernDigits(out) };
}

function buildGenericRequest({ lang, payload, model, maxTokens, subject }) {
  const req = buildRequest({ lang, payload, model, maxTokens });
  req.system = systemPrompt(lang, subject);
  req.output_config = { ...req.output_config, format: { type: 'json_schema', schema: genericSchema(payload) } };
  return req;
}

/**
 * Translate a payload into `lang` (sync with the API; never throws).
 * @returns {Promise<{status:'ready'|'failed', fields?, error?, input, output, cost, attempts, model}>}
 */
async function translatePayload({ client, lang, payload, model, subject, log = console }) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let maxTokens = maxTokensFor(payload);
  let lastError = null;
  let attempts = 0;
  let usedModel = model;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attempts = attempt;
    let response;
    try {
      response = await client.messages.create(buildGenericRequest({ lang, payload, model, maxTokens, subject }));
    } catch (e) {
      lastError = String(e && e.message || e);
      const status = e && (e.status || e.statusCode);
      if (status === 401 || status === 403 || /credit balance/i.test(lastError)) break;
      continue;
    }
    const u = response.usage || {};
    totals.input += u.input_tokens || 0;
    totals.output += u.output_tokens || 0;
    totals.cacheRead += u.cache_read_input_tokens || 0;
    totals.cacheWrite += u.cache_creation_input_tokens || 0;
    usedModel = response.model || model;
    if (response.stop_reason === 'max_tokens') { lastError = `output hit max_tokens (${maxTokens})`; maxTokens = Math.min(RETRY_MAX_TOKENS, maxTokens * 2); continue; }
    if (response.stop_reason !== 'end_turn') { lastError = `unexpected stop_reason '${response.stop_reason}'`; continue; }
    const text = (response.content || []).find(b => b.type === 'text');
    let parsed;
    try { parsed = JSON.parse(text && text.text); } catch (e) { lastError = `invalid JSON: ${e.message}`; continue; }
    const v = validateGenericTranslation(payload, parsed);
    if (!v.ok) { lastError = `invalid translation: ${v.message}`; continue; }
    const cost = estimateCost(usedModel, totals);
    return { status: 'ready', fields: v.fields, input: totals.input + totals.cacheRead + totals.cacheWrite, output: totals.output, cost, attempts, model: usedModel };
  }
  if (log && log.error) log.error(`[Translation] ${lang} failed after ${attempts} attempt(s): ${lastError}`);
  return { status: 'failed', error: lastError || 'unknown error', input: totals.input + totals.cacheRead + totals.cacheWrite, output: totals.output, cost: estimateCost(usedModel, totals), attempts, model: usedModel };
}

class AgronomistTranslationService {
  /**
   * @param {object} [deps]
   * @param {object} [deps.db]
   * @param {Function} [deps.getClient]   () => Anthropic client (throws when no API key)
   * @param {Function} [deps.getConfig]   () => agronomist config ({ model, translation_enabled, translation_languages })
   * @param {object} [deps.log]
   */
  constructor(deps = {}) {
    this.db = deps.db || defaultDb;
    this._getClient = deps.getClient || (() => require('./AgronomistService').agronomistService._client_or_throw());
    this._getConfig = deps.getConfig || (() => require('./AgronomistService').agronomistService.getConfig());
    this.log = deps.log || console;
    this._pending = new Set();
    this._running = new Map(); // `${reportId}:${lang}` -> promise
  }

  // ---------- settings ----------

  /** Languages translated automatically after each report ([] = off). */
  autoLanguages() {
    if (/^(0|off|false|no)$/i.test(String(process.env.AGRONOMIST_TRANSLATION || ''))) return [];
    let cfg = {};
    try { cfg = this._getConfig() || {}; } catch (_) { cfg = {}; }
    if (cfg.translation_enabled === false) return [];
    const langs = Array.isArray(cfg.translation_languages) ? cfg.translation_languages : TRANSLATION_LANGS;
    return langs.filter(l => TRANSLATION_LANGS.includes(l));
  }

  _model() {
    let cfg = {};
    try { cfg = this._getConfig() || {}; } catch (_) { cfg = {}; }
    return cfg.model || 'claude-sonnet-5';
  }

  // ---------- data ----------

  _report(reportId) {
    return this.db.prepare('SELECT id, report_date, status, opinion, summary, full_markdown, recommendations, sections FROM agronomist_reports WHERE id = ?').get(reportId) || null;
  }

  _tasks(reportId, lang, force) {
    const rows = this.db.prepare(`
      SELECT t.id, t.title, t.description, t.instructions, t.expected_outcome FROM operator_tasks t
      WHERE t.source_report_id = ? ${force ? '' : 'AND NOT EXISTS (SELECT 1 FROM operator_task_translations x WHERE x.task_id = t.id AND x.lang = ?)'}
      ORDER BY t.id ASC LIMIT ?
    `);
    return force ? rows.all(reportId, MAX_TASKS) : rows.all(reportId, lang, MAX_TASKS);
  }

  getRow(reportId, lang) {
    try {
      return this.db.prepare('SELECT * FROM agronomist_report_translations WHERE report_id = ? AND lang = ?').get(reportId, lang) || null;
    } catch (_) { return null; }
  }

  _setPending(reportId, lang) {
    this.db.prepare(`
      INSERT INTO agronomist_report_translations (report_id, lang, status, updated_at)
      VALUES (?, ?, 'pending', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(report_id, lang) DO UPDATE SET status = 'pending', error = NULL, updated_at = excluded.updated_at
    `).run(reportId, lang);
  }

  _saveResult(reportId, lang, r) {
    this.db.prepare(`
      INSERT INTO agronomist_report_translations
        (report_id, lang, fields, status, source_hash, model, input_tokens, output_tokens, cost_estimate, attempts, error, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(report_id, lang) DO UPDATE SET
        fields = COALESCE(excluded.fields, agronomist_report_translations.fields),
        status = excluded.status, source_hash = COALESCE(excluded.source_hash, agronomist_report_translations.source_hash),
        model = excluded.model, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
        cost_estimate = excluded.cost_estimate, attempts = excluded.attempts, error = excluded.error,
        updated_at = excluded.updated_at
    `).run(reportId, lang, r.fields ? JSON.stringify(r.fields) : null, r.status, r.sourceHash || null, r.model || null,
      r.input ?? null, r.output ?? null, r.cost ?? null, r.attempts ?? 0, r.error || null);
  }

  _saveTasks(reportId, lang, tasks) {
    const up = this.db.prepare(`
      INSERT INTO operator_task_translations (task_id, lang, fields, report_id) VALUES (?, ?, ?, ?)
      ON CONFLICT(task_id, lang) DO UPDATE SET fields = excluded.fields, report_id = excluded.report_id,
        created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `);
    const tx = this.db.transaction(() => {
      for (const t of tasks) {
        const { id, ...fields } = t;
        try { up.run(id, lang, JSON.stringify(fields), reportId); } catch (_) { /* task deleted meanwhile */ }
      }
    });
    tx();
  }

  // ---------- translate ----------

  /**
   * Translate one report into one language (sync with the API; never throws).
   * @returns {Promise<{status:'ready'|'failed'|'skipped', error?:string, cost?:number, input?:number, output?:number}>}
   */
  async translateReport(reportId, lang, { force = false } = {}) {
    try {
      if (!TRANSLATION_LANGS.includes(lang)) return { status: 'skipped', error: `unsupported language ${lang}` };
      const report = this._report(reportId);
      if (!report || report.status !== 'success') return { status: 'skipped', error: 'report not found or not successful' };
      const tasks = this._tasks(reportId, lang, force);
      const payload = extractPayload(report, tasks);
      const hash = sourceHash(payload);
      const existing = this.getRow(reportId, lang);
      if (!force && existing && existing.status === 'ready' && existing.source_hash === hash && tasks.length === 0) {
        return { status: 'ready', cached: true };
      }
      const model = this._model();
      let client;
      try { client = this._getClient(); } catch (e) {
        const error = String(e && e.message || e);
        this._saveResult(reportId, lang, { status: 'failed', error, model, attempts: 0 });
        return { status: 'failed', error };
      }
      const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      let maxTokens = maxTokensFor(payload);
      let lastError = null;
      let attempts = 0;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        attempts = attempt;
        let response;
        try {
          response = await client.messages.create(buildRequest({ lang, payload, model, maxTokens }));
        } catch (e) {
          lastError = String(e && e.message || e);
          const status = e && (e.status || e.statusCode);
          // billing / auth errors will not heal on a retry seconds later
          if (status === 401 || status === 403 || /credit balance/i.test(lastError)) break;
          continue;
        }
        const u = response.usage || {};
        totals.input += u.input_tokens || 0;
        totals.output += u.output_tokens || 0;
        totals.cacheRead += u.cache_read_input_tokens || 0;
        totals.cacheWrite += u.cache_creation_input_tokens || 0;
        if (response.stop_reason === 'max_tokens') {
          lastError = `output hit max_tokens (${maxTokens})`;
          maxTokens = Math.min(RETRY_MAX_TOKENS, maxTokens * 2);
          continue;
        }
        if (response.stop_reason !== 'end_turn') { lastError = `unexpected stop_reason '${response.stop_reason}'`; continue; }
        const text = (response.content || []).find(b => b.type === 'text');
        let parsed;
        try { parsed = JSON.parse(text && text.text); } catch (e) { lastError = `invalid JSON: ${e.message}`; continue; }
        const v = validateTranslation(payload, parsed);
        if (!v.ok) { lastError = `invalid translation: ${v.message}`; continue; }
        const { tasks: tTasks = [], ...fields } = v.fields;
        const cost = estimateCost(response.model || model, totals);
        // A regenerate while this call was in flight changes the English text: do not store a stale 'ready'.
        const nowReport = this._report(reportId);
        const nowHash = nowReport ? sourceHash(extractPayload(nowReport, [])) : null;
        const stale = nowHash !== sourceHash({ ...payload, tasks: [] });
        this._saveResult(reportId, lang, {
          status: stale ? 'pending' : 'ready', fields, sourceHash: hash, model: response.model || model,
          input: totals.input + totals.cacheRead + totals.cacheWrite, output: totals.output, cost, attempts,
        });
        this._saveTasks(reportId, lang, tTasks);
        this.log.log(`[AgronomistTranslation] report ${reportId} ${lang}: ${stale ? 'stale (regenerated meanwhile)' : 'ready'}`
          + ` in=${totals.input} out=${totals.output} attempts=${attempts} ~$${cost.toFixed(4)}`);
        return { status: stale ? 'pending' : 'ready', cost, input: totals.input, output: totals.output, attempts };
      }
      const cost = estimateCost(model, totals);
      this._saveResult(reportId, lang, {
        status: 'failed', error: lastError || 'unknown error', model, input: totals.input + totals.cacheRead + totals.cacheWrite,
        output: totals.output, cost, attempts,
      });
      this.log.error(`[AgronomistTranslation] report ${reportId} ${lang} failed after ${attempts} attempt(s): ${lastError}`);
      return { status: 'failed', error: lastError, cost, attempts };
    } catch (e) {
      this.log.error(`[AgronomistTranslation] report ${reportId} ${lang} crashed: ${e.message}`);
      try { this._saveResult(reportId, lang, { status: 'failed', error: e.message, attempts: 0 }); } catch (_) { /* db gone */ }
      return { status: 'failed', error: e.message };
    }
  }

  /**
   * Mark the report's translations pending now and translate in the background.
   * Never throws, never awaits the API. Called right after the English report is saved.
   * @returns {string[]} languages queued
   */
  enqueueReport(reportId, { langs = null, force = false, reason = 'generate' } = {}) {
    try {
      const list = (langs || this.autoLanguages()).filter(l => TRANSLATION_LANGS.includes(l));
      if (!reportId || !list.length) return [];
      for (const lang of list) this._setPending(reportId, lang);
      const run = async () => {
        for (const lang of list) {
          const key = `${reportId}:${lang}`;
          // one call at a time per report+language; a later enqueue re-checks the hash after it
          while (this._running.has(key)) { try { await this._running.get(key); } catch (_) { /* logged */ } }
          const p = this.translateReport(reportId, lang, { force });
          this._running.set(key, p);
          try { await p; } finally { if (this._running.get(key) === p) this._running.delete(key); }
        }
      };
      const p = new Promise(resolve => setImmediate(resolve)).then(run)
        .catch(e => this.log.error(`[AgronomistTranslation] ${reason} queue for report ${reportId} failed: ${e.message}`))
        .finally(() => this._pending.delete(p));
      this._pending.add(p);
      this.log.log(`[AgronomistTranslation] report ${reportId} (${reason}): queued ${list.join(', ')}`);
      return list;
    } catch (e) {
      this.log.error(`[AgronomistTranslation] enqueue failed for report ${reportId}: ${e.message}`);
      return [];
    }
  }

  /** Tests / shutdown: resolves when every queued translation finished. */
  async whenIdle() {
    while (this._pending.size) await Promise.allSettled([...this._pending]);
  }

  // ---------- read side ----------

  _note(lang, status) {
    if (status === 'pending') return i18n.t(lang, 'agronomist.translation_pending_note');
    if (status === 'failed') return i18n.t(lang, 'common.translation_failed_note');
    return null;
  }

  /** Effective status of a stored row against the report's current English text. */
  _status(row, report) {
    if (!row) return 'original';
    if (row.status === 'ready') {
      const hash = sourceHash(extractPayload(report, []));
      return row.source_hash === hash ? 'ready' : 'pending';
    }
    return row.status;
  }

  /** { tr: status, ar: status } for a report (admin / UI hint). */
  statuses(report) {
    const out = {};
    for (const l of TRANSLATION_LANGS) out[l] = this._status(this.getRow(report.id, l), report);
    return out;
  }

  /**
   * A report object (getReportById / getReportByDate shape) in `lang`.
   * English, ?original=1, or no usable translation → English fields.
   * Adds translation_status ('ready'|'pending'|'failed'|'original'), translated_from,
   * translation_note (pending / failed, in `lang`), translation_language.
   */
  localizeReport(report, lang, { original = false } = {}) {
    if (!report) return report;
    const L = i18n.normalizeLang(lang) || 'en';
    if (L === 'en' || original || !TRANSLATION_LANGS.includes(L) || report.status !== 'success') {
      return { ...report, translation_status: 'original', translated_from: null, translation_note: null, translation_language: 'en' };
    }
    const row = this.getRow(report.id, L);
    const status = this._status(row, report);
    if (status !== 'ready') {
      return {
        ...report, translation_status: status, translated_from: null,
        translation_note: this._note(L, status), translation_language: 'en',
      };
    }
    const f = parseJson(row.fields, {});
    const out = { ...report };
    if (f.opinion) out.opinion = f.opinion;
    if (f.summary) out.summary = f.summary;
    const recs = Array.isArray(report.recommendations) ? report.recommendations : parseJson(report.recommendations, []);
    if (Array.isArray(f.recommendations) && Array.isArray(recs) && f.recommendations.length === recs.length) {
      out.recommendations = recs.map((r, i) => ({ ...r, action: f.recommendations[i].action || r.action, rationale: f.recommendations[i].rationale || r.rationale }));
    }
    const sections = report.sections && typeof report.sections === 'object' ? report.sections : parseJson(report.sections, null);
    if (sections && f.sections) {
      const merged = {};
      for (const k of Object.keys(sections)) {
        const s = sections[k] || {};
        const t = f.sections[k] || {};
        const labels = Array.isArray(t.key_number_labels) ? t.key_number_labels : [];
        merged[k] = {
          ...s,
          headline: t.headline || s.headline,
          details_markdown: t.details_markdown || s.details_markdown,
          key_numbers: (s.key_numbers || []).map((n, i) => ({ ...n, label: labels[i] || n.label })),
        };
      }
      out.sections = merged;
      out.recommendations_notes = f.recommendations_notes ?? '';
      // Same composer (and `## ` headings) as the English report, so full_markdown consumers keep working.
      out.full_markdown = composeFullMarkdown({ sections: merged, recommendations_notes: f.recommendations_notes });
    } else if (f.full_markdown) {
      out.full_markdown = f.full_markdown;
    }
    return {
      ...out, translation_status: 'ready', translated_from: 'en', translation_note: null,
      translation_language: L, translation_model: row.model || null, translated_at: row.updated_at || row.created_at,
    };
  }

  /** listReports() rows (opinion / summary only) in `lang`. */
  localizeReportList(rows, lang, { original = false } = {}) {
    const L = i18n.normalizeLang(lang) || 'en';
    if (!Array.isArray(rows)) return rows;
    if (L === 'en' || original || !TRANSLATION_LANGS.includes(L)) return rows.map(r => ({ ...r, translation_status: 'original' }));
    return rows.map(r => {
      if (r.status !== 'success') return { ...r, translation_status: 'original' };
      const full = this._report(r.id);
      const loc = full ? this.localizeReport({ ...full, recommendations: parseJson(full.recommendations, []), sections: parseJson(full.sections, null) }, L) : null;
      if (!loc || loc.translation_status !== 'ready') {
        return { ...r, translation_status: loc ? loc.translation_status : 'original', translation_note: loc ? loc.translation_note : null };
      }
      return { ...r, opinion: loc.opinion, summary: loc.summary, translation_status: 'ready', translated_from: 'en' };
    });
  }

  /**
   * operator_tasks rows in `lang`: title / description / instructions / expected_outcome
   * from operator_task_translations when present. translation_status: 'ready' (translated),
   * 'pending' / 'failed' (the source report's translation state), 'original'.
   */
  localizeTasks(tasks, lang, { original = false } = {}) {
    const L = i18n.normalizeLang(lang) || 'en';
    const list = Array.isArray(tasks) ? tasks : [tasks];
    let out;
    if (L === 'en' || original || !TRANSLATION_LANGS.includes(L)) {
      out = list.map(t => (t ? { ...t, translation_status: 'original' } : t));
    } else {
      const ids = list.filter(Boolean).map(t => t.id);
      const tr = new Map();
      const rep = new Map();
      if (ids.length) {
        try {
          const q = this.db.prepare(`SELECT task_id, fields FROM operator_task_translations WHERE lang = ? AND task_id IN (${ids.map(() => '?').join(',')})`);
          for (const r of q.all(L, ...ids)) tr.set(r.task_id, parseJson(r.fields, {}));
          const rids = [...new Set(list.filter(t => t && t.source_report_id).map(t => t.source_report_id))];
          if (rids.length) {
            const q2 = this.db.prepare(`SELECT report_id, status FROM agronomist_report_translations WHERE lang = ? AND report_id IN (${rids.map(() => '?').join(',')})`);
            for (const r of q2.all(L, ...rids)) rep.set(r.report_id, r.status);
          }
        } catch (_) { /* tables missing → English */ }
      }
      out = list.map(t => {
        if (!t) return t;
        const f = tr.get(t.id);
        if (f) {
          return {
            ...t,
            title: f.title || t.title,
            description: t.description ? (f.description || t.description) : t.description,
            instructions: t.instructions ? (f.instructions || t.instructions) : t.instructions,
            expected_outcome: t.expected_outcome ? (f.expected_outcome || t.expected_outcome) : t.expected_outcome,
            translation_status: 'ready', translated_from: 'en',
          };
        }
        const st = t.source === 'agronomist' && rep.get(t.source_report_id);
        const status = st === 'pending' || st === 'failed' ? st : 'original';
        return { ...t, translation_status: status, translation_note: this._note(L, status) };
      });
    }
    return Array.isArray(tasks) ? out : out[0];
  }
}

const agronomistTranslationService = new AgronomistTranslationService();

module.exports = {
  agronomistTranslationService,
  AgronomistTranslationService,
  TRANSLATION_LANGS,
  extractPayload,
  sourceHash,
  buildSchema,
  buildRequest,
  validateTranslation,
  estimateCost,
  maxTokensFor,
  systemPrompt,
  westernDigits,
  PRICING,
  LANG_NAMES,
  genericSchema,
  validateGenericTranslation,
  buildGenericRequest,
  translatePayload,
};
