import React, { useState, useEffect } from 'react';
import { useSettings } from '../../context/SettingsContext';
import { Button, Label, StatusPill } from '../../ui';
import { TriggerChip } from './AutomationRow';
import { ICON_BUTTON, API_BASE } from './formStyles';
import { parseAutomation, isEnabled, describeWhen, collectTargets, formatDuration, relativeTime } from './automationSummary';

const LOG_STATE = { success: 'ok', error: 'alarm', warning: 'caution', skipped: 'caution', pending: 'idle' };

/** Read-only view of an automation: summary, channel list, run history. */
export default function AutomationDetailModal({ isOpen, onClose, automation, onEdit, canEdit, token, equipIndex, summary }) {
  const { formatDateTime } = useSettings();
  const [activeTab, setActiveTab] = useState('details');
  const [logs, setLogs] = useState([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [logsError, setLogsError] = useState(null);

  useEffect(() => {
    if (isOpen && automation) { setActiveTab('details'); setLogs([]); setLogsError(null); }
  }, [isOpen, automation?.id]);

  useEffect(() => {
    if (!isOpen || !automation?.id || activeTab !== 'history') return;
    let cancelled = false;
    setLoadingLogs(true);
    fetch(`${API_BASE}/automations/${automation.id}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(data => { if (!cancelled) setLogs(Array.isArray(data.logs) ? data.logs : []); })
      .catch(err => { if (!cancelled) setLogsError(err.message); })
      .finally(() => { if (!cancelled) setLoadingLogs(false); });
    return () => { cancelled = true; };
  }, [isOpen, automation?.id, activeTab, token]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen || !automation) return null;

  const { trigger, conditions, actions } = parseAutomation(automation);
  const enabled = isEnabled(automation);
  const targets = collectTargets(actions, equipIndex);
  const alerts = actions.filter(a => a?.type === 'alert');
  const logsActions = actions.filter(a => a?.type === 'log');

  const tabClass = (t) => `min-h-touch px-3 text-sm font-semibold border-b-2 -mb-px ${activeTab === t ? 'border-brand-600 text-ink' : 'border-transparent text-muted hover:text-ink'}`;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto" role="presentation">
      <div className="fixed inset-0 bg-night/60" onClick={onClose} aria-hidden="true" />
      <div className="relative min-h-full flex items-start justify-center p-4 sm:py-8">
        <div role="dialog" aria-modal="true" aria-labelledby="automation-detail-title" className="relative w-full max-w-2xl bg-panel border border-line rounded-card shadow-xl text-left">
          <div className="flex items-start justify-between gap-3 px-4 pt-4 sm:px-6 sm:pt-6">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Label>Automation</Label>
                <span className="text-xs font-mono tabular text-muted">#{automation.id}</span>
              </div>
              <h3 id="automation-detail-title" className="font-display text-lg font-semibold text-ink">{automation.name}</h3>
              {automation.description && <p className="text-sm text-muted mt-1">{automation.description}</p>}
            </div>
            <button type="button" onClick={onClose} className={ICON_BUTTON} aria-label="Close">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>

          <div className="px-4 sm:px-6 mt-3">
            <p className="text-sm text-ink" title={summary?.long}>
              <span className="font-mono tabular">{summary?.when || describeWhen(trigger, equipIndex)}</span>
              <span className="text-muted mx-1.5" aria-hidden="true">→</span>
              <span>{summary?.what}</span>
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StatusPill state={enabled ? 'ok' : 'idle'} filled={enabled}>{enabled ? 'Enabled' : 'Disabled'}</StatusPill>
              <TriggerChip type={trigger?.type || 'manual'} />
              <span className="text-xs font-mono tabular text-muted">priority {automation.priority || 0}</span>
            </div>
          </div>

          <div className="px-4 sm:px-6 mt-4 border-b border-line flex gap-2">
            <button type="button" className={tabClass('details')} onClick={() => setActiveTab('details')}>Details</button>
            <button type="button" className={tabClass('history')} onClick={() => setActiveTab('history')}>
              Run history{automation.run_count > 0 && <span className="ml-1.5 font-mono tabular text-muted">{automation.run_count}</span>}
            </button>
          </div>

          <div className="px-4 py-4 sm:px-6">
            {activeTab === 'details' && (
              <div className="space-y-4 text-sm">
                <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div><dt className="text-xs text-muted">When</dt><dd className="text-ink">{describeWhen(trigger, equipIndex, { long: true })}</dd></div>
                  <div><dt className="text-xs text-muted">Last run</dt><dd className="font-mono tabular text-ink">{automation.last_run ? `${relativeTime(automation.last_run)}` : 'never'}</dd>{automation.last_run && <dd className="text-xs text-muted font-mono tabular">{formatDateTime(automation.last_run)}</dd>}</div>
                  <div><dt className="text-xs text-muted">Runs</dt><dd className="font-mono tabular text-ink">{automation.run_count || 0}</dd></div>
                  <div><dt className="text-xs text-muted">Created</dt><dd className="font-mono tabular text-ink">{automation.created_at ? formatDateTime(automation.created_at) : '—'}</dd></div>
                </dl>

                <div>
                  <Label>Channels ({targets.length})</Label>
                  {targets.length === 0 ? (
                    <p className="text-muted mt-1">No relay channels are switched.</p>
                  ) : (
                    <ul className="mt-1 divide-y divide-line border border-line rounded-md">
                      {targets.map((t, i) => (
                        <li key={i} className="flex items-center gap-2 px-3 py-1.5">
                          <span className="text-ink truncate">{t.eqName} · {t.label}</span>
                          <span className="ml-auto font-mono tabular text-xs text-muted whitespace-nowrap">
                            {t.action.toUpperCase()}{t.value !== null && t.value !== undefined && t.action === 'set' ? ` ${t.value}` : ''}{t.duration ? ` ${formatDuration(t.duration)}` : ''}{t.delay ? ` +${formatDuration(t.delay)}` : ''}
                          </span>
                          {t.online === false && <StatusPill state="caution">offline</StatusPill>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {(alerts.length > 0 || logsActions.length > 0) && (
                  <div>
                    <Label>Alerts and logs</Label>
                    <ul className="mt-1 space-y-1">
                      {alerts.map((a, i) => <li key={`a${i}`} className="text-ink"><span className="text-xs font-bold uppercase tracking-label text-muted mr-2">{a.severity || 'info'}</span>{a.message}</li>)}
                      {logsActions.map((a, i) => <li key={`l${i}`} className="text-ink"><span className="text-xs font-bold uppercase tracking-label text-muted mr-2">log</span>{a.message}</li>)}
                    </ul>
                  </div>
                )}

                {conditions.length > 0 && (
                  <p className="text-muted">{conditions.length} dry-run condition{conditions.length > 1 ? 's' : ''} ({automation.condition_logic || 'AND'}); the executor gates on per-action dependencies instead.</p>
                )}
              </div>
            )}

            {activeTab === 'history' && (
              <div className="min-h-[160px]">
                {loadingLogs && <p className="text-sm text-muted">Loading history…</p>}
                {logsError && <p className="text-sm text-alarm-700 dark:text-alarm-300">Could not load history: {logsError}</p>}
                {!loadingLogs && !logsError && logs.length === 0 && <p className="text-sm text-muted">This automation has not run yet.</p>}
                {logs.length > 0 && (
                  <ul className="space-y-2">
                    {logs.map((log, i) => (
                      <li key={log.id || i} className="bg-field/60 border border-line rounded-md p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusPill state={LOG_STATE[log.status] || 'idle'} filled={log.status === 'success'}>{log.status}</StatusPill>
                          <span className="text-xs font-mono tabular text-muted">{log.triggered_at ? formatDateTime(log.triggered_at) : '—'}</span>
                          {log.completed_at && log.triggered_at && (
                            <span className="text-xs font-mono tabular text-muted">{Math.max(0, Math.round((new Date(log.completed_at) - new Date(log.triggered_at)) / 1000))} s</span>
                          )}
                        </div>
                        <p className="mt-1 text-sm text-ink break-words">{log.message || 'No message'}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          <div className="px-4 pb-4 sm:px-6 sm:pb-6 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <Button variant="ghost" onClick={onClose} className="w-full sm:w-auto">Close</Button>
            {canEdit && <Button variant="secondary" onClick={() => { onClose(); onEdit(automation); }} className="w-full sm:w-auto">Edit</Button>}
          </div>
        </div>
      </div>
    </div>
  );
}
