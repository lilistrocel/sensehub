import React from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { Card, Button, StatusPill, Label, ProvenanceBadge } from '../../ui';
import { useFormat } from '../../i18n/useFormat';
import { normalizeLanguage } from '../../i18n/languages';

/** Priority is shape + colour: filled LED for critical/high, hollow below. */
const PRIORITY_PILL = {
  critical: { state: 'alarm', filled: true },
  high: { state: 'caution', filled: true },
  medium: { state: 'caution', filled: false },
  low: { state: 'idle', filled: false },
};

// Words: tasks:status.<key> / tasks:category.<key> (`label` = English reference).
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

/** Who wrote the task (operator request 2026-09-30): the AI agents vs the farm team. */
const SOURCE_PROVENANCE = { agronomist: 'ai', planner: 'ai', manual: 'operator' };

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
export default function TaskCard({ task, outdated = false, ageDays = null, canControl, onAction, onReopen, formatDateTime, showingOriginal = false }) {
  const { t, i18n } = useTranslation('tasks');
  const f = useFormat();
  const uiLang = normalizeLanguage(i18n.language) || 'en';
  const isOpen = task.status === 'open' || task.status === 'snoozed';
  const priorityKey = PRIORITY_PILL[task.priority] ? task.priority : 'medium';
  const pr = PRIORITY_PILL[priorityKey];
  const statusKey = STATUS_PILL[task.status] ? task.status : 'open';
  const st = STATUS_PILL[statusKey];
  const categoryKey = CATEGORY_LABEL[task.category] ? task.category : 'physical';
  const fmt = (v) => (formatDateTime ? formatDateTime(v) : v);
  // Task text is in the UI language only when the server translated it; otherwise
  // (English, or an operator's own words) let the browser pick the direction.
  const translated = task.translation_status === 'ready';
  const textDir = translated ? undefined : 'auto';
  // Relative age with a long threshold so "84 days ago" stays relative (was timeAgo()).
  const created = task.created_at ? f.relative(task.created_at, { thresholdHours: 24 * 3650 }) : null;
  let translationNote = null;
  if (uiLang !== 'en' && !showingOriginal) {
    if (translated) translationNote = t('translation.auto');
    else if (task.translation_status === 'pending') translationNote = t('translation.pending');
    else if (task.translation_status === 'failed') translationNote = t('translation.failed');
  }

  return (
    <Card rail={railFor(task, outdated)} padding="md" data-testid="task-card" data-outdated={outdated ? 'true' : 'false'}>
      <div className="flex flex-col sm:flex-row sm:items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1.5">
            <StatusPill state={pr.state} filled={pr.filled} className="uppercase" data-testid="task-priority">{t(`priority.${priorityKey}`)}</StatusPill>
            <StatusPill state={st.state} filled={st.filled}>{t(`status.${statusKey}`)}</StatusPill>
            {SOURCE_PROVENANCE[task.source] && <ProvenanceBadge kind={SOURCE_PROVENANCE[task.source]} data-testid="task-provenance" />}
            {outdated && (
              <StatusPill state="caution" filled={false} className="!whitespace-normal" data-testid="task-outdated">
                {t('card.outdated', { count: ageDays ?? 0 })}
              </StatusPill>
            )}
          </div>
          <h3 className="font-display text-base font-semibold text-ink leading-6" dir={textDir}>{task.title}</h3>
          <p className="text-xs text-muted mt-0.5 flex flex-wrap gap-x-1.5">
            <span>{t(`source.${task.source}`, { defaultValue: task.source })}</span>
            <span aria-hidden="true">·</span>
            <span>{t(`category.${categoryKey}`)}</span>
            {task.target_entity && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono" dir="auto">{task.target_entity}</span>
              </>
            )}
            {translationNote && (
              <>
                <span aria-hidden="true">·</span>
                <span className="italic" data-testid="task-translation" data-translation-status={task.translation_status}>{translationNote}</span>
              </>
            )}
          </p>
          {task.description && (
            <p className="text-sm text-ink mt-2 whitespace-pre-wrap break-words" dir={textDir}>{task.description}</p>
          )}
          {task.expected_outcome && (
            <p className="mt-2 text-xs text-muted">
              <span className="font-semibold text-ink">{t('card.expectedOutcome')}</span> <span dir={textDir}>{task.expected_outcome}</span>
            </p>
          )}
          {task.instructions && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs font-semibold text-brand hover:underline">{t('card.viewInstructions')}</summary>
              <div className="mt-1 text-sm text-ink whitespace-pre-wrap bg-field rounded-md p-2 border border-line" dir={textDir}>
                {task.instructions}
              </div>
            </details>
          )}
          <p className="text-xs text-muted mt-2 flex flex-wrap gap-x-1.5">
            <span>
              {t('card.created')} <span className="font-mono tabular" title={fmt(task.created_at)}>{(created && created !== '-') ? created : fmt(task.created_at)}</span>
            </span>
            {task.snoozed_until && (
              <>
                <span aria-hidden="true">·</span>
                <span>{t('card.snoozedUntil')} <span className="font-mono tabular">{fmt(task.snoozed_until)}</span></span>
              </>
            )}
            {task.completed_at && (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  {task.status === 'declined' ? t('card.declinedAt') : t('card.doneAt')}{' '}
                  <span className="font-mono tabular">{fmt(task.completed_at)}</span>
                  {task.completed_by_email ? <>{' '}<Trans t={t} i18nKey="card.byUser" values={{ email: task.completed_by_email }} components={{ email: <bdi dir="ltr" /> }} /></> : ''}
                </span>
              </>
            )}
          </p>
          {task.completion_notes && (
            <div className="mt-2 text-xs rounded-md border border-ok-300 dark:border-ok-700 bg-ok-50 dark:bg-ok-900/30 p-2 text-ink">
              <Label className="mb-0.5">{t('card.completionNotes')}</Label>
              <span dir="auto">{task.completion_notes}</span>
            </div>
          )}
          {task.decline_reason && (
            <div className="mt-2 text-xs rounded-md border border-caution-300 dark:border-caution-700 bg-caution-50 dark:bg-caution-900/30 p-2 text-ink">
              <Label className="mb-0.5">{t('card.declineReason')}</Label>
              <span dir="auto">{task.decline_reason}</span>
            </div>
          )}
        </div>

        {canControl && (
          <div className="flex flex-row sm:flex-col gap-2 shrink-0 sm:self-start">
            {isOpen ? (
              <>
                <Button variant="primary" size="sm" className="flex-1 sm:flex-none" onClick={() => onAction(task, 'complete')} data-testid="task-done">{t('card.done')}</Button>
                <Button variant="danger-ghost" size="sm" className="flex-1 sm:flex-none" onClick={() => onAction(task, 'decline')}>{t('card.decline')}</Button>
                {task.status !== 'snoozed' && (
                  <Button variant="ghost" size="sm" className="flex-1 sm:flex-none" onClick={() => onAction(task, 'snooze')}>{t('card.snooze')}</Button>
                )}
              </>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => onReopen(task.id)}>{t('card.reopen')}</Button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
