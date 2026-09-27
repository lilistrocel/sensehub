/**
 * Locale-aware formatting for SenseHub. Pure functions (no React, no i18next)
 * so they are unit-tested in plain node; every function takes an optional
 * `lng` and otherwise uses the active UI language (src/i18n/current.js).
 *
 * Decisions (see docs/i18n-guide.md "Numbers, dates, units"):
 *  - Digits are Western 0-9 in every language (Arabic included): readings must
 *    match the equipment panels. All Intl calls pin `-u-nu-latn`.
 *  - The decimal separator is '.' in every language, for readings AND for any
 *    other number: the SEKO, the flow meter and the Priva panels all show
 *    "5.82", and one reading must never look different on a phone and on the
 *    panel beside it. Turkish normally writes "5,82".
 *  - Thousands grouping: ',' in en and ar (ar with Latin digits groups with
 *    ',' natively), a narrow no-break space in tr - with '.' as the decimal
 *    mark a Turkish reader would take "8,850" (or "8.850") for a decimal.
 *  - Dates/times are in the farm timezone (FARM_TZ unless the caller passes
 *    the configured one). Month/day names are localized; English keeps its
 *    existing en-US 12-hour output, tr and ar use 24 h like the device clock.
 *  - Units and technical abbreviations are never translated (formatWithUnit).
 */
import { getLanguage } from './current';
import { DEFAULT_LANGUAGE, PSEUDO, dirOf, intlLocale } from './languages';

export const FARM_TZ = 'Asia/Dubai';
export const DASH = '—';

/** Narrow no-break space: the Turkish thousands separator. */
export const NNBSP = '\u202F';
/** No-break space between a value and its unit (never wraps "12.5 / °C"). */
export const NBSP = '\u00A0';
/** Left-to-right isolate: keep "+12 %", "1:200", "08:30-09:10" intact inside RTL text. */
const LRI = '\u2066';
const PDI = '\u2069';

const lang = (lng) => {
  const l = lng || getLanguage() || DEFAULT_LANGUAGE;
  return l === PSEUDO ? DEFAULT_LANGUAGE : l;
};

const GROUP_SEPARATOR = { en: ',', ar: ',', tr: NNBSP };

/**
 * In a right-to-left language, wrap a left-to-right value ("89 %", "96.19 m³",
 * "−2.5", "+12 %") in a bidi isolate so it renders exactly as on the panel
 * inside Arabic sentences (otherwise the unit / sign jumps to the other side).
 * No-op in LTR languages, so English and Turkish strings are unchanged.
 */
function isolateForRtl(s, l) {
  return dirOf(l) === 'rtl' ? `${LRI}${s}${PDI}` : s;
}

const numberFormatCache = new Map();
function numberFormat(min, max, grouping) {
  const key = `${min}|${max}|${grouping}`;
  let f = numberFormatCache.get(key);
  if (!f) {
    // Always the en-US engine: '.' decimal and Latin digits, then swap the
    // grouping mark per language. Deterministic across browsers.
    f = new Intl.NumberFormat('en-US', { minimumFractionDigits: min, maximumFractionDigits: max, useGrouping: grouping });
    numberFormatCache.set(key, f);
  }
  return f;
}

export function toNumber(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Number with a fixed or bounded number of decimals.
 *   formatNumber(8850.456, { decimals: 1 })      -> "8,850.5" (en/ar) | "8 850.5" (tr)
 *   formatNumber(5.8, { minDecimals: 0, maxDecimals: 2 }) -> "5.8"
 * Returns `fallback` ('—') for null / NaN / non-numeric input: never render
 * absence as a value (FARM-APP-STANDARDS 4.1).
 */
export function formatNumber(value, {
  decimals, minDecimals, maxDecimals, grouping = true, signed = false, fallback = DASH, lng,
} = {}) {
  const n = toNumber(value);
  if (n === null) return fallback;
  const min = decimals ?? minDecimals ?? 0;
  const max = Math.max(min, decimals ?? maxDecimals ?? (minDecimals ?? 3));
  let s = numberFormat(min, max, grouping).format(Math.abs(n));
  const sep = GROUP_SEPARATOR[lang(lng)] ?? ',';
  if (grouping && sep !== ',') s = s.replace(/,/g, sep);
  // Negative with a real minus sign; "-0.0" collapses to "0.0".
  const isZero = Number(s.replace(/[^\d.]/g, '')) === 0;
  if (n < 0 && !isZero) s = isolateForRtl(`\u2212${s}`, lang(lng));
  else if (signed && n > 0 && !isZero) s = isolateForRtl(`+${s}`, lang(lng));
  return s;
}

export function formatInt(value, opts = {}) {
  return formatNumber(value, { ...opts, decimals: 0 });
}

/** Value + unit, unit untouched: "12.5 °C", "8,850 L/h", "1.85 mS/cm". */
export function formatWithUnit(value, unit, opts = {}) {
  const s = formatNumber(value, opts);
  if (s === (opts.fallback ?? DASH) || !unit) return s;
  return isolateForRtl(`${stripIsolates(s)}${NBSP}${unit}`, lang(opts.lng));
}

const stripIsolates = (s) => String(s).replace(/[\u2066-\u2069]/g, '');

/** "12 %" / "+12.5 %" (the app writes a space before %, like the devices). */
export function formatPercent(value, { decimals = 0, signed = false, lng, fallback = DASH } = {}) {
  const s = formatNumber(value, { decimals, signed, lng, fallback });
  return s === fallback ? s : isolateForRtl(`${stripIsolates(s)}${NBSP}%`, lang(lng));
}

/** Wrap a left-to-right fragment so it survives inside RTL text (plain strings only). */
export function ltr(text) {
  return `${LRI}${text}${PDI}`;
}

// ---------------------------------------------------------------------------
// Dates and times
// ---------------------------------------------------------------------------

/**
 * Parse Date | epoch ms | epoch s | ISO string | SQLite "YYYY-MM-DD HH:MM:SS"
 * (UTC without a zone designator). Returns epoch ms or null.
 */
export function toEpochMs(ts) {
  if (ts === null || ts === undefined || ts === '') return null;
  if (ts instanceof Date) return Number.isNaN(ts.getTime()) ? null : ts.getTime();
  if (typeof ts === 'number') return Number.isFinite(ts) ? (ts < 1e12 ? ts * 1000 : ts) : null;
  if (typeof ts === 'string') {
    let s = ts.trim();
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s)) s = `${s.replace(' ', 'T')}Z`;
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

const dtfCache = new Map();
function dateTimeFormat(lng, options) {
  const key = `${lng}|${JSON.stringify(options)}`;
  let f = dtfCache.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(intlLocale(lng), options);
    } catch {
      // Unknown IANA zone (bad setting): fall back to the farm zone.
      f = new Intl.DateTimeFormat(intlLocale(lng), { ...options, timeZone: FARM_TZ });
    }
    dtfCache.set(key, f);
  }
  return f;
}

function cleanOptions(options, l) {
  const o = {};
  Object.keys(options).forEach((k) => { if (options[k] !== undefined) o[k] = options[k]; });
  // tr and ar: 24 h clock like the device clock and the panels. English keeps
  // its established en-US output.
  if (l !== 'en' && (o.hour || o.timeStyle) && !o.hourCycle && o.hour12 === undefined) o.hourCycle = 'h23';
  return o;
}

/**
 * Full date + time (the SettingsContext.formatDateTime contract): options are
 * Intl.DateTimeFormat options merged over the defaults; pass a field as
 * `undefined` to drop it. Returns '-' for missing / invalid input (legacy).
 */
export function formatDateTime(value, { timeZone = FARM_TZ, lng, fallback = '-', ...options } = {}) {
  const ms = toEpochMs(value);
  if (ms === null) return fallback;
  const l = lang(lng);
  const opts = cleanOptions({
    timeZone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    ...options,
  }, l);
  // en-US 2-digit hours at midnight can read "24"; normalise.
  return dateTimeFormat(l, opts).format(new Date(ms)).replace(/\b24:(\d{2})/, '00:$1');
}

export function formatDate(value, opts = {}) {
  return formatDateTime(value, { ...opts, hour: undefined, minute: undefined, second: undefined });
}

/** Time with seconds ("14:05:03" | "02:05:03 PM"). */
export function formatTime(value, opts = {}) {
  return formatDateTime(value, { ...opts, year: undefined, month: undefined, day: undefined });
}

/** Clock without seconds ("14:05" | "02:05 PM"). */
export function formatClock(value, opts = {}) {
  return formatDateTime(value, { ...opts, year: undefined, month: undefined, day: undefined, second: undefined });
}

/** "27 Sep" style short day, localized month name. */
export function formatDayMonth(value, opts = {}) {
  return formatDateTime(value, { ...opts, year: undefined, hour: undefined, minute: undefined, second: undefined });
}

/** Calendar day key (YYYY-MM-DD) of an instant in a timezone. */
function dayKey(ms, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/**
 * Compact "since" label for stale readings: "14:02" today, "23 Sep 14:02"
 * otherwise (localized month), in the farm timezone. `fallback` when unparseable.
 */
export function formatSince(value, { now = Date.now(), timeZone = FARM_TZ, lng, fallback = null } = {}) {
  const ms = toEpochMs(value);
  if (ms === null) return fallback;
  const clock = formatClock(ms, { timeZone, lng });
  if (dayKey(ms, timeZone) === dayKey(now, timeZone)) return clock;
  return `${formatDayMonth(ms, { timeZone, lng })} ${clock}`;
}

const rtfCache = new Map();
function relativeTimeFormat(lng) {
  let f = rtfCache.get(lng);
  if (!f) {
    f = new Intl.RelativeTimeFormat(intlLocale(lng), { numeric: 'always', style: 'long' });
    rtfCache.set(lng, f);
  }
  return f;
}

const JUST_NOW = { en: 'Just now', tr: 'Az önce', ar: 'الآن' };

/**
 * "5 minutes ago" / "5 dakika önce" / "قبل 5 دقائق" for anything younger than
 * `thresholdHours`, otherwise the full date-time. Plural rules (Arabic
 * zero/one/two/few/many/other included) come from the browser's CLDR data.
 */
export function formatRelativeTime(value, { now = Date.now(), thresholdHours = 24, timeZone = FARM_TZ, lng } = {}) {
  const ms = toEpochMs(value);
  if (ms === null) return '-';
  const l = lang(lng);
  const diffS = Math.floor((now - ms) / 1000);
  // A few minutes "in the future" is clock skew between Pi and phone: just now.
  if (diffS < -300 || diffS / 3600 >= thresholdHours) return formatDateTime(ms, { timeZone, lng: l });
  if (diffS <= 5) return JUST_NOW[l] || JUST_NOW.en;
  const rtf = relativeTimeFormat(l);
  if (diffS < 60) return rtf.format(-diffS, 'second');
  const m = Math.floor(diffS / 60);
  if (m < 60) return rtf.format(-m, 'minute');
  const h = Math.floor(m / 60);
  if (h < 24) return rtf.format(-h, 'hour');
  return rtf.format(-Math.floor(h / 24), 'day');
}

/** Short "age" for freshness pills: "12 s ago", "4 min ago", "3 h ago" (localized). */
export function formatAgo(ageMs, { lng } = {}) {
  const n = toNumber(ageMs);
  if (n === null || n < 0) return null;
  const l = lang(lng);
  const u = DURATION_UNITS[l] || DURATION_UNITS.en;
  const s = Math.round(n / 1000);
  let v;
  if (s < 60) v = `${s}${NBSP}${u.s}`;
  else if (s < 3600) v = `${Math.round(s / 60)}${NBSP}${u.min}`;
  else v = `${Math.round(s / 3600)}${NBSP}${u.h}`;
  return (AGO[l] || AGO.en).replace('{v}', v);
}
const AGO = { en: '{v} ago', tr: '{v} önce', ar: 'قبل {v}' };

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

/**
 * Duration unit abbreviations. These are human words, not SI units, so they
 * ARE localized (glossary: docs/i18n-glossary.md). Machine-translated for
 * tr/ar: listed in docs/i18n-review.md.
 */
export const DURATION_UNITS = {
  en: { h: 'h', min: 'min', s: 's' },
  tr: { h: 'sa', min: 'dk', s: 'sn' },
  ar: { h: 'س', min: 'د', s: 'ث' },
};

/**
 * Seconds as a readable duration.
 *   default:          8 -> "8 s", 372 -> "6 min 12 s" (seconds padded), 3900 -> "1 h 05 min"
 *   compact: true     (irrigation run lists) < 90 s -> "75 s", else "6 min 12 s" / "6 min"
 */
export function formatDuration(seconds, { lng, compact = false, fallback = DASH } = {}) {
  const n = toNumber(seconds);
  if (n === null) return fallback;
  const u = DURATION_UNITS[lang(lng)] || DURATION_UNITS.en;
  const t = Math.max(0, Math.round(n));
  const sp = ' ';
  if (compact) {
    if (t < 90) return `${t}${sp}${u.s}`;
    const m = Math.floor(t / 60);
    const r = t % 60;
    if (m >= 60) {
      const h = Math.floor(m / 60);
      return `${h}${sp}${u.h} ${String(m % 60).padStart(2, '0')}${sp}${u.min}`;
    }
    return r ? `${m}${sp}${u.min} ${r}${sp}${u.s}` : `${m}${sp}${u.min}`;
  }
  if (t < 60) return `${t}${sp}${u.s}`;
  if (t < 3600) {
    const m = Math.floor(t / 60);
    const r = t % 60;
    return r ? `${m}${sp}${u.min} ${String(r).padStart(2, '0')}${sp}${u.s}` : `${m}${sp}${u.min}`;
  }
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  return `${h}${sp}${u.h} ${String(m).padStart(2, '0')}${sp}${u.min}`;
}

/** Countdown "MM:SS" / "H:MM:SS" - digits only, identical in every language. */
export function formatCountdown(totalSeconds) {
  const n = toNumber(totalSeconds);
  if (n === null) return null;
  const secs = Math.max(0, Math.floor(n));
  const hours = Math.floor(secs / 3600);
  const minutes = Math.floor((secs % 3600) / 60);
  const pad = (x) => String(x).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs % 60)}` : `${pad(minutes)}:${pad(secs % 60)}`;
}

/** Water volume: >= 1000 L as m³ (2 dp), < 10 L with 1 dp, else whole litres. */
export function formatWater(liters, { lng } = {}) {
  const v = toNumber(liters);
  if (v === null) return DASH;
  if (v >= 1000) return formatWithUnit(v / 1000, 'm³', { decimals: 2, lng });
  return formatWithUnit(v, 'L', { decimals: v < 10 ? 1 : 0, lng });
}
