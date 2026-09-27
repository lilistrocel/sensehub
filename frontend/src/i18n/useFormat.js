import { useContext, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import SettingsContext from '../context/SettingsContext';
import * as F from './format';

/**
 * Formatters bound to the active language and the configured farm timezone.
 *
 *   const fmt = useFormat();
 *   fmt.number(6.2, { decimals: 1 })   fmt.withUnit(8850, 'L/h', { decimals: 0 })
 *   fmt.dateTime(ts)  fmt.time(ts)  fmt.clock(ts)  fmt.date(ts)  fmt.relative(ts)  fmt.since(ts)
 *   fmt.duration(372) fmt.percent(12.5, { decimals: 1, signed: true })
 *
 * Components re-render on language change (useTranslation subscribes).
 */
export function useFormat() {
  const { i18n } = useTranslation();
  // Tolerant of a missing SettingsProvider (login page, tests): farm timezone.
  const settings = useContext(SettingsContext);
  const lng = i18n.language;
  const timeZone = settings?.timezone || F.FARM_TZ;
  return useMemo(() => ({
    lng,
    timeZone,
    number: (v, o = {}) => F.formatNumber(v, { lng, ...o }),
    int: (v, o = {}) => F.formatInt(v, { lng, ...o }),
    withUnit: (v, unit, o = {}) => F.formatWithUnit(v, unit, { lng, ...o }),
    percent: (v, o = {}) => F.formatPercent(v, { lng, ...o }),
    water: (l) => F.formatWater(l, { lng }),
    dateTime: (v, o = {}) => F.formatDateTime(v, { lng, timeZone, ...o }),
    date: (v, o = {}) => F.formatDate(v, { lng, timeZone, ...o }),
    time: (v, o = {}) => F.formatTime(v, { lng, timeZone, ...o }),
    clock: (v, o = {}) => F.formatClock(v, { lng, timeZone, ...o }),
    dayMonth: (v, o = {}) => F.formatDayMonth(v, { lng, timeZone, ...o }),
    relative: (v, o = {}) => F.formatRelativeTime(v, { lng, timeZone, ...o }),
    since: (v, o = {}) => F.formatSince(v, { lng, timeZone, ...o }),
    ago: (ms) => F.formatAgo(ms, { lng }),
    duration: (s, o = {}) => F.formatDuration(s, { lng, ...o }),
    countdown: F.formatCountdown,
  }), [lng, timeZone]);
}

export default useFormat;
