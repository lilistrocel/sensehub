import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { ProvenanceBadge, ProvenanceMark, BasisChips, ProvenanceLegend, PROVENANCE_KINDS, BASIS_KIND, cleanBasis, isAiOnlyBasis } from './Provenance';
import en from '../locales/en/common.json';
import tr from '../locales/tr/common.json';
import ar from '../locales/ar/common.json';

// Shared provenance marking (operator request 2026-09-30): one set of kinds,
// icon + colour token + label each, never colour alone.
function render(el, lng = 'en') {
  const inst = i18next.createInstance();
  inst.use(initReactI18next).init({
    lng, fallbackLng: 'en', initImmediate: false, ns: ['common'], defaultNS: 'common',
    resources: { en: { common: en }, tr: { common: tr }, ar: { common: ar } }, interpolation: { escapeValue: false },
  });
  return renderToStaticMarkup(<I18nextProvider i18n={inst}>{el}</I18nextProvider>);
}

describe('ProvenanceBadge / ProvenanceMark', () => {
  it('each kind: own icon, own colour token, own label (en / tr / ar)', () => {
    const labels = { en: [], tr: [], ar: [] };
    for (const k of PROVENANCE_KINDS) {
      const html = render(<ProvenanceBadge kind={k} />);
      expect(html).toContain(`data-provenance="${k}"`);
      expect(html).toContain(`data-provenance-icon="${k}"`);
      expect(html).toContain(`text-prov-${k}`);
      expect(html).not.toMatch(/#[0-9A-Fa-f]{6}/); // tokens, no raw colours
      for (const l of ['en', 'tr', 'ar']) labels[l].push(/<span>([^<]+)<\/span><\/span>$/.exec(render(<ProvenanceBadge kind={k} />, l))[1]);
    }
    for (const l of ['en', 'tr', 'ar']) expect(new Set(labels[l]).size).toBe(PROVENANCE_KINDS.length);
    expect(labels.en).toEqual(['Human · protocol', 'Human · operator', 'Measured', 'Calculated by SenseHub', 'AI-generated']);
    expect(labels.ar[4]).toBe('مُولَّد بالذكاء الاصطناعي');
  });

  it('AI is dashed; a derived value shows both icons and a derived label', () => {
    expect(render(<ProvenanceBadge kind="ai" />)).toContain('border-dashed');
    expect(render(<ProvenanceBadge kind="protocol" />)).not.toContain('border-dashed');
    const html = render(<ProvenanceBadge kind="calculated" from="protocol" />);
    expect(html).toContain('data-provenance-from="protocol"');
    expect(html).toContain('data-provenance-icon="calculated"');
    expect(html).toContain('data-provenance-icon="protocol"');
    expect(html).toContain('Calculated from protocol');
  });

  it('mark is icon-only with an accessible label + detail', () => {
    const html = render(<ProvenanceMark kind="operator" detail="Edited by hand." />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Human · operator: Edited by hand."');
    expect(html).not.toContain('<span>Human');
  });

  it('unknown kind falls back to calculated (never unmarked)', () => {
    expect(render(<ProvenanceBadge kind="bogus" />)).toContain('data-provenance="calculated"');
  });
});

describe('BasisChips (AI items)', () => {
  it('maps every basis value to a provenance kind', () => {
    expect(BASIS_KIND).toEqual({ protocol: 'protocol', operator_targets: 'operator', operator_notes: 'operator', measured: 'measured', senseHub_calculation: 'calculated', ai_general_knowledge: 'ai' });
    expect(cleanBasis(['measured', 'protocol', 'measured', 'nope'])).toEqual(['protocol', 'measured']);
    expect(isAiOnlyBasis(['ai_general_knowledge'])).toBe(true);
    expect(isAiOnlyBasis(['ai_general_knowledge', 'measured'])).toBe(false);
    expect(isAiOnlyBasis(undefined)).toBe(false);
  });

  it('"based on" chips in fixed order', () => {
    const html = render(<BasisChips basis={['measured', 'operator_notes', 'protocol']} />);
    expect(html).toContain('data-basis="protocol operator_notes measured"');
    expect(html).toContain('Based on:');
    expect(html.indexOf('Protocol')).toBeLessThan(html.indexOf('Your notes'));
    expect((html.match(/data-provenance="/g) || []).length).toBe(3);
  });

  it('AI-knowledge-only items are distinct: one emphasised chip', () => {
    const html = render(<BasisChips basis={['ai_general_knowledge']} />);
    expect(html).toContain('data-basis="ai_only"');
    expect(html).toContain('AI knowledge – not from your data');
    expect(html).toContain('border-2');
    expect(render(<BasisChips basis={['ai_general_knowledge']} />, 'tr')).toContain('Yapay zekâ bilgisi – verilerinizden değil');
  });

  it('older advices without basis: "Basis not recorded"', () => {
    expect(render(<BasisChips basis={undefined} />)).toContain('Basis not recorded');
    expect(render(<BasisChips basis={[]} />)).toContain('data-basis="none"');
    expect(render(<BasisChips basis={null} />, 'ar')).toContain('الأساس غير مسجّل');
  });

  it('compact = icons only', () => {
    const html = render(<BasisChips basis={['protocol', 'senseHub_calculation']} compact />);
    expect(html).not.toContain('>Based on:<');
    expect((html.match(/role="img"/g) || []).length).toBe(2);
    expect(html).toContain('aria-label="Calculated by SenseHub: Based on: SenseHub calculation"');
  });
});

describe('ProvenanceLegend', () => {
  it('collapsible, lists every kind with its description and the basis note', () => {
    const html = render(<ProvenanceLegend />);
    expect(html).toMatch(/^<details/);
    expect(html).toContain('What the markings mean');
    for (const k of PROVENANCE_KINDS) expect(html).toContain(`data-provenance="${k}"`);
    expect(html).toContain('1:150 design dilution');
    expect(html).toContain('AI knowledge – not from your data');
  });
});
