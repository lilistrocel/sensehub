import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import LastCycleZones from './LastCycleZones';
import en from '../locales/en/irrigation.json';
import ar from '../locales/ar/irrigation.json';
import tr from '../locales/tr/irrigation.json';

// Line flush (2026-09-28): zone 1's EC/pH exclude the first ~40 s after the run's
// first pump start; the cells carry a "*" marker + title, the table a footnote.
// Litres stay the counter values (ground truth).
function render(run, lng = 'en') {
  const inst = i18next.createInstance();
  inst.use(initReactI18next).init({
    lng, fallbackLng: 'en', initImmediate: false, ns: ['irrigation'], defaultNS: 'irrigation',
    resources: { en: { irrigation: en }, ar: { irrigation: ar }, tr: { irrigation: tr } }, interpolation: { escapeValue: false },
  });
  return renderToStaticMarkup(<I18nextProvider i18n={inst}><LastCycleZones run={run} formatTime={() => '07:30'} /></I18nextProvider>);
}

const tanks = (l) => [1, 2, 3, 4].map(id => ({ tank_id: id, name: `Tank ${'ABCD'[id - 1]}`, dosed_l: l, dosed_est_l: l + 0.12 }));
const zone = (n, extra = {}) => ({
  zone: n, channel: 2 + n, name: `Irrigation Zone ${n}`, status: 'ok', water_l: 438, tanks: tanks(2.25), achieved_ratio: 195,
  ec_avg_us: 1850, ec_min_us: 1800, ec_max_us: 1900, ec_samples: 13, ph_avg: 6.1, ph_min: 6.0, ph_max: 6.2, samples: 13, skipped_samples: 1,
  ...extra,
});
const RUN = {
  id: 11, started_at: '2026-09-28T03:30:00Z', status: 'completed', ratio_target: 200, acid_s: 30,
  tanks: tanks(9).map(t => ({ ...t, ratio_target: 200 })),
  zone_visits: [
    zone(1, { flush_samples: 4, flush_s: 40, flush_ec_avg_us: 450, flush_ph_avg: 7.2, ec_samples: 9, samples: 9 }),
    zone(2), zone(3), zone(4),
  ],
};

describe('LastCycleZones — line flush excluded', () => {
  it('marks only zone 1 EC/pH, with the flush values in the title and a footnote', () => {
    const html = render(RUN);
    expect((html.match(/data-testid="last-cycle-flush"/g) || []).length).toBe(2); // EC + pH of zone 1
    expect(html).toContain('Line flush excluded: first 40 s after the run&#x27;s first pump start (EC 0.45 mS/cm, pH 7.20)');
    expect(html).toContain('data-testid="last-cycle-flush-note"');
    expect(html).toContain('* EC/pH without the line flush (first 40 s after the run&#x27;s first pump start)');
    // litres shown are the counter (ground truth), not the estimate
    expect(html).toContain('>2.25<');
    expect(html).not.toContain('2.37');
  });

  it('no flush fields -> no marker, no footnote (older runs, flush_seconds 0)', () => {
    const run = { ...RUN, zone_visits: RUN.zone_visits.map(({ flush_samples, flush_s, flush_ec_avg_us, flush_ph_avg, ...z }) => z) };
    const html = render(run);
    expect(html).not.toContain('last-cycle-flush');
  });

  it('translated (ar, tr), numbers stay Western', () => {
    const htmlAr = render(RUN, 'ar');
    expect(htmlAr).toContain('استُبعد شطف الخط');
    expect(htmlAr).toContain('40');
    expect(htmlAr).toContain('0.45');
    const htmlTr = render(RUN, 'tr');
    expect(htmlTr).toContain('Hat yıkaması hariç tutuldu');
  });
});
