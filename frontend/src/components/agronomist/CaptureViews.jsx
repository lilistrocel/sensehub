import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '../../i18n/useFormat';
import { StatusPill } from '../../ui';

// Why a view has no image: agronomist:views.status.<status>.
const VIEW_STATUSES = ['missing', 'goto_failed', 'capture_failed', 'auth_stopped', 'not_attempted', 'missing_file'];

/**
 * Build the view list from what the backend gave us: the session's views (incl. the
 * missing ones) when present, else one view per frame (preset_name / sequence).
 */
export function viewsFrom({ views, frames = [] }) {
  const byId = new Map(frames.map(f => [f.id, f]));
  if (Array.isArray(views) && views.length) {
    return views.map(v => ({
      index: v.index,
      name: v.name,
      presetId: v.preset_id ?? null,
      status: v.status === 'ok' && v.capture_id != null && byId.has(v.capture_id) ? 'ok' : (v.status === 'ok' ? 'missing_file' : v.status),
      frame: v.capture_id != null ? byId.get(v.capture_id) || null : null,
      quality: v.quality || null,
    }));
  }
  return [...frames]
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
    .map(f => ({ index: f.sequence, name: f.preset_name || null, presetId: f.preset_id ?? null, status: 'ok', frame: f, quality: null }));
}

/**
 * Canopy views as tabs: one tab per camera preset ("Agronomist 1/2/3"), the selected
 * view's image full width underneath with preset, time and sharpness. A view that was
 * not captured keeps its tab and says why — it is never filled with another image.
 */
export default function CaptureViews({ views, frames = [], className = '' }) {
  const { t } = useTranslation('agronomist');
  const fmt = useFormat();
  const list = useMemo(() => viewsFrom({ views, frames }), [views, frames]);
  const firstOk = Math.max(0, list.findIndex(v => v.status === 'ok'));
  const [sel, setSel] = useState(firstOk);
  if (!list.length) return null;
  const cur = list[Math.min(sel, list.length - 1)];
  const captured = list.filter(v => v.status === 'ok').length;
  const label = v => v.name || t('canopyViews.viewN', { n: v.index });

  return (
    <div className={`min-w-0 ${className}`.trim()} data-testid="capture-views">
      {captured < list.length && (
        <p className="text-xs text-caution-700 dark:text-caution-300 mb-2" data-testid="views-incomplete">
          {t('canopyViews.incomplete', { captured, total: list.length })}
        </p>
      )}
      {/* up to 3 views share one row (fits 390 px); more would scroll */}
      <div
        role="tablist"
        aria-label={t('canopyViews.tablist')}
        className={list.length <= 3 ? 'grid gap-1' : 'flex gap-1 overflow-x-auto pb-1'}
        style={list.length <= 3 ? { gridTemplateColumns: `repeat(${list.length}, minmax(0, 1fr))` } : undefined}
      >
        {list.map((v, i) => {
          const active = v === cur;
          const ok = v.status === 'ok';
          return (
            <button
              key={`${v.index}-${v.name}`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-label={t('canopyViews.tabAria', { n: v.index, name: label(v) })}
              onClick={() => setSel(i)}
              className={`min-w-0 inline-flex items-center justify-center gap-1 sm:gap-1.5 rounded-md border px-1.5 sm:px-2.5 py-1.5 text-[11px] sm:text-xs font-semibold whitespace-nowrap ${list.length > 3 ? 'shrink-0' : ''} ${active ? 'border-ink text-ink bg-panel' : 'border-line text-muted hover:text-ink'}`}
              data-view-index={v.index}
              data-view-status={v.status}
            >
              <span
                aria-hidden="true"
                className={`inline-block w-2 h-2 border-2 ${ok ? 'rounded-full bg-state-ok border-state-ok' : 'bg-transparent border-state-caution'}`}
              />
              <span className="truncate">{label(v)}</span>
            </button>
          );
        })}
      </div>
      <div role="tabpanel" className="mt-2" data-testid="capture-view-panel">
        {cur.status === 'ok' && cur.frame ? (
          <figure>
            <a href={cur.frame.image_url} target="_blank" rel="noopener noreferrer" title={t('canopyViews.openFull')}>
              <img
                src={cur.frame.image_url}
                alt={t('canopyViews.imageAlt', { name: label(cur) })}
                className="w-full max-h-[60vh] object-contain rounded-md border border-line bg-gray-100 dark:bg-gray-900"
              />
            </a>
            <figcaption className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              <span>{t('canopyViews.viewOf', { n: cur.index, total: list.length })}</span>
              {cur.presetId != null && <span className="font-mono">{t('canopyViews.presetId', { id: cur.presetId })}</span>}
              {cur.frame.captured_at && <span className="font-mono">{fmt.time(cur.frame.captured_at, { fallback: '' })}</span>}
              <span className="font-mono" title={t('capture.sharpnessTitle')}>
                {t('canopyViews.sharpness', { value: cur.frame.sharpness == null ? t('capture.notAvailable') : Math.round(cur.frame.sharpness) })}
              </span>
              {cur.quality && <StatusPill state="caution" text={t('canopyViews.poorQuality')} className="!px-1.5 !py-0 !text-[10px]" />}
            </figcaption>
          </figure>
        ) : (
          <div className="rounded-md border border-dashed border-line px-3 py-6 text-sm text-muted" data-testid="capture-view-missing">
            <div className="font-semibold text-ink">{t('canopyViews.notCaptured', { name: label(cur) })}</div>
            <div className="mt-1">
              {VIEW_STATUSES.includes(cur.status) ? t(`canopyViews.status.${cur.status}`, { name: label(cur) }) : t('canopyViews.status.unknown')}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
