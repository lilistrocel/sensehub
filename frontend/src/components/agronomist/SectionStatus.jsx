import React from 'react';
import { useTranslation } from 'react-i18next';
import { StatusPill } from '../../ui';

/**
 * Section / key-number status for structured agronomist reports.
 * Status is shape + colour + text (FARM-APP-STANDARDS): ok = filled circle,
 * caution = triangle, alarm = square, unknown = dashed hollow circle in the
 * neutral colour — never green, so "no data" can't read as "fine".
 * `text` is the English reference; the UI shows common:state.<key>.
 */
export const SECTION_STATUS = {
  ok: { pill: 'ok', filled: true, rail: 'ok', text: 'ok' },
  caution: { pill: 'caution', filled: true, rail: 'caution', text: 'caution' },
  alarm: { pill: 'alarm', filled: true, rail: 'alarm', text: 'alarm' },
  unknown: { pill: 'idle', filled: false, rail: 'idle', text: 'unknown' },
};

export const statusOf = (s) => (SECTION_STATUS[s] ? s : 'unknown');

const COLOR = {
  ok: 'text-state-ok',
  caution: 'text-state-caution',
  alarm: 'text-state-alarm',
  unknown: 'text-state-idle',
};

/** Small inline shape; `label` adds screen-reader text ("status: caution"). */
export function StatusMark({ status, label = true, className = '' }) {
  const { t } = useTranslation('agronomist');
  const s = statusOf(status);
  return (
    <span className={`inline-flex items-center shrink-0 ${COLOR[s]} ${className}`} data-status={s}>
      <svg aria-hidden="true" viewBox="0 0 12 12" className="w-3 h-3">
        {s === 'ok' && <circle cx="6" cy="6" r="5" fill="currentColor" />}
        {s === 'caution' && <path d="M6 1 L11.2 10.5 H0.8 Z" fill="currentColor" />}
        {s === 'alarm' && <rect x="1.5" y="1.5" width="9" height="9" rx="1" fill="currentColor" />}
        {s === 'unknown' && <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2.2 1.6" />}
      </svg>
      {label && <span className="sr-only">{t('sectionStatus.srLabel', { status: t(`common:state.${s}`) })}</span>}
    </span>
  );
}

export function SectionStatusPill({ status, className = '' }) {
  const { t } = useTranslation('agronomist');
  const s = statusOf(status);
  const cfg = SECTION_STATUS[s];
  return (
    <StatusPill
      state={cfg.pill}
      filled={cfg.filled}
      text={t(`common:state.${s}`)}
      className={`${s === 'unknown' ? '!border-dashed' : ''} ${className}`.trim()}
      data-section-status={s}
    />
  );
}
