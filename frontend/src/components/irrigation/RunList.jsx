import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import LastCycleZones from '../LastCycleZones';
import { formatClock } from '../../i18n/format';
import { RunTypeTag, RunStatus, fmtWater, fmtDurShort } from './RunType';

/**
 * Compact list of irrigation runs (dashboard "Today's runs"): time, type,
 * water, status; a row expands to that run's per-zone table. Read-only.
 * Oldest first, like the day reads. Rows are >= 32 px touch targets.
 */
export default function RunList({ runs, formatTime, highlightId = null, emptyText, className = '' }) {
  const { t } = useTranslation('irrigation');
  const [open, setOpen] = useState(null);
  const list = [...(runs || [])].sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
  if (!list.length) return <p className={`text-sm text-muted ${className}`}>{emptyText ?? t('runs.emptyToday')}</p>;
  const when = (iso) => (iso ? (formatTime ? formatTime(iso) : formatClock(iso)) : '—');
  return (
    <ul className={`divide-y divide-line border-y border-line ${className}`} data-testid="run-list">
      {list.map((r) => {
        const id = r.id ?? r.key;
        const isOpen = open === id;
        return (
          <li key={id} data-testid="run-list-row" data-run-type={r.type} data-run-status={r.status} data-current={highlightId !== null && highlightId === r.id ? 'true' : undefined}>
            <button
              type="button"
              className="w-full min-h-[36px] flex items-center gap-2 py-1 text-start text-sm"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : id)}
            >
              <svg aria-hidden="true" viewBox="0 0 10 10" className={`w-2.5 h-2.5 shrink-0 text-muted transition-transform ${isOpen ? 'rotate-90' : 'rtl:-scale-x-100'}`}><path d="M3 1.5 7 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
              <span className="font-mono tabular text-ink shrink-0 whitespace-nowrap">{when(r.started_at)}</span>
              <span className="min-w-0 flex-1 flex items-center gap-1.5">
                <RunTypeTag run={r} short className="sm:hidden" />
                <RunTypeTag run={r} className="hidden sm:inline-flex" />
                {r.uncontrolled_dosing && (
                  <span className="inline-flex items-center text-caution-700 dark:text-caution-300" title={t('runs.uncontrolledDosing')}>
                    <svg aria-hidden="true" viewBox="0 0 12 12" className="w-3 h-3"><path d="M6 1 L11.2 10.5 H0.8 Z" fill="currentColor" /></svg>
                    <span className="sr-only">{t('runs.uncontrolledDosing')}</span>
                  </span>
                )}
              </span>
              <span className="hidden sm:inline font-mono tabular text-xs text-muted">{fmtDurShort(r.duration_s)}</span>
              <span className="font-mono tabular text-ink text-end shrink-0 whitespace-nowrap" dir="ltr">{fmtWater(r.water_l)}</span>
              <span className="w-[5.25rem] shrink-0 flex justify-end whitespace-nowrap"><RunStatus status={r.status} /></span>
            </button>
            {isOpen && (
              <div className="pb-2 ps-4">
                <LastCycleZones run={r} formatTime={formatTime} compact />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
