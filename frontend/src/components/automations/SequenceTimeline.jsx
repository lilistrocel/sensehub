import React from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Card, Label, StatusPill } from '../../ui';
import { formatClock, formatDuration, actionWord } from './automationSummary';
import { useSummaryLocale } from './useSummaryLocale';

/** Caution is a triangle (docs/FARM-APP-STANDARDS.md §5: status = shape + colour). */
function CautionTriangle({ className = '' }) {
  return (
    <svg viewBox="0 0 12 12" className={`inline-block h-3 w-3 shrink-0 ${className}`} aria-hidden="true">
      <path d="M6 1 L11.5 11 H0.5 Z" className="fill-state-caution" />
    </svg>
  );
}

const pct = (v, scale) => `${Math.max(0, Math.min(100, (v / scale) * 100))}%`;

// Time texts are clock offsets from the trigger ("0:03–18:30"); they live in
// the dir="ltr" timeline, so their order never flips in Arabic.
function timeText(item, loc) {
  const { t } = loc;
  if (item.kind === 'point') return t('sequence.pointAt', { action: actionWord(item.action || 'off', loc), time: formatClock(item.start) });
  if (item.end === null) return t('sequence.untilOff', { start: formatClock(item.start) });
  return `${formatClock(item.start)}–${formatClock(item.end)}`;
}

/** One segment: as before. Several (e.g. pumps once per zone): "4× 4:30 · 0:03–18:30". */
function rowTimeText(row, loc) {
  const { t } = loc;
  if (row.segments.length === 1) return timeText(row.segments[0], loc);
  const bars = row.segments.filter(s => s.kind === 'bar');
  const durs = new Set(bars.map(s => (s.end === null ? 'open' : Math.round(s.end - s.start))));
  const each = bars.length === row.segments.length && durs.size === 1 && !durs.has('open')
    ? `${row.segments.length}× ${formatClock([...durs][0])}`
    : t('sequence.windows', { count: row.segments.length });
  const end = row.end === null ? ` ${t('sequence.untilOffShort')}` : `–${formatClock(row.end)}`;
  return `${each} · ${formatClock(row.start)}${end}`;
}

/**
 * Read-only preview of when each relay action runs, measured from the
 * trigger. Flags (never blocks) a feed pump running with no zone open and
 * zones on one board overlapping.
 */
export default function SequenceTimeline({ sequence }) {
  const { t } = useTranslation('automations');
  const loc = useSummaryLocale();
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
        <Label>{t('sequence.title')}</Label>
        <span className="text-xs text-muted" data-testid="sequence-total">
          <Trans t={t} i18nKey="sequence.total" values={{ time: formatClock(total) }} components={{ b: <span className="font-mono tabular text-ink" dir="ltr" /> }} />
          {openEnded && <span> · {t('sequence.openEnded')}</span>}
        </span>
      </div>

      {/* Time runs left to right in every language (like a chart). */}
      <ol className="space-y-1.5" dir="ltr">
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
                <span className="truncate" dir="auto">{label}</span>
                {row.stagger ? <span className="text-muted shrink-0">{t('sequence.apart', { duration: formatDuration(row.stagger, loc) })}</span> : null}
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
              <span className="text-xs font-mono tabular text-muted whitespace-nowrap text-end sm:text-start">{rowTimeText(row, loc)}</span>
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
                {t('sequence.pumpNoZone')}{' '}
                <span className="font-mono tabular" dir="ltr">{g.end === null ? t('sequence.untilOff', { start: formatClock(g.start) }) : `${formatClock(g.start)}–${formatClock(g.end)}`}</span>
                {g.end !== null && ` (${formatDuration(Math.round(g.end - g.start), loc)})`}
              </span>
            </li>
          ))}
          {overlaps.map((o, i) => (
            <li key={`o${i}`} className="flex items-start gap-1.5 text-xs text-caution-700 dark:text-caution-300">
              <CautionTriangle className="mt-0.5" />
              <span>
                {t('sequence.zonesTogether', { a: `\u2068${o.aLabel}\u2069`, b: `\u2068${o.bLabel}\u2069` })}{' '}
                <span className="font-mono tabular" dir="ltr">{o.end === null ? t('sequence.untilOff', { start: formatClock(o.start) }) : `${formatClock(o.start)}–${formatClock(o.end)}`}</span>
                {o.end !== null && ` (${formatDuration(Math.round(o.end - o.start), loc)})`}
              </span>
            </li>
          ))}
        </ul>
      ) : pumpCovered ? (
        <StatusPill state="ok" filled data-testid="sequence-ok">{t('sequence.allCovered')}</StatusPill>
      ) : null}

      <p className="text-xs text-muted">{t('sequence.previewNote', { startAfter: t('builder.control.startAfter'), duration: t('builder.control.for') })}</p>
    </Card>
  );
}
