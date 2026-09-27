/**
 * Backend message catalog + renderer (en / tr / ar).
 *
 * Catalogs live in src/i18n/<lang>/<namespace>.json. Keys are flattened with
 * the file name as prefix: en/flow_watch.json { "valve_no_flow": { "fire": "…" } }
 * → key "flow_watch.valve_no_flow.fire". English is canonical and the fallback
 * for any key missing in tr/ar; a key missing everywhere renders as the key.
 *
 * Templates use `{param}` placeholders. A leaf may be a plural object
 * { one, other } (en/tr) or { zero, one, two, few, many, other } (ar), picked
 * by the numeric `count` param.
 *
 * Param values (rendered in the target language):
 *   string / number   → as-is (numbers: Western digits, '.' decimal, ',' thousands)
 *   null / undefined  → ''
 *   { $k, $p }        → a nested catalog message (see M())
 *   { $dur: ms[, units:'hm'] } → localized duration ("2 min 5 s" / "2 dk 5 sn" / "2 د 5 ث"); dur(ms[, 'hm'])
 *   { $list: [...] }  → items rendered and joined with the language's list separator
 *   [a, b, …]         → items rendered, empty ones dropped, joined with ' '
 *
 * Numbers, units and abbreviations (EC, pH, mS/cm, L/h, m³, °C, 1:200, relay /
 * zone numbers) are never translated. Clock times are passed pre-formatted
 * (24 h, Western digits) by the producer, so they are language-neutral.
 *
 * Pure module: no DB, no timers — safe to require anywhere.
 */
const fs = require('fs');
const path = require('path');

const SUPPORTED_LANGS = Object.freeze(['en', 'tr', 'ar']);
const DEFAULT_LANG = 'en';
const PLURAL_FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'];

/** 'tr', 'TR', 'tr-TR', 'ar_AE' → 'tr' / 'ar'; anything else → null. */
function normalizeLang(x) {
  if (typeof x !== 'string') return null;
  const primary = x.trim().toLowerCase().split(/[-_]/)[0];
  return SUPPORTED_LANGS.includes(primary) ? primary : null;
}

function isPluralLeaf(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length > 0 && keys.includes('other') && keys.every(k => PLURAL_FORMS.includes(k));
}

function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (k.startsWith('_')) continue; // "_comment" etc.
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string' || isPluralLeaf(v)) out[key] = v;
    else if (v && typeof v === 'object') flatten(v, key, out);
  }
  return out;
}

let CATALOGS = null;

function loadCatalogs(dir = __dirname) {
  const cats = {};
  for (const lang of SUPPORTED_LANGS) {
    const out = {};
    const langDir = path.join(dir, lang);
    let files = [];
    try { files = fs.readdirSync(langDir).filter(f => f.endsWith('.json')).sort(); } catch (_) { files = []; }
    for (const f of files) {
      const ns = f.replace(/\.json$/, '');
      const json = JSON.parse(fs.readFileSync(path.join(langDir, f), 'utf8'));
      flatten(json, ns, out);
    }
    cats[lang] = out;
  }
  return cats;
}

function catalogs() {
  if (!CATALOGS) CATALOGS = loadCatalogs();
  return CATALOGS;
}

/** Test hook: drop the cache (catalog files edited on disk). */
function reloadCatalogs() { CATALOGS = null; return catalogs(); }

/** CLDR cardinal plural category (integers; enough for counts). */
function pluralCategory(lang, n) {
  const x = Math.abs(Number(n));
  if (!Number.isFinite(x)) return 'other';
  const i = Math.floor(x);
  const isInt = i === x;
  if (lang === 'ar') {
    if (!isInt) return 'other';
    if (i === 0) return 'zero';
    if (i === 1) return 'one';
    if (i === 2) return 'two';
    const m = i % 100;
    if (m >= 3 && m <= 10) return 'few';
    if (m >= 11 && m <= 99) return 'many';
    return 'other';
  }
  // en, tr
  return isInt && i === 1 ? 'one' : 'other';
}

const LIST_SEP = { en: ', ', tr: ', ', ar: '، ' };
const DUR_UNITS = {
  en: { s: 's', min: 'min', h: 'h' },
  tr: { s: 'sn', min: 'dk', h: 'sa' },
  ar: { s: 'ث', min: 'د', h: 'س' },
};

/** Number with Western digits in every language (en-US grouping). */
function formatNumber(lang, x, { dp = null } = {}) {
  if (x === null || x === undefined || x === '' || !Number.isFinite(Number(x))) return '?';
  const n = Number(x);
  const opts = dp === null ? { maximumFractionDigits: 20 } : { minimumFractionDigits: dp, maximumFractionDigits: dp };
  return n.toLocaleString('en-US', { ...opts, numberingSystem: 'latn' });
}

/**
 * Duration. Default style = the flow watch's English fmtDur exactly:
 * < 90 s → "N s", otherwise "M min R s" / "M min" (no hours: "150 min").
 * units: 'hm' → hours + minutes ("2 h 5 min", "45 min", "30 s").
 */
function formatDuration(lang, ms, { units = null } = {}) {
  const u = DUR_UNITS[lang] || DUR_UNITS.en;
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (units === 'hm') {
    if (s < 60) return `${s} ${u.s}`;
    const totalMin = Math.round(s / 60);
    const h = Math.floor(totalMin / 60);
    const mm = totalMin % 60;
    if (!h) return `${mm} ${u.min}`;
    return mm ? `${h} ${u.h} ${mm} ${u.min}` : `${h} ${u.h}`;
  }
  if (s < 90) return `${s} ${u.s}`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} ${u.min} ${r} ${u.s}` : `${m} ${u.min}`;
}

/** HH:MM or HH:MM:SS (24 h, Western digits) of an epoch-ms / Date / ISO in `tz`. */
function formatClock(value, tz, { seconds = false } = {}) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '?';
  const opts = { hour: '2-digit', minute: '2-digit', hour12: false, numberingSystem: 'latn' };
  if (seconds) opts.second = '2-digit';
  try {
    return d.toLocaleTimeString('en-GB', { ...opts, timeZone: tz || undefined });
  } catch (_) {
    return d.toISOString().slice(11, seconds ? 19 : 16);
  }
}

/** Build a nested message descriptor for a param / an alert: M('flow_watch.x', { zone: 4 }). */
function M(key, params) {
  return params === undefined ? { $k: key } : { $k: key, $p: params };
}
const dur = (ms, units) => (units ? { $dur: ms, units } : { $dur: ms });
const list = (items) => ({ $list: items || [] });

function isDescriptor(v) { return !!v && typeof v === 'object' && !Array.isArray(v) && typeof v.$k === 'string'; }

function renderValue(lang, v, depth) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? formatNumber(lang, v) : '?';
  if (typeof v === 'boolean') return String(v);
  if (depth > 12) return '';
  if (Array.isArray(v)) return v.map(x => renderValue(lang, x, depth + 1)).filter(s => s !== '').join(' ');
  if (typeof v === 'object') {
    if (isDescriptor(v)) return t(lang, v.$k, v.$p, depth + 1);
    if (Object.prototype.hasOwnProperty.call(v, '$dur')) return formatDuration(lang, v.$dur, { units: v.units || null });
    if (Object.prototype.hasOwnProperty.call(v, '$list')) {
      return (v.$list || []).map(x => renderValue(lang, x, depth + 1)).filter(s => s !== '').join(LIST_SEP[lang] || LIST_SEP.en);
    }
  }
  return String(v);
}

function lookup(lang, key) {
  const cats = catalogs();
  const L = normalizeLang(lang) || DEFAULT_LANG;
  if (cats[L] && cats[L][key] !== undefined) return { lang: L, entry: cats[L][key] };
  if (cats[DEFAULT_LANG][key] !== undefined) return { lang: DEFAULT_LANG, entry: cats[DEFAULT_LANG][key] };
  return null;
}

/** Does the catalog (English, the fallback) know this key? */
function hasKey(key) { return catalogs()[DEFAULT_LANG][key] !== undefined; }

/**
 * Translate `key` into `lang` with `{param}` interpolation.
 * Falls back to English, then to the key itself.
 */
function t(lang, key, params = {}, depth = 0) {
  const L = normalizeLang(lang) || DEFAULT_LANG;
  const found = lookup(L, key);
  if (!found) return key;
  let tpl = found.entry;
  const p = params || {};
  if (typeof tpl === 'object') {
    const cat = pluralCategory(found.lang, p.count);
    tpl = tpl[cat] ?? tpl.other;
  }
  // Render in the language the template came from (a fallback English template gets English params).
  const renderLang = found.lang;
  return String(tpl)
    .replace(/\{([a-zA-Z0-9_]+)\}/g, (m, name) => (Object.prototype.hasOwnProperty.call(p, name) ? renderValue(renderLang, p[name], depth) : ''))
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Render any message spec: a plain string (returned as-is), a descriptor
 * { $k, $p } / { key, params }, or an array of specs (joined with ' ').
 */
function render(lang, spec) {
  if (spec === null || spec === undefined) return '';
  if (typeof spec === 'string') return spec;
  if (Array.isArray(spec)) return renderValue(normalizeLang(lang) || DEFAULT_LANG, spec, 0);
  if (typeof spec === 'object') {
    if (typeof spec.key === 'string') return t(lang, spec.key, spec.params || {});
    if (isDescriptor(spec)) return t(lang, spec.$k, spec.$p || {});
    return renderValue(normalizeLang(lang) || DEFAULT_LANG, spec, 0); // { $list } / { $dur }
  }
  return String(spec);
}

/** { en, tr, ar } renders of one spec. */
function renderAll(spec) {
  const out = {};
  for (const L of SUPPORTED_LANGS) out[L] = render(L, spec);
  return out;
}

/** Placeholder names used by a catalog entry (all plural forms together). */
function placeholders(entry) {
  const texts = typeof entry === 'string' ? [entry] : Object.values(entry || {});
  const names = new Set();
  for (const s of texts) for (const m of String(s).matchAll(/\{([a-zA-Z0-9_]+)\}/g)) names.add(m[1]);
  return names;
}

/** Every descriptor key referenced inside a params tree (for tests / validation). */
function collectKeys(v, out = new Set()) {
  if (!v || typeof v !== 'object') return out;
  if (Array.isArray(v)) { v.forEach(x => collectKeys(x, out)); return out; }
  if (isDescriptor(v)) { out.add(v.$k); collectKeys(v.$p, out); return out; }
  if (typeof v.key === 'string' && v.params !== undefined) { out.add(v.key); collectKeys(v.params, out); return out; }
  for (const x of Object.values(v)) collectKeys(x, out);
  return out;
}

module.exports = {
  SUPPORTED_LANGS,
  DEFAULT_LANG,
  normalizeLang,
  t,
  render,
  renderAll,
  M,
  dur,
  list,
  hasKey,
  formatNumber,
  formatDuration,
  formatClock,
  pluralCategory,
  catalogs,
  reloadCatalogs,
  loadCatalogs,
  placeholders,
  collectKeys,
  isDescriptor,
};
