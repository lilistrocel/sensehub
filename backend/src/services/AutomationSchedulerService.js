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
const { executeAutomation } = require('./AutomationExecutor');

class AutomationSchedulerService {
  constructor() {
    this.checkIntervalMs = 30000; // Check every 30 seconds
    this.intervalId = null;
    this.startupTimeoutId = null;
    this.running = false;
    this._tickInProgress = false;
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
            console.log(`[Scheduler] Firing scheduled automation: "${automation.name}" (id=${automation.id})`);
            try {
              const result = await executeAutomation(automation, 'scheduler');
              console.log(`[Scheduler] Automation "${automation.name}" executed: ${result.executedActions.length} action(s)`);

              // For one-time schedules, disable after firing
              if (triggerConfig.schedule_type === 'once') {
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
        } else if (triggerType === 'threshold') {
          if (this._isThresholdMet(triggerConfig, automation.last_run)) {
            console.log(`[Scheduler] Threshold met for automation: "${automation.name}" (id=${automation.id})`);
            try {
              const result = await executeAutomation(automation, 'scheduler');
              console.log(`[Scheduler] Automation "${automation.name}" executed: ${result.executedActions.length} action(s)`);
            } catch (err) {
              console.error(`[Scheduler] Error executing automation "${automation.name}":`, err.message);
              db.prepare(
                "INSERT INTO automation_logs (automation_id, status, message, triggered_at, completed_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))"
              ).run(automation.id, 'failure', `Scheduler error: ${err.message}`);
            }
          }
        }
        // 'manual' and 'event' triggers are not handled by the scheduler
      }
    } catch (err) {
      console.error('[Scheduler] Error in automation check loop:', err.message);
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
   */
  _isThresholdMet(triggerConfig, lastRun) {
    const now = new Date();

    // Cooldown: don't re-trigger within 60 seconds of last run
    if (lastRun) {
      const lastRunTime = this._parseUtcTimestamp(lastRun);
      if (lastRunTime && (now - lastRunTime) < 60000) return false;
    }

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

    // Check direct sensor value keys
    if (reading[sensorType] !== undefined) {
      currentValue = parseFloat(reading[sensorType]);
    }
    // Check in registers object
    if (currentValue === null && reading.registers) {
      for (const [key, val] of Object.entries(reading.registers)) {
        if (key.toLowerCase().includes(sensorType.toLowerCase())) {
          currentValue = parseFloat(val);
          break;
        }
      }
    }
    // Check in values object
    if (currentValue === null && reading.values) {
      for (const [key, val] of Object.entries(reading.values)) {
        if (key.toLowerCase().includes(sensorType.toLowerCase())) {
          currentValue = parseFloat(val);
          break;
        }
      }
    }

    if (currentValue === null || isNaN(currentValue)) return false;

    const threshold = parseFloat(triggerConfig.threshold_value);
    if (isNaN(threshold)) return false;

    const operator = triggerConfig.operator || 'gt';

    switch (operator) {
      case 'gt':  return currentValue > threshold;
      case 'gte': return currentValue >= threshold;
      case 'lt':  return currentValue < threshold;
      case 'lte': return currentValue <= threshold;
      case 'eq':  return currentValue === threshold;
      case 'neq': return currentValue !== threshold;
      default:    return false;
    }
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
