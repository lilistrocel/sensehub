/**
 * UnifiedLogService — one read API over the action audit trail and the
 * system event tables that already exist. Nothing is copied: every request
 * queries each source with the same filters + a LIMIT, maps rows to one item
 * shape, and merge-sorts (newest first) with cursor pagination.
 *
 * Sources (item.source):
 *   audit           audit_log                      people (and future system) actions
 *   relay           relay_events, bursts grouped   one item per burst of one writer
 *   automation      automation_logs                automation runs
 *   alert           alerts                         raised / resolved
 *   alert_ack       alerts (acknowledged)          pre-audit era only (audit has alert.acknowledge)
 *   flow            irrigation_flow_episodes       no-flow, retry, shutdown ...
 *   irrigation_run  irrigation_runs                automated / manual app / manual panel
 *   dose_run        dose_controller_runs           closed-loop dose runs
 *   dose_cycle      fertigation_dose_cycle_log     open-loop cycles (no dose run row)
 *   drift           relay_drift_log                polled state != expected
 *   request         request_log (non-GET)          pre-audit era only: device + path, no user
 *
 * "Pre-audit era" = before the first audit_log row. After it, user relay
 * writes (relay_events source manual / all_channels with a user_email) and
 * alert acknowledgements come from audit_log only, so nothing shows twice.
 *
 * Item shape:
 *   { id, source, source_id, time, end_time, actor_type, actor_email, actor_role,
 *     actor_label, device, ip, category, categories[], action, target_type,
 *     target_id, target_name, related[], summary, severity, result, status_code,
 *     count, repeat_count }
 *
 * Pagination: key = (time desc, source desc, sort id desc); the cursor is the
 * key of the last item served (base64url JSON). A source that could not be
 * read to the end reports a frontier; items older than any open frontier wait
 * for the next page, so merging never skips or repeats an item.
 *
 * Read-only.
 */

const { db } = require('../utils/database');
const { getSystemTimezone } = require('../utils/systemTimezone');
const { parseMaybeJson, fmtSeconds } = require('./AuditDiff');
const { deviceFromUA } = require('./AuditLogService');
const RouteMap = require('./AuditRouteMap');

const SOURCES = ['audit', 'relay', 'automation', 'alert', 'alert_ack', 'flow', 'irrigation_run', 'dose_run', 'dose_cycle', 'drift', 'request'];
const CATEGORIES = ['irrigation', 'dosing', 'climate', 'automations', 'equipment', 'settings', 'users', 'auth', 'alerts', 'ai', 'cameras', 'lab', 'crops', 'tasks', 'system'];
const SEVERITIES = ['info', 'warning', 'critical'];

const RELAY_GAP_S = 5;          // same writer, <= 5 s apart -> one burst
const RELAY_BUCKET_S = 300;     // bursts never cross an absolute 5-min boundary
const REQUEST_GAP_S = 30;       // legacy request rows: identical calls <= 30 s apart
const MAX_SCAN_ROWS = 25000;    // per source per page
const MAX_LIMIT = 200;

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/** Any stored timestamp -> 'YYYY-MM-DDTHH:MM:SS.mmmZ' (UTC), or null. */
function toIso(v) {
  if (!v) return null;
  let s = String(v).trim();
  if (!s) return null;
  if (!s.includes('T')) s = s.replace(' ', 'T');
  if (!/[zZ]$|[+-]\d\d:?\d\d$/.test(s)) s += 'Z';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
const isoMs = (iso) => Date.parse(iso);
const addSeconds = (iso, s) => new Date(isoMs(iso) + s * 1000).toISOString();
/** ISO -> SQLite datetime('now') format (seconds). */
const toSpace = (iso) => iso.slice(0, 19).replace('T', ' ');
/** Upper bound usable against ISO columns of mixed precision: 'YYYY-MM-DDTHH:MM:SS~'. */
const isoUpper = (iso) => `${iso.slice(0, 19)}~`;
const isoLower = (iso) => iso.slice(0, 19);

function tzOffsetMs(utcMs, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (t) => Number(parts.find(p => p.type === t).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** UTC instant of local midnight (today in `tz`). */
function startOfLocalDay(nowMs, tz) {
  const off = tzOffsetMs(nowMs, tz);
  const local = new Date(nowMs + off);
  const midLocalAsUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  let guess = midLocalAsUtc - off;
  const off2 = tzOffsetMs(guess, tz);
  if (off2 !== off) guess = midLocalAsUtc - off2;
  return guess;
}

// ---------------------------------------------------------------------------
// Keys + cursor
// ---------------------------------------------------------------------------

/** <0 when a is listed before b (newer). */
function keyCompare(a, b) {
  if (a.t !== b.t) return a.t > b.t ? -1 : 1;
  if (a.s !== b.s) return a.s > b.s ? -1 : 1;
  if (a.i !== b.i) return a.i > b.i ? -1 : 1;
  return 0;
}
const itemKey = (it) => ({ t: it.time, s: it.source, i: it._sort });

function encodeCursor(k) {
  return Buffer.from(JSON.stringify({ t: k.t, s: k.s, i: k.i })).toString('base64url');
}
function decodeCursor(c) {
  if (!c) return null;
  try {
    const k = JSON.parse(Buffer.from(String(c), 'base64url').toString('utf8'));
    if (typeof k.t !== 'string' || typeof k.s !== 'string' || typeof k.i !== 'number') return null;
    const t = toIso(k.t);
    return t ? { t, s: k.s, i: k.i } : null;
  } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

const csv = (v) => (v == null || v === '' ? null : String(v).split(',').map(s => s.trim()).filter(Boolean));

function parseFilters(query = {}, now = Date.now()) {
  const tz = getSystemTimezone(db);
  let from = toIso(query.from);
  let to = toIso(query.to);
  const range = query.range ? String(query.range) : null;
  if (range === 'today') from = new Date(startOfLocalDay(now, tz)).toISOString();
  else if (range === '24h') from = new Date(now - 24 * 3600e3).toISOString();
  else if (range === '7d') from = new Date(now - 7 * 24 * 3600e3).toISOString();
  else if (range === '30d') from = new Date(now - 30 * 24 * 3600e3).toISOString();
  const cats = csv(query.category);
  const actions = csv(query.action);
  const sev = csv(query.severity);
  const srcs = csv(query.source);
  const limit = Math.max(1, Math.min(parseInt(query.limit, 10) || 50, MAX_LIMIT));
  return {
    tz,
    from,
    to,
    categories: cats ? new Set(cats) : null,
    actions: actions || null,
    actor: query.actor ? String(query.actor).trim().toLowerCase() : null,
    actorType: query.actor_type === 'user' || query.actor_type === 'system' ? query.actor_type : null,
    targetType: query.target_type ? String(query.target_type) : null,
    targetId: query.target_id != null && query.target_id !== '' ? String(query.target_id) : null,
    q: query.q ? String(query.q).trim().toLowerCase().slice(0, 100) : null,
    severities: sev ? new Set(sev) : null,
    sources: srcs ? new Set(srcs.filter(s => SOURCES.includes(s))) : null,
    result: query.result ? String(query.result) : null,
    limit,
    cursor: decodeCursor(query.cursor),
  };
}

function actionMatches(action, patterns) {
  if (!patterns) return true;
  return patterns.some(p => (p.endsWith('*') ? String(action).startsWith(p.slice(0, -1)) : action === p));
}

function itemMatches(it, f) {
  if (f.from && it.time < f.from) return false;
  if (f.to && it.time > f.to) return false;
  if (f.actorType && it.actor_type !== f.actorType) return false;
  if (f.actor && String(it.actor_email || '').toLowerCase() !== f.actor) return false;
  if (f.categories && !(it.categories || [it.category]).some(c => f.categories.has(c))) return false;
  if (f.actions && !actionMatches(it.action, f.actions)) return false;
  if (f.severities && !f.severities.has(it.severity)) return false;
  if (f.result && it.result !== f.result) return false;
  if (f.targetType) {
    const tid = f.targetId;
    const hit = (t, id) => t === f.targetType && (tid == null || String(id) === tid);
    if (!hit(it.target_type, it.target_id) && !(it.related || []).some(r => hit(r.type, r.id))) return false;
  }
  if (f.q) {
    const hay = `${it.summary || ''} ${it.target_name || ''} ${it.actor_label || ''} ${it.actor_email || ''} ${it.action || ''} ${it.device || ''}`.toLowerCase();
    if (!hay.includes(f.q)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Reference data (one load per request)
// ---------------------------------------------------------------------------

function loadRefs() {
  const equipment = new Map();
  const automations = new Map();
  const users = new Map();
  const programs = new Map();
  try { for (const r of db.prepare('SELECT id, name, type, register_mappings FROM equipment').all()) equipment.set(r.id, r); } catch (_) {}
  try { for (const r of db.prepare('SELECT id, name, actions FROM automations').all()) automations.set(r.id, r); } catch (_) {}
  try { for (const r of db.prepare('SELECT id, email, role FROM users').all()) users.set(r.id, r); } catch (_) {}
  try { for (const r of db.prepare('SELECT id, name FROM fertigation_dose_programs').all()) programs.set(r.id, r); } catch (_) {}
  const domainCache = new Map();
  const refs = {
    equipment, automations, users, programs,
    eqName: (id) => (equipment.get(Number(id)) || {}).name || `equipment ${id}`,
    chName: (id, ch) => {
      const eq = equipment.get(Number(id));
      return eq ? `${eq.name} › ${RouteMap.channelLabel(eq, ch)}` : `equipment ${id} ch ${ch}`;
    },
    autoName: (id) => (automations.get(Number(id)) || {}).name || (id != null ? `automation #${id}` : null),
    chDomain: (id, ch) => {
      const k = `${id}:${ch}`;
      if (!domainCache.has(k)) {
        const eq = equipment.get(Number(id));
        let d = eq ? (RouteMap.classifyChannelText(RouteMap.channelLabel(eq, ch)) || RouteMap.classifyChannelText(eq.name)) : null;
        domainCache.set(k, d || 'equipment');
      }
      return domainCache.get(k);
    },
    autoDomain: (id) => {
      const k = `a:${id}`;
      if (!domainCache.has(k)) {
        const a = automations.get(Number(id));
        let d = a ? RouteMap.classifyAutomationText(a.name) : null;
        if (!d && a) {
          const acts = parseMaybeJson(a.actions);
          const counts = {};
          if (Array.isArray(acts)) for (const x of acts) if (x && x.equipment_id != null) { const dd = refs.chDomain(x.equipment_id, x.channel); if (dd !== 'equipment') counts[dd] = (counts[dd] || 0) + 1; }
          const best = Object.entries(counts).sort((p, q) => q[1] - p[1])[0];
          d = best ? best[0] : null;
        }
        domainCache.set(k, d || 'automations');
      }
      return domainCache.get(k);
    },
  };
  return refs;
}

let auditEraCache = null;
/** ISO time of the first audit_log row ('9999' when the table is empty). */
function auditEraStart() {
  if (auditEraCache) return auditEraCache;
  try {
    const r = db.prepare('SELECT MIN(created_at) AS t FROM audit_log').get();
    if (r && r.t) { auditEraCache = toIso(r.t); return auditEraCache; }
  } catch (_) {}
  return '9999-12-31T23:59:59.999Z';
}
function _resetAuditEraCache() { auditEraCache = null; }

// ---------------------------------------------------------------------------
// Grouping (relay bursts, repeated legacy requests)
// ---------------------------------------------------------------------------

/**
 * rowsDesc: raw rows newest first, each with ._iso. Returns groups (ascending
 * build, deterministic: split on key change per writer, gap > gapS, or an
 * absolute bucket boundary). Each group: { key, rows (asc), start, end, minId, maxId }.
 */
function groupRows(rowsDesc, keyFn, gapS, bucketS) {
  const asc = rowsDesc.slice().reverse();
  const open = new Map();
  const groups = [];
  for (const r of asc) {
    const k = keyFn(r);
    const ms = isoMs(r._iso);
    const g = open.get(k);
    if (g && ms - isoMs(g.end) <= gapS * 1000 && Math.floor(ms / (bucketS * 1000)) === g.bucket) {
      g.rows.push(r); g.end = r._iso; g.maxId = Math.max(g.maxId, r.id); g.minId = Math.min(g.minId, r.id);
    } else {
      const ng = { key: k, rows: [r], start: r._iso, end: r._iso, minId: r.id, maxId: r.id, bucket: Math.floor(ms / (bucketS * 1000)) };
      open.set(k, ng);
      groups.push(ng);
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Source definitions
// ---------------------------------------------------------------------------

const cap = (s, n = 240) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);
const shortEmail = (e) => (e ? String(e) : null);

function listNames(names, max = 3) {
  const uniq = [...new Set(names)];
  if (uniq.length <= max) return uniq.join(', ');
  return `${uniq.slice(0, max).join(', ')} +${uniq.length - max} more`;
}

const RELAY_ACTORS = {
  automation: { label: null, action: 'relay.automation' },
  automation_auto_off: { label: null, action: 'relay.auto_off' },
  stop_all: { label: 'Stop All', action: 'relay.stop_all', severity: 'warning' },
  stop_irrigation: { label: 'Stop Irrigation', action: 'relay.stop_irrigation', severity: 'warning' },
  manual: { label: null, action: 'relay.control' },
  all_channels: { label: null, action: 'relay.all' },
  watchdog_force_off: { label: 'Relay safety watchdog', action: 'relay.watchdog_force_off', severity: 'warning' },
  interlock: { label: 'Interlock', action: 'relay.interlock', severity: 'warning' },
  dose_controller: { label: 'Dose controller', action: 'relay.dose_controller', domain: 'dosing' },
  ph_controller: { label: 'pH controller', action: 'relay.ph_controller', domain: 'dosing' },
  dose_program: { label: 'Dose program', action: 'relay.dose_program', domain: 'dosing' },
  dose_program_end: { label: 'Dose program', action: 'relay.dose_program_end', domain: 'dosing' },
  dose_program_abort: { label: 'Dose program', action: 'relay.dose_program_abort', domain: 'dosing', severity: 'warning' },
  flow_watch: { label: 'Flow watch', action: 'relay.flow_watch', domain: 'irrigation', severity: 'warning' },
  flow_watch_retry: { label: 'Flow watch', action: 'relay.flow_watch_retry', domain: 'irrigation', severity: 'warning' },
  flow_watch_shutdown: { label: 'Flow watch', action: 'relay.flow_watch_shutdown', domain: 'irrigation', severity: 'warning' },
};

function relayGroupItem(g, refs, ctx) {
  const first = g.rows[0];
  const src = first.source;
  const meta = RELAY_ACTORS[src] || { label: src, action: `relay.${src}` };
  const isUser = (src === 'manual' || src === 'all_channels');
  const autoName = first.automation_id != null ? refs.autoName(first.automation_id) : null;
  const eqIds = [...new Set(g.rows.map(r => r.equipment_id))];
  const onRows = g.rows.filter(r => r.state === 1);
  const offRows = g.rows.filter(r => r.state !== 1);
  const unconfirmed = g.rows.filter(r => r.confirmed === 0).length;
  const names = g.rows.map(r => refs.chName(r.equipment_id, r.channel));
  const domains = {};
  for (const r of g.rows) { const d = meta.domain || refs.chDomain(r.equipment_id, r.channel); domains[d] = (domains[d] || 0) + 1; }
  let primary = Object.entries(domains).sort((a, b) => b[1] - a[1])[0][0];
  if (src === 'stop_all') primary = 'system';
  if (src === 'stop_irrigation') primary = 'irrigation';

  let what;
  const n = g.rows.length;
  if (onRows.length && offRows.length) what = `switched ${onRows.length} ON, ${offRows.length} OFF`;
  else what = `switched ${onRows.length ? 'ON' : 'OFF'}`;
  const where = n === 1 ? names[0] : `${n} channels${eqIds.length > 1 ? ` on ${eqIds.length} boards` : ` on ${refs.eqName(eqIds[0])}`} (${listNames(names)})`;

  let actorLabel = meta.label;
  if (src === 'automation' || src === 'automation_auto_off') actorLabel = autoName ? `Automation '${autoName}'` : 'Automation';
  if (isUser) actorLabel = first.user_email || 'Unknown user';
  let lead;
  if (src === 'automation') lead = `'${autoName || 'automation'}' ${what}`;
  else if (src === 'automation_auto_off') lead = `Auto-off after duration ('${autoName || 'automation'}') ${what}`;
  else if (isUser) lead = `${first.user_email || 'Someone'} ${what}`;
  else lead = `${meta.label || src} ${what}`;
  let summary = `${lead} ${where}`;
  if (!isUser && first.user_email) summary += src === 'interlock' ? ` (after a write by ${first.user_email})` : ` (pressed by ${first.user_email})`;
  if (unconfirmed) summary += ` — ${unconfirmed} not confirmed by read-back`;
  if (ctx && ctx.device) summary += ` (from ${ctx.device})`;

  const related = eqIds.map(id => ({ type: 'equipment', id: String(id) }));
  if (first.automation_id != null) related.push({ type: 'automation', id: String(first.automation_id) });
  return {
    id: `relay:${g.minId}-${g.maxId}`,
    source: 'relay',
    source_id: `${g.minId}-${g.maxId}`,
    _sort: g.minId,
    time: g.start,
    end_time: g.end !== g.start ? g.end : null,
    actor_type: isUser ? 'user' : 'system',
    actor_email: isUser ? shortEmail(first.user_email) : null,
    actor_role: null,
    actor_label: actorLabel,
    device: ctx && ctx.device ? ctx.device : null,
    ip: null,
    category: primary,
    categories: [...new Set([primary, ...Object.keys(domains), 'equipment'])],
    action: meta.action,
    target_type: eqIds.length === 1 ? 'equipment' : 'equipment',
    target_id: eqIds.length === 1 ? String(eqIds[0]) : null,
    target_name: eqIds.length === 1 ? (n === 1 ? names[0] : refs.eqName(eqIds[0])) : `${eqIds.length} boards`,
    related,
    summary: cap(summary, 400),
    severity: unconfirmed ? 'warning' : (meta.severity || 'info'),
    result: unconfirmed ? 'unconfirmed' : null,
    status_code: null,
    count: n,
    automation_id: first.automation_id,
  };
}

function automationLogItem(r, refs) {
  const name = refs.autoName(r.automation_id);
  const msg = String(r.message || '');
  const trig = (msg.match(/^(\w+) trigger/) || [])[1] || null;
  const skipped = (msg.match(/\((\d+) action\(s\) skipped by dependency\)/) || [])[1];
  const trigLabel = { scheduler: 'schedule', manual: 'run by hand', watchdog_rearm: 'watchdog re-arm', threshold: 'threshold' }[trig] || trig;
  let summary;
  if (r.status === 'failure') summary = `'${name}' failed${trigLabel ? ` (${trigLabel})` : ''}: ${cap(msg, 200)}`;
  else if (r.status === 'skipped') summary = `'${name}' skipped${trigLabel ? ` (${trigLabel})` : ''}: ${cap(msg, 200)}`;
  else summary = `'${name}' ran${trigLabel ? ` (${trigLabel})` : ''}${skipped ? ` — ${skipped} action(s) held back by dependencies` : ''}`;
  const dom = refs.autoDomain(r.automation_id);
  return {
    id: `automation:${r.id}`, source: 'automation', source_id: String(r.id), _sort: r.id,
    time: r._iso, end_time: null,
    actor_type: 'system', actor_email: null, actor_role: null, actor_label: `Automation '${name}'`,
    device: null, ip: null,
    category: dom, categories: [...new Set([dom, 'automations'])],
    action: r.status === 'failure' ? 'automation.failed' : (r.status === 'skipped' ? 'automation.skipped' : 'automation.run'),
    target_type: 'automation', target_id: String(r.automation_id), target_name: name, related: [],
    summary, severity: r.status === 'failure' ? 'warning' : 'info',
    result: r.status === 'failure' ? 'error' : 'ok', status_code: null, count: 1,
    trigger: trig,
  };
}

const ALERT_SOURCE_LABEL = {
  flow_watch: 'Flow watch', dose_controller: 'Dose controller', watchdog: 'Watchdog', relay_safety: 'Relay safety watchdog',
  interlock: 'Interlock', camera: 'Camera monitor', agronomist: 'Agronomist', automation: 'Automation',
};
function alertDomain(r, refs) {
  if (r.source === 'flow_watch') return 'irrigation';
  if (r.source === 'dose_controller') return 'dosing';
  if (r.source === 'camera') return 'cameras';
  if (r.source === 'agronomist') return 'ai';
  if (r.automation_id != null) return refs.autoDomain(r.automation_id);
  if (r.equipment_id != null) {
    const eq = refs.equipment.get(r.equipment_id);
    const d = eq ? RouteMap.classifyChannelText(eq.name) : null;
    return d || 'equipment';
  }
  return 'alerts';
}

function alertItem(r, refs) {
  const resolved = /^resolved\b/i.test(r.message || '');
  const dom = alertDomain(r, refs);
  const label = ALERT_SOURCE_LABEL[r.source] || (r.automation_id != null ? `Automation '${refs.autoName(r.automation_id)}'` : 'System');
  const related = [];
  if (r.equipment_id != null) related.push({ type: 'equipment', id: String(r.equipment_id) });
  if (r.automation_id != null) related.push({ type: 'automation', id: String(r.automation_id) });
  const occ = r.occurrence_count > 1 ? ` (×${r.occurrence_count})` : '';
  return {
    id: `alert:${r.id}`, source: 'alert', source_id: String(r.id), _sort: r.id,
    time: r._iso, end_time: r.last_seen_at ? toIso(r.last_seen_at) : null,
    actor_type: 'system', actor_email: null, actor_role: null, actor_label: label,
    device: null, ip: null,
    category: dom, categories: [...new Set([dom, 'alerts'])],
    action: resolved ? 'alert.resolved' : 'alert.raised',
    target_type: 'alert', target_id: String(r.id), target_name: cap(r.message, 140), related,
    summary: `${resolved ? '' : `${String(r.severity || 'info').toUpperCase()} alert: `}${cap(r.message, 300)}${occ}`,
    severity: resolved ? 'info' : (SEVERITIES.includes(r.severity) ? r.severity : 'info'),
    result: null, status_code: null, count: 1,
    acknowledged: !!r.acknowledged,
  };
}

function alertAckItem(r, refs) {
  const u = r.acknowledged_by != null ? refs.users.get(r.acknowledged_by) : null;
  const n = r.n || 1;
  return {
    id: `alert_ack:${r.min_id}`, source: 'alert_ack', source_id: String(r.min_id), _sort: r.min_id,
    time: r._iso, end_time: null,
    actor_type: 'user', actor_email: u ? u.email : null, actor_role: u ? u.role : null,
    actor_label: u ? u.email : (r.acknowledged_by == null ? 'Unknown user' : `user #${r.acknowledged_by}`),
    device: null, ip: null,
    category: 'alerts', categories: ['alerts'],
    action: n > 1 ? 'alert.acknowledge_all' : 'alert.acknowledge',
    target_type: 'alert', target_id: String(r.min_id), target_name: cap(r.message, 140), related: [],
    summary: n > 1 ? `Acknowledged ${n} alerts` : `Acknowledged alert: ${cap(r.message, 200)}`,
    severity: 'info', result: 'ok', status_code: null, count: n,
  };
}

const FLOW_KIND_LABEL = {
  valve_no_flow: 'No water flow with the zone open',
  run_shutdown: 'Flow watch shut the irrigation run down',
  pump_no_flow: 'No water flow with the pump running',
  low_flow: 'Low water flow',
  water_without_valve: 'Water flowing with no zone open',
  dosing_without_water: 'Dosing without water flow',
};
function flowItem(r, refs) {
  const det = parseMaybeJson(r.detail_json) || {};
  const where = r.equipment_id != null && r.channel != null ? refs.chName(r.equipment_id, r.channel) : (r.zone_name || '');
  let summary = `${FLOW_KIND_LABEL[r.kind] || r.kind.replace(/_/g, ' ')}${r.zone_name ? ` — ${r.zone_name}` : ''}`;
  if (r.duration_s != null) summary += ` for ${fmtSeconds(r.duration_s)}`;
  if (r.recovered === 1) summary += ' (recovered)';
  if (r.kind === 'run_shutdown') {
    if (det.retry) summary += `; cold-restart retry ${det.retry.attempt ? `#${det.retry.attempt} ` : ''}${det.retry.result || det.retry.outcome || 'tried'}`;
    if (Array.isArray(det.zones_not_irrigated) && det.zones_not_irrigated.length) summary += `; not irrigated: ${det.zones_not_irrigated.join(', ')}`;
    if (r.dosing_aborted) summary += '; dosing aborted';
  } else if (r.dosing_aborted) summary += '; dosing aborted';
  if (!r.ended_at) summary += ' (ongoing)';
  const related = [];
  if (r.equipment_id != null) related.push({ type: 'equipment', id: String(r.equipment_id) });
  if (det.automation_id != null) related.push({ type: 'automation', id: String(det.automation_id) });
  const sev = r.severity && SEVERITIES.includes(r.severity) ? r.severity : (r.alarmed ? 'warning' : 'info');
  return {
    id: `flow:${r.id}`, source: 'flow', source_id: String(r.id), _sort: r.id,
    time: r._iso, end_time: r.ended_at ? toIso(r.ended_at) : null,
    actor_type: 'system', actor_email: null, actor_role: null, actor_label: 'Flow watch',
    device: null, ip: null,
    category: 'irrigation', categories: ['irrigation'],
    action: `flow_watch.${r.kind}`,
    target_type: 'equipment', target_id: r.equipment_id != null ? String(r.equipment_id) : null, target_name: where, related,
    summary: cap(summary, 400), severity: sev, result: null, status_code: null, count: 1,
  };
}

function irrigationRunItem(r, refs) {
  const typeLabel = { automated: 'automated', manual_app: 'manual (app)', manual_panel: 'manual (panel)' }[r.type] || r.type;
  const autoName = r.automation_id != null ? refs.autoName(r.automation_id) : null;
  const ops = r.operators ? String(r.operators).split(',').map(s => s.trim()).filter(Boolean) : [];
  let summary = `Irrigation run, ${typeLabel}${autoName ? ` — '${autoName}'` : ''}${ops.length ? ` by ${ops.join(', ')}` : ''}`;
  const bits = [];
  if (r.water_l != null) bits.push(`${Math.round(r.water_l * 10) / 10} L`);
  if (r.duration_s != null) bits.push(`in ${fmtSeconds(r.duration_s)}`);
  if (bits.length) summary += `: ${bits.join(' ')}`;
  if (r.status && r.status !== 'ok' && r.status !== 'manual') summary += ` — ${String(r.status).replace(/_/g, ' ')}`;
  if (r.uncontrolled_dosing) summary += ' — dosing without control';
  if (r.provisional) summary += ' (in progress)';
  const warn = ['shutdown', 'cut_short', 'aborted', 'no_flow'].includes(r.status) || r.uncontrolled_dosing;
  const isUser = r.type === 'manual_app' || r.type === 'manual_panel';
  const related = r.automation_id != null ? [{ type: 'automation', id: String(r.automation_id) }] : [];
  return {
    id: `irrigation_run:${r.id}`, source: 'irrigation_run', source_id: String(r.id), _sort: r.id,
    time: r._iso, end_time: r.ended_at ? toIso(r.ended_at) : null,
    actor_type: isUser ? 'user' : 'system',
    actor_email: r.type === 'manual_app' && ops.length ? ops[0] : null,
    actor_role: null,
    actor_label: r.type === 'manual_panel' ? 'Someone at the panel' : (ops.length ? ops.join(', ') : (autoName ? `Automation '${autoName}'` : 'Irrigation')),
    device: r.type === 'manual_panel' ? 'panel switch' : null, ip: null,
    category: 'irrigation', categories: ['irrigation'],
    action: `irrigation.run_${r.type}`,
    target_type: r.automation_id != null ? 'automation' : 'irrigation_run', target_id: r.automation_id != null ? String(r.automation_id) : String(r.id),
    target_name: autoName || `run #${r.id}`, related,
    summary: cap(summary, 400), severity: warn ? 'warning' : 'info', result: null, status_code: null, count: 1,
  };
}

function doseRunItem(r, refs) {
  const prog = r.program_id != null ? (refs.programs.get(r.program_id) || {}).name : null;
  const autoName = r.automation_id != null ? refs.autoName(r.automation_id) : null;
  let summary = `Closed-loop dose run${prog ? ` '${prog}'` : ''}${autoName ? ` for '${autoName}'` : ''}`;
  const bits = [];
  if (r.water_l != null) bits.push(`${Math.round(r.water_l * 10) / 10} L water`);
  if (r.ph_avg != null) bits.push(`pH avg ${Math.round(r.ph_avg * 100) / 100}`);
  if (r.ec_avg != null) bits.push(`EC avg ${Math.round(r.ec_avg)}`);
  if (bits.length) summary += `: ${bits.join(', ')}`;
  summary += ` — ${r.status}${r.end_reason ? ` (${cap(r.end_reason, 120)})` : ''}`;
  const related = [];
  if (r.automation_id != null) related.push({ type: 'automation', id: String(r.automation_id) });
  if (r.program_id != null) related.push({ type: 'dose_program', id: String(r.program_id) });
  return {
    id: `dose_run:${r.id}`, source: 'dose_run', source_id: String(r.id), _sort: r.id,
    time: r._iso, end_time: r.ended_at ? toIso(r.ended_at) : null,
    actor_type: 'system', actor_email: null, actor_role: null, actor_label: 'Dose controller',
    device: null, ip: null,
    category: 'dosing', categories: ['dosing', 'irrigation'],
    action: 'dosing.run',
    target_type: 'dose_program', target_id: r.program_id != null ? String(r.program_id) : null, target_name: prog || null, related,
    summary: cap(summary, 400), severity: r.status === 'aborted' || r.status === 'failed' ? 'warning' : 'info',
    result: null, status_code: null, count: 1,
  };
}

function doseCycleItem(r, refs) {
  const prog = r.program_id != null ? (refs.programs.get(r.program_id) || {}).name : null;
  const autoName = r.automation_id != null ? refs.autoName(r.automation_id) : null;
  let summary = `Dose cycle${prog ? ` '${prog}'` : ''}${autoName ? ` for '${autoName}'` : ''}`;
  if (r.duration_seconds != null) summary += ` (${fmtSeconds(r.duration_seconds)})`;
  summary += ` — ${r.status || 'unknown'}${r.notes ? `: ${cap(r.notes, 120)}` : ''}`;
  const related = [];
  if (r.automation_id != null) related.push({ type: 'automation', id: String(r.automation_id) });
  return {
    id: `dose_cycle:${r.id}`, source: 'dose_cycle', source_id: String(r.id), _sort: r.id,
    time: r._iso, end_time: r.cycle_ended_at ? toIso(r.cycle_ended_at) : null,
    actor_type: 'system', actor_email: null, actor_role: null, actor_label: 'Dose program',
    device: null, ip: null,
    category: 'dosing', categories: ['dosing'],
    action: 'dosing.cycle',
    target_type: 'dose_program', target_id: r.program_id != null ? String(r.program_id) : null, target_name: prog || null, related,
    summary: cap(summary, 400), severity: r.status === 'aborted' || r.status === 'failed' ? 'warning' : 'info',
    result: null, status_code: null, count: 1,
  };
}

function driftItem(r, refs) {
  const det = parseMaybeJson(r.detail) || {};
  const st = (v) => (v == null ? 'unknown' : (v ? 'ON' : 'OFF'));
  let summary = `Relay drift on ${refs.chName(r.equipment_id, r.channel)}: expected ${st(r.expected_state)}, polled ${st(r.actual_state)}`;
  if (det.last_event && det.last_event.source) summary += ` (last write: ${det.last_event.source}${det.seconds_since_last_event != null ? `, ${fmtSeconds(det.seconds_since_last_event)} earlier` : ''})`;
  const dom = refs.chDomain(r.equipment_id, r.channel);
  return {
    id: `drift:${r.id}`, source: 'drift', source_id: String(r.id), _sort: r.id,
    time: r._iso, end_time: null,
    actor_type: 'system', actor_email: null, actor_role: null, actor_label: 'Relay monitor',
    device: null, ip: null,
    category: dom, categories: [...new Set([dom, 'equipment'])],
    action: 'relay.drift',
    target_type: 'equipment', target_id: String(r.equipment_id), target_name: refs.chName(r.equipment_id, r.channel), related: [],
    summary, severity: 'warning', result: null, status_code: null, count: 1,
  };
}

function legacyRequestItem(g, refs) {
  const r = g.rows[0];
  const matches = RouteMap.matchLegacyPath(r.method, r.path);
  const n = g.rows.length;
  const device = deviceFromUA(r.user_agent);
  let action = `${String(r.method).toLowerCase()}.request`;
  let category = 'system';
  let summary = null;
  let target = null;
  const candidates = matches.map(m => m.def.pattern);
  const status = r.status;
  const ok = status >= 200 && status < 400;
  // '/32' fits many '/:id' routes. If the same device hit an automation-only
  // route on that id within 5 minutes (/32/trigger, /32/test, /32/toggle), it
  // was the automation.
  let pick = matches;
  if (matches.length > 1 && matches.some(m => m.def.pattern === `/api/automations/:id`) && /^\/\d+$/.test(r.path)) {
    try {
      const near = db.prepare("SELECT 1 FROM request_log WHERE method = 'POST' AND path IN (?, ?, ?, ?) AND user_agent IS ? AND created_at BETWEEN ? AND ? LIMIT 1")
        .get(`${r.path}/trigger`, `${r.path}/test`, `${r.path}/toggle`, `${r.path}/duplicate`, r.user_agent, isoLower(addSeconds(g.start, -300)), isoUpper(addSeconds(g.start, 300)));
      if (near) pick = matches.filter(m => m.def.pattern === '/api/automations/:id');
    } catch (_) {}
  }
  if (pick.length > 1) {
    // Keep the candidates whose target row actually exists (automation 32 exists, camera 32 does not).
    const existing = pick.filter(m => {
      if (!m.def.before) return false;
      try { return !!m.def.before({ params: m.params, body: {}, query: {} }); } catch (_) { return false; }
    });
    if (existing.length >= 1) pick = existing;
  }
  const inferredRoute = pick.length === 1 && matches.length > 1;
  if (pick.length === 1 || (pick.length > 1 && new Set(pick.map(m => (typeof m.def.action === 'string' ? m.def.action : '?'))).size === 1 && typeof pick[0].def.action === 'string')) {
    const m = pick[0];
    const ctx = { params: m.params, body: {}, query: {}, status, ok, resBody: null, before: null, after: null, user: null, changes: null, changesText: '' };
    // Current row, used for names only (the historical state was never recorded).
    try { ctx.before = m.def.before ? m.def.before(ctx) : null; } catch (_) { ctx.before = null; }
    try { action = (m.def.actionFn ? m.def.actionFn(ctx) : (typeof m.def.action === 'function' ? m.def.action(ctx) : m.def.action)) || action; } catch (_) {}
    try { category = (typeof m.def.category === 'function' ? m.def.category(ctx) : m.def.category) || RouteMap.categoryForPath(m.mount); } catch (_) { category = RouteMap.categoryForPath(m.mount); }
    try { target = m.def.target ? m.def.target(ctx) : null; } catch (_) { target = null; }
    try { summary = m.def.summary ? m.def.summary(ctx) : null; } catch (_) { summary = null; }
    // Summaries that describe a diff need the body we never had: keep the verb.
    if (summary && /^Edited /.test(summary)) summary = summary.replace(/: .*$/, '');
    if (summary && inferredRoute) summary += ' (route inferred)';
  }
  if (!summary) {
    const kinds = [...new Set(pick.map(m => m.mount.replace('/api/', '')))];
    summary = `${r.method} …${r.path}${kinds.length ? ` (${kinds.slice(0, 4).join(' / ')}${kinds.length > 4 ? ' / …' : ''})` : ''}`;
  }
  let actorEmail = null; let actorRole = null; let inferred = false;
  if (r._login_user) { actorEmail = r._login_user.email; actorRole = r._login_user.role; inferred = true; }
  if (/\/login$/.test(r.path)) {
    if (actorEmail) summary = `Logged in as ${actorEmail}`;
    else summary = ok ? 'Logged in (user not recorded)' : 'Failed login (user not recorded)';
  }
  if (!ok) summary += ` — ${status === 401 || status === 403 || status === 409 ? 'refused' : 'failed'} (${status})`;
  if (n > 1) summary += ` ×${n}`;
  const related = [];
  return {
    id: `request:${g.minId}-${g.maxId}`, source: 'request', source_id: `${g.minId}-${g.maxId}`, _sort: g.minId,
    time: g.start, end_time: g.end !== g.start ? g.end : null,
    actor_type: 'user', actor_email: actorEmail, actor_role: actorRole,
    actor_label: actorEmail ? `${actorEmail}${inferred ? ' (matched by login time)' : ''}` : 'Unknown user (before audit log)',
    device, ip: r.ip ? String(r.ip).replace(/^::ffff:/, '') : null,
    category, categories: [...new Set([category])],
    action,
    target_type: target ? target.type : null, target_id: target && target.id != null ? String(target.id) : null, target_name: target ? target.name : null,
    related,
    summary: cap(summary, 400),
    severity: ok ? ((action === 'stop_all' || action === 'emergency_stop' || action === 'irrigation.stop') ? 'warning' : 'info') : 'warning',
    result: ok ? 'ok' : (status === 401 || status === 403 || status === 409 ? 'denied' : 'error'),
    status_code: status, count: n, legacy: true, route_candidates: candidates.length > 1 ? candidates : undefined,
  };
}

function auditItem(r) {
  const tags = r.tags ? r.tags.split(',').filter(Boolean) : [];
  return {
    id: `audit:${r.id}`, source: 'audit', source_id: String(r.id), _sort: r.id,
    time: toIso(r.created_at), end_time: r.last_at ? toIso(r.last_at) : null,
    actor_type: r.actor_type, actor_email: r.actor_email, actor_role: r.actor_role,
    actor_label: r.actor_email || (r.actor_type === 'system' ? (r.actor_role || 'System') : 'Unknown user'),
    device: r.device, ip: r.ip,
    category: r.category, categories: [...new Set([r.category, ...tags])],
    action: r.action, target_type: r.target_type, target_id: r.target_id, target_name: r.target_name, related: [],
    summary: r.summary, severity: r.severity || 'info', result: r.result, status_code: r.status_code,
    count: 1, repeat_count: r.repeat_count > 1 ? r.repeat_count : undefined, duration_ms: r.duration_ms,
  };
}

// ---------------------------------------------------------------------------
// Per-source fetchers
// ---------------------------------------------------------------------------

/**
 * Each fetcher: (f, refs, needed) -> { items (all after cursor, matching), exhausted, frontier }
 * `frontier` is a key: items older than it may exist but were not read.
 */

function topBound(f) {
  // Newest time a row may have to still belong to this page.
  let top = f.to || new Date(Date.now() + 60e3).toISOString();
  if (f.cursor && f.cursor.t < top) top = f.cursor.t;
  return top;
}

function simpleSource({ name, sql, timeCol, fmt, extraWhere, params: extraParams, map, pushdown }) {
  return (f, refs, needed) => {
    const top = topBound(f);
    const where = [];
    const params = [];
    const hi = fmt === 'space' ? toSpace(top) : isoUpper(top);
    where.push(`${timeCol} <= ?`); params.push(hi);
    if (f.from) { where.push(`${timeCol} >= ?`); params.push(fmt === 'space' ? toSpace(f.from) : isoLower(f.from)); }
    if (extraWhere) { where.push(...extraWhere(f)); params.push(...(extraParams ? extraParams(f) : [])); }
    if (pushdown) { const p = pushdown(f); if (p) { where.push(...p.where); params.push(...p.params); } }
    const items = [];
    let scanned = 0;
    let exhausted = false;
    let lastKey = null;
    let cur = null; // native (time, id) pagination inside this call
    let batch = Math.max(needed * 2, 100);
    while (items.length < needed && scanned < MAX_SCAN_ROWS) {
      const w = [...where]; const p = [...params];
      if (cur) { w.push(`(${timeCol} < ? OR (${timeCol} = ? AND id < ?))`); p.push(cur.t, cur.t, cur.id); }
      const rows = db.prepare(`${sql} WHERE ${w.join(' AND ')} ORDER BY ${timeCol} DESC, id DESC LIMIT ?`).all(...p, batch);
      scanned += rows.length;
      for (const r of rows) {
        r._iso = toIso(r[timeCol]);
        if (!r._iso) continue;
        const it = map(r, refs);
        if (!it) continue;
        lastKey = itemKey(it);
        if (f.cursor && keyCompare(lastKey, f.cursor) <= 0) continue;
        if (itemMatches(it, f)) items.push(it);
      }
      if (rows.length < batch) { exhausted = true; break; }
      const last = rows[rows.length - 1];
      cur = { t: last[timeCol], id: last.id };
      batch = Math.min(batch * 2, 5000);
    }
    items.sort((a, b) => keyCompare(itemKey(a), itemKey(b)));
    return { name, items, exhausted, frontier: exhausted ? null : lastKey };
  };
}

function groupedSource({ name, rawSql, timeCol, fmt, where: whereFn, gapS, bucketS, keyFn, toItem, prepare }) {
  return (f, refs, needed) => {
    // Window top: a burst that starts before the cursor can reach one bucket past it.
    const top = f.cursor ? addSeconds(f.cursor.t, bucketS + 1) : topBound(f);
    const hiTop = f.to && f.to < top ? f.to : top;
    const { where, params } = whereFn(f);
    where.push(`${timeCol} <= ?`); params.push(fmt === 'space' ? toSpace(hiTop) : isoUpper(hiTop));
    if (f.from) { where.push(`${timeCol} >= ?`); params.push(fmt === 'space' ? toSpace(f.from) : isoLower(f.from)); }
    let raw = [];
    let exhausted = false;
    let cur = null;
    let batch = 600;
    let result = [];
    let frontier = null;
    for (;;) {
      const w = [...where]; const p = [...params];
      if (cur) { w.push(`(${timeCol} < ? OR (${timeCol} = ? AND id < ?))`); p.push(cur.t, cur.t, cur.id); }
      const rows = db.prepare(`${rawSql} WHERE ${w.join(' AND ')} ORDER BY ${timeCol} DESC, id DESC LIMIT ?`).all(...p, batch);
      for (const r of rows) r._iso = toIso(r[timeCol]);
      raw = raw.concat(rows.filter(r => r._iso));
      if (rows.length < batch) exhausted = true;
      else { const last = rows[rows.length - 1]; cur = { t: last[timeCol], id: last.id }; }

      const groups = groupRows(raw, keyFn, gapS, bucketS);
      let kept = groups;
      frontier = null;
      if (!exhausted && raw.length) {
        const oldest = raw[raw.length - 1]._iso;
        const limitIso = addSeconds(oldest, gapS + 1);
        kept = groups.filter(g => g.start > limitIso);
        frontier = { t: limitIso, s: '', i: 0 };
      }
      if (prepare) prepare(kept);
      result = [];
      for (const g of kept) {
        const it = toItem(g, refs);
        if (!it) continue;
        if (f.cursor && keyCompare(itemKey(it), f.cursor) <= 0) continue;
        if (itemMatches(it, f)) result.push(it);
      }
      if (exhausted || result.length >= needed || raw.length >= MAX_SCAN_ROWS) break;
      batch = Math.min(batch * 2, 5000);
    }
    result.sort((a, b) => keyCompare(itemKey(a), itemKey(b)));
    return { name, items: result, exhausted, frontier: exhausted ? null : frontier };
  };
}

// Which sources can possibly satisfy the filters (cheap pre-skip).
const SOURCE_ACTOR_TYPES = {
  audit: ['user', 'system'], relay: ['user', 'system'], automation: ['system'], alert: ['system'], alert_ack: ['user'],
  flow: ['system'], irrigation_run: ['user', 'system'], dose_run: ['system'], dose_cycle: ['system'], drift: ['system'], request: ['user'],
};
const SOURCE_ACTION_PREFIXES = {
  relay: ['relay.'], automation: ['automation.'], alert: ['alert.'], alert_ack: ['alert.'], flow: ['flow_watch.'],
  irrigation_run: ['irrigation.'], dose_run: ['dosing.'], dose_cycle: ['dosing.'], drift: ['relay.'],
};

function sourceApplies(name, f, eraStart) {
  if (f.sources && !f.sources.has(name)) return false;
  if (f.actorType && !SOURCE_ACTOR_TYPES[name].includes(f.actorType)) return false;
  if (f.actor && !['audit', 'relay', 'alert_ack', 'irrigation_run', 'request'].includes(name)) return false;
  if (f.actions && SOURCE_ACTION_PREFIXES[name]) {
    const pre = SOURCE_ACTION_PREFIXES[name];
    const possible = f.actions.some(a => pre.some(p => a.startsWith(p) || (a.endsWith('*') && p.startsWith(a.slice(0, -1)))));
    if (!possible) return false;
  }
  if (f.result && !['audit', 'request', 'automation', 'relay', 'alert_ack'].includes(name)) return false;
  if ((name === 'request' || name === 'alert_ack') && f.from && f.from >= eraStart) return false;
  return true;
}

function buildFetchers(eraStart) {
  const eraSpace = eraStart.startsWith('9999') ? '9999-12-31 23:59:59' : toSpace(eraStart);
  return {
    audit: (f, refs, needed) => {
      const top = topBound(f);
      const where = ['created_at <= ?']; const params = [top];
      if (f.from) { where.push('created_at >= ?'); params.push(f.from); }
      if (f.actorType) { where.push('actor_type = ?'); params.push(f.actorType); }
      if (f.actor) { where.push('LOWER(actor_email) = ?'); params.push(f.actor); }
      if (f.categories) {
        const cs = [...f.categories];
        where.push(`(category IN (${cs.map(() => '?').join(',')}) OR ${cs.map(() => 'tags LIKE ?').join(' OR ')})`);
        params.push(...cs, ...cs.map(c => `%,${c},%`));
      }
      if (f.severities) { const s = [...f.severities]; where.push(`severity IN (${s.map(() => '?').join(',')})`); params.push(...s); }
      if (f.result) { where.push('result = ?'); params.push(f.result); }
      if (f.actions) {
        where.push(`(${f.actions.map(a => (a.endsWith('*') ? 'action LIKE ?' : 'action = ?')).join(' OR ')})`);
        params.push(...f.actions.map(a => (a.endsWith('*') ? `${a.slice(0, -1)}%` : a)));
      }
      if (f.q) {
        where.push("(LOWER(COALESCE(summary,'')) LIKE ? OR LOWER(COALESCE(target_name,'')) LIKE ? OR LOWER(COALESCE(actor_email,'')) LIKE ? OR action LIKE ? OR LOWER(COALESCE(device,'')) LIKE ?)");
        const like = `%${f.q.replace(/[%_]/g, '')}%`;
        params.push(like, like, like, like, like);
      }
      // target filter is applied after mapping (related[] is empty for audit rows)
      if (f.targetType) { where.push('target_type = ?'); params.push(f.targetType); if (f.targetId != null) { where.push('target_id = ?'); params.push(f.targetId); } }
      const items = [];
      let exhausted = false; let lastKey = null; let cur = null; let batch = Math.max(needed + 1, 50); let scanned = 0;
      while (items.length < needed && scanned < MAX_SCAN_ROWS) {
        const w = [...where]; const p = [...params];
        if (cur) { w.push('(created_at < ? OR (created_at = ? AND id < ?))'); p.push(cur.t, cur.t, cur.id); }
        const rows = db.prepare(`SELECT * FROM audit_log WHERE ${w.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...p, batch);
        scanned += rows.length;
        for (const r of rows) {
          const it = auditItem(r);
          lastKey = itemKey(it);
          if (f.cursor && keyCompare(lastKey, f.cursor) <= 0) continue;
          if (itemMatches(it, f)) items.push(it);
        }
        if (rows.length < batch) { exhausted = true; break; }
        const last = rows[rows.length - 1]; cur = { t: last.created_at, id: last.id };
        batch = Math.min(batch * 2, 2000);
      }
      return { name: 'audit', items, exhausted, frontier: exhausted ? null : lastKey };
    },

    relay: groupedSource({
      name: 'relay',
      rawSql: 'SELECT id, equipment_id, channel, state, source, automation_id, created_at, confirmed, readback_state, user_email FROM relay_events',
      timeCol: 'created_at', fmt: 'space', gapS: RELAY_GAP_S, bucketS: RELAY_BUCKET_S,
      where: (f) => {
        const where = []; const params = [];
        // Audit era: people's relay writes live in audit_log.
        where.push("NOT (user_email IS NOT NULL AND source IN ('manual','all_channels') AND created_at >= ?)"); params.push(eraSpace);
        if (f.actor) { where.push('LOWER(user_email) = ?'); params.push(f.actor); }
        if (f.actorType === 'user') { where.push("source IN ('manual','all_channels')"); }
        if (f.actorType === 'system') { where.push("source NOT IN ('manual','all_channels')"); }
        if (f.targetType === 'equipment' && f.targetId != null) { where.push('equipment_id = ?'); params.push(parseInt(f.targetId, 10) || -1); }
        if (f.targetType === 'automation' && f.targetId != null) { where.push('automation_id = ?'); params.push(parseInt(f.targetId, 10) || -1); }
        return { where, params };
      },
      keyFn: (r) => `${r.source}|${r.automation_id ?? ''}|${r.user_email ?? ''}`,
      prepare: (groups) => {
        // Pre-audit era user bursts: borrow the device from request_log.
        for (const g of groups) {
          const r0 = g.rows[0];
          if (!r0.user_email || !['manual', 'all_channels'].includes(r0.source)) continue;
          try {
            const ua = db.prepare("SELECT user_agent FROM request_log WHERE method = 'POST' AND path LIKE ? AND created_at >= ? AND created_at <= ? LIMIT 1")
              .get(`/${r0.equipment_id}/relay/%`, isoLower(addSeconds(g.start, -3)), isoUpper(addSeconds(g.end, 3)));
            if (ua) g._device = deviceFromUA(ua.user_agent);
          } catch (_) {}
        }
      },
      toItem: (g, refs) => relayGroupItem(g, refs, { device: g._device }),
    }),

    automation: simpleSource({
      name: 'automation',
      sql: 'SELECT l.id, l.automation_id, l.status, l.message, l.triggered_at, l.completed_at FROM automation_logs l',
      timeCol: 'triggered_at', fmt: 'space',
      pushdown: (f) => (f.targetType === 'automation' && f.targetId != null ? { where: ['automation_id = ?'], params: [parseInt(f.targetId, 10) || -1] } : null),
      map: automationLogItem,
    }),

    alert: simpleSource({
      name: 'alert',
      sql: 'SELECT id, equipment_id, zone_id, severity, message, acknowledged, acknowledged_by, created_at, acknowledged_at, fingerprint, occurrence_count, last_seen_at, source, automation_id FROM alerts',
      timeCol: 'created_at', fmt: 'space',
      pushdown: (f) => {
        const where = []; const params = [];
        if (f.severities) { const s = [...f.severities]; where.push(`severity IN (${s.map(() => '?').join(',')})`); params.push(...s); }
        if (f.targetType === 'equipment' && f.targetId != null) { where.push('equipment_id = ?'); params.push(parseInt(f.targetId, 10) || -1); }
        if (f.targetType === 'automation' && f.targetId != null) { where.push('automation_id = ?'); params.push(parseInt(f.targetId, 10) || -1); }
        return where.length ? { where, params } : null;
      },
      map: alertItem,
    }),

    alert_ack: (f, refs, needed) => {
      const top = topBound(f);
      const hi = toSpace(top) < eraSpace ? toSpace(top) : eraSpace;
      const where = ['acknowledged = 1', 'acknowledged_at IS NOT NULL', 'acknowledged_at <= ?', 'acknowledged_at < ?'];
      const params = [hi, eraSpace];
      if (f.from) { where.push('acknowledged_at >= ?'); params.push(toSpace(f.from)); }
      const rows = db.prepare(`
        SELECT acknowledged_at, acknowledged_by, MIN(id) AS min_id, COUNT(*) AS n, MIN(message) AS message
        FROM alerts WHERE ${where.join(' AND ')}
        GROUP BY acknowledged_at, acknowledged_by ORDER BY acknowledged_at DESC, min_id DESC LIMIT ?
      `).all(...params, needed * 3 + 10);
      const items = [];
      let lastKey = null;
      for (const r of rows) {
        r._iso = toIso(r.acknowledged_at);
        const it = alertAckItem(r, refs);
        lastKey = itemKey(it);
        if (f.cursor && keyCompare(lastKey, f.cursor) <= 0) continue;
        if (itemMatches(it, f)) items.push(it);
      }
      const exhausted = rows.length < needed * 3 + 10;
      return { name: 'alert_ack', items, exhausted, frontier: exhausted ? null : lastKey };
    },

    flow: simpleSource({ name: 'flow', sql: 'SELECT * FROM irrigation_flow_episodes', timeCol: 'started_at', fmt: 'iso', map: flowItem }),
    irrigation_run: simpleSource({
      name: 'irrigation_run',
      sql: 'SELECT id, run_key, type, status, started_at, ended_at, local_date, duration_s, water_l, automation_id, operators, uncontrolled_dosing, provisional FROM irrigation_runs',
      timeCol: 'started_at', fmt: 'iso', map: irrigationRunItem,
    }),
    dose_run: simpleSource({
      name: 'dose_run',
      sql: 'SELECT id, cycle_log_id, program_id, automation_id, started_at, ended_at, status, end_reason, duration_s, water_l, ph_avg, ec_avg FROM dose_controller_runs',
      timeCol: 'started_at', fmt: 'iso', map: doseRunItem,
    }),
    dose_cycle: simpleSource({
      name: 'dose_cycle',
      sql: 'SELECT id, program_id, automation_id, cycle_started_at, cycle_ended_at, duration_seconds, status, notes FROM fertigation_dose_cycle_log',
      timeCol: 'cycle_started_at', fmt: 'space',
      extraWhere: () => ['id NOT IN (SELECT cycle_log_id FROM dose_controller_runs WHERE cycle_log_id IS NOT NULL)'],
      map: doseCycleItem,
    }),
    drift: simpleSource({ name: 'drift', sql: 'SELECT * FROM relay_drift_log', timeCol: 'created_at', fmt: 'space', map: driftItem }),

    request: groupedSource({
      name: 'request',
      rawSql: 'SELECT id, method, path, status, duration_ms, ip, user_agent, created_at FROM request_log',
      timeCol: 'created_at', fmt: 'iso', gapS: REQUEST_GAP_S, bucketS: RELAY_BUCKET_S,
      where: () => ({
        where: [
          "method IN ('POST','PUT','PATCH','DELETE')",
          'created_at < ?',
          "path NOT LIKE '%/relay/control'", "path NOT LIKE '%/relay/all'", "path NOT LIKE '%/ptz/stop'",
        ],
        params: [eraStart],
      }),
      keyFn: (r) => `${r.method}|${r.path}|${r.status}|${r.user_agent || ''}`,
      prepare: (groups) => {
        for (const g of groups) {
          const r0 = g.rows[0];
          if (!/\/login$/.test(r0.path) || !(r0.status >= 200 && r0.status < 300)) continue;
          try {
            const hits = db.prepare('SELECT u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.created_at >= ? AND s.created_at <= ?')
              .all(toSpace(addSeconds(g.start, -3)), toSpace(addSeconds(g.start, 3)));
            if (hits.length === 1) r0._login_user = hits[0];
          } catch (_) {}
        }
      },
      toItem: legacyRequestItem,
    }),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function stripInternal(it) {
  const { _sort, ...rest } = it;
  return rest;
}

/** One page of merged log items. */
function queryLogs(query = {}, opts = {}) {
  const f = opts.filters || parseFilters(query);
  const refs = opts.refs || loadRefs();
  const eraStart = auditEraStart();
  const fetchers = buildFetchers(eraStart);
  const results = [];
  const errors = {};
  for (const name of SOURCES) {
    if (!sourceApplies(name, f, eraStart)) continue;
    try {
      results.push(fetchers[name](f, refs, f.limit));
    } catch (err) {
      // A missing table (fresh install) or a bad row must not blank the page.
      errors[name] = err.message;
    }
  }
  // Frontier: the newest point below which some source still has unread rows.
  let frontier = null;
  for (const r of results) if (!r.exhausted && r.frontier && (!frontier || keyCompare(r.frontier, frontier) < 0)) frontier = r.frontier;

  let all = [];
  for (const r of results) all = all.concat(r.items);
  all.sort((a, b) => keyCompare(itemKey(a), itemKey(b)));
  const allowed = frontier ? all.filter(it => keyCompare(itemKey(it), frontier) <= 0) : all;
  const page = allowed.slice(0, f.limit);
  const hasMore = allowed.length > f.limit || !!frontier;
  let nextCursor = null;
  if (hasMore) {
    if (page.length === f.limit) nextCursor = encodeCursor(itemKey(page[page.length - 1]));
    else if (frontier) nextCursor = encodeCursor(frontier);
  }
  return {
    items: page.map(stripInternal),
    next_cursor: nextCursor,
    has_more: hasMore,
    audit_started_at: eraStart.startsWith('9999') ? null : eraStart,
    timezone: f.tz,
    filters: { from: f.from, to: f.to },
    source_errors: Object.keys(errors).length ? errors : undefined,
  };
}

/** Iterate pages until `max` items (CSV export). */
function collectLogs(query = {}, max = 5000) {
  const f = parseFilters({ ...query, limit: MAX_LIMIT });
  const refs = loadRefs();
  const out = [];
  let guard = 0;
  let res;
  do {
    res = queryLogs({}, { filters: f, refs });
    out.push(...res.items);
    f.cursor = res.next_cursor ? decodeCursor(res.next_cursor) : null;
    guard++;
  } while (res.has_more && f.cursor && out.length < max && guard < 200);
  return { items: out.slice(0, max), truncated: out.length > max || (res.has_more && out.length >= max), timezone: f.tz };
}

function relayRowsDetail(rows, refs) {
  return rows.map(r => ({
    id: r.id, time: toIso(r.created_at), equipment_id: r.equipment_id, channel: r.channel,
    name: refs.chName(r.equipment_id, r.channel), state: r.state === 1 ? 'ON' : 'OFF',
    confirmed: r.confirmed === null || r.confirmed === undefined ? null : !!r.confirmed,
    readback: r.readback_state === null || r.readback_state === undefined ? null : (r.readback_state ? 'ON' : 'OFF'),
    source: r.source, automation_id: r.automation_id, automation_name: r.automation_id != null ? refs.autoName(r.automation_id) : null,
    user_email: r.user_email,
  }));
}

const RELAY_EFFECT_ACTIONS = {
  'relay.control': 'user', 'relay.all': 'user', stop_all: 'stop_all', emergency_stop: 'stop_all', 'irrigation.stop': 'stop_irrigation',
  'automation.trigger': 'automation',
};

/** Full detail for one item. Returns null when not found. */
function getLogDetail(source, id) {
  const refs = loadRefs();
  if (source === 'audit') {
    const r = db.prepare('SELECT * FROM audit_log WHERE id = ?').get(parseInt(id, 10));
    if (!r) return null;
    const item = stripInternal(auditItem(r));
    const details = r.details ? parseMaybeJson(r.details) : null;
    let effects = [];
    const kind = RELAY_EFFECT_ACTIONS[r.action];
    if (kind && r.result === 'ok') {
      const start = toSpace(addSeconds(toIso(r.created_at), -1));
      const end = toSpace(addSeconds(toIso(r.created_at), Math.ceil((r.duration_ms || 0) / 1000) + 5));
      let rows = [];
      try {
        if (kind === 'user') rows = db.prepare('SELECT * FROM relay_events WHERE created_at BETWEEN ? AND ? AND equipment_id = ? AND (user_email = ? OR user_email IS NULL) ORDER BY id LIMIT 200').all(start, end, parseInt(r.target_id, 10) || -1, r.actor_email || '');
        else if (kind === 'automation') rows = db.prepare('SELECT * FROM relay_events WHERE created_at BETWEEN ? AND ? AND automation_id = ? ORDER BY id LIMIT 200').all(start, end, parseInt(r.target_id, 10) || -1);
        else rows = db.prepare('SELECT * FROM relay_events WHERE created_at BETWEEN ? AND ? AND source IN (?, ?) ORDER BY id LIMIT 500').all(start, end, kind, 'stop_all');
      } catch (_) { rows = []; }
      effects = relayRowsDetail(rows, refs);
    }
    return { item, details, relay_effects: effects, raw: { method: r.method, path: r.path, user_agent: r.user_agent, duration_ms: r.duration_ms } };
  }
  if (source === 'relay' || source === 'request') {
    const m = String(id).match(/^(\d+)-(\d+)$/);
    if (!m) return null;
    const lo = parseInt(m[1], 10); const hi = parseInt(m[2], 10);
    if (hi < lo || hi - lo > 100000) return null;
    if (source === 'relay') {
      const first = db.prepare('SELECT * FROM relay_events WHERE id = ?').get(lo);
      if (!first) return null;
      const rows = db.prepare(`SELECT * FROM relay_events WHERE id BETWEEN ? AND ? AND source = ? AND automation_id IS ? AND user_email IS ? ORDER BY id LIMIT 1000`)
        .all(lo, hi, first.source, first.automation_id, first.user_email);
      for (const r of rows) r._iso = toIso(r.created_at);
      const g = { key: '', rows, start: rows[0]._iso, end: rows[rows.length - 1]._iso, minId: lo, maxId: hi };
      return { item: stripInternal(relayGroupItem(g, refs, null)), details: { writes: relayRowsDetail(rows, refs) } };
    }
    const first = db.prepare('SELECT * FROM request_log WHERE id = ?').get(lo);
    if (!first) return null;
    const rows = db.prepare('SELECT id, method, path, status, duration_ms, ip, user_agent, created_at FROM request_log WHERE id BETWEEN ? AND ? AND method = ? AND path = ? AND status IS ? AND user_agent IS ? ORDER BY id LIMIT 500')
      .all(lo, hi, first.method, first.path, first.status, first.user_agent);
    for (const r of rows) r._iso = toIso(r.created_at);
    const g = { key: '', rows, start: rows[0]._iso, end: rows[rows.length - 1]._iso, minId: lo, maxId: hi };
    const item = stripInternal(legacyRequestItem(g, refs));
    return {
      item,
      details: {
        note: 'Recorded before the audit log existed: request_log keeps the device and the router-relative path, not the user or the body.',
        requests: rows.map(r => ({ id: r.id, time: r._iso, method: r.method, path: r.path, status: r.status, duration_ms: r.duration_ms, device: deviceFromUA(r.user_agent), user_agent: r.user_agent })),
        route_candidates: RouteMap.matchLegacyPath(first.method, first.path).map(x => x.def.pattern),
      },
    };
  }
  const nId = parseInt(id, 10);
  if (!Number.isFinite(nId)) return null;
  if (source === 'automation') {
    const r = db.prepare('SELECT * FROM automation_logs WHERE id = ?').get(nId);
    if (!r) return null;
    r._iso = toIso(r.triggered_at);
    const start = toSpace(addSeconds(r._iso, -1));
    const end = toSpace(addSeconds(r._iso, 15));
    const writes = db.prepare('SELECT * FROM relay_events WHERE automation_id = ? AND created_at BETWEEN ? AND ? ORDER BY id LIMIT 200').all(r.automation_id, start, end);
    return { item: stripInternal(automationLogItem(r, refs)), details: { message: r.message, status: r.status, triggered_at: r.triggered_at, completed_at: r.completed_at, relay_writes_first_15s: relayRowsDetail(writes, refs) } };
  }
  if (source === 'alert' || source === 'alert_ack') {
    const r = db.prepare('SELECT * FROM alerts WHERE id = ?').get(nId);
    if (!r) return null;
    const ackUser = r.acknowledged_by != null ? refs.users.get(r.acknowledged_by) : null;
    if (source === 'alert_ack') {
      const rows = db.prepare('SELECT id, severity, message FROM alerts WHERE acknowledged_at IS ? AND acknowledged_by IS ? ORDER BY id LIMIT 200').all(r.acknowledged_at, r.acknowledged_by);
      const n = db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE acknowledged_at IS ? AND acknowledged_by IS ?').get(r.acknowledged_at, r.acknowledged_by).n;
      r._iso = toIso(r.acknowledged_at);
      return { item: stripInternal(alertAckItem({ ...r, min_id: r.id, n }, refs)), details: { acknowledged_alerts: rows, total: n } };
    }
    r._iso = toIso(r.created_at);
    return { item: stripInternal(alertItem(r, refs)), details: { ...r, acknowledged_by_email: ackUser ? ackUser.email : null } };
  }
  const table = { flow: 'irrigation_flow_episodes', irrigation_run: 'irrigation_runs', dose_run: 'dose_controller_runs', dose_cycle: 'fertigation_dose_cycle_log', drift: 'relay_drift_log' }[source];
  if (!table) return null;
  const r = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(nId);
  if (!r) return null;
  const timeCol = { flow: 'started_at', irrigation_run: 'started_at', dose_run: 'started_at', dose_cycle: 'cycle_started_at', drift: 'created_at' }[source];
  r._iso = toIso(r[timeCol]);
  const mapper = { flow: flowItem, irrigation_run: irrigationRunItem, dose_run: doseRunItem, dose_cycle: doseCycleItem, drift: driftItem }[source];
  const details = {};
  for (const [k, v] of Object.entries(r)) if (k !== '_iso') details[k] = typeof v === 'string' && /_json$|^detail$|^effective_duty_pcts$/.test(k) ? parseMaybeJson(v) : v;
  return { item: stripInternal(mapper(r, refs)), details };
}

/** Filter dropdown values. */
function getFacets() {
  const refs = loadRefs();
  const users = new Map();
  const add = (email, role) => { if (!email) return; const k = String(email).toLowerCase(); if (!users.has(k)) users.set(k, { email, role: role || null }); };
  for (const u of refs.users.values()) add(u.email, u.role);
  try { for (const r of db.prepare('SELECT DISTINCT actor_email, actor_role FROM audit_log WHERE actor_email IS NOT NULL LIMIT 200').all()) add(r.actor_email, r.actor_role); } catch (_) {}
  try { for (const r of db.prepare('SELECT DISTINCT user_email FROM relay_events WHERE user_email IS NOT NULL LIMIT 200').all()) add(r.user_email, null); } catch (_) {}
  let actions = [];
  try { actions = db.prepare('SELECT action, COUNT(*) AS n FROM audit_log GROUP BY action ORDER BY n DESC LIMIT 200').all().map(r => r.action); } catch (_) {}
  const systemActions = ['relay.automation', 'relay.auto_off', 'relay.stop_all', 'relay.control', 'relay.watchdog_force_off', 'relay.interlock', 'relay.dose_controller', 'relay.ph_controller', 'relay.flow_watch_shutdown', 'relay.drift', 'automation.run', 'automation.failed', 'alert.raised', 'alert.resolved', 'flow_watch.valve_no_flow', 'flow_watch.run_shutdown', 'irrigation.run_automated', 'irrigation.run_manual_app', 'irrigation.run_manual_panel', 'dosing.run', 'dosing.cycle'];
  const era = auditEraStart();
  return {
    categories: CATEGORIES,
    severities: SEVERITIES,
    sources: SOURCES,
    users: [...users.values()].sort((a, b) => a.email.localeCompare(b.email)),
    actions: [...new Set([...actions, ...systemActions])],
    equipment: [...refs.equipment.values()].map(e => ({ id: e.id, name: e.name, type: e.type })).sort((a, b) => a.name.localeCompare(b.name)),
    automations: [...refs.automations.values()].map(a => ({ id: a.id, name: a.name })).sort((a, b) => a.name.localeCompare(b.name)),
    audit_started_at: era.startsWith('9999') ? null : era,
    timezone: getSystemTimezone(db),
  };
}

module.exports = {
  queryLogs,
  collectLogs,
  getLogDetail,
  getFacets,
  parseFilters,
  encodeCursor,
  decodeCursor,
  keyCompare,
  groupRows,
  toIso,
  startOfLocalDay,
  SOURCES,
  CATEGORIES,
  _resetAuditEraCache,
};
