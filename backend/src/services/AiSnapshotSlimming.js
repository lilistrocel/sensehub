/**
 * AiSnapshotSlimming — pure helpers that keep the agronomist / planner prompts
 * small. No DB access here so everything is unit-testable and the dry-run
 * script can replay old snapshots through the exact same code.
 *
 *   slimOperatorTasks   — open/snoozed only, last 7 days, max 10, five fields
 *   compactAutomation   — one-liner trigger + actions instead of raw JSON
 *   dedupePlannerContext— today_snapshot must not repeat top-level sections
 *   sectionStats        — chars per top-level section (saved as snapshot_stats)
 */

const TASK_STATUSES = new Set(['open', 'snoozed']);
const TASK_WINDOW_DAYS = 7;
const TASK_MAX = 10;
const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

/** Parse SQLite 'YYYY-MM-DD HH:MM:SS' (UTC) or ISO timestamps to ms. */
function parseTs(s) {
  if (!s) return NaN;
  if (s instanceof Date) return s.getTime();
  const str = String(s);
  // SQLite CURRENT_TIMESTAMP has no zone marker — it is UTC.
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(str) ? str.replace(' ', 'T') + 'Z' : str;
  return new Date(iso).getTime();
}

/**
 * @param tasks   rows from operator_tasks (any fields)
 * @param opts.now  Date | ms | ISO string — reference "now" (default: real now)
 * @param opts.days window in days (default 7)
 * @param opts.max  cap (default 10)
 */
function slimOperatorTasks(tasks, opts = {}) {
  const nowMs = opts.now == null ? Date.now() : parseTs(opts.now);
  const days = opts.days ?? TASK_WINDOW_DAYS;
  const max = opts.max ?? TASK_MAX;
  const cutoff = nowMs - days * 86400_000;

  return (Array.isArray(tasks) ? tasks : [])
    .filter(t => t && TASK_STATUSES.has(t.status))
    .filter(t => {
      const ts = parseTs(t.created_at);
      return Number.isFinite(ts) && ts >= cutoff;
    })
    .sort((a, b) => {
      // open before snoozed, then by priority, then newest first
      if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
      const pa = PRIORITY_RANK[a.priority] ?? 9, pb = PRIORITY_RANK[b.priority] ?? 9;
      if (pa !== pb) return pa - pb;
      return parseTs(b.created_at) - parseTs(a.created_at);
    })
    .slice(0, max)
    .map(t => ({
      title: t.title,
      priority: t.priority,
      category: t.category,
      created_at: t.created_at,
      status: t.status,
    }));
}

// ---------------------------------------------------------------------------
// Compact automations
// ---------------------------------------------------------------------------

function triggerOneLiner(tc) {
  if (!tc || typeof tc !== 'object') return 'unknown';
  switch (tc.type) {
    case 'manual':
      return 'manual';
    case 'schedule': {
      const st = tc.schedule_type || 'daily';
      if (st === 'daily') return `schedule daily at ${tc.time || '??:??'}`;
      if (st === 'interval') return `schedule every ${tc.interval_minutes ?? '?'} min`;
      if (st === 'once') return `schedule once at ${tc.datetime || tc.time || '?'}`;
      if (st === 'weekly') return `schedule weekly ${Array.isArray(tc.days) ? tc.days.join(',') : ''} at ${tc.time || '??:??'}`.replace(/\s+/g, ' ');
      return `schedule ${st} ${tc.time || ''}`.trim();
    }
    case 'threshold': {
      const unit = tc.unit ? ` ${tc.unit}` : '';
      return `threshold eq#${tc.equipment_id} ${tc.sensor_type || tc.sensor_metric || 'value'} ${tc.operator || '?'} ${tc.threshold_value ?? tc.value ?? '?'}${unit}`;
    }
    case 'sensor':
    case 'condition':
      return `${tc.type} eq#${tc.equipment_id ?? '?'} ${tc.sensor_type || tc.sensor_metric || ''} ${tc.operator || ''} ${tc.threshold_value ?? tc.value ?? ''}`.replace(/\s+/g, ' ').trim();
    default: {
      // Unknown shape: keep it short but lossless enough to recognise.
      const { type, ...rest } = tc;
      const s = JSON.stringify(rest);
      return `${type || 'unknown'} ${s.length > 120 ? s.slice(0, 117) + '...' : s}`;
    }
  }
}

/**
 * @param actions   parsed actions array
 * @param eqIndex   { [equipment_id]: { name, channels: { [ch]: label } } } (optional)
 */
function actionsOneLiner(actions, eqIndex = {}) {
  if (!Array.isArray(actions) || actions.length === 0) return 'none';
  const groups = new Map(); // equipment_id -> parts[]
  for (const a of actions) {
    const eqId = a.equipment_id;
    const eq = eqIndex[eqId] || {};
    const eqName = eq.name || a.equipment_name || null;
    const key = eqId ?? 'other';
    if (!groups.has(key)) groups.set(key, { label: eqName ? `eq#${eqId} ${eqName}` : `eq#${eqId ?? '?'}`, parts: [] });
    const g = groups.get(key);

    if (a.type === 'transition' && Array.isArray(a.transitions)) {
      const trs = a.transitions.map(t => `ch${t.channel}${labelFor(eq, t.channel, null)} ${t.state ? 'on' : 'off'}`).join(', ');
      g.parts.push(`transition [${trs}]${timing(a)}`);
      continue;
    }
    if (a.type === 'notification' || a.type === 'notify') {
      g.parts.push(`notify${a.message ? ` "${String(a.message).slice(0, 40)}"` : ''}`);
      continue;
    }
    if (a.type === 'delay') {
      g.parts.push(`delay ${a.duration_seconds ?? a.seconds ?? '?'}s`);
      continue;
    }
    const ch = a.channel;
    const act = String(a.action || a.type || '?').toLowerCase();
    g.parts.push(`ch${ch}${labelFor(eq, ch, a.channel_name)} ${act}${a.value != null && act !== 'on' && act !== 'off' ? `=${a.value}` : ''}${timing(a)}`);
  }
  return [...groups.values()].map(g => `${g.label}: ${g.parts.join(', ')}`).join(' | ');
}

function labelFor(eq, ch, fallback) {
  const label = (eq.channels && eq.channels[ch]) || fallback || null;
  return label ? ` ${label}` : '';
}

function timing(a) {
  const out = [];
  const dur = parseInt(a.duration_seconds);
  const delay = parseInt(a.delay_seconds);
  if (Number.isFinite(dur) && dur > 0) out.push(`${dur}s`);
  if (Number.isFinite(delay) && delay > 0) out.push(`@+${delay}s`);
  return out.length ? ' ' + out.join(' ') : '';
}

function countDependencies(actions) {
  if (!Array.isArray(actions)) return 0;
  let n = 0;
  for (const a of actions) if (Array.isArray(a?.dependencies)) n += a.dependencies.length;
  return n;
}

/**
 * Compact form of one automation for the planner prompt. `a` is the parsed row
 * (trigger_config / conditions / actions already objects).
 */
function compactAutomation(a, eqIndex = {}) {
  const actions = Array.isArray(a.actions) ? a.actions : [];
  const conditions = Array.isArray(a.conditions) ? a.conditions : [];
  const out = {
    id: a.id,
    name: a.name,
    enabled: !!a.enabled,
    trigger: triggerOneLiner(a.trigger_config),
    actions: actionsOneLiner(actions, eqIndex),
    action_count: actions.length,
    dependencies: countDependencies(actions),
  };
  if (conditions.length) out.conditions = conditions.length;
  if (a.template_id) out.template_id = a.template_id;
  if (a.dose_program_id) out.dose_program_id = a.dose_program_id;
  if (a.priority) out.priority = a.priority;
  if (a.last_run) out.last_run = a.last_run;
  return out;
}

/** Build { [equipment_id]: { name, channels: { [ch]: label } } } from planner equipment inventory. */
function equipmentIndexFromInventory(inventory) {
  const idx = {};
  for (const eq of inventory || []) {
    const channels = {};
    for (const c of eq.channels || []) if (c.label) channels[c.channel] = c.label;
    idx[eq.id] = { name: eq.name, channels };
  }
  return idx;
}

// ---------------------------------------------------------------------------
// Planner context dedupe
// ---------------------------------------------------------------------------

/**
 * The planner prompt addresses `context.operator_tasks` and
 * `context.today_snapshot.lab` / `.sensors`, so those are the copies we keep.
 * Mutates and returns ctx.
 */
function dedupePlannerContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return ctx;
  const snap = ctx.today_snapshot;
  if (snap && typeof snap === 'object') {
    if ('operator_tasks' in snap) {
      if (!('operator_tasks' in ctx)) ctx.operator_tasks = snap.operator_tasks;
      delete snap.operator_tasks;
    }
    for (const key of ['sensors', 'lab']) {
      if (key in ctx && key in snap) delete ctx[key];
      else if (key in ctx && !(key in snap)) { snap[key] = ctx[key]; delete ctx[key]; }
    }
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/** Chars of JSON per top-level section, plus _total. */
function sectionStats(obj, { pretty = true } = {}) {
  const stats = {};
  if (!obj || typeof obj !== 'object') return { _total: 0 };
  const ser = v => (pretty ? JSON.stringify(v, null, 2) : JSON.stringify(v)) ?? 'null';
  let total = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'snapshot_stats') continue;
    const n = ser(v).length;
    stats[k] = n;
    total += n;
  }
  stats._total = total;
  return stats;
}

module.exports = {
  slimOperatorTasks,
  triggerOneLiner,
  actionsOneLiner,
  compactAutomation,
  equipmentIndexFromInventory,
  dedupePlannerContext,
  sectionStats,
  parseTs,
  TASK_WINDOW_DAYS,
  TASK_MAX,
};
