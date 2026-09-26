import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, Label, Reading, SectionHeader, StatusPill } from '../../ui';
import { useIrrigationLive } from './useIrrigationLive';
import {
  IRRIGATION,
  deriveIrrigationView,
  formatDuration,
  formatInt,
  formatNum,
} from './irrigationLive';

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

const RELAY_TEXT = { on: 'ON', off: 'OFF', unknown: 'unknown' };

function RelayWord({ state, confirmed = true, compact = false }) {
  const cls = state === 'on' ? 'text-ok-700 dark:text-ok-300' : 'text-muted';
  const known = state === 'on' || state === 'off';
  const title = !known ? 'Relay state unknown: the board has not reported' : !confirmed ? 'Last write failed its read-back check' : undefined;
  return (
    <span className={`inline-flex items-center gap-1 font-mono tabular text-xs ${cls}`} title={title} data-relay-state={known ? state : 'unknown'}>
      <Glyph level={known ? state : 'unknown'} />
      {known ? RELAY_TEXT[state] : (compact ? '?' : 'unknown')}{known && !confirmed ? '?' : ''}
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
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block w-full h-12" role="img" aria-label="Flow over the last 10 minutes">
      <line x1="0" x2={W} y1={H - 2} y2={H - 2} className="stroke-line" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      {expected ? (
        <line x1="0" x2={W} y1={y(expected)} y2={y(expected)} className="stroke-state-idle" strokeWidth="1" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
      ) : null}
      {d && <path d={d} className="fill-none stroke-water-500 dark:stroke-water-400" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

function ZoneChip({ zone }) {
  const on = zone.state === 'on';
  const unknown = zone.state === 'unknown';
  const box = on
    ? 'border-state-ok bg-ok-50 dark:bg-ok-900/40'
    : unknown ? 'border-dashed border-state-idle' : 'border-line';
  return (
    <div className={`min-w-0 rounded-md border px-1.5 py-1.5 ${box}`} data-testid="irrigation-zone" data-state={zone.state} title={`${zone.fullLabel}: ${RELAY_TEXT[zone.state]}${!zone.confirmed ? ' (last write not confirmed)' : ''}`}>
      <span className="block truncate text-xs text-ink">{zone.label}</span>
      <RelayWord state={zone.state} confirmed={zone.confirmed} />
    </div>
  );
}

function Hint({ hint }) {
  const tone = hint.level === 'alarm'
    ? 'border-l-state-alarm bg-alarm-50 text-alarm-700 dark:bg-alarm-900/40 dark:text-alarm-300'
    : 'border-l-state-caution bg-caution-50 text-caution-700 dark:bg-caution-900/40 dark:text-caution-300';
  return (
    <li className={`flex items-start gap-2 rounded-md border-l-[3px] px-2.5 py-1.5 text-sm ${tone}`} data-testid={`irrigation-hint-${hint.key}`} data-level={hint.level}>
      <Glyph level={hint.level} className="mt-1" />
      <span className="min-w-0">{hint.text}</span>
    </li>
  );
}

/**
 * Dashboard "Irrigation" card: live flow, which zone is open, pumps, dosing
 * per tank, today's measured totals and the last cycle. Read-only - it never
 * sends a command. Mismatch hints are visual; the backend flow-watch raises
 * the actual alerts.
 */
export default function IrrigationCard({ token, subscribe, board, formatClock }) {
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

  const clock = (ms) => (ms === null || ms === undefined ? '—' : formatClock ? formatClock(ms) : new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));

  let subtitle;
  if (live.loading && !live.monitor) subtitle = 'loading…';
  else if (live.error && !live.monitor) subtitle = live.error;
  else if (!view.live) subtitle = view.lastSeenMs ? `no data since ${clock(view.lastSeenMs)} (${formatDuration(view.ageS)} ago)` : 'the monitor has not reported';
  else if (view.irrigating) subtitle = view.sinceMs ? `since ${clock(view.sinceMs)} · ${formatDuration(view.elapsedS)}` : 'start time not reported';
  else subtitle = view.lastCycle?.endMs ? `last cycle ended ${clock(view.lastCycle.endMs)}` : 'no cycle recorded yet';

  const f = view.flow;
  const devCaution = f.deviationPct !== null && Math.abs(f.deviationPct) > f.threshold && view.hints.some((h) => h.key === 'deviation');
  const openZoneText = !view.boardKnown || (view.zonesUnknown && view.openZones.length === 0)
    ? null
    : view.openZones.length === 0 ? 'None' : view.openZones.map((z) => z.label).join(' + ');
  const { zoneOpenS } = view;
  const t = view.today;
  const lc = view.lastCycle;

  return (
    <section aria-label="Irrigation" data-testid="irrigation-card">
      <SectionHeader
        title="Irrigation"
        subtitle={subtitle}
        right={(
          <>
            {view.meterFault && <StatusPill state="caution" filled title={view.faultReasons.join(', ')}>Meter fault</StatusPill>}
            <StatusPill state={view.headline.state} filled={view.headline.filled} pulse={view.irrigating} data-testid="irrigation-state">
              {view.headline.text}
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

        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)_minmax(0,1.35fr)] divide-y lg:divide-y-0 lg:divide-x divide-line">
          {/* Flow */}
          <div className="p-3 min-w-0" data-testid="irrigation-flow">
            <div className="flex items-baseline justify-between gap-2">
              <Label>Flow</Label>
              {f.fresh && <span className="font-mono tabular text-xs text-muted">{formatNum(f.lph / 1000, 2)} m³/h</span>}
            </div>
            <div className="mt-1">
              <Reading
                size="lg"
                value={f.lph === null ? null : formatInt(f.lph)}
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
                  <span>expected <span className="font-mono tabular text-ink">{formatInt(f.expectedLph)}</span> L/h</span>
                  {f.deviationPct !== null && (
                    <span className={`inline-flex items-center gap-1 font-mono tabular ${devCaution ? 'text-caution-700 dark:text-caution-300' : ''}`}>
                      {devCaution && <Glyph level="caution" />}
                      {f.deviationPct >= 0 ? '+' : '−'}{Math.abs(f.deviationPct).toFixed(1)} %
                    </span>
                  )}
                </span>
              ) : view.openZones.length === 0 ? 'no zone open' : 'expected flow not configured'}
            </p>
            <div className="mt-2">
              <Sparkline points={live.flowBuffer} nowMs={serverNow} fresh={f.fresh} expected={f.expectedLph} />
              <div className="flex justify-between text-[11px] text-muted font-mono tabular">
                <span>−10 min</span>
                <span>now</span>
              </div>
            </div>
            <p className="mt-1 text-xs text-muted font-mono tabular">
              <span className={f.fresh && f.signal !== null && f.signal < IRRIGATION.signalMin ? 'text-caution-700 dark:text-caution-300' : ''}>
                signal {f.fresh && f.signal !== null ? `${Math.round(f.signal)} %` : '—'}
              </span>
              {' · '}
              <span className={f.fresh && f.errorFlags ? 'text-caution-700 dark:text-caution-300' : ''}>
                flags {f.fresh && f.errorFlags !== null ? f.errorFlags : '—'}
              </span>
              {' · '}<span className="whitespace-nowrap">counter {f.netTotalM3 !== null ? `${formatNum(f.netTotalM3, 2)} m³` : '—'}</span>
            </p>
          </div>

          {/* Zones and pumps */}
          <div className="p-3 min-w-0" data-testid="irrigation-zones">
            <Label>Zone open</Label>
            <div className="mt-1 flex items-baseline gap-2 min-w-0">
              {openZoneText === null ? (
                <span className="text-2xl font-mono text-muted" title="Valve states unknown: the relay board has not reported">&mdash;</span>
              ) : (
                <span className={`text-2xl font-semibold truncate ${view.openZones.length ? 'text-ink' : 'text-muted'}`} data-testid="irrigation-open-zone">{openZoneText}</span>
              )}
              {zoneOpenS !== null && <span className="font-mono tabular text-xs text-muted shrink-0">for {formatDuration(zoneOpenS)}</span>}
            </div>
            {view.zones.length > 0 ? (
              <div className="mt-2 grid grid-cols-4 gap-1.5">
                {view.zones.map((z) => <ZoneChip key={z.key} zone={z} />)}
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted">{board ? 'No zone valves on the board.' : 'Waiting for relay states…'}</p>
            )}
            {view.pumps.length > 0 && (
              <ul className="mt-3 space-y-1">
                {view.pumps.map((p) => (
                  <li key={p.key} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate text-ink">{p.label}</span>
                    <RelayWord state={p.state} confirmed={p.confirmed} />
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Dosing */}
          <div className="p-3 min-w-0" data-testid="irrigation-dosing">
            <div className="grid grid-cols-[1fr_auto_auto_auto] items-baseline gap-x-2 sm:gap-x-3">
              <Label>Dosing</Label>
              <span className="text-[11px] text-muted w-12">relay</span>
              <span className="text-[11px] text-muted text-right w-14">L/h now</span>
              <span className="text-[11px] text-muted text-right w-14">today L</span>
            </div>
            <ul className="mt-1 divide-y divide-line">
              {view.tanks.map((tk) => (
                <li
                  key={tk.monitorTank}
                  className={`grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-2 sm:gap-x-3 py-1.5 ${tk.alarm ? 'bg-alarm-50 dark:bg-alarm-900/40 shadow-[inset_3px_0_0_rgb(var(--state-alarm-rgb))] -mx-3 px-3' : ''}`}
                  data-testid="irrigation-tank"
                  data-alarm={tk.alarm ? 'true' : undefined}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="inline-flex w-6 h-6 shrink-0 items-center justify-center rounded border border-line font-mono text-xs font-semibold text-ink">{tk.letter}</span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-ink" title={tk.name}>{tk.desc}</span>
                      {tk.alarm && (
                        <span className="flex items-center gap-1 text-xs font-semibold text-alarm-700 dark:text-alarm-300">
                          <Glyph level="alarm" /> dosing, no flow
                        </span>
                      )}
                    </span>
                  </span>
                  <span className="w-12"><RelayWord state={tk.relay} confirmed={tk.relayConfirmed} compact /></span>
                  {tk.metered ? (
                    <>
                      <span className="w-14 text-right">
                        <Reading size="sm" value={tk.rateLph === null ? null : formatNum(tk.rateLph, 1)} stale={tk.rateStale} unknown={!tk.rateStale && tk.rateLph === null} />
                      </span>
                      <span className="w-14 text-right font-mono tabular text-sm text-ink">{tk.todayL !== null ? formatNum(tk.todayL, 1) : <span className="text-muted">&mdash;</span>}</span>
                    </>
                  ) : (
                    <span className="col-span-2 w-[7.5rem] sm:w-[7.75rem] text-right text-xs text-muted italic" title="Tank 5 has no flow sensor on the irrigation monitor">not metered</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Today + last cycle */}
        <div className="border-t border-line p-3 grid grid-cols-2 sm:grid-cols-4 gap-3" data-testid="irrigation-today">
          <div className="min-w-0">
            <Label>Water today</Label>
            <Reading size="md" value={t.waterM3 === null ? null : formatNum(t.waterM3, 2)} unit="m³" unknown={t.waterM3 === null} />
            <p className="text-[11px] text-muted">{t.available ? (t.coverageFrom ? `measured since ${clock(Date.parse(t.coverageFrom))}` : 'measured') : (t.reason || '—')}</p>
          </div>
          <div className="min-w-0">
            <Label>Cycles today</Label>
            <Reading size="md" value={t.cycles === null ? null : String(t.cycles)} unknown={t.cycles === null} />
            <p className="text-[11px] text-muted">{t.fertL !== null ? `${formatNum(t.fertL, 1)} L dosed (A–D)` : ' '}</p>
          </div>
          <div className="col-span-2 min-w-0">
            <Label>Last cycle</Label>
            {lc ? (
              <>
                <p className="font-mono tabular text-sm text-ink mt-1">
                  {clock(lc.startMs)} · {formatDuration(lc.durationS)} · {lc.waterL !== null ? (lc.waterL >= 1000 ? `${formatNum(lc.waterL / 1000, 2)} m³` : `${formatNum(lc.waterL, 1)} L`) : '—'}
                </p>
                <p className="font-mono tabular text-xs text-muted mt-0.5">
                  {lc.tanks.length ? lc.tanks.map((x) => `${x.letter} ${x.liters !== null ? formatNum(x.liters, 1) : '—'}`).join(' · ') + ' L' : 'no dosing reported'}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted mt-1">No cycle recorded yet.</p>
            )}
          </div>
          <div className="col-span-2 sm:col-span-4 flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-sm">
            <Link to="/reports" className="text-muted underline min-h-[32px] inline-flex items-center">Reports (measured)</Link>
            <Link to="/fertigation" className="text-muted underline min-h-[32px] inline-flex items-center">Fertigation</Link>
          </div>
        </div>
      </Card>
    </section>
  );
}
