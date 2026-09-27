/**
 * The active UI language as a plain module value, readable without React and
 * without importing i18next (the fetch wrapper and the pure formatters use it;
 * keeping them free of i18next keeps them unit-testable in plain node).
 * src/i18n/index.js keeps it in sync with i18next.languageChanged.
 */
import { DEFAULT_LANGUAGE, PSEUDO } from './languages';

let current = DEFAULT_LANGUAGE;
const listeners = new Set();

export function getLanguage() {
  return current;
}

/** Language to send to the backend: pseudo is a dev view of English. */
export function getApiLanguage() {
  return current === PSEUDO ? DEFAULT_LANGUAGE : current;
}

export function setCurrentLanguage(code) {
  if (!code || code === current) return;
  current = code;
  listeners.forEach((fn) => { try { fn(code); } catch { /* ignore */ } });
}

export function onLanguage(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
