/**
 * Parse a SQLite UTC timestamp for display in the user's local timezone.
 *
 * SQLite's datetime('now') stores UTC as "YYYY-MM-DD HH:MM:SS" without a
 * timezone indicator. JavaScript's new Date() parses that format as LOCAL time,
 * causing displayed times to be off by the timezone offset.
 *
 * This helper appends 'Z' so the browser correctly interprets the value as UTC,
 * then toLocaleString() converts it to the user's local time.
 */
export function formatUtcDate(sqliteDateStr) {
  if (!sqliteDateStr) return null;
  const str = sqliteDateStr.endsWith('Z') || sqliteDateStr.includes('+')
    ? sqliteDateStr
    : sqliteDateStr.replace(' ', 'T') + 'Z';
  return new Date(str).toLocaleString();
}
