/**
 * Supported UI languages. Adding a language: add it here, add
 * src/locales/<code>/*.json, and check docs/i18n-guide.md "Adding a language".
 *
 * `intl` is the BCP 47 tag handed to Intl.* formatters. Every tag pins the
 * Latin numbering system (`-u-nu-latn`): the operator decision is that Arabic
 * shows Western digits 0-9 everywhere so readings match the equipment panels.
 */
export const LANGUAGES = [
  { code: 'en', name: 'English', dir: 'ltr', intl: 'en-US-u-nu-latn' },
  { code: 'tr', name: 'Türkçe', dir: 'ltr', intl: 'tr-TR-u-nu-latn' },
  { code: 'ar', name: 'العربية', dir: 'rtl', intl: 'ar-u-nu-latn' },
];

export const DEFAULT_LANGUAGE = 'en';
export const SUPPORTED = LANGUAGES.map((l) => l.code);

/** Dev-only pseudo-locale (?lng=pseudo): English, accented and padded. */
export const PSEUDO = 'pseudo';

/** localStorage key: the language last used on this device (pre-login + API fallback). */
export const STORAGE_KEY = 'sensehub.lang';

export function isSupported(code) {
  return SUPPORTED.includes(code);
}

/** 'ar-AE' -> 'ar', 'TR' -> 'tr', anything else -> null. */
export function normalizeLanguage(code) {
  if (!code || typeof code !== 'string') return null;
  const base = code.trim().toLowerCase().split(/[-_]/)[0];
  return isSupported(base) ? base : null;
}

export function languageInfo(code) {
  return LANGUAGES.find((l) => l.code === code) || LANGUAGES[0];
}

export function dirOf(code) {
  return languageInfo(code).dir;
}

/** Intl locale tag for a UI language (pseudo formats like English). */
export function intlLocale(code) {
  return languageInfo(code === PSEUDO ? DEFAULT_LANGUAGE : code).intl;
}
