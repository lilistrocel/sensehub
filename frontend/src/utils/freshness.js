/**
 * Reading freshness helpers.
 *
 * A reading is "stale" when it is older than `factor` poll intervals. Stale
 * readings must never be shown as numbers - the Reading component renders an
 * em dash with a dashed caution rail and a "not reported since HH:MM" tooltip.
 */

/**
 * Parse a timestamp that may be a Date, epoch ms, ISO string, or a SQLite
 * `datetime('now')` string ("YYYY-MM-DD HH:MM:SS", which is UTC with no zone).
 * @returns {number|null} epoch ms or null when unparseable
 */
export function toEpochMs(ts) {
  if (ts === null || ts === undefined || ts === '') return null;
  if (ts instanceof Date) return Number.isNaN(ts.getTime()) ? null : ts.getTime();
  if (typeof ts === 'number') return Number.isFinite(ts) ? (ts < 1e12 ? ts * 1000 : ts) : null;
  if (typeof ts === 'string') {
    let s = ts.trim();
    // SQLite UTC timestamps carry no zone indicator - append Z so they parse as UTC.
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s)) {
      s = s.replace(' ', 'T') + 'Z';
    }
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/**
 * @param {*} lastTs      last report time (see toEpochMs)
 * @param {number} pollMs poll interval in ms
 * @param {number} factor how many intervals may pass before a reading is stale
 * @param {number} [now]  injectable clock for tests
 */
export function isStale(lastTs, pollMs, factor = 2, now = Date.now()) {
  const ms = toEpochMs(lastTs);
  if (ms === null) return true;
  const interval = Number(pollMs);
  if (!Number.isFinite(interval) || interval <= 0) return false;
  return now - ms > interval * factor;
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * Compact "since" label for tooltips: "14:02" when today, "23 Sep 14:02"
 * otherwise, "unknown" when unparseable. Uses an optional formatter
 * (e.g. SettingsContext.formatTime) so the configured timezone is honoured.
 * @param {*} ts
 * @param {{ now?: number, format?: (date: Date, sameDay: boolean) => string }} [opts]
 */
export function formatSince(ts, opts = {}) {
  const ms = toEpochMs(ts);
  if (ms === null) return 'unknown';
  const d = new Date(ms);
  const now = new Date(opts.now ?? Date.now());
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  if (typeof opts.format === 'function') return opts.format(d, sameDay);
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay) return hhmm;
  const mon = d.toLocaleString('en-GB', { month: 'short' });
  return `${d.getDate()} ${mon} ${hhmm}`;
}
