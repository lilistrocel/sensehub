/**
 * RelayEventLogger - Logs every relay on/off transition to the relay_events table.
 */

const { db } = require('../utils/database');

const insertStmt = db.prepare(`
  INSERT INTO relay_events (equipment_id, channel, state, source, automation_id, created_at)
  VALUES (?, ?, ?, ?, ?, datetime('now'))
`);

/**
 * Log a relay state change event.
 *
 * @param {number} equipmentId
 * @param {number} channel - coil address
 * @param {boolean|number} state - true/1 = ON, false/0 = OFF
 * @param {string} source - 'manual' | 'automation' | 'automation_auto_off' | 'all_channels'
 * @param {number|null} automationId
 */
function logRelayEvent(equipmentId, channel, state, source, automationId = null) {
  try {
    const stateInt = state ? 1 : 0;
    insertStmt.run(equipmentId, channel, stateInt, source, automationId);

    global.broadcast('relay_event', {
      equipmentId,
      channel,
      state: stateInt,
      source,
      automationId,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('[RelayEventLogger] Failed to log event:', err.message);
  }
}

module.exports = { logRelayEvent };
