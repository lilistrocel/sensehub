/**
 * AutomationGuards - server-side caps and hysteresis validation for automation
 * actions. Pure functions: the caller supplies the limits and the other rules,
 * so everything here is unit-testable without a database.
 */

const DEFAULT_RELAY_LIMITS = Object.freeze({
  max_duration_seconds: 21600, // 6 h
  max_delay_seconds: 3600,     // 1 h
});

const DURATION_FIELDS = ['duration_seconds', 'auto_off_seconds'];
const DELAY_FIELDS = ['delay_seconds', 'stagger_delay_seconds'];

/** Merge stored relay_limits (JSON from system_settings) with the defaults. */
function resolveRelayLimits(stored) {
  let parsed = stored;
  if (typeof stored === 'string') { try { parsed = JSON.parse(stored); } catch (e) { parsed = null; } }
  const out = { ...DEFAULT_RELAY_LIMITS };
  if (parsed && typeof parsed === 'object') {
    for (const k of Object.keys(DEFAULT_RELAY_LIMITS)) {
      const v = Number(parsed[k]);
      if (Number.isFinite(v) && v > 0) out[k] = v;
    }
  }
  return out;
}

/** Clamp a seconds value to `max`. Returns { value, capped } — non-numeric / <=0 values pass through untouched. */
function clampSeconds(value, max) {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(n) || n <= 0) return { value, capped: false };
  if (n > max) return { value: max, capped: true };
  return { value: n, capped: false };
}

/**
 * Clamp every duration / delay field in a list of automation actions.
 * Returns a deep-ish copy (actions are cloned; nested arrays copied) plus the
 * list of fields that were capped.
 *
 * @returns {{ actions: Array, capped: Array<{index:number, field:string, requested:number, capped_to:number}> }}
 */
function clampActions(actions, limits = DEFAULT_RELAY_LIMITS) {
  const lim = resolveRelayLimits(limits);
  const capped = [];
  if (!Array.isArray(actions)) return { actions, capped };

  const out = actions.map((action, index) => {
    if (!action || typeof action !== 'object') return action;
    const copy = { ...action };
    for (const field of DURATION_FIELDS) {
      if (copy[field] === undefined) continue;
      const r = clampSeconds(copy[field], lim.max_duration_seconds);
      if (r.capped) { capped.push({ index, field, requested: Number(copy[field]), capped_to: r.value }); copy[field] = r.value; }
    }
    for (const field of DELAY_FIELDS) {
      if (copy[field] === undefined) continue;
      const r = clampSeconds(copy[field], lim.max_delay_seconds);
      if (r.capped) { capped.push({ index, field, requested: Number(copy[field]), capped_to: r.value }); copy[field] = r.value; }
    }
    return copy;
  });
  return { actions: out, capped };
}

// ---------------------------------------------------------------------------
// Hysteresis validation
// ---------------------------------------------------------------------------

function parseJson(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch (e) { return fallback; }
}

/**
 * Map "equipment:channel" -> 'on' | 'off' for the relay channels an action list
 * touches. Transition actions map each transition's state; "all channels"
 * control actions expand via getEquipment(id) when available, else use the
 * wildcard key "eq:*" (which overlaps every channel on that equipment).
 */
function actionChannelMap(actions, getEquipment) {
  const map = new Map();
  if (!Array.isArray(actions)) return map;
  for (const a of actions) {
    if (!a || typeof a !== 'object') continue;
    const eqId = parseInt(a.equipment_id, 10);
    if (!Number.isFinite(eqId)) continue;
    if (a.type === 'transition' && Array.isArray(a.transitions)) {
      for (const t of a.transitions) {
        const ch = parseInt(t.channel, 10);
        if (!Number.isFinite(ch)) continue;
        map.set(`${eqId}:${ch}`, t.state ? 'on' : 'off');
      }
    } else if (a.type === 'control' && (a.action === 'on' || a.action === 'off')) {
      if (a.channel === null || a.channel === undefined) {
        let expanded = false;
        if (typeof getEquipment === 'function') {
          const row = getEquipment(eqId);
          const mappings = row ? parseJson(row.register_mappings, []) : null;
          if (Array.isArray(mappings)) {
            for (const m of mappings) {
              if (!m || m.type !== 'coil' || m.access !== 'readwrite') continue;
              const ch = parseInt(m.register ?? m.address, 10);
              if (Number.isFinite(ch)) { map.set(`${eqId}:${ch}`, a.action); expanded = true; }
            }
          }
        }
        if (!expanded) map.set(`${eqId}:*`, a.action);
      } else {
        const ch = parseInt(a.channel, 10);
        if (Number.isFinite(ch)) map.set(`${eqId}:${ch}`, a.action);
      }
    }
  }
  return map;
}

/**
 * Normalise an automation row / request body into a threshold rule shape, or
 * null when it is not a threshold-triggered automation.
 */
function toThresholdRule(row, getEquipment) {
  if (!row) return null;
  const trigger = parseJson(row.trigger_config, {}) || {};
  if (trigger.type !== 'threshold') return null;
  const threshold = Number(trigger.threshold_value);
  if (!Number.isFinite(threshold)) return null;
  const eqId = parseInt(trigger.equipment_id, 10);
  const metric = String(trigger.sensor_type || '').trim().toLowerCase();
  if (!metric) return null;
  return {
    id: row.id ?? null,
    name: row.name || `automation ${row.id}`,
    enabled: row.enabled === undefined ? true : !!row.enabled,
    metricKey: `${Number.isFinite(eqId) ? eqId : '?'}:${metric}`,
    metricLabel: `${trigger.sensor_type}${Number.isFinite(eqId) ? ` (equipment ${eqId})` : ''}`,
    operator: String(trigger.operator || 'gt').toLowerCase(),
    threshold,
    unit: trigger.unit || '',
    channels: actionChannelMap(parseJson(row.actions, []), getEquipment),
  };
}

const OP_SYM = { gt: '>', gte: '>=', lt: '<', lte: '<=' };
const isUp = (op) => op === 'gt' || op === 'gte';
const isDown = (op) => op === 'lt' || op === 'lte';

/** Channels both rules touch where their actions are opposite: [{key, aAction, bAction}] */
function opposingChannels(a, b) {
  const out = [];
  for (const [key, aAction] of a.channels) {
    const [eq, ch] = key.split(':');
    let bAction = b.channels.get(key);
    if (bAction === undefined) bAction = b.channels.get(`${eq}:*`);
    if (bAction === undefined && ch === '*') {
      for (const [bk, bv] of b.channels) if (bk.startsWith(`${eq}:`)) { bAction = bv; break; }
    }
    if (bAction !== undefined && bAction !== aAction) out.push({ key, aAction, bAction });
  }
  return out;
}

/**
 * Check one ON rule against one OFF rule on the same metric.
 * @returns {null|object} null when fine; a violation descriptor otherwise.
 */
function checkPair(onRule, offRule, channels) {
  let ok;
  if (isUp(onRule.operator) && isDown(offRule.operator)) ok = onRule.threshold > offRule.threshold;
  else if (isDown(onRule.operator) && isUp(offRule.operator)) ok = onRule.threshold < offRule.threshold;
  else return null; // same direction or equality operators: not a hysteresis pair
  if (ok) return null;
  const chList = channels.map(c => c.key).join(', ');
  const fmt = (r) => `#${r.id ?? 'new'} "${r.name}" (${OP_SYM[r.operator] || r.operator} ${r.threshold}${r.unit})`;
  return {
    code: 'HYSTERESIS_CROSSED',
    message: `Hysteresis crossed on ${onRule.metricLabel}: ON rule ${fmt(onRule)} must be strictly beyond OFF rule ${fmt(offRule)} ` +
      `(need ON ${isUp(onRule.operator) ? '>' : '<'} OFF). Both rules switch ${chList}.`,
    on: { id: onRule.id, name: onRule.name, operator: onRule.operator, threshold: onRule.threshold },
    off: { id: offRule.id, name: offRule.name, operator: offRule.operator, threshold: offRule.threshold },
    metric: onRule.metricLabel,
    channels: channels.map(c => c.key),
  };
}

/**
 * Validate a candidate automation against the other enabled threshold rules.
 *
 * @param {object} candidate - automation row or request body ({id?, name, trigger_config, actions, enabled?})
 * @param {Array<object>} others - other automation rows (only enabled threshold rules are considered)
 * @param {Function} [getEquipment] - optional equipment lookup for "all channels" expansion
 * @returns {null|object} null when valid; the first violation otherwise
 */
function validateHysteresis(candidate, others, getEquipment) {
  const rule = toThresholdRule(candidate, getEquipment);
  if (!rule || rule.channels.size === 0) return null;

  for (const row of others || []) {
    if (!row || (candidate.id != null && Number(row.id) === Number(candidate.id))) continue;
    if (!row.enabled) continue;
    const other = toThresholdRule(row, getEquipment);
    if (!other || other.metricKey !== rule.metricKey) continue;

    const opposing = opposingChannels(rule, other);
    if (opposing.length === 0) continue;

    const ruleOn = opposing.filter(c => c.aAction === 'on');
    const ruleOff = opposing.filter(c => c.aAction === 'off');
    if (ruleOn.length) { const v = checkPair(rule, other, ruleOn); if (v) return v; }
    if (ruleOff.length) { const v = checkPair(other, rule, ruleOff); if (v) return v; }
  }
  return null;
}

module.exports = {
  DEFAULT_RELAY_LIMITS,
  resolveRelayLimits,
  clampSeconds,
  clampActions,
  actionChannelMap,
  toThresholdRule,
  validateHysteresis,
};
