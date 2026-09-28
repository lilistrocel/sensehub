/**
 * FertilizerAdvisorSchedulerService — one-minute tick for the crop profile /
 * fertilizer advisor (same pattern as AgronomistSchedulerService):
 *
 *   1. keep crop_assignments.current_stage in step with each active profile's
 *      effective stage (days after transplant / override), so older readers agree;
 *   2. weekly advisor run (default Sunday 19:30 local, before the agronomist
 *      weekly rollup at 20:30);
 *   3. automatic advisor runs on a stage change, a tank mixture / refill change or
 *      a dosing-ratio config change — debounced, at most once per 24 h, never while
 *      a dose cycle is running, never while provider failures pause scheduled runs.
 *
 * Advisory only: the advisor never changes recipes, programs, ratios, tanks or automations.
 */

const { getFertilizerAdvisor } = require('./FertilizerAdvisorService');

class FertilizerAdvisorSchedulerService {
  constructor(deps = {}) {
    this.advisor = deps.advisor || null;
    this.checkIntervalMs = 60_000;
    this.intervalId = null;
    this.startupTimeoutId = null;
    this.running = false;
    this._busy = false;
  }

  _advisor() { return this.advisor || getFertilizerAdvisor(); }

  start() {
    if (this.running) return;
    this.running = true;
    console.log('[FertilizerAdvisor] Scheduler started (checks every 60s)');
    this.startupTimeoutId = setTimeout(() => {
      this.startupTimeoutId = null;
      this.tick();
      this.intervalId = setInterval(() => this.tick(), this.checkIntervalMs);
    }, 30_000);
  }

  stop() {
    if (this.intervalId) clearInterval(this.intervalId);
    if (this.startupTimeoutId) clearTimeout(this.startupTimeoutId);
    this.intervalId = null;
    this.startupTimeoutId = null;
    this.running = false;
  }

  /** One tick (public for tests). Returns { stages_synced, weekly, auto }. */
  tick(nowMs = Date.now()) {
    if (this._busy) return null;
    this._busy = true;
    const out = { stages_synced: 0, weekly: null, auto: null };
    try {
      const a = this._advisor();
      out.stages_synced = a.syncStages(nowMs);
      out.weekly = a.checkWeekly(nowMs);
      if (!out.weekly) out.auto = a.checkAutoTriggers(nowMs);
    } catch (err) {
      console.error('[FertilizerAdvisor] tick error:', err.message);
    } finally {
      this._busy = false;
    }
    return out;
  }
}

const fertilizerAdvisorSchedulerService = new FertilizerAdvisorSchedulerService();

module.exports = { fertilizerAdvisorSchedulerService, FertilizerAdvisorSchedulerService };
