const crypto = require('crypto');
const { db } = require('./database');
const i18n = require('../i18n');

const ENRICH_SQL = `
  SELECT a.*, e.name as equipment_name, z.name as zone_name
  FROM alerts a
  LEFT JOIN equipment e ON a.equipment_id = e.id
  LEFT JOIN zones z ON a.zone_id = z.id
  WHERE a.id = ?
`;

function safeBroadcast(event, payload) {
  try {
    if (global.broadcast && payload) global.broadcast(event, payload);
  } catch (err) {
    // Never let a broadcast failure break alert creation.
    console.error(`[alertBroadcast] Failed to broadcast ${event}:`, err.message);
  }
}

function getEnriched(id) {
  return db.prepare(ENRICH_SQL).get(Number(id));
}

function parseParams(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

/**
 * Resolve the message of createAlert()/updateOpenAlert() options.
 * `messageKey` (+ `messageParams`) wins: the stored English `message` is the
 * catalog's English render, so it always matches the key. Without a key the
 * given English `message` is stored as before (message_key = NULL).
 * A `title` (string or { $k, $p } descriptor) is kept as "Title: message".
 * @returns {{ message: string, key: string|null, params: object|null }}
 */
function resolveMessage(opts) {
  const titleIsSpec = opts.title && typeof opts.title === 'object';
  if (opts.messageKey) {
    let key = String(opts.messageKey);
    let params = opts.messageParams || {};
    if (opts.title) {
      params = { title: opts.title, message: i18n.M(key, params) };
      key = 'common.titled';
    }
    return { message: i18n.t('en', key, params), key, params };
  }
  let message = String(opts.message ?? '').trim();
  if (opts.title) {
    const title = titleIsSpec ? i18n.render('en', opts.title) : String(opts.title).trim();
    if (titleIsSpec) {
      return { message: `${title}: ${message}`, key: 'common.titled', params: { title: opts.title, message } };
    }
    message = `${title}: ${message}`;
  }
  return { message, key: null, params: null };
}

/**
 * An alert row for an API response in `lang`:
 *   message         rendered from message_key + message_params in `lang`
 *                   (old rows without a key: the stored English text)
 *   message_en      the stored English text
 *   message_key     raw key (null on old rows)
 *   message_params  parsed params (null on old rows)
 * Never throws; a render failure falls back to the English text.
 */
function localizeAlert(row, lang = 'en') {
  if (!row || typeof row !== 'object') return row;
  const params = parseParams(row.message_params);
  let message = row.message;
  if (row.message_key) {
    try {
      const out = i18n.t(lang, row.message_key, params || {});
      if (out && out !== row.message_key) message = out;
    } catch (_) { message = row.message; }
  }
  return { ...row, message, message_en: row.message, message_key: row.message_key || null, message_params: params };
}

/** WebSocket payload: the stored row (message = English, as before) + key/params + every language. */
function broadcastPayload(row, metadata) {
  const params = parseParams(row.message_params);
  let i18nMessages = null;
  if (row.message_key) {
    try { i18nMessages = i18n.renderAll({ key: row.message_key, params: params || {} }); } catch (_) { i18nMessages = null; }
  }
  return {
    ...row,
    message_en: row.message,
    message_key: row.message_key || null,
    message_params: params,
    message_i18n: i18nMessages || { en: row.message, tr: row.message, ar: row.message },
    metadata,
  };
}

/**
 * Broadcast a newly-created alert over WebSocket as a `new_alert` event.
 *
 * Given the better-sqlite3 RunResult from an `INSERT INTO alerts ...` statement,
 * fetch the just-inserted row (enriched with equipment/zone names, matching the
 * `alert_acknowledged` payload shape used in routes/alerts.js) and broadcast it.
 *
 * Prefer `createAlert()` for new code — it de-duplicates. This function remains
 * for callers that still run their own INSERT.
 *
 * @param {{ lastInsertRowid?: number|bigint }} info - result of db.prepare(...).run(...)
 */
function broadcastNewAlert(info) {
  try {
    if (!global.broadcast || !info || info.lastInsertRowid == null) return;
    const alertRow = getEnriched(info.lastInsertRowid);
    if (alertRow) global.broadcast('new_alert', broadcastPayload(alertRow));
  } catch (err) {
    console.error('[alertBroadcast] Failed to broadcast new_alert:', err.message);
  }
}

/**
 * Create an alert with de-duplication, and broadcast it.
 *
 * Every alert has a `fingerprint` that identifies the underlying condition. If an
 * UNACKNOWLEDGED row with the same fingerprint already exists, that row is updated
 * in place (occurrence_count += 1, last_seen_at = now, message = latest message,
 * severity = latest severity) and an `alert_updated` WebSocket event is broadcast.
 * Otherwise a new row is inserted (occurrence_count = 1, last_seen_at = created_at)
 * and a `new_alert` event is broadcast. Acknowledging a row "closes" it, so the next
 * occurrence of the same condition creates a fresh row.
 *
 * The default fingerprint is sha1(`${source}|${automation_id}|${equipment_id}|${message}`),
 * so alerts with an identical message from the same source/equipment collapse. When the
 * message embeds something that changes between occurrences (a duration, a reading, a
 * timestamp) pass an explicit stable `fingerprint` — e.g. `equipment_offline:${id}` —
 * otherwise every occurrence will be a new row.
 *
 * @param {object} opts
 * @param {'info'|'warning'|'critical'} opts.severity   Required. Must satisfy the alerts.severity CHECK.
 * @param {string}  [opts.messageKey]                   Catalog key (src/i18n/<lang>/*.json). When given, the stored
 *                                                      English `message` is rendered from it and the key + params are
 *                                                      stored (message_key / message_params) so the API / Telegram can
 *                                                      render the alert in tr / ar. Preferred for new alerts.
 * @param {object}  [opts.messageParams]                `{param}` values; may nest i18n.M() descriptors, i18n.dur(ms), i18n.list([...]).
 * @param {string}  opts.message                        Required unless messageKey is given. English text (may change between occurrences).
 * @param {string}  [opts.type]                         Alias of `severity` (accepted for readability; `severity` wins).
 * @param {string}  [opts.title]                        Optional short title; prepended to message as "Title: message"
 *                                                      because the alerts table has no title column.
 * @param {number}  [opts.equipment_id]                 FK equipment.id (nullable).
 * @param {number}  [opts.zone_id]                      FK zones.id (nullable).
 * @param {number}  [opts.automation_id]                Related automation id (nullable, no FK).
 * @param {string}  [opts.source]                       Emitting subsystem, e.g. 'watchdog', 'scheduler', 'relay_safety',
 *                                                      'amic', 'agronomist', 'automation'. Part of the default fingerprint.
 * @param {string}  [opts.fingerprint]                  Explicit stable dedupe key (see above).
 * @param {object}  [opts.metadata]                     Ignored by storage today (reserved); passed through in the broadcast payload.
 * @returns {object|null} The enriched alert row (a.*, equipment_name, zone_name) plus
 *                        `deduplicated: boolean`. Returns null if the DB write failed
 *                        (the failure is logged, never thrown).
 *
 * @example
 *   const { createAlert } = require('../utils/alertBroadcast');
 *   createAlert({ severity: 'warning', source: 'watchdog', equipment_id: eq.id,
 *                 fingerprint: `equipment_offline:${eq.id}`,
 *                 message: `${eq.name} offline for ${mins} min` });
 */
function createAlert(opts = {}) {
  try {
    const severity = opts.severity || opts.type || 'info';
    if (!['info', 'warning', 'critical'].includes(severity)) {
      throw new Error(`invalid severity "${severity}"`);
    }
    const resolved = resolveMessage(opts);
    const message = resolved.message;
    if (!message) throw new Error('message is required');
    const messageKey = resolved.key;
    const messageParams = resolved.params ? JSON.stringify(resolved.params) : null;

    const equipment_id = opts.equipment_id ?? null;
    const zone_id = opts.zone_id ?? null;
    const automation_id = opts.automation_id ?? null;
    const source = opts.source ?? null;
    const fingerprint = opts.fingerprint
      || crypto.createHash('sha1')
          .update(`${source ?? ''}|${automation_id ?? ''}|${equipment_id ?? ''}|${message}`)
          .digest('hex');

    const existing = db.prepare(
      'SELECT id FROM alerts WHERE fingerprint = ? AND acknowledged = 0 ORDER BY id DESC LIMIT 1'
    ).get(fingerprint);

    let row;
    let deduplicated = false;
    if (existing) {
      db.prepare(`
        UPDATE alerts
        SET occurrence_count = COALESCE(occurrence_count, 1) + 1,
            last_seen_at = datetime('now'),
            message = ?,
            message_key = ?,
            message_params = ?,
            severity = ?
        WHERE id = ?
      `).run(message, messageKey, messageParams, severity, existing.id);
      row = getEnriched(existing.id);
      deduplicated = true;
      if (row) safeBroadcast('alert_updated', broadcastPayload(row, opts.metadata));
    } else {
      const info = db.prepare(`
        INSERT INTO alerts
          (equipment_id, zone_id, automation_id, severity, message, message_key, message_params, source, fingerprint,
           occurrence_count, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
      `).run(equipment_id, zone_id, automation_id, severity, message, messageKey, messageParams, source, fingerprint);
      row = getEnriched(info.lastInsertRowid);
      if (row) safeBroadcast('new_alert', broadcastPayload(row, opts.metadata));
    }
    return row ? { ...row, deduplicated } : null;
  } catch (err) {
    console.error('[alertBroadcast] createAlert failed:', err.message);
    return null;
  }
}

/**
 * Rewrite the OPEN (unacknowledged) alert with this fingerprint in place — new
 * message and/or severity, last_seen_at = now — WITHOUT counting a new
 * occurrence, and broadcast `alert_updated`. For a condition that has ended
 * ("recovered after 25 s") or a follow-up on the same event (the outcome of an
 * automatic action). The row stays open so the operator still sees it and
 * acknowledges it as usual. Returns the enriched row, or null when there is no
 * open row (e.g. already acknowledged) or the write failed (logged, never thrown).
 *
 * @param {string} fingerprint
 * @param {{message?: string, severity?: 'info'|'warning'|'critical', metadata?: object}} changes
 */
function updateOpenAlert(fingerprint, changes = {}) {
  try {
    if (!fingerprint) return null;
    const existing = db.prepare(
      'SELECT id, message, message_key, message_params, severity FROM alerts WHERE fingerprint = ? AND acknowledged = 0 ORDER BY id DESC LIMIT 1'
    ).get(fingerprint);
    if (!existing) return null;
    const severity = changes.severity || existing.severity;
    if (!['info', 'warning', 'critical'].includes(severity)) throw new Error(`invalid severity "${severity}"`);
    let message = existing.message;
    let messageKey = existing.message_key;
    let messageParams = existing.message_params;
    if (changes.messageKey || changes.message) {
      const r = resolveMessage(changes);
      message = r.message;
      messageKey = r.key;
      messageParams = r.params ? JSON.stringify(r.params) : null;
    }
    db.prepare("UPDATE alerts SET message = ?, message_key = ?, message_params = ?, severity = ?, last_seen_at = datetime('now') WHERE id = ?")
      .run(message, messageKey, messageParams, severity, existing.id);
    const row = getEnriched(existing.id);
    if (row) safeBroadcast('alert_updated', broadcastPayload(row, changes.metadata));
    return row || null;
  } catch (err) {
    console.error('[alertBroadcast] updateOpenAlert failed:', err.message);
    return null;
  }
}

module.exports = { broadcastNewAlert, createAlert, updateOpenAlert, localizeAlert, broadcastPayload, resolveMessage };
