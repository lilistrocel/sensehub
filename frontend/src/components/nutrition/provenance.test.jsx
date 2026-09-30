import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next, useTranslation } from 'react-i18next';
import { useFormat } from '../../i18n/useFormat';
import { AdviceView } from './AdvisorPanel';
import { FeedBody } from './FeedPanel';
import feedToday from './__fixtures__/feedToday.json';
import TargetsPanel from './TargetsPanel';
import { adviceHasBasis } from './nutritionUtil';
import enN from '../../locales/en/nutrition.json';
import trN from '../../locales/tr/nutrition.json';
import arN from '../../locales/ar/nutrition.json';
import enC from '../../locales/en/common.json';
import trC from '../../locales/tr/common.json';
import arC from '../../locales/ar/common.json';

// Crop & Nutrition provenance (operator request 2026-09-30): the farm team can
// tell at a glance where every number and statement comes from.
function render(el, lng = 'en') {
  const inst = i18next.createInstance();
  inst.use(initReactI18next).init({
    lng, fallbackLng: 'en', initImmediate: false, ns: ['nutrition', 'common'], defaultNS: 'nutrition',
    resources: { en: { nutrition: enN, common: enC }, tr: { nutrition: trN, common: trC }, ar: { nutrition: arN, common: arC } },
    interpolation: { escapeValue: false },
  });
  return renderToStaticMarkup(<I18nextProvider i18n={inst}>{el}</I18nextProvider>);
}

const ELS = ['N', 'P', 'K', 'Ca', 'Mg', 'S', 'Fe', 'Mn', 'Zn', 'B', 'Cu', 'Mo'];
function advice({ withBasis = true } = {}) {
  const b = (x) => (withBasis ? { basis: x } : {});
  return {
    id: 7, status: 'success', trigger: 'manual', created_at: new Date().toISOString(), model: 'claude-sonnet-5', translation_status: 'original',
    advice: {
      status: 'caution',
      summary: 'Feeding is below the protocol for day 21.',
      analysis_markdown: 'Analysis.',
      per_element: ELS.map(el => ({ element: el, status: 'ok', comment: `${el} fine.`, ...b(['senseHub_calculation', 'protocol']) })),
      warnings: [{ severity: 'warning', message: 'N low.', ...b(['measured', 'protocol']) }],
      recommendations: [
        { priority: 'high', action: 'Next refill of Tank C: 58 kg KNO3.', rationale: 'N low.', when: 'next refill', vs_protocol: 'agrees', vs_protocol_reason: 'Protocol value.', ...b(['protocol', 'operator_targets']) },
        { priority: 'low', action: 'Keep the slab below 28 C.', rationale: 'Ca uptake.', when: 'this week', vs_protocol: 'extends', vs_protocol_reason: 'Not in the protocol.', ...b(['ai_general_knowledge']) },
      ],
      questions_for_operator: [],
    },
  };
}

describe('advisor report provenance', () => {
  it('marked AI-generated; every item shows its basis; AI-knowledge-only items are distinct', () => {
    const html = render(<AdviceView adv={advice()} ui="en" original={false} onToggleOriginal={() => {}} />);
    expect(html).toContain('data-testid="advisor-ai-badge"');
    expect(html).toContain('AI-generated');
    // section labels carry the AI marker (warnings, recommendations, per element, analysis)
    expect((html.match(/aria-label="AI-generated: Written by the AI advisor\."/g) || []).length).toBeGreaterThanOrEqual(4);
    expect(html).toContain('data-basis="protocol operator_targets"');
    expect(html).toContain('data-basis="protocol measured"');
    expect((html.match(/data-basis="protocol senseHub_calculation"/g) || []).length).toBe(12); // compact per element
    expect(html).toContain('data-ai-only="true"');
    expect((html.match(/data-ai-only="true"/g) || []).length).toBe(1);
    expect(html).toContain('AI knowledge – not from your data');
    // vs_protocol tags kept
    expect(html).toContain('data-vs-protocol="agrees"');
    expect(html).toContain('data-vs-protocol="extends"');
    expect(html).not.toContain('Basis not recorded');
  });

  it('advice from before 2026-09-30 (no basis) renders fine: one "basis not recorded" line', () => {
    const a = advice({ withBasis: false });
    expect(adviceHasBasis(a.advice)).toBe(false);
    const html = render(<AdviceView adv={a} ui="en" original={false} onToggleOriginal={() => {}} />);
    expect(html).toContain('data-testid="advisor-basis-not-recorded"');
    expect((html.match(/Basis not recorded/g) || []).length).toBe(1);
    expect(html).not.toContain('data-ai-only');
    expect(html).toContain('Next refill of Tank C');
    expect(html).toContain('data-testid="advisor-ai-badge"');
  });

  it('Arabic: labels translated, no raw keys', () => {
    const html = render(<AdviceView adv={advice()} ui="ar" original={false} onToggleOriginal={() => {}} />, 'ar');
    expect(html).toContain('مُولَّد بالذكاء الاصطناعي');
    expect(html).toContain('معرفة الذكاء الاصطناعي – ليست من بياناتك');
    expect(html).not.toMatch(/provenance\.|prov\./);
  });
});

const profile = {
  id: 1,
  stage: { effective: 'vegetative' },
  stage_targets: {
    vegetative: { ec_min: 1.8, ec_target: 2.0, ec_max: 2.2, ph_min: 5.5, ph_max: 6.0, drain_pct_min: null, drain_pct_target: null, drain_pct_max: null, drain_ec_delta_max: null, drain_ph_min: null, drain_ph_max: null, ml_min: 1500, ml_target: 1900, ml_max: 2300, source: 'operator' },
  },
  element_targets: {
    vegetative: [
      { element: 'N', hard_min: 108, soft_target: 154, hard_max: 231, manual: false, basis_source: 'protocol' },
      { element: 'K', hard_min: 150, soft_target: 200, hard_max: 300, manual: true, basis_source: 'protocol' },
      { element: 'Ca', hard_min: 80, soft_target: 118, hard_max: 170, manual: false, basis_source: 'scaled', basis_ec: 1.9, basis_factor: 0.93 },
    ],
  },
  protocol: { name: 'Human agronomist protocol (2026-09-28)', data: { stage_targets: { vegetative: { input_ec: { min: 1.8, target: 2.0, max: 2.2 }, input_ph: { min: 5.5, max: 6.2 }, ml_per_plant_day: { min: 1500, target: 1900, max: 2300 } } } } },
  protocol_ppm: { design_dilution: 150, by_stage: { vegetative: { recipe: 'vegetative', ec_ms_cm: 2.1, ppm: { N: 154, K: 213, Ca: 127 } } } },
  element_targets_ec: {},
};

describe('targets panel provenance', () => {
  it('per value: protocol vs operator-edited stage rows; element rows calculated from protocol / scaled / hand-edited', () => {
    const html = render(<TargetsPanel profile={profile} canEdit={false} api={{}} onSaved={() => {}} />);
    const marks = [...html.matchAll(/data-provenance="(\w+)"[^>]*data-testid="stage-row-provenance"|aria-label="([^"]+)"[^>]*data-provenance="(\w+)"[^>]*data-testid="stage-row-provenance"/g)];
    expect(marks.length).toBe(3); // EC, pH, water rows have values
    expect(html).toContain('aria-label="Human · protocol: Same as the human agronomist protocol."');
    expect(html).toContain('aria-label="Human · operator: Changed by the farm team: differs from the protocol (max)."'); // pH max 6.0 vs 6.2
    // element rows
    expect(html).toContain('aria-label="Calculated from protocol: Protocol recipe at the 1:150 design dilution (SenseHub assumption), with SenseHub&#x27;s min / max band."');
    expect(html).toContain('aria-label="Human · operator: Edited by hand by the farm team."');
    expect(html).toContain('Protocol recipe scaled by SenseHub to input EC 1.90 mS/cm (×0.93)');
    expect((html.match(/data-testid="element-target-provenance"/g) || []).length).toBe(3);
    // column headers: the protocol as written vs the protocol recipe x SenseHub dilution
    expect(html).toContain('data-provenance="protocol"');
    expect(html).toContain('data-testid="protocol-ppm-provenance"');
    // the old ad-hoc badges are gone
    expect(html).not.toContain('Entered by operator');
    expect(html).not.toContain('data-testid="target-manual"');
    expect(html).not.toContain('data-source=');
  });

  it('Turkish renders the same markers translated', () => {
    const html = render(<TargetsPanel profile={profile} canEdit={false} api={{}} onSaved={() => {}} />, 'tr');
    expect(html).toContain('İnsan · protokol');
    expect(html).toContain('Protokolden hesaplandı');
  });
});

// Feed calculator (2026-09-30 regression: a shadowed helper crashed the Feed tab;
// vite build and the other tests passed). Live response of 2026-09-30, runs dropped.
function FeedHarness({ rep, profile }) {
  const { t } = useTranslation('nutrition');
  const fmt = useFormat();
  return <FeedBody rep={rep} profile={profile} fmt={fmt} t={t} />;
}

describe('feed calculator provenance', () => {
  it('renders (ratios table included) with measured / calculated / operator / protocol marks', () => {
    const html = render(<FeedHarness rep={feedToday} profile={{ ...profile, element_targets: { vegetative: profile.element_targets.vegetative } }} />);
    expect(html).toContain('data-testid="feed-ratios"');
    expect(html).toContain('data-testid="feed-delivered-provenance"');
    for (const k of ['measured', 'calculated', 'operator', 'protocol']) expect(html).toContain(`data-provenance="${k}"`);
    expect(html).toContain('data-provenance-from="measured"');
    expect(html).toContain('data-provenance-from="protocol"');
    expect(html).toContain('aria-label="Measured: Feed EC from the SEKO probe."');
    expect(html).toContain('aria-label="Human · operator: Edited by hand by the farm team."'); // K is hand-edited in the fixture profile
  });
});

// Operator request 2026-09-30: the fruit-set recipe's 1:100 dilution is STATED by the protocol
// (2026-09-30 version), not the 1:150 SenseHub assumption; a mid-day recipe change is shown.
describe('protocol-stated dilution (2026-09-30) and recipe change', () => {
  const flowering = {
    ...profile,
    stage: { effective: 'flowering' },
    stage_targets: { flowering: { ec_min: 2.0, ec_target: 2.1, ec_max: 2.2 } },
    element_targets: { flowering: [{ element: 'N', hard_min: 190, soft_target: 223, hard_max: 256, manual: false, basis_source: 'protocol' }] },
    protocol: { name: 'Human agronomist protocol (2026-09-30)', data: { stage_targets: { flowering: { input_ec: { target: 1.7 } } } } },
    protocol_ppm: { design_dilution: 150, by_stage: { flowering: { recipe: 'fruit_set', design_dilution: 100, dilution_source: 'protocol', ec_ms_cm: 2.21, ppm: { N: 229, K: 373, Ca: 171 } } } },
  };
  it('targets panel: 1:100 marked as stated by the protocol, recipe label translated', () => {
    const html = render(<TargetsPanel profile={flowering} canEdit={false} api={{}} onSaved={() => {}} />);
    expect(html).toContain('Protocol recipe at 1:100 as stated by the protocol');
    expect(html).toContain('Protocol recipe diluted 1:100 per tank, as the protocol sheet states.');
    expect(html).toContain('Protocol fruit set recipe diluted 1:100');
    expect(html).not.toContain('1:150');
    const ar = render(<TargetsPanel profile={flowering} canEdit={false} api={{}} onSaved={() => {}} />, 'ar');
    expect(ar).toContain('عقد الثمار');
  });
  it('feed body: stated dilution in the protocol column; recipe-change note lists the tanks', () => {
    const rep = {
      ...feedToday,
      protocol: feedToday.protocol ? { ...feedToday.protocol, recipe: 'fruit_set', design_dilution: 100, dilution_source: 'protocol' } : feedToday.protocol,
      recipe_changed_in_period: true,
      recipe_segments: [
        { tank_id: 1, letter: 'A', mixture_id: 14, current: false, runs: 4, dosed_l: 30 },
        { tank_id: 1, letter: 'A', mixture_id: 18, current: true, runs: 2, dosed_l: 12 },
        { tank_id: 2, letter: 'B', mixture_id: 15, current: false, runs: 4, dosed_l: 30 },
      ],
    };
    const html = render(<FeedHarness rep={rep} profile={{ ...profile, element_targets: { vegetative: profile.element_targets.vegetative } }} />);
    expect(html).toContain('data-testid="feed-recipe-changed"');
    expect(html).toContain('(tank A, B)');
    if (feedToday.protocol) expect(html).toContain('as the protocol sheet states');
  });
});
