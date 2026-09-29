import { describe, it, expect } from 'vitest';
import { shapeOf, railOf, targetStages, stageDate, parseNum, diffFields, invalidField, isStaleAdvice, ppmDecimals, warningState, ecCorrespondenceState } from './nutritionUtil';

describe('nutritionUtil', () => {
  it('status → shape: unknown never renders as ok, severity picks triangle vs square', () => {
    expect(shapeOf('ok')).toBe('ok');
    expect(shapeOf('low', 'caution')).toBe('caution');
    expect(shapeOf('high', 'alarm')).toBe('alarm');
    expect(shapeOf('unknown')).toBe('unknown');
    expect(shapeOf(undefined)).toBe('unknown');
    expect(shapeOf('caution')).toBe('caution');
    expect(railOf('bogus')).toBe('idle');
    expect(warningState('critical')).toBe('alarm');
    expect(warningState('info')).toBe('idle');
  });

  it('stages with targets in growth order; timeline dates', () => {
    const p = { stage_targets: { fruiting: {}, vegetative: {} }, element_targets: { flowering: [] }, stage_timeline: [] };
    expect(targetStages(p)).toEqual(['vegetative', 'flowering', 'fruiting']);
    expect(targetStages(null)).toEqual([]);
    expect(stageDate('2026-09-07', 25)).toBe('2026-10-02');
    expect(stageDate(null, 25)).toBeNull();
  });

  it('numbers: blank → null, comma decimal accepted, junk → NaN; diff only sends changes', () => {
    expect(parseNum('')).toBeNull();
    expect(parseNum('2,5')).toBe(2.5);
    expect(Number.isNaN(parseNum('abc'))).toBe(true);
    const orig = { plants_per_section: 4300, source_water_ec: null, variety: 'S13-06 F1' };
    expect(diffFields(orig, { plants_per_section: '4300', source_water_ec: '0.4', variety: 'S13-06 F1' }, ['plants_per_section', 'source_water_ec']))
      .toEqual({ source_water_ec: 0.4 });
    expect(diffFields(orig, { variety: '' }, [])).toEqual({ variety: null });
    expect(invalidField({ a: '1', b: 'x' }, ['a', 'b'])).toBe('b');
  });

  it('advice older than 8 days is stale; micro elements get more decimals', () => {
    const now = Date.parse('2026-09-28T12:00:00Z');
    expect(isStaleAdvice('2026-09-27T12:00:00Z', now)).toBe(false);
    expect(isStaleAdvice('2026-09-19T12:00:00Z', now)).toBe(true);
    expect(ppmDecimals('N')).toBe(1);
    expect(ppmDecimals('Fe')).toBe(2);
    expect(ppmDecimals('Mo')).toBe(3);
  });
});

describe('ecCorrespondenceState (element targets vs the input EC target)', () => {
  it('ok within ±0.05 mS/cm, caution outside, unknown when a side is missing', () => {
    expect(ecCorrespondenceState({ total_ec_ms_cm: 1.9 }, 1.9)).toBe('ok');
    expect(ecCorrespondenceState({ total_ec_ms_cm: 1.86 }, 1.9)).toBe('ok');
    expect(ecCorrespondenceState({ total_ec_ms_cm: 1.45 }, 1.9)).toBe('caution');
    expect(ecCorrespondenceState({ total_ec_ms_cm: 1.45 }, null)).toBe('unknown');
    expect(ecCorrespondenceState(null, 1.9)).toBe('unknown');
    expect(ecCorrespondenceState({ total_ec_ms_cm: null }, 1.9)).toBe('unknown');
  });
});
