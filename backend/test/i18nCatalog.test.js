/**
 * Catalog consistency (en / tr / ar):
 *  - every key exists in all three languages (no missing / extra keys)
 *  - every translation uses exactly the placeholders of the English entry
 *  - plural entries carry the forms each language needs
 *  - no Eastern-Arabic digits in any catalog (operator decision: Western 0-9)
 *  - every message key referenced by the source (messageKey: '…', M('…'),
 *    i18n.t(lang, '…')) exists in the catalogs
 */
process.env.DB_PATH = process.env.DB_PATH || ':memory:';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const i18n = require('../src/i18n');

const cats = i18n.reloadCatalogs();
const en = cats.en;

test('catalogs: every English key is translated in tr and ar, and no extra keys', () => {
  for (const lang of ['tr', 'ar']) {
    const missing = Object.keys(en).filter(k => cats[lang][k] === undefined);
    const extra = Object.keys(cats[lang]).filter(k => en[k] === undefined);
    assert.deepStrictEqual(missing, [], `${lang} is missing keys`);
    assert.deepStrictEqual(extra, [], `${lang} has keys English does not`);
  }
});

test('catalogs: translations use exactly the English placeholders', () => {
  const bad = [];
  for (const [key, entry] of Object.entries(en)) {
    const want = [...i18n.placeholders(entry)].sort().join(',');
    for (const lang of ['tr', 'ar']) {
      const tr = cats[lang][key];
      if (tr === undefined) continue;
      // each plural form may omit {count} (e.g. Arabic "one"/"two" forms), all others must match
      const forms = typeof tr === 'string' ? [tr] : Object.values(tr);
      const got = [...i18n.placeholders(tr)].sort().join(',');
      if (got !== want) bad.push(`${lang}:${key} has {${got}} vs en {${want}}`);
      for (const f of forms) {
        const names = [...i18n.placeholders(f)];
        const unknown = names.filter(n => !i18n.placeholders(entry).has(n));
        if (unknown.length) bad.push(`${lang}:${key} unknown {${unknown.join(',')}}`);
      }
    }
  }
  assert.deepStrictEqual(bad, []);
});

test('catalogs: plural forms per language', () => {
  const bad = [];
  for (const [lang, need] of [['en', ['one', 'other']], ['tr', ['other']], ['ar', ['zero', 'one', 'two', 'few', 'many', 'other']]]) {
    for (const [key, entry] of Object.entries(cats[lang])) {
      if (typeof entry === 'string') continue;
      for (const f of need) if (typeof entry[f] !== 'string') bad.push(`${lang}:${key} lacks "${f}"`);
    }
  }
  // a key plural in English must be plural (or a plain string) everywhere, never missing
  assert.deepStrictEqual(bad, []);
});

test('catalogs: Western digits only (no Arabic-Indic / Persian digits)', () => {
  const bad = [];
  for (const lang of i18n.SUPPORTED_LANGS) {
    for (const [key, entry] of Object.entries(cats[lang])) {
      const texts = typeof entry === 'string' ? [entry] : Object.values(entry);
      if (texts.some(s => /[٠-٩۰-۹]/.test(s))) bad.push(`${lang}:${key}`);
    }
  }
  assert.deepStrictEqual(bad, []);
});

function listJs(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listJs(p));
    else if (ent.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('source: every referenced message key exists in the catalog', () => {
  const src = path.join(__dirname, '..', 'src');
  const files = listJs(src).filter(f => !f.includes(`${path.sep}i18n${path.sep}index.js`));
  const patterns = [
    /messageKey:\s*'([a-z0-9_]+\.[a-z0-9_.]+)'/g,
    /\bM\(\s*'([a-z0-9_]+\.[a-z0-9_.]+)'/g,
    /\bi18n\.t\(\s*[^,]+,\s*'([a-z0-9_]+\.[a-z0-9_.]+)'/g,
    /\bt\(\s*(?:lang|L|req\.lang|'en'|'tr'|'ar'),\s*'([a-z0-9_]+\.[a-z0-9_.]+)'/g,
  ];
  const missing = [];
  let seen = 0;
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        seen++;
        if (en[m[1]] === undefined) missing.push(`${path.relative(src, f)}: ${m[1]}`);
      }
    }
  }
  assert.ok(seen > 0, 'scanner found no key references');
  assert.deepStrictEqual([...new Set(missing)], []);
});
