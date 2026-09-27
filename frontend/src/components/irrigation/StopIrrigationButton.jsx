import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { useWebSocket } from '../../context/WebSocketContext';
import { useSettings } from '../../context/SettingsContext';
import ConfirmDialog from '../ConfirmDialog';
import { startPolling } from '../../hooks/usePoll';

const API_BASE = '/api';
// A 202 (a board slow to answer) waits this long for the stop_irrigation_result broadcast.
const RESULT_TIMEOUT_MS = 60000;

// What POST /api/irrigation/stop switches OFF (backend: flow-watch config irrigation board
// relays 1-6 + dosing board relays 1-5). Listed in the confirmation (FARM-APP-STANDARDS 4.3).
export const STOP_IRRIGATION_CHANNELS = [
  'Irrigation Pump — irrigation board relay 1',
  'Mixing Pump — irrigation board relay 2',
  'Zone 1 valve — irrigation board relay 3',
  'Zone 2 valve — irrigation board relay 4',
  'Zone 3 valve — irrigation board relay 5',
  'Zone 4 valve — irrigation board relay 6',
  'pH Down valve — dosing board relay 1',
  'Tank A dosing valve — dosing board relay 2',
  'Tank B dosing valve — dosing board relay 3',
  'Tank C dosing valve — dosing board relay 4',
  'Tank D dosing valve — dosing board relay 5',
];

function StopGlyph({ className = 'w-4 h-4' }) {
  return (
    <svg className={`${className} shrink-0`} viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3" y="3" width="10" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

/** Confirmed OFF = filled ok dot; not confirmed = alarm square (shape + colour + text). */
function ChannelRow({ c }) {
  return (
    <li className="flex items-center justify-between gap-2 py-1 text-sm" data-testid="stop-irrigation-channel" data-confirmed={c.confirmed ? 'true' : 'false'}>
      <span className="min-w-0 truncate text-ink" title={`${c.equipment} relay ${c.channel}`}>{c.name}</span>
      {c.confirmed ? (
        <span className="inline-flex items-center gap-1 font-mono tabular text-xs text-ok-700 dark:text-ok-300 shrink-0">
          <svg aria-hidden="true" viewBox="0 0 10 10" className="w-2.5 h-2.5"><circle cx="5" cy="5" r="4" className="fill-state-ok" /></svg>
          OFF confirmed
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 font-mono tabular text-xs font-semibold text-alarm-700 dark:text-alarm-300 shrink-0">
          <svg aria-hidden="true" viewBox="0 0 10 10" className="w-2.5 h-2.5"><rect x="1" y="1" width="8" height="8" className="fill-state-alarm" /></svg>
          NOT confirmed{c.readback === true ? ' (reads ON)' : ''}
        </span>
      )}
    </li>
  );
}

function ResultPanel({ result, onDismiss, formatTime }) {
  if (!result) return null;
  if (result.pending) {
    return (
      <div role="status" className="mt-2 rounded-md border border-line border-l-[3px] border-l-state-caution px-3 py-2 text-sm text-ink" data-testid="stop-irrigation-result" data-state="pending">
        Still switching off — a board is slow to answer. Waiting for the result…
      </div>
    );
  }
  const channels = Array.isArray(result.channels) ? result.channels : [];
  const bad = channels.filter((c) => !c.confirmed);
  const ok = result.ok === true;
  const irr = channels.filter((c) => c.equipment_id === channels[0]?.equipment_id);
  const dos = channels.filter((c) => c.equipment_id !== channels[0]?.equipment_id);
  const when = result.stopped_at ? (formatTime ? formatTime(result.stopped_at) : new Date(result.stopped_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : null;
  return (
    <div
      role={ok ? 'status' : 'alert'}
      className={`mt-2 rounded-md border border-l-[3px] px-3 py-2 ${ok ? 'border-line border-l-state-ok' : 'border-alarm-300 border-l-state-alarm bg-alarm-50 dark:border-alarm-700 dark:bg-alarm-900/30'}`}
      data-testid="stop-irrigation-result"
      data-state={ok ? 'ok' : 'error'}
    >
      <div className="flex items-start justify-between gap-2">
        <p className={`text-sm font-semibold ${ok ? 'text-ink' : 'text-alarm-700 dark:text-alarm-300'}`}>
          {ok
            ? `Irrigation stopped${when ? ` at ${when}` : ''}: ${channels.length}/${channels.length} channels confirmed OFF. Fans and climate unaffected.`
            : (channels.length
              ? `${bad.length} channel${bad.length === 1 ? '' : 's'} NOT confirmed OFF — switch off at the panel NOW.`
              : `${result.error || 'Stop irrigation failed'}`)}
        </p>
        <button type="button" onClick={onDismiss} className="shrink-0 min-h-[32px] px-2 text-xs text-muted underline" aria-label="Dismiss the stop result">Dismiss</button>
      </div>
      {!ok && channels.length > 0 && result.error && <p className="mt-0.5 text-xs text-alarm-700 dark:text-alarm-300">{result.error}</p>}
      {(result.zones_interrupted?.length > 0 || result.zones_not_started?.length > 0 || result.dose?.outcome === 'aborted' || result.runs_cancelled?.length > 0) && (
        <p className="mt-1 text-xs text-muted">
          {[
            result.runs_cancelled?.length ? `run: ${result.runs_cancelled.map((r) => r.name || `automation #${r.automation_id}`).join(', ')}` : null,
            result.zones_interrupted?.length ? `interrupted: ${result.zones_interrupted.join(', ')}` : null,
            result.zones_not_started?.length ? `cancelled: ${result.zones_not_started.join(', ')}` : null,
            result.dose?.outcome === 'aborted' ? 'dose cycle aborted' : null,
          ].filter(Boolean).join(' · ')}
        </p>
      )}
      {channels.length > 0 && (
        <details className="mt-1" open={!ok}>
          <summary className="cursor-pointer text-xs text-muted min-h-[32px] inline-flex items-center">Per channel</summary>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
            <ul className="divide-y divide-line" aria-label={irr[0]?.equipment || 'Irrigation board'}>{irr.map((c) => <ChannelRow key={`${c.equipment_id}:${c.channel}`} c={c} />)}</ul>
            <ul className="divide-y divide-line" aria-label={dos[0]?.equipment || 'Dosing board'}>{dos.map((c) => <ChannelRow key={`${c.equipment_id}:${c.channel}`} c={c} />)}</ul>
          </div>
        </details>
      )}
    </div>
  );
}

/**
 * "Stop irrigation": stops ONLY the irrigation side (irrigation pump, mixing pump,
 * zones 1-4, dosing valves A-D and pH Down) through POST /api/irrigation/stop;
 * fans and climate keep running. Requirement 2026-09-27 (Stop All used to end
 * irrigation runs switched the fan boards off at ~35 °C).
 *
 * Admin + operator only (viewers see nothing). Ghost button in alarm red
 * (destructive = ghost; solid red is the EMERGENCY STOP's), emphasised while
 * irrigating. Always confirms with the channel list; shows the per-channel
 * read-back result and a clear "switch off at the panel" error when any OFF is
 * not confirmed.
 *
 * Props:
 *   active     boolean | undefined — irrigating now (undefined: polled from /api/flow-watch/status)
 *   formatTime (iso) => string
 */
export default function StopIrrigationButton({ active, formatTime, className = '' }) {
  const { token, user } = useAuth();
  const { showSuccess, addToast } = useToast();
  const { subscribe } = useWebSocket();
  const settings = useSettings();
  const fmtTime = formatTime || ((iso) => (settings?.formatTime ? settings.formatTime(new Date(iso)) : new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
  const canStop = user?.role === 'admin' || user?.role === 'operator';

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [polledActive, setPolledActive] = useState(null);
  const waitRef = useRef(null); // { timer } while a 202 waits for the broadcast
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true; // StrictMode mounts twice: re-arm after the first cleanup
    return () => { mounted.current = false; if (waitRef.current) { clearTimeout(waitRef.current.timer); waitRef.current = null; } };
  }, []);

  // Only when the caller does not know whether irrigation runs.
  useEffect(() => {
    if (!canStop || active !== undefined || !token) return undefined;
    let stop = false;
    const poll = async () => {
      try {
        const r = await fetch(`${API_BASE}/flow-watch/status`, { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) return;
        const s = await r.json();
        const on = !!(s?.relays?.pump_on || (s?.relays?.zones || []).some((z) => z.on) || s?.dosing?.cycle_running || s?.flow?.irrigation_active);
        if (!stop) setPolledActive(on);
      } catch { /* the button works without it */ }
    };
    poll();
    const stopPoll = startPolling(poll, 10000); // paused while hidden, one refresh on resume
    return () => { stop = true; stopPoll(); };
  }, [canStop, active, token]);

  const report = useCallback((data) => {
    if (!mounted.current) return;
    setResult(data);
    const channels = Array.isArray(data?.channels) ? data.channels : [];
    if (data?.ok) {
      showSuccess(`${channels.length}/${channels.length} channels confirmed OFF: pumps, zones and dosing. Fans and climate keep running.`, 'Irrigation stopped');
    } else {
      addToast({
        type: 'error',
        title: 'Stop irrigation NOT confirmed',
        duration: 0,
        message: /switch off at the panel/i.test(data?.error || '') ? data.error : `${data?.error || 'The controller did not confirm the irrigation relays OFF.'} Switch off at the panel.`,
      });
    }
  }, [showSuccess, addToast]);

  // 202: the backend broadcasts the final result when its writes finish.
  useEffect(() => {
    if (!subscribe) return undefined;
    return subscribe('stop_irrigation_result', (data) => {
      if (!waitRef.current || !data || data.inProgress) return;
      clearTimeout(waitRef.current.timer);
      waitRef.current = null;
      setBusy(false);
      report(data);
    });
  }, [subscribe, report]);

  const handleConfirm = useCallback(async () => {
    setBusy(true);
    let pending = false;
    try {
      const res = await fetch(`${API_BASE}/irrigation/stop`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      const data = await res.json().catch(() => ({}));
      setOpen(false);
      if (res.status === 202 || data.inProgress) {
        pending = true;
        setResult({ pending: true });
        waitRef.current = {
          timer: setTimeout(() => {
            waitRef.current = null;
            setBusy(false);
            report({ ok: false, error: 'The controller never reported the result of Stop irrigation — the relays are NOT confirmed OFF.' });
          }, RESULT_TIMEOUT_MS),
        };
        return;
      }
      if (!res.ok) {
        report({ ok: false, error: res.status === 403 ? 'Your account may not stop irrigation — nothing was switched.' : (data.error || data.message || `Stop irrigation failed (HTTP ${res.status}) — nothing is confirmed OFF.`) });
        return;
      }
      report(data);
    } catch (err) {
      setOpen(false);
      report({ ok: false, error: `Could not reach the controller (${err.message || 'network error'}) — nothing is confirmed OFF.` });
    } finally {
      if (!pending && mounted.current) setBusy(false);
    }
  }, [token, report]);

  if (!canStop) return null;
  const irrigating = active !== undefined ? !!active : !!polledActive;

  const btn = irrigating
    ? 'border-2 border-alarm-600 text-alarm-700 dark:border-alarm-400 dark:text-alarm-300 font-bold'
    : 'border border-alarm-300 text-alarm-700 dark:border-alarm-700 dark:text-alarm-300 font-semibold';

  return (
    <div className={className} data-testid="stop-irrigation" data-active={irrigating ? 'true' : 'false'}>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <p className="text-xs text-muted min-w-0">
          {irrigating
            ? 'Irrigation is running. Stop irrigation switches off pumps, zones and dosing only — fans and climate keep running.'
            : 'Stops pumps, zones and dosing only — fans and climate keep running.'}
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={busy}
          className={`inline-flex items-center justify-center gap-2 rounded-md bg-transparent hover:bg-alarm-50 dark:hover:bg-alarm-900/30 min-h-touch px-4 py-2 text-sm whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-alarm-500 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:opacity-60 disabled:cursor-not-allowed ${irrigating ? 'w-full sm:w-auto' : ''} ${btn}`}
          title="Stop irrigation: pumps, zones and dosing OFF. Fans and climate keep running."
          data-testid="stop-irrigation-button"
        >
          <StopGlyph />
          {busy ? 'Stopping irrigation…' : 'Stop irrigation'}
        </button>
      </div>
      <ResultPanel result={result} onDismiss={() => setResult(null)} formatTime={fmtTime} />
      <ConfirmDialog
        open={open}
        title="Stop irrigation?"
        variant="destructive"
        busy={busy}
        confirmLabel="Stop irrigation"
        cancelLabel="Keep running"
        body={(
          <>
            <p>Switches OFF the Irrigation Pump, Mixing Pump, Zones 1–4, dosing valves A–D and pH Down, cancels the rest of any irrigation run and aborts dosing. <strong className="font-semibold">Fans and climate keep running.</strong></p>
            <p className="mt-1">Works while automations are disarmed. It does not disarm anything: the next scheduled run starts as planned.</p>
          </>
        )}
        items={STOP_IRRIGATION_CHANNELS}
        onConfirm={handleConfirm}
        onCancel={() => { if (!busy) setOpen(false); }}
      />
    </div>
  );
}
