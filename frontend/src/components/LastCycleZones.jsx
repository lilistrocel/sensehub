import React from 'react';
/* i18n-check: physical-ok (renders dir="ltr": left/right are meant) */
import { useTranslation } from 'react-i18next';
import { RunTypeTag, fmtWater, fmtDurShort } from './irrigation/RunType';
import { formatClock, formatNumber } from '../i18n/format';

/**
 * "Last cycle" per-zone table from an irrigation run (GET /api/irrigation/runs/last,
 * any type: scheduled, manual app, manual panel) or a dose-controller run record
 * (GET /api/dose-controller/runs/last or status.last_run).
 *
 *   Zone | Water | A | B | C | D | 1:ratio | EC (mS/cm) | pH   + totals row
 *
 * One row per zone visit (run.zone_visits; older backends: run.zones).
 * Status is shape + colour + text (FARM-APP-STANDARDS 5): check = ok,
 * triangle = cut short, square = no water / shutdown, dashed hollow square =
 * not run, hollow diamond = manual (a run nobody scheduled). A panel run has
 * one "Zone unknown" row. Unknown values render "—" (muted), never 0. On a
 * phone the table scrolls sideways inside the card with the zone column pinned.
 *
 * Line flush (DoseRunZoneStats flush_*, 2026-09-28): SEKO samples in the first
 * ~40 s after the run's first pump start are stale line / buffer / cup liquid and
 * are kept out of that zone's EC/pH; the cells get a "*" marker, a title with the
 * flush values, and a footnote. Litres stay the counter (ground truth).
 *
 * Equal draw (operator requirement 2026-10-01, dose-controller records with run.equal_draw):
 * a "Spread" column (max - min of the tanks' counter litres in the zone; caution colour
 * above the zone's tolerance), the tank that paced the others (the slowest) in bold with
 * a title, and a summary line: run spread, pacing tank, the common ratio achieved, any
 * tank failure. run.equal_draw_capability (any dose-controller record) gives the "max
 * achievable equal ratio" of recent runs (median of the runs whose slowest tank was
 * physics-limited).
 *
 * i18n: texts in irrigation:lastCycle.* / irrigation:zoneStatus.*. The table is
 * a numeric table and stays left-to-right in Arabic (dir="ltr"); zone names
 * and status words inside it are still translated.
 */

// Text: irrigation:zoneStatus.<status>
const STATUS = {
  ok: { cls: 'text-ok-700 dark:text-ok-300' },
  cut_short: { cls: 'text-caution-700 dark:text-caution-300' },
  no_water: { cls: 'text-alarm-600 dark:text-alarm-300' },
  shutdown: { cls: 'text-alarm-600 dark:text-alarm-300' },
  not_run: { cls: 'text-muted' },
  manual: { cls: 'text-ink' },
  running: { cls: 'text-ink' },
};

function ZoneMark({ status }) {
  const { t } = useTranslation('irrigation');
  const s = STATUS[status] ? status : 'unknown';
  const cls = STATUS[s]?.cls || 'text-muted';
  const text = t(`zoneStatus.${s}`);
  return (
    <span className={`inline-flex items-center shrink-0 ${cls}`} data-zone-status={s} title={text}>
      <svg aria-hidden="true" viewBox="0 0 12 12" className="w-3 h-3">
        {s === 'ok' && <path d="M1.8 6.4 4.7 9.2 10.4 2.8" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />}
        {s === 'cut_short' && <path d="M6 1 L11.2 10.5 H0.8 Z" fill="currentColor" />}
        {(s === 'no_water' || s === 'shutdown') && <rect x="1.5" y="1.5" width="9" height="9" rx="1" fill="currentColor" />}
        {s === 'not_run' && <rect x="2" y="2" width="8" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 1.6" />}
        {s === 'manual' && <path d="M6 1.2 10.8 6 6 10.8 1.2 6Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />}
        {s === 'running' && <circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.6" />}
        {s === 'unknown' && <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2.2 1.6" />}
      </svg>
      <span className="sr-only">{text}</span>
    </span>
  );
}

const isNum = (x) => x !== null && x !== undefined && Number.isFinite(Number(x));
const Dash = () => <span className="text-muted">&mdash;</span>;
// '.' decimal / Western digits in every language (src/i18n/format.js).
const num = (x, d) => (isNum(x) ? formatNumber(x, { decimals: d, grouping: false }) : <Dash />);
const int = (x) => (isNum(x) ? (Number(x) > 0 && Number(x) < 10 ? formatNumber(x, { decimals: 1 }) : formatNumber(x, { decimals: 0 })) : <Dash />);
const mS = (us) => (isNum(us) && Number(us) > 0 ? formatNumber(Number(us) / 1000, { decimals: 2 }) : <Dash />);

function letterOf(name, id) {
  const m = /Tank\s+([A-Z])\b/i.exec(String(name || ''));
  return m ? m[1].toUpperCase() : String(name || `#${id}`).slice(0, 3);
}

/** "Irrigation Zone 3" -> "Zone 3" in the active language (t: irrigation namespace). */
function shortZone(t, name, channel) {
  const m = /Zone\s*(\d+)/i.exec(String(name || ''));
  return m ? t('lastCycle.zoneN', { n: m[1] }) : (name || t('lastCycle.relayN', { n: channel }));
}

// Run-level statuses shown next to the header (text: irrigation:runStatus.<status>).
const RUN_STATUS_SHOWN = ['shutdown', 'no_water', 'cut_short', 'stopped', 'running'];

/** Target ratio: a single number when all tanks share it. */
function targetOf(run) {
  if (isNum(run.ratio_target)) return Number(run.ratio_target);
  const r = (run.tanks || []).map(t => t.ratio_target).filter(isNum);
  return r.length && r.every(x => x === r[0]) ? r[0] : null;
}

export function lastCycleView(run) {
  if (!run) return null;
  const rows = Array.isArray(run.zone_visits) ? run.zone_visits : (Array.isArray(run.zones) ? run.zones : []);
  const tankCols = [...(run.tanks || [])]
    .sort((a, b) => letterOf(a.name, a.tank_id).localeCompare(letterOf(b.name, b.tank_id)))
    .map(t => ({ tank_id: t.tank_id, letter: letterOf(t.name, t.tank_id), name: t.name, dosed_l: t.dosed_l }));
  const totals = run.zone_totals || null;
  const eq = run.equal_draw && run.equal_draw.enabled ? run.equal_draw : null;
  return { rows, tankCols, totals, target: targetOf(run), hasQuality: rows.some(r => 'samples' in r), eq, capability: run.equal_draw_capability || null };
}

/** Equal draw: counter-litre spread of a zone row (max - min over its ratio tanks), or null. */
export function zoneSpread(row, eq) {
  const excluded = new Set(((eq && eq.tanks) || []).filter(x => x.excluded).map(x => x.tank_id));
  const v = (row.tanks || []).filter(x => !excluded.has(x.tank_id) && isNum(x.dosed_l)).map(x => Number(x.dosed_l));
  if (v.length < 2) return null;
  return Math.round((Math.max(...v) - Math.min(...v)) * 100) / 100;
}

export default function LastCycleZones({ run, formatTime, compact = false, className = '' }) {
  const { t } = useTranslation('irrigation');
  const v = lastCycleView(run);
  if (!v) return null;
  const { rows, tankCols, totals, target, eq, capability } = v;
  // the counter (0.25 L steps) can show one step more than the controlled estimate
  const spreadTol = (r) => (r.equal_draw && isNum(r.equal_draw.tolerance_l) ? Number(r.equal_draw.tolerance_l) : eq ? Number(eq.tolerance_l) : null);
  const spreadCls = (r, x) => (isNum(x) && spreadTol(r) !== null && x > spreadTol(r) + 0.25 + 1e-9 ? 'text-caution-700 dark:text-caution-300' : 'text-ink');
  const when = (iso) => {
    if (!iso) return '—';
    if (formatTime) return formatTime(iso);
    return formatClock(iso);
  };
  const ratioCls = (r, status) => {
    if (!isNum(r) || !target || status === 'not_run') return 'text-ink';
    // per zone the 0.25 L counter alone is ~±14 % of a 1.75 L dose: flag > 15 % only
    return Math.abs(r - target) / target > 0.15 ? 'text-caution-700 dark:text-caution-300' : 'text-ink';
  };
  const tankOf = (row, tankId) => (row.tanks || []).find(t => t.tank_id === tankId);
  const notOk = rows.filter(r => r.status && r.status !== 'ok' && r.status !== 'manual');
  const th = 'px-1.5 py-1 text-right font-sans text-[11px] font-semibold uppercase tracking-wider text-muted whitespace-nowrap';
  // (the table below is dir="ltr": physical left/right are intended here)
  const td = 'px-1.5 py-1 text-right font-mono tabular whitespace-nowrap';
  const pin = 'sticky left-0 z-[1] bg-panel';

  const isRun = !!run.type; // irrigation run (any type) vs dose-controller record
  const manual = run.type === 'manual_app' || run.type === 'manual_panel';
  const notes = isRun ? (run.notes || []).filter(n => !/^Dosing outside SenseHub control/.test(n)) : [];
  return (
    <div className={`min-w-0 ${className}`} data-testid="last-cycle-zones" data-run-type={run.type || 'dose_controller'}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span className="font-mono tabular text-sm text-ink" data-testid="last-cycle-start">{when(run.started_at)}</span>
        {isRun && <RunTypeTag run={run} />}
        {run.automation_name && <span className="truncate max-w-full text-ink" title={run.automation_name}>{run.automation_name}</span>}
        {isRun && (
          <span className="font-mono tabular text-ink">{fmtDurShort(run.duration_s)} · <span dir="ltr">{fmtWater(run.water_l)}</span></span>
        )}
        {(!manual || target) && (
          <span>{t('lastCycle.target')} <span className="font-mono tabular text-ink" dir="ltr">{target ? `1:${target}` : '—'}</span></span>
        )}
        {(!isRun || isNum(run.acid_s)) && (
          <span>{t('lastCycle.acid')} <span className="font-mono tabular text-ink">{isNum(run.acid_s) ? t('lastCycle.seconds', { value: Math.round(run.acid_s) }) : '—'}</span></span>
        )}
        {eq && (
          <span data-testid="last-cycle-equal-draw" data-within={eq.within_tolerance ? 'true' : 'false'}>
            {t('lastCycle.equalDraw')}{' '}
            <span className={`font-mono tabular ${eq.within_tolerance ? 'text-ink' : 'text-caution-700 dark:text-caution-300'}`} dir="ltr">
              {t('lastCycle.equalDrawSpread', { spread: num(eq.spread_l, 2), pct: isNum(eq.spread_pct) ? formatNumber(eq.spread_pct, { decimals: 1 }) : '—' })}
            </span>
            {eq.pacer && <> · {t('lastCycle.pacedBy', { tank: letterOf(eq.pacer.name, eq.pacer.tank_id) })}</>}
            {isNum(eq.common_ratio) && <> · <span className="font-mono tabular text-ink" dir="ltr">1:{eq.common_ratio}</span></>}
          </span>
        )}
        {!isRun && run.status && run.status !== 'completed' && run.status !== 'running' && (
          <span className="text-caution-700 dark:text-caution-300">{run.status}{run.end_reason ? ` — ${String(run.end_reason).replace(/^flow_watch(_shutdown)?:\s*/, '')}` : ''}</span>
        )}
        {isRun && RUN_STATUS_SHOWN.includes(run.status) && (
          <span className={run.status === 'running' ? 'text-ink' : (run.status === 'cut_short' || run.status === 'stopped') ? 'text-caution-700 dark:text-caution-300' : 'text-alarm-600 dark:text-alarm-300'} data-testid="last-cycle-status">
            {t(`runStatus.${run.status}`)}
          </span>
        )}
      </div>
      {eq && (eq.failures || []).length > 0 && (
        <p className="mt-1 flex items-start gap-1.5 text-xs text-alarm-600 dark:text-alarm-300" data-testid="last-cycle-equal-draw-failure">
          <svg aria-hidden="true" viewBox="0 0 12 12" className="mt-0.5 w-3 h-3 shrink-0"><rect x="1.5" y="1.5" width="9" height="9" rx="1" fill="currentColor" /></svg>
          <span>{eq.failures.map(f => t(f.policy === 'exclude_failed' ? 'lastCycle.eqFailureExcluded' : (f.resolved_at ? 'lastCycle.eqFailureHoldResolved' : 'lastCycle.eqFailureHold'), { tank: letterOf(f.name, f.tank_id) })).join(' · ')}</span>
        </p>
      )}
      {!isRun && capability && isNum(capability.achievable_ratio) && (
        <p className="mt-1 text-xs text-muted" data-testid="last-cycle-achievable">
          {t('lastCycle.achievable', { count: capability.n_limited })}{' '}
          <span className="font-mono tabular text-ink" dir="ltr">≈1:{capability.achievable_ratio}</span>
          {isNum(capability.best_ratio) && capability.best_ratio !== capability.achievable_ratio && <> ({t('lastCycle.achievableBest')} <span className="font-mono tabular" dir="ltr">1:{capability.best_ratio}</span>)</>}
          {target && target < capability.achievable_ratio * 0.97 && (
            <span className="ms-1 text-caution-700 dark:text-caution-300" data-testid="last-cycle-achievable-warning">— {t('lastCycle.achievableBelowTarget', { target })}</span>
          )}
        </p>
      )}
      {isRun && run.uncontrolled_dosing && (
        <p className="mt-1 flex items-start gap-1.5 text-xs text-caution-700 dark:text-caution-300" data-testid="last-cycle-uncontrolled">
          <svg aria-hidden="true" viewBox="0 0 12 12" className="mt-0.5 w-3 h-3 shrink-0"><path d="M6 1 L11.2 10.5 H0.8 Z" fill="currentColor" /></svg>
          <span>
            {t('lastCycle.uncontrolled')}
            {(run.uncontrolled_tanks || []).length ? <> — <span dir="ltr">{run.uncontrolled_tanks.map(x => `${letterOf(x.name, x.tank_id)} ${num(x.dosed_l, 2)} L`).join(', ')}</span></> : ''}
          </span>
        </p>
      )}

      {rows.length === 0 ? (
        <p className="mt-1 text-sm text-muted">{t('lastCycle.noZoneRecord')}</p>
      ) : (
        <div className="relative mt-1.5 -mx-3 overflow-x-auto overscroll-x-contain" role="region" aria-label={t('lastCycle.tableAria')} tabIndex={0} dir="ltr">
          <table className={`w-full min-w-[33rem] border-collapse ${compact ? 'text-xs' : 'text-sm'}`}>
            <thead>
              <tr className="border-b border-line">
                <th scope="col" className={`${pin} pl-3 pr-1.5 py-1 text-left font-sans text-[11px] font-semibold uppercase tracking-wider text-muted whitespace-nowrap`}>{t('lastCycle.colZone')}</th>
                <th scope="col" className={th}>{t('lastCycle.colWater')}</th>
                {tankCols.map(tc => <th key={tc.tank_id} scope="col" className={th} title={`${tc.name} (L)`}>{tc.letter}</th>)}
                {eq && <th scope="col" className={th} title={t('lastCycle.colSpreadTitle')}>{t('lastCycle.colSpread')}</th>}
                <th scope="col" className={th}>{t('lastCycle.colRatio')}</th>
                <th scope="col" className={th}>EC mS/cm</th>
                <th scope="col" className={`${th} pr-3`}>pH</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const dim = r.status === 'not_run';
                const range = (k, min, max, n) => (isNum(n)
                  ? t(`lastCycle.${k}`, { min, max, count: Number(n) })
                  : t(`lastCycle.${k}NoCount`, { min, max }));
                const flush = r.flush_samples > 0;
                const flushTitle = flush ? t('lastCycle.flushTitle', {
                  seconds: isNum(r.flush_s) ? Math.round(r.flush_s) : '—',
                  ec: isNum(r.flush_ec_avg_us) && Number(r.flush_ec_avg_us) > 0 ? formatNumber(Number(r.flush_ec_avg_us) / 1000, { decimals: 2 }) : '—',
                  ph: isNum(r.flush_ph_avg) ? formatNumber(r.flush_ph_avg, { decimals: 2 }) : '—',
                }) : null;
                const withFlush = (title) => (flush ? `${title} — ${flushTitle}` : title);
                const ecTitle = withFlush(isNum(r.ec_avg_us) ? range('ecTitle', mS(r.ec_min_us), mS(r.ec_max_us), r.ec_samples) : t('lastCycle.noEcSample'));
                const phTitle = withFlush(isNum(r.ph_avg) ? range('phTitle', num(r.ph_min, 2), num(r.ph_max, 2), r.samples) : t('lastCycle.noPhSample'));
                const flushMark = flush ? <span className="text-muted" aria-hidden="true" data-testid="last-cycle-flush">*</span> : null;
                return (
                  <tr key={`${r.channel}-${i}`} className={`border-b border-line ${dim ? 'text-muted' : 'text-ink'}`} data-testid="last-cycle-row" data-status={r.status || 'unknown'}>
                    <th scope="row" className={`${pin} pl-3 pr-1.5 py-1 text-left font-sans font-normal whitespace-nowrap`}>
                      <span className="inline-flex items-center gap-1.5">
                        <ZoneMark status={r.status} />
                        <span>{r.zone_unknown ? t('lastCycle.zoneUnknown') : shortZone(t, r.name, r.channel)}</span>
                        {r.zone_unknown && r.zone_hint && <span className="text-[11px] text-muted">{r.zone_hint}</span>}
                        {r.status && r.status !== 'ok' && r.status !== 'manual' && (
                          <span className={`text-[11px] ${STATUS[r.status]?.cls || 'text-muted'}`}>{t(`zoneStatus.${STATUS[r.status] ? r.status : 'unknown'}`)}</span>
                        )}
                        {r.retries > 0 && <span className="text-[11px] text-caution-700 dark:text-caution-300" title={t('lastCycle.retryTitle')}>{t('lastCycle.retry')}</span>}
                        {(r.also_open || []).length > 0 && (
                          <span className="text-[11px] text-caution-700 dark:text-caution-300" title={t('lastCycle.alsoOpenTitle', { list: r.also_open.map(x => `${x.name} (${x.by})`).join(', ') })}>
                            {t('lastCycle.alsoOpen', { zones: r.also_open.map(x => shortZone(t, x.name, x.channel)).join(', ') })}
                          </span>
                        )}
                      </span>
                    </th>
                    <td className={td}>{int(r.water_l)}</td>
                    {tankCols.map(tc => {
                      const x = tankOf(r, tc.tank_id);
                      const pacer = eq && x && x.eq_pacer;
                      return (
                        <td key={tc.tank_id} className={`${td} ${pacer ? 'font-bold underline decoration-dotted underline-offset-2' : ''}`}
                          title={pacer ? t('lastCycle.pacerTitle') : (eq && x && x.eq_paced ? t('lastCycle.heldTitle', { seconds: isNum(x.eq_held_s) ? Math.round(x.eq_held_s) : '—' }) : undefined)}
                          data-eq-pacer={pacer ? 'true' : undefined}>
                          {x ? num(x.dosed_l, 2) : <Dash />}
                          {pacer && <span className="sr-only"> {t('lastCycle.pacerTitle')}</span>}
                        </td>
                      );
                    })}
                    {eq && (() => { const sp = zoneSpread(r, eq); return <td className={`${td} ${spreadCls(r, sp)}`} data-testid="last-cycle-spread">{num(sp, 2)}</td>; })()}
                    <td className={`${td} ${ratioCls(r.achieved_ratio, r.status)}`}>{isNum(r.achieved_ratio) ? `1:${r.achieved_ratio}` : <Dash />}</td>
                    <td className={td} title={ecTitle}>{mS(r.ec_avg_us)}{flushMark}{flush && <span className="sr-only">{flushTitle}</span>}</td>
                    <td className={`${td} pr-3`} title={phTitle}>{num(r.ph_avg, 2)}{flushMark}</td>
                  </tr>
                );
              })}
            </tbody>
            {totals && (
              <tfoot>
                <tr className="font-semibold text-ink" data-testid="last-cycle-total">
                  <th scope="row" className={`${pin} pl-3 pr-1.5 py-1 text-left font-sans text-[11px] uppercase tracking-wider text-muted`}>{t('lastCycle.total')}</th>
                  <td className={td}>{int(totals.water_l)}</td>
                  {tankCols.map(tc => {
                    const x = (totals.tanks || []).find(tt => tt.tank_id === tc.tank_id);
                    return <td key={tc.tank_id} className={td}>{x ? num(x.dosed_l, 2) : <Dash />}</td>;
                  })}
                  {eq && <td className={`${td} ${eq.within_tolerance ? 'text-ink' : 'text-caution-700 dark:text-caution-300'}`}>{num(eq.spread_l, 2)}</td>}
                  <td className={`${td} ${ratioCls(totals.achieved_ratio)}`}>{isNum(totals.achieved_ratio) ? `1:${totals.achieved_ratio}` : <Dash />}</td>
                  <td className={td}>{mS(totals.ec_avg_us)}</td>
                  <td className={`${td} pr-3`}>{num(totals.ph_avg, 2)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {rows.length > 0 && (
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted">
          <span className="inline-flex items-center gap-1"><ZoneMark status="ok" /> {t('zoneStatus.ok')}</span>
          <span className="inline-flex items-center gap-1"><ZoneMark status="cut_short" /> {t('zoneStatus.cut_short')}</span>
          <span className="inline-flex items-center gap-1"><ZoneMark status="no_water" /> {t('lastCycle.legendNoWater')}</span>
          {rows.some(r => r.status === 'manual') && <span className="inline-flex items-center gap-1"><ZoneMark status="manual" /> {t('zoneStatus.manual')}</span>}
          <span>{t('lastCycle.legendSamples')}</span>
          {eq && <span data-testid="last-cycle-pacer-legend"><span className="font-bold underline decoration-dotted underline-offset-2 text-ink">2.50</span> {t('lastCycle.legendPacer', { tol: formatNumber(eq.tolerance_l, { decimals: 1 }) })}</span>}
          {rows.some(r => r.flush_samples > 0) && (
            <span data-testid="last-cycle-flush-note">{t('lastCycle.flushNote', { seconds: Math.round(Number(rows.find(r => r.flush_samples > 0).flush_s) || 40) })}</span>
          )}
          {notOk.length === 0 && <span className="sr-only">{t('lastCycle.allOk')}</span>}
        </p>
      )}
      {notes.length > 0 && (
        <details className="mt-1 text-[11px] text-muted group" data-testid="last-cycle-notes">
          <summary className="cursor-pointer select-none inline-flex items-center gap-1 min-h-[24px]">
            <svg aria-hidden="true" viewBox="0 0 10 10" className="w-2 h-2 transition-transform rtl:-scale-x-100 group-open:rotate-90 rtl:group-open:-rotate-90"><path d="M3 1.5 7 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
            {t('lastCycle.notes', { count: notes.length })}
          </summary>
          <ul className="mt-0.5 space-y-0.5">{notes.map(n => <li key={n}>{n}</li>)}</ul>
        </details>
      )}
    </div>
  );
}
