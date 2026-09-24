/**
 * RelayStateCache - per-channel bookkeeping after a coil write.
 *
 * Updates the cached relayStates in equipment.last_reading, marks the
 * equipment online, logs a relay_events row and broadcasts
 * `relay_state_changed` for each channel. Shared by the automation executor
 * and the manual / raw relay routes so every write site records the same
 * read-back result the same way.
 */

const { db } = require('../utils/database');
const { logRelayEvent } = require('./RelayEventLogger');

/**
 * @param {object} equipment - equipment row (id, last_reading)
 * @param {Array<{channel:number, state?:boolean, requested?:boolean, readback?:boolean|null, confirmed?:boolean|null}>} channelStates
 *        `state` is the legacy "requested" field. When `readback` is a boolean it
 *        is what goes into the cache (the hardware's answer, not the request).
 * @param {object} opts
 * @param {string} opts.source - relay_events / broadcast source label
 * @param {number|null} [opts.automationId]
 * @param {string|null} [opts.userEmail] - operator who triggered the write (null for schedulers)
 */
function applyRelayCache(equipment, channelStates, { source, automationId = null, userEmail = null }) {
  // Re-read last_reading so we merge onto the freshest polled snapshot rather
  // than a row that may have been fetched seconds (or a delay timer) ago.
  let lastReading = {};
  try {
    const fresh = db.prepare('SELECT last_reading FROM equipment WHERE id = ?').get(equipment.id);
    const raw = fresh ? fresh.last_reading : equipment.last_reading;
    if (raw) lastReading = JSON.parse(raw);
  } catch (e) {
    try { if (equipment.last_reading) lastReading = JSON.parse(equipment.last_reading); } catch (e2) {}
  }
  if (!lastReading || typeof lastReading !== 'object') lastReading = {};
  if (!lastReading.relayStates) lastReading.relayStates = {};

  const items = channelStates.map(item => {
    const requested = item.requested !== undefined ? item.requested === true : item.state === true;
    const readback = typeof item.readback === 'boolean' ? item.readback : null;
    const confirmed = item.confirmed === undefined || item.confirmed === null ? null : !!item.confirmed;
    // Cache the READ-BACK value when we have one; the request only when we don't.
    const cacheState = readback === null ? requested : readback;
    return { channel: item.channel, requested, readback, confirmed, cacheState };
  });

  for (const it of items) lastReading.relayStates[it.channel] = it.cacheState;

  db.prepare(
    "UPDATE equipment SET last_reading = ?, last_communication = datetime('now'), status = 'online', updated_at = datetime('now') WHERE id = ?"
  ).run(JSON.stringify(lastReading), equipment.id);

  for (const it of items) {
    // The broadcast payload shape ({equipmentId, channel, state, source,
    // automationId}) is relied on by the frontend — keep it stable; `confirmed`
    // and `requested` are additive.
    if (global.broadcast) {
      global.broadcast('relay_state_changed', {
        equipmentId: equipment.id,
        channel: it.channel,
        state: it.cacheState,
        requested: it.requested,
        confirmed: it.confirmed === true,
        source,
        automationId
      });
    }
    logRelayEvent(equipment.id, it.channel, it.requested, source, automationId, {
      confirmed: it.confirmed,
      readbackState: it.readback,
      userEmail
    });
  }
  return items;
}

module.exports = { applyRelayCache };
