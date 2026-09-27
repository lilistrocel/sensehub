import React from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { formatNumber, formatWithUnit, formatPercent, formatDuration } from '../../i18n/format';
import { Card, Label, Reading } from '../../ui';
import { StatusMark } from '../agronomist/SectionStatus';
import LastCycleZones from '../LastCycleZones';
import { RunTypeTag, RunStatus } from '../irrigation/RunType';

/**
 * Measured (irrigation monitor) vs estimated (relay ON-time x flow) water and
 * fertigation for the Reports page. Read-only display of GET /api/reports/daily.
 *
 * Rules (FARM-APP-STANDARDS 4.1): no measurement renders as "—", never 0;
 * a tank without a rate sensor is "not metered", never 0 L; every status is
 * shape + colour + text (StatusMark: circle ok, triangle caution, square alarm,
 * dashed hollow unknown).
 *
 * i18n: labels in the `reports` namespace. The numeric tables (times, litres,
 * tank columns) render dir="ltr" like the panel read-outs; the logical
 * text-end classes then resolve to the right edge in every language.
 * Automation / tank / zone names are data and are never translated.
 */

/** Litres -> { value, unit, precision } for Reading. */
export const litres = (l, small = false) => {
  if (l === null || l === undefined || !Number.isFinite(Number(l))) return { value: null, unit: 'L', precision: 0 };
  const v = Number(l);
  if (v >= 1000) return { value: v / 1000, unit: 'm³', precision: 2 };
  if (small || v < 10) return { value: v, unit: 'L', precision: v < 10 ? 2 : 1 };
  return { value: v, unit: 'L', precision: 0 };
};

/** Litres as text in the active language ("96.19 m³", "8.40 L"); '—' when absent. */
export const fmtL = (l) => {
  if (l === null || l === undefined || !Number.isFinite(Number(l))) return '—';
  const v = Number(l);
  if (v >= 1000) return formatWithUnit(v / 1000, 'm³', { decimals: 2 });
  return formatWithUnit(v, 'L', { decimals: v < 10 ? 2 : (v < 100 ? 1 : 0) });
};

/** Signed deviation "+12.5 %"; '—' when absent. */
export const fmtDev = (d) => (d === null || d === undefined ? '—' : formatPercent(d, { decimals: 1, signed: true }));

// First-strong isolate: an Arabic "1 د 32 ث" keeps its own order inside the
// dir="ltr" tables (no-op visually in en/tr).
const fmtDur = (s) => (s === null || s === undefined ? '—' : `\u2068${formatDuration(s)}\u2069`);
const num = (v, decimals) => formatNumber(v, { decimals });

export function timeIn(tz, iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  } catch (_) {
    return iso.slice(11, 16);
  }
}

/** Short tank label: "Tank A — Calcium nitrate" -> "Tank A". */
export const shortTank = (name, n) => {
  if (!name) return i18n.t('reports:measured.monitorN', { n });
  const [head, rest] = name.split(' — ');
  // "Tank 5 — pH Down": a bare number says nothing, keep the role
  return /^Tank \d+$/.test(head) && rest ? `${head} · ${rest}` : head;
};

// English reference; rendered via t(`measured.flag.${f}`).
const FLAG_LABEL = {
  deviation: 'deviation',
  dosing_without_relay: 'dosing, relay OFF',
  relay_without_dosing: 'relay ON, no dosing',
  water_without_valve: 'flow, valves OFF',
  valve_without_water: 'valves ON, no flow',
};
const ALARM_FLAGS = new Set(['dosing_without_relay', 'relay_without_dosing', 'water_without_valve', 'valve_without_water']);

/** 'ok' | 'caution' | 'alarm' | 'unknown' for a comparison row. */
export function rowStatus(row) {
  if (!row || row.metered === false || row.measured_liters === null || row.measured_liters === undefined) return 'unknown';
  const flags = row.flags || [];
  if (flags.some(f => ALARM_FLAGS.has(f))) return 'alarm';
  if (flags.length) return 'caution';
  return 'ok';
}

const STATUS_TEXT = { ok: 'text-ink', caution: 'text-caution-700 dark:text-caution-300', alarm: 'text-alarm-600 dark:text-alarm-300', unknown: 'text-muted' };

/**
 * Data-source tag. Measured = solid border, estimated = dashed border + muted,
 * so the two are distinguishable without colour. Not a state pill.
 */
export function SourceTag({ measured, short = false, className = '' }) {
  const { t } = useTranslation('reports');
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-px text-[10px] font-bold uppercase tracking-label leading-4 whitespace-nowrap ${
        measured ? 'border-ink/40 text-ink' : 'border-dashed border-line text-muted'
      } ${className}`.trim()}
      data-source={measured ? 'measured' : 'estimated'}
      title={measured ? t('source.measuredTitle') : t('source.estimatedTitle')}
    >
      {short ? (measured ? t('source.measShort') : t('source.estShort')) : (measured ? t('source.measured') : t('source.estimated'))}
    </span>
  );
}

function FlagText({ row }) {
  const { t } = useTranslation('reports');
  const s = rowStatus(row);
  if (row.metered === false) return <span className="text-muted">{t('measured.notMetered')}</span>;
  if (s === 'unknown') return <span className="text-muted">{t('measured.noData')}</span>;
  if (s === 'ok') return <span className="text-muted">{t('measured.ok')}</span>;
  return <span className={STATUS_TEXT[s]}>{(row.flags || []).map(f => t(`measured.flag.${f}`, { defaultValue: FLAG_LABEL[f] || f })).join(', ')}</span>;
}

const th = 'px-3 py-2 text-start text-label uppercase text-muted font-sans whitespace-nowrap';
const td = 'px-3 py-2 align-top whitespace-nowrap';

/** One day's estimated-vs-measured block (water + per tank) with flags. */
export function ComparisonTable({ cmp, tz }) {
  const { t } = useTranslation('reports');
  const rows = [
    { key: 'water', label: t('measured.water'), sub: t('measured.flowMeter'), ...cmp.water, on: cmp.water.valve_on_s, metered: true },
    ...cmp.tanks.map(tk => ({
      key: `t${tk.monitor_tank}`,
      label: shortTank(tk.tank_name, tk.monitor_tank),
      sub: tk.channel
        ? t('measured.monitorRelay', { n: tk.monitor_tank, channel: tk.channel })
        : t('measured.monitorLower', { n: tk.monitor_tank }),
      ...tk,
      on: tk.relay_on_s,
    })),
  ];
  return (
    <div className="relative overflow-x-auto -mx-4 sm:mx-0" data-testid="measured-comparison">
      <table className="min-w-full text-sm" dir="ltr">
        <thead className="bg-field">
          <tr>
            <th className={th}>{t('measured.col.item')}</th>
            <th className={`${th} text-end`}>{t('measured.col.relayOn')}</th>
            <th className={`${th} text-end`}>{t('measured.col.estimated')}</th>
            <th className={`${th} text-end`}>{t('measured.col.measured')}</th>
            <th className={`${th} text-end`}>{t('measured.col.dev')}</th>
            <th className={th}>{t('measured.col.status')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map(r => {
            const s = rowStatus(r);
            return (
              <tr key={r.key} data-row-status={s}>
                <td className={td}>
                  <span className="font-medium text-ink" dir="auto">{r.label}</span>
                  <span className="block text-xs text-muted" dir="auto">{r.sub}</span>
                </td>
                <td className={`${td} text-end font-mono tabular text-muted`}>{fmtDur(r.on)}</td>
                <td className={`${td} text-end font-mono tabular text-muted`}>{fmtL(r.estimated_liters)}</td>
                <td className={`${td} text-end font-mono tabular text-ink font-semibold`}>
                  {r.metered === false ? <span className="text-muted font-normal">—</span> : fmtL(r.measured_liters)}
                </td>
                <td className={`${td} text-end font-mono tabular ${STATUS_TEXT[s === 'caution' || s === 'alarm' ? s : 'unknown']}`}>{fmtDev(r.deviation_pct)}</td>
                <td className={td}>
                  <span className="inline-flex items-center gap-1.5 text-xs" dir="auto">
                    <StatusMark status={s} />
                    <FlagText row={r} />
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="px-4 sm:px-0 mt-2 text-xs text-muted">
        {t('measured.comparedOver', {
          from: timeIn(tz, cmp.window.from),
          to: timeIn(tz, cmp.window.to),
          threshold: formatPercent(cmp.threshold_pct, { decimals: 0 }),
        })}
        {cmp.fertigation.tanks_not_metered?.length > 0 && (
          <> {t('measured.excludesUnmetered', { tanks: cmp.fertigation.tanks_not_metered.map(tk => shortTank(tk.tank_name, tk.monitor_tank)).join(', ') })}</>
        )}
      </p>
    </div>
  );
}

/** Measured irrigation cycles for one day. */
export function CyclesTable({ cycles, tz, tankCols }) {
  const { t } = useTranslation('reports');
  if (!cycles.length) {
    return <p className="text-sm text-muted">{t('measured.noCycles')}</p>;
  }
  return (
    <div className="relative overflow-x-auto -mx-4 sm:mx-0" data-testid="measured-cycles">
      <table className="min-w-full text-sm" dir="ltr">
        <thead className="bg-field">
          <tr>
            <th className={th}>{t('measured.col.time')}</th>
            <th className={th}>{t('measured.col.automation')}</th>
            <th className={`${th} text-end`}>{t('measured.col.duration')}</th>
            <th className={`${th} text-end`}>{t('measured.col.water')}</th>
            {tankCols.map(tk => <th key={tk.monitor_tank} className={`${th} text-end`}>{shortTank(tk.tank_name, tk.monitor_tank)}</th>)}
            <th className={th}>{t('measured.col.flags')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {cycles.map(c => {
            const ws = rowStatus({ ...c.water, metered: true });
            return (
              <tr key={c.cycle_id}>
                <td className={`${td} font-mono tabular text-ink`}>{timeIn(tz, c.start)}–{timeIn(tz, c.end)}</td>
                <td className="px-3 py-2 align-top min-w-[10rem] max-w-[16rem]">
                  {c.automation
                    ? <span className="text-ink" dir="auto">{c.automation.name}</span>
                    : <span className="text-muted">{t('measured.noAutomationMatched')}</span>}
                </td>
                <td className={`${td} text-end font-mono tabular text-muted`}>{fmtDur(c.duration_s)}</td>
                <td className={`${td} text-end`}>
                  <span className="inline-flex items-center gap-1 font-mono tabular text-ink font-semibold">
                    <StatusMark status={ws} />{fmtL(c.water.measured_liters)}
                  </span>
                  <span className="block text-xs font-mono tabular text-muted">{t('measured.estDev', { est: fmtL(c.water.estimated_liters), dev: fmtDev(c.water.deviation_pct) })}</span>
                </td>
                {tankCols.map(col => {
                  const tk = c.tanks.find(x => x.monitor_tank === col.monitor_tank);
                  const s = rowStatus(tk);
                  return (
                    <td key={col.monitor_tank} className={`${td} text-end`}>
                      {!tk || tk.metered === false ? (
                        <span className="text-xs text-muted">{t('measured.notMetered')}</span>
                      ) : (
                        <>
                          <span className={`inline-flex items-center gap-1 font-mono tabular font-semibold ${s === 'ok' ? 'text-ink' : STATUS_TEXT[s]}`}>
                            <StatusMark status={s} />{fmtL(tk.measured_liters)}
                          </span>
                          <span className="block text-xs font-mono tabular text-muted">{t('measured.est', { est: fmtL(tk.estimated_liters) })}</span>
                        </>
                      )}
                    </td>
                  );
                })}
                <td className={`${td} text-xs`}>
                  {c.flag_count > 0
                    ? <span className="text-caution-700 dark:text-caution-300">{t('measured.flags', { count: c.flag_count })}</span>
                    : <span className="text-muted">{t('measured.none')}</span>}
                  {c.estimate_mapping_caveat && <span className="block text-muted">{t('measured.oldRelayMap')}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const tankLetter = (name, id) => {
  const m = /Tank\s+([A-Z])\b/i.exec(String(name || ''));
  return m ? m[1].toUpperCase() : `#${id}`;
};
const mS = (us) => (us === null || us === undefined || !(Number(us) > 0) ? '—' : (Number(us) / 1000).toFixed(2));

/**
 * The day's irrigation RUNS (cycles grouped with the relay events): scheduled,
 * manual in the app (operator) or manual at the panel. A row expands to the
 * run's per-zone table. Read-only.
 */
export function RunsTable({ runs, tz }) {
  const { t } = useTranslation('reports');
  const [open, setOpen] = React.useState(null);
  if (!runs.length) return <p className="text-sm text-muted">{t('measured.noRuns')}</p>;
  const tankCols = (runs.find(r => (r.tanks || []).length)?.tanks || []).map(tk => ({ tank_id: tk.tank_id, letter: tankLetter(tk.name, tk.tank_id), name: tk.name }));
  const cols = 9 + tankCols.length;
  return (
    <div className="relative overflow-x-auto -mx-4 sm:mx-0" data-testid="measured-runs">
      <table className="min-w-full text-sm" dir="ltr">
        <thead className="bg-field">
          <tr>
            <th className={th}>{t('measured.col.time')}</th>
            <th className={th}>{t('measured.col.run')}</th>
            <th className={th}>{t('measured.col.zones')}</th>
            <th className={`${th} text-end`}>{t('measured.col.duration')}</th>
            <th className={`${th} text-end`}>{t('measured.col.water')}</th>
            {tankCols.map(tk => <th key={tk.tank_id} className={`${th} text-end`} title={`${tk.name} (L)`}>{tk.letter}</th>)}
            <th className={`${th} text-end`}>{t('measured.col.ratio')}</th>
            <th className={`${th} text-end`}>EC mS/cm</th>
            <th className={`${th} text-end`}>pH</th>
            <th className={th}>{t('measured.col.status')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {runs.map((r) => {
            const id = r.id ?? r.key;
            const isOpen = open === id;
            const zones = (r.zone_visits || []).filter(v => !v.not_run);
            const zoneText = zones.some(v => v.zone_unknown)
              ? `${t('common:status.unknown')}${zones[0].zone_hint ? ` · ${zones[0].zone_hint}` : ''}`
              : zones.map(v => (/Zone\s*(\d+)/i.exec(v.name || '') || [])[1] || v.channel).join(', ');
            return (
              <React.Fragment key={id}>
                <tr data-run-type={r.type} data-run-status={r.status}>
                  <td className={`${td} font-mono tabular text-ink`}>
                    {/* the table is dir="ltr": the disclosure triangle points right in every language */}
                    <button type="button" className="inline-flex items-center gap-1.5 min-h-[32px] underline decoration-dotted underline-offset-2" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : id)}>
                      <svg aria-hidden="true" viewBox="0 0 10 10" className={`w-2.5 h-2.5 text-muted transition-transform ${isOpen ? 'rotate-90' : ''}`}><path d="M3 1.5 7 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
                      {timeIn(tz, r.started_at)}–{timeIn(tz, r.ended_at)}
                    </button>
                  </td>
                  <td className="px-3 py-2 align-top min-w-[11rem]">
                    <RunTypeTag run={r} />
                    {r.automation_name && <span className="block text-xs text-muted truncate max-w-[16rem]" title={r.automation_name} dir="auto">{r.automation_name}</span>}
                    {r.uncontrolled_dosing && (
                      <span className="mt-0.5 flex items-center gap-1 text-xs text-caution-700 dark:text-caution-300"><StatusMark status="caution" />{t('measured.dosingOutside')}</span>
                    )}
                  </td>
                  <td className={`${td} text-muted`}>{zoneText || '—'}</td>
                  <td className={`${td} text-end font-mono tabular text-muted`}>{fmtDur(r.duration_s)}</td>
                  <td className={`${td} text-end font-mono tabular text-ink font-semibold`}>{fmtL(r.water_l)}</td>
                  {tankCols.map(c => {
                    const tk = (r.tanks || []).find(x => x.tank_id === c.tank_id);
                    return <td key={c.tank_id} className={`${td} text-end font-mono tabular text-ink`}>{tk && tk.dosed_l !== null ? num(tk.dosed_l, 2) : '—'}</td>;
                  })}
                  <td className={`${td} text-end font-mono tabular text-ink`}>{r.achieved_ratio ? `1:${r.achieved_ratio}` : '—'}</td>
                  <td className={`${td} text-end font-mono tabular text-ink`}>{r.ec_ms && r.ec_ms.avg !== null ? num(r.ec_ms.avg, 2) : mS(r.zone_totals?.ec_avg_us)}</td>
                  <td className={`${td} text-end font-mono tabular text-ink`}>{r.ph && r.ph.avg !== null && r.ph.avg !== undefined ? num(r.ph.avg, 2) : '—'}</td>
                  <td className={td}><RunStatus status={r.status} /></td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={cols} className="px-3 pb-3 bg-field/40">
                      <LastCycleZones run={r} formatTime={(iso) => timeIn(tz, iso)} compact />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Coverage line: when the monitor had data for this day and whether it was complete. */
export function CoverageLine({ cov, tz }) {
  const { t } = useTranslation('reports');
  const s = cov.complete ? 'ok' : 'caution';
  return (
    <p className="flex items-start gap-1.5 text-xs text-muted" data-testid="measured-coverage">
      <StatusMark status={s} className="mt-0.5" />
      <span>
        {t('measured.monitorData')} <span className="font-mono tabular text-ink" dir="ltr">{timeIn(tz, cov.first_reading)}–{timeIn(tz, cov.last_reading)}</span>
        {' · '}{cov.complete
          ? t('measured.coverageComplete', { pct: formatPercent(Math.round(cov.fraction * 100)) })
          : t('measured.coveragePartial', { pct: formatPercent(Math.round(cov.fraction * 100)) })}
        {cov.gap_count > 0 && <> · {t('measured.gaps', { count: cov.gap_count, n: cov.gap_count, min: Math.round(cov.max_gap_s / 60) })}</>}
      </span>
    </p>
  );
}

/** Day-detail section: coverage, comparison, cycles, caveats. */
export function MeasuredDaySection({ day, data }) {
  const { t } = useTranslation('reports');
  const m = day.measured;
  const tz = data.timezone;
  const monitorName = data.monitor?.name || t('measured.monitorDefault');
  if (!m || !m.available) {
    return (
      <div className="pt-3 mt-3 border-t border-line" data-testid="measured-none">
        <Label className="mb-1">{t('measured.heading', { name: monitorName })}</Label>
        <p className="flex items-center gap-1.5 text-sm text-muted">
          <StatusMark status="unknown" />
          {data.monitor?.first_reading
            ? t('measured.noneStarts', { date: data.monitor.first_reading.slice(0, 10) })
            : t('measured.noneForDay')}
        </p>
      </div>
    );
  }
  const tankCols = m.tanks.map(t => ({ monitor_tank: t.monitor_tank, tank_name: t.tank_name }));
  return (
    <div className="pt-3 mt-3 border-t border-line space-y-4" data-testid="measured-section">
      <div className="space-y-1">
        <Label>{t('measured.heading', { name: monitorName })}</Label>
        <CoverageLine cov={m.coverage} tz={tz} />
        {m.water.cycles_liters !== null && m.water.counter_liters !== null && (
          <p className="text-xs text-muted">
            {t('measured.counterVsCycles', { counter: fmtL(m.water.counter_liters), cycles: fmtL(m.water.cycles_liters) })}
            {m.water.counter_vs_cycles_pct !== null && <> ({fmtDev(m.water.counter_vs_cycles_pct)})</>}
          </p>
        )}
        {(m.water.counter_resets > 0 || m.water.rejected_jumps > 0) && (
          <p className="text-xs text-muted">{t('measured.counterResets', { resets: m.water.counter_resets, jumps: m.water.rejected_jumps })}</p>
        )}
      </div>

      <div>
        <Label className="mb-2">{t('measured.estVsMeasured')}</Label>
        <ComparisonTable cmp={m.comparison} tz={tz} />
      </div>

      {Array.isArray(m.runs) ? (
        <div>
          <Label className="mb-2">{t('measured.irrigationRuns')}</Label>
          <RunsTable runs={m.runs} tz={tz} />
          {m.runs_summary && !m.runs_summary.error && (
            <p className="mt-2 text-xs text-muted" data-testid="measured-runs-reconcile">
              {t('measured.reconcile.runs', { count: m.runs_summary.runs })} <span className="font-mono tabular text-ink">{fmtL(m.runs_summary.water_l)}</span>
              {m.runs_summary.dropped_blips > 0 && <> + {t('measured.reconcile.blips', { count: m.runs_summary.dropped_blips })} <span className="font-mono tabular text-ink">{fmtL(m.runs_summary.dropped_water_l)}</span></>}
              {' '}= <span className="font-mono tabular text-ink">{fmtL(m.runs_summary.cycles_water_l)}</span> {t('measured.reconcile.inCycles', { count: m.runs_summary.cycles })}
              {m.water.counter_liters !== null && <> · {t('measured.reconcile.counter')} <span className="font-mono tabular text-ink">{fmtL(m.water.counter_liters)}</span></>}
              {Object.entries(m.runs_summary.by_type || {}).length > 0 && (
                <> · {Object.entries(m.runs_summary.by_type).map(([k, v]) => `${t(`measured.runType.${k}`, { defaultValue: k })} ${v.count} (${fmtL(v.water_l)})`).join(', ')}</>
              )}
            </p>
          )}
          <details className="mt-3 group" data-testid="measured-cycles-disclosure">
            <summary className="cursor-pointer select-none text-sm text-muted min-h-touch inline-flex items-center gap-1.5">
              <svg aria-hidden="true" viewBox="0 0 10 10" className="w-2.5 h-2.5 transition-transform rtl:-scale-x-100 group-open:rotate-90 rtl:group-open:-rotate-90"><path d="M3 1.5 7 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
              {t('measured.monitorCycles', { n: m.cycles.length })}
            </summary>
            <div className="mt-2">
              <CyclesTable cycles={m.cycles} tz={tz} tankCols={tankCols} />
              {(m.dropped_blips || []).length > 0 && (
                <p className="mt-2 text-xs text-muted">{t('measured.droppedBlips')} <span dir="ltr">{m.dropped_blips.map(d => `${timeIn(tz, d.start)} ${fmtL(d.water_l)}`).join(', ')}</span></p>
              )}
            </div>
          </details>
        </div>
      ) : (
        <div>
          <Label className="mb-2">{t('measured.measuredCycles')}</Label>
          <CyclesTable cycles={m.cycles} tz={tz} tankCols={tankCols} />
        </div>
      )}

      <Caveats day={day} data={data} />
    </div>
  );
}

function Caveats({ day, data }) {
  const { t } = useTranslation('reports');
  const notes = [];
  if (data.monitor && !data.monitor.tank_map_confirmed) {
    notes.push(t('measured.caveat.attribution', {
      map: data.monitor.tank_map.map(tk => `${tk.monitor_tank}→${shortTank(tk.tank_name, tk.monitor_tank)}`).join(', '),
    }));
  }
  if (day.measured?.comparison?.estimate_mapping_caveat || day.fertigation?.mapping_caveat) {
    const at = data.fertigation_relay_remap_at;
    notes.push(t('measured.caveat.remap', { time: timeIn(data.timezone, at), date: at ? at.slice(0, 10) : '2026-09-26' }));
  }
  if (!notes.length) return null;
  return (
    <ul className="space-y-1 text-xs text-muted">
      {notes.map(n => (
        <li key={n} className="flex items-start gap-1.5"><StatusMark status="caution" className="mt-0.5" /><span>{n}</span></li>
      ))}
    </ul>
  );
}

/** Period-level calibration disclosure: implied venturi flow per tank vs configured. */
export function CalibrationHint({ calibration, remapAt, tz }) {
  const { t } = useTranslation('reports');
  const rows = (calibration || []).filter(c => c.relay_on_minutes > 0 || c.measured_liters > 0);
  return (
    <details className="mt-4 bg-panel border border-line rounded-card group" data-testid="calibration-hint">
      <summary className="px-4 py-3 cursor-pointer select-none flex items-center justify-between gap-2 min-h-touch">
        <span className="text-sm font-semibold text-ink">{t('calibration.title')}</span>
        <span className="text-xs text-muted">{t('calibration.subtitle')}</span>
      </summary>
      <div className="px-4 pb-4">
        <p className="text-xs text-muted mb-2">
          {t('calibration.body', { time: timeIn(tz, remapAt), date: remapAt ? remapAt.slice(0, 10) : '—' })}
        </p>
        {rows.length === 0 ? (
          <p className="text-sm text-muted">{t('calibration.notEnough')}</p>
        ) : (
          <div className="relative overflow-x-auto -mx-4 sm:mx-0">
            <table className="min-w-full text-sm" dir="ltr">
              <thead className="bg-field">
                <tr>
                  <th className={th}>{t('calibration.col.tank')}</th>
                  <th className={`${th} text-end`}>{t('calibration.col.relay')}</th>
                  <th className={`${th} text-end`}>{t('calibration.col.on')}</th>
                  <th className={`${th} text-end`}>{t('calibration.col.measured')}</th>
                  <th className={`${th} text-end`}>{t('calibration.col.implied')}</th>
                  <th className={`${th} text-end`}>{t('calibration.col.configured')}</th>
                  <th className={`${th} text-end`}>{t('calibration.col.diff')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map(c => {
                  const noDosing = c.implied_flow_lpm !== null && c.implied_flow_lpm <= 0;
                  const diff = c.implied_flow_lpm > 0 && c.configured_flow_lpm > 0
                    ? ((c.configured_flow_lpm - c.implied_flow_lpm) / c.implied_flow_lpm) * 100 : null;
                  return (
                    <tr key={c.tank_id}>
                      <td className={td}><span className="text-ink font-medium" dir="auto">{shortTank(c.tank_name, c.monitor_tank)}</span></td>
                      <td className={`${td} text-end font-mono tabular text-muted`}>{t('calibration.channel', { channel: c.channel ?? '—' })}</td>
                      <td className={`${td} text-end font-mono tabular text-muted`}>{t('calibration.onMinutes', { n: num(c.relay_on_minutes, 1) })}</td>
                      <td className={`${td} text-end font-mono tabular text-ink`}>{fmtL(c.measured_liters)}</td>
                      <td className={`${td} text-end font-mono tabular text-ink font-semibold`}>
                        {noDosing ? (
                          <span className="inline-flex items-center gap-1 text-alarm-600 dark:text-alarm-300 font-normal font-sans text-xs">
                            <StatusMark status="alarm" />{t('calibration.noDosing')}
                          </span>
                        ) : c.implied_flow_lpm !== null ? formatWithUnit(c.implied_flow_lpm, 'L/min', { decimals: 3 }) : '—'}
                      </td>
                      <td className={`${td} text-end font-mono tabular text-muted`}>{c.configured_flow_lpm != null ? formatWithUnit(c.configured_flow_lpm, 'L/min', { minDecimals: 0, maxDecimals: 3 }) : '— L/min'}</td>
                      <td className={`${td} text-end font-mono tabular text-muted`}>{fmtDev(diff)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </details>
  );
}

/** KPI tile with a measured/estimated source tag and an optional secondary line. */
export function SourceKpi({ label, rail, value, measured, secondary, status, hint }) {
  return (
    <Card rail={rail} data-kpi-source={measured ? 'measured' : 'estimated'}>
      <Label>{label}</Label>
      <div className="mt-1 flex items-baseline gap-2 flex-wrap">
        <Reading value={value.value} unit={value.unit} precision={value.precision} />
        <SourceTag measured={measured} />
      </div>
      {secondary && (
        <p className={`mt-1 text-xs flex items-start gap-1 ${status && status !== 'ok' ? STATUS_TEXT[status] : 'text-muted'}`}>
          {status && status !== 'ok' && <StatusMark status={status} className="mt-0.5" />}
          <span>{secondary}</span>
        </p>
      )}
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </Card>
  );
}

/**
 * Measured dosing per fertigation tank, per day, from the irrigation monitor
 * (Fertigation → Consumption). Reads GET /api/reports/daily; display only —
 * tank stock levels are still decremented from the relay-time estimate.
 */
export function MeasuredDosingCard({ headers, days = 7 }) {
  const { t } = useTranslation('reports');
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);
  React.useEffect(() => {
    let alive = true;
    fetch(`/api/reports/daily?days=${days}`, { headers })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => { if (alive) setData(d); })
      .catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  if (error) return <Card rail="caution" className="text-sm text-muted">{t('dosingCard.unavailable', { error })}</Card>;
  if (!data) return null;
  if (!data.monitor) return null;
  const measuredDays = data.report.filter(d => d.measured?.available);
  const cols = data.monitor.tank_map;
  return (
    <Card padding="none" className="overflow-hidden" data-testid="measured-dosing-card">
      <div className="px-4 pt-3 pb-2 flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Label>{t('dosingCard.title', { name: data.monitor.name })}</Label>
          <SourceTag measured />
        </div>
        <span className="text-xs text-muted">{t('dosingCard.lastDays', { count: days })}</span>
      </div>
      {measuredDays.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-muted flex items-center gap-1.5"><StatusMark status="unknown" /> {t('dosingCard.noMeasurement')}</p>
      ) : (
        <div className="relative overflow-x-auto">
          <table className="min-w-full text-sm" dir="ltr">
            <thead className="bg-field">
              <tr>
                <th className={th}>{t('dosingCard.day')}</th>
                {cols.map(c => <th key={c.monitor_tank} className={`${th} text-end`}>{shortTank(c.tank_name, c.monitor_tank)}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {measuredDays.map(d => (
                <tr key={d.date}>
                  <td className={`${td} font-mono tabular text-ink`}>
                    {d.date}
                    {!d.measured.coverage.complete && <span className="block text-xs text-muted font-sans">{t('dosingCard.partialDay')}</span>}
                  </td>
                  {cols.map(c => {
                    const tk = d.measured.comparison.tanks.find(x => x.monitor_tank === c.monitor_tank);
                    const s = rowStatus(tk);
                    return (
                      <td key={c.monitor_tank} className={`${td} text-end`}>
                        {!tk || !tk.metered ? <span className="text-xs text-muted">{t('measured.notMetered')}</span> : (
                          <>
                            <span className={`inline-flex items-center gap-1 font-mono tabular font-semibold ${s === 'ok' ? 'text-ink' : STATUS_TEXT[s]}`}>
                              <StatusMark status={s} />{fmtL(tk.measured_liters)}
                            </span>
                            <span className="block text-xs font-mono tabular text-muted">{t('measured.est', { est: fmtL(tk.estimated_liters) })}</span>
                          </>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="px-4 py-2 text-xs text-muted border-t border-line">
        {data.monitor.tank_map_confirmed ? t('dosingCard.attributionConfigured') : t('dosingCard.attributionAssumed')}
        {' '}{t('dosingCard.stockNote')}
      </p>
    </Card>
  );
}
