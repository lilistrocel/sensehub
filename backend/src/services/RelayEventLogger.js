/**
 * RelayEventLogger - Logs every relay on/off transition to the relay_events table.
 *
 * Columns: state = requested state; readback_state = what FC01 read back after
 * the write (NULL when unavailable, e.g. write-only boards); confirmed =
 * 1 when readback === requested, 0 when it disagreed / could not be read,
 * NULL for legacy rows; user_email = operator behind a manual write (NULL for
 * schedulers).
 */

const { db } = require('../utils/database');

let insertStmt = null;
function getInsert() {
  if (!insertStmt) {
    insertStmt = db.prepare(`
      INSERT INTO relay_events (equipment_id, channel, state, source, automation_id, confirmed, readback_state, user_email, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);
  }
  return insertStmt;
}

const toIntOrNull = (v) => (v === null || v === undefined ? null : (v ? 1 : 0));

/**
 * Log a relay state change event.
 *
 * @param {number} equipmentId
 * @param {number} channel - coil address
 * @param {boolean|number} state - requested state: true/1 = ON, false/0 = OFF
 * @param {string} source - 'manual' | 'automation' | 'automation_auto_off' | 'all_channels' | ...
 * @param {number|null} automationId
 * @param {object} [extra]
 * @param {boolean|null} [extra.confirmed]     - read-back agreed with the request
 * @param {boolean|null} [extra.readbackState] - value read back (null when not read)
 * @param {string|null}  [extra.userEmail]     - operator email for route-triggered writes
 */
function logRelayEvent(equipmentId, channel, state, source, automationId = null, extra = {}) {
  try {
    const stateInt = state ? 1 : 0;
    const confirmed = toIntOrNull(extra.confirmed);
    const readbackState = toIntOrNull(extra.readbackState);
    const userEmail = extra.userEmail || null;
    getInsert().run(equipmentId, channel, stateInt, source, automationId, confirmed, readbackState, userEmail);

    if (global.broadcast) {
      global.broadcast('relay_event', {
        equipmentId,
        channel,
        state: stateInt,
        source,
        automationId,
        confirmed,
        readbackState,
        userEmail,
        timestamp: new Date().toISOString()
      });
    }
  } catch (err) {
    console.error('[RelayEventLogger] Failed to log event:', err.message);
  }
}

module.exports = { logRelayEvent };
