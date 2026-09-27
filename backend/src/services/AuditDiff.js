/**
 * Field-level diff + human wording for audit log BEFORE / AFTER snapshots.
 *
 * diffSnapshots(before, after) -> [{ path, before, after }]
 *   - JSON strings ("[...]" / "{...}") are parsed first, so an automation's
 *     `actions` column diffs per action field instead of as one opaque string.
 *   - Arrays compare by index; an extra / missing element is one entry with
 *     before or after undefined (serialised as null + `added` / `removed`).
 *   - Volatile bookkeeping fields (updated_at, run_count, last_run ...) are ignored.
 *
 * describeChanges(diff, { lookupChannel }) -> ["Irrigation Zone 4 start 4:09 → 4:30", ...]
 */

const IGNORED_KEYS = new Set([
  'updated_at', 'created_at', 'last_run', 'run_count', 'consecutive_skips',
  'last_watchdog_alert', 'last_login', 'last_reading', 'last_communication',
  'status', 'error_log', 'last_seen_at',
]);

const MAX_DIFF_ENTRIES = 200;
const MAX_DEPTH = 8;

function parseMaybeJson(v) {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!s || (s[0] !== '{' && s[0] !== '[')) return v;
  try { return JSON.parse(s); } catch (_) { return v; }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Loose equality: 1 == true, "30" == 30, null == undefined — form round-trips
// change representation without changing meaning; those are not edits.
function looseEqual(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  if (typeof a === 'boolean' || typeof b === 'boolean') return Number(a) === Number(b) && !Number.isNaN(Number(a));
  if (typeof a === 'number' || typeof b === 'number') {
    const na = Number(a); const nb = Number(b);
    return !Number.isNaN(na) && !Number.isNaN(nb) && na === nb && String(a).trim() !== '' && String(b).trim() !== '';
  }
  return false;
}

function walk(a, b, path, out, depth) {
  if (out.length >= MAX_DIFF_ENTRIES) return;
  a = parseMaybeJson(a);
  b = parseMaybeJson(b);
  if (depth < MAX_DEPTH && isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (IGNORED_KEYS.has(k)) continue;
      walk(a[k], b[k], path ? `${path}.${k}` : k, out, depth + 1);
    }
    return;
  }
  if (depth < MAX_DEPTH && Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const p = `${path}[${i}]`;
      if (i >= a.length) out.push({ path: p, before: null, after: b[i], added: true });
      else if (i >= b.length) out.push({ path: p, before: a[i], after: null, removed: true });
      else walk(a[i], b[i], p, out, depth + 1);
      if (out.length >= MAX_DIFF_ENTRIES) return;
    }
    return;
  }
  if (!looseEqual(a, b)) out.push({ path, before: a === undefined ? null : a, after: b === undefined ? null : b });
}

function diffSnapshots(before, after) {
  if (before == null && after == null) return [];
  const out = [];
  walk(before == null ? {} : before, after == null ? {} : after, '', out, 0);
  return out;
}

// ---------------------------------------------------------------------------
// Human wording
// ---------------------------------------------------------------------------

const SECONDS_FIELDS = new Set(['delay_seconds', 'duration_seconds', 'max_on_seconds', 'duration_s']);
const FIELD_LABELS = {
  delay_seconds: 'start',
  duration_seconds: 'duration',
  action: 'action',
  enabled: 'enabled',
  name: 'name',
  description: 'description',
  priority: 'priority',
  threshold_value: 'threshold',
  operator: 'operator',
  time: 'time',
  days: 'days',
  role: 'role',
  email: 'email',
  control_mode: 'mode',
  dependencies: 'dependencies',
  condition_logic: 'condition logic',
  dose_program_id: 'dose program',
};

function fmtSeconds(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fmtValue(v);
  const neg = n < 0; const s = Math.abs(Math.round(n));
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = s % 60;
  const body = h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
  return (neg ? '-' : '') + body;
}

function fmtValue(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > 60 ? `${s.slice(0, 57)}…` : s;
  }
  const s = String(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

/** Label for an array element such as actions[3] from the element itself. */
function elementLabel(el, lookupChannel) {
  if (!isPlainObject(el)) return null;
  if (el.channel_name) return el.channel_name;
  if (el.equipment_id != null && el.channel != null && lookupChannel) {
    const n = lookupChannel(el.equipment_id, el.channel);
    if (n) return n;
  }
  if (el.name) return el.name;
  if (el.equipment_id != null && el.channel != null) return `board ${el.equipment_id} ch ${el.channel}`;
  if (el.type === 'alert' || el.type === 'notify') return 'alert action';
  return null;
}

function getAt(obj, pathParts) {
  let cur = obj;
  for (const p of pathParts) {
    cur = parseMaybeJson(cur);
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return parseMaybeJson(cur);
}

function splitPath(path) {
  const parts = [];
  path.replace(/([^.[\]]+)|\[(\d+)\]/g, (_, key, idx) => { parts.push(idx !== undefined ? Number(idx) : key); return ''; });
  return parts;
}

/**
 * One short phrase per diff entry. `before` / `after` are the full snapshots
 * (used to label array elements by their channel / name).
 */
function describeChanges(diff, { before, after, lookupChannel } = {}) {
  const phrases = [];
  for (const d of diff) {
    if (d.redacted) { phrases.push(`${d.path} changed (secret)`); continue; }
    const parts = splitPath(d.path);
    const field = parts.length ? parts[parts.length - 1] : d.path;
    // Nearest enclosing array element -> label ("Irrigation Zone 4").
    let label = null;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (typeof parts[i] === 'number') {
        const elPath = parts.slice(0, i + 1);
        label = elementLabel(getAt(after, elPath), lookupChannel) || elementLabel(getAt(before, elPath), lookupChannel);
        if (!label) label = `${parts[i - 1] || 'item'} #${parts[i] + 1}`;
        break;
      }
    }
    if (d.added) { phrases.push(`added ${elementLabel(d.after, lookupChannel) || label || d.path}`); continue; }
    if (d.removed) { phrases.push(`removed ${elementLabel(d.before, lookupChannel) || label || d.path}`); continue; }
    const fieldName = typeof field === 'number' ? d.path : (FIELD_LABELS[field] || String(field).replace(/_/g, ' '));
    const fmt = SECONDS_FIELDS.has(field) ? fmtSeconds : fmtValue;
    const subject = label ? `${label} ${fieldName}` : (parts.length > 1 ? d.path.replace(/_/g, ' ') : fieldName);
    phrases.push(`${subject} ${fmt(d.before)} → ${fmt(d.after)}`);
  }
  return phrases;
}

/** "a; b; c (+4 more)" bounded to maxLen characters. */
function joinPhrases(phrases, maxShown = 3, maxLen = 220) {
  if (!phrases.length) return '';
  const shown = phrases.slice(0, maxShown);
  let s = shown.join('; ');
  if (s.length > maxLen) s = `${s.slice(0, maxLen - 1)}…`;
  if (phrases.length > maxShown) s += ` (+${phrases.length - maxShown} more)`;
  return s;
}

module.exports = { diffSnapshots, describeChanges, joinPhrases, parseMaybeJson, fmtSeconds, fmtValue, splitPath };
