import { toEpochMs } from '../../utils/freshness';
import { formatAgo } from '../../i18n/format';
import { intlLocale } from '../../i18n/languages';
import { getLanguage } from '../../i18n/current';

const JUST_NOW = { en: 'just now', tr: 'az önce', ar: 'الآن' };

const activeLng = (lng) => {
  const l = lng || getLanguage() || 'en';
  return l === 'pseudo' ? 'en' : l;
};

/**
 * Compact relative age for meta lines: "just now", "12 min ago", "3 h ago",
 * "84 days ago" — in the active UI language ("12 dk önce", "قبل 12 د").
 * Accepts anything toEpochMs() understands (SQLite UTC strings included).
 * Returns null when the timestamp is unparseable.
 */
export function timeAgo(ts, now = Date.now(), lng) {
  const ms = toEpochMs(ts);
  if (ms === null) return null;
  const l = activeLng(lng);
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return JUST_NOW[l] || JUST_NOW.en;
  const m = Math.round(s / 60);
  if (m < 60) return formatAgo(m * 60000, { lng: l });
  const h = Math.round(m / 60);
  if (h < 24) return formatAgo(h * 3600000, { lng: l });
  const d = Math.floor(h / 24);
  if (l === 'en') return `${d} day${d === 1 ? '' : 's'} ago`;
  try {
    return new Intl.RelativeTimeFormat(intlLocale(l), { numeric: 'always', style: 'long' }).format(-d, 'day');
  } catch {
    return `${d} day${d === 1 ? '' : 's'} ago`;
  }
}

/** Whole days elapsed since `ts`, or null when unparseable. */
export function daysSince(ts, now = Date.now()) {
  const ms = toEpochMs(ts);
  if (ms === null) return null;
  return Math.floor((now - ms) / 86_400_000);
}
