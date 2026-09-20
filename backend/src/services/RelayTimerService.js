/**
 * RelayTimerService - In-memory timer service for delayed relay actions.
 *
 * Manages setTimeout-based timers keyed by purpose:equipmentId:channel.
 * Setting a new timer on the same key cancels the previous one.
 */

const { db } = require('../utils/database');
const { automationArmingService } = require('./AutomationArmingService');

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
   * @param {object} [options]
   * @param {number|null} [options.automationId] - owning automation, if any
   * @param {boolean} [options.checkEnabled] - re-check the owning automation is
   *        still enabled at fire time (see _mayFire)
   */
  scheduleDelayedStart(equipmentId, channel, delaySeconds, executeFn, options = {}) {
    const { automationId = null, checkEnabled = false } = options;
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
      if (!this._mayFire(key, automationId, checkEnabled)) return;
      try {
        await executeFn();
      } catch (err) {
        console.error(`[RelayTimer] Delayed start failed for ${key}:`, err.message);
      }
    }, delaySeconds * 1000);

    this.timers.set(key, { timer, equipmentId, channel, firesAt, type: 'delay', automationId });
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
   * @param {object} [options]
   * @param {number|null} [options.automationId] - owning automation, if any
   * @param {boolean} [options.checkEnabled] - re-check the owning automation is
   *        still enabled at fire time. Leave false for de-energising timers.
   */
  scheduleOff(equipmentId, channel, durationSeconds, executeOffFn, options = {}) {
    const { automationId = null, checkEnabled = false } = options;
    const key = `off:${equipmentId}:${channel}`;

    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key).timer);
      console.log(`[RelayTimer] Cancelled existing auto-off for ${key}`);
    }

    const firesAt = new Date(Date.now() + durationSeconds * 1000);
    const timer = setTimeout(async () => {
      console.log(`[RelayTimer] Auto-off firing for equipment ${equipmentId} channel ${channel}`);
      this.timers.delete(key);
      if (!this._mayFire(key, automationId, checkEnabled)) return;
      try {
        await executeOffFn();
      } catch (err) {
        console.error(`[RelayTimer] Auto-off failed for ${key}:`, err.message);
      }
    }, durationSeconds * 1000);

    this.timers.set(key, { timer, equipmentId, channel, firesAt, type: 'off', automationId });
    console.log(`[RelayTimer] Scheduled auto-off for equipment ${equipmentId} ch ${channel} in ${durationSeconds}s`);
  }

  /**
   * Schedule an arbitrary delayed callback under a custom key.
   * Used for transitions where multiple delayed actions share channels and
   * need unique keys to avoid cancelling each other.
   *
   * @param {object} [options]
   * @param {number|null} [options.automationId] - owning automation, if any
   * @param {boolean} [options.checkEnabled] - re-check the owning automation is
   *        still enabled at fire time (see _mayFire)
   */
  scheduleDelayedRaw(key, delaySeconds, executeFn, options = {}) {
    const { automationId = null, checkEnabled = false } = options;
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key).timer);
      console.log(`[RelayTimer] Cancelled existing raw timer for ${key}`);
    }

    const firesAt = new Date(Date.now() + delaySeconds * 1000);
    const timer = setTimeout(async () => {
      console.log(`[RelayTimer] Raw timer firing for ${key}`);
      this.timers.delete(key);
      if (!this._mayFire(key, automationId, checkEnabled)) return;
      try {
        await executeFn();
      } catch (err) {
        console.error(`[RelayTimer] Raw timer ${key} failed:`, err.message);
      }
    }, delaySeconds * 1000);

    this.timers.set(key, { timer, firesAt, type: 'raw', equipmentId: 0, channel: 0, automationId });
    console.log(`[RelayTimer] Scheduled raw timer ${key} in ${delaySeconds}s`);
  }

  /**
   * Fire-time safety gate.
   *
   * A timer armed on behalf of an automation must not fire if that automation
   * has since been disabled or deleted — the `enabled = 1` filter in the
   * scheduler only applies when an automation is picked up, never to callbacks
   * that are already queued.
   *
   * IMPORTANT: callers only opt in (checkEnabled: true) for timers that can
   * ENERGISE a coil. De-energising timers (auto-off, auto-revert) are never
   * gated — disabling an automation mid-cycle must never strand a pump ON.
   *
   * On a DB error the gate fails CLOSED (the energising action is skipped).
   *
   * The same checkEnabled opt-in also gates on the emergency-stop disarm flag:
   * a timer armed before the stop (or by any path we failed to gate) must not
   * energise a coil afterwards. De-energising timers are never blocked, so a
   * disarm can't strand a pump ON.
   *
   * @returns {boolean} true when the callback may proceed
   */
  _mayFire(key, automationId, checkEnabled) {
    if (checkEnabled) {
      const arming = automationArmingService.getState();
      if (arming.disarmed) {
        console.log(`[RelayTimer] Skipping ${key} — automations are DISARMED (emergency stop)${automationArmingService.describe(arming)}`);
        return false;
      }
    }

    if (!checkEnabled || automationId == null) return true;

    let row;
    try {
      row = db.prepare('SELECT enabled FROM automations WHERE id = ?').get(automationId);
    } catch (err) {
      console.error(`[RelayTimer] Skipping ${key} — enabled re-check failed for automation ${automationId}:`, err.message);
      return false;
    }

    if (!row) {
      console.log(`[RelayTimer] Skipping ${key} — automation ${automationId} no longer exists`);
      return false;
    }
    if (!row.enabled) {
      console.log(`[RelayTimer] Skipping ${key} — automation ${automationId} was disabled after this timer was armed`);
      return false;
    }
    return true;
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
   * Cancel EVERY pending timer, whatever its purpose (emergency stop).
   * Returns the number of timers cancelled; safe to call on an empty Map.
   */
  cancelAllTimers() {
    const count = this.timers.size;
    for (const [key, entry] of this.timers.entries()) {
      clearTimeout(entry.timer);
      console.log(`[RelayTimer] Cancelled ${key} (stop-all)`);
    }
    this.timers.clear();
    console.log(`[RelayTimer] Stop-all cancelled ${count} pending timer(s)`);
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
        automationId: entry.automationId ?? null,
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
