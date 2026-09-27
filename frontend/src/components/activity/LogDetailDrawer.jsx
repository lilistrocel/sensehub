import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, Label, StatusPill } from '../../ui';
import { StatusMark, markFor, markLabel, ActorChip, DeviceIcon, categoryLabel, fullTime, timeOfDay, fmtDuration } from './logFormat';

// English reference labels; the rendered text is t(`drawer.source.${id}`).
const SOURCE_LABELS = {
  audit: 'Audit log (API request)',
  relay: 'Relay events',
  automation: 'Automation run log',
  alert: 'Alerts',
  alert_ack: 'Alerts (acknowledgement)',
  flow: 'Flow watch episodes',
  irrigation_run: 'Irrigation runs',
  dose_run: 'Dose controller runs',
  dose_cycle: 'Dose cycle log',
  drift: 'Relay drift log',
  request: 'Request log (before the audit log existed)',
};

function fmtVal(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function Fact({ label, children }) {
  if (children === null || children === undefined || children === '') return null;
  return (
    <div className="min-w-0">
      <Label>{label}</Label>
      <div className="text-sm text-ink break-words">{children}</div>
    </div>
  );
}

function RelayWrites({ rows, tz }) {
  const { t } = useTranslation('logs');
  if (!rows || !rows.length) return null;
  return (
    <section className="mt-5" data-testid="log-relay-writes">
      <Label className="mb-1.5">{t('drawer.relayWrites', { n: rows.length })}</Label>
      <div className="border border-line rounded-card overflow-hidden">
        <ul className="divide-y divide-line max-h-80 overflow-y-auto">
          {rows.map((w) => (
            <li key={w.id} className="px-3 py-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
              <span className="font-mono tabular text-xs text-muted">{timeOfDay(w.time, tz)}</span>
              <span className="min-w-0 flex-1 text-ink break-words" dir="auto">{w.name}</span>
              <StatusPill state={w.state === 'ON' ? 'ok' : 'idle'} filled={w.state === 'ON'}>
                {w.state === 'ON' ? t('common:status.on') : w.state === 'OFF' ? t('common:status.off') : w.state}
              </StatusPill>
              <span className="text-xs text-muted whitespace-nowrap">
                {w.confirmed === true ? t('drawer.readBackConfirmed') : w.confirmed === false ? t('drawer.readBackNotConfirmed') : t('drawer.noReadBack')}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function DiffTable({ diff }) {
  const { t } = useTranslation('logs');
  if (!Array.isArray(diff) || !diff.length) return null;
  return (
    <section className="mt-5" data-testid="log-diff">
      <Label className="mb-1.5">{t('drawer.fieldChanges', { n: diff.length })}</Label>
      <div className="border border-line rounded-card overflow-hidden">
        <div className="max-h-96 overflow-y-auto divide-y divide-line">
          {diff.map((d, i) => (
            <div key={`${d.path}-${i}`} className="px-3 py-2 text-sm">
              <div className="font-mono text-xs text-muted break-all" dir="ltr">
                {d.path}
                {d.added ? ` (${t('drawer.added')})` : d.removed ? ` (${t('drawer.removed')})` : ''}
                {d.redacted ? ` (${t('drawer.secret')})` : ''}
              </div>
              <div className="mt-0.5 grid grid-cols-1 sm:grid-cols-2 gap-1 sm:gap-3">
                <div className="min-w-0">
                  <span className="text-[11px] font-bold uppercase tracking-[.08em] text-muted me-1.5">{t('drawer.before')}</span>
                  <span className="font-mono text-xs text-muted line-through decoration-alarm-400 break-all" dir="ltr">{fmtVal(d.before)}</span>
                </div>
                <div className="min-w-0">
                  <span className="text-[11px] font-bold uppercase tracking-[.08em] text-muted me-1.5">{t('drawer.after')}</span>
                  <span className="font-mono text-xs text-ink font-semibold break-all" dir="ltr">{fmtVal(d.after)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function JsonBlock({ title, value, open = false }) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return null;
  return (
    <details className="mt-4 group" open={open}>
      <summary className="cursor-pointer select-none text-label uppercase text-muted min-h-touch flex items-center">{title}</summary>
      <pre dir="ltr" className="mt-1 p-3 bg-field border border-line rounded-card text-xs font-mono text-ink overflow-x-auto max-h-80 whitespace-pre-wrap break-all">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

export default function LogDetailDrawer({ item, token, tz, onClose, onFilterTarget, onFilterActor }) {
  const { t, i18n } = useTranslation('logs');
  const lng = i18n.language;
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!item) return undefined;
    let cancelled = false;
    setData(null); setError(null); setLoading(true);
    fetch(`/api/logs/${item.source}/${encodeURIComponent(item.source_id)}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.message || body.error || `HTTP ${r.status}`);
        return body;
      })
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [item, token]);

  useEffect(() => {
    if (!item) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [item, onClose]);

  if (!item) return null;
  const it = (data && data.item) || item;
  const details = (data && data.details) || {};
  const mark = markFor(it);
  const writes = details.writes || (data && data.relay_effects) || details.relay_writes_first_15s || null;
  const changes = Array.isArray(details.changes) ? details.changes : null;
  const duration = it.end_time ? fmtDuration(it.time, it.end_time, lng) : null;
  const targetTypeLabel = it.target_type
    ? t(`drawer.targetType.${it.target_type}`, { defaultValue: it.target_type.replace(/_/g, ' ') })
    : '';

  let targetLink = null;
  if (it.target_type === 'equipment' && it.target_id) targetLink = { to: `/equipment/${it.target_id}`, label: t('drawer.open.equipment') };
  else if (it.target_type === 'automation' && it.target_id) targetLink = { to: '/automations', label: t('drawer.open.automations') };
  else if (it.target_type === 'tank' || it.target_type === 'dose_program') targetLink = { to: '/fertigation', label: t('drawer.open.fertigation') };
  else if (it.target_type === 'alert') targetLink = { to: '/alerts', label: t('drawer.open.alerts') };
  else if (it.target_type === 'camera') targetLink = { to: '/cameras', label: t('drawer.open.cameras') };

  // Everything already shown above is left out of the raw block.
  const { body, before, after, diff, changes: _c, writes: _w, requests, response, relay_writes_first_15s: _r, ...rest } = details;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-labelledby="log-detail-title" data-testid="log-drawer">
      <button type="button" aria-label={t('drawer.closeDetails')} className="hidden sm:block absolute inset-0 bg-gray-900/50 cursor-default" onClick={onClose} />
      <aside className="relative w-full sm:max-w-xl h-full bg-panel sm:border-s border-line shadow-xl flex flex-col">
        <header className="flex items-start gap-3 px-4 py-3 border-b border-line">
          <StatusMark mark={mark} withLabel className="mt-1" />
          <div className="min-w-0 flex-1">
            <p className="text-label uppercase text-muted">{categoryLabel(it.category, t)} · <span className="font-mono normal-case tracking-normal" dir="ltr">{it.action}</span></p>
            {/* server text: localized by the backend */}
            <h2 id="log-detail-title" className="font-display text-base font-semibold text-ink break-words" dir="auto">{it.summary}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common:actions.close')}
            className="shrink-0 -me-2 min-h-touch min-w-[44px] inline-flex items-center justify-center rounded-md text-muted hover:text-ink hover:bg-field"
            data-testid="log-drawer-close"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
            <Fact label={t('drawer.when')}><span className="font-mono tabular">{fullTime(it.time, tz, lng)}</span>{duration ? <span className="text-muted"> · {t('drawer.lasted', { duration })}</span> : null}</Fact>
            <Fact label={t('drawer.who')}>
              <span className="inline-flex flex-wrap items-center gap-2">
                <ActorChip item={it} />
                {it.actor_role && <span className="text-xs text-muted">{t(`common:role.${it.actor_role}`, { defaultValue: it.actor_role })}</span>}
              </span>
            </Fact>
            <Fact label={t('drawer.device')}>{it.device ? <span className="inline-flex items-center gap-1.5"><DeviceIcon device={it.device} /><span dir="auto">{it.device}</span></span> : null}</Fact>
            <Fact label={t('drawer.ip')}>{it.ip ? <span className="font-mono" dir="ltr">{it.ip}</span> : null}</Fact>
            <Fact label={t('drawer.target')}>{it.target_name ? <span><span dir="auto">{it.target_name}</span>{it.target_type ? <span className="text-muted"> ({targetTypeLabel}{it.target_id ? <> <span dir="ltr">#{it.target_id}</span></> : null})</span> : null}</span> : null}</Fact>
            <Fact label={t('drawer.result')}>{it.result ? <span>{markLabel(mark, t)}{it.status_code ? <span className="font-mono text-muted"> · <span dir="ltr">HTTP {it.status_code}</span></span> : null}{it.duration_ms != null ? <span className="font-mono text-muted"> · <span dir="ltr">{it.duration_ms} ms</span></span> : null}</span> : null}</Fact>
            <Fact label={t('drawer.recordedIn')}>{SOURCE_LABELS[it.source] ? t(`drawer.source.${it.source}`, { defaultValue: SOURCE_LABELS[it.source] }) : it.source}</Fact>
            {it.repeat_count > 1 && <Fact label={t('drawer.repeated')}>{t('drawer.repeatedUntil', { count: it.repeat_count, time: timeOfDay(it.end_time, tz) })}</Fact>}
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {targetLink && <Button as={Link} to={targetLink.to} variant="secondary" size="sm">{targetLink.label}</Button>}
            {it.target_type && it.target_id && (
              <Button variant="ghost" size="sm" onClick={() => onFilterTarget(it.target_type, it.target_id, it.target_name)} data-testid="log-filter-target">
                {t('drawer.allActivityFor', { type: targetTypeLabel })}
              </Button>
            )}
            {it.actor_email && (
              <Button variant="ghost" size="sm" onClick={() => onFilterActor(it.actor_email)}>{t('drawer.everythingBy', { name: it.actor_email.split('@')[0] })}</Button>
            )}
          </div>

          {loading && <p className="mt-5 text-sm text-muted">{t('drawer.loading')}</p>}
          {error && <p className="mt-5 text-sm text-alarm-600 dark:text-alarm-300">{t('drawer.loadFailed', { error })}</p>}

          {it.source === 'request' && (
            <p className="mt-5 text-sm text-muted border border-dashed border-line rounded-card p-3">
              {t('drawer.requestLogNote')}
              {Array.isArray(details.route_candidates) && details.route_candidates.length > 1 && (
                <> {t('drawer.possibleRoutes')} <span dir="ltr" className="font-mono">{details.route_candidates.join(', ')}</span></>
              )}
            </p>
          )}

          {changes && changes.length > 0 && (
            <section className="mt-5" data-testid="log-changes">
              <Label className="mb-1.5">{t('drawer.whatChanged')}</Label>
              <ul className="list-disc ps-5 space-y-0.5 text-sm text-ink">
                {changes.map((c, i) => <li key={i} className="break-words" dir="auto">{c}</li>)}
              </ul>
            </section>
          )}
          <DiffTable diff={diff} />
          <RelayWrites rows={writes} tz={tz} />

          {Array.isArray(requests) && requests.length > 0 && (
            <section className="mt-5">
              <Label className="mb-1.5">{t('drawer.requests', { n: requests.length })}</Label>
              <ul className="border border-line rounded-card divide-y divide-line text-sm">
                {requests.slice(0, 50).map((r) => (
                  <li key={r.id} className="px-3 py-1.5 flex flex-wrap gap-x-2" dir="ltr">
                    <span className="font-mono tabular text-xs text-muted">{timeOfDay(r.time, tz)}</span>
                    <span className="font-mono text-xs text-ink break-all">{r.method} {r.path}</span>
                    <span className="font-mono text-xs text-muted">{r.status}</span>
                    <span className="text-xs text-muted">{r.device}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <JsonBlock title={t('drawer.json.body')} value={body} />
          <JsonBlock title={t('drawer.json.response')} value={response} />
          <JsonBlock title={t('drawer.before')} value={before} />
          <JsonBlock title={t('drawer.after')} value={after} />
          <JsonBlock title={t('drawer.json.raw')} value={Object.keys(rest).length ? rest : null} />
          {data && data.raw && <JsonBlock title={t('drawer.json.request')} value={data.raw} />}
        </div>
      </aside>
    </div>
  );
}
