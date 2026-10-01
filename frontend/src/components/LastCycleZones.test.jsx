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

// Equal draw (operator requirement 2026-10-01): spread column, pacing tank, summary +
// the max achievable equal ratio of recent runs.
describe('LastCycleZones — equal draw', () => {
  const eqTanks = (vals, pacer) => vals.map((l, i) => ({ tank_id: i + 1, name: `Tank ${'ABCD'[i]}`, dosed_l: l, dosed_est_l: l, ...(i + 1 === pacer ? { eq_pacer: true } : { eq_paced: true, eq_held_s: 40 }) }));
  const EQRUN = {
    ...RUN, ratio_target: 116,
    tanks: [1, 2, 3, 4].map(id => ({ tank_id: id, name: `Tank ${'ABCD'[id - 1]}`, dosed_l: 9.5, ratio_target: 116 })),
    zone_visits: [
      zone(1, { tanks: eqTanks([2.5, 2.25, 2.5, 2.5], 2), equal_draw: { tolerance_l: 0.5 } }),
      zone(2, { tanks: eqTanks([2.25, 2.25, 2.5, 3.25], 2), equal_draw: { tolerance_l: 0.5 } }),
    ],
    equal_draw: { enabled: true, tolerance_l: 0.5, spread_l: 0.25, spread_pct: 1.9, within_tolerance: true, pacer: { tank_id: 2, name: 'Tank B' }, common_ratio: 188, failures: [] },
    equal_draw_capability: { achievable_ratio: 171, best_ratio: 150, n_limited: 4 },
  };
  it('shows the spread per zone (caution above tolerance + one counter step), the pacing tank and the summary', () => {
    const html = render(EQRUN);
    expect(html).toContain('data-testid="last-cycle-equal-draw"');
    expect(html).toContain('spread 0.25 L (1.9 %)');
    expect(html).toContain('paced by B');
    expect(html).toContain('1:188');
    expect(html.match(/data-eq-pacer="true"/g).length).toBe(2);
    const spreads = [...html.matchAll(/data-testid="last-cycle-spread">([^<]+)</g)].map(m => m[1]);
    expect(spreads).toEqual(['0.25', '1.00']);
    expect(html).toMatch(/text-caution-700[^"]*" data-testid="last-cycle-spread">1.00/);
    expect(html).toContain('Max achievable equal ratio (4 recent runs');
    expect(html).toContain('≈1:171');
    expect(html).toContain('data-testid="last-cycle-achievable-warning"');
  });
  it('without equal draw: no spread column; failures are listed; Arabic + Turkish render', () => {
    const off = render({ ...RUN });
    expect(off).not.toContain('last-cycle-spread');
    const fail = render({ ...EQRUN, equal_draw: { ...EQRUN.equal_draw, failures: [{ tank_id: 2, name: 'Tank B', policy: 'hold_all', resolved_at: null }] } });
    expect(fail).toContain('Tank B stopped drawing — the other tanks were held (water only)');
    expect(render(EQRUN, 'ar')).toContain('سحب متساوٍ');
    expect(render(EQRUN, 'tr')).toContain('Eşit emiş');
  });
});
