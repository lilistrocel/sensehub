/**
 * Tasks page — the human-in-the-loop surface for AI agents.
 *
 * Lists agronomist/planner/manual operator_tasks with confirm + decline +
 * snooze actions. Confirmation notes + decline reasons feed back into the
 * next agent run so its mental model updates from operator feedback.
 *
 * Stale AI output expires visually: any open task older than OUTDATED_DAYS
 * gets a caution rail + "Outdated" pill, sorts below fresh tasks and is
 * hidden by default behind the "Hide outdated" chip.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useSettings } from '../context/SettingsContext';
import { Card, Label, Button } from '../ui';
import TaskCard from '../components/tasks/TaskCard';
import { daysSince } from '../components/alerts/relativeTime';

const API_BASE = '/api';
const OUTDATED_DAYS = 7;
const PAGE_SIZE = 50;

const selectCls = 'min-h-touch px-3 py-2 bg-field text-ink border border-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-500';
const fieldCls = 'w-full px-3 py-2 text-sm bg-field text-ink border border-line rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500';

export default function Tasks() {
  const { token, user } = useAuth();
  const { showError, showSuccess } = useToast();
  const { formatDateTime } = useSettings();
  const canControl = user?.role === 'admin' || user?.role === 'operator';

  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('open');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [hideOutdated, setHideOutdated] = useState(true);
  const [shown, setShown] = useState(PAGE_SIZE);
  const [activeTask, setActiveTask] = useState(null);
  const [actionMode, setActionMode] = useState(null); // 'complete' | 'decline' | 'snooze'
  const [actionText, setActionText] = useState('');
  const [actionDate, setActionDate] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (sourceFilter !== 'all') params.set('source', sourceFilter);
      params.set('limit', '200');
      const res = await fetch(`${API_BASE}/operator-tasks?${params}`, { headers });
      if (res.ok) {
        const data = await res.json();
        setTasks(Array.isArray(data) ? data : []);
      }
    } catch (e) { showError('Failed to load tasks: ' + e.message); }
    finally { setLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, sourceFilter, token]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setShown(PAGE_SIZE); }, [statusFilter, sourceFilter, hideOutdated]);

  // Tag age; stable-partition fresh before outdated (server order kept within each group).
  const { fresh, outdated } = useMemo(() => {
    const now = Date.now();
    const fresh = [];
    const outdated = [];
    for (const t of tasks) {
      const days = daysSince(t.created_at, now);
      const isOpen = t.status === 'open' || t.status === 'snoozed';
      const stale = isOpen && days !== null && days > OUTDATED_DAYS;
      (stale ? outdated : fresh).push({ task: t, days, outdated: stale });
    }
    return { fresh, outdated };
  }, [tasks]);

  const visible = hideOutdated ? fresh : [...fresh, ...outdated];
  const rendered = visible.slice(0, shown);
  const remaining = visible.length - rendered.length;

  const openAction = (task, mode) => {
    setActiveTask(task);
    setActionMode(mode);
    setActionText('');
    if (mode === 'snooze') {
      // Default snooze to tomorrow morning
      const tmr = new Date(); tmr.setDate(tmr.getDate() + 1); tmr.setHours(8, 0, 0, 0);
      setActionDate(tmr.toISOString().slice(0, 16));
    }
  };

  const closeAction = () => { setActiveTask(null); setActionMode(null); };

  const submitAction = async () => {
    if (!activeTask) return;
    setSubmitting(true);
    try {
      let url, body;
      if (actionMode === 'complete') {
        url = `${API_BASE}/operator-tasks/${activeTask.id}/complete`;
        body = { notes: actionText.trim() || null };
      } else if (actionMode === 'decline') {
        const reason = actionText.trim();
        if (!reason) { showError('Decline reason is required so the agent can update its theory.'); setSubmitting(false); return; }
        url = `${API_BASE}/operator-tasks/${activeTask.id}/decline`;
        body = { reason };
      } else if (actionMode === 'snooze') {
        url = `${API_BASE}/operator-tasks/${activeTask.id}/snooze`;
        body = { until: new Date(actionDate).toISOString() };
      } else { return; }
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        showError(e.error || 'Action failed');
      } else {
        showSuccess(actionMode === 'complete' ? 'Task marked done' : actionMode === 'decline' ? 'Task declined — feedback recorded' : 'Task snoozed');
        closeAction();
        load();
      }
    } catch (e) { showError(e.message); }
    finally { setSubmitting(false); }
  };

  const reopen = async (taskId) => {
    try {
      await fetch(`${API_BASE}/operator-tasks/${taskId}/reopen`, { method: 'POST', headers });
      load();
    } catch (e) { showError(e.message); }
  };

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-start justify-between mb-4 flex-wrap gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold text-ink">Operator Tasks</h1>
          <p className="text-sm text-muted mt-1">
            Actionable items from the agronomist and planner. Done tells the agent its theory was right; declining with a reason tells it why.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className={selectCls} aria-label="Status">
            <option value="open">Open</option>
            <option value="done">Done</option>
            <option value="declined">Declined</option>
            <option value="snoozed">Snoozed</option>
            <option value="all">All</option>
          </select>
          <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)} className={selectCls} aria-label="Source">
            <option value="all">All sources</option>
            <option value="agronomist">Agronomist</option>
            <option value="planner">Planner</option>
            <option value="watchdog">Watchdog</option>
            <option value="manual">Manual</option>
          </select>
        </div>
      </div>

      {/* Summary + outdated chip */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Label as="p" className="font-mono tabular" data-testid="task-summary">
          {fresh.length.toLocaleString()} current
          <span aria-hidden="true"> · </span>{outdated.length.toLocaleString()} outdated
        </Label>
        <button
          type="button"
          onClick={() => setHideOutdated(v => !v)}
          aria-pressed={hideOutdated}
          data-testid="hide-outdated"
          className={`inline-flex items-center gap-1.5 min-h-[36px] px-3 rounded-full border text-xs font-semibold transition-colors ${
            hideOutdated
              ? 'bg-caution-50 dark:bg-caution-900/40 border-caution-400 text-caution-700 dark:text-caution-300'
              : 'bg-panel border-line text-muted hover:bg-field'
          }`}
          title={`Open tasks created more than ${OUTDATED_DAYS} days ago are treated as outdated`}
        >
          <span aria-hidden="true" className={`inline-block w-2 h-2 border-2 border-state-caution ${hideOutdated ? 'bg-state-caution' : 'bg-transparent'}`} style={{ clipPath: 'polygon(50% 0, 100% 100%, 0 100%)' }} />
          Hide outdated{hideOutdated && outdated.length > 0 ? ` (${outdated.length.toLocaleString()} hidden)` : ''}
        </button>
      </div>

      {loading ? (
        <div className="text-sm text-muted py-8 text-center">Loading…</div>
      ) : rendered.length === 0 ? (
        <Card className="text-center text-sm text-muted py-10">
          {tasks.length === 0
            ? (statusFilter === 'open'
              ? 'No open tasks. The agents will surface new ones as they identify physical interventions or measurements you need to make.'
              : 'No tasks match the current filter.')
            : `All ${outdated.length.toLocaleString()} open tasks are outdated (older than ${OUTDATED_DAYS} days). Turn off "Hide outdated" to review them.`}
        </Card>
      ) : (
        <div className="space-y-3" data-testid="task-list">
          {rendered.map(({ task, days, outdated: stale }) => (
            <TaskCard
              key={task.id}
              task={task}
              outdated={stale}
              ageDays={days}
              canControl={canControl}
              onAction={openAction}
              onReopen={reopen}
              formatDateTime={formatDateTime}
            />
          ))}
        </div>
      )}

      {!loading && remaining > 0 && (
        <div className="mt-4 flex items-center justify-between gap-3 flex-wrap">
          <p className="text-xs text-muted font-mono tabular">Showing {rendered.length} of {visible.length}</p>
          <Button variant="secondary" size="sm" onClick={() => setShown(s => s + PAGE_SIZE)}>
            Load more ({Math.min(PAGE_SIZE, remaining)})
          </Button>
        </div>
      )}

      {/* Action modal */}
      {activeTask && actionMode && (
        <div className="fixed inset-0 bg-gray-900/60 z-50 flex items-end sm:items-center justify-center p-4" role="presentation">
          <div role="dialog" aria-modal="true" className="bg-panel border border-line rounded-card shadow-xl w-full max-w-lg p-4 sm:p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-display text-lg font-semibold text-ink">
                {actionMode === 'complete' && 'Mark as done'}
                {actionMode === 'decline' && 'Decline task'}
                {actionMode === 'snooze' && 'Snooze task'}
              </h3>
              <Button variant="ghost" size="sm" onClick={closeAction} aria-label="Close">✕</Button>
            </div>
            <p className="text-sm text-muted mb-4 italic">"{activeTask.title}"</p>

            {actionMode === 'complete' && (
              <>
                <Label as="label" className="mb-1">
                  Completion notes <span className="normal-case tracking-normal font-normal">(optional — confirms or refines the agent's theory)</span>
                </Label>
                <textarea rows={4} value={actionText} onChange={e => setActionText(e.target.value)}
                  placeholder={activeTask.expected_outcome ? `Expected: ${activeTask.expected_outcome}\nObserved: ` : 'What you did and what you observed...'}
                  className={fieldCls} />
              </>
            )}

            {actionMode === 'decline' && (
              <>
                <Label as="label" className="mb-1">
                  Decline reason <span className="text-alarm-600">*</span>
                  <span className="normal-case tracking-normal font-normal ml-1">(required — the agent uses this to update its theory)</span>
                </Label>
                <textarea rows={4} value={actionText} onChange={e => setActionText(e.target.value)}
                  placeholder="e.g. Tank 1 was already verified by lab on 2026-05-23 at 19,200 mg/L Ca — the concentration is correct, the issue must be elsewhere."
                  className={fieldCls} />
              </>
            )}

            {actionMode === 'snooze' && (
              <>
                <Label as="label" className="mb-1">Snooze until</Label>
                <input type="datetime-local" value={actionDate} onChange={e => setActionDate(e.target.value)} className={fieldCls} />
                <p className="text-xs text-muted mt-2">Snoozed tasks reappear after this time. Use sparingly — the agent will keep noticing the underlying condition.</p>
              </>
            )}

            <div className="mt-4 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
              <Button variant="ghost" onClick={closeAction} disabled={submitting}>Cancel</Button>
              <Button
                variant={actionMode === 'decline' ? 'danger-ghost' : 'primary'}
                onClick={submitAction}
                disabled={submitting}
                className={actionMode === 'decline' ? 'border-line' : ''}
              >
                {submitting ? 'Saving…' : actionMode === 'complete' ? 'Confirm done' : actionMode === 'decline' ? 'Decline with reason' : 'Snooze'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
