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
const { createAlert } = require('../utils/alertBroadcast');
const { M } = require('../i18n');

// Weekday names for missed-weekly details (literal keys so the catalog test can scan them).
const DAY_KEYS = ['watchdog.day.0', 'watchdog.day.1', 'watchdog.day.2', 'watchdog.day.3', 'watchdog.day.4', 'watchdog.day.5', 'watchdog.day.6'];
const { telegramService } = require('./TelegramService');
const { automationArmingService } = require('./AutomationArmingService');

// Auto-rearm: when a threshold automation should be firing but hasn't (the relay was
// killed by the safety watchdog and the condition is still met, so no rising edge
// re-fires it), this service can re-execute the automation. Hard-capped per
// automation/hour to prevent runaway.
//
// Config (system_settings.watchdog_rearm_config JSON):
//   { enabled: true, max_per_hour: 6, min_interval_seconds: 300 }
const REARM_CONFIG_KEY = 'watchdog_rearm_config';
const REARM_DEFAULTS = { enabled: true, max_per_hour: 6, min_interval_seconds: 300 };

function getRearmConfig() {
  try {
    const row = db.prepare("SELECT value FROM system_settings WHERE key = ?").get(REARM_CONFIG_KEY);
    if (row?.value) return { ...REARM_DEFAULTS, ...JSON.parse(row.value) };
  } catch (_) {}
  return { ...REARM_DEFAULTS };
}

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

    // Rolling window of recent auto-rearm fires per automation id, in ms.
    // _rearmHistory[autoId] = [ms, ms, ...] (only kept for the trailing hour).
    this._rearmHistory = new Map();

    // Equipment ids we have already told Telegram are down. A device gets one
    // "went down" message on first detection, then at most one digest per 24 h
    // (gated by equipment.last_watchdog_alert), and one "recovered" message
    // when it is next seen online. Seeded from the DB on start().
    this._eqDownNotified = new Set();

    // Throttle for low-value debug lines: key -> last log time (ms)
    this._lastDebugLog = new Map();
  }

  /** Log `msg` at most once per `everyMs` for the given key. */
  _debugThrottled(key, msg, everyMs = 30 * 60 * 1000) {
    const now = Date.now();
    const last = this._lastDebugLog.get(key) || 0;
    if (now - last < everyMs) return;
    this._lastDebugLog.set(key, now);
    console.log(msg);
  }

  /** Returns true if we should rearm this automation, false if rate-limited.
   *  Records the attempt (regardless of outcome) so repeat calls within the
   *  cooldown still see it as recently rearmed. */
  _shouldRearm(automationId, cfg) {
    const now = Date.now();
    const windowMs = 60 * 60 * 1000;
    const arr = (this._rearmHistory.get(automationId) || []).filter(t => now - t < windowMs);
    const minIntervalMs = (cfg.min_interval_seconds || 300) * 1000;
    if (arr.length && now - arr[arr.length - 1] < minIntervalMs) return false;
    if (arr.length >= (cfg.max_per_hour || 6)) return false;
    arr.push(now);
    this._rearmHistory.set(automationId, arr);
    return true;
  }

  start() {
    if (this.running) return;
    this.running = true;
    console.log(`[Watchdog] Service started (checking every ${this.checkIntervalMs / 1000}s)`);

    // Seed connectivity state and detect restart gaps
    this._seedConnState();
    this._seedEquipmentDownState();
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

  /**
   * Seed _eqDownNotified with devices that are currently down AND were already
   * alerted on (last_watchdog_alert set) so a restart doesn't re-send "went
   * down" for them. Only currently-down rows are seeded: seeding every row
   * with a stale last_watchdog_alert would fire a burst of bogus "recovered"
   * messages on the first tick.
   */
  _seedEquipmentDownState() {
    try {
      const rows = db.prepare(
        "SELECT id FROM equipment WHERE enabled = 1 AND status IN ('offline', 'error') AND last_watchdog_alert IS NOT NULL"
      ).all();
      for (const r of rows) this._eqDownNotified.add(r.id);
      if (rows.length) console.log(`[Watchdog] Seeded ${rows.length} equipment id(s) as already-notified down`);
    } catch (err) {
      console.error('[Watchdog] Failed to seed equipment down state:', err.message);
    }
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
        const durSpec = this._durationSpec(gapMs);
        const msg = `System restarted after ${durStr} gap (last activity: ${lastEvent.created_at})`;

        logEvent.run('system', 'restart', 'restart', msg, null, gapSec);
        createAlert({ severity: 'warning', source: 'watchdog', fingerprint: 'system_restart',
          messageKey: 'watchdog.restart_alert', messageParams: { dur: durSpec, at: lastEvent.created_at } });

        console.log(`[Watchdog] ${msg}`);

        // Queue notification about the restart
        this._queueNotification(
          `System Restart Detected`,
          `SenseHub was offline for ${durStr}.\nLast activity: ${lastEvent.created_at}\nRestarted: ${now.toISOString()}`,
          'warning',
          {
            titleSpec: M('watchdog.restart_title'),
            detailSpec: M('watchdog.restart_detail', { dur: durSpec, at: lastEvent.created_at, restarted: now.toISOString() }),
          }
        );

        // If internet was last known as "down" before the restart, queue that original alert too
        const inetState = this._connState.internet;
        if (inetState.up === false && inetState.downSince) {
          const totalDownSec = Math.round((now.getTime() - new Date(inetState.downSince).getTime()) / 1000);
          this._queueNotification(
            `Internet Outage Report`,
            `Internet has been down since ${inetState.downSince} (${this._formatDuration(totalDownSec * 1000)} so far). Will send recovery report when restored.`,
            'warning',
            {
              titleSpec: M('watchdog.internet_outage_title'),
              detailSpec: M('watchdog.internet_outage_detail', { since: inetState.downSince, dur: this._durationSpec(totalDownSec * 1000) }),
            }
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

  /**
   * title / detail stay English strings (logs, the Internet de-dupe filter);
   * specs.titleSpec / specs.detailSpec are the i18n versions Telegram renders
   * in telegram_language (falls back to the English strings when absent).
   */
  _queueNotification(title, detail, severity, specs = {}) {
    this._pendingNotifications.push({
      title, detail, severity, queuedAt: new Date().toISOString(),
      titleSpec: specs.titleSpec || null, detailSpec: specs.detailSpec || null,
    });
  }

  async _flushPendingNotifications() {
    if (!telegramService.isConfigured()) return;

    const toSend = [...this._pendingNotifications];
    this._pendingNotifications = [];

    for (const notif of toSend) {
      try {
        await telegramService.sendAlert(notif.titleSpec || notif.title, notif.detailSpec || notif.detail, notif.severity);
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
      createAlert({ severity: 'warning', source: 'watchdog', fingerprint: `connectivity_down:${target}`,
        messageKey: 'watchdog.conn_down_alert', messageParams: { target } });

      if (target === 'internet') {
        // Can't send Telegram — queue it for when internet returns
        this._queueNotification(`Internet Connection Lost`, `Internet went offline at ${now.toISOString()}. Recovery report will follow.`, 'warning', {
          titleSpec: M('watchdog.internet_lost_title'),
          detailSpec: M('watchdog.internet_lost_detail', { at: now.toISOString() }),
        });
      } else if (telegramService.isConfigured()) {
        // Non-internet service down — try sending immediately, queue on failure
        const specs = { titleSpec: M('watchdog.service_offline_title', { target }), detailSpec: M('watchdog.conn_down', { target }) };
        try {
          await telegramService.sendAlert(specs.titleSpec, specs.detailSpec, 'warning');
        } catch {
          this._queueNotification(`Service Offline: ${target}`, msg, 'warning', specs);
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
      const durSpec = durationSec ? this._durationSpec(durationSec * 1000) : M('common.unknown');
      const msg = `${target} back online (was down ${durStr})`;
      logEvent.run('connectivity', target, 'up', msg, null, durationSec);
      state.downSince = null;
      global.broadcast('connectivity_change', { target, status: 'up', downtime_seconds: durationSec });
      console.log(`[Watchdog] ${msg}`);

      // Log alert to DB
      createAlert({ severity: 'info', source: 'watchdog', fingerprint: `connectivity_up:${target}`,
        messageKey: 'watchdog.conn_up_alert', messageParams: { target, dur: durSpec } });

      if (target === 'internet') {
        // Internet just recovered — build a full outage report
        const report = `Internet connectivity restored.\nDowntime: ${durStr}${durationSec ? ` (${durationSec}s)` : ''}\nDown since: ${state.downSince || 'unknown'}\nRecovered: ${now.toISOString()}`;
        const reportSpec = M('watchdog.internet_restored_detail', {
          downtime: durationSec ? M('watchdog.dur_with_secs', { dur: durSpec, s: String(durationSec) }) : durSpec,
          since: state.downSince || M('common.unknown'),
          at: now.toISOString(),
        });

        // Replace any pending "Internet Connection Lost" with the full report
        this._pendingNotifications = this._pendingNotifications.filter(n => !n.title.includes('Internet'));
        this._queueNotification(`Internet Restored (down ${durStr})`, report, 'info', {
          titleSpec: M('watchdog.internet_restored_title', { dur: durSpec }),
          detailSpec: reportSpec,
        });
        // Flush will happen on the next part of _tick() since internet is now up

      } else if (telegramService.isConfigured()) {
        const specs = { titleSpec: M('watchdog.service_recovered_title', { target }), detailSpec: M('watchdog.conn_up', { target, dur: durSpec }) };
        try {
          await telegramService.sendAlert(specs.titleSpec, specs.detailSpec, 'info');
        } catch {
          this._queueNotification(`Service Recovered: ${target}`, msg, 'info', specs);
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
    // Emergency stop gate. Auto-rearm below re-EXECUTES threshold automations,
    // which energises coils — it would silently undo an emergency stop within
    // minutes. While disarmed every automation is deliberately not firing, so
    // the "missed"/"met but not fired" alerts are noise about an operator's own
    // action; the whole check is skipped rather than just the rearm (checking
    // earlier also avoids burning _shouldRearm's rate-limit slots).
    // Equipment / connectivity / service checks are unaffected.
    const arming = automationArmingService.getState();
    if (arming.disarmed) {
      automationArmingService.noteSkip(
        'watchdog_rearm',
        `[Watchdog] Automations DISARMED — skipping missed-automation checks and auto-rearm${automationArmingService.describe(arming)}`
      );
      return;
    }

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
            detail: missedInfo.detail,
            detailSpec: missedInfo.detailSpec || null,
          });
        }
      } else if (triggerType === 'threshold') {
        triggerConfig._automation_id = auto.id;
        const missedInfo = this._isThresholdMissedButMet(triggerConfig, lastRun, graceMinutes, now);
        if (missedInfo.missed) {
          // What relay states does this automation want? Alert/log-only
          // automations have none — they must NEVER be re-executed (that would
          // just re-send the alert), so they only get a throttled watchdog alert.
          const desired = this._desiredRelayStates(auto.actions);
          if (desired.length === 0) {
            if (lastAlert && (now - lastAlert) < 3600000) continue;
            alerts.push({
              automationId: auto.id,
              name: auto.name,
              type: 'threshold_met_not_fired',
              detail: missedInfo.detail,
              detailSpec: missedInfo.detailSpec || null,
            });
            continue;
          }

          // If every relay the automation would touch is ALREADY in the desired
          // state there is nothing to re-fire: the automation (or an operator)
          // did its job and the relays simply stayed put. Re-executing would
          // burn a rate-limit slot and, with an "off" automation, spam relay
          // events. Unknown cache (write-only boards, missing relayStates) or
          // toggle actions fall through to the existing rearm behaviour.
          const match = this._relayStatesMatch(desired);
          if (match.allMatch) {
            this._debugThrottled(
              `rearm-match-${auto.id}`,
              `[Watchdog] "${auto.name}": threshold met but all ${match.checked} relay(s) already in desired state - skipping rearm`
            );
            continue;
          }

          // Auto-rearm: re-fire the automation if the condition is still met. This
          // covers the rising-edge gap left behind when the safety watchdog force-OFFs
          // a relay while its triggering condition is still true — without this,
          // nothing turns the relay back on until the sensor crosses the threshold
          // again.
          const rearmCfg = getRearmConfig();
          let rearmed = false;
          let rearmError = null;
          if (rearmCfg.enabled && this._shouldRearm(auto.id, rearmCfg)) {
            try {
              const { executeAutomation } = require('./AutomationExecutor');
              await executeAutomation(auto, 'watchdog_rearm');
              rearmed = true;
              try {
                logEvent.run(
                  'automation', auto.name, 'rearm', `Auto-rearmed: ${auto.name}`,
                  missedInfo.detail, null,
                );
              } catch (_) {}
            } catch (err) {
              rearmError = err.message || String(err);
              console.error(`[Watchdog] Auto-rearm failed for "${auto.name}":`, rearmError);
            }
          }

          // Only raise the "Threshold Met But Not Fired" alert if the rearm did not
          // succeed (rate-limited, disabled, or executor error). When rearm worked
          // the alert is redundant — the system self-healed.
          if (!rearmed) {
            if (lastAlert && (now - lastAlert) < 3600000) continue;
            alerts.push({
              automationId: auto.id,
              name: auto.name,
              type: 'threshold_met_not_fired',
              detail: missedInfo.detail + (rearmError ? `\nAuto-rearm error: ${rearmError}` : ''),
              detailSpec: rearmError && missedInfo.detailSpec
                ? M('watchdog.with_rearm_error', { detail: missedInfo.detailSpec, error: rearmError })
                : (missedInfo.detailSpec || null),
            });
          } else {
            // Update last_watchdog_alert so the next tick's de-dupe window applies
            // to the rearm (we don't want to rearm + alert + rearm in a loop).
            db.prepare("UPDATE automations SET last_watchdog_alert = datetime('now') WHERE id = ?").run(auto.id);
          }
        }
      }
    }

    for (const alert of alerts) {
      try {
        const title = alert.type === 'schedule_missed'
          ? `Automation Missed: ${alert.name}`
          : `Threshold Met But Not Fired: ${alert.name}`;
        const titleSpec = alert.type === 'schedule_missed'
          ? M('watchdog.title_automation_missed', { name: alert.name })
          : M('watchdog.title_threshold_not_fired', { name: alert.name });
        const detailSpec = alert.detailSpec || alert.detail;

        db.prepare("UPDATE automations SET last_watchdog_alert = datetime('now') WHERE id = ?").run(alert.automationId);
        createAlert({
          severity: 'warning',
          source: 'watchdog',
          automation_id: alert.automationId,
          fingerprint: alert.type === 'schedule_missed'
            ? `watchdog_missed:${alert.automationId}`
            : `watchdog_rearm:${alert.automationId}`,
          messageKey: 'watchdog.automation_alert',
          messageParams: { title: titleSpec, detail: detailSpec },
        });
        logEvent.run('automation', alert.name, alert.type, title, alert.detail, null);

        // Try sending immediately, queue on failure
        try {
          await telegramService.sendAlert(titleSpec, detailSpec, 'warning');
        } catch {
          this._queueNotification(title, alert.detail, 'warning', { titleSpec, detailSpec });
        }

        console.log(`[Watchdog] Alert sent: ${title}`);
      } catch (err) {
        console.error(`[Watchdog] Failed to process alert for "${alert.name}":`, err.message);
      }
    }
  }

  async _checkEquipmentHealth() {
    // Disabled devices are intentionally not polled, so they are never "down"
    const equipment = db.prepare(
      "SELECT * FROM equipment WHERE status IN ('offline', 'error') AND enabled = 1"
    ).all();
    const now = new Date();
    const DIGEST_MS = 24 * 3600000;
    const downIds = new Set();

    for (const eq of equipment) {
      const lastComm = eq.last_communication ? this._parseUtcTimestamp(eq.last_communication) : null;
      // Heard from it in the last 5 min: treat as flapping, not down (yet)
      if (lastComm && (now - lastComm) < 300000) continue;

      downIds.add(eq.id);

      const alreadyNotified = this._eqDownNotified.has(eq.id);
      const lastAlert = eq.last_watchdog_alert ? this._parseUtcTimestamp(eq.last_watchdog_alert) : null;
      // First detection → notify now. After that → at most one digest per 24 h.
      if (alreadyNotified && lastAlert && (now - lastAlert) < DIGEST_MS) continue;

      const downDuration = lastComm ? this._formatDuration(now - lastComm) : 'unknown';
      const downSpec = lastComm ? this._durationSpec(now - lastComm) : M('common.unknown');
      const errText = eq.error_log || eq.error_message;
      const detail = eq.status === 'error'
        ? `Equipment "${eq.name}" has errors. Last communication: ${downDuration} ago.${errText ? `\nError: ${errText}` : ''}`
        : `Equipment "${eq.name}" is offline. Last communication: ${downDuration} ago.`;
      const detailSpec = eq.status === 'error'
        ? (errText
          ? M('watchdog.equipment_error_detail_with_error', { name: eq.name, dur: downSpec, error: String(errText) })
          : M('watchdog.equipment_error_detail', { name: eq.name, dur: downSpec }))
        : M('watchdog.equipment_offline_detail', { name: eq.name, dur: downSpec });

      try {
        const severity = eq.status === 'error' ? 'error' : 'warning';
        const kind = alreadyNotified ? 'Still Down' : (eq.status === 'error' ? 'Error' : 'Offline');
        const title = `Equipment ${kind}: ${eq.name}`;
        const titleSpec = alreadyNotified
          ? M('watchdog.title_equipment_still_down', { name: eq.name })
          : (eq.status === 'error' ? M('watchdog.title_equipment_error', { name: eq.name }) : M('watchdog.title_equipment_offline', { name: eq.name }));
        db.prepare("UPDATE equipment SET last_watchdog_alert = datetime('now') WHERE id = ?").run(eq.id);

        // One open (unacknowledged) alerts row per device: the stable fingerprint
        // makes createAlert bump occurrence_count on each digest instead of
        // stacking a new row while the first is still unread.
        createAlert({
          severity: eq.status === 'error' ? 'critical' : 'warning',
          source: 'watchdog',
          equipment_id: eq.id,
          fingerprint: `equipment_offline:${eq.id}`,
          messageKey: 'watchdog.equipment_alert',
          messageParams: { detail: detailSpec },
        });
        const downSeconds = lastComm ? Math.round((now - lastComm) / 1000) : null;
        logEvent.run('equipment', eq.name, eq.status, title, detail, downSeconds);

        try {
          await telegramService.sendAlert(titleSpec, detailSpec, severity);
        } catch {
          this._queueNotification(title, detail, severity, { titleSpec, detailSpec });
        }
        this._eqDownNotified.add(eq.id);

        console.log(`[Watchdog] Equipment ${alreadyNotified ? 'digest' : 'alert'} sent: ${eq.name} (${eq.status})`);
      } catch (err) {
        console.error(`[Watchdog] Failed to send equipment alert for "${eq.name}":`, err.message);
      }
    }

    // Recovery: anything we reported down that is no longer in the down set
    for (const id of [...this._eqDownNotified]) {
      if (downIds.has(id)) continue;
      let eq = null;
      try { eq = db.prepare('SELECT * FROM equipment WHERE id = ?').get(id); } catch (_) {}

      // Deleted or disabled: forget it quietly — "recovered" would be misleading
      if (!eq || !eq.enabled) {
        this._eqDownNotified.delete(id);
        continue;
      }
      // Still offline/error but heard from within 5 min: flapping, wait
      if (eq.status === 'offline' || eq.status === 'error') continue;

      this._eqDownNotified.delete(id);
      const lastAlert = eq.last_watchdog_alert ? this._parseUtcTimestamp(eq.last_watchdog_alert) : null;
      const msg = `Equipment "${eq.name}" is back online${lastAlert ? ` (alerted ${this._formatDuration(now - lastAlert)} ago)` : ''}.`;
      const title = `Equipment Recovered: ${eq.name}`;
      const titleSpec = M('watchdog.title_equipment_recovered', { name: eq.name });
      const msgSpec = lastAlert
        ? M('watchdog.equipment_recovered_alerted', { name: eq.name, dur: this._durationSpec(now - lastAlert) })
        : M('watchdog.equipment_recovered', { name: eq.name });
      try {
        logEvent.run('equipment', eq.name, 'recovered', title, msg, null);
        createAlert({
          severity: 'info',
          source: 'watchdog',
          equipment_id: eq.id,
          fingerprint: `equipment_recovered:${eq.id}`,
          messageKey: 'watchdog.equipment_alert',
          messageParams: { detail: msgSpec },
        });
        try {
          await telegramService.sendAlert(titleSpec, msgSpec, 'info');
        } catch {
          this._queueNotification(title, msg, 'info', { titleSpec, detailSpec: msgSpec });
        }
        console.log(`[Watchdog] Equipment recovered: ${eq.name}`);
      } catch (err) {
        console.error(`[Watchdog] Failed to send recovery notice for "${eq.name}":`, err.message);
      }
    }
  }

  // ─── Relay-state helpers (auto-rearm) ───

  /**
   * Coil channel addresses an "all channels" control action would touch —
   * same filter as AutomationExecutor's all-channels mode.
   */
  _coilChannels(equipmentId) {
    let mappings = [];
    try {
      const eq = db.prepare('SELECT register_mappings FROM equipment WHERE id = ?').get(equipmentId);
      if (!eq) return [];
      mappings = typeof eq.register_mappings === 'string'
        ? JSON.parse(eq.register_mappings)
        : (eq.register_mappings || []);
    } catch (_) { return []; }
    if (!Array.isArray(mappings)) return [];
    return mappings
      .filter(m => m && m.type === 'coil' && m.access === 'readwrite')
      .map(m => parseInt(m.register ?? m.address, 10))
      .filter(Number.isFinite);
  }

  /**
   * Relay states an automation's actions would leave behind.
   * Returns [{ equipment_id, channel, state }] where state is a boolean, or
   * null for a 'toggle' control action (desired state depends on current).
   *
   * Handles the two relay-writing action shapes from AutomationExecutor:
   *   { type:'control', equipment_id, channel|null(all channels), action:'on'|'off'|'toggle' }
   *   { type:'transition', equipment_id, transitions:[{ channel, state }] }
   * Alert/log/other actions contribute nothing, so an empty result means the
   * automation does not drive relays at all.
   */
  _desiredRelayStates(actions) {
    let list = actions;
    if (typeof list === 'string') {
      try { list = JSON.parse(list); } catch (_) { return []; }
    }
    if (!Array.isArray(list)) return [];

    const out = [];
    for (const a of list) {
      if (!a || typeof a !== 'object') continue;
      const equipmentId = parseInt(a.equipment_id, 10);
      if (!Number.isFinite(equipmentId)) continue;

      if (a.type === 'control') {
        const state = a.action === 'on' ? true : a.action === 'off' ? false : null;
        if (a.channel != null) {
          const channel = parseInt(a.channel, 10);
          if (Number.isFinite(channel)) out.push({ equipment_id: equipmentId, channel, state });
        } else {
          for (const channel of this._coilChannels(equipmentId)) {
            out.push({ equipment_id: equipmentId, channel, state });
          }
        }
      } else if (a.type === 'transition' && Array.isArray(a.transitions)) {
        for (const t of a.transitions) {
          if (!t) continue;
          const channel = parseInt(t.channel, 10);
          if (Number.isFinite(channel)) out.push({ equipment_id: equipmentId, channel, state: !!t.state });
        }
      }
    }
    return out;
  }

  /**
   * Compare desired relay states with the cached hardware state in
   * equipment.last_reading.relayStates (written by the 15 s coil poll and by
   * AutomationExecutor on every write).
   *
   * @param {Array} desired  output of _desiredRelayStates
   * @param {Function} [getEquipment]  optional row lookup (for tests)
   * @returns {{ allMatch: boolean, checked: number, unknown: number, mismatched: Array }}
   *   allMatch is true ONLY when every entry has a known cached state that
   *   equals the desired one. Any unknown (no relayStates on the row, e.g. a
   *   write-only board; channel absent; toggle action) → allMatch = false so the
   *   caller keeps the pre-existing rearm behaviour.
   */
  _relayStatesMatch(desired, getEquipment) {
    const lookup = getEquipment || ((id) => db.prepare('SELECT id, last_reading FROM equipment WHERE id = ?').get(id));
    const cache = new Map(); // equipment_id -> relayStates object | null
    const result = { allMatch: desired.length > 0, checked: 0, unknown: 0, mismatched: [] };

    for (const d of desired) {
      if (!cache.has(d.equipment_id)) {
        let states = null;
        try {
          const row = lookup(d.equipment_id);
          if (row && row.last_reading) {
            const parsed = typeof row.last_reading === 'string' ? JSON.parse(row.last_reading) : row.last_reading;
            if (parsed && parsed.relayStates && typeof parsed.relayStates === 'object') states = parsed.relayStates;
          }
        } catch (_) { states = null; }
        cache.set(d.equipment_id, states);
      }
      const states = cache.get(d.equipment_id);
      const actual = states ? states[String(d.channel)] : undefined;

      if (d.state === null || actual === undefined || actual === null) {
        result.unknown++;
        result.allMatch = false;
        continue;
      }
      result.checked++;
      if (!!actual !== d.state) {
        result.allMatch = false;
        result.mismatched.push({ ...d, actual: !!actual });
      }
    }
    return result;
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
            detailSpec: M('watchdog.missed_daily', { time: String(triggerConfig.time), last: this._lastRunSpec(lastRun) }),
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
            detailSpec: M('watchdog.missed_weekly', {
              day: DAY_KEYS[dayOfWeek] ? M(DAY_KEYS[dayOfWeek]) : String(days[dayOfWeek]),
              time: String(triggerConfig.time), last: this._lastRunSpec(lastRun),
            }),
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
            detailSpec: M('watchdog.missed_hourly', { minute: String(minute).padStart(2, '0'), last: this._lastRunSpec(lastRun) }),
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

    // Check how long the threshold has been continuously exceeded by looking
    // at recent readings. If the threshold was just crossed, the scheduler
    // (30s cycle + 60s cooldown) needs time to react — don't alert yet.
    // Only alert if the condition has been met for at least 5 minutes AND
    // the scheduler still hasn't fired.
    const sustainedMinutes = 5;
    const sustainedMs = sustainedMinutes * 60 * 1000;

    try {
      // Find the most recent reading that did NOT meet the threshold
      // (i.e., the last time the condition was false). If it was less than
      // sustainedMs ago, the threshold was freshly crossed — give the
      // scheduler time.
      const compareFn = (op) => {
        switch (op) {
          case 'gt':  return `value <= ${threshold}`;
          case 'gte': return `value < ${threshold}`;
          case 'lt':  return `value >= ${threshold}`;
          case 'lte': return `value > ${threshold}`;
          case 'eq':  return `value != ${threshold}`;
          case 'neq': return `value = ${threshold}`;
          default:    return null;
        }
      };
      const invertedCond = compareFn(operator);
      if (invertedCond) {
        // Look for a reading where the condition was NOT met in the last N minutes
        const lookbackCutoff = new Date(now.getTime() - sustainedMs).toISOString();
        const sensorLike = `%${sensorType.toLowerCase()}%`;
        const lastFalse = db.prepare(`
          SELECT timestamp FROM readings
          WHERE equipment_id = ? AND LOWER(name) LIKE ? AND ${invertedCond}
            AND timestamp > ?
          ORDER BY timestamp DESC LIMIT 1
        `).get(parseInt(triggerConfig.equipment_id), sensorLike, lookbackCutoff);

        if (lastFalse) {
          // Condition was false within the sustained window — freshly crossed
          return { missed: false };
        }
      }
    } catch (err) {
      // If readings check fails, fall through to automation_logs check
    }

    // Also check if the automation has actually fired recently
    try {
      const cutoff = new Date(now.getTime() - sustainedMs).toISOString();
      const recentLog = db.prepare(
        "SELECT id FROM automation_logs WHERE automation_id = ? AND status = 'success' AND triggered_at > ? LIMIT 1"
      ).get(triggerConfig._automation_id, cutoff);
      if (recentLog) return { missed: false };
    } catch { /* fall through */ }

    if (lastRun && (now - lastRun) < sustainedMs) return { missed: false };

    const opSymbols = { gt: '>', gte: '>=', lt: '<', lte: '<=', eq: '==', neq: '!=' };
    return {
      missed: true,
      detail: `Threshold condition met for ${sustainedMinutes}+ minutes (${sensorType}: ${currentValue} ${opSymbols[operator] || operator} ${threshold}${triggerConfig.unit || ''}) but automation hasn't fired.${lastRun ? ` Last run: ${lastRun.toISOString()}` : ' Never run.'}\nEquipment: ${equipment.name}`,
      detailSpec: M('watchdog.threshold_met', {
        minutes: `${sustainedMinutes}`, sensor: `${sensorType}`, value: `${currentValue}`, op: `${opSymbols[operator] || operator}`,
        threshold: `${threshold}`, unit: `${triggerConfig.unit || ''}`, last: this._lastRunSpec(lastRun), equipment: `${equipment.name}`,
      }),
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

  /** "Last run: <iso>" / "Never run." as an i18n spec (English identical to the detail strings). */
  _lastRunSpec(lastRun) {
    return lastRun ? M('watchdog.last_run', { at: lastRun.toISOString() }) : M('watchdog.never_run');
  }

  /** _formatDuration() as an i18n spec: English renders byte-identical ("45s", "12m", "2h 5m", "3d 4h"). */
  _durationSpec(ms) {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return M('watchdog.dur.s', { s: String(seconds) });
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return M('watchdog.dur.m', { m: String(minutes) });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return M('watchdog.dur.hm', { h: String(hours), m: String(minutes % 60) });
    const days = Math.floor(hours / 24);
    return M('watchdog.dur.dh', { d: String(days), h: String(hours % 24) });
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
