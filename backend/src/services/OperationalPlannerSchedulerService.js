/**
 * OperationalPlannerSchedulerService — fires the operational planner daily at
 * the configured local time (default 18:00). At that minute, it generates the
 * plan for TOMORROW (covering 00:00–23:59 local next day).
 *
 * Uses the same 1-minute tick pattern as AgronomistSchedulerService. Timezone
 * is honored via the TZ env var (set to Asia/Dubai in docker-compose).
 */

const { operationalPlannerService } = require('./OperationalPlannerService');

class OperationalPlannerSchedulerService {
  constructor() {
    this.checkIntervalMs = 60_000;
    this.intervalId = null;
    this.startupTimeoutId = null;
    this.running = false;
    this._tickInProgress = false;
    this._lastFiredKey = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    console.log('[OperationalPlanner] Scheduler started (checks every 60s)');
    // Small startup delay so the rest of the backend has a chance to settle.
    this.startupTimeoutId = setTimeout(() => {
      this.startupTimeoutId = null;
      this._safeTick();
      this.intervalId = setInterval(() => this._safeTick(), this.checkIntervalMs);
    }, 15_000);
  }

  stop() {
    if (this.intervalId) clearInterval(this.intervalId);
    if (this.startupTimeoutId) clearTimeout(this.startupTimeoutId);
    this.intervalId = null;
    this.startupTimeoutId = null;
    this.running = false;
    console.log('[OperationalPlanner] Scheduler stopped');
  }

  _safeTick() {
    if (this._tickInProgress) return;
    this._tickInProgress = true;
    this._tick()
      .catch(err => console.error('[OperationalPlanner] Tick error:', err.message))
      .finally(() => { this._tickInProgress = false; });
  }

  async _tick() {
    const cfg = operationalPlannerService.getConfig();
    if (!cfg.enabled) return;
    if (!process.env.ANTHROPIC_API_KEY) return;

    const now = this._nowInLocalTz();
    if (now.hour !== cfg.schedule_hour || now.minute !== cfg.schedule_minute) return;

    const todayStr = `${now.year}-${String(now.month).padStart(2, '0')}-${String(now.day).padStart(2, '0')}`;
    const key = `${todayStr}-${now.hour}-${now.minute}`;
    if (this._lastFiredKey === key) return;
    this._lastFiredKey = key;

    console.log(`[OperationalPlanner] Firing plan generation for day after ${todayStr}`);
    try {
      const plan = await operationalPlannerService.generatePlanForTomorrow(todayStr, { force: false });
      console.log(`[OperationalPlanner] Plan for ${plan.plan_date} written`);
    } catch (err) {
      if (err.code === 'ALREADY_EXISTS') {
        console.log(`[OperationalPlanner] Plan for tomorrow already exists, skipping`);
      } else {
        console.error('[OperationalPlanner] Plan generation failed:', err.message);
      }
    }
  }

  _nowInLocalTz() {
    const tz = process.env.TZ;
    const date = new Date();
    if (tz) {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', hour12: false,
      }).formatToParts(date);
      const get = type => parts.find(p => p.type === type)?.value;
      return {
        year: parseInt(get('year'), 10),
        month: parseInt(get('month'), 10),
        day: parseInt(get('day'), 10),
        hour: parseInt(get('hour'), 10) % 24,
        minute: parseInt(get('minute'), 10),
      };
    }
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
    };
  }
}

const operationalPlannerSchedulerService = new OperationalPlannerSchedulerService();

module.exports = { operationalPlannerSchedulerService, OperationalPlannerSchedulerService };
