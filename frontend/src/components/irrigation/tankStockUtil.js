/**
 * Pure derivation for <TankStock>: how a stock view (TankStockService) is shown.
 * Returns null when there is no level at all (render "—", never a fake value).
 *   level     'ok' | 'caution' | 'alarm' | 'unknown'  (glyph shape + colour)
 *   width     bar fill 0-100 (null = no bar fill)
 *   source    'measured' | 'estimated' | 'manual'
 *   estimated true for the pH Down line (valve time x L/min)
 */
export function stockDisplay(stock) {
  if (!stock || stock.level_l === null || stock.level_l === undefined || !Number.isFinite(Number(stock.level_l))) return null;
  const source = ['measured', 'estimated', 'manual'].includes(stock.source) ? stock.source : 'manual';
  const pct = stock.pct !== null && stock.pct !== undefined && Number.isFinite(Number(stock.pct)) ? Number(stock.pct) : null;
  const level = source === 'manual' ? 'unknown' : (['ok', 'caution', 'alarm'].includes(stock.state) ? stock.state : 'unknown');
  return {
    level,
    source,
    estimated: source === 'estimated',
    pct,
    width: pct === null ? null : Math.max(0, Math.min(100, pct)),
  };
}

/** Stock views keyed by tank id (from /api/fertigation/tanks/stock). */
export function stockById(payload) {
  const out = {};
  for (const v of (payload && Array.isArray(payload.tanks) ? payload.tanks : [])) {
    if (v && v.tank_id !== undefined) out[v.tank_id] = v;
  }
  return out;
}
