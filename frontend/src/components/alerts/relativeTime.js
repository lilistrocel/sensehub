import { toEpochMs } from '../../utils/freshness';

/**
 * Compact relative age for meta lines: "just now", "12 min ago", "3 h ago",
 * "84 days ago". Accepts anything toEpochMs() understands (SQLite UTC strings
 * included). Returns null when the timestamp is unparseable.
 */
export function timeAgo(ts, now = Date.now()) {
  const ms = toEpochMs(ts);
  if (ms === null) return null;
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/** Whole days elapsed since `ts`, or null when unparseable. */
export function daysSince(ts, now = Date.now()) {
  const ms = toEpochMs(ts);
  if (ms === null) return null;
  return Math.floor((now - ms) / 86_400_000);
}
