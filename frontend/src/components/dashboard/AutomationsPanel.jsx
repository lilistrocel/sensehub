import React from 'react';
import { Link } from 'react-router-dom';
import { Card, Label, StatusPill } from '../../ui';

const shortName = (name) => String(name || '').replace(/^Climate\s*[—–-]\s*/i, '');

/**
 * Automations panel: climate rules (enabled, last run, run count) and the
 * eight most recent executions. The disarmed banner lives in Layout; here
 * only the state pill is shown (in the section header).
 */
export default function AutomationsPanel({ automations, formatRelativeTime, formatTime }) {
  const rules = Array.isArray(automations?.climateRules) ? automations.climateRules : [];
  const recent = Array.isArray(automations?.recent) ? automations.recent.slice(0, 8) : [];

  return (
    <Card padding="sm" className="space-y-4">
      <div>
        <Label className="mb-1.5">Climate rules</Label>
        {rules.length === 0 ? (
          <p className="text-sm text-muted">No climate rules defined. <Link to="/automations" className="underline">Create one</Link>.</p>
        ) : (
          <ul className="divide-y divide-line" data-testid="climate-rules">
            {rules.map((r) => (
              <li key={r.id} className="flex items-center gap-2 py-1.5 text-sm min-w-0">
                <Link to="/automations" className="min-w-0 flex-1 truncate text-ink hover:underline" title={r.name}>{shortName(r.name)}</Link>
                <StatusPill state={r.enabled ? 'ok' : 'idle'} filled={r.enabled} className="shrink-0">{r.enabled ? 'on' : 'off'}</StatusPill>
                <span className="shrink-0 w-24 text-right font-mono tabular text-xs text-muted" title={r.last_run ? formatTime?.(r.last_run) : 'never run'}>
                  {r.last_run && formatRelativeTime ? formatRelativeTime(r.last_run) : 'never'}
                </span>
                <span className="shrink-0 w-12 text-right font-mono tabular text-xs text-muted" title="run count">&times;{r.run_count ?? 0}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <Label className="mb-1.5">Recent executions</Label>
        {recent.length === 0 ? (
          <p className="text-sm text-muted">Nothing has run yet.</p>
        ) : (
          <ul className="divide-y divide-line" data-testid="recent-executions">
            {recent.map((e, i) => (
              <li key={`${e.automation_id}-${e.ts}-${i}`} className="flex items-center gap-2 py-1.5 text-sm min-w-0">
                <span className="shrink-0 font-mono tabular text-xs text-muted">{formatTime ? formatTime(e.ts) : e.ts}</span>
                <span className="min-w-0 flex-1 truncate text-ink" title={e.message || e.name}>{shortName(e.name)}</span>
                <span className="shrink-0 font-mono tabular text-xs text-muted">{e.trigger_type || e.status}</span>
                <span
                  aria-label={e.ok ? 'success' : e.status || 'failed'}
                  title={e.ok ? 'success' : e.status || 'failed'}
                  className={`shrink-0 inline-block ${e.ok ? 'w-2 h-2 rounded-full bg-state-ok' : 'w-2 h-2 bg-state-alarm'}`}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-xs text-muted">
        {automations?.enabled ?? 0} automations enabled · <Link to="/automations" className="underline">All automations</Link>
      </p>
    </Card>
  );
}
