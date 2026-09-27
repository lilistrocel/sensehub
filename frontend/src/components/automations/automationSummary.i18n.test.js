import { describe, it, expect } from 'vitest';
import {
  buildEquipmentIndex, describeWhat, summarizeAutomation, formatDuration, makeTranslator, stripIsolates,
  relativeTime, formatNextRun, describeSchedule,
} from './automationSummary';
import en from '../../locales/en/automations.json';
import tr from '../../locales/tr/automations.json';
import ar from '../../locales/ar/automations.json';

// The summary sentence is built from whole per-language templates
// (locales/<lng>/automations.json summary.*), never from English fragments.
const LOC = {
  en: { t: makeTranslator(en, 'en'), lng: 'en' },
  tr: { t: makeTranslator(tr, 'tr'), lng: 'tr' },
  ar: { t: makeTranslator(ar, 'ar'), lng: 'ar' },
};
const FSI = '⁨';
const PDI = '⁩';

const EQ = [{
  id: 1, name: 'Waveshare Irrigation 1',
  register_mappings: JSON.stringify(['Irrigation Pump', 'Mixing Pump', 'Irrigation Zone 1', 'Irrigation Zone 2', 'Irrigation Zone 3', 'Irrigation Zone 4']
    .map((name, i) => ({ name, register: String(i + 1), type: 'coil', access: 'readwrite' }))),
}];
const idx = buildEquipmentIndex(EQ);

function softSwitch(D = 270, lead = 3, lag = 5, gap = 1) {
  const out = [];
  let t0 = 0;
  for (const ch of [3, 4, 5, 6]) {
    out.push({ type: 'control', action: 'on', equipment_id: 1, channel: ch, delay_seconds: t0, duration_seconds: D + lead + lag });
    out.push({ type: 'control', action: 'on', equipment_id: 1, channel: 1, delay_seconds: t0 + lead, duration_seconds: D });
    out.push({ type: 'control', action: 'on', equipment_id: 1, channel: 2, delay_seconds: t0 + lead, duration_seconds: D });
    t0 += D + lead + lag + gap;
  }
  return out;
}

const daily18 = {
  trigger_config: { type: 'schedule', schedule_type: 'daily', time: '11:30' },
  actions: [{ type: 'control', action: 'on', equipment_id: 1, channel: 1, duration_seconds: 1080 }],
};

describe('summary sentence per language', () => {
  it('English is unchanged when a translator is passed explicitly', () => {
    expect(summarizeAutomation(daily18, idx, LOC.en).text).toBe('Daily 11:30 → Irrigation Pump ON 18 min');
    expect(summarizeAutomation(daily18, idx).text).toBe('Daily 11:30 → Irrigation Pump ON 18 min');
  });

  it('Turkish: own word order and duration words, channel names untouched', () => {
    expect(summarizeAutomation(daily18, idx, LOC.tr).text).toBe('Her gün 11:30 → Irrigation Pump AÇIK 18 dk');
    const what = describeWhat(softSwitch(), idx, LOC.tr);
    expect(what).toContain('Irrigation Zone 1→4 AÇIK her biri 4 dk 38 sn, sırayla');
    expect(what).toContain('Irrigation Pump AÇIK 4 dk 30 sn × 4, ilki 3 sn sonra');
    expect(what).not.toMatch(/\b(ON|each|in sequence|first after|min)\b/);
  });

  it('Arabic: verb first, names isolated, arrow points right-to-left', () => {
    const s = summarizeAutomation(daily18, idx, LOC.ar);
    expect(s.text).toBe(`يوميًا 11:30 ← تشغيل ${FSI}Irrigation Pump${PDI} لمدة 18 د`);
    const what = describeWhat(softSwitch(), idx, LOC.ar);
    expect(what).toContain(`تشغيل ${FSI}Irrigation Zone${PDI} من 1 إلى 4 لمدة 4 د 38 ث لكلٍّ منها، بالتتابع`);
    expect(what).toContain(`تشغيل ${FSI}Mixing Pump${PDI} لمدة 4 د 30 ث × 4، الأول بعد 3 ث`);
    expect(what).not.toMatch(/\b(ON|each|in sequence|first after)\b/);
  });

  it('Arabic plural forms of counts (six CLDR categories)', () => {
    const acts = (n) => Array.from({ length: n }, () => ({ type: 'alert', severity: 'info', message: 'x' }));
    expect(describeWhat(acts(2), idx, LOC.ar)).toBe('تنبيهان');
    expect(describeWhat(acts(3), idx, LOC.ar)).toBe('3 تنبيهات');
    expect(describeWhat(acts(11), idx, LOC.ar)).toBe('11 تنبيهًا');
    expect(describeWhat(acts(3), idx, LOC.tr)).toBe('3 alarm');
  });

  it('threshold keeps "> 30 °C" as one left-to-right unit in Arabic', () => {
    const auto = { trigger_config: { type: 'threshold', sensor_type: 'temperature', operator: 'gt', threshold_value: 30, unit: '°C' }, actions: [] };
    expect(summarizeAutomation(auto, idx, LOC.ar).when).toBe(`${FSI}الحرارة${PDI} ⁦> 30 °C${PDI}`);
    expect(summarizeAutomation(auto, idx, LOC.tr).when).toBe('Sıc. > 30 °C');
  });

  it('suggested names are saved without bidi controls', () => {
    expect(stripIsolates(summarizeAutomation(daily18, idx, LOC.ar).text)).toBe('يوميًا 11:30 ← تشغيل Irrigation Pump لمدة 18 د');
  });
});

describe('localized helpers', () => {
  it('durations use the language unit words', () => {
    expect(formatDuration(278, 'en')).toBe('4 min 38 s');
    expect(formatDuration(278, LOC.tr)).toBe('4 dk 38 sn');
    expect(formatDuration(3900, 'ar')).toBe('1 س 5 د');
  });

  it('weekly schedules use localized weekday names', () => {
    const trig = { type: 'schedule', schedule_type: 'weekly', day_of_week: 1, time: '06:00' };
    expect(describeSchedule(trig, { long: true })).toBe('Every Monday at 06:00');
    expect(describeSchedule(trig, { long: true, loc: LOC.tr })).toBe('Her Pazartesi saat 06:00');
    expect(describeSchedule(trig, { long: true, loc: LOC.ar })).toBe('كل يوم الاثنين الساعة 06:00');
  });

  it('relative times and next run', () => {
    const now = Date.UTC(2026, 8, 27, 12, 0, 0);
    expect(relativeTime(now - 3 * 86400e3, now, LOC.tr)).toBe('3 gün önce');
    expect(relativeTime(now - 2 * 86400e3, now, LOC.ar)).toBe('قبل يومين');
    expect(relativeTime(null, now, LOC.tr)).toBe('hiç');
    const base = new Date(2026, 8, 27, 10, 0, 0);
    expect(formatNextRun(new Date(2026, 8, 27, 10, 30, 0), base, LOC.tr)).toBe('bugün 10:30 (30 dk sonra)');
    expect(formatNextRun(new Date(2026, 8, 27, 10, 30, 0), base, LOC.ar)).toBe('اليوم 10:30 (بعد 30 د)');
  });
});
