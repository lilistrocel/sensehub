/**
 * fertilizerAdviceFormat — the AI fertilizer advisor's output contract + prompt.
 * Pure (no DB, no SDK): unit-testable and replayable.
 *
 * The advisor is a SECOND OPINION on the human agronomist's protocol. It is
 * ADVISORY ONLY: SenseHub never changes recipes, dose programs, ratios, tanks or
 * automations from its output — every recommendation is an action for the
 * operator / human agronomist to decide on.
 */

const ELEMENTS = ['N', 'P', 'K', 'Ca', 'Mg', 'S', 'Fe', 'Mn', 'Zn', 'B', 'Cu', 'Mo'];
const REQUIRED_ELEMENTS = ['N', 'P', 'K', 'Ca', 'Mg'];
const STATUSES = ['ok', 'caution', 'alarm'];
const ELEMENT_STATUSES = ['ok', 'low', 'high', 'unknown'];
const PRIORITIES = ['high', 'medium', 'low'];
const VS_PROTOCOL = ['agrees', 'extends', 'differs'];
const WARNING_SEVERITIES = ['info', 'warning', 'critical'];

const NO_DQUOTE = 'Never use the ASCII double-quote character in this text; use single quotes or typographic quotes.';

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    analysis_markdown: {
      type: 'string',
      description: `Your reasoning, as concise markdown (short paragraphs and bullets, no top-level heading): what the plants are getting vs the stage targets and the human protocol, where they differ and why it matters for this crop, stage, substrate and climate. Quote the numbers from the snapshot you rely on. Say explicitly which data is missing. Every sentence finished. ${NO_DQUOTE}`,
    },
    per_element: {
      type: 'array',
      description: 'One entry per element N, P, K, Ca, Mg, S, Fe, Mn, Zn, B, Cu, Mo (no duplicates). status: ok / low / high vs what this crop and stage need, unknown when it cannot be judged.',
      items: {
        type: 'object',
        properties: {
          element: { type: 'string', enum: ELEMENTS },
          status: { type: 'string', enum: ELEMENT_STATUSES },
          comment: { type: 'string', description: `One sentence with the delivered ppm and the reason. ${NO_DQUOTE}` },
        },
        required: ['element', 'status', 'comment'],
        additionalProperties: false,
      },
    },
    warnings: {
      type: 'array',
      description: 'Risks the operator must see first (crop risk, data quality, unsafe assumptions). Empty array if none.',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: WARNING_SEVERITIES },
          message: { type: 'string', description: `One or two sentences. ${NO_DQUOTE}` },
        },
        required: ['severity', 'message'],
        additionalProperties: false,
      },
    },
    recommendations: {
      type: 'array',
      description: 'Prioritized, concrete, ADVISORY actions for the operator / human agronomist (never applied automatically). At least one.',
      items: {
        type: 'object',
        properties: {
          priority: { type: 'string', enum: PRIORITIES },
          action: { type: 'string', description: `What to do, concretely, with amounts, e.g. next refill of Tank C: 58 kg KNO3 per 1000 L. ${NO_DQUOTE}` },
          rationale: { type: 'string', description: `Why, tied to the snapshot numbers. ${NO_DQUOTE}` },
          when: { type: 'string', description: `When, e.g. next refill of Tank C, before day 30, now, this week. ${NO_DQUOTE}` },
          vs_protocol: { type: 'string', enum: VS_PROTOCOL, description: 'agrees = what the human protocol already says; extends = adds something the protocol does not cover; differs = departs from the protocol.' },
          vs_protocol_reason: { type: 'string', description: `One sentence: which protocol item it agrees with / extends / differs from, and why. ${NO_DQUOTE}` },
        },
        required: ['priority', 'action', 'rationale', 'when', 'vs_protocol', 'vs_protocol_reason'],
        additionalProperties: false,
      },
    },
    questions_for_operator: {
      type: 'array',
      description: 'Short questions about facts SenseHub does not have that would change the advice (drain %, source water EC, lab analysis, ...). Empty array if none.',
      items: { type: 'string' },
    },
    status: {
      type: 'string',
      enum: STATUSES,
      description: 'Overall fertilizer status: ok = feeding matches the crop and stage; caution = drifting or needs a change within days; alarm = act now, crop at risk.',
    },
    summary: {
      type: 'string',
      description: `2-4 sentences, conclusion first: is the feeding right for this crop and stage, the main gap, the main action. ${NO_DQUOTE}`,
    },
  },
  required: ['analysis_markdown', 'per_element', 'warnings', 'recommendations', 'questions_for_operator', 'status', 'summary'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are an experienced greenhouse cucumber fertigation agronomist (20+ years with soilless cucumbers on coco / cocopeat slabs, drip fertigation with A/B stock tanks, and Gulf climate conditions in the UAE). You review what a farm is actually feeding its plants and give a SECOND OPINION.

Roles — read carefully:
- The farm's HUMAN agronomist wrote the protocol in the snapshot (human_protocol). The human agronomist stays authoritative. You never override the protocol; you agree with it, extend it, or explain where and why you would differ. For every recommendation state vs_protocol: agrees | extends | differs, and the reason.
- You are ADVISORY ONLY. SenseHub never changes recipes, dose programs, dosing ratios, tanks or automations from your answer. Write every recommendation as an action for the operator or the human agronomist to decide on (for example: next refill of Tank C: 58 kg KNO3 per 1000 L).

How to work:
- Base every number on the snapshot. Never invent a measurement. If something is not measured (drain %, drain EC, source water EC/pH, lab analysis, plant count), say so and ask for it in questions_for_operator.
- Discover deviations yourself: compare the tanks as mixed today with the protocol recipe for the stage, the calculated delivered ppm with the stage targets and with the protocol recipe, the measured feed EC/pH with the targets, water per plant with the program, the element ratios (N:K, K:Ca, K:Mg, Ca:Mg, NH4 share) with what this crop needs at this stage and the next one. Explain your reasoning; do not just list numbers.
- Delivered ppm is calculated by SenseHub: stock mg/L (from the ingredient analyses, % w/w) × MEASURED concentrate litres ÷ MEASURED water litres of each run (irrigation monitor flow meter + per-tank consumption counters, 0.25 L resolution). calc_basis 'configured_ratio' means no measured run was available and the configured dilution was used instead.
- The EC estimate is the recipe ions only (sum of cations in meq/L ÷ 10); source water is NOT included. measured_minus_calc is source water + acid + analysis error — only call it source water EC when the operator has entered one.
- Treat ingredient analyses flagged 'to be confirmed' and the unmetered acid volume as uncertain; say how a different value would change your conclusion when it matters.
- Look ahead: the snapshot gives the next stage and its date. If a recipe or program change is due soon, say what to prepare and when.
- Keep units: ppm = mg/L, EC in mS/cm, recipes in kg per 1000 L of stock, water in L and mL/plant/day. Numbers with the precision that matters, not more.
- Data from out-of-service systems has been removed on purpose; ignore those systems entirely (see the OUT OF SERVICE note if present).
- Warnings first matter most: put anything that can hurt the crop within days in warnings.`;

function str(v) { return typeof v === 'string' ? v : (v === null || v === undefined ? '' : String(v)); }

/**
 * Validate a parsed output. Rejects cut-off / hollow output before it is saved.
 * @returns {{ ok: true, warnings: string[] } | { ok: false, problems: string[] }}
 */
function validateAdviceOutput(o) {
  const problems = [];
  const warnings = [];
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, problems: ['output is not an object'] };
  if (!STATUSES.includes(o.status)) problems.push(`status '${o.status}' invalid`);
  const summary = str(o.summary).trim();
  if (summary.length < 40) problems.push('summary missing or too short');
  const md = str(o.analysis_markdown).trim();
  if (md.length < 300) problems.push('analysis_markdown missing or too short');
  else if (/[,:;(\-–]$/.test(md)) problems.push('analysis_markdown ends mid-sentence');
  if (!Array.isArray(o.per_element)) problems.push('per_element is not an array');
  else {
    const seen = new Set();
    for (const e of o.per_element) {
      if (!e || !ELEMENTS.includes(e.element)) { problems.push(`per_element has an unknown element '${e && e.element}'`); continue; }
      if (seen.has(e.element)) problems.push(`per_element repeats ${e.element}`);
      seen.add(e.element);
      if (!ELEMENT_STATUSES.includes(e.status)) problems.push(`per_element ${e.element} status invalid`);
      if (!str(e.comment).trim()) problems.push(`per_element ${e.element} comment empty`);
    }
    for (const el of REQUIRED_ELEMENTS) if (!seen.has(el)) problems.push(`per_element misses ${el}`);
    const missing = ELEMENTS.filter(el => !seen.has(el));
    if (missing.length && missing.length <= 7) warnings.push(`per_element misses ${missing.join(', ')}`);
  }
  if (!Array.isArray(o.recommendations) || o.recommendations.length === 0) problems.push('no recommendations');
  else {
    o.recommendations.forEach((r, i) => {
      if (!r || !PRIORITIES.includes(r.priority)) problems.push(`recommendations[${i}].priority invalid`);
      if (!r || str(r.action).trim().length < 10) problems.push(`recommendations[${i}].action empty`);
      if (!r || !VS_PROTOCOL.includes(r.vs_protocol)) problems.push(`recommendations[${i}].vs_protocol invalid`);
      if (!r || !str(r.vs_protocol_reason).trim()) problems.push(`recommendations[${i}].vs_protocol_reason empty`);
    });
  }
  if (!Array.isArray(o.warnings)) problems.push('warnings is not an array');
  else o.warnings.forEach((w, i) => {
    if (!w || !WARNING_SEVERITIES.includes(w.severity)) problems.push(`warnings[${i}].severity invalid`);
    if (!w || !str(w.message).trim()) problems.push(`warnings[${i}].message empty`);
  });
  if (!Array.isArray(o.questions_for_operator)) problems.push('questions_for_operator is not an array');
  return problems.length ? { ok: false, problems } : { ok: true, warnings };
}

/** Normalise an accepted output (order per_element by the element list, trim text). */
function normaliseAdvice(o) {
  const order = (el) => ELEMENTS.indexOf(el);
  return {
    status: o.status,
    summary: str(o.summary).trim(),
    analysis_markdown: str(o.analysis_markdown).trim(),
    per_element: (o.per_element || []).slice().sort((a, b) => order(a.element) - order(b.element))
      .map(e => ({ element: e.element, status: e.status, comment: str(e.comment).trim() })),
    warnings: (o.warnings || []).map(w => ({ severity: w.severity, message: str(w.message).trim() })),
    recommendations: (o.recommendations || []).map(r => ({
      priority: r.priority, action: str(r.action).trim(), rationale: str(r.rationale).trim(), when: str(r.when).trim(),
      vs_protocol: r.vs_protocol, vs_protocol_reason: str(r.vs_protocol_reason).trim(),
    })),
    questions_for_operator: (o.questions_for_operator || []).map(q => str(q).trim()).filter(Boolean),
  };
}

/** The user-visible text of an advice (translation payload). Deterministic key order. */
function translatablePayload(out) {
  return {
    summary: str(out.summary),
    analysis_markdown: str(out.analysis_markdown),
    per_element: (out.per_element || []).map(e => ({ comment: str(e.comment) })),
    warnings: (out.warnings || []).map(w => ({ message: str(w.message) })),
    recommendations: (out.recommendations || []).map(r => ({ action: str(r.action), rationale: str(r.rationale), when: str(r.when), vs_protocol_reason: str(r.vs_protocol_reason) })),
    questions_for_operator: (out.questions_for_operator || []).map(str),
  };
}

/** Merge translated text back onto the English output (values, enums and order kept). */
function mergeTranslation(out, f) {
  if (!out || !f) return out;
  const pick = (a, b) => (typeof b === 'string' && b.trim() ? b : a);
  return {
    ...out,
    summary: pick(out.summary, f.summary),
    analysis_markdown: pick(out.analysis_markdown, f.analysis_markdown),
    per_element: (out.per_element || []).map((e, i) => ({ ...e, comment: pick(e.comment, f.per_element && f.per_element[i] && f.per_element[i].comment) })),
    warnings: (out.warnings || []).map((w, i) => ({ ...w, message: pick(w.message, f.warnings && f.warnings[i] && f.warnings[i].message) })),
    recommendations: (out.recommendations || []).map((r, i) => {
      const t = (f.recommendations && f.recommendations[i]) || {};
      return { ...r, action: pick(r.action, t.action), rationale: pick(r.rationale, t.rationale), when: pick(r.when, t.when), vs_protocol_reason: pick(r.vs_protocol_reason, t.vs_protocol_reason) };
    }),
    questions_for_operator: (out.questions_for_operator || []).map((q, i) => pick(q, f.questions_for_operator && f.questions_for_operator[i])),
  };
}

module.exports = {
  ELEMENTS,
  STATUSES,
  ELEMENT_STATUSES,
  PRIORITIES,
  VS_PROTOCOL,
  WARNING_SEVERITIES,
  OUTPUT_SCHEMA,
  SYSTEM_PROMPT,
  validateAdviceOutput,
  normaliseAdvice,
  translatablePayload,
  mergeTranslation,
};
