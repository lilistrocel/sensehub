const { db } = require('./database');

/**
 * Broadcast a newly-created alert over WebSocket as a `new_alert` event.
 *
 * Given the better-sqlite3 RunResult from an `INSERT INTO alerts ...` statement,
 * fetch the just-inserted row (enriched with equipment/zone names, matching the
 * `alert_acknowledged` payload shape used in routes/alerts.js) and broadcast it.
 *
 * Safe to call from services that may run before/around WebSocket setup:
 * guarded by `global.broadcast` existence and wrapped in try/catch so a
 * broadcast failure never breaks alert creation.
 *
 * @param {{ lastInsertRowid?: number|bigint }} info - result of db.prepare(...).run(...)
 */
function broadcastNewAlert(info) {
  try {
    if (!global.broadcast || !info || info.lastInsertRowid == null) return;
    const id = Number(info.lastInsertRowid);
    const alertRow = db.prepare(`
      SELECT a.*, e.name as equipment_name, z.name as zone_name
      FROM alerts a
      LEFT JOIN equipment e ON a.equipment_id = e.id
      LEFT JOIN zones z ON a.zone_id = z.id
      WHERE a.id = ?
    `).get(id);
    if (alertRow) {
      global.broadcast('new_alert', alertRow);
    }
  } catch (err) {
    // Never let a broadcast failure break alert creation.
    console.error('[alertBroadcast] Failed to broadcast new_alert:', err.message);
  }
}

module.exports = { broadcastNewAlert };
