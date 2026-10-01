import React, { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Card, Label, Reading } from '../ui';
import { StatusMark } from './agronomist/SectionStatus';
import { useAuth } from '../context/AuthContext';
import { startPolling } from '../hooks/usePoll';
import { isNetworkError, isTransientNow } from '../utils/connectivity';
import LastCycleZones from './LastCycleZones';
import { useFormat } from '../i18n/useFormat';

/**
 * Closed-loop dose controller card (GET /api/dose-controller/status, polled 4 s).
 *
 * Status is shape + colour + text (FARM-APP-STANDARDS 4.1 / 5): filled circle
 * ok, triangle caution, square alarm, dashed hollow circle unknown/stale.
 * Valves: filled = commanded open, hollow = commanded closed, dashed = the
 * board's read-back is unknown/stale, triangle = read-back disagrees. A stale
 * pH sample renders "—" with its age, never as a value. Feed EC in mS/cm.
 */

// Label text: fertigation:doseController.state.<key> (en: Alarm, Caution, Closed loop,
// Waiting, Idle, Off, Unknown).
const STATE = {
  alarm: { mark: 'alarm', rail: 'alarm' },
  caution: { mark: 'caution', rail: 'caution' },
  ok: { mark: 'ok', rail: 'ok' },
  waiting: { mark: 'unknown', rail: 'stale' },
  idle: { mark: 'idle', rail: 'idle' },
  off: { mark: 'unknown', rail: 'idle' },
  unknown: { mark: 'unknown', rail: 'stale' },
};

// Mode text: fertigation:doseController.mode.<mode> (closed_loop, fallback, hold, waiting).

const TEXT = {
  alarm: 'text-alarm-600 dark:text-alarm-300',
  caution: 'text-caution-700 dark:text-caution-300',
  ok: 'text-ink',
  idle: 'text-muted',
  unknown: 'text-muted',
};

// pH sample states with a note: fertigation:doseController.phState.<state>. 'ok' has none.
const PH_STATE_NOTE = new Set(['idle', 'start_delay', 'waiting', 'stale', 'frozen', 'implausible']);

// Raw mS/cm number for <Reading> (it formats itself).
const mSRaw = (us, d = 2) => (us === null || us === undefined || !Number.isFinite(Number(us)) ? null : Number((Number(us) / 1000).toFixed(d)));

/** Display formatters bound to the active language ('.' decimals, '—' for absence). */
function useNums() {
  const f = useFormat();
  return {
    f,
    fmt: (x, d = 1) => f.number(x, { decimals: d }),
    fmtInt: (x) => f.int(x),
    mS: (us, d = 2) => f.number(mSRaw(us, d), { decimals: d }),
    fmtDur: (s) => f.duration(s, { compact: true }),
  };
}

function Mark({ state }) {
  const { t } = useTranslation('fertigation');
  if (state === 'idle') {
    return (
      <span className="inline-flex items-center shrink-0 text-state-idle" data-status="idle">
        <svg aria-hidden="true" viewBox="0 0 12 12" className="w-3 h-3"><circle cx="6" cy="6" r="5" fill="currentColor" /></svg>
        <span className="sr-only">{t('flowWatch.srIdle')}</span>
      </span>
    );
  }
  return <StatusMark status={state} />;
}

/** Valve mark: filled = open, hollow = closed, dashed = read-back unknown, triangle = read-back disagrees. */
function ValveMark({ valve, actual }) {
  const { t } = useTranslation('fertigation');
  const open = valve === 'open';
  const mismatch = actual !== null && actual !== undefined && actual !== open;
  const unknown = actual === null || actual === undefined;
  const title = t('doseController.valve.title', {
    commanded: open ? t('doseController.valve.open') : t('doseController.valve.closed'),
    actual: unknown ? t('doseController.valve.unknown') : actual ? t('doseController.valve.open') : t('doseController.valve.closed'),
  });
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${mismatch ? 'text-caution-700 dark:text-caution-300' : 'text-ink'}`} title={title} data-valve={valve} data-valve-actual={unknown ? 'unknown' : String(actual)}>
      <svg aria-hidden="true" viewBox="0 0 12 12" className="w-3 h-3 shrink-0">
        {mismatch ? <path d="M6 1 L11.2 10.5 H0.8 Z" fill="currentColor" />
          : open ? <circle cx="6" cy="6" r="4.6" fill="currentColor" stroke="currentColor" strokeWidth="1.6" strokeDasharray={unknown ? '2.2 1.6' : undefined} />
            : <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray={unknown ? '2.2 1.6' : undefined} />}
      </svg>
      <span>{open ? t('doseController.valve.open') : t('doseController.valve.closed')}</span>
      <span className="sr-only">{title}</span>
    </span>
  );
}

function deriveState(s, error) {
  if (error || !s) return 'unknown';
  if (!s.enabled) return 'off';
  if (!s.running) return 'idle';
  if (s.ph && s.ph.tripped) return 'alarm';
  if ((s.tanks || []).some(t => t.drawing && t.drawing.alarm)) return 'alarm'; // a tank is not drawing
  const tankFlag = (s.tanks || []).some(t => t.limited || (t.actual !== null && t.actual !== undefined && t.actual !== (t.valve === 'open')));
  if (s.mode === 'fallback' || s.mode === 'hold' || (s.ph && s.ph.fault) || s.ph?.sample_state === 'stale' || tankFlag) return 'caution';
  if (s.mode === 'waiting') return 'waiting';
  return 'ok';
}

function TankRow({ t, ratioTarget }) {
  const { t: tr } = useTranslation('fertigation');
  const { fmt, fmtInt, fmtDur } = useNums();
  const mono = <span className="font-mono tabular text-ink" />;
  const monoMuted = <span className="font-mono tabular" />;
  const achieved = t.achieved_ratio;
  const dev = t.deviation_pct;
  const off = dev !== null && dev !== undefined && Math.abs(dev) > 5;
  return (
    <li className="py-1.5 border-t border-line first:border-t-0" data-testid="dose-tank" data-tank={t.tank_id}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-semibold text-ink text-sm min-w-[4.5rem]" dir="auto">{t.name}</span>
        <ValveMark valve={t.valve} actual={t.actual} />
        <span className="text-xs text-muted">
          <Trans t={tr} i18nKey="doseController.tank.zone" values={{ dosed: fmt(t.zone_dosed_l, 2), target: fmt(t.zone_target_l, 2) }}
            components={{ v: mono, m: monoMuted }} />
        </span>
        <span className="text-xs text-muted">
          <Trans t={tr} i18nKey="doseController.tank.run" values={{ dosed: fmt(t.dosed_l, 2), target: fmt(t.target_l, 2) }}
            components={{ v: mono, m: monoMuted }} />
        </span>
        <span className={`text-xs font-mono tabular ${off ? 'text-caution-700 dark:text-caution-300' : 'text-ink'}`} title={tr('doseController.tank.targetRatio', { ratio: ratioTarget ?? t.ratio_target })}>
          <span dir="ltr">1:{achieved ? fmtInt(achieved) : '—'}</span>
          <span className="text-muted font-sans"> · {tr('doseController.tank.targetRatio', { ratio: fmtInt(t.ratio_target ?? ratioTarget) })}</span>
        </span>
        {t.limited && (
          <span className="inline-flex items-center gap-1 text-xs text-caution-700 dark:text-caution-300" data-testid="cant-reach">
            <StatusMark status="caution" /> {tr('doseController.tank.cantReach')}
          </span>
        )}
        {t.drawing && t.drawing.state === 'not_drawing' && (
          <span className={`inline-flex items-center gap-1 text-xs font-semibold ${t.drawing.alarm ? 'text-alarm-700 dark:text-alarm-300' : 'text-caution-700 dark:text-caution-300'}`} data-testid="not-drawing">
            <StatusMark status={t.drawing.alarm ? 'alarm' : 'caution'} /> {tr('doseController.tank.notDrawing', { duration: fmtDur(t.drawing.not_drawing_s) })}
          </span>
        )}
        {t.equal_draw && t.equal_draw.pacer && (
          <span className="text-xs text-muted" data-testid="eq-pacer">{tr('doseController.tank.eqPacer')}</span>
        )}
        {t.equal_draw && t.equal_draw.held && t.valve !== 'open' && (
          t.equal_draw.held_why === 'equal draw: held — a tank is not drawing'
            ? <span className="inline-flex items-center gap-1 text-xs font-semibold text-alarm-700 dark:text-alarm-300" data-testid="eq-held-failure"><StatusMark status="alarm" /> {tr('doseController.tank.eqHeldFailure')}</span>
            : <span className="text-xs text-muted" data-testid="eq-held">{tr('doseController.tank.eqHeld')}</span>
        )}
        {t.redraw_retry && (t.redraw_retry.phase === 'off' || t.redraw_retry.phase === 'verify') && (
          <span className="inline-flex items-center gap-1 text-xs text-caution-700 dark:text-caution-300" data-testid="redraw-retry">
            <StatusMark status="caution" /> {tr('doseController.tank.retrying')}
          </span>
        )}
      </div>
    </li>
  );
}

function LastRun({ run, when }) {
  const { t: tr } = useTranslation('fertigation');
  const { fmt, fmtInt, mS, fmtDur } = useNums();
  if (!run) return null;
  const mono = <span className="font-mono tabular text-ink" />;
  const monoMuted = <span className="font-mono tabular" />;
  const flags = [];
  if (run.modes && run.modes.fallback_s > 0) flags.push(tr('doseController.lastRun.fallback', { duration: fmtDur(run.modes.fallback_s) }));
  const limited = (run.tanks || []).filter(t => t.physics_limited || t.cant_reach_zones > 0);
  if (limited.length) flags.push(tr('doseController.lastRun.cantReach', { tanks: limited.map(t => t.name).join(', ') }));
  const phTrip = (run.trips || []).find(t => t.kind === 'ph_floor');
  if (phTrip) flags.push(tr('doseController.lastRun.phFloorTripped'));
  const zero = (run.tanks || []).filter(t => t.delivered_zero);
  if (zero.length) flags.push(tr('doseController.lastRun.deliveredZero', { tanks: zero.map(t => t.name).join(', ') }));
  const drew = (run.tanks || []).filter(t => (t.redraw_retries || []).some(x => x.result === 'drew'));
  if (drew.length) flags.push(tr('doseController.lastRun.redrawOk', { tanks: drew.map(t => t.name).join(', ') }));
  if (run.status !== 'completed') flags.push(tr(`doseController.runStatus.${run.status}`, { defaultValue: run.status }));
  return (
    <div className="mt-3 pt-2 border-t border-line text-xs text-muted" data-testid="dose-last-run">
      <span className="block font-semibold uppercase tracking-wider">{tr('doseController.lastRun.title')}</span>
      <LastCycleZones run={run} formatTime={when} compact className="mt-1" />
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
        {[...(run.tanks || [])].sort((a, b) => a.tank_id - b.tank_id).map(t => (
          <span key={t.tank_id}><span dir="auto">{t.name}</span> <span className="font-mono tabular text-ink" dir="ltr">1:{t.achieved_ratio ? fmtInt(t.achieved_ratio) : '—'}</span></span>
        ))}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
        <span>
          <Trans t={tr} i18nKey="doseController.lastRun.ph"
            values={{ min: fmt(run.ph?.min, 2), max: fmt(run.ph?.max, 2), avg: fmt(run.ph?.avg, 2), last: fmt(run.ph?.last, 2) }}
            components={{ v: <span className="font-mono tabular text-ink" dir="ltr" />, m: monoMuted }} />
        </span>
        <span>EC <span className="font-mono tabular text-ink">{mS(run.ec_us?.avg)}</span> mS/cm</span>
        <span>
          <Trans t={tr} i18nKey="doseController.lastRun.acid" values={{ seconds: fmt(run.acid_s, 0), litres: fmt(run.acid_est_l, 2) }}
            components={{ v: mono, m: monoMuted }} />
        </span>
      </div>
      {flags.length > 0 && (
        <div className="mt-1 inline-flex items-center gap-1 text-caution-700 dark:text-caution-300"><StatusMark status="caution" /> {flags.join(' · ')}</div>
      )}
    </div>
  );
}

export default function DoseControllerStatus({ formatDateTime }) {
  const { t } = useTranslation('fertigation');
  const { f, fmt, fmtInt, fmtDur } = useNums();
  const mono = <span className="font-mono tabular text-ink" />;
  const monoMuted = <span className="font-mono tabular" />;
  const { token } = useAuth();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let mounted = true;
    const poll = async () => {
      try {
        const r = await fetch('/api/dose-controller/status', { headers: { Authorization: `Bearer ${token}` } });
        if (!mounted) return;
        if (r.ok) { setStatus(await r.json()); setError(false); } else setError(true);
      } catch (e) {
        // Tab resume / radio waking up: keep showing the last status, not "unknown".
        if (isNetworkError(e) && isTransientNow()) return;
        if (mounted) setError(true);
      }
    };
    poll();
    const stopPoll = startPolling(poll, 4000); // paused while hidden, one refresh on resume
    return () => { mounted = false; stopPoll(); };
  }, [token]);

  if (!status && !error) return null;

  const state = deriveState(status, error);
  const cfg = STATE[state] || STATE.unknown;
  const when = (iso) => (iso ? (formatDateTime ? formatDateTime(iso) : f.dateTime(iso)) : '—');
  const s = status || {};
  const ph = s.ph || null;
  const zone = s.zone || null;
  const ratioTarget = s.setpoints?.ratio ? Object.values(s.setpoints.ratio)[0] : 150;

  let line;
  if (error || !status) line = <span className="text-muted">{t('doseController.unavailable')}</span>;
  else if (!s.enabled) line = <span className="text-muted">{t('doseController.switchedOff')}</span>;
  else if (!s.running) {
    line = (
      <span className="text-muted">
        {t('doseController.noCycle')}
        {s.acid_day_used_s !== null && s.acid_day_used_s !== undefined && (
          <>{' '}<Trans t={t} i18nKey="doseController.acidTodayLine"
            values={{ used: fmt(s.acid_day_used_s, 0), cap: fmt(s.setpoints?.acid_cap_day_s, 0) }}
            components={{ v: mono, m: monoMuted }} /></>
        )}
      </span>
    );
  } else {
    line = (
      <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-ink font-semibold">{t(`doseController.mode.${s.mode}`, { defaultValue: s.mode })}</span>
        {/* mode_reason: server text, shown as-is */}
        {s.mode !== 'closed_loop' && s.mode_reason && <span className="text-xs text-muted">{s.mode_reason}</span>}
      </span>
    );
  }

  return (
    <Card rail={cfg.rail} padding="sm" data-testid="dose-controller-status" data-dose-state={state}>
      <div className="flex items-center justify-between gap-3">
        <Label>{t('doseController.title')}</Label>
        <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${TEXT[cfg.mark] || 'text-muted'}`}>
          <Mark state={cfg.mark} />
          {t(`doseController.state.${STATE[state] ? state : 'unknown'}`)}
        </span>
      </div>
      <div className="mt-1.5 text-sm">{line}</div>

      {s.running && (
        <>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            {zone ? (
              <span>
                <span className="text-ink font-semibold" dir="auto">{zone.name}</span>
                {zone.slots > 1 ? <> · {t('doseController.half', { n: zone.slot + 1 })}</> : ''}
                {zone.remaining_s !== null && zone.remaining_s !== undefined && <> · <Trans t={t} i18nKey="doseController.left" values={{ time: fmtDur(zone.remaining_s) }} components={{ m: monoMuted }} /></>}
                {' · '}<Trans t={t} i18nKey="doseController.zoneWater" values={{ water: fmtInt(zone.water_l), expected: fmtInt(zone.expected_water_l) }} components={{ v: mono, m: monoMuted }} />
              </span>
            ) : null}
            <span>
              <Trans t={t} i18nKey="doseController.runWater" values={{ litres: fmtInt(s.water?.litres) }} components={{ v: mono }} />{' · '}
              <Reading value={s.water?.flow_lph ?? null} unit="L/h" size="sm" precision={0} className="!text-xs"
                stale={s.water && s.water.flow_lph !== null && !s.water.known} unknown={!s.water || s.water.flow_lph === null} />
            </span>
            <span><Trans t={t} i18nKey="doseController.endsIn" values={{ time: fmtDur(s.cycle?.remaining_s) }} components={{ m: monoMuted }} /></span>
          </div>

          {s.equal_draw && s.equal_draw.enabled && (
            <p className="mt-1.5 text-xs text-muted" data-testid="dose-equal-draw">
              <Trans t={t} i18nKey="doseController.equalDraw"
                values={{ tank: s.equal_draw.pacer ? s.equal_draw.pacer.name : '—', spread: fmt(s.equal_draw.spread_est_l, 2), tol: fmt(s.equal_draw.tolerance_l, 1) }}
                components={{ v: mono, m: monoMuted }} />
            </p>
          )}
          <ul className="mt-2" aria-label={t('doseController.tanksAria')}>
            {[...(s.tanks || [])].sort((a, b) => a.tank_id - b.tank_id).map(t => <TankRow key={t.tank_id} t={t} ratioTarget={ratioTarget} />)}
          </ul>

          {ph && (
            <div className="mt-2 pt-2 border-t border-line" data-testid="dose-ph" data-ph-state={ph.tripped ? 'alarm' : ph.sample_state}>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <Label as="span" className="!inline">{t('doseController.feedPh')}</Label>
                <Reading value={ph.value} precision={2} size="sm"
                  stale={ph.value !== null && (ph.sample_state === 'stale' || ph.sample_state === 'idle' || ph.sample_state === 'start_delay')}
                  unknown={ph.value === null} since={ph.sample_at} />
                <span className="text-xs text-muted">
                  <Trans t={t} i18nKey="doseController.setpointLine" values={{ setpoint: fmt(ph.setpoint, 2), deadband: fmt(ph.deadband, 2), floor: fmt(ph.floor, 2) }}
                    components={{ m: <span className="font-mono tabular" dir="ltr" /> }} />
                </span>
                <span className="text-xs text-muted inline-flex items-baseline gap-1">EC
                  <Reading value={ph.ec_us === null || ph.ec_us === undefined ? null : mSRaw(ph.ec_us)} precision={2} unit="mS/cm" size="sm" className="!text-xs"
                    stale={ph.ec_us !== null && ph.ec_us !== undefined && ph.sample_state !== 'ok'} unknown={ph.ec_us === null || ph.ec_us === undefined} since={ph.sample_at} />
                </span>
              </div>
              {ph.tripped ? (
                <div className="mt-1 inline-flex items-center gap-1.5 text-sm text-alarm-600 dark:text-alarm-300" data-testid="ph-alarm">
                  <StatusMark status="alarm" /> {t('doseController.phTripped', { floor: fmt(ph.floor, 2) })}
                </div>
              ) : (ph.fault || (ph.sample_state && PH_STATE_NOTE.has(ph.sample_state))) ? (
                <div className={`mt-1 inline-flex items-center gap-1.5 text-xs ${ph.fault || ph.sample_state === 'stale' ? 'text-caution-700 dark:text-caution-300' : 'text-muted'}`}>
                  {(ph.fault || ph.sample_state === 'stale') && <StatusMark status="caution" />}
                  {ph.fault ? (PH_STATE_NOTE.has(ph.fault) ? t(`doseController.phState.${ph.fault}`) : t('doseController.sensorFault', { fault: ph.fault }))
                    : ph.sample_state === 'idle' && s.water && !s.water.known ? t('doseController.flowNotVerifiable')
                      : t(`doseController.phState.${ph.sample_state}`)}
                </div>
              ) : null}
              {ph.acid && (
                <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted">
                  <span className="inline-flex items-center gap-1">
                    {t('doseController.phDown')} <ValveMark valve={ph.acid.open ? 'open' : 'closed'} actual={ph.tank ? ph.tank.actual : null} />
                  </span>
                  <span><Trans t={t} i18nKey="doseController.acidCycle" values={{ used: fmt(ph.acid.used_s, 0), cap: fmt(ph.acid.cap_s, 0) }} components={{ v: mono, m: monoMuted }} /></span>
                  <span><Trans t={t} i18nKey="doseController.acidToday" values={{ used: fmt(ph.acid.day_used_s, 0), cap: fmt(ph.acid.day_cap_s, 0) }} components={{ v: mono, m: monoMuted }} /></span>
                  <span title={t('doseController.acidEstTitle')}><Trans t={t} i18nKey="doseController.acidEst" values={{ litres: fmt(ph.acid.est_l, 2) }} components={{ m: monoMuted }} /></span>
                  {/* gate: server text, shown as-is */}
                  {ph.gate && !ph.acid.open && <span className="italic">{ph.gate}</span>}
                </div>
              )}
            </div>
          )}
        </>
      )}

      <LastRun run={s.last_run} when={when} />
    </Card>
  );
}
