import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import i18next from 'i18next';
import { normalizeLanguage, dirOf, intlLocale } from './languages';
import { pseudoString } from './pseudo';

// Real locale files, loaded synchronously (no React, no lazy backend).
const LOCALES = path.resolve(__dirname, '../locales');
const resources = {};
for (const lng of fs.readdirSync(LOCALES)) {
  resources[lng] = {};
  for (const f of fs.readdirSync(path.join(LOCALES, lng))) {
    resources[lng][f.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(LOCALES, lng, f), 'utf8'));
  }
}

let i18n;
beforeAll(async () => {
  i18n = i18next.createInstance();
  await i18n.init({ resources, lng: 'en', fallbackLng: 'en', defaultNS: 'common', returnEmptyString: false, interpolation: { escapeValue: false } });
});

const t = (lng, key, opts) => i18n.getFixedT(lng)(key, opts);

describe('plural rules', () => {
  it('English: one / other', () => {
    expect(t('en', 'shell:count.channel', { count: 1 })).toBe('1 channel');
    expect(t('en', 'shell:count.channel', { count: 0 })).toBe('0 channels');
    expect(t('en', 'shell:count.channel', { count: 7 })).toBe('7 channels');
  });

  it('Turkish: one / other, noun stays singular after a number', () => {
    expect(t('tr', 'shell:count.channel', { count: 1 })).toBe('1 kanal');
    expect(t('tr', 'shell:count.channel', { count: 7 })).toBe('7 kanal');
    expect(t('tr', 'shell:durations.minutes', { count: 15 })).toBe('15 dakika');
  });

  it('Arabic: zero / one / two / few / many / other', () => {
    const got = [0, 1, 2, 3, 10, 11, 99, 100, 102].map((n) => t('ar', 'shell:count.channel', { count: n }));
    expect(got).toEqual([
      '0 قناة',        // zero
      'قناة واحدة',    // one
      'قناتان',        // two
      '3 قنوات',       // few (3-10)
      '10 قنوات',
      '11 قناة',       // many (11-99)
      '99 قناة',
      '100 قناة',      // other
      '102 قناة',
    ]);
    expect(t('ar', 'shell:durations.minutes', { count: 2 })).toBe('دقيقتان');
    expect(t('ar', 'shell:durations.hours', { count: 1 })).toBe('ساعة واحدة');
  });

  it('every Arabic plural key has all six CLDR forms and every Turkish one has one/other', () => {
    const cats = { ar: new Intl.PluralRules('ar').resolvedOptions().pluralCategories, tr: new Intl.PluralRules('tr').resolvedOptions().pluralCategories };
    expect(cats.ar.sort()).toEqual(['few', 'many', 'one', 'other', 'two', 'zero']);
    const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${p}${k}.`) : [`${p}${k}`]));
    for (const ns of Object.keys(resources.en)) {
      const bases = new Set(flat(resources.en[ns]).filter((k) => /_(one|other)$/.test(k)).map((k) => k.replace(/_(one|other)$/, '')));
      for (const lng of ['ar', 'tr']) {
        const keys = new Set(flat(resources[lng][ns] || {}));
        for (const b of bases) for (const c of cats[lng]) expect(keys.has(`${b}_${c}`), `${lng} ${ns}:${b}_${c}`).toBe(true);
      }
    }
  });
});

describe('interpolation and fallback', () => {
  it('interpolates without HTML escaping (React escapes)', () => {
    expect(t('en', 'shell:stop.result.incompleteTitle', { label: 'Stop all' })).toBe('Stop all INCOMPLETE');
    expect(t('tr', 'common:interlock.withPartner', { partner: 'Shade <Close>' })).toContain('Shade <Close>');
  });

  it('falls back to English for a key missing in tr/ar', () => {
    i18n.addResource('en', 'common', '__only_en', 'English only');
    expect(t('ar', 'common:__only_en')).toBe('English only');
  });

  it('safety wording: Stop All and Stop irrigation stay distinct in every language', () => {
    for (const lng of ['en', 'tr', 'ar']) {
      const stopAll = t(lng, 'shell:stopAll.long');
      const stopIrr = t(lng, 'irrigation:stop.button');
      const estop = t(lng, 'shell:estop.long');
      expect(new Set([stopAll, stopIrr, estop]).size).toBe(3);
      // the Stop All tooltip must name the fans and point to Stop irrigation
      expect(t(lng, 'shell:stopAll.tooltip')).toContain(lng === 'ar' ? 'المراوح' : lng === 'tr' ? 'fan' : 'fans');
    }
  });
});

describe('language helpers', () => {
  it('normalizes tags and knows the direction', () => {
    expect(normalizeLanguage('ar-AE')).toBe('ar');
    expect(normalizeLanguage('TR')).toBe('tr');
    expect(normalizeLanguage('de-DE')).toBeNull();
    expect(dirOf('ar')).toBe('rtl');
    expect(dirOf('tr')).toBe('ltr');
    expect(intlLocale('ar')).toBe('ar-u-nu-latn');
  });

  it('pseudo-locale keeps interpolations, tags and units', () => {
    const p = pseudoString('Flow {{flow}} L/h with <b>every</b> zone valve shut');
    expect(p).toContain('{{flow}}');
    expect(p).toContain('<b>');
    expect(p).toContain('L/h');
    expect(p).toMatch(/^\[.*~+\]$/);
    expect(p).not.toContain('every');
  });
});
