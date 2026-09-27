/**
 * i18next setup: offline, bundled, lazy per namespace.
 *
 * Resources live in src/locales/<lng>/<namespace>.json. Vite turns every file
 * into its own small chunk (import.meta.glob, lazy), so a page only downloads
 * the namespaces it uses, in the active language plus the English fallback.
 * Nothing comes from a CDN: the Pi must work without internet.
 *
 * See docs/i18n-guide.md for the conventions Phase 2 follows.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import {
  DEFAULT_LANGUAGE, PSEUDO, STORAGE_KEY, SUPPORTED, dirOf, normalizeLanguage,
} from './languages';
import { setCurrentLanguage } from './current';

/** Loaded before the first render: the shell must never flash raw keys. */
export const CORE_NAMESPACES = ['common', 'nav', 'shell', 'auth'];

const loaders = import.meta.glob('../locales/*/*.json');
const DEV = !!import.meta.env.DEV;

const lazyBackend = {
  type: 'backend',
  init() {},
  read(lng, ns, callback) {
    const source = lng === PSEUDO ? DEFAULT_LANGUAGE : lng;
    const load = loaders[`../locales/${source}/${ns}.json`];
    if (!load) { callback(null, {}); return; }
    load().then(
      async (mod) => {
        const data = mod.default || mod;
        if (DEV && lng === PSEUDO) {
          const { pseudoResource } = await import('./pseudo');
          callback(null, pseudoResource(data));
          return;
        }
        callback(null, data);
      },
      (err) => callback(err, null),
    );
  },
};

function readStored() {
  try { return normalizeLanguage(localStorage.getItem(STORAGE_KEY)); } catch { return null; }
}

function writeStored(code) {
  try { localStorage.setItem(STORAGE_KEY, code); } catch { /* private mode: session only */ }
}

/**
 * Language for the first paint, before any user is known:
 *   dev ?lng= override -> this device's last language -> browser language if tr/ar -> en.
 * After login the user's server-side preference replaces it (LanguageContext).
 */
export function detectInitialLanguage() {
  if (DEV && typeof window !== 'undefined') {
    const q = new URLSearchParams(window.location.search).get('lng');
    if (q === PSEUDO) return PSEUDO;
    const fromQuery = normalizeLanguage(q);
    if (fromQuery) return fromQuery;
  }
  const stored = readStored();
  if (stored) return stored;
  const browser = typeof navigator !== 'undefined'
    ? (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language])
    : [];
  for (const tag of browser) {
    const code = normalizeLanguage(tag);
    if (code === 'tr' || code === 'ar') return code;
  }
  return DEFAULT_LANGUAGE;
}

/** <html lang dir>: drives RTL layout, :lang() CSS (Turkish İ, Arabic no-tracking) and fonts. */
export function applyDocumentLanguage(code) {
  if (typeof document === 'undefined') return;
  const lang = code === PSEUDO ? DEFAULT_LANGUAGE : code;
  const el = document.documentElement;
  el.setAttribute('lang', lang);
  el.setAttribute('dir', dirOf(lang));
}

function onLanguageChanged(lng) {
  const code = lng === PSEUDO ? PSEUDO : (normalizeLanguage(lng) || DEFAULT_LANGUAGE);
  setCurrentLanguage(code);
  applyDocumentLanguage(code);
  if (code !== PSEUDO) writeStored(code);
}

let initPromise = null;

export function initI18n() {
  if (initPromise) return initPromise;
  const lng = detectInitialLanguage();
  onLanguageChanged(lng);
  i18n.on('languageChanged', onLanguageChanged);
  initPromise = i18n
    .use(lazyBackend)
    .use(initReactI18next)
    .init({
      lng,
      fallbackLng: DEFAULT_LANGUAGE,
      supportedLngs: DEV ? [...SUPPORTED, PSEUDO] : SUPPORTED,
      load: 'languageOnly',
      ns: CORE_NAMESPACES,
      defaultNS: 'common',
      // An empty string in tr/ar means "not translated yet": fall back to English.
      returnEmptyString: false,
      returnNull: false,
      interpolation: { escapeValue: false }, // React escapes
      react: {
        useSuspense: true,
        bindI18n: 'languageChanged loaded',
        transKeepBasicHtmlNodesFor: ['br', 'strong', 'b', 'i', 'em'],
      },
      saveMissing: DEV,
      missingKeyHandler: DEV
        ? (lngs, ns, key) => console.warn(`[i18n] missing key ${ns}:${key} (${lngs.join(',')})`)
        : undefined,
    })
    .catch((err) => {
      // A failed chunk must not blank the app: English keys render as keys,
      // but the UI stays usable.
      console.error('[i18n] init failed', err);
    });
  return initPromise;
}

export default i18n;
