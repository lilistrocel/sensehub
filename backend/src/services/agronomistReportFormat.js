/**
 * agronomistReportFormat — the agronomist report's output contract.
 *
 * Pure module (no DB, no SDK) so it can be unit-checked against saved reports:
 *   - REPORT_OUTPUT_SCHEMA         structured-output JSON schema sent to the API
 *   - REPORT_FORMAT_INSTRUCTION    appended to every system prompt (incl. overrides)
 *   - validateReportOutput()       rejects cut-off / hollow output before it is saved
 *   - composeFullMarkdown()        rebuilds full_markdown from the structured sections
 *                                  with the historical `## ` headings, so every
 *                                  full_markdown consumer keeps working
 *
 * Incident 2026-09-25 (report 182): the model wrote an unescaped `"` inside
 * full_markdown, closing the string early. The JSON stayed valid, so a
 * 1,275-char report ending "...8 min each as" with no recommendations was saved
 * as a success and overwrote the good morning version.
 */

const SECTION_STATES = ['ok', 'caution', 'alarm', 'unknown'];

// Fixed order + the headings used in full_markdown (the frontend splitter keys on them).
const SECTION_META = [
  { key: 'crop', heading: 'State of the Crop', label: 'Crop' },
  { key: 'irrigation', heading: 'Irrigation & Fertigation', label: 'Irrigation' },
  { key: 'nutrients', heading: 'Nutrient Status (AMIC + Lab)', label: 'Nutrients' },
  { key: 'risks', heading: 'Risks & Anomalies', label: 'Risks' },
];
const SECTION_KEYS = SECTION_META.map(s => s.key);
const MAX_KEY_NUMBERS = 4;

const NO_DQUOTE = 'Never use the ASCII double-quote character in this text; use single quotes or typographic quotes.';

const SECTION_SCHEMA = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: SECTION_STATES,
      description: 'ok = in range, nothing to do; caution = drifting or needs attention within days; alarm = act today / crop at risk; unknown = the data needed to judge is missing, stale or out of service.',
    },
    headline: {
      type: 'string',
      description: `One sentence stating the verdict with the key figure, conclusion first. ${NO_DQUOTE}`,
    },
    key_numbers: {
      type: 'array',
      description: `At most ${MAX_KEY_NUMBERS} figures from the data that an operator would check first. Never invented. Empty array if none apply.`,
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Short name, e.g. Drain EC, Feed volume, Max air temp.' },
          value: { type: 'string', description: 'As displayed, e.g. 2.4, ~1,176, not measured.' },
          unit: { type: 'string', description: 'e.g. mS/cm, L, °C, %; empty string if none.' },
          state: { type: 'string', enum: SECTION_STATES, description: 'Same scale as status, for this one figure; unknown when missing or stale.' },
        },
        required: ['label', 'value', 'unit', 'state'],
        additionalProperties: false,
      },
    },
    details_markdown: {
      type: 'string',
      description: `Concise markdown bullets (about 3-8; one is enough when status is unknown), conclusion first then evidence, every bullet a finished sentence. No headings. ${NO_DQUOTE}`,
    },
  },
  required: ['status', 'headline', 'key_numbers', 'details_markdown'],
  additionalProperties: false,
};

// Property order is generation order: verdicts first, history summary and
// machine-read task JSON last.
const REPORT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    opinion: {
      type: 'string',
      description: `1-2 sentence headline opinion about how the farm is doing today. Direct, no hedging. ${NO_DQUOTE}`,
    },
    sections: {
      type: 'object',
      description: 'The report body, one entry per fixed section.',
      properties: {
        crop: { ...SECTION_SCHEMA, description: 'State of the crop: growth stage, canopy photo findings, plant stress.' },
        irrigation: { ...SECTION_SCHEMA, description: 'Irrigation & fertigation: volumes, dosing channels, drain, water use.' },
        nutrients: { ...SECTION_SCHEMA, description: 'Nutrient status from AMIC + lab, every nutrient in lab[*].latest_per_nutrient with its age. unknown when the sources are out of service or absent.' },
        risks: { ...SECTION_SCHEMA, description: 'Risks & anomalies, including sensor data-quality problems and canopy findings.' },
      },
      required: SECTION_KEYS,
      additionalProperties: false,
    },
    recommendations: {
      type: 'array',
      description: 'Prioritized actionable recommendations for the operator. At least one entry.',
      items: {
        type: 'object',
        properties: {
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          action: { type: 'string', description: `What to do, concretely. ${NO_DQUOTE}` },
          rationale: { type: 'string', description: `Why, tied to today's data. ${NO_DQUOTE}` },
        },
        required: ['priority', 'action', 'rationale'],
        additionalProperties: false,
      },
    },
    recommendations_notes: {
      type: 'string',
      description: `Optional short context for the recommendations that does not fit the list; empty string if none. ${NO_DQUOTE}`,
    },
    summary: {
      type: 'string',
      description: `A self-contained ≤500-char paragraph capturing what happened today and why it matters. This becomes part of the rolling history for future reports. ${NO_DQUOTE}`,
    },
    operator_tasks_requests: {
      type: 'string',
      description: 'JSON array string of actionable tasks the human operator must do that depend on physical farm interventions — measurements, drilling drain holes, refilling tanks, calibrating sensors, etc. Use "[]" if none. Each entry is an object: {title (short, imperative), description, category ("physical"|"measurement"|"tutorial"|"config_change"), priority ("low"|"medium"|"high"|"critical"), instructions (markdown step-by-step), expected_outcome (what should be observed when done), target_entity (free text, e.g. "Tank 1", "AMIC CH1")}. These are STRUCTURED, tracked tasks with confirm/decline feedback flowing back into your next report; mention them in the relevant section so the operator understands the context. This field is JSON text, so its own quotes are required; inside the task text values use single quotes.',
    },
  },
  required: ['opinion', 'sections', 'recommendations', 'recommendations_notes', 'summary', 'operator_tasks_requests'],
  additionalProperties: false,
};

// Appended to the system prompt after the (possibly overridden) base prompt, so
// a system_prompt_override can never drop the format rules.
const REPORT_FORMAT_INSTRUCTION = `Report format (the JSON schema fixes the shape; these rules govern the content):
- Conclusion first, everywhere. Each of the four sections (crop, irrigation, nutrients, risks) opens with a status and a one-sentence headline that states the verdict with its key figure — e.g. 'Drain EC is climbing: 3.4 mS/cm, up 0.6 in 3 days.' — not a topic label.
- status: ok = within range, nothing to do; caution = drifting or needs attention within days; alarm = act today, crop at risk; unknown = the data needed to judge is missing, too stale to use, or its source is out of service. Never guess: if you cannot judge, use unknown and say why in the headline.
- key_numbers: at most ${MAX_KEY_NUMBERS} per section, the figures an operator would check first, copied from the data (never invented). value is the displayed string, unit separate ('' if none), state on the same scale for that single figure (unknown when missing or stale).
- details_markdown: concise bullets, about 3-8, each a finished sentence, conclusion first then the evidence (names, mg/L, L, °C). No headings, no preamble, no repetition of the headline. A short table only when it is clearer than bullets.
- Nutrients: cover every nutrient in lab[*].latest_per_nutrient with its age in days. If AMIC is listed as OUT OF SERVICE, do not infer feed or drain chemistry from other data: set nutrients.status to unknown (unless recent in-service lab results allow a judgement) and say plainly which source is out of service. Same when there is no nutrient data at all.
- recommendations: the prioritized action list, at least one entry (if nothing needs doing, one low-priority entry naming what to keep monitoring). recommendations_notes: short extra context or ''.
- Punctuation: never write the ASCII double-quote character (") inside any prose field (opinion, headlines, key_numbers, details_markdown, recommendations, recommendations_notes, summary) — use single quotes (') or typographic quotes (“ ”). Finish every sentence; never stop mid-sentence.`;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// A last word like this means the text was cut mid-sentence ("... 8 min each as").
// Kept short on purpose: words that end real sentences in this domain ('left on',
// 'keep as is', 'what to watch for') are not listed.
const DANGLING_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'as', 'of', 'to', 'with', 'at', 'by', 'from', 'than',
  'while', 'because', 'per', 'into', 'onto', 'between', 'its', 'their', 'these',
]);
const SENTENCE_END = /[.!?…:;)\]'’”*_`%]$/;   // after stripping trailing markdown emphasis/quotes
const OPEN_TAIL = /(["“‘(\[,\-–—=~≈+/&]|\b\w+:)$/; // ends on an opener or joiner

function lastContentLine(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').map(l => l.trimEnd());
  let inFence = false;
  let last = '';
  for (const l of lines) {
    if (/^\s*(```|~~~)/.test(l)) { inFence = !inFence; continue; }
    if (l.trim()) last = l.trim();
  }
  return { last, unclosedFence: inFence };
}

/**
 * Does `text` end like finished writing? Prose must end in sentence punctuation;
 * a trailing bullet, numbered item or table row may end on a value/unit but not
 * on a dangling word or an opening quote/comma. Returns null or a reason string.
 */
function endProblem(text) {
  const { last, unclosedFence } = lastContentLine(text);
  if (!last) return 'empty';
  if (unclosedFence) return 'unclosed code fence';
  if (last.startsWith('|')) return /\|\s*$/.test(last) ? null : 'table row cut off';
  const stars = (String(text).match(/\*\*/g) || []).length;
  if (stars % 2) return 'unbalanced bold markers';
  const isItem = /^([-*+]|\d+[.)])\s+/.test(last);
  const bare = last.replace(/[*_`]+$/, '').trim();
  if (OPEN_TAIL.test(bare)) return `ends on '${bare.slice(-12)}'`;
  const lastWord = (bare.match(/([A-Za-z]+)$/) || [])[1];
  if (lastWord && DANGLING_WORDS.has(lastWord.toLowerCase())) return `ends mid-sentence ('…${bare.slice(-24)}')`;
  if (isItem) return null;
  if (!SENTENCE_END.test(bare) && !/[0-9A-Za-z°µ]$/.test(bare)) return `ends on '${bare.slice(-12)}'`;
  if (!SENTENCE_END.test(bare)) return `prose ends without sentence punctuation ('…${bare.slice(-24)}')`;
  return null;
}

const str = v => (typeof v === 'string' ? v.trim() : '');

/**
 * Validate a parsed model output. Handles the structured shape ({ sections }) and,
 * for replaying old rows, the legacy full_markdown shape.
 * @returns {{ ok: boolean, problems: string[], warnings: string[], shape: 'structured'|'legacy' }}
 */
function validateReportOutput(parsed, { minSectionChars = 60, minDetailsChars = 30 } = {}) {
  const problems = [];
  const warnings = [];
  if (!parsed || typeof parsed !== 'object') return { ok: false, problems: ['output is not an object'], warnings, shape: null };
  const shape = parsed.sections && typeof parsed.sections === 'object' ? 'structured' : 'legacy';

  const opinion = str(parsed.opinion);
  if (opinion.length < 20) problems.push('opinion missing or too short');
  else if (endProblem(opinion)) problems.push(`opinion: ${endProblem(opinion)}`);

  const summary = str(parsed.summary);
  if (summary.length < 80) problems.push('summary missing or too short');
  else if (endProblem(summary)) problems.push(`summary: ${endProblem(summary)}`);

  const recs = Array.isArray(parsed.recommendations) ? parsed.recommendations : [];
  if (recs.length === 0) problems.push('recommendations empty');
  recs.forEach((r, i) => {
    if (str(r?.action).length < 10) problems.push(`recommendation ${i + 1}: action missing`);
    else if (endProblem(r.action) && /mid-sentence|ends on/.test(endProblem(r.action))) problems.push(`recommendation ${i + 1} action: ${endProblem(r.action)}`);
  });

  if (shape === 'structured') {
    for (const { key } of SECTION_META) {
      const s = parsed.sections[key];
      if (!s || typeof s !== 'object') { problems.push(`section ${key} missing`); continue; }
      if (!SECTION_STATES.includes(s.status)) problems.push(`section ${key}: bad status '${s.status}'`);
      const headline = str(s.headline);
      if (headline.length < 10) problems.push(`section ${key}: headline missing`);
      else {
        const p = endProblem(headline);
        if (p && /mid-sentence|ends on|fence|bold/.test(p)) problems.push(`section ${key} headline: ${p}`);
      }
      // An 'unknown' section (e.g. nutrients with AMIC + lab out of service) may
      // legitimately have nothing beyond its headline.
      const details = str(s.details_markdown);
      if (s.status !== 'unknown' && details.length < minDetailsChars) problems.push(`section ${key}: details too short (${details.length} chars)`);
      else if (details && endProblem(details)) problems.push(`section ${key} details: ${endProblem(details)}`);
      if (!Array.isArray(s.key_numbers)) problems.push(`section ${key}: key_numbers not an array`);
      else s.key_numbers.forEach((k, i) => {
        if (!str(k?.label) || !str(k?.value)) warnings.push(`section ${key}: key_number ${i + 1} incomplete`);
      });
    }
  } else {
    const md = String(parsed.full_markdown || '');
    const bodies = splitLegacySections(md);
    const want = [
      ['crop', /crop|plant|canopy/i],
      ['irrigation', /irrigat|fertigat/i],
      ['nutrients', /nutrient|amic|\blab\b/i],
      ['risks', /risk|anomal/i],
    ];
    for (const [key, re] of want) {
      const sec = bodies.find(b => re.test(b.title));
      if (!sec) { problems.push(`section ${key} missing from full_markdown`); continue; }
      if (sec.body.length < minSectionChars) problems.push(`section ${key}: too short (${sec.body.length} chars)`);
      else if (endProblem(sec.body)) problems.push(`section ${key}: ${endProblem(sec.body)}`);
    }
    const p = endProblem(md);
    if (p) problems.push(`full_markdown: ${p}`);
  }

  // Task JSON is secondary: a bad string loses the tasks, not the report.
  const t = parsed.operator_tasks_requests;
  if (typeof t === 'string' && t.trim()) {
    try {
      const arr = JSON.parse(t);
      if (!Array.isArray(arr)) warnings.push('operator_tasks_requests is not a JSON array');
    } catch (err) {
      warnings.push(`operator_tasks_requests is not valid JSON (${err.message})`);
    }
  }

  return { ok: problems.length === 0, problems, warnings, shape };
}

function splitLegacySections(md) {
  const out = [];
  let cur = null;
  let inFence = false;
  for (const line of String(md).replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) { cur = { title: m[1], lines: [] }; out.push(cur); continue; }
    if (cur) cur.lines.push(line);
  }
  return out.map(s => ({ title: s.title, body: s.lines.join('\n').trim() }));
}

// ---------------------------------------------------------------------------
// Normalisation + full_markdown composition
// ---------------------------------------------------------------------------

/** Clean the model's sections for storage: fixed keys, known states, ≤4 key numbers. */
function normaliseSections(sections) {
  if (!sections || typeof sections !== 'object') return null;
  const out = {};
  for (const { key } of SECTION_META) {
    const s = sections[key] || {};
    out[key] = {
      status: SECTION_STATES.includes(s.status) ? s.status : 'unknown',
      headline: str(s.headline),
      key_numbers: (Array.isArray(s.key_numbers) ? s.key_numbers : [])
        .filter(k => k && str(k.label))
        .slice(0, MAX_KEY_NUMBERS)
        .map(k => ({
          label: str(k.label),
          value: str(k.value),
          unit: str(k.unit),
          state: SECTION_STATES.includes(k.state) ? k.state : 'unknown',
        })),
      details_markdown: str(s.details_markdown),
    };
  }
  return out;
}

const STATUS_WORD = { ok: 'OK', caution: 'Caution', alarm: 'Alarm', unknown: 'Unknown' };

/**
 * full_markdown for a structured report: the historical `## ` headings in the
 * historical order, then `## Recommendations` holding recommendations_notes when
 * there are any (the structured list lives in the recommendations column).
 */
function composeFullMarkdown({ sections, recommendations_notes: notes }) {
  const parts = [];
  for (const { key, heading } of SECTION_META) {
    const s = sections?.[key];
    if (!s) continue;
    const lines = [`## ${heading}`, '', `**Status: ${STATUS_WORD[s.status] || 'Unknown'}** — ${s.headline || '(no headline)'}`];
    if (s.key_numbers?.length) {
      lines.push('');
      for (const k of s.key_numbers) {
        const v = [k.value, k.unit].filter(Boolean).join(' ');
        lines.push(`- **${k.label}:** ${v || '—'}${k.state && k.state !== 'ok' ? ` (${k.state})` : ''}`);
      }
    }
    if (s.details_markdown) lines.push('', s.details_markdown);
    parts.push(lines.join('\n'));
  }
  const n = str(notes);
  if (n) parts.push(`## Recommendations\n\n${n}`);
  return parts.join('\n\n');
}

module.exports = {
  REPORT_OUTPUT_SCHEMA,
  REPORT_FORMAT_INSTRUCTION,
  SECTION_META,
  SECTION_KEYS,
  SECTION_STATES,
  MAX_KEY_NUMBERS,
  validateReportOutput,
  normaliseSections,
  composeFullMarkdown,
  endProblem,
};
