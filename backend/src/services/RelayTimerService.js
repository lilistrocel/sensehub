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
   * @param {string|null} [options.actionKey] - per-action suffix (automation id +
   *        action index). Lets ONE automation hold several delayed starts on the
   *        same channel (soft-switch runs: one pump window per zone) without the
   *        later one cancelling the earlier; a re-trigger of the same automation
   *        still replaces its own timers. Without it the key is per channel.
   */
  scheduleDelayedStart(equipmentId, channel, delaySeconds, executeFn, options = {}) {
    const { automationId = null, checkEnabled = false, actionKey = null } = options;
    const key = actionKey ? `delay:${equipmentId}:${channel}:${actionKey}` : `delay:${equipmentId}:${channel}`;
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

    this.timers.set(key, { timer, equipmentId, channel, firesAt, type: 'delay', automationId, checkEnabled: !!checkEnabled });
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

    this.timers.set(key, { timer, equipmentId, channel, firesAt, type: 'off', automationId, checkEnabled: !!checkEnabled });
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

    this.timers.set(key, { timer, firesAt, type: 'raw', equipmentId: 0, channel: 0, automationId, checkEnabled: !!checkEnabled });
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
   * Cancel the pending timers that belong to one automation run (flow-watch run
   * shutdown, 2026-09-26). `filter(entry, key)` narrows the set (e.g. keep the
   * auto-offs of channels whose OFF could not be confirmed). Timers without an
   * owning automation are only matched by `extraKeyPrefixes` (e.g. 'delay:1:'),
   * so a manual timer on another board is never touched.
   *
   * @returns {Array<{key, type, equipmentId, channel, automationId, firesAt}>} what was cancelled
   */
  cancelTimersForAutomation(automationId, { filter = null, extraKeyPrefixes = [] } = {}) {
    const cancelled = [];
    for (const [key, entry] of [...this.timers.entries()]) {
      const owned = automationId != null && entry.automationId === automationId;
      const prefixed = extraKeyPrefixes.some(p => key.startsWith(p));
      if (!owned && !prefixed) continue;
      if (filter && !filter(entry, key)) continue;
      clearTimeout(entry.timer);
      this.timers.delete(key);
      cancelled.push({
        key, type: entry.type, equipmentId: entry.equipmentId, channel: entry.channel,
        automationId: entry.automationId ?? null, firesAt: entry.firesAt ? entry.firesAt.toISOString() : null,
      });
      console.log(`[RelayTimer] Cancelled ${key} (automation ${automationId} run stopped)`);
    }
    return cancelled;
  }

  /**
   * Pending timers that switch a coil on one of `equipmentIds`, whoever armed them
   * (Stop irrigation, 2026-09-27). Matched on the key, which always carries the
   * target board: delay:<eq>:<ch>[:<action>], off:<eq>:<ch>,
   * transition_delay:<eq>:<aid>:<i>, transition_off:<eq>:<aid>:<i>. Timers on any
   * other board are never matched, even when the same automation owns them.
   *
   * @param {number[]} equipmentIds
   * @param {object} [opts]
   * @param {'all'|'starts'|'offs'} [opts.kind] starts = delay + transition_delay;
   *        offs = off + transition_off (de-energising)
   * @param {number[]|null} [opts.channels] only per-channel timers (delay/off) on these channels
   * @param {boolean} [opts.includeRaw] include the per-board transition timers (no channel); default true
   * @returns {Array<[string, object, number, string]>} matching [key, entry, equipmentId, purpose]
   */
  _equipmentTimers(equipmentIds, { kind = 'all', channels = null, includeRaw = true } = {}) {
    const ids = new Set((equipmentIds || []).map(Number));
    const out = [];
    for (const [key, entry] of this.timers.entries()) {
      const m = /^(delay|off|transition_delay|transition_off):(\d+):/.exec(key);
      if (!m || !ids.has(Number(m[2]))) continue;
      const purpose = m[1];
      const isStart = purpose === 'delay' || purpose === 'transition_delay';
      if (kind === 'starts' && !isStart) continue;
      if (kind === 'offs' && isStart) continue;
      const raw = purpose.startsWith('transition_');
      if (raw && !includeRaw) continue;
      if (!raw && Array.isArray(channels) && !channels.includes(entry.channel)) continue;
      out.push([key, entry, Number(m[2]), purpose]);
    }
    return out;
  }

  _describe(key, entry, equipmentId, purpose) {
    const raw = purpose.startsWith('transition_');
    return {
      key,
      type: purpose === 'transition_delay' ? 'transition_delay' : purpose === 'transition_off' ? 'transition_off' : entry.type,
      equipmentId,
      channel: raw ? null : entry.channel,
      automationId: entry.automationId ?? null,
      firesAt: entry.firesAt ? entry.firesAt.toISOString() : null,
    };
  }

  /** Read-only view of the timers _equipmentTimers matches. */
  listTimersForEquipment(equipmentIds, opts = {}) {
    return this._equipmentTimers(equipmentIds, opts).map(([key, entry, eq, purpose]) => this._describe(key, entry, eq, purpose));
  }

  /** Cancel the matches of _equipmentTimers; returns what was cancelled. */
  cancelTimersForEquipment(equipmentIds, opts = {}) {
    const cancelled = [];
    for (const [key, entry, eq, purpose] of this._equipmentTimers(equipmentIds, opts)) {
      clearTimeout(entry.timer);
      this.timers.delete(key);
      cancelled.push(this._describe(key, entry, eq, purpose));
      console.log(`[RelayTimer] Cancelled ${key} (equipment ${eq} stopped)`);
    }
    return cancelled;
  }

  /** Cancel one timer by its exact key. Returns true when one was pending. */
  cancelTimer(key) {
    const e = this.timers.get(key);
    if (!e) return false;
    clearTimeout(e.timer);
    this.timers.delete(key);
    console.log(`[RelayTimer] Cancelled ${key}`);
    return true;
  }

  /** The pending auto-off for a channel ({ firesAt: Date, automationId }) or null. */
  getOffTimer(equipmentId, channel) {
    const e = this.timers.get(`off:${equipmentId}:${channel}`);
    return e ? { key: `off:${equipmentId}:${channel}`, firesAt: e.firesAt, automationId: e.automationId ?? null } : null;
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

module.exports = { relayTimerService, RelayTimerService };
