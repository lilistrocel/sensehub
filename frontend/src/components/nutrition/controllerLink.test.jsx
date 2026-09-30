import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { ControllerLinkView } from './ControllerLinkPanel';
import { fieldText, originProvenance, ratioOrigin, uniformRatio, matchState, proposalShape, deviationPct, bestFitShape } from './controllerLinkUtil';
import fx from './__fixtures__/controllerLink.json';
import enN from '../../locales/en/nutrition.json';
import trN from '../../locales/tr/nutrition.json';
import arN from '../../locales/ar/nutrition.json';
import enC from '../../locales/en/common.json';
import trC from '../../locales/tr/common.json';
import arC from '../../locales/ar/common.json';
import enA from '../../locales/en/agronomist.json';

// "Follow crop targets" (operator decision 2026-09-30): the dose-controller link on
// Crop & Nutrition and Fertigation. Fixture = the backend view for the live-like
// vegetative state (EC 1.8·1.9·2.0, pH 5.8-6.2), generated from ControllerLinkService.
function render(el, lng = 'en') {
  const inst = i18next.createInstance();
  inst.use(initReactI18next).init({
    lng, fallbackLng: 'en', initImmediate: false, ns: ['nutrition', 'common', 'agronomist'], defaultNS: 'nutrition',
    resources: { en: { nutrition: enN, common: enC, agronomist: enA }, tr: { nutrition: trN, common: trC, agronomist: enA }, ar: { nutrition: arN, common: arC, agronomist: enA } },
    interpolation: { escapeValue: false },
  });
  return renderToStaticMarkup(<I18nextProvider i18n={inst}>{el}</I18nextProvider>);
}
const noop = () => {};
const view = (v, props = {}) => <ControllerLinkView view={v} canEdit onToggleMode={noop} onApprove={noop} onReject={noop} onTrim={noop} {...props} />;
const fmt = { int: (v) => String(Math.round(v)), number: (v, o = {}) => Number(v).toFixed(o.decimals ?? 2) };

describe('controller link util', () => {
  it('formats controller values (ratio uniform / per tank, µS as mS/cm, absence as a dash)', () => {
    const L = { 1: 'A', 2: 'B', 3: 'C', 4: 'D' };
    expect(fieldText('nutrients.ratio', { 1: 132, 2: 132, 3: 132, 4: 132 }, fmt, L)).toBe('1:132 (A–D)');
    expect(fieldText('nutrients.ratio', { 1: 150, 2: 200 }, fmt, L)).toBe('A 1:150 · B 1:200');
    expect(fieldText('nutrients.ec_trim.water_us', 250, fmt)).toBe('0.25 mS/cm');
    expect(fieldText('ec_check.raw_water_ec_us', null, fmt)).toBe('—');
    expect(fieldText('ph.setpoint', 6, fmt)).toBe('6.00');
    expect(uniformRatio({ 1: 200, 2: 200 })).toBe(200);
    expect(uniformRatio({ 1: 200, 2: 150 })).toBe(null);
  });
  it('maps origins to the shared provenance kinds', () => {
    expect(originProvenance('crop_link')).toMatchObject({ kind: 'calculated', from: 'operator' });
    expect(originProvenance('operator')).toMatchObject({ kind: 'operator' });
    expect(originProvenance('default')).toMatchObject({ kind: 'calculated', from: null });
    expect(originProvenance('operator_unrecorded')).toMatchObject({ kind: 'operator' });
    expect(originProvenance('x')).toBe(null);
    expect(ratioOrigin({ 'nutrients.ratio.1': { origin: 'crop_link', proposal_id: 3 }, 'nutrients.ratio.2': { origin: 'crop_link', proposal_id: 3 } }, [1, 2]).origin).toBe('crop_link');
    expect(ratioOrigin({ 'nutrients.ratio.1': { origin: 'crop_link' }, 'nutrients.ratio.2': { origin: 'operator' } }, [1, 2]).mixed).toBe(true);
  });
  it('status shapes: never green for unknown; unreachable is an alarm', () => {
    expect(matchState({ available: false })).toBe('unknown');
    expect(matchState({ available: true, match: true })).toBe('ok');
    expect(matchState({ available: true, match: false })).toBe('caution');
    expect(proposalShape('applied')).toBe('ok');
    expect(proposalShape('pending')).toBe('caution');
    expect(proposalShape('failed')).toBe('alarm');
    expect(proposalShape('rejected')).toBe('unknown');
    expect(deviationPct(1.9, 1.95)).toBe(2.6);
    expect(deviationPct(0, 1)).toBe(null);
    expect(bestFitShape({ unreachable: true, status: 'low' })).toBe('alarm');
    expect(bestFitShape({ status: 'low' })).toBe('caution');
  });
});

describe('ControllerLinkView', () => {
  it('no source water: pH proposal with Approve / Reject, EC blocked, 250 µS/cm shown as an unmeasured default', () => {
    const html = render(view(fx.pending));
    expect(html).toContain('data-mode="follow_crop_targets"');
    expect(html).toContain('Follow crop targets');
    // discrepancy: profile blank, controller assumes a code default
    expect(html).toContain('data-testid="link-water-warning"');
    expect(html).toContain('data-state="profile_missing"');
    expect(html).toContain('0.25 mS/cm. That value is a SenseHub default');
    // pending proposal diff: pH setpoint 5.65 -> 6.00, floor 5.30 -> 5.60
    expect(html).toContain('data-testid="link-pending"');
    expect(html).toMatch(/data-field="ph.setpoint"[\s\S]*?5\.65[\s\S]*?6\.00/);
    expect(html).toMatch(/data-field="ph.floor_ph"[\s\S]*?5\.30[\s\S]*?5\.60/);
    expect(html).toContain('Middle of the stage pH range 5.80–6.20.');
    expect(html).toContain('data-testid="link-approve"');
    expect(html).toContain('data-testid="link-reject"');
    expect(html).toContain('data-reason="source_water_missing"');
    expect(html).toContain('Needs source water EC');
    // provenance: operator ratio (before origins were recorded), default pH setpoint
    expect(html).toContain('data-origin="operator_unrecorded"');
    expect(html).toContain('data-origin="default"');
    expect(html).toContain('Calculated from crop targets');
    // EC fine-tuning: off, never proposed, the verified enable control is there
    expect(html).toContain('data-testid="link-trim" data-enabled="false"');
    expect(html).toContain('Enable EC fine-tuning (requires SEKO EC verified against a handheld meter)');
    // best fit: clearly advisory
    expect(html).toContain('data-testid="link-bestfit-advisory"');
    expect(html).toContain('Advisory only — never applied');
  });

  it('with source water: ratio 1:200 -> 1:132 (A–D) with the EC math; controller rows show mismatch', () => {
    const html = render(view(fx.withWater));
    expect(html).toContain('1:132 (A–D)');
    expect(html).toContain('EC target 1.90 − source water 0.25 = 1.65 mS/cm from fertilizers');
    expect(html).toContain('×1.139 → 1:132 for every tank');
    expect(html).toMatch(/data-field="nutrients.ratio" data-match="caution"/);
    expect(html).not.toContain('data-testid="link-water-warning"');
  });

  it('viewer: sees everything, no action buttons', () => {
    const html = render(view(fx.withWater, { canEdit: false }));
    expect(html).toContain('data-testid="link-pending"');
    expect(html).not.toContain('data-testid="link-approve"');
    expect(html).not.toContain('data-testid="link-reject"');
    expect(html).not.toContain('data-testid="link-toggle"');
    expect(html).not.toContain('data-testid="link-trim-on"');
    expect(html).toContain('Only an admin or operator can approve or reject.');
  });

  it('manual mode: says nothing is proposed; approved card says it waits for the next cycle', () => {
    const manual = { ...fx.pending, mode: 'manual', pending: null };
    const html = render(view(manual));
    expect(html).toContain('data-mode="manual"');
    expect(html).toContain('data-testid="link-manual-preview"');
    const approved = { ...fx.withWater, approved: { ...fx.withWater.pending, status: 'approved', decided_by_email: 'op@farm', decided_at: '2026-09-30T06:00:00Z' }, pending: null };
    const h2 = render(view(approved));
    expect(h2).toContain('data-testid="link-approved"');
    expect(h2).toContain('waiting for the next dose cycle');
    expect(h2).not.toContain('data-testid="link-approve"'); // already approved: only reject remains
  });

  it('best fit flags elements the current stock cannot reach', () => {
    const v = JSON.parse(JSON.stringify(fx.pending));
    const mo = v.best_fit.elements.find(e => e.element === 'Mo');
    Object.assign(mo, { unreachable: true, needs_stock_change: true, reason: 'too_low_even_richest', status: 'low' });
    v.best_fit.unreachable = ['Mo'];
    const html = render(view(v));
    expect(html).toMatch(/data-element="Mo" data-state="alarm"/);
    expect(html).toContain('Needs a stock recipe change');
    expect(html).toContain('data-testid="link-bestfit-unreachable"');
  });

  it('Turkish and Arabic: translated, Western digits, same structure', () => {
    for (const lng of ['tr', 'ar']) {
      const html = render(view(fx.withWater), lng);
      expect(html).toContain('1:132 (A–D)');
      expect(html).not.toMatch(/[٠-٩۰-۹]/); // no Eastern-Arabic digits
      expect(html).not.toContain('link.');                    // no raw keys
    }
    expect(render(view(fx.withWater), 'tr')).toContain('Ürün hedeflerini izle');
    expect(render(view(fx.withWater), 'ar')).toContain('اتباع أهداف المحصول');
  });
});
