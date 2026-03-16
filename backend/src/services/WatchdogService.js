/**
 * WatchdogService - Monitors automations, equipment health, and connectivity.
 *
 * Checks every 2 minutes for:
 *  1. Scheduled automations that missed their fire window
 *  2. Threshold automations where condition was met but didn't execute
 *  3. Equipment that has gone offline or has errors
 *  4. Internet connectivity (DNS resolution)
 *  5. Internal services (go2rtc, MCP)
 *
 * All detections are logged to the watchdog_events table for persistent history.
 * Notifications that can't be sent (e.g. internet down) are queued and delivered
 * when connectivity is restored. Restart/power-outage gaps are detected on boot.
 */

const dns = require('dns');
const { db } = require('../utils/database');
const { telegramService } = require('./TelegramService');

const logEvent = db.prepare(`
  INSERT INTO watchdog_events (event_type, target, status, message, detail, duration_seconds, created_at)
  VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
`);

class WatchdogService {
  constructor() {
    this.checkIntervalMs = 120000; // 2 minutes
    this.intervalId = null;
    this.startupTimeoutId = null;
    this.running = false;
    this._tickInProgress = false;

    // Connectivity state tracking (in-memory, seeded from DB on start)
    this._connState = {
      internet: { up: null, downSince: null },
      go2rtc: { up: null, downSince: null },
      mcp: { up: null, downSince: null },
    };

    // Queue of Telegram messages to send once internet is back
    this._pendingNotifications = [];
  }

  start() {
    if (this.running) return;
    this.running = true;
    console.log(`[Watchdog] Service started (checking every ${this.checkIntervalMs / 1000}s)`);

    // Seed connectivity state and detect restart gaps
    this._seedConnState();
    this._detectRestartGap();

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

  _seedConnState() {
    try {
      for (const target of ['internet', 'go2rtc', 'mcp']) {
        const last = db.prepare(
          "SELECT status, created_at FROM watchdog_events WHERE event_type = 'connectivity' AND target = ? ORDER BY created_at DESC LIMIT 1"
        ).get(target);
        if (last) {
          this._connState[target].up = last.status === 'up';
          if (last.status === 'down') {
            this._connState[target].downSince = last.created_at;
          }
        }
      }
    } catch (err) {
      console.error('[Watchdog] Failed to seed connectivity state:', err.message);
    }
  }

  /**
   * Detect if the server was down (power outage / restart).
   * Compare the last watchdog_events timestamp to now.
   * If the gap is larger than 2x check interval, a restart/outage occurred.
   */
  _detectRestartGap() {
    try {
      const lastEvent = db.prepare(
        "SELECT created_at FROM watchdog_events ORDER BY created_at DESC LIMIT 1"
      ).get();

      if (!lastEvent) return; // First run ever, nothing to compare

      const lastTime = this._parseUtcTimestamp(lastEvent.created_at);
      const now = new Date();
      const gapMs = now.getTime() - lastTime.getTime();
      const gapThresholdMs = this.checkIntervalMs * 2; // 4 minutes

      if (gapMs > gapThresholdMs) {
        const gapSec = Math.round(gapMs / 1000);
        const durStr = this._formatDuration(gapMs);
        const msg = `System restarted after ${durStr} gap (last activity: ${lastEvent.created_at})`;

        logEvent.run('system', 'restart', 'restart', msg, null, gapSec);
        db.prepare("INSERT INTO alerts (severity, message, created_at) VALUES ('warning', ?, datetime('now'))").run(`Watchdog: ${msg}`);

        console.log(`[Watchdog] ${msg}`);

        // Queue notification about the restart
        this._queueNotification(
          `System Restart Detected`,
          `SenseHub was offline for ${durStr}.\nLast activity: ${lastEvent.created_at}\nRestarted: ${now.toISOString()}`,
          'warning'
        );

        // If internet was last known as "down" before the restart, queue that original alert too
        const inetState = this._connState.internet;
        if (inetState.up === false && inetState.downSince) {
          const totalDownSec = Math.round((now.getTime() - new Date(inetState.downSince).getTime()) / 1000);
          this._queueNotification(
            `Internet Outage Report`,
            `Internet has been down since ${inetState.downSince} (${this._formatDuration(totalDownSec * 1000)} so far). Will send recovery report when restored.`,
            'warning'
          );
        }
      }
    } catch (err) {
      console.error('[Watchdog] Restart gap detection error:', err.message);
    }
  }

  _safeTick() {
    if (this._tickInProgress) return;
    this._tickInProgress = true;
    this._tick()
      .catch(err => console.error('[Watchdog] Unhandled tick error:', err.message))
      .finally(() => { this._tickInProgress = false; });
  }

  async _tick() {
    try {
      // Connectivity checks always run (even without Telegram)
      await this._checkConnectivity();

      // Flush pending notifications if internet is up
      if (this._connState.internet.up && this._pendingNotifications.length > 0) {
        await this._flushPendingNotifications();
      }

      // Automation/equipment checks only if Telegram is configured
      if (telegramService.isConfigured()) {
        await this._checkMissedAutomations();
        await this._checkEquipmentHealth();
      }
    } catch (err) {
      console.error('[Watchdog] Error during check:', err.message);
    }
  }

  // ─── Notification Queue ───

  _queueNotification(title, detail, severity) {
    this._pendingNotifications.push({ title, detail, severity, queuedAt: new Date().toISOString() });
  }

  async _flushPendingNotifications() {
    if (!telegramService.isConfigured()) return;

    const toSend = [...this._pendingNotifications];
    this._pendingNotifications = [];

    for (const notif of toSend) {
      try {
        await telegramService.sendAlert(notif.title, notif.detail, notif.severity);
        console.log(`[Watchdog] Queued notification sent: ${notif.title}`);
      } catch (err) {
        console.error(`[Watchdog] Failed to send queued notification "${notif.title}":`, err.message);
        // Put it back if it failed (will retry next tick)
        this._pendingNotifications.push(notif);
      }
    }
  }

  // ─── Connectivity Monitoring ───

  async _checkConnectivity() {
    const checks = [
      { target: 'internet', check: () => this._checkInternet() },
      { target: 'go2rtc', check: () => this._checkService('http://127.0.0.1:1984/api', 'go2rtc') },
      { target: 'mcp', check: () => this._checkService('http://127.0.0.1:3001/health', 'MCP Server') },
    ];

    for (const { target, check } of checks) {
      try {
        const isUp = await check();
        await this._handleConnTransition(target, isUp);
      } catch (err) {
        await this._handleConnTransition(target, false);
      }
    }
  }

  _checkInternet() {
    return new Promise((resolve) => {
      const hosts = ['dns.google', 'one.one.one.one', 'cloudflare.com'];
      let resolved = false;

      for (const host of hosts) {
        dns.resolve4(host, { timeout: 5000 }, (err) => {
          if (!resolved && !err) {
            resolved = true;
            resolve(true);
          }
        });
      }

      setTimeout(() => {
        if (!resolved) resolve(false);
      }, 8000);
    });
  }

  async _checkService(url, name) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const r = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      return r.ok;
    } catch {
      return false;
    }
  }

  async _handleConnTransition(target, isUp) {
    const state = this._connState[target];
    const wasUp = state.up;
    const now = new Date();

    if (wasUp === null) {
      // First check — record initial state
      state.up = isUp;
      state.downSince = isUp ? null : now.toISOString();
      logEvent.run('connectivity', target, isUp ? 'up' : 'down', `${target} initial status: ${isUp ? 'online' : 'offline'}`, null, null);
      global.broadcast('connectivity_change', { target, status: isUp ? 'up' : 'down' });

      // If first check after seed found it down and now it's still down, no transition.
      // If first check finds it up but was seeded as down, handle recovery below via normal flow.
      return;
    }

    if (wasUp && !isUp) {
      // ── Went DOWN ──
      state.up = false;
      state.downSince = now.toISOString();
      const msg = `${target} went offline`;
      logEvent.run('connectivity', target, 'down', msg, null, null);
      global.broadcast('connectivity_change', { target, status: 'down' });
      console.log(`[Watchdog] ${msg}`);

      // Log alert to DB immediately (always works, it's local)
      db.prepare("INSERT INTO alerts (severity, message, created_at) VALUES ('warning', ?, datetime('now'))").run(`Watchdog: ${msg}`);

      if (target === 'internet') {
        // Can't send Telegram — queue it for when internet returns
        this._queueNotification(`Internet Connection Lost`, `Internet went offline at ${now.toISOString()}. Recovery report will follow.`, 'warning');
      } else if (telegramService.isConfigured()) {
        // Non-internet service down — try sending immediately, queue on failure
        try {
          await telegramService.sendAlert(`Service Offline: ${target}`, msg, 'warning');
        } catch {
          this._queueNotification(`Service Offline: ${target}`, msg, 'warning');
        }
      }

    } else if (!wasUp && isUp) {
      // ── Came back UP ──
      let durationSec = null;
      if (state.downSince) {
        durationSec = Math.round((now.getTime() - new Date(state.downSince).getTime()) / 1000);
      }
      state.up = true;
      const durStr = durationSec ? this._formatDuration(durationSec * 1000) : 'unknown';
      const msg = `${target} back online (was down ${durStr})`;
      logEvent.run('connectivity', target, 'up', msg, null, durationSec);
      state.downSince = null;
      global.broadcast('connectivity_change', { target, status: 'up', downtime_seconds: durationSec });
      console.log(`[Watchdog] ${msg}`);

      // Log alert to DB
      db.prepare("INSERT INTO alerts (severity, message, created_at) VALUES ('info', ?, datetime('now'))").run(`Watchdog: ${msg}`);

      if (target === 'internet') {
        // Internet just recovered — build a full outage report
        const report = `Internet connectivity restored.\nDowntime: ${durStr}${durationSec ? ` (${durationSec}s)` : ''}\nDown since: ${state.downSince || 'unknown'}\nRecovered: ${now.toISOString()}`;

        // Replace any pending "Internet Connection Lost" with the full report
        this._pendingNotifications = this._pendingNotifications.filter(n => !n.title.includes('Internet'));
        this._queueNotification(`Internet Restored (down ${durStr})`, report, 'info');
        // Flush will happen on the next part of _tick() since internet is now up

      } else if (telegramService.isConfigured()) {
        try {
          await telegramService.sendAlert(`Service Recovered: ${target}`, msg, 'info');
        } catch {
          this._queueNotification(`Service Recovered: ${target}`, msg, 'info');
        }
      }
    }
    // If state unchanged (up→up or down→down), do nothing
  }

  /** Get current connectivity status (for API) */
  getConnectivityStatus() {
    const result = {};
    for (const [target, state] of Object.entries(this._connState)) {
      result[target] = {
        status: state.up === null ? 'unknown' : (state.up ? 'up' : 'down'),
        downSince: state.downSince || null,
      };
    }
    result.pendingNotifications = this._pendingNotifications.length;
    return result;
  }

  // ─── Automation Checks ───

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
      if (triggerType === 'manual') continue;

      const graceMinutes = this._getGraceMinutes(triggerConfig);
      const lastRun = auto.last_run ? this._parseUtcTimestamp(auto.last_run) : null;
      const lastAlert = auto.last_watchdog_alert ? this._parseUtcTimestamp(auto.last_watchdog_alert) : null;

      if (triggerType === 'schedule') {
        const missedInfo = this._isScheduleMissed(triggerConfig, lastRun, graceMinutes, now);
        if (missedInfo.missed) {
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
          if (lastAlert && (now - lastAlert) < 3600000) continue;
          alerts.push({
            automationId: auto.id,
            name: auto.name,
            type: 'threshold_met_not_fired',
            detail: missedInfo.detail
          });
        }
      }
    }

    for (const alert of alerts) {
      try {
        const title = alert.type === 'schedule_missed'
          ? `Automation Missed: ${alert.name}`
          : `Threshold Met But Not Fired: ${alert.name}`;

        db.prepare("UPDATE automations SET last_watchdog_alert = datetime('now') WHERE id = ?").run(alert.automationId);
        db.prepare("INSERT INTO alerts (severity, message, created_at) VALUES ('warning', ?, datetime('now'))").run(`Watchdog: ${title} - ${alert.detail}`);
        logEvent.run('automation', alert.name, alert.type, title, alert.detail, null);

        // Try sending immediately, queue on failure
        try {
          await telegramService.sendAlert(title, alert.detail, 'warning');
        } catch {
          this._queueNotification(title, alert.detail, 'warning');
        }

        console.log(`[Watchdog] Alert sent: ${title}`);
      } catch (err) {
        console.error(`[Watchdog] Failed to process alert for "${alert.name}":`, err.message);
      }
    }
  }

  async _checkEquipmentHealth() {
    const equipment = db.prepare("SELECT * FROM equipment WHERE status IN ('offline', 'error')").all();
    const now = new Date();

    for (const eq of equipment) {
      const lastAlert = eq.last_watchdog_alert ? this._parseUtcTimestamp(eq.last_watchdog_alert) : null;
      if (lastAlert && (now - lastAlert) < 3600000) continue;

      const lastComm = eq.last_communication ? this._parseUtcTimestamp(eq.last_communication) : null;
      if (lastComm && (now - lastComm) < 300000) continue;

      const downDuration = lastComm ? this._formatDuration(now - lastComm) : 'unknown';
      const detail = eq.status === 'error'
        ? `Equipment "${eq.name}" has errors. Last communication: ${downDuration} ago.${eq.error_message ? `\nError: ${eq.error_message}` : ''}`
        : `Equipment "${eq.name}" is offline. Last communication: ${downDuration} ago.`;

      try {
        const severity = eq.status === 'error' ? 'error' : 'warning';
        const title = `Equipment ${eq.status === 'error' ? 'Error' : 'Offline'}: ${eq.name}`;
        db.prepare("UPDATE equipment SET last_watchdog_alert = datetime('now') WHERE id = ?").run(eq.id);
        db.prepare("INSERT INTO alerts (equipment_id, severity, message, created_at) VALUES (?, ?, ?, datetime('now'))").run(
          eq.id, eq.status === 'error' ? 'critical' : 'warning', `Watchdog: ${detail}`
        );
        const downSeconds = lastComm ? Math.round((now - lastComm) / 1000) : null;
        logEvent.run('equipment', eq.name, eq.status, title, detail, downSeconds);

        try {
          await telegramService.sendAlert(title, detail, severity);
        } catch {
          this._queueNotification(title, detail, severity);
        }

        console.log(`[Watchdog] Equipment alert sent: ${eq.name} (${eq.status})`);
      } catch (err) {
        console.error(`[Watchdog] Failed to send equipment alert for "${eq.name}":`, err.message);
      }
    }
  }

  // ─── Schedule Helpers ───

  _isScheduleMissed(triggerConfig, lastRun, graceMinutes, now) {
    const graceMs = graceMinutes * 60000;
    const scheduleType = triggerConfig.schedule_type;

    if (scheduleType === 'daily') {
      const [hours, minutes] = (triggerConfig.time || '08:00').split(':').map(Number);
      const expectedToday = new Date(now);
      expectedToday.setHours(hours, minutes, 0, 0);
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

  _isThresholdMissedButMet(triggerConfig, lastRun, graceMinutes, now) {
    if (!triggerConfig.equipment_id) return { missed: false };
    const equipment = db.prepare('SELECT * FROM equipment WHERE id = ?').get(triggerConfig.equipment_id);
    if (!equipment || !equipment.last_reading) return { missed: false };

    let reading;
    try {
      reading = typeof equipment.last_reading === 'string' ? JSON.parse(equipment.last_reading) : equipment.last_reading;
    } catch { return { missed: false }; }

    const sensorType = triggerConfig.sensor_type || 'temperature';
    let currentValue = null;
    const extractNumber = (v) => {
      if (v != null && typeof v === 'object' && v.value !== undefined) return parseFloat(v.value);
      return parseFloat(v);
    };

    if (reading[sensorType] !== undefined) currentValue = extractNumber(reading[sensorType]);
    if (currentValue === null && reading.registers) {
      for (const [key, val] of Object.entries(reading.registers)) {
        if (key.toLowerCase().includes(sensorType.toLowerCase())) { currentValue = extractNumber(val); break; }
      }
    }
    if (currentValue === null && reading.values) {
      for (const [key, val] of Object.entries(reading.values)) {
        if (key.toLowerCase().includes(sensorType.toLowerCase())) { currentValue = extractNumber(val); break; }
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
    return 10;
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
