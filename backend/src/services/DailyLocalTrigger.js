/**
 * DailyLocalTrigger — fires a callback once per local calendar day at (or
 * shortly after) HH:MM in a named IANA timezone. Clock is injectable so the
 * "exactly once per day" behaviour is unit-testable.
 *
 *   const t = new DailyLocalTrigger({ hour: 12, minute: 0, tz: 'Asia/Dubai', graceMinutes: 60, onFire });
 *   setInterval(() => t.tick(), 60_000);
 *
 * Semantics of tick(now):
 *   - fires when local time >= HH:MM and < HH:MM + graceMinutes
 *   - at most once per local date (dedupes by YYYY-MM-DD in tz)
 *   - a restart at 12:20 still fires (inside the grace window); at 14:00 it does not
 */

function localParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'UTC',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = t => parts.find(p => p.type === t)?.value;
  return {
    dateStr: `${get('year')}-${get('month')}-${get('day')}`,
    hour: parseInt(get('hour'), 10) % 24,
    minute: parseInt(get('minute'), 10),
  };
}

class DailyLocalTrigger {
  constructor({ hour = 12, minute = 0, tz = null, graceMinutes = 60, onFire, now = () => new Date() } = {}) {
    if (typeof onFire !== 'function') throw new Error('onFire callback required');
    this.hour = hour;
    this.minute = minute;
    this.tz = typeof tz === 'function' ? tz : () => tz;
    this.graceMinutes = graceMinutes;
    this.onFire = onFire;
    this.now = now;
    this.lastFiredDate = null;
    this._inFlight = false;
  }

  /** Returns the fired dateStr, or null. */
  tick() {
    if (this._inFlight) return null;
    const tz = this.tz() || 'UTC';
    const { dateStr, hour, minute } = localParts(this.now(), tz);
    const minuteOfDay = hour * 60 + minute;
    const target = this.hour * 60 + this.minute;
    if (minuteOfDay < target || minuteOfDay >= target + this.graceMinutes) return null;
    if (this.lastFiredDate === dateStr) return null;
    this.lastFiredDate = dateStr;
    this._inFlight = true;
    Promise.resolve()
      .then(() => this.onFire({ dateStr, tz }))
      .catch(() => {})
      .finally(() => { this._inFlight = false; });
    return dateStr;
  }

  /** Tell the trigger that a run for dateStr already happened (e.g. found in DB on boot). */
  markFired(dateStr) { this.lastFiredDate = dateStr; }
}

module.exports = { DailyLocalTrigger, localParts };
