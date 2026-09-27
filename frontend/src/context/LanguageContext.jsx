import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from './AuthContext';
import { useToast } from './ToastContext';
import { LANGUAGES, PSEUDO, dirOf, normalizeLanguage } from '../i18n/languages';

/**
 * Per-user UI language.
 *
 * - The preference lives on the server: `language` ('en'|'tr'|'ar') in
 *   GET/PUT /api/users/me/preferences (also accepted on the user object).
 * - After login it replaces the device language. If the user picked a language
 *   on the login page just before signing in, that explicit choice wins and is
 *   written to the server.
 * - `language: null` means the account never chose one (new users): the device
 *   language (this device's last choice, else the browser language, else en)
 *   stays and is written to the account once, on that first sign-in.
 * - Switching is optimistic: the UI changes at once; the PUT follows. If the PUT
 *   fails the choice is kept on this device (localStorage via src/i18n) and the
 *   user is told it was not saved to their account.
 * - Every /api request carries Accept-Language (utils/resilientFetch.js), so
 *   server-generated texts come back in the same language.
 */
const LanguageContext = createContext(null);

const EXPLICIT_KEY = 'sensehub.lang.explicit'; // sessionStorage: chosen on the login page

function readExplicit() {
  try { return normalizeLanguage(sessionStorage.getItem(EXPLICIT_KEY)); } catch { return null; }
}
function writeExplicit(code) {
  try { if (code) sessionStorage.setItem(EXPLICIT_KEY, code); else sessionStorage.removeItem(EXPLICIT_KEY); } catch { /* ignore */ }
}

export function LanguageProvider({ children }) {
  const { i18n, t } = useTranslation('common', { useSuspense: false });
  const { token, user } = useAuth();
  const { showWarning } = useToast();
  const language = i18n.language;
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const saveToServer = useCallback(async (code, { quiet = false } = {}) => {
    const auth = tokenRef.current;
    if (!auth) return 'device';
    try {
      const res = await fetch('/api/users/me/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
        body: JSON.stringify({ language: code }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return 'server';
    } catch (err) {
      console.warn('[i18n] language preference not saved to the account:', err);
      if (!quiet) showWarning(t('language.savedOnDeviceOnly'), t('language.title'));
      return 'device';
    }
  }, [showWarning, t]);

  // After login (or a restored session): apply the user's stored language.
  useEffect(() => {
    if (!token || !user) return undefined;
    let cancelled = false;
    (async () => {
      let serverLang = normalizeLanguage(user.language);
      // null = never chosen; undefined = not in this payload (ask the preferences endpoint)
      let neverSet = user.language === null;
      if (!serverLang && !neverSet) {
        try {
          const res = await fetch('/api/users/me/preferences', { headers: { Authorization: `Bearer ${token}` } });
          if (res.ok) {
            const data = await res.json();
            const raw = data?.language !== undefined ? data.language : data?.preferences?.language;
            serverLang = normalizeLanguage(raw);
            neverSet = raw === null;
          }
        } catch { /* keep the device language */ }
      }
      if (cancelled) return;
      if (i18n.language === PSEUDO) return; // dev pseudo-locale stays put
      const explicit = readExplicit();
      writeExplicit(null);
      if (explicit) {
        if (explicit !== i18n.language) await i18n.changeLanguage(explicit);
        if (explicit !== serverLang) saveToServer(explicit);
      } else if (serverLang) {
        if (serverLang !== i18n.language) await i18n.changeLanguage(serverLang);
      } else if (neverSet) {
        // First sign-in of an account without a language: keep the device language and store it.
        saveToServer(i18n.language, { quiet: true });
      }
    })();
    return () => { cancelled = true; };
    // user.id: once per signed-in user, not on every user-object refresh
  }, [token, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const setLanguage = useCallback(async (next) => {
    const code = normalizeLanguage(next);
    if (!code) return 'invalid';
    if (code !== i18n.language) await i18n.changeLanguage(code);
    if (!tokenRef.current) {
      writeExplicit(code); // login page: carried into the account at sign-in
      return 'device';
    }
    return saveToServer(code);
  }, [i18n, saveToServer]);

  const value = useMemo(() => ({
    language,
    dir: dirOf(language === PSEUDO ? 'en' : language),
    languages: LANGUAGES,
    setLanguage,
  }), [language, setLanguage]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useLanguage must be used within a LanguageProvider');
  return ctx;
}

export default LanguageContext;
