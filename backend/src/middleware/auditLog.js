/**
 * Audit middleware — records every mutating API request (POST / PUT / PATCH /
 * DELETE under /api) in audit_log with the authenticated user, role, client
 * IP, device, action, target, summary, redacted body, BEFORE / AFTER
 * snapshots + field-level diff, result and duration.
 *
 * Mounted once, globally, BEFORE the routers (index.js). Route-level
 * authMiddleware sets req.user later on the same req object, so the actor is
 * read when the response finishes. New routes are logged automatically (a
 * generic entry when AuditRouteMap has no def for them).
 *
 * Safety: never blocks or breaks a request. Every step is wrapped in
 * try/catch; the BEFORE snapshot is a couple of indexed SELECTs; everything
 * else (AFTER snapshot, diff, insert) runs in setImmediate after 'finish'.
 * Read-only for the plant: no relay / Modbus access here.
 */

const jwt = require('jsonwebtoken');
const { db } = require('../utils/database');
const { JWT_SECRET } = require('./auth');
const {
  recordAudit, redact, bound, pickScalars, deviceFromUA, clientIp, isSecretPath, REDACTED,
} = require('../services/AuditLogService');
const { matchRoute, genericDef } = require('../services/AuditRouteMap');
const { diffSnapshots, describeChanges, joinPhrases } = require('../services/AuditDiff');
const { channelLabel, equipmentRow } = require('../services/AuditRouteMap');

const BODY_MAX_BYTES = 8 * 1024;
const SNAPSHOT_MAX_BYTES = 16 * 1024;
const DIFF_MAX_BYTES = 12 * 1024;
const RESPONSE_MAX_BYTES = 2 * 1024;

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Non-GET calls that are pure keep-alives / telemetry and never an action.
const SKIP_PATHS = new Set(['/api/health']);

function resultFor(status) {
  if (status >= 200 && status < 400) return 'ok';
  if (status === 401 || status === 403 || status === 409 || status === 423) return 'denied';
  return 'error';
}

function severityFor(result, status, okSeverity) {
  if (result === 'ok') return okSeverity || 'info';
  if (result === 'denied') return 'warning';
  return status >= 500 ? 'critical' : 'warning';
}

function evalField(v, ctx, fallback) {
  try {
    if (typeof v === 'function') return v(ctx);
    return v === undefined ? fallback : v;
  } catch (_) { return fallback; }
}

function resolveSessionActor(req) {
  try {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Bearer ')) return null;
    const token = h.slice(7);
    jwt.verify(token, JWT_SECRET);
    const s = db.prepare('SELECT u.id, u.email, u.role FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ?').get(token);
    return s ? { id: s.id, email: s.email, role: s.role } : null;
  } catch (_) { return null; }
}

function errorMessage(resBody) {
  if (!resBody || typeof resBody !== 'object') return null;
  const m = resBody.message || resBody.error;
  return typeof m === 'string' ? m.slice(0, 160) : null;
}

/** Diff entries with secret paths keep the path but lose the values. */
function redactDiff(diff) {
  return diff.map(d => (isSecretPath(d.path)
    ? { path: d.path, before: REDACTED, after: REDACTED, redacted: true }
    : { ...d, before: redact(d.before), after: redact(d.after) }));
}

function lookupChannel(eqId, ch) {
  try { return channelLabel(equipmentRow(eqId), ch); } catch (_) { return null; }
}

function finalize(req, res, ctx) {
  try {
    const status = res.statusCode;
    const def = ctx.def;
    const c = {
      params: ctx.params, body: ctx.body || {}, query: req.query || {}, status,
      ok: status >= 200 && status < 400, resBody: ctx.resBody, before: ctx.before, after: null,
      user: req.user || ctx.preActor || null, diff: null, changes: null, changesText: '',
      contentLength: ctx.contentLength,
    };

    // Actor
    let actor = req.user ? { id: req.user.id, email: req.user.email, role: req.user.role } : (ctx.preActor || null);
    if (def.actorFromBody) {
      const email = c.body && typeof c.body.email === 'string' ? c.body.email.slice(0, 200) : null;
      let known = null;
      try { known = email ? db.prepare('SELECT id, email, role FROM users WHERE email = ?').get(email) : null; } catch (_) {}
      actor = { id: known ? known.id : null, email: known ? known.email : email, role: known ? known.role : null };
      c.actorUserId = known ? known.id : null;
    }
    c.actorEmail = actor && actor.email;

    // AFTER snapshot + diff (only when the call succeeded)
    if (c.ok && def.after) {
      try {
        c.after = def.after === true ? (def.before ? def.before(c) : null) : def.after(c);
      } catch (_) { c.after = null; }
    }
    if (def.before && def.after && (c.before || c.after)) {
      try {
        const raw = diffSnapshots(c.before, c.ok ? c.after : c.before);
        c.diff = redactDiff(raw);
        c.changes = describeChanges(c.diff, { before: c.before, after: c.after, lookupChannel });
        c.changesText = joinPhrases(c.changes);
      } catch (_) { c.diff = null; }
    }

    const action = evalField(def.actionFn, c, null) || evalField(def.action, c, `${req.method.toLowerCase()}.request`);
    const category = evalField(def.category, c, 'system') || 'system';
    const tags = evalField(def.tags, c, []) || [];
    const target = evalField(def.target, c, null);
    const result = resultFor(status);
    let summary = evalField(def.summary, c, null) || `${req.method} ${ctx.path}`;
    if (result !== 'ok' && !def.noResultSuffix) {
      const msg = errorMessage(c.resBody);
      summary += ` — ${result === 'denied' ? 'refused' : 'failed'} (${status}${msg ? `: ${msg}` : ''})`;
    }
    const okSeverity = evalField(def.severityFn, c, null) || def.severity || 'info';

    const details = {};
    const body = redact(c.body);
    if (body && typeof body === 'object' && Object.keys(body).length) details.body = bound(body, BODY_MAX_BYTES);
    if (ctx.contentLength && ctx.isBinary) details.upload_bytes = ctx.contentLength;
    if (req.query && Object.keys(req.query).length) details.query = bound(redact(req.query), 1024);
    if (ctx.params && Object.keys(ctx.params).length) details.params = ctx.params;
    if (def.keepSnapshots !== false) {
      if (c.before) details.before = bound(redact(c.before), SNAPSHOT_MAX_BYTES);
      if (c.after) details.after = bound(redact(c.after), SNAPSHOT_MAX_BYTES);
      if (c.diff) details.diff = bound(c.diff, DIFF_MAX_BYTES);
      if (c.changes && c.changes.length) details.changes = c.changes.slice(0, 40);
    }
    if (target && target.channel !== undefined && target.channel !== null) details.channel = target.channel;
    if (!def.actorFromBody) {
      const resp = pickScalars(c.resBody);
      if (resp) details.response = bound(resp, RESPONSE_MAX_BYTES);
    }
    if (result !== 'ok') { const msg = errorMessage(c.resBody); if (msg) details.error = msg; }
    if (ctx.remoteAddr && ctx.remoteAddr !== ctx.ip) details.remote_addr = ctx.remoteAddr;
    if (def.generic) details.unmapped_route = true;
    if (ctx.aborted) details.client_aborted = true;

    recordAudit({
      created_at: ctx.startIso,
      actor_type: 'user',
      actor_id: actor ? actor.id : null,
      actor_email: actor ? actor.email : null,
      actor_role: actor ? actor.role : null,
      ip: ctx.ip,
      device: ctx.device,
      user_agent: ctx.ua,
      method: req.method,
      path: ctx.path,
      action,
      category,
      tags: [category, ...tags].filter(Boolean),
      target_type: target ? target.type : null,
      target_id: target ? target.id : null,
      target_name: target ? target.name : null,
      summary,
      details: Object.keys(details).length ? details : null,
      result,
      status_code: status,
      duration_ms: ctx.durationMs,
      severity: severityFor(result, status, okSeverity),
    }, def.coalesceSeconds ? {
      coalesceKey: `${actor && actor.email}|${action}|${target && target.id}|${result}`,
      coalesceSeconds: def.coalesceSeconds,
    } : {});
  } catch (err) {
    console.error('[AuditLog] finalize failed:', err.message);
  }
}

function auditMiddleware(req, res, next) {
  try {
    if (!MUTATING.has(req.method)) return next();
    const path = String(req.originalUrl || req.url || '').split('?')[0];
    if (!path.startsWith('/api/') || SKIP_PATHS.has(path)) return next();

    const match = matchRoute(req.method, path);
    const def = match ? match.def : genericDef(req.method, path);
    if (def.skip) return next();

    const ua = req.headers['user-agent'] || '';
    const cl = parseInt(req.headers['content-length'], 10);
    const ctype = String(req.headers['content-type'] || '');
    const ctx = {
      def,
      params: match ? match.params : {},
      path,
      startMs: Date.now(),
      startIso: new Date().toISOString(),
      ip: clientIp(req),
      remoteAddr: String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, ''),
      ua: String(ua).slice(0, 300),
      device: deviceFromUA(ua),
      body: req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {},
      contentLength: Number.isFinite(cl) ? cl : null,
      isBinary: !/json|x-www-form-urlencoded|^$/.test(ctype),
      before: null,
      resBody: undefined,
      preActor: null,
      done: false,
    };

    if (def.preResolveActor) ctx.preActor = resolveSessionActor(req);
    if (def.before) {
      try {
        ctx.before = def.before({ params: ctx.params, body: ctx.body, query: req.query || {} });
      } catch (_) { ctx.before = null; }
    }

    // Keep a reference to the JSON body the handler sends (used for created
    // ids and scalar result fields; never stored wholesale).
    const origJson = res.json;
    res.json = function auditJson(payload) {
      try { ctx.resBody = payload; } catch (_) {}
      return origJson.call(this, payload);
    };

    const done = (aborted) => {
      if (ctx.done) return;
      ctx.done = true;
      ctx.aborted = !!aborted;
      ctx.durationMs = Date.now() - ctx.startMs;
      setImmediate(() => finalize(req, res, ctx));
    };
    res.on('finish', () => done(false));
    res.on('close', () => { if (!res.writableFinished) done(true); });
  } catch (err) {
    console.error('[AuditLog] middleware setup failed:', err.message);
  }
  return next();
}

module.exports = { auditMiddleware, _finalize: finalize, resultFor };
