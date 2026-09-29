import React from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '../../i18n/useFormat';
import { stockDisplay } from './tankStockUtil';

/**
 * Stock level of one fertigation tank (TankStockService view from /api/fertigation/tanks
 * or /api/fertigation/tanks/stock). Requirement 2026-09-29: the level counts down from
 * the monitor-measured litres of every irrigation cycle since the last refill.
 *
 * Never renders absence or a guess as a measurement (FARM-APP-STANDARDS 4.1):
 *   measured   solid bar, state colour + glyph shape (dot ok / triangle caution / square alarm)
 *   estimated  striped bar + "estimated" tag (pH Down: valve time x L/min, never an alarm)
 *   manual     hollow bar, "not metered" (the level only changes with a refill / correction)
 *   no data    "—"
 * An unmetered stretch before the monitor's history (e.g. the refill was before the
 * monitor came online) is spelled out: the real level is lower than shown.
 * Strings: `irrigation` namespace (`stock.*`), shared by Fertigation, the dashboard and
 * Crop & Nutrition.
 */

export function StockGlyph({ level = 'unknown', className = '' }) {
  const common = `inline-block shrink-0 w-2.5 h-2.5 ${className}`;
  if (level === 'alarm') return <svg aria-hidden="true" viewBox="0 0 10 10" className={common}><rect x="1" y="1" width="8" height="8" className="fill-state-alarm" /></svg>;
  if (level === 'caution') return <svg aria-hidden="true" viewBox="0 0 10 10" className={common}><path d="M5 0.8 9.6 9.2H0.4Z" className="fill-state-caution" /></svg>;
  if (level === 'ok') return <svg aria-hidden="true" viewBox="0 0 10 10" className={common}><circle cx="5" cy="5" r="4" className="fill-state-ok" /></svg>;
  return <svg aria-hidden="true" viewBox="0 0 10 10" className={common}><circle cx="5" cy="5" r="3.5" className="fill-none stroke-state-idle" strokeWidth="1.5" strokeDasharray="2 1.5" /></svg>;
}

const FILL = {
  ok: 'bg-state-ok',
  caution: 'bg-state-caution',
  alarm: 'bg-state-alarm',
  unknown: 'bg-state-idle',
};
const STRIPES = { backgroundImage: 'repeating-linear-gradient(135deg, rgba(255,255,255,0.55) 0 3px, transparent 3px 6px)' };

function Bar({ d, className = '', label }) {
  const fill = FILL[d.level] || FILL.unknown;
  return (
    <div
      className={`relative overflow-hidden rounded-full ${d.source === 'manual' ? 'border border-state-idle bg-transparent' : 'bg-line'} ${className}`}
      role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={d.pct ?? undefined} aria-label={label}
      data-stock-level={d.level} data-stock-source={d.source}
    >
      {d.width !== null && (
        <div className={`h-full ${d.source === 'manual' ? 'bg-state-idle/40' : fill}`} style={{ width: `${d.width}%`, ...(d.estimated ? STRIPES : null) }} />
      )}
    </div>
  );
}

/** Full view (Fertigation tanks tab). */
export default function TankStock({ stock, tankLabel = '' }) {
  const { t } = useTranslation('irrigation');
  const fmt = useFormat();
  const d = stockDisplay(stock);
  if (!d) {
    return <p className="text-xs text-muted" data-testid="tank-stock">{t('stock.label')}: —</p>;
  }
  const L = (v) => fmt.withUnit(v, 'L', { decimals: 0 });
  const anchorDate = stock.anchor ? fmt.date(stock.anchor.at) : null;
  return (
    <div data-testid="tank-stock" data-state={d.level}>
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-xs mb-1">
        <span className="inline-flex items-center gap-1.5 text-muted">
          {t('stock.label')}
          <span className={`rounded border px-1 py-px text-[10px] font-semibold ${d.estimated ? 'border-caution-300 text-caution-700 dark:border-caution-700 dark:text-caution-300' : d.source === 'manual' ? 'border-line text-muted' : 'border-water-300 text-water-700 dark:border-water-700 dark:text-water-300'}`}
            title={t(`stock.sourceTitle.${d.source}`)} data-source={d.source}>
            {t(`stock.source.${d.source}`)}
          </span>
        </span>
        <span className="font-mono tabular text-ink" dir="ltr">
          {d.estimated ? '≈ ' : ''}{L(stock.level_l)}{stock.capacity_l ? <span className="text-muted"> / {L(stock.capacity_l)}</span> : null}
          {stock.pct !== null && stock.pct !== undefined ? <span className="text-muted"> · {fmt.percent(stock.pct)}</span> : null}
        </span>
      </div>
      <Bar d={d} className="h-2 w-full" label={t('stock.aria', { tank: tankLabel, pct: stock.pct !== null && stock.pct !== undefined ? fmt.percent(stock.pct) : '—' })} />
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
        <span className={`inline-flex items-center gap-1 ${d.level === 'alarm' ? 'text-alarm-700 dark:text-alarm-300 font-semibold' : d.level === 'caution' ? 'text-caution-700 dark:text-caution-300 font-semibold' : 'text-muted'}`}>
          <StockGlyph level={d.level} />
          {d.level === 'caution' || d.level === 'alarm' ? t(`stock.state.${d.level}`) : null}
          {d.level === 'ok' ? t('stock.state.ok') : null}
          {d.level === 'unknown' ? t(d.source === 'manual' ? 'stock.state.notMetered' : 'stock.state.unknown') : null}
        </span>
        {d.source !== 'manual' && (
          stock.days_left !== null && stock.days_left !== undefined ? (
            <span className="text-ink" data-testid="tank-stock-days">
              {t('stock.daysLeft', { days: fmt.number(stock.days_left, { decimals: stock.days_left < 10 ? 1 : 0 }) })}
              {stock.avg_daily_l !== null && stock.avg_daily_l !== undefined && (
                <span className="text-muted"> · {t('stock.useRate', { rate: fmt.withUnit(stock.avg_daily_l, 'L', { decimals: 1 }), days: fmt.number(stock.avg_span_days, { decimals: 0 }) })}</span>
              )}
            </span>
          ) : <span className="text-muted" data-testid="tank-stock-days">{t('stock.useUnknown')}</span>
        )}
      </div>
      <p className="mt-0.5 text-[11px] text-muted">
        {d.source === 'measured' && anchorDate && t(stock.anchor.kind === 'refill' ? 'stock.basis.measuredRefill' : 'stock.basis.measuredSet', { date: anchorDate, used: L(stock.used_since_anchor_l) })}
        {d.source === 'estimated' && t('stock.basis.estimated', { used: L(stock.estimated_since_anchor_l) })}
        {d.source === 'manual' && t('stock.basis.manual')}
      </p>
      {stock.unmetered_gap && (
        <p className="mt-0.5 text-[11px] text-caution-700 dark:text-caution-300 inline-flex items-start gap-1" data-testid="tank-stock-gap">
          <StockGlyph level="caution" className="mt-0.5" />
          <span>
            {stock.unmetered_gap.dose_cycles
              ? t('stock.gap', { from: fmt.dateTime(stock.unmetered_gap.from), to: stock.unmetered_gap.to ? fmt.dateTime(stock.unmetered_gap.to) : '—', count: stock.unmetered_gap.dose_cycles })
              : t('stock.gapNoCount', { from: fmt.dateTime(stock.unmetered_gap.from), to: stock.unmetered_gap.to ? fmt.dateTime(stock.unmetered_gap.to) : '—' })}
          </span>
        </p>
      )}
    </div>
  );
}

/** One line: glyph + small bar + "73 % · ≈ 11 d" (dashboard dosing rows, Crop & Nutrition table). */
export function TankStockCompact({ stock, tankLabel = '', className = '' }) {
  const { t } = useTranslation('irrigation');
  const fmt = useFormat();
  const d = stockDisplay(stock);
  if (!d) return <span className={`text-[11px] text-muted ${className}`} data-testid="tank-stock-compact">—</span>;
  const pct = stock.pct !== null && stock.pct !== undefined ? fmt.percent(stock.pct) : '—';
  const title = [
    `${t('stock.label')}: ${d.estimated ? '≈ ' : ''}${fmt.withUnit(stock.level_l, 'L', { decimals: 0 })}${stock.capacity_l ? ` / ${fmt.withUnit(stock.capacity_l, 'L', { decimals: 0 })}` : ''}`,
    t(`stock.source.${d.source}`),
    d.level === 'caution' || d.level === 'alarm' ? t(`stock.state.${d.level}`) : null,
    stock.unmetered_gap ? t('stock.gapShort') : null,
  ].filter(Boolean).join(' · ');
  return (
    <span className={`flex flex-wrap items-center gap-x-1.5 gap-y-0.5 min-w-0 ${className}`} title={title} data-testid="tank-stock-compact" data-state={d.level} data-source={d.source}>
      <StockGlyph level={d.level} />
      <Bar d={d} className="h-1.5 w-10 shrink-0" label={t('stock.aria', { tank: tankLabel, pct })} />
      <span className={`font-mono tabular text-[11px] whitespace-nowrap ${d.level === 'alarm' ? 'text-alarm-700 dark:text-alarm-300 font-semibold' : d.level === 'caution' ? 'text-caution-700 dark:text-caution-300 font-semibold' : 'text-muted'}`} dir="ltr">
        {d.estimated ? '≈' : ''}{pct}
      </span>
      {d.source !== 'manual' && stock.days_left !== null && stock.days_left !== undefined && (
        <span className="text-[11px] text-muted whitespace-nowrap">{t('stock.daysShort', { days: fmt.number(stock.days_left, { decimals: stock.days_left < 10 ? 1 : 0 }) })}</span>
      )}
      {d.estimated && <span className="text-[10px] text-caution-700 dark:text-caution-300 whitespace-nowrap">{t('stock.source.estimated')}</span>}
    </span>
  );
}
