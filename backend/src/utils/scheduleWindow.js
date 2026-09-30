/**
 * scheduleWindow — dated activation for schedule automations (operator request
 * 2026-09-30: the new daily irrigation program starts TOMORROW while today's
 * remaining runs stay exactly as they are).
 *
 * trigger_config.active_from / active_until: local calendar dates 'YYYY-MM-DD'
 * (inclusive), in the same clock the scheduler matches `time` against (the
 * process timezone, TZ=Asia/Dubai in the container). Outside the window a
 * schedule is not due (AutomationSchedulerService) and not "missed"
 * (WatchdogService). Both optional; absent = no limit. Manual Run / Test are not
 * limited (operator-initiated).
 *
 * Pure: no DB.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Local YYYY-MM-DD of `now` in the process timezone (the scheduler's clock). */
function localDate(now) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** @returns {string|null} error message, or null when the window is valid / absent. */
function validateActiveWindow(tc) {
  if (!tc || typeof tc !== 'object') return null;
  const { active_from: from, active_until: until } = tc;
  for (const [k, v] of [['active_from', from], ['active_until', until]]) {
    if (v === undefined || v === null || v === '') continue;
    if (!isRealDate(v)) return `trigger_config.${k} must be a date YYYY-MM-DD`;
  }
  if (from && until && from > until) return 'trigger_config.active_from must not be after active_until';
  return null;
}

/** True when `now` (local date) is inside [active_from, active_until]; absent bounds are open. */
function isWithinActiveWindow(tc, now = new Date()) {
  if (!tc) return true;
  const today = localDate(now);
  if (tc.active_from && isRealDate(tc.active_from) && today < tc.active_from) return false;
  if (tc.active_until && isRealDate(tc.active_until) && today > tc.active_until) return false;
  return true;
}

module.exports = { validateActiveWindow, isWithinActiveWindow, localDate, isRealDate };
