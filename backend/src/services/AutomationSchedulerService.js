/**
 * AutomationSchedulerService - Background service that checks for due automations
 * and executes them automatically.
 *
 * Checks every 30 seconds for:
 *  - Schedule triggers (daily, weekly, hourly, once, custom)
 *  - Threshold triggers (sensor value crossed threshold)
 *
 * Uses last_run to prevent double-firing within the same minute window.
 */

const { db } = require('../utils/database');
const { broadcastNewAlert } = require('../utils/alertBroadcast');
const { executeAutomation } = require('./AutomationExecutor');
const { evaluateSkip } = require('./SkipEvaluator');
const { automationArmingService } = require('./AutomationArmingService');

class AutomationSchedulerService {
  constructor() {
    this.checkIntervalMs = 30000; // Check every 30 seconds
    this.intervalId = null;
    this.startupTimeoutId = null;
    this.running = false;
    this._tickInProgress = false;
    // Edge-detection memory for threshold triggers. Map<automation_id, boolean>.
    // We fire on rising edge (false→true). undefined defaults to false on first read, so a
    // fresh restart with condition already true will fire ONCE to re-establish relay state.
    this._lastThresholdState = new Map();
  }

  start() {
    if (this.running) return;
    this.running = true;
    console.log(`[Scheduler] Automation scheduler started (checking every ${this.checkIntervalMs / 1000}s)`);

    // Run first check after a short delay (let other services initialize)
    this.startupTimeoutId = setTimeout(() => {
      this.startupTimeoutId = null;
      this._safeTick();
      this.intervalId = setInterval(() => this._safeTick(), this.checkIntervalMs);
    }, 5000);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.startupTimeoutId) {
      clearTimeout(this.startupTimeoutId);
      this.startupTimeoutId = null;
    }
    this.running = false;
    console.log('[Scheduler] Automation scheduler stopped');
  }

  // Guard against overlapping ticks (if a tick takes longer than the interval)
  _safeTick() {
    if (this._tickInProgress) {
      console.log('[Scheduler] Skipping tick — previous tick still in progress');
      return;
    }
    this._tickInProgress = true;
    this._tick()
      .catch(err => console.error('[Scheduler] Unhandled tick error:', err.message))
      .finally(() => { this._tickInProgress = false; });
  }

  async _tick() {
    try {
      // Emergency stop gate. While disarmed nothing fires, however met the
      // conditions are, until an operator re-arms (or autoReArmAt elapses).
      const arming = automationArmingService.getState();
      if (arming.disarmed) {
        // Drop threshold edge memory so that on re-arm a still-met condition
        // counts as a rising edge and re-establishes relay state — the same
        // semantics as a fresh backend restart. Without this, a fan whose
        // "temp > 30" was true throughout the stop would stay off for hours.
        if (this._lastThresholdState.size) this._lastThresholdState.clear();
        automationArmingService.noteSkip(
          'scheduler',
          `[Scheduler] Automations DISARMED — skipping ticks until re-armed${automationArmingService.describe(arming)}`
        );
        return;
      }

      const automations = db.prepare(
        'SELECT * FROM automations WHERE enabled = 1'
      ).all();

      for (const automation of automations) {
        let triggerConfig;
        try {
          triggerConfig = typeof automation.trigger_config === 'string'
            ? JSON.parse(automation.trigger_config)
            : automation.trigger_config || {};
        } catch (e) {
          continue;
        }

        const triggerType = triggerConfig.type;

        if (triggerType === 'schedule') {
          if (this._isScheduleDue(triggerConfig, automation.last_run)) {
            await this._fireWithSkipCheck(automation, triggerConfig, 'schedule');
          }
        } else if (triggerType === 'threshold') {
          const currentlyMet = this._isThresholdMet(triggerConfig, automation.last_run);
          const previouslyMet = this._lastThresholdState.get(automation.id) ?? false;
          // Persist current state for next tick
          this._lastThresholdState.set(automation.id, currentlyMet);
          // Fire ONLY on the rising edge (false → true). This stops the per-poll re-fire
          // bug that was generating 90+ runs/day for steady conditions like "temp > 30°C".
          // When the condition falls (true → false), the companion OFF-rule (e.g. #36 at <26°C)
          // is responsible for the OFF action.
          if (currentlyMet && !previouslyMet) {
            await this._fireWithSkipCheck(automation, triggerConfig, 'threshold');
          }
        } else {
          // Trigger type changed away from threshold — clear any stale edge state for this id
          this._lastThresholdState.delete(automation.id);
        }
        // 'manual' and 'event' triggers are not handled by the scheduler
      }
    } catch (err) {
      console.error('[Scheduler] Error in automation check loop:', err.message);
    }
  }

  /**
   * Fire an automation with a pre-execution skip check.
   * If SkipEvaluator returns skip=true, log status='skipped' and do not run the actions.
   * Otherwise execute normally and reset the consecutive_skips counter.
   *
   * @param {object} automation - the live automation row
   * @param {object} triggerConfig - parsed trigger
   * @param {string} kind - 'schedule' | 'threshold' (for log context)
   */
  async _fireWithSkipCheck(automation, triggerConfig, kind) {
    // Pre-execution skip evaluation
    let evalResult;
    try {
      evalResult = evaluateSkip(automation);
    } catch (err) {
      console.error(`[Scheduler] SkipEvaluator threw on "${automation.name}":`, err.message);
      evalResult = { skip: false };
    }

    if (evalResult.stale_sensor && !evalResult.skip) {
      // Sensor too old to trust — log a note but proceed normally
      console.log(`[Scheduler] "${automation.name}" sensor stale, skip eval bypassed: ${evalResult.reason}`);
    }

    if (evalResult.skip) {
      const reason = evalResult.reason || 'Skipped by pre-execution gate';
      const src = evalResult.source || 'unknown';
      console.log(`[Scheduler] SKIPPING "${automation.name}" (id=${automation.id}, source=${src}): ${reason}`);
      // Bump consecutive_skips, persist last_run so we don't re-fire within the same tick window
      db.prepare(`
        UPDATE automations
        SET consecutive_skips = COALESCE(consecutive_skips, 0) + 1,
            last_run = datetime('now'),
            updated_at = datetime('now')
        WHERE id = ?
      `).run(automation.id);
      db.prepare(
        "INSERT INTO automation_logs (automation_id, status, message, triggered_at, completed_at) VALUES (?, 'skipped', ?, datetime('now'), datetime('now'))"
      ).run(automation.id, `[${src}] ${reason}`);

      // Consecutive-skip alert at threshold
      const updated = db.prepare('SELECT consecutive_skips FROM automations WHERE id = ?').get(automation.id);
      const n = updated?.consecutive_skips || 0;
      if (n === 3 || n === 6 || n === 12) {
        try {
          broadcastNewAlert(db.prepare(
            "INSERT INTO alerts (severity, message, created_at) VALUES (?, ?, datetime('now'))"
          ).run(
            n >= 12 ? 'critical' : 'warning',
            `Automation "${automation.name}" (id=${automation.id}) has skipped ${n} consecutive times. Verify the sensor reading driving the skip is correct.`,
          ));
        } catch (err) {
          console.error('[Scheduler] Failed to write consecutive-skip alert:', err.message);
        }
      }
      return;
    }

    // Normal execution path
    console.log(`[Scheduler] Firing ${kind} automation: "${automation.name}" (id=${automation.id})`);
    try {
      const result = await executeAutomation(automation, 'scheduler');
      console.log(`[Scheduler] Automation "${automation.name}" executed: ${result.executedActions.length} action(s)`);
      // Reset skip streak on successful run
      db.prepare("UPDATE automations SET consecutive_skips = 0 WHERE id = ?").run(automation.id);
      // For one-time schedules, disable after firing
      if (kind === 'schedule' && triggerConfig.schedule_type === 'once') {
        db.prepare("UPDATE automations SET enabled = 0, updated_at = datetime('now') WHERE id = ?")
          .run(automation.id);
        console.log(`[Scheduler] One-time automation "${automation.name}" disabled after execution`);
      }
    } catch (err) {
      console.error(`[Scheduler] Error executing automation "${automation.name}":`, err.message);
      db.prepare(
        "INSERT INTO automation_logs (automation_id, status, message, triggered_at, completed_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))"
      ).run(automation.id, 'failure', `Scheduler error: ${err.message}`);
    }
  }

  /**
   * Parse a SQLite datetime string as UTC.
   * SQLite's datetime('now') returns UTC without a timezone indicator (e.g., "2026-02-15 14:30:00").
   * new Date() would parse this as local time, breaking cooldown math on non-UTC systems.
   */
  _parseUtcTimestamp(sqliteDateStr) {
    if (!sqliteDateStr) return null;
    // Append 'Z' to force UTC interpretation if not already ISO format
    const str = sqliteDateStr.endsWith('Z') || sqliteDateStr.includes('+') ? sqliteDateStr : sqliteDateStr.replace(' ', 'T') + 'Z';
    return new Date(str);
  }

  /**
   * Check if a schedule trigger is due to fire right now.
   */
  _isScheduleDue(triggerConfig, lastRun) {
    const now = new Date();

    // Prevent double-firing: if last_run is within the last 55 seconds, skip
    if (lastRun) {
      const lastRunTime = this._parseUtcTimestamp(lastRun);
      if (lastRunTime && (now - lastRunTime) < 55000) return false;
    }

    const scheduleType = triggerConfig.schedule_type;

    if (scheduleType === 'once') {
      if (!triggerConfig.run_at) return false;
      const runAt = new Date(triggerConfig.run_at);
      // Fire if current time is at or past run_at AND we haven't run since run_at
      if (now >= runAt) {
        if (!lastRun) return true;
        const lastRunTime = this._parseUtcTimestamp(lastRun);
        if (lastRunTime && lastRunTime < runAt) return true;
      }
      return false;
    }

    if (scheduleType === 'daily') {
      const [hours, minutes] = (triggerConfig.time || '08:00').split(':').map(Number);
      return now.getHours() === hours && now.getMinutes() === minutes;
    }

    if (scheduleType === 'weekly') {
      const dayOfWeek = parseInt(triggerConfig.day_of_week || '1', 10);
      const [hours, minutes] = (triggerConfig.time || '08:00').split(':').map(Number);
      return now.getDay() === dayOfWeek && now.getHours() === hours && now.getMinutes() === minutes;
    }

    if (scheduleType === 'hourly') {
      const minute = parseInt(triggerConfig.minute || '0', 10);
      return now.getMinutes() === minute;
    }

    if (scheduleType === 'custom') {
      // Basic cron parsing: "minute hour day month weekday"
      if (!triggerConfig.cron) return false;
      return this._matchesCron(triggerConfig.cron, now);
    }

    return false;
  }

  /**
   * Check if a threshold trigger's condition is currently met.
   * Reads the equipment's last_reading from the database.
   *
   * NOTE: This is a PURE state check — returns true whenever the sensor value crosses
   * the threshold, without any cooldown. The caller (the threshold path in _tick) is
   * responsible for edge-detection via _lastThresholdState. A cooldown here would
   * inject phantom false→true transitions and reintroduce the per-poll spam bug.
   */
  _isThresholdMet(triggerConfig, _lastRun /* intentionally unused */) {
    if (!triggerConfig.equipment_id) return false;

    const equipment = db.prepare('SELECT * FROM equipment WHERE id = ?').get(triggerConfig.equipment_id);
    if (!equipment || !equipment.last_reading) return false;

    let reading;
    try {
      reading = typeof equipment.last_reading === 'string'
        ? JSON.parse(equipment.last_reading)
        : equipment.last_reading;
    } catch (e) {
      return false;
    }

    // Find the current value for the sensor type
    const sensorType = triggerConfig.sensor_type || 'temperature';
    let currentValue = null;

    // Helper: extract numeric value — handles both raw numbers and {value, unit} objects
    const extractNumber = (v) => {
      if (v != null && typeof v === 'object' && v.value !== undefined) return parseFloat(v.value);
      return parseFloat(v);
    };

    // Check direct sensor value keys
    if (reading[sensorType] !== undefined) {
      currentValue = extractNumber(reading[sensorType]);
    }
    // Check in registers object
    if (currentValue === null && reading.registers) {
      for (const [key, val] of Object.entries(reading.registers)) {
        if (key.toLowerCase().includes(sensorType.toLowerCase())) {
          currentValue = extractNumber(val);
          break;
        }
      }
    }
    // Check in values object (ModbusPollingService stores {value, unit} objects here)
    if (currentValue === null && reading.values) {
      for (const [key, val] of Object.entries(reading.values)) {
        if (key.toLowerCase().includes(sensorType.toLowerCase())) {
          currentValue = extractNumber(val);
          break;
        }
      }
    }

    if (currentValue === null || isNaN(currentValue)) {
      console.log(`[Scheduler] Threshold check: could not resolve sensor_type="${sensorType}" for equipment ${triggerConfig.equipment_id}`);
      return false;
    }

    const threshold = parseFloat(triggerConfig.threshold_value);
    if (isNaN(threshold)) return false;

    const operator = triggerConfig.operator || 'gt';

    const result = (() => {
      switch (operator) {
        case 'gt':  return currentValue > threshold;
        case 'gte': return currentValue >= threshold;
        case 'lt':  return currentValue < threshold;
        case 'lte': return currentValue <= threshold;
        case 'eq':  return currentValue === threshold;
        case 'neq': return currentValue !== threshold;
        default:    return false;
      }
    })();

    // Don't log here — this is called every tick and would spam the logs.
    // The caller logs only when it actually fires (rising edge).
    return result;
  }

  /**
   * Basic cron expression matching: "minute hour day month weekday"
   * Supports: numbers, * (any), and comma-separated lists.
   */
  _matchesCron(cronExpr, now) {
    const parts = cronExpr.trim().split(/\s+/);
    if (parts.length < 5) return false;

    const fields = [
      { value: now.getMinutes(), field: parts[0] },
      { value: now.getHours(), field: parts[1] },
      { value: now.getDate(), field: parts[2] },
      { value: now.getMonth() + 1, field: parts[3] },
      { value: now.getDay(), field: parts[4] }
    ];

    for (const { value, field } of fields) {
      if (field === '*') continue;
      const allowed = field.split(',').map(Number);
      if (!allowed.includes(value)) return false;
    }

    return true;
  }
}

const automationSchedulerService = new AutomationSchedulerService();

module.exports = { automationSchedulerService };
