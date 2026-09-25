import React from 'react';
import { Link } from 'react-router-dom';
import { Card, Label, StatusPill } from '../../ui';
import ReportMarkdown from './ReportMarkdown';

// Priority is shape + colour + text: alarm/caution/idle pill with the word,
// paired with the same rail on the card.
export const PRIORITY = {
  critical: { state: 'alarm', filled: true, rail: 'alarm', text: 'critical' },
  high: { state: 'alarm', filled: false, rail: 'alarm', text: 'high' },
  medium: { state: 'caution', filled: false, rail: 'caution', text: 'medium' },
  low: { state: 'idle', filled: false, rail: 'idle', text: 'low' },
};
const PRIORITY_ORDER = ['critical', 'high', 'medium', 'low'];
const priorityOf = (p) => (PRIORITY[p] ? p : 'low');

const TASK_STATUS = {
  open: { state: 'caution', filled: false, text: 'open' },
  snoozed: { state: 'idle', filled: false, text: 'snoozed' },
  done: { state: 'ok', filled: true, text: 'done' },
  declined: { state: 'idle', filled: true, text: 'declined' },
};

// Notes longer than this sit behind a disclosure under the cards.
const NOTES_COLLAPSE_CHARS = 600;

export function PriorityPill({ priority, className = '' }) {
  const p = PRIORITY[priorityOf(priority)];
  return <StatusPill state={p.state} filled={p.filled} text={p.text} className={className} />;
}

export function RecommendationCard({ rec, compact = false }) {
  const p = PRIORITY[priorityOf(rec.priority)];
  return (
    <Card as="li" rail={p.rail} padding="sm" className="list-none" data-priority={priorityOf(rec.priority)}>
      <div className="flex items-start gap-3">
        <PriorityPill priority={rec.priority} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className={`font-semibold text-ink break-words ${compact ? 'text-sm' : 'text-[15px] leading-6'}`}>{rec.action}</p>
          {rec.rationale && !compact && (
            <p className="mt-1 text-sm leading-6 text-muted break-words">{rec.rationale}</p>
          )}
        </div>
      </div>
    </Card>
  );
}

/** Group recommendations high -> medium -> low, keeping the model's order inside a group. */
export function groupRecommendations(recs) {
  const groups = new Map(PRIORITY_ORDER.map(k => [k, []]));
  (recs || []).forEach(r => groups.get(priorityOf(r.priority)).push(r));
  return PRIORITY_ORDER.map(k => ({ priority: k, items: groups.get(k) })).filter(g => g.items.length);
}

function TaskRow({ task }) {
  const s = TASK_STATUS[task.status] || TASK_STATUS.open;
  return (
    // Phone: title gets the full row, category + status sit underneath.
    <li className="py-2.5 flex flex-col sm:flex-row sm:items-start gap-1.5 sm:gap-3">
      <span className="flex items-start gap-3 min-w-0 flex-1">
        <PriorityPill priority={task.priority} className="mt-0.5 shrink-0" />
        <span className="min-w-0 flex-1 text-sm text-ink break-words">{task.title}</span>
      </span>
      <span className="flex items-center gap-2 shrink-0 self-end sm:self-auto">
        <span className="font-mono text-[11px] text-muted">{String(task.category || '').replace(/_/g, ' ')}</span>
        <StatusPill state={s.state} filled={s.filled} text={s.text} />
      </span>
    </li>
  );
}

/**
 * Actions tab: structured recommendations as cards grouped by priority, the
 * operator tasks the run created (read-only here; worked on the Tasks page),
 * then the report's own "Recommendations" prose so no text is lost.
 */
export default function ReportActions({ report, notes, tasks, tasksError }) {
  const groups = groupRecommendations(report.recommendations);
  const hasNotes = !!notes?.trim();
  const longNotes = hasNotes && notes.length > NOTES_COLLAPSE_CHARS;

  return (
    <div className="space-y-5">
      {groups.length === 0 ? (
        <Card padding="sm" className="text-sm text-muted">
          No structured recommendations in this report.
        </Card>
      ) : groups.map(g => (
        <section key={g.priority} aria-label={`${PRIORITY[g.priority].text} priority`}>
          <Label as="h3" className="mb-2">
            {PRIORITY[g.priority].text} priority <span className="font-mono">· {g.items.length}</span>
          </Label>
          <ul className="space-y-2">
            {g.items.map((rec, i) => <RecommendationCard key={i} rec={rec} />)}
          </ul>
        </section>
      ))}

      {(tasks?.length > 0 || tasksError) && (
        <Card padding="sm" data-testid="report-tasks">
          <div className="flex items-baseline justify-between gap-2 flex-wrap">
            <Label as="h3">Operator tasks from this report <span className="font-mono">· {tasks?.length || 0}</span></Label>
            <Link to="/tasks" className="text-sm font-semibold text-brand hover:underline min-h-[36px] inline-flex items-center">Open Tasks</Link>
          </div>
          {tasksError ? (
            <p className="text-sm text-muted mt-1">Could not load tasks: {tasksError}</p>
          ) : (
            <ul className="divide-y divide-line">
              {tasks.map(t => <TaskRow key={t.id} task={t} />)}
            </ul>
          )}
        </Card>
      )}

      {hasNotes && (
        longNotes ? (
          <Card as="details" padding="none" className="group">
            <summary className="cursor-pointer list-none min-h-touch px-4 py-2 flex items-center gap-2 hover:bg-field rounded-card">
              <svg aria-hidden="true" className="w-4 h-4 text-muted transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
              <span className="text-sm font-semibold text-ink">Agronomist's notes</span>
            </summary>
            <div className="px-4 pb-4 pt-1"><ReportMarkdown markdown={notes} /></div>
          </Card>
        ) : (
          <Card>
            <Label as="h3" className="mb-2">Agronomist's notes</Label>
            <ReportMarkdown markdown={notes} />
          </Card>
        )
      )}
    </div>
  );
}
