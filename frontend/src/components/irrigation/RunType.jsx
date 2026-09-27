import React from 'react';

/**
 * Irrigation run type tag (GET /api/irrigation/runs). Not a state: neutral ink,
 * told apart by a glyph + text so it reads without colour.
 *   automated     "Scheduled" (clock)       — automation id known
 *                 "Automation" (clock)      — SenseHub sequence without an id (test / run-now)
 *   manual_app    "Manual — app" (hand) + operator
 *   manual_panel  "Manual — panel" (panel)  — dashed border: SenseHub drove nothing
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

export function runTypeText(run, { withOperator = true } = {}) {
  if (!run) return '';
  if (run.type === 'automated') return run.automation_id ? 'Scheduled' : 'Automation';
  if (run.type === 'manual_app') {
    const ops = (run.operators || []).map(shortUser).filter(Boolean);
    return withOperator && ops.length ? `Manual — app (${ops.join(', ')})` : 'Manual — app';
  }
  if (run.type === 'manual_panel') return 'Manual — panel';
  return run.type_label || run.type || '';
}

export function RunTypeTag({ run, short = false, className = '' }) {
  if (!run || !run.type) return null;
  const text = short
    ? (run.type === 'automated' ? (run.automation_id ? 'Sched' : 'Auto') : run.type === 'manual_app' ? 'App' : 'Panel')
    : runTypeText(run);
  const title = run.type === 'manual_panel'
    ? 'Run from the fertigation panel: no SenseHub pump or zone relay was ON'
    : run.type === 'manual_app' ? `Pump/zone relays switched in the app${(run.operators || []).length ? ` by ${run.operators.join(', ')}` : ''}`
      : run.automation_name || 'Run by a SenseHub automation';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px] font-bold uppercase tracking-label leading-4 whitespace-nowrap text-ink ${
        run.type === 'manual_panel' ? 'border-dashed border-ink/50' : 'border-ink/30'
      } ${className}`.trim()}
      data-run-type={run.type}
      title={title}
    >
      <Glyph type={run.type} />
      <span className="truncate max-w-[14rem]">{text}</span>
    </span>
  );
}

const STATUS = {
  ok: { mark: 'ok', text: 'ok', cls: 'text-ok-700 dark:text-ok-300' },
  cut_short: { mark: 'caution', text: 'cut short', cls: 'text-caution-700 dark:text-caution-300' },
  // ended by the operator's Stop irrigation button
  stopped: { mark: 'caution', text: 'stopped by operator', cls: 'text-caution-700 dark:text-caution-300' },
  no_water: { mark: 'alarm', text: 'no water', cls: 'text-alarm-600 dark:text-alarm-300' },
  shutdown: { mark: 'alarm', text: 'shut down', cls: 'text-alarm-600 dark:text-alarm-300' },
  manual: { mark: 'manual', text: 'manual', cls: 'text-ink' },
  running: { mark: 'running', text: 'in progress', cls: 'text-ink' },
};

/** Run-level status: shape + colour + text. manual = hollow diamond, running = hollow circle. */
export function RunStatus({ status, compact = false }) {
  const s = STATUS[status] || { mark: 'unknown', text: status || 'unknown', cls: 'text-muted' };
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
      {compact ? <span className="sr-only">{s.text}</span> : <span>{s.text}</span>}
    </span>
  );
}

export const fmtWater = (l) => {
  if (l === null || l === undefined || !Number.isFinite(Number(l))) return '—';
  const v = Number(l);
  return v >= 1000 ? `${(v / 1000).toFixed(2)} m³` : `${v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString('en-US')} L`;
};

export const fmtDurShort = (s) => {
  if (s === null || s === undefined || !Number.isFinite(Number(s))) return '—';
  const r = Math.round(Number(s));
  if (r < 90) return `${r} s`;
  const m = Math.floor(r / 60);
  const sec = r % 60;
  return sec ? `${m} min ${sec} s` : `${m} min`;
};
