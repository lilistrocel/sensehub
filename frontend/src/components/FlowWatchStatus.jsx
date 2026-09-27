import React, { useEffect, useState } from 'react';
import { Card, Label, Reading } from '../ui';
import { StatusMark } from './agronomist/SectionStatus';
import { useAuth } from '../context/AuthContext';

/**
 * Compact irrigation flow-watch status (GET /api/flow-watch/status, polled 5 s).
 *
 * Status is shape + colour + text (FARM-APP-STANDARDS 4.1 / 5): filled circle
 * ok, triangle caution/checking, square alarm, dashed hollow circle unknown,
 * neutral filled circle idle. "Unknown" (relay board stale, or pump ON with no
 * fresh flow data) never renders as OK, and a missing flow value renders "—".
 */

const STATE = {
  alarm: { mark: 'alarm', rail: 'alarm', text: 'Alarm' },
  caution: { mark: 'caution', rail: 'caution', text: 'Caution' },
  checking: { mark: 'caution', rail: 'caution', text: 'Checking' },
  ok: { mark: 'ok', rail: 'ok', text: 'OK' },
  // manual irrigation at the panel (info): water with no SenseHub pump / zone relay ON
  manual: { mark: 'unknown', rail: 'idle', text: 'Manual (panel)' },
  idle: { mark: 'idle', rail: 'idle', text: 'Idle' },
  unknown: { mark: 'unknown', rail: 'stale', text: 'Unknown' },
  disabled: { mark: 'unknown', rail: 'idle', text: 'Off' },
};

const KIND = {
  valve_no_flow: 'No flow',
  low_flow: 'Low flow',
  flow_above_expected: 'Flow above one zone',
  dosing_without_water: 'Dosing without water',
  water_without_valve: 'Flow, no zone open',
  flow_after_pump_off: 'Flow, pump off',
  monitor_blind: 'Flow not verifiable',
  manual_panel: 'Manual irrigation (panel)',
};

const TEXT = {
  alarm: 'text-alarm-600 dark:text-alarm-300',
  caution: 'text-caution-700 dark:text-caution-300',
  ok: 'text-ink',
  idle: 'text-muted',
  unknown: 'text-muted',
};

const fmtL = (x) => (x === null || x === undefined ? '—' : Math.round(x).toLocaleString('en-US'));
function fmtDur(s) {
  if (s === null || s === undefined) return '—';
  const r = Math.round(s);
  if (r < 90) return `${r} s`;
  return `${Math.floor(r / 60)} min ${r % 60} s`;
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

export default function FlowWatchStatus({ formatDateTime }) {
  const { token } = useAuth();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let mounted = true;
    const poll = async () => {
      try {
        const r = await fetch('/api/flow-watch/status', { headers: { Authorization: `Bearer ${token}` } });
        if (!mounted) return;
        if (r.ok) { setStatus(await r.json()); setError(false); } else setError(true);
      } catch (_) {
        if (mounted) setError(true);
      }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => { mounted = false; clearInterval(id); };
  }, [token]);

  if (!status && !error) return null;

  const state = error || !status ? 'unknown' : status.state;
  const cfg = STATE[state] || STATE.unknown;
  const zone = status?.current_zone;
  const flow = status?.flow;
  const flowMissing = !flow || flow.lph === null || flow.lph === undefined;
  const active = (status?.active || []).filter(a => a.fired);
  const ep = status?.last_episode;
  const when = (iso) => (iso ? (formatDateTime ? formatDateTime(iso) : new Date(iso).toLocaleString()) : '—');

  let line;
  if (error || !status) line = <span className="text-muted">Flow watch status unavailable.</span>;
  else if (!status.enabled) line = <span className="text-muted">Flow watch is switched off.</span>;
  else if (!status.relays?.known) line = <span className="text-muted">Relay state unknown — {status.relays?.reason || 'irrigation board not reporting'}.</span>;
  else if (zone) {
    line = (
      <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-semibold text-ink">{zone.name}</span>
        <Reading value={flowMissing ? null : Math.round(flow.lph)} unit="L/h" size="sm"
          stale={!flowMissing && (!flow.fresh || !flow.healthy)} unknown={flowMissing} />
        <span className="text-muted font-mono tabular text-xs">/ ~{fmtL(zone.expected_lph)} L/h expected</span>
        {zone.ratio_pct !== null && zone.ratio_pct !== undefined && (
          <span className="font-mono tabular text-xs text-muted">{zone.ratio_pct} %</span>
        )}
        {status.settling && <span className="text-xs text-muted">settling</span>}
      </span>
    );
  } else if (status.relays?.pump_on) {
    line = <span className="text-ink">Pump ON, no zone open — flow <span className="font-mono tabular">{flowMissing ? '—' : fmtL(flow.lph)}</span> L/h</span>;
  } else {
    line = <span className="text-muted">Pump off — no irrigation running.{!flowMissing && flow.lph > 0 ? <> Flow <span className="font-mono tabular">{fmtL(flow.lph)}</span> L/h.</> : null}</span>;
  }

  return (
    <Card rail={cfg.rail} padding="sm" data-testid="flow-watch-status" data-flow-watch-state={state}>
      <div className="flex items-center justify-between gap-3">
        <Label>Flow watch</Label>
        <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${TEXT[cfg.mark] || 'text-muted'}`}>
          <Mark state={cfg.mark} />
          {cfg.text}
        </span>
      </div>
      <div className="mt-1.5 text-sm">{line}</div>
      {active.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {active.map(a => (
            <li key={a.key} className="flex items-start gap-2 text-sm">
              <span className="mt-1"><Mark state={a.level === 'alarm' ? 'alarm' : a.level === 'info' ? 'unknown' : 'caution'} /></span>
              <span className={TEXT[a.level === 'alarm' ? 'alarm' : a.level === 'info' ? 'ok' : 'caution']}>{a.message || KIND[a.rule]}</span>
            </li>
          ))}
        </ul>
      )}
      {ep && (
        <div className="mt-2 text-xs text-muted flex flex-wrap gap-x-2">
          <span className="font-semibold uppercase tracking-wider">Last episode</span>
          <span>{KIND[ep.kind] || ep.kind}{ep.zone_name ? ` · ${ep.zone_name}` : ''}</span>
          <span className="font-mono tabular">{when(ep.started_at)}</span>
          <span className="font-mono tabular">{ep.ended_at ? fmtDur(ep.duration_s) : 'ongoing'}</span>
          <span>
            {ep.ended_at ? (ep.recovered ? 'recovered' : ep.end_reason === 'interrupted' ? 'interrupted by restart' : 'not recovered') : ''}
            {ep.alarmed ? ' · alerted' : ' · no alert'}
            {ep.dosing_aborted ? ' · dosing stopped' : ''}
          </span>
        </div>
      )}
    </Card>
  );
}
