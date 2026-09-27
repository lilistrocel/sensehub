/**
 * Localized weekday names for the agronomist UI (schedule selects, report
 * date list). Pure helpers: Intl in the UI language with Latin digits
 * (intlLocale pins -u-nu-latn). Computed in UTC so the day never shifts.
 */
import { intlLocale } from '../../i18n/languages';

const cache = new Map();
function weekdayFormat(lng, style) {
  const key = `${lng}|${style}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(intlLocale(lng), { weekday: style, timeZone: 'UTC' });
    cache.set(key, f);
  }
  return f;
}

/** 0 = Sunday … 6 = Saturday (the backend's weekly_rollup_day convention). */
export function weekdayName(dayIndex, lng, style = 'short') {
  const i = Number(dayIndex);
  if (!Number.isInteger(i) || i < 0 || i > 6) return '?';
  // 2023-01-01 was a Sunday.
  return weekdayFormat(lng, style).format(new Date(Date.UTC(2023, 0, 1 + i)));
}

/** Weekday of a YYYY-MM-DD calendar date ('' when unparseable). */
export function dateWeekday(ymd, lng, style = 'short') {
  const [y, m, d] = String(ymd || '').split('-').map(Number);
  if (!y || !m || !d) return '';
  return weekdayFormat(lng, style).format(new Date(Date.UTC(y, m - 1, d)));
}
