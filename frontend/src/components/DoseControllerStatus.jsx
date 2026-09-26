import React, { useEffect, useState } from 'react';
import { Card, Label, Reading } from '../ui';
import { StatusMark } from './agronomist/SectionStatus';
import { useAuth } from '../context/AuthContext';

/**
 * Closed-loop dose controller card (GET /api/dose-controller/status, polled 4 s).
 *
 * Status is shape + colour + text (FARM-APP-STANDARDS 4.1 / 5): filled circle
 * ok, triangle caution, square alarm, dashed hollow circle unknown/stale.
 * Valves: filled = commanded open, hollow = commanded closed, dashed = the
 * board's read-back is unknown/stale, triangle = read-back disagrees. A stale
 * pH sample renders "—" with its age, never as a value. Feed EC in mS/cm.
 */

const STATE = {
  alarm: { mark: 'alarm', rail: 'alarm', text: 'Alarm' },
  caution: { mark: 'caution', rail: 'caution', text: 'Caution' },
  ok: { mark: 'ok', rail: 'ok', text: 'Closed loop' },
  waiting: { mark: 'unknown', rail: 'stale', text: 'Waiting' },
  idle: { mark: 'idle', rail: 'idle', text: 'Idle' },
  off: { mark: 'unknown', rail: 'idle', text: 'Off' },
  unknown: { mark: 'unknown', rail: 'stale', text: 'Unknown' },
};

const MODE_TEXT = {
  closed_loop: 'Closed loop — per-zone litre targets',
  fallback: 'Fallback — fixed program schedule',
  hold: 'Held closed — automations disarmed',
  waiting: 'Waiting for monitor data',
};

const TEXT = {
  alarm: 'text-alarm-600 dark:text-alarm-300',
  caution: 'text-caution-700 dark:text-caution-300',
  ok: 'text-ink',
  idle: 'text-muted',
  unknown: 'text-muted',
};

const PH_STATE_TEXT = {
  ok: null,
  idle: 'no water flow — cup liquid ignored',
  start_delay: 'start delay (cup flushing)',
  waiting: 'waiting for a sample',
  stale: 'sample stale',
  frozen: 'sensor frozen — acid off this cycle',
  implausible: 'implausible reading — acid off this cycle',
};

const fmt = (x, d = 1) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? '—' : Number(x).toFixed(d));
const fmtInt = (x) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? '—' : Math.round(Number(x)).toLocaleString('en-US'));
const mS = (us, d = 2) => (us === null || us === undefined || !Number.isFinite(Number(us)) ? '—' : (Number(us) / 1000).toFixed(d));
function fmtDur(s) {
  if (s === null || s === undefined) return '—';
  const r = Math.max(0, Math.round(s));
  if (r < 90) return `${r} s`;
  return `${Math.floor(r / 60)} min ${String(r % 60).padStart(2, '0')} s`;
}

function Mark({ state }) {
  if (state === 'idle') {
    return (
      <span className="inline-flex items-center shrink-0 text-state-idle" data-status="idle">
        <svg aria-hidden="true" viewBox="0 0 12 12" className="w-3 h-3"><circle cx="6" cy="6" r="5" fill="currentColor" /></svg>
        <span className="sr-only">status: idle</span>
      </span>
    );
  }
  return <StatusMark status={state} />;
}

/** Valve mark: filled = open, hollow = closed, dashed = read-back unknown, triangle = read-back disagrees. */
function ValveMark({ valve, actual }) {
  const open = valve === 'open';
  const mismatch = actual !== null && actual !== undefined && actual !== open;
  const unknown = actual === null || actual === undefined;
  const title = `commanded ${open ? 'open' : 'closed'}; board reads ${unknown ? 'unknown' : actual ? 'open' : 'closed'}`;
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${mismatch ? 'text-caution-700 dark:text-caution-300' : 'text-ink'}`} title={title} data-valve={valve} data-valve-actual={unknown ? 'unknown' : String(actual)}>
      <svg aria-hidden="true" viewBox="0 0 12 12" className="w-3 h-3 shrink-0">
        {mismatch ? <path d="M6 1 L11.2 10.5 H0.8 Z" fill="currentColor" />
          : open ? <circle cx="6" cy="6" r="4.6" fill="currentColor" stroke="currentColor" strokeWidth="1.6" strokeDasharray={unknown ? '2.2 1.6' : undefined} />
            : <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray={unknown ? '2.2 1.6' : undefined} />}
      </svg>
      <span>{open ? 'open' : 'closed'}</span>
      <span className="sr-only">{title}</span>
    </span>
  );
}

function deriveState(s, error) {
  if (error || !s) return 'unknown';
  if (!s.enabled) return 'off';
  if (!s.running) return 'idle';
  if (s.ph && s.ph.tripped) return 'alarm';
  const tankFlag = (s.tanks || []).some(t => t.limited || (t.actual !== null && t.actual !== undefined && t.actual !== (t.valve === 'open')));
  if (s.mode === 'fallback' || s.mode === 'hold' || (s.ph && s.ph.fault) || s.ph?.sample_state === 'stale' || tankFlag) return 'caution';
  if (s.mode === 'waiting') return 'waiting';
  return 'ok';
}

function TankRow({ t, ratioTarget }) {
  const achieved = t.achieved_ratio;
  const dev = t.deviation_pct;
  const off = dev !== null && dev !== undefined && Math.abs(dev) > 5;
  return (
    <li className="py-1.5 border-t border-line first:border-t-0" data-testid="dose-tank" data-tank={t.tank_id}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-semibold text-ink text-sm min-w-[4.5rem]">{t.name}</span>
        <ValveMark valve={t.valve} actual={t.actual} />
        <span className="text-xs text-muted">
          zone <span className="font-mono tabular text-ink">{fmt(t.zone_dosed_l, 2)}</span> / <span className="font-mono tabular">{fmt(t.zone_target_l, 2)}</span> L
        </span>
        <span className="text-xs text-muted">
          run <span className="font-mono tabular text-ink">{fmt(t.dosed_l, 2)}</span> / <span className="font-mono tabular">{fmt(t.target_l, 2)}</span> L
        </span>
        <span className={`text-xs font-mono tabular ${off ? 'text-caution-700 dark:text-caution-300' : 'text-ink'}`} title={`target 1:${ratioTarget ?? t.ratio_target}`}>
          1:{achieved ? fmtInt(achieved) : '—'}
          <span className="text-muted font-sans"> · target 1:{fmtInt(t.ratio_target ?? ratioTarget)}</span>
        </span>
        {t.limited && (
          <span className="inline-flex items-center gap-1 text-xs text-caution-700 dark:text-caution-300" data-testid="cant-reach">
            <StatusMark status="caution" /> can&apos;t reach target
          </span>
        )}
      </div>
    </li>
  );
}

function LastRun({ run, when }) {
  if (!run) return null;
  const flags = [];
  if (run.modes && run.modes.fallback_s > 0) flags.push(`fallback ${fmtDur(run.modes.fallback_s)}`);
  const limited = (run.tanks || []).filter(t => t.physics_limited || t.cant_reach_zones > 0);
  if (limited.length) flags.push(`can't reach: ${limited.map(t => t.name).join(', ')}`);
  const phTrip = (run.trips || []).find(t => t.kind === 'ph_floor');
  if (phTrip) flags.push('pH floor tripped');
  if (run.status !== 'completed') flags.push(run.status);
  return (
    <div className="mt-3 pt-2 border-t border-line text-xs text-muted" data-testid="dose-last-run">
      <div className="flex flex-wrap gap-x-2 gap-y-1 items-baseline">
        <span className="font-semibold uppercase tracking-wider">Last run</span>
        <span className="font-mono tabular">{when(run.started_at)}</span>
        {run.automation_name && <span className="truncate max-w-[16rem]">{run.automation_name}</span>}
        <span><span className="font-mono tabular text-ink">{fmtInt(run.water_l)}</span> L water</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
        {[...(run.tanks || [])].sort((a, b) => a.tank_id - b.tank_id).map(t => (
          <span key={t.tank_id}>{t.name} <span className="font-mono tabular text-ink">1:{t.achieved_ratio ? fmtInt(t.achieved_ratio) : '—'}</span></span>
        ))}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
        <span>pH <span className="font-mono tabular text-ink">{fmt(run.ph?.min, 2)}–{fmt(run.ph?.max, 2)}</span> (avg <span className="font-mono tabular">{fmt(run.ph?.avg, 2)}</span>, end <span className="font-mono tabular">{fmt(run.ph?.last, 2)}</span>)</span>
        <span>EC <span className="font-mono tabular text-ink">{mS(run.ec_us?.avg)}</span> mS/cm</span>
        <span>acid <span className="font-mono tabular text-ink">{fmt(run.acid_s, 0)}</span> s (~<span className="font-mono tabular">{fmt(run.acid_est_l, 2)}</span> L est.)</span>
      </div>
      {flags.length > 0 && (
        <div className="mt-1 inline-flex items-center gap-1 text-caution-700 dark:text-caution-300"><StatusMark status="caution" /> {flags.join(' · ')}</div>
      )}
    </div>
  );
}

export default function DoseControllerStatus({ formatDateTime }) {
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
      } catch (_) {
        if (mounted) setError(true);
      }
    };
    poll();
    const id = setInterval(poll, 4000);
    return () => { mounted = false; clearInterval(id); };
  }, [token]);

  if (!status && !error) return null;

  const state = deriveState(status, error);
  const cfg = STATE[state] || STATE.unknown;
  const when = (iso) => (iso ? (formatDateTime ? formatDateTime(iso) : new Date(iso).toLocaleString()) : '—');
  const s = status || {};
  const ph = s.ph || null;
  const zone = s.zone || null;
  const ratioTarget = s.setpoints?.ratio ? Object.values(s.setpoints.ratio)[0] : 150;

  let line;
  if (error || !status) line = <span className="text-muted">Dose controller status unavailable.</span>;
  else if (!s.enabled) line = <span className="text-muted">Closed-loop dosing is switched off — programs run their fixed schedule.</span>;
  else if (!s.running) {
    line = (
      <span className="text-muted">
        No dose cycle running.
        {s.acid_day_used_s !== null && s.acid_day_used_s !== undefined && (
          <> Acid today <span className="font-mono tabular text-ink">{fmt(s.acid_day_used_s, 0)}</span> / <span className="font-mono tabular">{fmt(s.setpoints?.acid_cap_day_s, 0)}</span> s.</>
        )}
      </span>
    );
  } else {
    line = (
      <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-ink font-semibold">{MODE_TEXT[s.mode] || s.mode}</span>
        {s.mode !== 'closed_loop' && s.mode_reason && <span className="text-xs text-muted">{s.mode_reason}</span>}
      </span>
    );
  }

  return (
    <Card rail={cfg.rail} padding="sm" data-testid="dose-controller-status" data-dose-state={state}>
      <div className="flex items-center justify-between gap-3">
        <Label>Dose controller</Label>
        <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${TEXT[cfg.mark] || 'text-muted'}`}>
          <Mark state={cfg.mark} />
          {cfg.text}
        </span>
      </div>
      <div className="mt-1.5 text-sm">{line}</div>

      {s.running && (
        <>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            {zone ? (
              <span>
                <span className="text-ink font-semibold">{zone.name}</span>
                {zone.slots > 1 ? ` · half ${zone.slot + 1}` : ''}
                {zone.remaining_s !== null && zone.remaining_s !== undefined && <> · <span className="font-mono tabular">{fmtDur(zone.remaining_s)}</span> left</>}
                {' · '}<span className="font-mono tabular text-ink">{fmtInt(zone.water_l)}</span> / ~<span className="font-mono tabular">{fmtInt(zone.expected_water_l)}</span> L
              </span>
            ) : null}
            <span>
              run <span className="font-mono tabular text-ink">{fmtInt(s.water?.litres)}</span> L ·{' '}
              <Reading value={s.water?.flow_lph ?? null} unit="L/h" size="sm" precision={0} className="!text-xs"
                stale={s.water && s.water.flow_lph !== null && !s.water.known} unknown={!s.water || s.water.flow_lph === null} />
            </span>
            <span>ends in <span className="font-mono tabular">{fmtDur(s.cycle?.remaining_s)}</span></span>
          </div>

          <ul className="mt-2" aria-label="Nutrient tanks">
            {[...(s.tanks || [])].sort((a, b) => a.tank_id - b.tank_id).map(t => <TankRow key={t.tank_id} t={t} ratioTarget={ratioTarget} />)}
          </ul>

          {ph && (
            <div className="mt-2 pt-2 border-t border-line" data-testid="dose-ph" data-ph-state={ph.tripped ? 'alarm' : ph.sample_state}>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <Label as="span" className="!inline">Feed pH</Label>
                <Reading value={ph.value} precision={2} size="sm"
                  stale={ph.value !== null && (ph.sample_state === 'stale' || ph.sample_state === 'idle' || ph.sample_state === 'start_delay')}
                  unknown={ph.value === null} since={ph.sample_at} />
                <span className="text-xs text-muted">setpoint <span className="font-mono tabular">{fmt(ph.setpoint, 2)}</span> ±<span className="font-mono tabular">{fmt(ph.deadband, 2)}</span> · floor <span className="font-mono tabular">{fmt(ph.floor, 2)}</span></span>
                <span className="text-xs text-muted inline-flex items-baseline gap-1">EC
                  <Reading value={ph.ec_us === null || ph.ec_us === undefined ? null : Number(mS(ph.ec_us))} precision={2} unit="mS/cm" size="sm" className="!text-xs"
                    stale={ph.ec_us !== null && ph.ec_us !== undefined && ph.sample_state !== 'ok'} unknown={ph.ec_us === null || ph.ec_us === undefined} since={ph.sample_at} />
                </span>
              </div>
              {ph.tripped ? (
                <div className="mt-1 inline-flex items-center gap-1.5 text-sm text-alarm-600 dark:text-alarm-300" data-testid="ph-alarm">
                  <StatusMark status="alarm" /> pH fell below {fmt(ph.floor, 2)} — pH Down locked out for this cycle
                </div>
              ) : (ph.fault || (ph.sample_state && PH_STATE_TEXT[ph.sample_state])) ? (
                <div className={`mt-1 inline-flex items-center gap-1.5 text-xs ${ph.fault || ph.sample_state === 'stale' ? 'text-caution-700 dark:text-caution-300' : 'text-muted'}`}>
                  {(ph.fault || ph.sample_state === 'stale') && <StatusMark status="caution" />}
                  {ph.fault ? PH_STATE_TEXT[ph.fault] || `sensor ${ph.fault}`
                    : ph.sample_state === 'idle' && s.water && !s.water.known ? 'flow not verifiable — pH not used'
                      : PH_STATE_TEXT[ph.sample_state]}
                </div>
              ) : null}
              {ph.acid && (
                <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted">
                  <span className="inline-flex items-center gap-1">
                    pH Down <ValveMark valve={ph.acid.open ? 'open' : 'closed'} actual={ph.tank ? ph.tank.actual : null} />
                  </span>
                  <span>cycle <span className="font-mono tabular text-ink">{fmt(ph.acid.used_s, 0)}</span> / <span className="font-mono tabular">{fmt(ph.acid.cap_s, 0)}</span> s</span>
                  <span>today <span className="font-mono tabular text-ink">{fmt(ph.acid.day_used_s, 0)}</span> / <span className="font-mono tabular">{fmt(ph.acid.day_cap_s, 0)}</span> s</span>
                  <span title="acid is not metered: estimate from the configured valve flow, unverified">~<span className="font-mono tabular">{fmt(ph.acid.est_l, 2)}</span> L est.</span>
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
