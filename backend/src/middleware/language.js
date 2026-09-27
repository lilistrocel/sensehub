/**
 * Request language (en / tr / ar) → req.lang.
 *
 * Resolution order:
 *   1. ?lang=xx query param (links / downloads that cannot set headers)
 *   2. an explicit Accept-Language header set by the SenseHub frontend: a
 *      single tag (`tr`, `ar-AE`) whose primary subtag is en/tr/ar
 *   3. the signed-in user's saved preference (user_preferences.language)
 *   4. 'en'
 *
 * A browser-generated list ("tr-TR,tr;q=0.9,en;q=0.8") is NOT treated as an
 * explicit choice — every browser sends one on every request, and it must not
 * override the language the user picked in SenseHub. The frontend always sends
 * a single tag, so its header wins over the stored preference.
 *
 * `languageMiddleware` runs before auth (header / query only); authMiddleware
 * calls `applyUserLanguage(req, pref)` once the user is known.
 */
const { normalizeLang, DEFAULT_LANG } = require('../i18n');

/** Explicit language from the query / a single-tag Accept-Language header, else null. */
function explicitLanguage({ query, acceptLanguage } = {}) {
  const q = normalizeLang(typeof query === 'string' ? query : '');
  if (q) return q;
  if (typeof acceptLanguage !== 'string') return null;
  const h = acceptLanguage.trim();
  if (!h || h.includes(',') || h.includes(';') || h === '*') return null;
  return normalizeLang(h);
}

/** Pure resolver (tests): explicit → user preference → 'en'. */
function resolveLanguage({ query, acceptLanguage, userPreference } = {}) {
  return explicitLanguage({ query, acceptLanguage }) || normalizeLang(userPreference || '') || DEFAULT_LANG;
}

function languageMiddleware(req, res, next) {
  const explicit = explicitLanguage({ query: req.query && req.query.lang, acceptLanguage: req.headers['accept-language'] });
  req.lang = explicit || DEFAULT_LANG;
  req.langSource = explicit ? 'request' : 'default';
  next();
}

/** Apply the stored user preference when the request did not choose explicitly. */
function applyUserLanguage(req, userPreference) {
  if (req.langSource === undefined) {
    // languageMiddleware not mounted (a router used on its own): detect the explicit choice here.
    const explicit = explicitLanguage({ query: req.query && req.query.lang, acceptLanguage: req.headers && req.headers['accept-language'] });
    if (explicit) { req.lang = explicit; req.langSource = 'request'; return req.lang; }
  }
  if (req.langSource === 'request') return req.lang;
  const pref = normalizeLang(userPreference || '');
  if (pref) { req.lang = pref; req.langSource = 'user'; }
  else if (!req.lang) { req.lang = DEFAULT_LANG; req.langSource = 'default'; }
  return req.lang;
}

module.exports = { languageMiddleware, applyUserLanguage, resolveLanguage, explicitLanguage };
