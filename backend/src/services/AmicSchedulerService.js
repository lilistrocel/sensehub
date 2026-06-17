/**
 * AmicSchedulerService — fires AMIC Calibrate cycles at operator-configured
 * times of day (typically 1–2 slots, e.g. 06:00 and 18:00 local time).
 *
 * Schedule config lives in system_settings.amic_schedule (JSON):
 *   {
 *     enabled: true,
 *     times: [
 *       { hour: 6, minute: 0, enabled: true, label: 'morning', last_fired: '...' },
 *       { hour: 18, minute: 0, enabled: true, label: 'evening', last_fired: null }
 *     ]
 *   }
 *
 * Ticks every 60 s. For each enabled slot whose time has arrived (within the
 * past 5-minute grace window) and that hasn't already fired today, this
 * service:
 *   - Checks that the AMIC is idle (no other cycle running)
 *   - Calls amicService.triggerCalibrate('scheduled')
 *   - Updates last_fired on the slot and persists the schedule
 *   - Inserts an info alert so the operator sees the schedule firing
 *
 * Completion tracking is handled by AmicService's reconciler + cycle history:
 * when the cycle ends, an `amic_cycle_history` row is written with
 * source='scheduled' and the per-channel cal_check / mV-trace diagnostics
 * already in place. The UI reads those to show "last scheduled cal" status.
 */

const { db } = require('../utils/database');
const { broadcastNewAlert } = require('../utils/alertBroadcast');
const { amicService } = require('./AmicService');

const TICK_MS = 60000;             // 60 s
const GRACE_WINDOW_MS = 5 * 60000; // fire if scheduled time was up to 5 min ago

class AmicSchedulerService {
  constructor() {
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this._tick().catch(err => console.error('[AmicScheduler] tick error:', err.message));
    }, TICK_MS);
    console.log('[AmicScheduler] Started (tick every ' + (TICK_MS / 1000) + 's)');
    // Run one tick immediately so the user doesn't wait up to a minute for the first check
    this._tick().catch(() => {});
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Compute the next firing time across all enabled slots, in local time. Used by the UI. */
  nextFiringTime(schedule = null) {
    const sched = schedule || amicService.getSchedule();
    if (!sched.enabled) return null;
    const now = new Date();
    let best = null;
    for (const slot of sched.times || []) {
      if (!slot.enabled) continue;
      // Candidate: today at slot.hour:slot.minute
      let cand = new Date(now);
      cand.setHours(slot.hour, slot.minute, 0, 0);
      // If slot already fired today (last_fired same calendar date), advance to tomorrow
      const firedToday = slot.last_fired && new Date(slot.last_fired).toDateString() === now.toDateString();
      if (cand < now || firedToday) cand.setDate(cand.getDate() + 1);
      if (!best || cand < best) best = cand;
    }
    return best ? best.toISOString() : null;
  }

  async _tick() {
    const schedule = amicService.getSchedule();
    if (!schedule.enabled) return;

    const now = new Date();
    const todayStr = now.toDateString();
    let dirty = false;

    for (const slot of schedule.times || []) {
      if (!slot.enabled) continue;
      // Already fired today?
      if (slot.last_fired && new Date(slot.last_fired).toDateString() === todayStr) continue;

      // Compute "should have fired by now" — within the last 5 minutes of slot time
      const slotTime = new Date(now);
      slotTime.setHours(slot.hour, slot.minute, 0, 0);
      const ageMs = now.getTime() - slotTime.getTime();
      if (ageMs < 0) continue;                  // not yet
      if (ageMs > GRACE_WINDOW_MS) continue;    // missed the window — skip until tomorrow

      // Is AMIC busy? Check the persisted current_cycle (cheap, no Modbus call)
      const current = amicService._getCurrentCycle();
      if (current) {
        console.log(`[AmicScheduler] AMIC busy (${current.state}), skipping ${slot.hour}:${String(slot.minute).padStart(2,'0')} this minute, will retry next tick`);
        continue;
      }

      // Fire!
      const label = slot.label ? ` (${slot.label})` : '';
      console.log(`[AmicScheduler] Firing scheduled Calibrate ${slot.hour}:${String(slot.minute).padStart(2,'0')}${label}`);
      try {
        await amicService.triggerCalibrate('scheduled');
        slot.last_fired = now.toISOString();
        dirty = true;
        try {
          broadcastNewAlert(db.prepare("INSERT INTO alerts (severity, message, created_at) VALUES (?, ?, datetime('now'))")
            .run('info', `[AMIC] Scheduled Calibration triggered at ${slot.hour}:${String(slot.minute).padStart(2,'0')}${label}`));
        } catch {}
      } catch (err) {
        console.error('[AmicScheduler] Failed to trigger Calibrate:', err.message);
        try {
          broadcastNewAlert(db.prepare("INSERT INTO alerts (severity, message, created_at) VALUES (?, ?, datetime('now'))")
            .run('warning', `[AMIC] Scheduled Calibration FAILED to trigger at ${slot.hour}:${String(slot.minute).padStart(2,'0')}: ${err.message}`));
        } catch {}
      }
    }

    if (dirty) {
      try { amicService.saveSchedule(schedule); } catch (err) {
        console.error('[AmicScheduler] saveSchedule failed:', err.message);
      }
    }
  }
}

const amicSchedulerService = new AmicSchedulerService();

module.exports = { amicSchedulerService, AmicSchedulerService };
