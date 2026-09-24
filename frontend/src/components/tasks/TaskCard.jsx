import React from 'react';
import { Card, Button, StatusPill, Label } from '../../ui';
import { timeAgo } from '../alerts/relativeTime';

/** Priority is shape + colour: filled LED for critical/high, hollow below. */
const PRIORITY_PILL = {
  critical: { state: 'alarm', filled: true },
  high: { state: 'caution', filled: true },
  medium: { state: 'caution', filled: false },
  low: { state: 'idle', filled: false },
};

const STATUS_PILL = {
  open: { state: 'caution', filled: false, label: 'open' },
  snoozed: { state: 'idle', filled: false, label: 'snoozed' },
  done: { state: 'ok', filled: true, label: 'done' },
  declined: { state: 'idle', filled: true, label: 'declined' },
  archived: { state: 'idle', filled: false, label: 'archived' },
};

const CATEGORY_LABEL = {
  physical: 'Physical',
  measurement: 'Measurement',
  tutorial: 'Tutorial',
  config_change: 'Config change',
};

function railFor(task, outdated) {
  if (outdated) return 'caution';
  if (task.status === 'done') return 'ok';
  if (task.status === 'declined' || task.status === 'archived') return 'idle';
  if (task.priority === 'critical') return 'alarm';
  if (task.priority === 'high') return 'caution';
  return 'idle';
}

/**
 * One operator task. `outdated` (open task older than the freshness window)
 * gets a caution rail and an explicit pill so stale AI output never reads as
 * a current instruction.
 */
export default function TaskCard({ task: t, outdated = false, ageDays = null, canControl, onAction, onReopen, formatDateTime }) {
  const isOpen = t.status === 'open' || t.status === 'snoozed';
  const pr = PRIORITY_PILL[t.priority] || PRIORITY_PILL.medium;
  const st = STATUS_PILL[t.status] || STATUS_PILL.open;
  const fmt = (v) => (formatDateTime ? formatDateTime(v) : v);

  return (
    <Card rail={railFor(t, outdated)} padding="md" data-testid="task-card" data-outdated={outdated ? 'true' : 'false'}>
      <div className="flex flex-col sm:flex-row sm:items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1.5">
            <StatusPill state={pr.state} filled={pr.filled} className="uppercase" data-testid="task-priority">{t.priority}</StatusPill>
            <StatusPill state={st.state} filled={st.filled}>{st.label}</StatusPill>
            {outdated && (
              <StatusPill state="caution" filled={false} className="!whitespace-normal" data-testid="task-outdated">
                Outdated — created {ageDays} days ago; conditions may have changed
              </StatusPill>
            )}
          </div>
          <h3 className="font-display text-base font-semibold text-ink leading-6">{t.title}</h3>
          <p className="text-xs text-muted mt-0.5 flex flex-wrap gap-x-1.5">
            <span>{t.source}</span>
            <span aria-hidden="true">·</span>
            <span>{CATEGORY_LABEL[t.category] || CATEGORY_LABEL.physical}</span>
            {t.target_entity && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono">{t.target_entity}</span>
              </>
            )}
          </p>
          {t.description && (
            <p className="text-sm text-ink mt-2 whitespace-pre-wrap break-words">{t.description}</p>
          )}
          {t.expected_outcome && (
            <p className="mt-2 text-xs text-muted">
              <span className="font-semibold text-ink">Expected outcome:</span> {t.expected_outcome}
            </p>
          )}
          {t.instructions && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs font-semibold text-brand hover:underline">View instructions</summary>
              <div className="mt-1 text-sm text-ink whitespace-pre-wrap bg-field rounded-md p-2 border border-line">
                {t.instructions}
              </div>
            </details>
          )}
          <p className="text-xs text-muted mt-2 flex flex-wrap gap-x-1.5">
            <span>
              Created <span className="font-mono tabular" title={fmt(t.created_at)}>{timeAgo(t.created_at) || fmt(t.created_at)}</span>
            </span>
            {t.snoozed_until && (
              <>
                <span aria-hidden="true">·</span>
                <span>snoozed until <span className="font-mono tabular">{fmt(t.snoozed_until)}</span></span>
              </>
            )}
            {t.completed_at && (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  {t.status === 'declined' ? 'declined' : 'done'}{' '}
                  <span className="font-mono tabular">{fmt(t.completed_at)}</span>
                  {t.completed_by_email ? ` by ${t.completed_by_email}` : ''}
                </span>
              </>
            )}
          </p>
          {t.completion_notes && (
            <div className="mt-2 text-xs rounded-md border border-ok-300 dark:border-ok-700 bg-ok-50 dark:bg-ok-900/30 p-2 text-ink">
              <Label className="mb-0.5">Completion notes</Label>
              {t.completion_notes}
            </div>
          )}
          {t.decline_reason && (
            <div className="mt-2 text-xs rounded-md border border-caution-300 dark:border-caution-700 bg-caution-50 dark:bg-caution-900/30 p-2 text-ink">
              <Label className="mb-0.5">Decline reason (fed back to agent)</Label>
              {t.decline_reason}
            </div>
          )}
        </div>

        {canControl && (
          <div className="flex flex-row sm:flex-col gap-2 shrink-0 sm:self-start">
            {isOpen ? (
              <>
                <Button variant="primary" size="sm" className="flex-1 sm:flex-none" onClick={() => onAction(t, 'complete')} data-testid="task-done">Done</Button>
                <Button variant="danger-ghost" size="sm" className="flex-1 sm:flex-none" onClick={() => onAction(t, 'decline')}>Decline…</Button>
                {t.status !== 'snoozed' && (
                  <Button variant="ghost" size="sm" className="flex-1 sm:flex-none" onClick={() => onAction(t, 'snooze')}>Snooze…</Button>
                )}
              </>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => onReopen(t.id)}>Reopen</Button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
