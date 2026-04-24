/**
 * RelayTimerService - In-memory timer service for delayed relay actions.
 *
 * Manages setTimeout-based timers keyed by purpose:equipmentId:channel.
 * Setting a new timer on the same key cancels the previous one.
 */

class RelayTimerService {
  constructor() {
    this.timers = new Map(); // key: "purpose:equipmentId:channel" -> { timer, equipmentId, channel, firesAt }
  }

  /**
   * Schedule a delayed start for a relay channel.
   * If a timer already exists for the same key, it is cancelled first.
   *
   * @param {number} equipmentId
   * @param {number} channel - coil address
   * @param {number} delaySeconds
   * @param {Function} executeFn - async function called after the delay
   */
  scheduleDelayedStart(equipmentId, channel, delaySeconds, executeFn) {
    const key = `delay:${equipmentId}:${channel}`;
    const offKey = `off:${equipmentId}:${channel}`;

    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key).timer);
      console.log(`[RelayTimer] Cancelled existing delayed start for ${key}`);
    }

    // Also cancel any pending auto-off for this channel — a new delayed start
    // means the previous cycle's auto-off is stale and could conflict.
    if (this.timers.has(offKey)) {
      clearTimeout(this.timers.get(offKey).timer);
      this.timers.delete(offKey);
      console.log(`[RelayTimer] Cancelled stale auto-off for ${offKey} (new delayed start takes over)`);
    }

    const firesAt = new Date(Date.now() + delaySeconds * 1000);
    const timer = setTimeout(async () => {
      console.log(`[RelayTimer] Delayed start firing for equipment ${equipmentId} channel ${channel}`);
      this.timers.delete(key);
      try {
        await executeFn();
      } catch (err) {
        console.error(`[RelayTimer] Delayed start failed for ${key}:`, err.message);
      }
    }, delaySeconds * 1000);

    this.timers.set(key, { timer, equipmentId, channel, firesAt, type: 'delay' });
    console.log(`[RelayTimer] Scheduled delayed start for equipment ${equipmentId} ch ${channel} in ${delaySeconds}s`);
  }

  /**
   * Schedule an auto-off for a relay channel after durationSeconds.
   * If a timer already exists for the same key, it is cancelled first.
   *
   * @param {number} equipmentId
   * @param {number} channel - coil address
   * @param {number} durationSeconds
   * @param {Function} executeOffFn - async function called to turn the relay off
   */
  scheduleOff(equipmentId, channel, durationSeconds, executeOffFn) {
    const key = `off:${equipmentId}:${channel}`;

    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key).timer);
      console.log(`[RelayTimer] Cancelled existing auto-off for ${key}`);
    }

    const firesAt = new Date(Date.now() + durationSeconds * 1000);
    const timer = setTimeout(async () => {
      console.log(`[RelayTimer] Auto-off firing for equipment ${equipmentId} channel ${channel}`);
      this.timers.delete(key);
      try {
        await executeOffFn();
      } catch (err) {
        console.error(`[RelayTimer] Auto-off failed for ${key}:`, err.message);
      }
    }, durationSeconds * 1000);

    this.timers.set(key, { timer, equipmentId, channel, firesAt, type: 'off' });
    console.log(`[RelayTimer] Scheduled auto-off for equipment ${equipmentId} ch ${channel} in ${durationSeconds}s`);
  }

  /**
   * Schedule an arbitrary delayed callback under a custom key.
   * Used for transitions where multiple delayed actions share channels and
   * need unique keys to avoid cancelling each other.
   */
  scheduleDelayedRaw(key, delaySeconds, executeFn) {
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key).timer);
      console.log(`[RelayTimer] Cancelled existing raw timer for ${key}`);
    }

    const firesAt = new Date(Date.now() + delaySeconds * 1000);
    const timer = setTimeout(async () => {
      console.log(`[RelayTimer] Raw timer firing for ${key}`);
      this.timers.delete(key);
      try {
        await executeFn();
      } catch (err) {
        console.error(`[RelayTimer] Raw timer ${key} failed:`, err.message);
      }
    }, delaySeconds * 1000);

    this.timers.set(key, { timer, firesAt, type: 'raw', equipmentId: 0, channel: 0 });
    console.log(`[RelayTimer] Scheduled raw timer ${key} in ${delaySeconds}s`);
  }

  /**
   * Cancel all pending timers whose key starts with the given prefix.
   * Returns the number of timers cancelled.
   */
  cancelTimersByPrefix(prefix) {
    let count = 0;
    for (const [key, entry] of this.timers.entries()) {
      if (key.startsWith(prefix)) {
        clearTimeout(entry.timer);
        this.timers.delete(key);
        count++;
        console.log(`[RelayTimer] Cancelled ${key}`);
      }
    }
    return count;
  }

  /**
   * Returns a list of active pending timers (for debugging).
   */
  getActiveTimers() {
    const result = [];
    for (const [key, entry] of this.timers.entries()) {
      result.push({
        key,
        type: entry.type,
        equipmentId: entry.equipmentId,
        channel: entry.channel,
        firesAt: entry.firesAt.toISOString()
      });
    }
    return result;
  }

  /**
   * Clear all pending timers (call on process shutdown).
   */
  shutdown() {
    console.log(`[RelayTimer] Shutting down, clearing ${this.timers.size} timer(s)`);
    for (const [key, entry] of this.timers.entries()) {
      clearTimeout(entry.timer);
    }
    this.timers.clear();
  }
}

const relayTimerService = new RelayTimerService();

module.exports = { relayTimerService };
