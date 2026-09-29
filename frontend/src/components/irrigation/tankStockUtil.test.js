import { describe, it, expect } from 'vitest';
import { stockDisplay, stockById } from './tankStockUtil';

describe('stockDisplay', () => {
  it('no level -> null (render "—", never a value)', () => {
    expect(stockDisplay(null)).toBeNull();
    expect(stockDisplay({ level_l: null, source: 'measured' })).toBeNull();
  });
  it('measured levels keep their state and clamp the bar', () => {
    expect(stockDisplay({ level_l: 734.8, pct: 73.5, source: 'measured', state: 'ok' })).toEqual({ level: 'ok', source: 'measured', estimated: false, pct: 73.5, width: 73.5 });
    expect(stockDisplay({ level_l: 80, pct: 8, source: 'measured', state: 'alarm' }).level).toBe('alarm');
    expect(stockDisplay({ level_l: 1200, pct: 120, source: 'measured', state: 'ok' }).width).toBe(100);
  });
  it('estimated stays flagged; manual (not metered) is never shown as a state', () => {
    const e = stockDisplay({ level_l: 910.9, pct: 91.1, source: 'estimated', state: 'ok' });
    expect(e.estimated).toBe(true);
    expect(e.level).toBe('ok');
    const m = stockDisplay({ level_l: 1000, pct: 100, source: 'manual', state: 'ok' });
    expect(m.level).toBe('unknown');
    expect(m.source).toBe('manual');
    expect(stockDisplay({ level_l: 10, pct: null, source: 'bogus', state: 'x' })).toEqual({ level: 'unknown', source: 'manual', estimated: false, pct: null, width: null });
  });
});

describe('stockById', () => {
  it('keys the API payload by tank id', () => {
    expect(stockById({ tanks: [{ tank_id: 1, level_l: 5 }, { tank_id: 4, level_l: 6 }] })).toEqual({ 1: { tank_id: 1, level_l: 5 }, 4: { tank_id: 4, level_l: 6 } });
    expect(stockById(null)).toEqual({});
  });
});
