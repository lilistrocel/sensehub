import React from 'react';
import { Link } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { Card, Label, StatusPill } from '../../ui';

const shortName = (name) => String(name || '').replace(/^Climate\s*[—–-]\s*/i, '');

/**
 * Automations panel: climate rules (enabled, last run, run count) and the
 * eight most recent executions. The disarmed banner lives in Layout; here
 * only the state pill is shown (in the section header).
 */
export default function AutomationsPanel({ automations, formatRelativeTime, formatTime }) {
  const { t } = useTranslation('dashboard');
  const rules = Array.isArray(automations?.climateRules) ? automations.climateRules : [];
  const recent = Array.isArray(automations?.recent) ? automations.recent.slice(0, 8) : [];

  return (
    <Card padding="sm" className="space-y-4">
      <div>
        <Label className="mb-1.5">{t('automations.climateRules')}</Label>
        {rules.length === 0 ? (
          <p className="text-sm text-muted">
            <Trans i18nKey="dashboard:automations.noRules" components={{ link: <Link to="/automations" className="underline" /> }} />
          </p>
        ) : (
          <ul className="divide-y divide-line" data-testid="climate-rules">
            {rules.map((r) => (
              <li key={r.id} className="flex items-center gap-2 py-1.5 text-sm min-w-0">
                <Link to="/automations" className="min-w-0 flex-1 truncate text-ink hover:underline" dir="auto" title={r.name}>{shortName(r.name)}</Link>
                <StatusPill state={r.enabled ? 'ok' : 'idle'} filled={r.enabled} className="shrink-0">{r.enabled ? t('automations.ruleOn') : t('automations.ruleOff')}</StatusPill>
                <span className="shrink-0 w-24 text-end font-mono tabular text-xs text-muted" title={r.last_run ? formatTime?.(r.last_run) : t('automations.neverRun')}>
                  {r.last_run && formatRelativeTime ? formatRelativeTime(r.last_run) : t('common:status.never')}
                </span>
                <span className="shrink-0 w-12 text-end font-mono tabular text-xs text-muted" title={t('automations.runCount')}>&times;{r.run_count ?? 0}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <Label className="mb-1.5">{t('automations.recent')}</Label>
        {recent.length === 0 ? (
          <p className="text-sm text-muted">{t('automations.nothingRun')}</p>
        ) : (
          <ul className="divide-y divide-line" data-testid="recent-executions">
            {recent.map((e, i) => (
              <li key={`${e.automation_id}-${e.ts}-${i}`} className="flex items-center gap-2 py-1.5 text-sm min-w-0">
                <span className="shrink-0 font-mono tabular text-xs text-muted">{formatTime ? formatTime(e.ts) : e.ts}</span>
                <span className="min-w-0 flex-1 truncate text-ink" dir="auto" title={e.message || e.name}>{shortName(e.name)}</span>
                <span className="shrink-0 font-mono tabular text-xs text-muted">
                  {e.trigger_type ? t(`automations.trigger.${e.trigger_type}`, { defaultValue: e.trigger_type }) : e.status}
                </span>
                <span
                  aria-label={e.ok ? t('common:status.success') : e.status || t('common:status.failed')}
                  title={e.ok ? t('common:status.success') : e.status || t('common:status.failed')}
                  className={`shrink-0 inline-block ${e.ok ? 'w-2 h-2 rounded-full bg-state-ok' : 'w-2 h-2 bg-state-alarm'}`}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-xs text-muted">
        {t('automations.enabledCount', { count: automations?.enabled ?? 0 })} · <Link to="/automations" className="underline">{t('automations.all')}</Link>
      </p>
    </Card>
  );
}
