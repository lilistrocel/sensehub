const crypto = require('crypto');
const { db } = require('./database');

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
    if (alertRow) global.broadcast('new_alert', alertRow);
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
 * @param {string}  opts.message                        Required. Human-readable text (may change between occurrences).
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
    let message = String(opts.message ?? '').trim();
    if (opts.title) message = `${String(opts.title).trim()}: ${message}`;
    if (!message) throw new Error('message is required');

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
            severity = ?
        WHERE id = ?
      `).run(message, severity, existing.id);
      row = getEnriched(existing.id);
      deduplicated = true;
      if (row) safeBroadcast('alert_updated', { ...row, metadata: opts.metadata });
    } else {
      const info = db.prepare(`
        INSERT INTO alerts
          (equipment_id, zone_id, automation_id, severity, message, source, fingerprint,
           occurrence_count, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
      `).run(equipment_id, zone_id, automation_id, severity, message, source, fingerprint);
      row = getEnriched(info.lastInsertRowid);
      if (row) safeBroadcast('new_alert', { ...row, metadata: opts.metadata });
    }
    return row ? { ...row, deduplicated } : null;
  } catch (err) {
    console.error('[alertBroadcast] createAlert failed:', err.message);
    return null;
  }
}

module.exports = { broadcastNewAlert, createAlert };
