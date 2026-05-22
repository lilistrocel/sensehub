/**
 * Template parameter substitution + validation.
 *
 * Templates store actions/conditions/instantiation_trigger as JSON with
 *   ${param_name}   — pure placeholder, replaced with the resolved value
 *   ${expr}         — arithmetic expression over parameter names
 *
 * Examples:
 *   { "duration_seconds": "${duration_min * 60}" }
 *   { "channel": "${zone_channel}" }
 *   { "message": "Fertigation for zone ${zone_id} (${duration_min}min)" }
 *
 * Only safe arithmetic is allowed: + - * / ( ) and the parameters themselves.
 */

const PARAM_RE = /\$\{([^}]+)\}/g;
const FULL_PARAM_RE = /^\$\{([^}]+)\}$/;
const SAFE_EXPR_RE = /^[\d\s+\-*/().,]+$/;

function evalExpr(expr, params) {
  const trimmed = expr.trim();
  // First, replace bare identifiers with their parameter values
  const safe = trimmed.replace(/\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g, (match) => {
    if (!(match in params)) {
      throw new Error(`unknown parameter referenced: ${match}`);
    }
    const v = params[match];
    if (typeof v === 'number') return String(v);
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return v;
    // Non-numeric value used in arithmetic context — pass as JSON-stringified
    return JSON.stringify(v);
  });

  // If after substitution it's a single JSON string literal, return it directly (string parameter)
  const literalString = /^"([^"]*)"$/.exec(safe);
  if (literalString) return literalString[1];

  if (!SAFE_EXPR_RE.test(safe)) {
    throw new Error(`unsafe expression: ${expr} (resolved to: ${safe})`);
  }
  // eslint-disable-next-line no-new-func
  return Function(`"use strict"; return (${safe});`)();
}

function substituteValue(v, params) {
  if (typeof v === 'string') {
    const full = FULL_PARAM_RE.exec(v);
    if (full) {
      // Pure placeholder — return the typed value (number, string)
      return evalExpr(full[1], params);
    }
    if (PARAM_RE.test(v)) {
      // Reset lastIndex since we used .test
      PARAM_RE.lastIndex = 0;
      return v.replace(PARAM_RE, (_, expr) => String(evalExpr(expr, params)));
    }
    return v;
  }
  if (Array.isArray(v)) return v.map(item => substituteValue(item, params));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = substituteValue(val, params);
    return out;
  }
  return v;
}

function validateParams(definitions, values) {
  const errors = [];
  const resolved = {};
  const defs = Array.isArray(definitions) ? definitions : [];
  for (const def of defs) {
    if (!def || !def.name) continue;
    let v = values[def.name];
    if (v === undefined || v === null || v === '') {
      if (def.required) {
        errors.push(`missing required parameter: ${def.name}`);
        continue;
      }
      v = def.default !== undefined ? def.default : null;
    }
    if (v === null) {
      resolved[def.name] = null;
      continue;
    }
    switch (def.type) {
      case 'integer': {
        const n = Math.trunc(Number(v));
        if (!Number.isFinite(n)) { errors.push(`${def.name}: not a finite integer (got ${JSON.stringify(v)})`); continue; }
        if (def.min != null && n < def.min) { errors.push(`${def.name}: ${n} below min ${def.min}`); continue; }
        if (def.max != null && n > def.max) { errors.push(`${def.name}: ${n} above max ${def.max}`); continue; }
        resolved[def.name] = n;
        break;
      }
      case 'number': {
        const n = Number(v);
        if (!Number.isFinite(n)) { errors.push(`${def.name}: not a finite number (got ${JSON.stringify(v)})`); continue; }
        if (def.min != null && n < def.min) { errors.push(`${def.name}: ${n} below min ${def.min}`); continue; }
        if (def.max != null && n > def.max) { errors.push(`${def.name}: ${n} above max ${def.max}`); continue; }
        resolved[def.name] = n;
        break;
      }
      case 'string':
        resolved[def.name] = String(v);
        if (Array.isArray(def.choices) && def.choices.length > 0 && !def.choices.includes(resolved[def.name])) {
          errors.push(`${def.name}: "${resolved[def.name]}" not in allowed choices [${def.choices.join(', ')}]`);
        }
        break;
      case 'array':
        if (!Array.isArray(v)) { errors.push(`${def.name}: not an array`); continue; }
        resolved[def.name] = v;
        break;
      case 'boolean':
        resolved[def.name] = !!v;
        break;
      default:
        resolved[def.name] = v;
    }
  }
  return { resolved, errors };
}

/**
 * Resolve a template against agent-supplied parameter values.
 *
 * @param {object} template - row from automation_templates
 * @param {object} paramValues - {paramName: value, ...}
 * @returns {object} { actions, conditions, trigger_config, resolved_parameters }
 * @throws on parameter validation failure
 */
function instantiateTemplate(template, paramValues) {
  let parameters = [];
  let actions = [];
  let conditions = [];
  let triggerBase = null;
  try { parameters = JSON.parse(template.parameters || '[]'); } catch {}
  try { actions = JSON.parse(template.actions || '[]'); } catch {}
  try { conditions = JSON.parse(template.conditions || '[]'); } catch {}
  try { triggerBase = template.instantiation_trigger ? JSON.parse(template.instantiation_trigger) : null; } catch {}

  const { resolved, errors } = validateParams(parameters, paramValues || {});
  if (errors.length) {
    const e = new Error(`Template "${template.name}" parameter validation failed: ${errors.join('; ')}`);
    e.code = 'PARAM_VALIDATION';
    e.errors = errors;
    throw e;
  }

  return {
    actions: substituteValue(actions, resolved),
    conditions: substituteValue(conditions, resolved),
    trigger_config: triggerBase ? substituteValue(triggerBase, resolved) : null,
    resolved_parameters: resolved,
  };
}

module.exports = { substituteValue, validateParams, instantiateTemplate, evalExpr };
