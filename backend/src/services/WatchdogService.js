/**
 * WatchdogService - Monitors automations and equipment health.
 *
 * Checks every 2 minutes for:
 *  1. Scheduled automations that missed their fire window
 *  2. Threshold automations where condition was met but didn't execute
 *  3. Equipment that has gone offline or has errors
 *
 * Sends Telegram alerts on detection. Alerts once per missed window (cooldown).
 */

const { db } = require('../utils/database');
const { telegramService } = require('./TelegramService');

class WatchdogService {
  constructor() {
    this.checkIntervalMs = 120000; // 2 minutes
    this.intervalId = null;
    this.startupTimeoutId = null;
    this.running = false;
    this._tickInProgress = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    console.log(`[Watchdog] Service started (checking every ${this.checkIntervalMs / 1000}s)`);

    // First check after 30s (let other services boot)
    this.startupTimeoutId = setTimeout(() => {
      this.startupTimeoutId = null;
      this._safeTick();
      this.intervalId = setInterval(() => this._safeTick(), this.checkIntervalMs);
    }, 30000);
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
    console.log('[Watchdog] Service stopped');
  }

  _safeTick() {
    if (this._tickInProgress) return;
    this._tickInProgress = true;
    this._tick()
      .catch(err => console.error('[Watchdog] Unhandled tick error:', err.message))
      .finally(() => { this._tickInProgress = false; });
  }

  async _tick() {
    if (!telegramService.isConfigured()) return;

    try {
      await this._checkMissedAutomations();
      await this._checkEquipmentHealth();
    } catch (err) {
      console.error('[Watchdog] Error during check:', err.message);
    }
  }

  /**
   * Check for automations that should have fired but didn't.
   */
  async _checkMissedAutomations() {
    const automations = db.prepare('SELECT * FROM automations WHERE enabled = 1').all();
    const now = new Date();
    const alerts = [];

    for (const auto of automations) {
      let triggerConfig;
      try {
        triggerConfig = typeof auto.trigger_config === 'string'
          ? JSON.parse(auto.trigger_config)
          : auto.trigger_config || {};
      } catch {
        continue;
      }

      const triggerType = triggerConfig.type;
      if (triggerType === 'manual') continue; // Don't monitor manual triggers

      // Get grace period from watchdog settings (default 30 min for schedule, 10 min for threshold)
      const graceMinutes = this._getGraceMinutes(triggerConfig);
      const lastRun = auto.last_run ? this._parseUtcTimestamp(auto.last_run) : null;
      const lastAlert = auto.last_watchdog_alert ? this._parseUtcTimestamp(auto.last_watchdog_alert) : null;

      if (triggerType === 'schedule') {
        const missedInfo = this._isScheduleMissed(triggerConfig, lastRun, graceMinutes, now);
        if (missedInfo.missed) {
          // Cooldown: don't re-alert if we already alerted for this window
          if (lastAlert && (now - lastAlert) < missedInfo.windowMs) continue;

          alerts.push({
            automationId: auto.id,
            name: auto.name,
            type: 'schedule_missed',
            detail: missedInfo.detail
          });
        }
      } else if (triggerType === 'threshold') {
        const missedInfo = this._isThresholdMissedButMet(triggerConfig, lastRun, graceMinutes, now);
        if (missedInfo.missed) {
          if (lastAlert && (now - lastAlert) < 3600000) continue; // 1hr cooldown for threshold

          alerts.push({
            automationId: auto.id,
            name: auto.name,
            type: 'threshold_met_not_fired',
            detail: missedInfo.detail
          });
        }
      }
    }

    // Send alerts
    for (const alert of alerts) {
      try {
        const title = alert.type === 'schedule_missed'
          ? `Automation Missed: ${alert.name}`
          : `Threshold Met But Not Fired: ${alert.name}`;

        await telegramService.sendAlert(title, alert.detail, 'warning');

        // Update last_watchdog_alert
        db.prepare(
          "UPDATE automations SET last_watchdog_alert = datetime('now') WHERE id = ?"
        ).run(alert.automationId);

        // Also log to alerts table
        db.prepare(
          "INSERT INTO alerts (severity, message, created_at) VALUES ('warning', ?, datetime('now'))"
        ).run(`Watchdog: ${title} - ${alert.detail}`);

        console.log(`[Watchdog] Alert sent: ${title}`);
      } catch (err) {
        console.error(`[Watchdog] Failed to send alert for "${alert.name}":`, err.message);
      }
    }
  }

  /**
   * Check for equipment that is offline or erroring.
   */
  async _checkEquipmentHealth() {
    const equipment = db.prepare(
      "SELECT * FROM equipment WHERE status IN ('offline', 'error')"
    ).all();

    const now = new Date();

    for (const eq of equipment) {
      const lastAlert = eq.last_watchdog_alert ? this._parseUtcTimestamp(eq.last_watchdog_alert) : null;

      // Cooldown: don't re-alert within 1 hour for the same equipment
      if (lastAlert && (now - lastAlert) < 3600000) continue;

      // Only alert if the equipment has been down for at least 5 minutes
      const lastComm = eq.last_communication ? this._parseUtcTimestamp(eq.last_communication) : null;
      if (lastComm && (now - lastComm) < 300000) continue; // Less than 5 min — not yet stale

      const downDuration = lastComm ? this._formatDuration(now - lastComm) : 'unknown';
      const detail = eq.status === 'error'
        ? `Equipment "${eq.name}" has errors. Last communication: ${downDuration} ago.${eq.error_message ? `\nError: ${eq.error_message}` : ''}`
        : `Equipment "${eq.name}" is offline. Last communication: ${downDuration} ago.`;

      try {
        await telegramService.sendAlert(
          `Equipment ${eq.status === 'error' ? 'Error' : 'Offline'}: ${eq.name}`,
          detail,
          eq.status === 'error' ? 'error' : 'warning'
        );

        db.prepare(
          "UPDATE equipment SET last_watchdog_alert = datetime('now') WHERE id = ?"
        ).run(eq.id);

        // Log to alerts table
        db.prepare(
          "INSERT INTO alerts (equipment_id, severity, message, created_at) VALUES (?, ?, ?, datetime('now'))"
        ).run(eq.id, eq.status === 'error' ? 'critical' : 'warning', `Watchdog: ${detail}`);

        console.log(`[Watchdog] Equipment alert sent: ${eq.name} (${eq.status})`);
      } catch (err) {
        console.error(`[Watchdog] Failed to send equipment alert for "${eq.name}":`, err.message);
      }
    }
  }

  /**
   * Check if a scheduled automation missed its fire window.
   */
  _isScheduleMissed(triggerConfig, lastRun, graceMinutes, now) {
    const graceMs = graceMinutes * 60000;
    const scheduleType = triggerConfig.schedule_type;

    if (scheduleType === 'daily') {
      const [hours, minutes] = (triggerConfig.time || '08:00').split(':').map(Number);
      const expectedToday = new Date(now);
      expectedToday.setHours(hours, minutes, 0, 0);

      // If we're past the expected time + grace, and haven't run since expected time
      if (now > new Date(expectedToday.getTime() + graceMs)) {
        if (!lastRun || lastRun < expectedToday) {
          return {
            missed: true,
            detail: `Daily automation scheduled for ${triggerConfig.time} has not fired today.${lastRun ? ` Last run: ${lastRun.toISOString()}` : ' Never run.'}`,
            windowMs: 24 * 3600000
          };
        }
      }
      return { missed: false };
    }

    if (scheduleType === 'weekly') {
      const dayOfWeek = parseInt(triggerConfig.day_of_week || '1', 10);
      const [hours, minutes] = (triggerConfig.time || '08:00').split(':').map(Number);

      // Find the most recent expected run day
      const expected = new Date(now);
      const currentDay = expected.getDay();
      const dayDiff = (currentDay - dayOfWeek + 7) % 7;
      expected.setDate(expected.getDate() - dayDiff);
      expected.setHours(hours, minutes, 0, 0);

      if (now > new Date(expected.getTime() + graceMs)) {
        if (!lastRun || lastRun < expected) {
          const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
          return {
            missed: true,
            detail: `Weekly automation (${days[dayOfWeek]} at ${triggerConfig.time}) has not fired this week.${lastRun ? ` Last run: ${lastRun.toISOString()}` : ' Never run.'}`,
            windowMs: 7 * 24 * 3600000
          };
        }
      }
      return { missed: false };
    }

    if (scheduleType === 'hourly') {
      const minute = parseInt(triggerConfig.minute || '0', 10);
      const expectedThisHour = new Date(now);
      expectedThisHour.setMinutes(minute, 0, 0);

      if (now > new Date(expectedThisHour.getTime() + graceMs)) {
        if (!lastRun || lastRun < expectedThisHour) {
          return {
            missed: true,
            detail: `Hourly automation (at :${String(minute).padStart(2, '0')}) has not fired this hour.${lastRun ? ` Last run: ${lastRun.toISOString()}` : ' Never run.'}`,
            windowMs: 3600000
          };
        }
      }
      return { missed: false };
    }

    return { missed: false };
  }

  /**
   * Check if a threshold condition is currently met but automation hasn't fired.
   */
  _isThresholdMissedButMet(triggerConfig, lastRun, graceMinutes, now) {
    if (!triggerConfig.equipment_id) return { missed: false };

    const equipment = db.prepare('SELECT * FROM equipment WHERE id = ?').get(triggerConfig.equipment_id);
    if (!equipment || !equipment.last_reading) return { missed: false };

    let reading;
    try {
      reading = typeof equipment.last_reading === 'string'
        ? JSON.parse(equipment.last_reading)
        : equipment.last_reading;
    } catch {
      return { missed: false };
    }

    // Find current value for the sensor type
    const sensorType = triggerConfig.sensor_type || 'temperature';
    let currentValue = null;

    const extractNumber = (v) => {
      if (v != null && typeof v === 'object' && v.value !== undefined) return parseFloat(v.value);
      return parseFloat(v);
    };

    if (reading[sensorType] !== undefined) {
      currentValue = extractNumber(reading[sensorType]);
    }
    if (currentValue === null && reading.registers) {
      for (const [key, val] of Object.entries(reading.registers)) {
        if (key.toLowerCase().includes(sensorType.toLowerCase())) {
          currentValue = extractNumber(val);
          break;
        }
      }
    }
    if (currentValue === null && reading.values) {
      for (const [key, val] of Object.entries(reading.values)) {
        if (key.toLowerCase().includes(sensorType.toLowerCase())) {
          currentValue = extractNumber(val);
          break;
        }
      }
    }

    if (currentValue === null || isNaN(currentValue)) return { missed: false };

    const threshold = parseFloat(triggerConfig.threshold_value);
    if (isNaN(threshold)) return { missed: false };

    const operator = triggerConfig.operator || 'gt';
    const conditionMet = (() => {
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

    if (!conditionMet) return { missed: false };

    // Condition IS met — check if automation fired recently (within grace period)
    const graceMs = graceMinutes * 60000;
    if (lastRun && (now - lastRun) < graceMs) return { missed: false };

    const opSymbols = { gt: '>', gte: '>=', lt: '<', lte: '<=', eq: '==', neq: '!=' };
    return {
      missed: true,
      detail: `Threshold condition met (${sensorType}: ${currentValue} ${opSymbols[operator] || operator} ${threshold}${triggerConfig.unit || ''}) but automation hasn't fired.${lastRun ? ` Last run: ${lastRun.toISOString()}` : ' Never run.'}\nEquipment: ${equipment.name}`
    };
  }

  _getGraceMinutes(triggerConfig) {
    if (triggerConfig.type === 'schedule') {
      switch (triggerConfig.schedule_type) {
        case 'hourly': return 10;
        case 'daily': return 30;
        case 'weekly': return 60;
        default: return 30;
      }
    }
    return 10; // threshold default
  }

  _parseUtcTimestamp(sqliteDateStr) {
    if (!sqliteDateStr) return null;
    const str = sqliteDateStr.endsWith('Z') || sqliteDateStr.includes('+')
      ? sqliteDateStr
      : sqliteDateStr.replace(' ', 'T') + 'Z';
    return new Date(str);
  }

  _formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${minutes % 60}m`;
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
}

const watchdogService = new WatchdogService();

module.exports = { watchdogService };
