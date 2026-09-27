import { describe, it, expect, afterEach } from 'vitest';
import {
  formatNumber, formatInt, formatWithUnit, formatPercent, formatDateTime, formatDate, formatTime, formatClock,
  formatRelativeTime, formatDuration, formatCountdown, formatWater, formatSince, formatAgo, toEpochMs, ltr, NBSP, NNBSP,
} from './format';
import { setCurrentLanguage } from './current';

const LRI = '\u2066';
const PDI = '\u2069';
const strip = (s) => s.replace(/[\u2066-\u2069]/g, '');
// Arabic-Indic (U+0660-0669) and Eastern Arabic-Indic (U+06F0-06F9) digits must never appear.
const NON_LATIN_DIGITS = /[٠-٩۰-۹]/;
const T = Date.parse('2026-09-27T10:05:03Z'); // 14:05:03 in Dubai

afterEach(() => setCurrentLanguage('en'));

describe('numbers: "." decimal and Western digits in every language', () => {
  it('keeps "." as the decimal mark (readings match the panels)', () => {
    expect(formatNumber(5.821, { decimals: 2, lng: 'en' })).toBe('5.82');
    expect(formatNumber(5.821, { decimals: 2, lng: 'tr' })).toBe('5.82');
    expect(formatNumber(5.821, { decimals: 2, lng: 'ar' })).toBe('5.82');
  });

  it('groups thousands with "," in en/ar and a narrow no-break space in tr', () => {
    expect(formatInt(8850, { lng: 'en' })).toBe('8,850');
    expect(formatInt(8850, { lng: 'ar' })).toBe('8,850');
    expect(formatInt(8850, { lng: 'tr' })).toBe(`8${NNBSP}850`);
    expect(formatNumber(1234567.891, { decimals: 1, lng: 'tr' })).toBe(`1${NNBSP}234${NNBSP}567.9`);
    expect(formatNumber(8850, { decimals: 0, grouping: false, lng: 'en' })).toBe('8850');
  });

  it('never renders absence as a value', () => {
    for (const v of [null, undefined, '', 'abc', NaN, Infinity, true]) expect(formatNumber(v)).toBe('—');
    expect(formatNumber(null, { fallback: '' })).toBe('');
    expect(formatWithUnit(null, 'L/h')).toBe('—');
  });

  it('uses a real minus sign, drops "-0", and signs on request', () => {
    expect(formatNumber(-2.5, { decimals: 1, lng: 'en' })).toBe('\u22122.5');
    expect(formatNumber(-0.01, { decimals: 1, lng: 'en' })).toBe('0.0');
    expect(formatNumber(12, { signed: true, lng: 'en' })).toBe('+12');
    expect(formatNumber(0, { signed: true, lng: 'en' })).toBe('0');
  });

  it('never produces Arabic-Indic digits', () => {
    const outputs = [
      formatNumber(1234.56, { decimals: 2, lng: 'ar' }),
      formatDateTime(T, { lng: 'ar' }),
      formatRelativeTime(T - 5 * 60000, { now: T, lng: 'ar' }),
      formatDuration(372, { lng: 'ar' }),
      formatAgo(90000, { lng: 'ar' }),
    ];
    outputs.forEach((s) => expect(s).not.toMatch(NON_LATIN_DIGITS));
  });

  it('keeps units untouched and joins them with a no-break space', () => {
    expect(formatWithUnit(12.34, '°C', { decimals: 1, lng: 'en' })).toBe(`12.3${NBSP}°C`);
    expect(formatWithUnit(1.85, 'mS/cm', { decimals: 2, lng: 'tr' })).toBe(`1.85${NBSP}mS/cm`);
    expect(formatPercent(12.46, { decimals: 1, lng: 'en' })).toBe(`12.5${NBSP}%`);
    expect(formatPercent(12, { signed: true, lng: 'tr' })).toBe(`+12${NBSP}%`);
  });

  it('isolates value+unit and signed values in Arabic only (bidi-safe inside RTL text)', () => {
    expect(formatWithUnit(96.19, 'm³', { decimals: 2, lng: 'ar' })).toBe(`${LRI}96.19${NBSP}m³${PDI}`);
    expect(formatPercent(89, { lng: 'ar' })).toBe(`${LRI}89${NBSP}%${PDI}`);
    expect(formatNumber(-3, { lng: 'ar' })).toBe(`${LRI}\u22123${PDI}`);
    expect(formatNumber(3, { lng: 'ar' })).toBe('3'); // plain digits need no isolate
    expect(formatWithUnit(96.19, 'm³', { decimals: 2, lng: 'en' })).toBe(`96.19${NBSP}m³`);
    expect(ltr('1:200')).toBe(`${LRI}1:200${PDI}`);
  });

  it('formats water like the run lists (m³ from 1000 L, 1 dp below 10 L)', () => {
    expect(formatWater(1234, { lng: 'en' })).toBe(`1.23${NBSP}m³`);
    expect(formatWater(850, { lng: 'en' })).toBe(`850${NBSP}L`);
    expect(formatWater(4.25, { lng: 'en' })).toBe(`4.3${NBSP}L`);
    expect(formatWater(null)).toBe('—');
  });

  it('follows the active language when none is passed', () => {
    setCurrentLanguage('tr');
    expect(formatInt(8850)).toBe(`8${NNBSP}850`);
    setCurrentLanguage('pseudo');
    expect(formatInt(8850)).toBe('8,850');
  });
});

describe('dates and times: farm timezone, localized names, Western digits', () => {
  it('parses SQLite UTC timestamps, ISO strings, epoch s and ms', () => {
    expect(toEpochMs('2026-09-27 10:05:03')).toBe(T);
    expect(toEpochMs('2026-09-27T10:05:03Z')).toBe(T);
    expect(toEpochMs(T / 1000)).toBe(T);
    expect(toEpochMs(new Date(T))).toBe(T);
    expect(toEpochMs('garbage')).toBeNull();
  });

  it('keeps the established English output (en-US, 12 h)', () => {
    expect(formatDateTime(T, { timeZone: 'Asia/Dubai', lng: 'en' })).toBe('Sep 27, 2026, 02:05:03 PM');
    expect(formatTime(T, { timeZone: 'Asia/Dubai', lng: 'en' })).toBe('02:05:03 PM');
    expect(formatDate('2026-09-27 10:05:03', { timeZone: 'Asia/Dubai', lng: 'en' })).toBe('Sep 27, 2026');
  });

  it('uses 24 h and localized month names in tr and ar', () => {
    expect(formatDateTime(T, { timeZone: 'Asia/Dubai', lng: 'tr' })).toBe('27 Eyl 2026 14:05:03');
    expect(formatClock(T, { timeZone: 'Asia/Dubai', lng: 'tr' })).toBe('14:05');
    const ar = formatDateTime(T, { timeZone: 'Asia/Dubai', lng: 'ar' });
    expect(ar).toContain('سبتمبر');
    expect(ar).toContain('14:05:03');
    expect(formatClock(T, { timeZone: 'Asia/Dubai', lng: 'ar' })).toBe('14:05');
  });

  it('returns "-" for missing input (legacy SettingsContext contract)', () => {
    expect(formatDateTime(null)).toBe('-');
    expect(formatDateTime('not a date')).toBe('-');
  });

  it('formats relative time with CLDR plural rules', () => {
    const now = T;
    expect(formatRelativeTime(now - 3000, { now, lng: 'en' })).toBe('Just now');
    expect(formatRelativeTime(now - 60000, { now, lng: 'en' })).toBe('1 minute ago');
    expect(formatRelativeTime(now - 5 * 60000, { now, lng: 'en' })).toBe('5 minutes ago');
    expect(formatRelativeTime(now - 5 * 60000, { now, lng: 'tr' })).toBe('5 dakika önce');
    expect(formatRelativeTime(now - 2 * 3600000, { now, lng: 'ar' })).toBe('قبل ساعتين');
    expect(formatRelativeTime(now - 5 * 60000, { now, lng: 'ar' })).toBe('قبل 5 دقائق');
    expect(formatRelativeTime(now - 11 * 60000, { now, lng: 'ar' })).toBe('قبل 11 دقيقة');
    // clock skew: a few seconds in the future is "just now", not a date
    expect(formatRelativeTime(now + 20000, { now, lng: 'en' })).toBe('Just now');
    // older than the threshold: full date-time
    expect(formatRelativeTime(now - 30 * 3600000, { now, timeZone: 'Asia/Dubai', lng: 'en' })).toBe('Sep 26, 2026, 08:05:03 AM');
  });

  it('labels "since" as a clock today and with the day otherwise (farm timezone)', () => {
    expect(formatSince(T - 3600000, { now: T, timeZone: 'Asia/Dubai', lng: 'tr' })).toBe('13:05');
    expect(formatSince(T - 26 * 3600000, { now: T, timeZone: 'Asia/Dubai', lng: 'tr' })).toBe('26 Eyl 12:05');
    expect(formatSince(null, { fallback: 'unknown' })).toBe('unknown');
  });
});

describe('durations', () => {
  it('matches the existing English formats', () => {
    expect(formatDuration(8, { lng: 'en' })).toBe('8 s');
    expect(formatDuration(372, { lng: 'en' })).toBe('6 min 12 s');
    expect(formatDuration(360, { lng: 'en' })).toBe('6 min');
    expect(formatDuration(3900, { lng: 'en' })).toBe('1 h 05 min');
    expect(formatDuration(75, { lng: 'en', compact: true })).toBe('75 s');
    expect(formatDuration(372, { lng: 'en', compact: true })).toBe('6 min 12 s');
    expect(formatDuration(null)).toBe('—');
  });

  it('localizes the unit words', () => {
    expect(formatDuration(372, { lng: 'tr' })).toBe('6 dk 12 sn');
    expect(formatDuration(3900, { lng: 'tr' })).toBe('1 sa 05 dk');
    expect(formatDuration(372, { lng: 'ar' })).toBe('6 د 12 ث');
    expect(strip(formatAgo(4 * 60000, { lng: 'ar' }))).toBe(`قبل 4${NBSP}د`);
    expect(formatAgo(12000, { lng: 'tr' })).toBe(`12${NBSP}sn önce`);
  });

  it('keeps countdowns as digits', () => {
    expect(formatCountdown(65)).toBe('01:05');
    expect(formatCountdown(3725)).toBe('1:02:05');
    expect(formatCountdown(null)).toBeNull();
  });
});
