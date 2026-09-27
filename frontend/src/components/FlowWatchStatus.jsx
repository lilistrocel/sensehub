import React, { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Card, Label, Reading } from '../ui';
import { StatusMark } from './agronomist/SectionStatus';
import { useAuth } from '../context/AuthContext';
import { startPolling } from '../hooks/usePoll';
import { isNetworkError, isTransientNow } from '../utils/connectivity';
import { useFormat } from '../i18n/useFormat';

/**
 * Compact irrigation flow-watch status (GET /api/flow-watch/status, polled 5 s).
 *
 * Status is shape + colour + text (FARM-APP-STANDARDS 4.1 / 5): filled circle
 * ok, triangle caution/checking, square alarm, dashed hollow circle unknown,
 * neutral filled circle idle. "Unknown" (relay board stale, or pump ON with no
 * fresh flow data) never renders as OK, and a missing flow value renders "—".
 */

// Label text: fertigation:flowWatch.state.<key> (en: Alarm, Caution, Checking, OK,
// Manual (panel), Idle, Unknown, Off).
const STATE = {
  alarm: { mark: 'alarm', rail: 'alarm' },
  caution: { mark: 'caution', rail: 'caution' },
  checking: { mark: 'caution', rail: 'caution' },
  ok: { mark: 'ok', rail: 'ok' },
  // manual irrigation at the panel (info): water with no SenseHub pump / zone relay ON
  manual: { mark: 'unknown', rail: 'idle' },
  idle: { mark: 'idle', rail: 'idle' },
  unknown: { mark: 'unknown', rail: 'stale' },
  disabled: { mark: 'unknown', rail: 'idle' },
};

// Episode / rule kinds -> fertigation:flowWatch.kind.<code> (defaultValue = the code).
const kindText = (t, code) => (code ? t(`flowWatch.kind.${code}`, { defaultValue: code }) : '');

const TEXT = {
  alarm: 'text-alarm-600 dark:text-alarm-300',
  caution: 'text-caution-700 dark:text-caution-300',
  ok: 'text-ink',
  idle: 'text-muted',
  unknown: 'text-muted',
};

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

export default function FlowWatchStatus({ formatDateTime }) {
  const { t } = useTranslation('fertigation');
  const f = useFormat();
  const fmtL = (x) => (x === null || x === undefined ? '—' : f.int(x));
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
      } catch (e) {
        // Tab resume / radio waking up: keep showing the last status, not "unknown".
        if (isNetworkError(e) && isTransientNow()) return;
        if (mounted) setError(true);
      }
    };
    poll();
    const stopPoll = startPolling(poll, 5000); // paused while hidden, one refresh on resume
    return () => { mounted = false; stopPoll(); };
  }, [token]);

  if (!status && !error) return null;

  const state = error || !status ? 'unknown' : status.state;
  const cfg = STATE[state] || STATE.unknown;
  const zone = status?.current_zone;
  const flow = status?.flow;
  const flowMissing = !flow || flow.lph === null || flow.lph === undefined;
  const active = (status?.active || []).filter(a => a.fired);
  const ep = status?.last_episode;
  const when = (iso) => (iso ? (formatDateTime ? formatDateTime(iso) : f.dateTime(iso)) : '—');

  let line;
  if (error || !status) line = <span className="text-muted">{t('flowWatch.unavailable')}</span>;
  else if (!status.enabled) line = <span className="text-muted">{t('flowWatch.switchedOff')}</span>;
  // relays.reason is server text (localized by the backend): shown as-is.
  else if (!status.relays?.known) line = <span className="text-muted">{t('flowWatch.relayUnknown', { reason: status.relays?.reason || t('flowWatch.boardNotReporting') })}</span>;
  else if (zone) {
    line = (
      <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-semibold text-ink" dir="auto">{zone.name}</span>
        <Reading value={flowMissing ? null : Math.round(flow.lph)} unit="L/h" size="sm"
          stale={!flowMissing && (!flow.fresh || !flow.healthy)} unknown={flowMissing} />
        <span className="text-muted font-mono tabular text-xs">{t('flowWatch.expected', { value: fmtL(zone.expected_lph) })}</span>
        {zone.ratio_pct !== null && zone.ratio_pct !== undefined && (
          <span className="font-mono tabular text-xs text-muted">{f.percent(zone.ratio_pct)}</span>
        )}
        {status.settling && <span className="text-xs text-muted">{t('flowWatch.settling')}</span>}
      </span>
    );
  } else if (status.relays?.pump_on) {
    line = (
      <span className="text-ink">
        <Trans t={t} i18nKey="flowWatch.pumpOnNoZone" values={{ value: flowMissing ? '—' : fmtL(flow.lph) }}
          components={{ v: <span className="font-mono tabular" /> }} />
      </span>
    );
  } else {
    line = (
      <span className="text-muted">
        {t('flowWatch.pumpOff')}
        {!flowMissing && flow.lph > 0 ? (
          <>{' '}<Trans t={t} i18nKey="flowWatch.pumpOffFlow" values={{ value: fmtL(flow.lph) }}
            components={{ v: <span className="font-mono tabular" /> }} /></>
        ) : null}
      </span>
    );
  }

  return (
    <Card rail={cfg.rail} padding="sm" data-testid="flow-watch-status" data-flow-watch-state={state}>
      <div className="flex items-center justify-between gap-3">
        <Label>{t('flowWatch.title')}</Label>
        <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${TEXT[cfg.mark] || 'text-muted'}`}>
          <Mark state={cfg.mark} />
          {t(`flowWatch.state.${STATE[state] ? state : 'unknown'}`)}
        </span>
      </div>
      <div className="mt-1.5 text-sm">{line}</div>
      {active.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {active.map(a => (
            <li key={a.key} className="flex items-start gap-2 text-sm">
              <span className="mt-1"><Mark state={a.level === 'alarm' ? 'alarm' : a.level === 'info' ? 'unknown' : 'caution'} /></span>
              <span className={TEXT[a.level === 'alarm' ? 'alarm' : a.level === 'info' ? 'ok' : 'caution']}>{/* a.message: server text, shown as-is */}{a.message || kindText(t, a.rule)}</span>
            </li>
          ))}
        </ul>
      )}
      {ep && (
        <div className="mt-2 text-xs text-muted flex flex-wrap gap-x-2">
          <span className="font-semibold uppercase tracking-wider">{t('flowWatch.lastEpisode')}</span>
          <span>{kindText(t, ep.kind)}{ep.zone_name ? <> · <span dir="auto">{ep.zone_name}</span></> : ''}</span>
          <span className="font-mono tabular">{when(ep.started_at)}</span>
          <span className="font-mono tabular">{ep.ended_at ? f.duration(ep.duration_s, { compact: true }) : t('flowWatch.ongoing')}</span>
          <span>
            {[
              ep.ended_at ? (ep.recovered ? t('flowWatch.recovered') : ep.end_reason === 'interrupted' ? t('flowWatch.interrupted') : t('flowWatch.notRecovered')) : null,
              ep.alarmed ? t('flowWatch.alerted') : t('flowWatch.noAlert'),
              ep.dosing_aborted ? t('flowWatch.dosingStopped') : null,
            ].filter(Boolean).join(' · ')}
          </span>
        </div>
      )}
    </Card>
  );
}
