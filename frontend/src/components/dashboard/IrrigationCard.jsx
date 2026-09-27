import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { Card, Label, Reading, SectionHeader, StatusPill } from '../../ui';
import { useFormat } from '../../i18n/useFormat';
import { ltr } from '../../i18n/format';
import { useIrrigationLive } from './useIrrigationLive';
import LastCycleZones from '../LastCycleZones';
import RunList from '../irrigation/RunList';
import { RunTypeTag } from '../irrigation/RunType';
import StopIrrigationButton from '../irrigation/StopIrrigationButton';
import { IRRIGATION, deriveIrrigationView } from './irrigationLive';

// deriveIrrigationView hint keys -> irrigation:hint.<camelCase>
const HINT_KEYS = {
  'multi-zone': 'multiZone',
  'zone-no-flow': 'zoneNoFlow',
  'flow-no-zone': 'flowNoZone',
  deviation: 'deviation',
  'dosing-no-flow': 'dosingNoFlow',
};

/**
 * Status glyph: shape carries the state so it reads without colour.
 * ok = filled dot, caution = triangle, alarm = square, unknown = hollow dot.
 */
function Glyph({ level = 'unknown', className = '' }) {
  const common = `inline-block shrink-0 ${className}`;
  if (level === 'alarm') {
    return <svg aria-hidden="true" viewBox="0 0 10 10" className={`${common} w-2.5 h-2.5`}><rect x="1" y="1" width="8" height="8" className="fill-state-alarm" /></svg>;
  }
  if (level === 'caution') {
    return <svg aria-hidden="true" viewBox="0 0 10 10" className={`${common} w-2.5 h-2.5`}><path d="M5 0.8 9.6 9.2H0.4Z" className="fill-state-caution" /></svg>;
  }
  if (level === 'ok' || level === 'on') {
    return <svg aria-hidden="true" viewBox="0 0 10 10" className={`${common} w-2.5 h-2.5`}><circle cx="5" cy="5" r="4" className="fill-state-ok" /></svg>;
  }
  if (level === 'off') {
    return <svg aria-hidden="true" viewBox="0 0 10 10" className={`${common} w-2.5 h-2.5`}><circle cx="5" cy="5" r="3.5" className="fill-none stroke-state-idle" strokeWidth="1.5" /></svg>;
  }
  return <svg aria-hidden="true" viewBox="0 0 10 10" className={`${common} w-2.5 h-2.5`}><circle cx="5" cy="5" r="3.5" className="fill-none stroke-state-idle" strokeWidth="1.5" strokeDasharray="2 1.5" /></svg>;
}

function useRelayText() {
  const { t } = useTranslation('irrigation');
  return (state) => (state === 'on' ? t('common:status.on') : state === 'off' ? t('common:status.off') : t('relay.unknown'));
}

function RelayWord({ state, confirmed = true, compact = false }) {
  const { t } = useTranslation('irrigation');
  const relayText = useRelayText();
  const cls = state === 'on' ? 'text-ok-700 dark:text-ok-300' : 'text-muted';
  const known = state === 'on' || state === 'off';
  const title = !known ? t('relay.unknownTitle') : !confirmed ? t('relay.readbackFailed') : undefined;
  return (
    <span className={`inline-flex items-center gap-1 font-mono tabular text-xs ${cls}`} title={title} data-relay-state={known ? state : 'unknown'}>
      <Glyph level={known ? state : 'unknown'} />
      {known ? relayText(state) : (compact ? '?' : relayText('unknown'))}{known && !confirmed ? '?' : ''}
    </span>
  );
}

/**
 * Step sparkline of the last 10 min of flow. Readings are held until the next
 * one (the stored series is change-downsampled); gaps longer than
 * IRRIGATION.sparkGapMs break the line; the line only reaches "now" while the
 * meter is fresh. Expected flow is a dashed reference line.
 */
function Sparkline({ points, nowMs, fresh, expected }) {
  const { t } = useTranslation('irrigation');
  const W = 300;
  const H = 48;
  const x0 = nowMs - IRRIGATION.sparkWindowMs;
  const pts = (points || []).filter((p) => p.t <= nowMs + 5000);
  const maxV = Math.max(expected || 0, ...pts.map((p) => p.v), 1);
  const yMax = maxV * 1.12;
  const x = (t) => Math.max(0, Math.min(W, ((t - x0) / IRRIGATION.sparkWindowMs) * W));
  const y = (v) => H - 2 - (Math.max(0, v) / yMax) * (H - 4);

  let d = '';
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const next = pts[i + 1];
    const endT = next ? next.t : (fresh ? nowMs : p.t);
    const gap = next && next.t - p.t > IRRIGATION.sparkGapMs;
    if (endT < x0) continue;
    const startX = x(Math.max(p.t, x0));
    const needsMove = d === '' || (i > 0 && p.t - pts[i - 1].t > IRRIGATION.sparkGapMs);
    d += `${needsMove ? 'M' : 'L'}${startX.toFixed(1)},${y(p.v).toFixed(1)}`;
    const holdTo = gap ? p.t : endT;
    d += `L${x(holdTo).toFixed(1)},${y(p.v).toFixed(1)}`;
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block w-full h-12" role="img" aria-label={t('flow.sparklineAria')}>
      <line x1="0" x2={W} y1={H - 2} y2={H - 2} className="stroke-line" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      {expected ? (
        <line x1="0" x2={W} y1={y(expected)} y2={y(expected)} className="stroke-state-idle" strokeWidth="1" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
      ) : null}
      {d && <path d={d} className="fill-none stroke-water-500 dark:stroke-water-400" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

function ZoneChip({ zone }) {
  const { t } = useTranslation('irrigation');
  const relayText = useRelayText();
  const on = zone.state === 'on';
  const unknown = zone.state === 'unknown';
  const box = on
    ? 'border-state-ok bg-ok-50 dark:bg-ok-900/40'
    : unknown ? 'border-dashed border-state-idle' : 'border-line';
  return (
    <div className={`min-w-0 rounded-md border px-1.5 py-1.5 ${box}`} data-testid="irrigation-zone" data-state={zone.state} title={`${zone.fullLabel}: ${relayText(zone.state)}${!zone.confirmed ? ` ${t('zones.notConfirmed')}` : ''}`}>
      <span className="block truncate text-xs text-ink" dir="auto">{zone.label}</span>
      <RelayWord state={zone.state} confirmed={zone.confirmed} />
    </div>
  );
}

function Hint({ hint }) {
  const { t } = useTranslation('irrigation');
  const fmt = useFormat();
  const p = hint.params || {};
  const key = HINT_KEYS[hint.key];
  const text = key ? t(`hint.${key}`, {
    ...p,
    duration: p.seconds !== undefined ? fmt.duration(p.seconds) : undefined,
    flow: p.flowLph !== undefined ? fmt.int(p.flowLph) : undefined,
    pct: p.pct !== undefined ? ltr(fmt.percent(p.pct, { signed: true })) : undefined,
    defaultValue: hint.text,
  }) : hint.text;
  const tone = hint.level === 'alarm'
    ? 'border-s-state-alarm bg-alarm-50 text-alarm-700 dark:bg-alarm-900/40 dark:text-alarm-300'
    : 'border-s-state-caution bg-caution-50 text-caution-700 dark:bg-caution-900/40 dark:text-caution-300';
  return (
    <li className={`flex items-start gap-2 rounded-md border-s-[3px] px-2.5 py-1.5 text-sm ${tone}`} data-testid={`irrigation-hint-${hint.key}`} data-level={hint.level}>
      <Glyph level={hint.level} className="mt-1" />
      <span className="min-w-0">{text}</span>
    </li>
  );
}

/**
 * Dashboard "Irrigation" card: live flow, which zone is open, pumps, dosing
 * per tank, today's measured totals and the last cycle. Its one command is
 * "Stop irrigation" (admin/operator, confirmed; pumps, zones and dosing only —
 * fans and climate keep running). Mismatch hints are visual; the backend
 * flow-watch raises the actual alerts.
 */
export default function IrrigationCard({ token, subscribe, board, formatClock }) {
  const { t } = useTranslation('irrigation');
  const fmt = useFormat();
  const live = useIrrigationLive({ token, subscribe });
  const [nowLocal, setNowLocal] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) setNowLocal(Date.now()); }, 1000);
    return () => clearInterval(id);
  }, []);

  const serverNow = nowLocal + (live.skewMs || 0);
  const view = useMemo(() => deriveIrrigationView({
    monitor: live.monitor,
    board,
    channelConfig: live.channelConfig,
    report: live.report,
    flowBuffer: live.flowBuffer,
    serverNowMs: serverNow,
    firstSeenOnMs: live.firstSeenOnMs,
  }), [live.monitor, board, live.channelConfig, live.report, live.flowBuffer, serverNow, live.firstSeenOnMs]);

  const zoneSig = view.zones.map((z) => `${z.key}=${z.state}`).join('|');
  const { noteZoneStates } = live;
  useEffect(() => { noteZoneStates(view.zones); }, [zoneSig]); // eslint-disable-line react-hooks/exhaustive-deps

  const clock = (ms) => (ms === null || ms === undefined || Number.isNaN(ms) ? '—' : formatClock ? formatClock(ms) : fmt.clock(ms));
  const num = (v, d) => fmt.number(v, { decimals: d });
  const water = (l) => (l === null || l === undefined ? '—' : l >= 1000 ? fmt.withUnit(l / 1000, 'm³', { decimals: 2 }) : fmt.withUnit(l, 'L', { decimals: 1 }));

  let subtitle;
  if (live.loading && !live.monitor) subtitle = t('common:status.loadingShort');
  else if (live.error && !live.monitor) subtitle = t('card.monitorUnavailable', { error: live.error });
  else if (!view.live) subtitle = view.lastSeenMs ? t('card.noDataSince', { time: clock(view.lastSeenMs), age: fmt.duration(view.ageS) }) : t('card.monitorNotReported');
  else if (view.irrigating) subtitle = view.sinceMs ? t('card.since', { time: clock(view.sinceMs), elapsed: fmt.duration(view.elapsedS) }) : t('card.startNotReported');
  else subtitle = view.lastCycle?.endMs ? t('card.lastCycleEnded', { time: clock(view.lastCycle.endMs) }) : t('card.noCycleYet');

  const f = view.flow;
  const devCaution = f.deviationPct !== null && Math.abs(f.deviationPct) > f.threshold && view.hints.some((h) => h.key === 'deviation');
  const openZoneText = !view.boardKnown || (view.zonesUnknown && view.openZones.length === 0)
    ? null
    : view.openZones.length === 0 ? t('zones.none') : view.openZones.map((z) => z.label).join(' + ');
  const { zoneOpenS } = view;
  const td = view.today;
  const lc = view.lastCycle;
  const runsToday = live.todayRuns && Array.isArray(live.todayRuns.runs) ? live.todayRuns : null;
  const manualToday = runsToday ? runsToday.runs.filter((r) => r.type !== 'automated').length : 0;
  const lastRunIsRun = !!(live.lastRun && live.lastRun.type);
  // emphasise Stop irrigation while water runs or any irrigation / dosing relay is ON
  const irrigationActive = view.irrigating || view.openZones.length > 0
    || view.pumps.some((p) => p.state === 'on') || view.tanks.some((tk) => tk.relay === 'on');

  return (
    <section aria-label={t('card.title')} data-testid="irrigation-card">
      <SectionHeader
        title={t('card.title')}
        subtitle={subtitle}
        right={(
          <>
            {view.meterFault && (
              <StatusPill state="caution" filled title={(view.faults || []).map((x) => t(`fault.${x.key}`, { value: x.value })).join(', ')}>
                {t('card.meterFault')}
              </StatusPill>
            )}
            <StatusPill state={view.headline.state} filled={view.headline.filled} pulse={view.irrigating} data-testid="irrigation-state">
              {t(`headline.${view.headline.key}`, { defaultValue: view.headline.text })}
            </StatusPill>
          </>
        )}
      />

      <Card rail={view.rail} padding="none" className="overflow-hidden" data-rail={view.rail}>
        {view.hints.length > 0 && (
          <ul className="space-y-1.5 p-3 pb-0" data-testid="irrigation-hints">
            {view.hints.map((h) => <Hint key={h.key} hint={h} />)}
          </ul>
        )}

        <StopIrrigationButton active={irrigationActive} formatTime={(iso) => clock(Date.parse(iso))} className="p-3 border-b border-line" />

        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)_minmax(0,1.35fr)] divide-y lg:divide-y-0 lg:divide-x rtl:lg:divide-x-reverse divide-line">
          {/* Flow */}
          <div className="p-3 min-w-0" data-testid="irrigation-flow">
            <div className="flex items-baseline justify-between gap-2">
              <Label>{t('flow.label')}</Label>
              {f.fresh && <span className="font-mono tabular text-xs text-muted" dir="ltr">{num(f.lph / 1000, 2)} m³/h</span>}
            </div>
            <div className="mt-1">
              <Reading
                size="lg"
                value={f.lph === null ? null : fmt.int(f.lph)}
                unit="L/h"
                unknown={f.unknown}
                stale={!f.unknown && !f.fresh}
                since={f.receivedMs ? new Date(f.receivedMs).toISOString() : null}
                data-testid="irrigation-flow-value"
              />
            </div>
            <p className="mt-1 text-xs text-muted min-h-[1rem]">
              {f.expectedLph !== null ? (
                <span className="inline-flex flex-wrap items-center gap-x-1.5">
                  <span>
                    <Trans
                      i18nKey="irrigation:flow.expected"
                      values={{ value: fmt.int(f.expectedLph) }}
                      components={{ v: <span className="font-mono tabular text-ink" dir="ltr" /> }}
                    />
                  </span>
                  {f.deviationPct !== null && (
                    <span dir="ltr" className={`inline-flex items-center gap-1 font-mono tabular ${devCaution ? 'text-caution-700 dark:text-caution-300' : ''}`}>
                      {devCaution && <Glyph level="caution" />}
                      {fmt.percent(f.deviationPct, { decimals: 1, signed: true })}
                    </span>
                  )}
                </span>
              ) : view.openZones.length === 0 ? t('flow.noZoneOpen') : t('flow.expectedNotConfigured')}
            </p>
            {/* time runs left -> right in every language */}
            <div className="mt-2" dir="ltr">
              <Sparkline points={live.flowBuffer} nowMs={serverNow} fresh={f.fresh} expected={f.expectedLph} />
              <div className="flex justify-between text-[11px] text-muted font-mono tabular">
                <span>{t('flow.axisStart')}</span>
                <span>{t('flow.axisNow')}</span>
              </div>
            </div>
            <p className="mt-1 text-xs text-muted font-mono tabular">
              <span className={f.fresh && f.signal !== null && f.signal < IRRIGATION.signalMin ? 'text-caution-700 dark:text-caution-300' : ''}>
                {t('flow.signal', { value: f.fresh && f.signal !== null ? fmt.percent(f.signal) : '—' })}
              </span>
              {' · '}
              <span className={f.fresh && f.errorFlags ? 'text-caution-700 dark:text-caution-300' : ''}>
                {t('flow.flags', { value: f.fresh && f.errorFlags !== null ? f.errorFlags : '—' })}
              </span>
              {' · '}<span className="whitespace-nowrap">{t('flow.counter', { value: f.netTotalM3 !== null ? fmt.withUnit(f.netTotalM3, 'm³', { decimals: 2 }) : '—' })}</span>
            </p>
          </div>

          {/* Zones and pumps */}
          <div className="p-3 min-w-0" data-testid="irrigation-zones">
            <Label>{t('zones.label')}</Label>
            <div className="mt-1 flex items-baseline gap-2 min-w-0">
              {openZoneText === null ? (
                <span className="text-2xl font-mono text-muted" title={t('zones.unknownTitle')}>&mdash;</span>
              ) : (
                <span className={`text-2xl font-semibold truncate ${view.openZones.length ? 'text-ink' : 'text-muted'}`} data-testid="irrigation-open-zone">{openZoneText}</span>
              )}
              {zoneOpenS !== null && <span className="font-mono tabular text-xs text-muted shrink-0">{t('zones.forDuration', { duration: fmt.duration(zoneOpenS) })}</span>}
            </div>
            {view.zones.length > 0 ? (
              // 2 columns where the zone column is narrow (phone, 3-column desktop card):
              // "OFF" is 3 letters, "KAPALI" / "مطفأ" are not.
              <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-2 gap-1.5">
                {view.zones.map((z) => <ZoneChip key={z.key} zone={z} />)}
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted">{board ? t('zones.noValves') : t('zones.waiting')}</p>
            )}
            {view.pumps.length > 0 && (
              <ul className="mt-3 space-y-1">
                {view.pumps.map((p) => (
                  <li key={p.key} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate text-ink" dir="auto">{p.label}</span>
                    <RelayWord state={p.state} confirmed={p.confirmed} />
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Dosing */}
          <div className="p-3 min-w-0" data-testid="irrigation-dosing">
            <div className="grid grid-cols-[1fr_auto_auto_auto] items-baseline gap-x-2 sm:gap-x-3">
              <Label>{t('dosing.label')}</Label>
              <span className="text-[11px] text-muted w-12">{t('dosing.colRelay')}</span>
              <span className="text-[11px] text-muted text-end w-14">{t('dosing.colNow')}</span>
              <span className="text-[11px] text-muted text-end w-14">{t('dosing.colToday')}</span>
            </div>
            <ul className="mt-1 divide-y divide-line">
              {view.tanks.map((tk) => (
                <li
                  key={tk.monitorTank}
                  className={`grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-2 sm:gap-x-3 py-1.5 ${tk.alarm ? 'bg-alarm-50 dark:bg-alarm-900/40 shadow-[inset_3px_0_0_rgb(var(--state-alarm-rgb))] rtl:shadow-[inset_-3px_0_0_rgb(var(--state-alarm-rgb))] -mx-3 px-3' : ''}`}
                  data-testid="irrigation-tank"
                  data-alarm={tk.alarm ? 'true' : undefined}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="inline-flex w-6 h-6 shrink-0 items-center justify-center rounded border border-line font-mono text-xs font-semibold text-ink">{tk.letter}</span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-ink" dir="auto" title={tk.name}>{tk.desc}</span>
                      {tk.alarm && (
                        <span className="flex items-center gap-1 text-xs font-semibold text-alarm-700 dark:text-alarm-300">
                          <Glyph level="alarm" /> {t('dosing.noFlow')}
                        </span>
                      )}
                    </span>
                  </span>
                  <span className="w-12"><RelayWord state={tk.relay} confirmed={tk.relayConfirmed} compact /></span>
                  {tk.metered ? (
                    <>
                      <span className="w-14 text-end">
                        <Reading size="sm" value={tk.rateLph === null ? null : num(tk.rateLph, 1)} stale={tk.rateStale} unknown={!tk.rateStale && tk.rateLph === null} />
                      </span>
                      <span className="w-14 text-end font-mono tabular text-sm text-ink">{tk.todayL !== null ? num(tk.todayL, 1) : <span className="text-muted">&mdash;</span>}</span>
                    </>
                  ) : (
                    <span className="col-span-2 w-[7.5rem] sm:w-[7.75rem] text-end text-xs text-muted italic" title={t('dosing.notMeteredTitle', { tank: tk.letter })}>{t('dosing.notMetered')}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Today + last cycle */}
        <div className="border-t border-line p-3 grid grid-cols-2 sm:grid-cols-4 gap-3" data-testid="irrigation-today">
          <div className="min-w-0">
            <Label>{t('today.water')}</Label>
            <Reading size="md" value={td.waterM3 === null ? null : num(td.waterM3, 2)} unit="m³" unknown={td.waterM3 === null} />
            <p className="text-[11px] text-muted">
              {td.available
                ? (td.coverageFrom ? t('today.measuredSince', { time: clock(Date.parse(td.coverageFrom)) }) : t('today.measured'))
                : (td.reasonKey ? t(`today.reason.${td.reasonKey}`) : (td.reason || '—'))}
            </p>
          </div>
          <div className="min-w-0">
            {runsToday ? (
              <>
                <Label>{t('today.runs')}</Label>
                <Reading size="md" value={String(runsToday.total)} />
                <p className="text-[11px] text-muted" data-testid="irrigation-runs-today-sub">
                  {manualToday > 0 ? `${t('today.manualCount', { count: manualToday })} · ` : ''}
                  {td.fertL !== null
                    ? t('today.dosed', { value: num(td.fertL, 1) })
                    : (td.cycles !== null ? t('today.monitorCycles', { count: td.cycles }) : ' ')}
                </p>
              </>
            ) : (
              <>
                <Label>{t('today.cycles')}</Label>
                <Reading size="md" value={td.cycles === null ? null : String(td.cycles)} unknown={td.cycles === null} />
                <p className="text-[11px] text-muted">{td.fertL !== null ? t('today.dosedTanks', { value: num(td.fertL, 1) }) : ' '}</p>
              </>
            )}
          </div>
          <div className="col-span-2 min-w-0">
            <Label>{lastRunIsRun ? t('today.lastRun') : t('today.lastCycle')}</Label>
            {lastRunIsRun ? (
              <>
                <p className="font-mono tabular text-sm text-ink mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span>{clock(Date.parse(live.lastRun.started_at))} · {fmt.duration(live.lastRun.duration_s)} · {water(live.lastRun.water_l)}</span>
                  <RunTypeTag run={live.lastRun} short />
                </p>
                <p className="font-mono tabular text-xs text-muted mt-0.5" dir="ltr">
                  {(live.lastRun.tanks || []).length ? live.lastRun.tanks.map((x) => `${(/Tank\s+([A-Z])/.exec(x.name || '') || [])[1] || x.tank_id} ${num(x.dosed_l, 1)}`).join(' · ') + ' L' : <span dir="auto">{t('today.noDosing')}</span>}
                </p>
              </>
            ) : lc ? (
              <>
                <p className="font-mono tabular text-sm text-ink mt-1">
                  {clock(lc.startMs)} · {fmt.duration(lc.durationS)} · {water(lc.waterL)}
                </p>
                <p className="font-mono tabular text-xs text-muted mt-0.5" dir="ltr">
                  {lc.tanks.length ? lc.tanks.map((x) => `${x.letter} ${x.liters !== null ? num(x.liters, 1) : '—'}`).join(' · ') + ' L' : <span dir="auto">{t('today.noDosing')}</span>}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted mt-1">{t('today.noCycle')}</p>
            )}
          </div>
          {live.lastRun !== undefined && (
            <div className="col-span-2 sm:col-span-4 min-w-0 border-t border-line pt-3" data-testid="irrigation-last-cycle-zones">
              <Label>{t('today.lastCyclePerZone')}</Label>
              {live.lastRun ? (
                <LastCycleZones run={live.lastRun} formatTime={(iso) => clock(Date.parse(iso))} className="mt-1" />
              ) : (
                <p className="text-sm text-muted mt-1">{t('today.noRun')}</p>
              )}
            </div>
          )}
          {runsToday && (
            <div className="col-span-2 sm:col-span-4 min-w-0" data-testid="irrigation-runs-today">
              <div className="flex items-baseline justify-between gap-2">
                <Label>{t('today.todaysRuns')}</Label>
                <span className="font-mono tabular text-xs text-muted" dir="ltr">{runsToday.total} · {num((runsToday.water_l || 0) / 1000, 2)} m³</span>
              </div>
              <RunList runs={runsToday.runs} formatTime={(iso) => clock(Date.parse(iso))} highlightId={lastRunIsRun ? live.lastRun.id : null} className="mt-1" />
            </div>
          )}
          <div className="col-span-2 sm:col-span-4 flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-sm">
            <Link to="/reports" className="text-muted underline min-h-[32px] inline-flex items-center">{t('today.reportsLink')}</Link>
            <Link to="/fertigation" className="text-muted underline min-h-[32px] inline-flex items-center">{t('nav:items.fertigation')}</Link>
          </div>
        </div>
      </Card>
    </section>
  );
}
