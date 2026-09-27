/**
 * AuditLogService — writes the action audit trail (audit_log) and holds the
 * helpers the audit middleware and the unified Logs API share: secret
 * redaction, bounded JSON, user-agent -> device label, client IP.
 *
 * Writes never throw: a failed audit insert is logged to the console and the
 * caller carries on. Nothing here touches hardware.
 */

const { db } = require('../utils/database');

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

// Key names whose VALUES are never stored: passwords, tokens, API keys, MQTT /
// camera / Telegram credentials, JWTs.
const SECRET_KEY_RE = /(pass(word|wd|phrase)?|pwd|secret|token|api[_-]?key|apikey|authorization|auth[_-]?key|private[_-]?key|credential|access[_-]?key|signature|cookie)/i;
const JWT_RE = /^eyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}$/;
const BEARER_RE = /^Bearer\s+\S+/i;
const REDACTED = '[redacted]';

function isSecretKey(key) {
  return typeof key === 'string' && SECRET_KEY_RE.test(key);
}

function redact(value, depth = 0) {
  if (depth > 12) return '[depth limit]';
  if (typeof value === 'string') {
    if (JWT_RE.test(value) || BEARER_RE.test(value)) return REDACTED;
    return value;
  }
  if (Buffer.isBuffer(value)) return `[binary ${value.length} bytes]`;
  if (Array.isArray(value)) return value.map(v => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSecretKey(k) && v !== null && v !== undefined && v !== '' ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** True when any segment of a diff path ("cloud_config.api_key") is a secret key. */
function isSecretPath(path) {
  return String(path || '').split(/[.[\]]/).some(isSecretKey);
}

// ---------------------------------------------------------------------------
// Bounded JSON
// ---------------------------------------------------------------------------

/**
 * Returns `value` unchanged when its JSON is <= maxBytes, else a marker object
 * with a string preview so the row stays small and still readable.
 */
function bound(value, maxBytes) {
  if (value === undefined) return undefined;
  let s;
  try { s = JSON.stringify(value); } catch (_) { return { _unserialisable: true }; }
  if (s === undefined) return undefined;
  if (s.length <= maxBytes) return value;
  return { _truncated: true, _bytes: s.length, preview: s.slice(0, Math.max(0, maxBytes - 80)) };
}

/** Top-level scalar fields of a response body (numbers, booleans, short strings), redacted. */
function pickScalars(body, maxKeys = 24) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(body)) {
    if (n >= maxKeys) break;
    if (isSecretKey(k)) continue;
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) { out[k] = v; n++; }
    else if (typeof v === 'string' && v.length <= 300 && !JWT_RE.test(v)) { out[k] = v; n++; }
    else if (Array.isArray(v) && k === 'failed') { out.failed_count = v.length; n++; }
  }
  return n ? out : undefined;
}

// ---------------------------------------------------------------------------
// Device + IP
// ---------------------------------------------------------------------------

function deviceFromUA(ua) {
  const s = String(ua || '');
  if (!s.trim()) return 'unknown device';
  if (/HeadlessChrome|curl\/|Wget|python|node-fetch|axios|Go-http|okhttp|PostmanRuntime|undici|^node\b|insomnia|httpie|libwww/i.test(s)) {
    return 'headless/script';
  }
  let base;
  if (/iPhone|iPod/.test(s)) base = 'iPhone';
  else if (/iPad/.test(s)) base = 'iPad';
  else if (/Android/.test(s)) base = /Mobile/.test(s) ? 'Android phone' : 'Android tablet';
  else if (/Windows/.test(s)) base = 'Windows PC';
  else if (/Macintosh|Mac OS X/.test(s)) base = 'Mac';
  else if (/CrOS/.test(s)) base = 'Chromebook';
  else if (/Linux|X11/.test(s)) base = 'Linux PC';
  else if (/Mozilla/.test(s)) base = 'browser';
  else return 'headless/script';
  if (/\bClaude\//.test(s)) base += ' (Claude app)';
  return base;
}

/** Coarse device class for icons: phone | tablet | desktop | script | unknown. */
function deviceClass(device) {
  const d = String(device || '');
  if (/phone|iPhone/i.test(d)) return 'phone';
  if (/tablet|iPad/i.test(d)) return 'tablet';
  if (/script/i.test(d)) return 'script';
  if (/PC|Mac|Chromebook|browser/i.test(d)) return 'desktop';
  return 'unknown';
}

const PRIVATE_ADDR_RE = /^(::ffff:)?(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)|^::1$|^localhost$/;
const stripV6Prefix = (ip) => String(ip || '').replace(/^::ffff:/, '').trim();

/**
 * Client IP. Behind the frontend nginx / cloudflared the socket peer is a
 * private proxy address; only then are CF-Connecting-IP / X-Forwarded-For /
 * X-Real-IP believed (a direct client could forge them).
 */
function clientIp(req) {
  const remote = (req.socket && req.socket.remoteAddress) || req.ip || '';
  if (PRIVATE_ADDR_RE.test(remote)) {
    const h = req.headers || {};
    const cf = h['cf-connecting-ip'];
    const xff = typeof h['x-forwarded-for'] === 'string' ? h['x-forwarded-for'].split(',')[0].trim() : '';
    const xr = h['x-real-ip'];
    const picked = cf || xff || xr;
    if (picked) return stripV6Prefix(picked).slice(0, 64);
  }
  return stripV6Prefix(remote).slice(0, 64);
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

let schemaReady = false;
function ensureSchema() {
  if (schemaReady) return;
  require('../utils/auditLogSchema').ensureAuditLogSchema(db);
  schemaReady = true;
}

let insertStmt = null;
let coalesceStmt = null;
const coalesceMap = new Map(); // key -> { id, lastMs }

const DETAILS_MAX_BYTES = 64 * 1024;

/**
 * Insert one audit row. Returns the row id, or null on failure.
 * opts.coalesceKey + opts.coalesceSeconds: repeated identical actions inside
 * the window bump repeat_count / last_at on the previous row instead.
 */
function recordAudit(entry, opts = {}) {
  try {
    ensureSchema();
    const nowIso = entry.created_at || new Date().toISOString();
    if (opts.coalesceKey && opts.coalesceSeconds) {
      const prev = coalesceMap.get(opts.coalesceKey);
      const nowMs = Date.parse(nowIso);
      if (prev && nowMs - prev.lastMs <= opts.coalesceSeconds * 1000) {
        if (!coalesceStmt) coalesceStmt = db.prepare('UPDATE audit_log SET repeat_count = repeat_count + 1, last_at = ? WHERE id = ?');
        const r = coalesceStmt.run(nowIso, prev.id);
        if (r.changes) { prev.lastMs = nowMs; return prev.id; }
      }
    }
    if (!insertStmt) {
      insertStmt = db.prepare(`
        INSERT INTO audit_log (created_at, actor_type, actor_id, actor_email, actor_role, ip, device, user_agent,
          method, path, action, category, tags, target_type, target_id, target_name, summary, details,
          result, status_code, duration_ms, severity)
        VALUES (@created_at, @actor_type, @actor_id, @actor_email, @actor_role, @ip, @device, @user_agent,
          @method, @path, @action, @category, @tags, @target_type, @target_id, @target_name, @summary, @details,
          @result, @status_code, @duration_ms, @severity)
      `);
    }
    let details = null;
    if (entry.details !== undefined && entry.details !== null) {
      details = JSON.stringify(entry.details);
      if (details.length > DETAILS_MAX_BYTES) {
        details = JSON.stringify({ _truncated: true, _bytes: details.length, preview: details.slice(0, DETAILS_MAX_BYTES - 200) });
      }
    }
    const tags = Array.isArray(entry.tags) && entry.tags.length ? `,${[...new Set(entry.tags)].join(',')},` : null;
    const row = {
      created_at: nowIso,
      actor_type: entry.actor_type || 'user',
      actor_id: entry.actor_id ?? null,
      actor_email: entry.actor_email || null,
      actor_role: entry.actor_role || null,
      ip: entry.ip || null,
      device: entry.device || null,
      user_agent: entry.user_agent ? String(entry.user_agent).slice(0, 300) : null,
      method: entry.method || null,
      path: entry.path ? String(entry.path).slice(0, 300) : null,
      action: entry.action || 'unknown',
      category: entry.category || 'system',
      tags,
      target_type: entry.target_type || null,
      target_id: entry.target_id === undefined || entry.target_id === null ? null : String(entry.target_id),
      target_name: entry.target_name ? String(entry.target_name).slice(0, 300) : null,
      summary: entry.summary ? String(entry.summary).slice(0, 600) : null,
      details,
      result: entry.result || null,
      status_code: entry.status_code ?? null,
      duration_ms: entry.duration_ms ?? null,
      severity: entry.severity || 'info',
    };
    const id = Number(insertStmt.run(row).lastInsertRowid);
    if (opts.coalesceKey && opts.coalesceSeconds) {
      coalesceMap.set(opts.coalesceKey, { id, lastMs: Date.parse(nowIso) });
      if (coalesceMap.size > 500) coalesceMap.delete(coalesceMap.keys().next().value);
    }
    if (typeof global.broadcast === 'function') {
      // The WebSocket is unauthenticated: send only a nudge, the page refetches
      // the row through the authenticated /api/logs.
      try { global.broadcast('audit_log_new', { id, created_at: nowIso }); } catch (_) {}
    }
    return id;
  } catch (err) {
    console.error('[AuditLog] Failed to record audit entry:', err.message);
    return null;
  }
}

/** Convenience for services that act on their own (actor_type 'system'). */
function logSystemAction({ action, category = 'system', summary, target_type, target_id, target_name, details, severity = 'info', actor_label }) {
  return recordAudit({
    actor_type: 'system', actor_email: null, actor_role: actor_label || null,
    action, category, summary, target_type, target_id, target_name,
    details: details ? redact(details) : null, result: 'ok', severity,
  });
}

function _resetForTests() {
  insertStmt = null; coalesceStmt = null; coalesceMap.clear(); schemaReady = false;
}

module.exports = {
  recordAudit,
  logSystemAction,
  redact,
  isSecretKey,
  isSecretPath,
  bound,
  pickScalars,
  deviceFromUA,
  deviceClass,
  clientIp,
  REDACTED,
  _resetForTests,
};
