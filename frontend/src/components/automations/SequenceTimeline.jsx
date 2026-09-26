import React from 'react';
import { Card, Label, StatusPill } from '../../ui';
import { formatClock, formatDuration } from './automationSummary';

/** Caution is a triangle (docs/FARM-APP-STANDARDS.md §5: status = shape + colour). */
function CautionTriangle({ className = '' }) {
  return (
    <svg viewBox="0 0 12 12" className={`inline-block h-3 w-3 shrink-0 ${className}`} aria-hidden="true">
      <path d="M6 1 L11.5 11 H0.5 Z" className="fill-state-caution" />
    </svg>
  );
}

const pct = (v, scale) => `${Math.max(0, Math.min(100, (v / scale) * 100))}%`;

function timeText(item) {
  if (item.kind === 'point') return `${String(item.action || 'off').toUpperCase()} at ${formatClock(item.start)}`;
  if (item.end === null) return `${formatClock(item.start)} → until off`;
  return `${formatClock(item.start)}–${formatClock(item.end)}`;
}

/** One segment: as before. Several (e.g. pumps once per zone): "4× 4:30 · 0:03–18:30". */
function rowTimeText(row) {
  if (row.segments.length === 1) return timeText(row.segments[0]);
  const bars = row.segments.filter(s => s.kind === 'bar');
  const durs = new Set(bars.map(s => (s.end === null ? 'open' : Math.round(s.end - s.start))));
  const each = bars.length === row.segments.length && durs.size === 1 && !durs.has('open')
    ? `${row.segments.length}× ${formatClock([...durs][0])}`
    : `${row.segments.length} windows`;
  const end = row.end === null ? ' → until off' : `–${formatClock(row.end)}`;
  return `${each} · ${formatClock(row.start)}${end}`;
}

/**
 * Read-only preview of when each relay action runs, measured from the
 * trigger. Flags (never blocks) a feed pump running with no zone open and
 * zones on one board overlapping.
 */
export default function SequenceTimeline({ sequence }) {
  if (!sequence || !sequence.show) return null;
  const { items, total, openEnded, scaleEnd, gaps, overlaps, pumpCovered } = sequence;
  const rows = sequence.rows || items.map(i => ({ key: i.key, eqId: i.eqId, eqName: i.eqName, label: i.label, stagger: i.stagger, segments: [i], start: i.start, end: i.end }));
  const multiEquipment = new Set(items.map(i => i.eqId)).size > 1;
  const issues = gaps.length + overlaps.length;

  // Caution overlays per row, in seconds.
  const flagged = new Map();
  const flag = (key, start, end) => {
    if (!flagged.has(key)) flagged.set(key, []);
    flagged.get(key).push({ start, end: end === null ? scaleEnd : end });
  };
  for (const g of gaps) for (const k of g.pumps) flag(k, g.start, g.end);
  for (const o of overlaps) { flag(o.a, o.start, o.end); flag(o.b, o.start, o.end); }

  return (
    <Card padding="sm" rail={issues ? 'caution' : null} data-testid="sequence-timeline" className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <Label>Sequence from trigger</Label>
        <span className="text-xs text-muted" data-testid="sequence-total">
          Total <span className="font-mono tabular text-ink">{formatClock(total)}</span>
          {openEnded && <span> · some channels stay on until turned off</span>}
        </span>
      </div>

      <ol className="space-y-1.5">
        {rows.map((row) => {
          const label = multiEquipment ? `${row.eqName} · ${row.label}` : row.label;
          const overlays = row.segments.flatMap(s => flagged.get(s.key) || []);
          return (
            <li
              key={row.key}
              className="grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[9rem_minmax(0,1fr)_9.5rem] items-center gap-x-2 gap-y-0.5"
              data-testid="sequence-row"
            >
              <span className="text-xs text-ink truncate flex items-center gap-1" title={`${row.eqName} · ${row.label}`}>
                {overlays.length > 0 && <CautionTriangle />}
                <span className="truncate">{label}</span>
                {row.stagger ? <span className="text-muted shrink-0">· {row.stagger} s apart</span> : null}
              </span>
              <span className="col-span-2 sm:col-span-1 order-last sm:order-none relative h-3 rounded-sm bg-field border border-line overflow-hidden" aria-hidden="true">
                {row.segments.map((item) => (item.kind === 'bar' ? (
                  <span
                    key={item.key}
                    className={`absolute inset-y-0 ${item.end === null ? 'bg-gradient-to-r from-state-ok to-transparent' : 'bg-state-ok'}`}
                    style={{ left: pct(item.start, scaleEnd), width: pct((item.end === null ? scaleEnd : item.end) - item.start, scaleEnd) }}
                  />
                ) : (
                  <span key={item.key} className="absolute inset-y-0 w-0.5 bg-ink" style={{ left: pct(item.start, scaleEnd) }} />
                )))}
                {overlays.map((o, n) => (
                  <span
                    key={n}
                    className="absolute inset-y-0 bg-state-caution"
                    style={{ left: pct(o.start, scaleEnd), width: pct(o.end - o.start, scaleEnd) }}
                  />
                ))}
              </span>
              <span className="text-xs font-mono tabular text-muted whitespace-nowrap text-right sm:text-left">{rowTimeText(row)}</span>
            </li>
          );
        })}
      </ol>

      {issues > 0 ? (
        <ul className="space-y-1" data-testid="sequence-issues">
          {gaps.map((g, i) => (
            <li key={`g${i}`} className="flex items-start gap-1.5 text-xs text-caution-700 dark:text-caution-300">
              <CautionTriangle className="mt-0.5" />
              <span>
                Pump on with no zone open{' '}
                <span className="font-mono tabular">{formatClock(g.start)}{g.end === null ? ' → until off' : `–${formatClock(g.end)}`}</span>
                {g.end !== null && ` (${formatDuration(Math.round(g.end - g.start))})`}
              </span>
            </li>
          ))}
          {overlaps.map((o, i) => (
            <li key={`o${i}`} className="flex items-start gap-1.5 text-xs text-caution-700 dark:text-caution-300">
              <CautionTriangle className="mt-0.5" />
              <span>
                {o.aLabel} and {o.bLabel} open together{' '}
                <span className="font-mono tabular">{formatClock(o.start)}{o.end === null ? ' → until off' : `–${formatClock(o.end)}`}</span>
                {o.end !== null && ` (${formatDuration(Math.round(o.end - o.start))})`}
              </span>
            </li>
          ))}
        </ul>
      ) : pumpCovered ? (
        <StatusPill state="ok" filled data-testid="sequence-ok">A zone is open whenever the pump runs</StatusPill>
      ) : null}

      <p className="text-xs text-muted">Preview only, from Start after and For. Warnings never block saving.</p>
    </Card>
  );
}
