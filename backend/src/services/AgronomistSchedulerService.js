/**
 * AgronomistSchedulerService — fires the agronomist's daily report at the
 * configured local time (default 20:00) and runs the weekly Tier-2 rollup
 * + Tier-3 memory refresh after the last daily report of the week.
 *
 * Uses a 1-minute tick like AutomationSchedulerService. Local timezone is
 * honored via the TZ env var (set to Asia/Dubai in docker-compose).
 */

const { agronomistService } = require('./AgronomistService');
const { createAlert } = require('../utils/alertBroadcast');

const PROVIDER_ALERT_FINGERPRINT = 'agronomist_provider_error';

class AgronomistSchedulerService {
  constructor() {
    this.checkIntervalMs = 60_000; // 1 minute
    this.intervalId = null;
    this.startupTimeoutId = null;
    this.running = false;
    this._tickInProgress = false;
    this._lastFiredKey = null; // dedupe within the same minute
    this._pauseLoggedFor = null; // lastFailureAt of the pause window we already logged
  }

  /**
   * Returns true (and logs once per pause window) when scheduled runs should be
   * skipped because the provider keeps rejecting us for billing/auth reasons.
   * The window resets when a new failure lands or the config is re-saved.
   */
  _isPaused(kind) {
    const health = agronomistService.getHealth();
    if (!health.paused) {
      this._pauseLoggedFor = null;
      return false;
    }
    const windowKey = `${health.lastFailureAt}|${health.configUpdatedAt}`;
    if (this._pauseLoggedFor !== windowKey) {
      this._pauseLoggedFor = windowKey;
      console.warn(`[Agronomist] Skipping ${kind} run — ${health.pauseReason}`);
      this._raiseProviderAlert(health);
    }
    return true;
  }

  _raiseProviderAlert(health) {
    if (!health?.lastErrorClass) return;
    const label = { billing: 'Anthropic credit balance exhausted', auth: 'Anthropic API key rejected',
                    rate_limit: 'Anthropic rate limit hit', other: 'Anthropic API error' }[health.lastErrorClass] || 'Anthropic API error';
    createAlert({
      severity: health.paused ? 'critical' : 'warning',
      source: 'agronomist',
      fingerprint: PROVIDER_ALERT_FINGERPRINT,
      message: `[Agronomist] ${label} — ${health.consecutiveFailures} consecutive failed report(s)` +
        (health.paused ? '; scheduled runs paused until settings are saved or Retry now succeeds' : '') +
        `. Last error: ${String(health.lastErrorMessage || '').slice(0, 300)}`,
    });
  }

  start() {
    if (this.running) return;
    this.running = true;
    console.log('[Agronomist] Scheduler started (checks every 60s)');
    this.startupTimeoutId = setTimeout(() => {
      this.startupTimeoutId = null;
      this._safeTick();
      this.intervalId = setInterval(() => this._safeTick(), this.checkIntervalMs);
    }, 10_000);
  }

  stop() {
    if (this.intervalId) clearInterval(this.intervalId);
    if (this.startupTimeoutId) clearTimeout(this.startupTimeoutId);
    this.intervalId = null;
    this.startupTimeoutId = null;
    this.running = false;
    console.log('[Agronomist] Scheduler stopped');
  }

  _safeTick() {
    if (this._tickInProgress) return;
    this._tickInProgress = true;
    this._tick()
      .catch(err => console.error('[Agronomist] Tick error:', err.message))
      .finally(() => { this._tickInProgress = false; });
  }

  async _tick() {
    const cfg = agronomistService.getConfig();
    if (!cfg.enabled) return;
    if (!process.env.ANTHROPIC_API_KEY) {
      // Quietly skip — the user will see the disabled state in the UI.
      return;
    }

    const now = this._nowInLocalTz();
    const minuteKey = `${now.year}-${now.month}-${now.day}-${now.hour}-${now.minute}`;

    // Daily report
    if (now.hour === cfg.schedule_hour && now.minute === cfg.schedule_minute) {
      const dailyKey = `daily:${minuteKey}`;
      if (this._lastFiredKey !== dailyKey) {
        this._lastFiredKey = dailyKey;
        if (this._isPaused('daily')) return;
        const dateStr = `${now.year}-${String(now.month).padStart(2, '0')}-${String(now.day).padStart(2, '0')}`;
        console.log(`[Agronomist] Firing daily report for ${dateStr}`);
        try {
          await agronomistService.generateDailyReport(dateStr, { force: false });
          console.log(`[Agronomist] Daily report for ${dateStr} written`);
        } catch (err) {
          if (err.code === 'ALREADY_EXISTS') {
            console.log(`[Agronomist] Daily report for ${dateStr} already exists, skipping`);
          } else {
            console.error(`[Agronomist] Daily report for ${dateStr} failed:`, err.message);
            // Surface provider problems as one deduped alert (billing/auth/rate_limit).
            const cls = err.errorClass || agronomistService.classifyProviderError(err);
            if (cls !== 'other') this._raiseProviderAlert(agronomistService.getHealth());
          }
        }
      }
    }

    // Weekly rollup (and Tier 3 refresh)
    if (
      now.dayOfWeek === cfg.weekly_rollup_day &&
      now.hour === cfg.weekly_rollup_hour &&
      now.minute === cfg.weekly_rollup_minute
    ) {
      const weeklyKey = `weekly:${minuteKey}`;
      if (this._lastFiredKey !== weeklyKey) {
        this._lastFiredKey = weeklyKey;
        if (this._isPaused('weekly')) return;
        console.log('[Agronomist] Firing weekly rollup');
        try {
          const result = await agronomistService.runWeeklyRollup();
          if (result.skipped) {
            console.log(`[Agronomist] Weekly rollup skipped: ${result.reason}`);
          } else {
            console.log(`[Agronomist] Weekly rollup written for ${result.week_start} → ${result.week_end} (${result.reports} reports)`);
          }
        } catch (err) {
          console.error('[Agronomist] Weekly rollup failed:', err.message);
        }
      }
    }
  }

  /** Get current wall-clock time in the configured TZ (TZ env var). */
  _nowInLocalTz() {
    const tz = process.env.TZ;
    const date = new Date();
    if (tz) {
      // Intl-based extraction so 20:00 means 20:00 in Asia/Dubai regardless of host clock
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', hour12: false,
        weekday: 'short',
      }).formatToParts(date);
      const get = type => parts.find(p => p.type === type)?.value;
      const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      return {
        year: parseInt(get('year'), 10),
        month: parseInt(get('month'), 10),
        day: parseInt(get('day'), 10),
        hour: parseInt(get('hour'), 10) % 24, // some locales render 24 as midnight
        minute: parseInt(get('minute'), 10),
        dayOfWeek: dayMap[get('weekday')],
      };
    }
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      dayOfWeek: date.getDay(),
    };
  }
}

const agronomistSchedulerService = new AgronomistSchedulerService();

module.exports = { agronomistSchedulerService };
