/**
 * SkipEvaluator — decides whether a scheduled automation should be skipped at trigger time,
 * based on:
 *   1) the active plan's targets[] + the automation's template.target_effects (auto-derived skip)
 *   2) manual skip_conditions[] declared on the automation itself
 *
 * Skip is conservative: requires sensor value to be CLEARLY past the band (10% margin) for auto-skip.
 * Stale sensor readings (> 10 min old) bypass auto-skip evaluation entirely — the automation runs.
 *
 * Result shapes:
 *   { skip: false }                              — run normally
 *   { skip: false, stale_sensor: true, reason }  — sensor too old to trust, ran normally
 *   { skip: true, reason, source, target_key?, sensor_value, sensor_age_ms }
 */

const { db } = require('../utils/database');

const STALE_SENSOR_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes
const BAND_MARGIN_PCT = 0.10;                    // 10% of band width

function evaluateSkip(automation, opts = {}) {
  const now = Date.now();
  const tz = opts.tz || process.env.TZ || 'UTC';
  const localDateStr = opts.localDateStr || _localDateStr(new Date(), tz);

  // ----- 1) Manual skip_conditions[] on the automation itself -----
  let manualConditions = [];
  try { manualConditions = JSON.parse(automation.skip_conditions || '[]'); } catch {}
  for (const c of manualConditions) {
    if (!c || !c.sensor_equipment_id || !c.operator || c.value == null) continue;
    const reading = _latestReading(c.sensor_equipment_id, c.sensor_metric || '');
    if (!reading) continue;
    const ageMs = now - reading.timestamp;
    if (ageMs > STALE_SENSOR_MAX_AGE_MS) {
      // Stale — don't trust manual skip rules either. Run, log staleness.
      return {
        skip: false,
        stale_sensor: true,
        reason: `Manual skip_condition bypassed: sensor reading for ${c.sensor_metric || 'value'} is ${Math.round(ageMs/60000)}min old`,
      };
    }
    if (_compare(reading.value, c.operator, Number(c.value))) {
      return {
        skip: true,
        source: 'manual',
        reason: c.reason || `${c.sensor_metric || 'sensor'} ${c.operator} ${c.value} (current: ${roundN(reading.value, 2)})`,
        sensor_value: reading.value,
        sensor_age_ms: ageMs,
      };
    }
  }

  // ----- 2) Target-derived auto-skip via template.target_effects -----
  if (!automation.template_id) return { skip: false };

  const tpl = db.prepare('SELECT target_effects FROM automation_templates WHERE id = ?').get(automation.template_id);
  let effects = [];
  try { effects = JSON.parse(tpl?.target_effects || '[]'); } catch {}
  if (effects.length === 0) return { skip: false };

  const plan = _getActivePlanForToday(localDateStr);
  if (!plan || !plan.proposed_plan?.targets) return { skip: false };

  const targets = plan.proposed_plan.targets;

  for (const effect of effects) {
    if (!effect || effect.direction === 'neutral') continue;
    if (effect.direction !== 'raise' && effect.direction !== 'lower') continue;

    // Find a target whose sensor_metric matches this effect's metric_name (case-insensitive)
    const target = targets.find(t => normalize(t.sensor_metric) === normalize(effect.metric_name));
    if (!target) continue;

    const reading = _latestReading(target.sensor_equipment_id, target.sensor_metric);
    if (!reading) continue;
    const ageMs = now - reading.timestamp;
    if (ageMs > STALE_SENSOR_MAX_AGE_MS) {
      return {
        skip: false,
        stale_sensor: true,
        reason: `Target-derived skip bypassed: ${target.sensor_metric} reading is ${Math.round(ageMs/60000)}min old`,
      };
    }

    const min = Number(target.min);
    const max = Number(target.max);
    if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
    const margin = (max - min) * BAND_MARGIN_PCT;
    const cur = reading.value;

    if (effect.direction === 'raise' && cur >= max + margin) {
      return {
        skip: true,
        source: 'target',
        target_key: target.key,
        reason: `${target.sensor_metric}=${roundN(cur, 2)} already past target max ${max} (margin ${roundN(margin, 2)}). Running would push higher.`,
        sensor_value: cur,
        sensor_age_ms: ageMs,
      };
    }
    if (effect.direction === 'lower' && cur <= min - margin) {
      return {
        skip: true,
        source: 'target',
        target_key: target.key,
        reason: `${target.sensor_metric}=${roundN(cur, 2)} already below target min ${min} (margin ${roundN(margin, 2)}). Running would push lower.`,
        sensor_value: cur,
        sensor_age_ms: ageMs,
      };
    }
  }

  return { skip: false };
}

// ----- helpers -----

function _latestReading(equipmentId, metric) {
  if (!equipmentId) return null;
  let row;
  // ORDER BY datetime() handles both "2026-05-14T11:46:12Z" and "2026-05-14 11:46:12" formats consistently.
  if (metric && metric.trim()) {
    row = db.prepare(
      "SELECT value, timestamp FROM readings WHERE equipment_id = ? AND name = ? ORDER BY datetime(timestamp) DESC LIMIT 1"
    ).get(equipmentId, metric);
  } else {
    row = db.prepare(
      "SELECT value, timestamp FROM readings WHERE equipment_id = ? AND (name IS NULL OR name = '' OR name = '_value') ORDER BY datetime(timestamp) DESC LIMIT 1"
    ).get(equipmentId);
  }
  if (!row) return null;
  const tsStr = row.timestamp.includes('T') ? row.timestamp : row.timestamp.replace(' ', 'T') + 'Z';
  const tms = new Date(tsStr).getTime();
  const value = Number(row.value);
  if (!Number.isFinite(tms) || !Number.isFinite(value)) return null;
  return { value, timestamp: tms };
}

function _getActivePlanForToday(localDateStr) {
  const row = db.prepare(`
    SELECT id, plan_date, version, status, proposed_plan_json
    FROM operational_plans
    WHERE plan_date = ? AND status = 'confirmed'
    ORDER BY version DESC LIMIT 1
  `).get(localDateStr);
  if (!row) return null;
  try {
    return { ...row, proposed_plan: row.proposed_plan_json ? JSON.parse(row.proposed_plan_json) : null };
  } catch {
    return null;
  }
}

function _compare(value, op, threshold) {
  switch (op) {
    case 'gt':  return value > threshold;
    case 'gte': return value >= threshold;
    case 'lt':  return value < threshold;
    case 'lte': return value <= threshold;
    case 'eq':  return value === threshold;
    case 'neq': return value !== threshold;
    default:    return false;
  }
}

function _localDateStr(d, tz) {
  if (tz) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(d);
    const get = t => parts.find(p => p.type === t)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  }
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function normalize(s) {
  return (s || '').toString().trim().toLowerCase();
}

function roundN(v, n) {
  const p = Math.pow(10, n);
  return Math.round(v * p) / p;
}

module.exports = { evaluateSkip };
