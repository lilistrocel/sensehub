import React from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { formatDuration, formatWater } from '../../i18n/format';

/**
 * Irrigation run type tag (GET /api/irrigation/runs). Not a state: neutral ink,
 * told apart by a glyph + text so it reads without colour.
 *   automated     "Scheduled" (clock)       — automation id known
 *                 "Automation" (clock)      — SenseHub sequence without an id (test / run-now)
 *   manual_app    "Manual — app" (hand) + operator
 *   manual_panel  "Manual — panel" (panel)  — dashed border: SenseHub drove nothing
 * Texts: irrigation:runType.* (English reference kept in RUN_TYPE_TEXT).
 */

export const RUN_TYPE_TEXT = { automated: 'Scheduled', manual_app: 'Manual — app', manual_panel: 'Manual — panel' };

function Glyph({ type }) {
  if (type === 'manual_app') {
    // phone
    return <svg aria-hidden="true" viewBox="0 0 12 12" className="w-3 h-3 shrink-0"><rect x="3" y="0.8" width="6" height="10.4" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" /><circle cx="6" cy="9.2" r="0.7" fill="currentColor" /></svg>;
  }
  if (type === 'manual_panel') {
    // panel with two switches
    return <svg aria-hidden="true" viewBox="0 0 12 12" className="w-3 h-3 shrink-0"><rect x="0.8" y="1.8" width="10.4" height="8.4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M4 4.2v3.6M8 4.2v3.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
  }
  // clock
  return <svg aria-hidden="true" viewBox="0 0 12 12" className="w-3 h-3 shrink-0"><circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M6 3.2V6l2 1.3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>;
}

/** Short operator label: "lilistrocel@gmail.com" -> "lilistrocel". */
export const shortUser = (email) => String(email || '').split('@')[0] || null;

/** Run type text in the active language (plain function: usable outside React). */
export function runTypeText(run, { withOperator = true, t = i18n.t.bind(i18n) } = {}) {
  if (!run) return '';
  if (run.type === 'automated') return run.automation_id ? t('irrigation:runType.scheduled') : t('irrigation:runType.automation');
  if (run.type === 'manual_app') {
    const ops = (run.operators || []).map(shortUser).filter(Boolean);
    return withOperator && ops.length
      ? t('irrigation:runType.manualAppBy', { operators: ops.join(', ') })
      : t('irrigation:runType.manualApp');
  }
  if (run.type === 'manual_panel') return t('irrigation:runType.manualPanel');
  return run.type_label || run.type || '';
}

export function RunTypeTag({ run, short = false, className = '' }) {
  const { t } = useTranslation('irrigation');
  if (!run || !run.type) return null;
  const operators = run.type === 'manual_app' ? (run.operators || []).map(shortUser).filter(Boolean) : [];
  const text = short
    ? (run.type === 'automated'
      ? (run.automation_id ? t('runType.scheduledShort') : t('runType.automationShort'))
      : run.type === 'manual_app' ? t('runType.manualAppShort') : t('runType.manualPanelShort'))
    : runTypeText(run, { t, withOperator: false });
  const title = run.type === 'manual_panel'
    ? t('runType.panelTitle')
    : run.type === 'manual_app'
      ? ((run.operators || []).length ? t('runType.appTitleBy', { operators: run.operators.join(', ') }) : t('runType.appTitle'))
      : run.automation_name || t('runType.automationTitle');
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px] font-bold uppercase tracking-label leading-4 whitespace-nowrap text-ink ${
        run.type === 'manual_panel' ? 'border-dashed border-ink/50' : 'border-ink/30'
      } ${className}`.trim()}
      data-run-type={run.type}
      title={title}
    >
      <Glyph type={run.type} />
      <span className="truncate max-w-[14rem]">
        {text}
        {/* user names are data: no Turkish/Arabic casing rules on them (lilistrocel, not LİLİSTROCEL) */}
        {!short && operators.length > 0 && <> (<span lang="en" dir="ltr">{operators.join(', ')}</span>)</>}
      </span>
    </span>
  );
}

// Text: irrigation:runStatus.<status>
const STATUS = {
  ok: { mark: 'ok', cls: 'text-ok-700 dark:text-ok-300' },
  cut_short: { mark: 'caution', cls: 'text-caution-700 dark:text-caution-300' },
  // ended by the operator's Stop irrigation button
  stopped: { mark: 'caution', cls: 'text-caution-700 dark:text-caution-300' },
  no_water: { mark: 'alarm', cls: 'text-alarm-600 dark:text-alarm-300' },
  shutdown: { mark: 'alarm', cls: 'text-alarm-600 dark:text-alarm-300' },
  manual: { mark: 'manual', cls: 'text-ink' },
  running: { mark: 'running', cls: 'text-ink' },
};

/** Run-level status: shape + colour + text. manual = hollow diamond, running = hollow circle. */
export function RunStatus({ status, compact = false }) {
  const { t } = useTranslation('irrigation');
  const known = STATUS[status];
  const s = known || { mark: 'unknown', cls: 'text-muted' };
  const text = known ? t(`runStatus.${status}`) : (status || t('relay.unknown'));
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${s.cls}`} data-run-status={status || 'unknown'}>
      <svg aria-hidden="true" viewBox="0 0 12 12" className="w-3 h-3 shrink-0">
        {s.mark === 'ok' && <path d="M1.8 6.4 4.7 9.2 10.4 2.8" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />}
        {s.mark === 'caution' && <path d="M6 1 L11.2 10.5 H0.8 Z" fill="currentColor" />}
        {s.mark === 'alarm' && <rect x="1.5" y="1.5" width="9" height="9" rx="1" fill="currentColor" />}
        {s.mark === 'manual' && <path d="M6 1.2 10.8 6 6 10.8 1.2 6Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />}
        {s.mark === 'running' && <circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.6" />}
        {s.mark === 'unknown' && <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2.2 1.6" />}
      </svg>
      {compact ? <span className="sr-only">{text}</span> : <span>{text}</span>}
    </span>
  );
}

/** Water volume in the active language: "1.23 m³" / "850 L" / "4.5 L" (src/i18n/format.js). */
export const fmtWater = (l) => formatWater(l);

/** Compact duration in the active language: "75 s" / "6 min 12 s" / "6 min". */
export const fmtDurShort = (s) => formatDuration(s, { compact: true });
