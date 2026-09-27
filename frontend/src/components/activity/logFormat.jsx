import React from 'react';

/**
 * Shared presentation for the Logs page: status marks (shape + colour, per
 * docs/FARM-APP-STANDARDS.md §5), category labels, device icons, actor chips,
 * local-day grouping in the farm timezone.
 */

export const CATEGORY_LABELS = {
  irrigation: 'Irrigation',
  dosing: 'Dosing',
  climate: 'Climate',
  automations: 'Automations',
  equipment: 'Equipment',
  settings: 'Settings',
  users: 'Users',
  auth: 'Sign-in',
  alerts: 'Alerts',
  ai: 'AI',
  cameras: 'Cameras',
  lab: 'Lab',
  crops: 'Crops',
  tasks: 'Tasks',
  system: 'System',
};

export const categoryLabel = (c) => CATEGORY_LABELS[c] || (c ? c.charAt(0).toUpperCase() + c.slice(1) : '—');

/**
 * The one status signal per row. Shape carries meaning without colour:
 * square = failed / critical, triangle = refused / notable, hollow ring =
 * unconfirmed or unknown, filled dot = done / informational.
 */
export function markFor(item) {
  if (!item) return { shape: 'ring', tone: 'idle', label: 'Unknown' };
  if (item.result === 'error') return { shape: 'square', tone: 'alarm', label: item.status_code ? `Failed ${item.status_code}` : 'Failed' };
  if (item.severity === 'critical') return { shape: 'square', tone: 'alarm', label: 'Critical' };
  if (item.result === 'denied') return { shape: 'triangle', tone: 'caution', label: item.status_code ? `Refused ${item.status_code}` : 'Refused' };
  if (item.result === 'unconfirmed') return { shape: 'ring', tone: 'caution', label: 'Unconfirmed' };
  if (item.severity === 'warning') return { shape: 'triangle', tone: 'caution', label: 'Notable' };
  if (item.result === 'ok') return { shape: 'dot', tone: 'ok', label: 'Done' };
  if (item.severity === 'info') return { shape: 'dot', tone: 'idle', label: 'Info' };
  return { shape: 'ring', tone: 'idle', label: 'Unknown' };
}

const TONE_TEXT = {
  alarm: 'text-state-alarm',
  caution: 'text-state-caution',
  ok: 'text-state-ok',
  idle: 'text-state-idle',
};

export function StatusMark({ mark, className = '', withLabel = false }) {
  const tone = TONE_TEXT[mark.tone] || TONE_TEXT.idle;
  let glyph;
  if (mark.shape === 'square') glyph = <rect x="2" y="2" width="10" height="10" rx="1" fill="currentColor" />;
  else if (mark.shape === 'triangle') glyph = <path d="M7 1.5 L13 12.5 H1 Z" fill="currentColor" />;
  else if (mark.shape === 'ring') glyph = <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="2" />;
  else glyph = <circle cx="7" cy="7" r="5" fill="currentColor" />;
  return (
    <span className={`inline-flex items-center gap-1.5 shrink-0 ${className}`.trim()} title={mark.label} data-mark={mark.shape} data-tone={mark.tone}>
      <svg viewBox="0 0 14 14" width="14" height="14" className={tone} aria-hidden="true">{glyph}</svg>
      {withLabel ? <span className="text-xs font-semibold text-ink">{mark.label}</span> : <span className="sr-only">{mark.label}</span>}
    </span>
  );
}

/** Device icon from the short label the backend stores. */
export function deviceKind(device) {
  const d = String(device || '');
  if (/panel/i.test(d)) return 'panel';
  if (/phone|iPhone/i.test(d)) return 'phone';
  if (/tablet|iPad/i.test(d)) return 'tablet';
  if (/script/i.test(d)) return 'script';
  if (/PC|Mac|Chromebook|browser/i.test(d)) return 'desktop';
  return null;
}

const DEVICE_PATHS = {
  phone: 'M8 2h8a2 2 0 012 2v16a2 2 0 01-2 2H8a2 2 0 01-2-2V4a2 2 0 012-2zm3 17h2',
  tablet: 'M6 2h12a2 2 0 012 2v16a2 2 0 01-2 2H6a2 2 0 01-2-2V4a2 2 0 012-2zm5 17h2',
  desktop: 'M3 5a2 2 0 012-2h14a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V5zm5 15h8m-4-4v4',
  script: 'M8 9l-4 3 4 3m8-6l4 3-4 3M14 5l-4 14',
  panel: 'M4 4h16v16H4zM9 9v6m6-6v6',
};

export function DeviceIcon({ device, className = '' }) {
  const kind = deviceKind(device);
  if (!kind) return null;
  return (
    <span className={`inline-flex items-center gap-1 text-muted ${className}`.trim()} title={device}>
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={DEVICE_PATHS[kind]} />
      </svg>
      <span className="sr-only">{device}</span>
    </span>
  );
}

/** "lilistrocel" from "lilistrocel@gmail.com". */
export const shortEmail = (e) => (e ? String(e).split('@')[0] : null);

export function ActorChip({ item, className = '' }) {
  const isUser = item.actor_type === 'user';
  const label = isUser
    ? (shortEmail(item.actor_email) || item.actor_label || 'Unknown user')
    : (item.actor_label || 'System');
  const unknown = isUser && !item.actor_email;
  return (
    <span
      className={`inline-flex items-center gap-1.5 min-w-0 max-w-full rounded-full border px-2 py-0.5 text-xs font-semibold ${
        isUser
          ? (unknown ? 'border-dashed border-line text-muted bg-panel' : 'border-brand-200 dark:border-brand-700 text-brand-700 dark:text-brand-200 bg-brand-50 dark:bg-brand-900/40')
          : 'border-line text-muted bg-field'
      } ${className}`.trim()}
      title={isUser ? (item.actor_email || item.actor_label || 'Unknown user') : item.actor_label}
      data-actor-type={item.actor_type}
    >
      {isUser ? (
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" /></svg>
      ) : (
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><rect x="5" y="7" width="14" height="11" rx="2" /><path d="M12 3v4M9 12h.01M15 12h.01" /></svg>
      )}
      <span className="truncate">{label}</span>
    </span>
  );
}

export function CategoryTag({ category }) {
  return (
    <span className="inline-flex items-center rounded border border-line px-1.5 py-px text-[11px] font-bold uppercase tracking-[.08em] text-muted whitespace-nowrap">
      {categoryLabel(category)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Time in the farm timezone
// ---------------------------------------------------------------------------

export function localDayKey(iso, tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  } catch (_) { return String(iso).slice(0, 10); }
}

export function dayHeading(dayKey, tz) {
  const today = localDayKey(new Date().toISOString(), tz);
  const yesterday = localDayKey(new Date(Date.now() - 86400e3).toISOString(), tz);
  if (dayKey === today) return 'Today';
  if (dayKey === yesterday) return 'Yesterday';
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: y !== new Date().getFullYear() ? 'numeric' : undefined, timeZone: 'UTC' })
    .format(new Date(Date.UTC(y, m - 1, d)));
}

export function timeOfDay(iso, tz) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  } catch (_) { return String(iso).slice(11, 19); }
}

export function fullTime(iso, tz) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
    }).format(new Date(iso));
  } catch (_) { return iso; }
}

export function fmtDuration(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const s = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Group sorted items into [{ day, heading, items }] in the farm timezone. */
export function groupByDay(items, tz) {
  const out = [];
  for (const it of items) {
    const day = localDayKey(it.time, tz);
    let g = out[out.length - 1];
    if (!g || g.day !== day) { g = { day, heading: dayHeading(day, tz), items: [] }; out.push(g); }
    g.items.push(it);
  }
  return out;
}

/** Short "count" badge text for grouped rows. */
export function countBadge(item) {
  if (item.repeat_count > 1) return `×${item.repeat_count}`;
  if (item.source === 'relay' && item.count > 1) return `${item.count} writes`;
  if (item.count > 1) return `×${item.count}`;
  return null;
}
