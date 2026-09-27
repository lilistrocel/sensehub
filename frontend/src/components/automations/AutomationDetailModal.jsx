import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettings } from '../../context/SettingsContext';
import { useFormat } from '../../i18n/useFormat';
import { Button, Label, StatusPill } from '../../ui';
import { TriggerChip } from './AutomationRow';
import { ICON_BUTTON, API_BASE } from './formStyles';
import { parseAutomation, isEnabled, describeWhen, collectTargets, formatDuration, relativeTime, actionWord } from './automationSummary';
import { useSummaryLocale } from './useSummaryLocale';

const LOG_STATE = { success: 'ok', error: 'alarm', warning: 'caution', skipped: 'caution', pending: 'idle' };

/** Read-only view of an automation: summary, channel list, run history. */
export default function AutomationDetailModal({ isOpen, onClose, automation, onEdit, canEdit, token, equipIndex, summary }) {
  const { t } = useTranslation('automations');
  const loc = useSummaryLocale();
  const fmt = useFormat();
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
  const targets = collectTargets(actions, equipIndex, loc);
  const alerts = actions.filter(a => a?.type === 'alert');
  const logsActions = actions.filter(a => a?.type === 'log');

  const tabClass = (tab) => `min-h-touch px-3 text-sm font-semibold border-b-2 -mb-px ${activeTab === tab ? 'border-brand-600 text-ink' : 'border-transparent text-muted hover:text-ink'}`;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto" role="presentation">
      <div className="fixed inset-0 bg-night/60" onClick={onClose} aria-hidden="true" />
      <div className="relative min-h-full flex items-start justify-center p-4 sm:py-8">
        <div role="dialog" aria-modal="true" aria-labelledby="automation-detail-title" className="relative w-full max-w-2xl bg-panel border border-line rounded-card shadow-xl text-start">
          <div className="flex items-start justify-between gap-3 px-4 pt-4 sm:px-6 sm:pt-6">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Label>{t('detail.label')}</Label>
                <span className="text-xs font-mono tabular text-muted">#{automation.id}</span>
              </div>
              <h3 id="automation-detail-title" className="font-display text-lg font-semibold text-ink" dir="auto">{automation.name}</h3>
              {automation.description && <p className="text-sm text-muted mt-1" dir="auto">{automation.description}</p>}
            </div>
            <button type="button" onClick={onClose} className={ICON_BUTTON} aria-label={t('common:actions.close')}>
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>

          <div className="px-4 sm:px-6 mt-3">
            <p className="text-sm text-ink" title={summary?.long}>
              <span className="font-mono tabular">{summary?.when || describeWhen(trigger, equipIndex, { loc })}</span>
              <span className="inline-block text-muted mx-1.5 rtl:-scale-x-100" aria-hidden="true">→</span>
              <span>{summary?.what}</span>
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StatusPill state={enabled ? 'ok' : 'idle'} filled={enabled}>{enabled ? t('common:status.enabled') : t('common:status.disabled')}</StatusPill>
              <TriggerChip type={trigger?.type || 'manual'} />
              <span className="text-xs font-mono tabular text-muted">{t('detail.priority', { n: automation.priority || 0 })}</span>
            </div>
          </div>

          <div className="px-4 sm:px-6 mt-4 border-b border-line flex gap-2">
            <button type="button" className={tabClass('details')} onClick={() => setActiveTab('details')}>{t('detail.tabDetails')}</button>
            <button type="button" className={tabClass('history')} onClick={() => setActiveTab('history')}>
              {t('detail.tabHistory')}{automation.run_count > 0 && <span className="ms-1.5 font-mono tabular text-muted">{automation.run_count}</span>}
            </button>
          </div>

          <div className="px-4 py-4 sm:px-6">
            {activeTab === 'details' && (
              <div className="space-y-4 text-sm">
                <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div><dt className="text-xs text-muted">{t('detail.when')}</dt><dd className="text-ink">{describeWhen(trigger, equipIndex, { long: true, loc })}</dd></div>
                  <div><dt className="text-xs text-muted">{t('detail.lastRun')}</dt><dd className="font-mono tabular text-ink">{relativeTime(automation.last_run, undefined, loc)}</dd>{automation.last_run && <dd className="text-xs text-muted font-mono tabular">{formatDateTime(automation.last_run)}</dd>}</div>
                  <div><dt className="text-xs text-muted">{t('detail.runs')}</dt><dd className="font-mono tabular text-ink">{automation.run_count || 0}</dd></div>
                  <div><dt className="text-xs text-muted">{t('detail.created')}</dt><dd className="font-mono tabular text-ink">{automation.created_at ? formatDateTime(automation.created_at) : '—'}</dd></div>
                </dl>

                <div>
                  <Label>{t('detail.channels', { n: targets.length })}</Label>
                  {targets.length === 0 ? (
                    <p className="text-muted mt-1">{t('detail.noChannels')}</p>
                  ) : (
                    <ul className="mt-1 divide-y divide-line border border-line rounded-md">
                      {targets.map((x, i) => (
                        <li key={i} className="flex items-center gap-2 px-3 py-1.5">
                          <span className="text-ink truncate" dir="auto">{x.eqName} · {x.label}</span>
                          <span className="ms-auto font-mono tabular text-xs text-muted whitespace-nowrap">
                            {actionWord(x.action, loc)}{x.value !== null && x.value !== undefined && x.action === 'set' ? ` ${x.value}` : ''}{x.duration ? ` ${formatDuration(x.duration, loc)}` : ''}{x.windows > 1 ? ` ×${x.windows}` : ''}{x.delay ? ` +${formatDuration(x.delay, loc)}` : ''}
                          </span>
                          {x.online === false && <StatusPill state="caution">{t('common:status.offline')}</StatusPill>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {(alerts.length > 0 || logsActions.length > 0) && (
                  <div>
                    <Label>{t('detail.alertsAndLogs')}</Label>
                    <ul className="mt-1 space-y-1">
                      {alerts.map((a, i) => <li key={`a${i}`} className="text-ink"><span className="text-xs font-bold uppercase tracking-label text-muted me-2">{t(`common:severity.${a.severity || 'info'}`, { defaultValue: a.severity })}</span><span dir="auto">{a.message}</span></li>)}
                      {logsActions.map((a, i) => <li key={`l${i}`} className="text-ink"><span className="text-xs font-bold uppercase tracking-label text-muted me-2">{t('detail.logTag')}</span><span dir="auto">{a.message}</span></li>)}
                    </ul>
                  </div>
                )}

                {conditions.length > 0 && (
                  <p className="text-muted">{t('detail.dryRunConditions', { count: conditions.length, logic: automation.condition_logic || 'AND' })}</p>
                )}
              </div>
            )}

            {activeTab === 'history' && (
              <div className="min-h-[160px]">
                {loadingLogs && <p className="text-sm text-muted">{t('detail.historyLoading')}</p>}
                {logsError && <p className="text-sm text-alarm-700 dark:text-alarm-300">{t('detail.historyError', { error: logsError })}</p>}
                {!loadingLogs && !logsError && logs.length === 0 && <p className="text-sm text-muted">{t('detail.historyEmpty')}</p>}
                {logs.length > 0 && (
                  <ul className="space-y-2">
                    {logs.map((log, i) => (
                      <li key={log.id || i} className="bg-field/60 border border-line rounded-md p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusPill state={LOG_STATE[log.status] || 'idle'} filled={log.status === 'success'}>{t(`logStatus.${log.status}`, { defaultValue: log.status })}</StatusPill>
                          <span className="text-xs font-mono tabular text-muted">{log.triggered_at ? formatDateTime(log.triggered_at) : '—'}</span>
                          {log.completed_at && log.triggered_at && (
                            <span className="text-xs font-mono tabular text-muted">{fmt.duration(Math.max(0, Math.round((new Date(log.completed_at) - new Date(log.triggered_at)) / 1000)))}</span>
                          )}
                        </div>
                        <p className="mt-1 text-sm text-ink break-words" dir="auto">{log.message || t('detail.noMessage')}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          <div className="px-4 pb-4 sm:px-6 sm:pb-6 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <Button variant="ghost" onClick={onClose} className="w-full sm:w-auto">{t('common:actions.close')}</Button>
            {canEdit && <Button variant="secondary" onClick={() => { onClose(); onEdit(automation); }} className="w-full sm:w-auto">{t('common:actions.edit')}</Button>}
          </div>
        </div>
      </div>
    </div>
  );
}
