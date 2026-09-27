import React from 'react';
import { RunTypeTag, fmtWater, fmtDurShort } from './irrigation/RunType';

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
 */

const STATUS = {
  ok: { text: 'ok', cls: 'text-ok-700 dark:text-ok-300' },
  cut_short: { text: 'cut short', cls: 'text-caution-700 dark:text-caution-300' },
  no_water: { text: 'no water', cls: 'text-alarm-600 dark:text-alarm-300' },
  shutdown: { text: 'shut down', cls: 'text-alarm-600 dark:text-alarm-300' },
  not_run: { text: 'not run', cls: 'text-muted' },
  manual: { text: 'manual', cls: 'text-ink' },
  running: { text: 'in progress', cls: 'text-ink' },
};

function ZoneMark({ status }) {
  const s = STATUS[status] ? status : 'unknown';
  const cls = STATUS[s]?.cls || 'text-muted';
  return (
    <span className={`inline-flex items-center shrink-0 ${cls}`} data-zone-status={s} title={STATUS[s]?.text || 'status unknown'}>
      <svg aria-hidden="true" viewBox="0 0 12 12" className="w-3 h-3">
        {s === 'ok' && <path d="M1.8 6.4 4.7 9.2 10.4 2.8" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />}
        {s === 'cut_short' && <path d="M6 1 L11.2 10.5 H0.8 Z" fill="currentColor" />}
        {(s === 'no_water' || s === 'shutdown') && <rect x="1.5" y="1.5" width="9" height="9" rx="1" fill="currentColor" />}
        {s === 'not_run' && <rect x="2" y="2" width="8" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 1.6" />}
        {s === 'manual' && <path d="M6 1.2 10.8 6 6 10.8 1.2 6Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />}
        {s === 'running' && <circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.6" />}
        {s === 'unknown' && <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2.2 1.6" />}
      </svg>
      <span className="sr-only">{STATUS[s]?.text || 'status unknown'}</span>
    </span>
  );
}

const isNum = (x) => x !== null && x !== undefined && Number.isFinite(Number(x));
const Dash = () => <span className="text-muted">&mdash;</span>;
const num = (x, d) => (isNum(x) ? Number(x).toFixed(d) : <Dash />);
const int = (x) => (isNum(x) ? (Number(x) > 0 && Number(x) < 10 ? Number(x).toFixed(1) : Math.round(Number(x)).toLocaleString('en-US')) : <Dash />);
const mS = (us) => (isNum(us) && Number(us) > 0 ? (Number(us) / 1000).toFixed(2) : <Dash />);

function letterOf(name, id) {
  const m = /Tank\s+([A-Z])\b/i.exec(String(name || ''));
  return m ? m[1].toUpperCase() : String(name || `#${id}`).slice(0, 3);
}

function shortZone(name, channel) {
  const m = /Zone\s*(\d+)/i.exec(String(name || ''));
  return m ? `Zone ${m[1]}` : (name || `relay ${channel}`);
}

const RUN_STATUS_TEXT = { shutdown: 'shut down', no_water: 'no water', cut_short: 'cut short', stopped: 'stopped by operator', running: 'in progress' };

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
  return { rows, tankCols, totals, target: targetOf(run), hasQuality: rows.some(r => 'samples' in r) };
}

export default function LastCycleZones({ run, formatTime, compact = false, className = '' }) {
  const v = lastCycleView(run);
  if (!v) return null;
  const { rows, tankCols, totals, target } = v;
  const when = (iso) => {
    if (!iso) return '—';
    if (formatTime) return formatTime(iso);
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };
  const ratioCls = (r, status) => {
    if (!isNum(r) || !target || status === 'not_run') return 'text-ink';
    // per zone the 0.25 L counter alone is ~±14 % of a 1.75 L dose: flag > 15 % only
    return Math.abs(r - target) / target > 0.15 ? 'text-caution-700 dark:text-caution-300' : 'text-ink';
  };
  const tankOf = (row, tankId) => (row.tanks || []).find(t => t.tank_id === tankId);
  const notOk = rows.filter(r => r.status && r.status !== 'ok' && r.status !== 'manual');
  const th = 'px-1.5 py-1 text-right font-sans text-[11px] font-semibold uppercase tracking-wider text-muted whitespace-nowrap';
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
          <span className="font-mono tabular text-ink">{fmtDurShort(run.duration_s)} · {fmtWater(run.water_l)}</span>
        )}
        {(!manual || target) && <span>target <span className="font-mono tabular text-ink">{target ? `1:${target}` : '—'}</span></span>}
        {(!isRun || isNum(run.acid_s)) && <span>acid <span className="font-mono tabular text-ink">{isNum(run.acid_s) ? Math.round(run.acid_s) : '—'}</span> s</span>}
        {!isRun && run.status && run.status !== 'completed' && run.status !== 'running' && (
          <span className="text-caution-700 dark:text-caution-300">{run.status}{run.end_reason ? ` — ${String(run.end_reason).replace(/^flow_watch(_shutdown)?:\s*/, '')}` : ''}</span>
        )}
        {isRun && RUN_STATUS_TEXT[run.status] && (
          <span className={run.status === 'running' ? 'text-ink' : (run.status === 'cut_short' || run.status === 'stopped') ? 'text-caution-700 dark:text-caution-300' : 'text-alarm-600 dark:text-alarm-300'} data-testid="last-cycle-status">
            {RUN_STATUS_TEXT[run.status]}
          </span>
        )}
      </div>
      {isRun && run.uncontrolled_dosing && (
        <p className="mt-1 flex items-start gap-1.5 text-xs text-caution-700 dark:text-caution-300" data-testid="last-cycle-uncontrolled">
          <svg aria-hidden="true" viewBox="0 0 12 12" className="mt-0.5 w-3 h-3 shrink-0"><path d="M6 1 L11.2 10.5 H0.8 Z" fill="currentColor" /></svg>
          <span>Dosing outside SenseHub control{(run.uncontrolled_tanks || []).length ? ` — ${run.uncontrolled_tanks.map(t => `${letterOf(t.name, t.tank_id)} ${num(t.dosed_l, 2)} L`).join(', ')}` : ''}</span>
        </p>
      )}

      {rows.length === 0 ? (
        <p className="mt-1 text-sm text-muted">No per-zone record for this run.</p>
      ) : (
        <div className="mt-1.5 -mx-3 overflow-x-auto overscroll-x-contain" role="region" aria-label="Last cycle per zone" tabIndex={0}>
          <table className={`w-full min-w-[33rem] border-collapse ${compact ? 'text-xs' : 'text-sm'}`}>
            <thead>
              <tr className="border-b border-line">
                <th scope="col" className={`${pin} pl-3 pr-1.5 py-1 text-left font-sans text-[11px] font-semibold uppercase tracking-wider text-muted whitespace-nowrap`}>Zone</th>
                <th scope="col" className={th}>Water L</th>
                {tankCols.map(t => <th key={t.tank_id} scope="col" className={th} title={`${t.name} (L)`}>{t.letter}</th>)}
                <th scope="col" className={th}>1:ratio</th>
                <th scope="col" className={th}>EC mS/cm</th>
                <th scope="col" className={`${th} pr-3`}>pH</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const dim = r.status === 'not_run';
                const ecTitle = isNum(r.ec_avg_us) ? `EC ${mS(r.ec_min_us)}–${mS(r.ec_max_us)} mS/cm, ${r.ec_samples ?? '?'} samples` : 'no EC sample while water flowed';
                const phTitle = isNum(r.ph_avg) ? `pH ${num(r.ph_min, 2)}–${num(r.ph_max, 2)}, ${r.samples ?? '?'} samples` : 'no pH sample while water flowed';
                return (
                  <tr key={`${r.channel}-${i}`} className={`border-b border-line ${dim ? 'text-muted' : 'text-ink'}`} data-testid="last-cycle-row" data-status={r.status || 'unknown'}>
                    <th scope="row" className={`${pin} pl-3 pr-1.5 py-1 text-left font-sans font-normal whitespace-nowrap`}>
                      <span className="inline-flex items-center gap-1.5">
                        <ZoneMark status={r.status} />
                        <span>{r.zone_unknown ? 'Zone unknown' : shortZone(r.name, r.channel)}</span>
                        {r.zone_unknown && r.zone_hint && <span className="text-[11px] text-muted">{r.zone_hint}</span>}
                        {r.status && r.status !== 'ok' && r.status !== 'manual' && (
                          <span className={`text-[11px] ${STATUS[r.status]?.cls || 'text-muted'}`}>{STATUS[r.status]?.text}</span>
                        )}
                        {r.retries > 0 && <span className="text-[11px] text-caution-700 dark:text-caution-300" title="flow watch restarted the pumps for this zone">retry</span>}
                        {(r.also_open || []).length > 0 && (
                          <span className="text-[11px] text-caution-700 dark:text-caution-300" title={`Also open: ${r.also_open.map(x => `${x.name} (${x.by})`).join(', ')}`}>
                            +{r.also_open.map(x => shortZone(x.name, x.channel)).join(', ')} open
                          </span>
                        )}
                      </span>
                    </th>
                    <td className={td}>{int(r.water_l)}</td>
                    {tankCols.map(t => {
                      const x = tankOf(r, t.tank_id);
                      return <td key={t.tank_id} className={td}>{x ? num(x.dosed_l, 2) : <Dash />}</td>;
                    })}
                    <td className={`${td} ${ratioCls(r.achieved_ratio, r.status)}`}>{isNum(r.achieved_ratio) ? `1:${r.achieved_ratio}` : <Dash />}</td>
                    <td className={td} title={ecTitle}>{mS(r.ec_avg_us)}</td>
                    <td className={`${td} pr-3`} title={phTitle}>{num(r.ph_avg, 2)}</td>
                  </tr>
                );
              })}
            </tbody>
            {totals && (
              <tfoot>
                <tr className="font-semibold text-ink" data-testid="last-cycle-total">
                  <th scope="row" className={`${pin} pl-3 pr-1.5 py-1 text-left font-sans text-[11px] uppercase tracking-wider text-muted`}>Total</th>
                  <td className={td}>{int(totals.water_l)}</td>
                  {tankCols.map(t => {
                    const x = (totals.tanks || []).find(tt => tt.tank_id === t.tank_id);
                    return <td key={t.tank_id} className={td}>{x ? num(x.dosed_l, 2) : <Dash />}</td>;
                  })}
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
          <span className="inline-flex items-center gap-1"><ZoneMark status="ok" /> ok</span>
          <span className="inline-flex items-center gap-1"><ZoneMark status="cut_short" /> cut short</span>
          <span className="inline-flex items-center gap-1"><ZoneMark status="no_water" /> no water / shut down</span>
          {rows.some(r => r.status === 'manual') && <span className="inline-flex items-center gap-1"><ZoneMark status="manual" /> manual</span>}
          <span>EC/pH: SEKO samples while water flowed</span>
          {notOk.length === 0 && <span className="sr-only">all zones ok</span>}
        </p>
      )}
      {notes.length > 0 && (
        <details className="mt-1 text-[11px] text-muted group" data-testid="last-cycle-notes">
          <summary className="cursor-pointer select-none inline-flex items-center gap-1 min-h-[24px]">
            <svg aria-hidden="true" viewBox="0 0 10 10" className="w-2 h-2 transition-transform group-open:rotate-90"><path d="M3 1.5 7 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
            {notes.length} note{notes.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-0.5 space-y-0.5">{notes.map(n => <li key={n}>{n}</li>)}</ul>
        </details>
      )}
    </div>
  );
}
