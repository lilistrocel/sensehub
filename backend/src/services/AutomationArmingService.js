/**
 * AutomationArmingService - The "are automations allowed to fire?" flag behind
 * the operator's Emergency Stop.
 *
 * Plain Stop-All (POST /api/automations/stop-all) is a one-shot: it kills what
 * is running now, but the schedulers are free to re-fire the very next tick. An
 * Emergency Stop additionally DISARMS every automatic actuation path until an
 * operator re-arms it.
 *
 * State lives in system_settings under the key `automations_disarmed`, JSON:
 *   { disarmed: true, at: <ISO>, by: <email|null>, reason: <string|null>,
 *     autoReArmAt: <ISO|null> }
 *
 * The row is absent when armed. Persisting it deliberately means a backend
 * restart does NOT silently re-arm: a system that was emergency-stopped comes
 * back up still stopped. Failing safe here means staying stopped.
 *
 * `autoReArmAt` is evaluated lazily on read — once it is in the past the row is
 * deleted and the system reports itself armed again. There is no timer, so a
 * restart across the expiry window still behaves correctly.
 *
 * Only requires utils/database, so it can be pulled into any service (including
 * RelayTimerService, which AutomationExecutor requires) without a require cycle.
 */

const { db } = require('../utils/database');

const SETTINGS_KEY = 'automations_disarmed';

// Armed = no row. Frozen template; always spread before returning.
const ARMED_STATE = Object.freeze({
  disarmed: false,
  at: null,
  by: null,
  reason: null,
  autoReArmAt: null,
});

// A disarmed system is polled by several tickers (automation scheduler every
// 30s, watchdog every 2min, AMIC scheduler every 60s). Log the transition, then
// at most one reminder per scope per window, or the log file balloons.
const SKIP_LOG_THROTTLE_MS = 10 * 60 * 1000; // 10 minutes

class AutomationArmingService {
  constructor() {
    // scope -> epoch ms of the last "skipped because disarmed" log for that scope
    this._skipLog = new Map();
  }

  /**
   * Current arming state.
   *
   * Treats an elapsed `autoReArmAt` as re-armed and clears the row when it
   * notices. Fails CLOSED (reports disarmed) if the row exists but cannot be
   * read or parsed — a stop we cannot verify has ended is still a stop.
   *
   * @returns {{disarmed: boolean, at: string|null, by: string|null, reason: string|null, autoReArmAt: string|null}}
   */
  getState() {
    let row;
    try {
      row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(SETTINGS_KEY);
    } catch (err) {
      console.error(`[Automation] Arming-state read FAILED, assuming DISARMED (fail-safe): ${err.message}`);
      return { ...ARMED_STATE, disarmed: true, reason: `arming-state read failed: ${err.message}` };
    }

    if (!row || !row.value) return this._armed();

    let stored;
    try {
      stored = JSON.parse(row.value);
    } catch (err) {
      console.error(`[Automation] Arming-state row is unparseable, assuming DISARMED (fail-safe): ${err.message}`);
      return { ...ARMED_STATE, disarmed: true, reason: 'arming-state row is corrupt' };
    }

    if (!stored || stored.disarmed !== true) return this._armed();

    // Lazy auto re-arm. An unparseable autoReArmAt is treated as "no expiry"
    // rather than "expired" — never re-arm on a value we don't understand.
    if (stored.autoReArmAt) {
      const expiresAt = Date.parse(stored.autoReArmAt);
      if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
        console.log(`[Automation] Auto re-arm window elapsed (${stored.autoReArmAt}) — automations re-armed`);
        this._clearRow();
        return this._armed();
      }
    }

    return {
      disarmed: true,
      at: stored.at || null,
      by: stored.by || null,
      reason: stored.reason || null,
      autoReArmAt: stored.autoReArmAt || null,
    };
  }

  /** Convenience predicate for the gates. */
  isDisarmed() {
    return this.getState().disarmed === true;
  }

  /**
   * Disarm every automatic actuation path until re-armed.
   *
   * @param {object} [options]
   * @param {string|null} [options.by] - requesting user's email
   * @param {string|null} [options.reason]
   * @param {number} [options.autoReArmMinutes] - >0 sets autoReArmAt; 0/absent
   *        means "until an operator re-arms".
   * @returns {object} the resulting arming state
   */
  disarm(options = {}) {
    const { by = null, reason = null, autoReArmMinutes = 0 } = options || {};

    const now = new Date();
    let autoReArmAt = null;
    const minutes = Number(autoReArmMinutes);
    if (Number.isFinite(minutes) && minutes > 0) {
      autoReArmAt = new Date(now.getTime() + minutes * 60000).toISOString();
    }

    const state = {
      disarmed: true,
      at: now.toISOString(),
      by: by || null,
      reason: reason || null,
      autoReArmAt,
    };

    const valueStr = JSON.stringify(state);
    db.prepare(`
      INSERT INTO system_settings (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
    `).run(SETTINGS_KEY, valueStr, valueStr);

    // A fresh disarm should log its transition immediately, not inherit the
    // throttle window of a previous one.
    this._skipLog.clear();

    console.log(
      `[Automation] Automations DISARMED by ${state.by || 'unknown'}` +
      (state.reason ? ` (${state.reason})` : '') +
      (autoReArmAt ? ` — auto re-arm at ${autoReArmAt}` : ' — until manually re-armed')
    );

    return state;
  }

  /**
   * Re-arm: clear the flag so schedulers resume.
   * @param {object} [options]
   * @param {string|null} [options.by] - requesting user's email (logged only)
   * @returns {object} the resulting (armed) state
   */
  reArm(options = {}) {
    const { by = null } = options || {};
    this._clearRow();
    this._skipLog.clear();
    console.log(`[Automation] Automations RE-ARMED by ${by || 'unknown'}`);
    return { ...ARMED_STATE };
  }

  /**
   * Throttled "skipped because disarmed" logging.
   * Logs on the first skip for a scope after any arm/disarm transition, then at
   * most once per SKIP_LOG_THROTTLE_MS for that scope.
   *
   * @param {string} scope - e.g. 'scheduler', 'watchdog_rearm'
   * @param {string} message - the full line to log (already prefixed)
   */
  noteSkip(scope, message) {
    const now = Date.now();
    const last = this._skipLog.get(scope);
    if (last != null && (now - last) < SKIP_LOG_THROTTLE_MS) return;
    this._skipLog.set(scope, now);
    console.log(message);
  }

  /** Human-readable "(disarmed at X by Y)" suffix for log lines. */
  describe(state) {
    const s = state || this.getState();
    const bits = [];
    if (s.at) bits.push(`at ${s.at}`);
    if (s.by) bits.push(`by ${s.by}`);
    if (s.reason) bits.push(`reason: ${s.reason}`);
    if (s.autoReArmAt) bits.push(`auto re-arm ${s.autoReArmAt}`);
    return bits.length ? ` (${bits.join(', ')})` : '';
  }

  _armed() {
    // Any armed observation ends the throttle window, so the next disarm logs
    // its transition straight away.
    if (this._skipLog.size) this._skipLog.clear();
    return { ...ARMED_STATE };
  }

  _clearRow() {
    try {
      db.prepare('DELETE FROM system_settings WHERE key = ?').run(SETTINGS_KEY);
    } catch (err) {
      console.error(`[Automation] Failed to clear arming-state row: ${err.message}`);
    }
  }
}

const automationArmingService = new AutomationArmingService();

module.exports = { automationArmingService, AutomationArmingService, AUTOMATION_DISARM_KEY: SETTINGS_KEY };
