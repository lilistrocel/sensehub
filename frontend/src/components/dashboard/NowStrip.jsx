import React from 'react';
import { useTranslation } from 'react-i18next';
import { Kpi } from '../../ui';
import { isStale } from '../../utils/freshness';
import { CLIMATE_BANDS, CLIMATE_TILES, STALE_FACTOR } from './constants';

/** Rail for a climate tile: caution when stale, alarm when outside its band, else idle. */
export function climateRail(tile) {
  if (!tile || tile.stale || tile.value === null || tile.value === undefined) return 'stale';
  const band = CLIMATE_BANDS[tile.key];
  if (band) {
    if (band.min !== undefined && tile.value < band.min) return 'alarm';
    if (band.max !== undefined && tile.value > band.max) return 'alarm';
  }
  return 'idle';
}

/**
 * The "Now" strip: 12 climate readings from status-board.climate. A stale or
 * missing reading renders as an em dash with a dashed caution rail - never a
 * number (rule 4.1).
 */
export default function NowStrip({ climate = [], formatSince, now = Date.now() }) {
  const { t } = useTranslation('dashboard');
  const byKey = new Map((climate || []).map((c) => [c.key, c]));
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3" data-testid="now-strip">
      {CLIMATE_TILES.map((spec) => {
        const tile = byKey.get(spec.key);
        const stale = !tile || tile.stale || isStale(tile.ts, tile.pollMs, STALE_FACTOR, now);
        const unknown = !tile || tile.value === null || tile.value === undefined || !tile.ts;
        const rail = stale ? 'stale' : climateRail(tile);
        const hint = stale && !unknown && formatSince ? t('now.notReportedSince', { time: formatSince(tile.ts) }) : null;
        return (
          <Kpi
            key={spec.key}
            label={t(`climate.${spec.key}`, { defaultValue: spec.label })}
            rail={rail}
            padding="sm"
            value={unknown ? null : tile.value}
            unit={tile?.unit || undefined}
            precision={spec.precision}
            unknown={unknown}
            stale={!unknown && stale}
            since={tile?.ts}
            hint={hint}
            data-testid={`kpi-${spec.key}`}
          />
        );
      })}
    </div>
  );
}
