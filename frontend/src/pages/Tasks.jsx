/**
 * Tasks page — the human-in-the-loop surface for AI agents.
 *
 * Lists agronomist/planner/manual operator_tasks with confirm + decline +
 * snooze actions. Confirmation notes + decline reasons feed back into the
 * next agent run so its mental model updates from operator feedback.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useSettings } from '../context/SettingsContext';

const API_BASE = '/api';

const PRIORITY_COLOR = {
  critical: 'bg-red-100 text-red-800 border-red-300 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700',
  high:     'bg-orange-100 text-orange-800 border-orange-300 dark:bg-orange-900/30 dark:text-orange-300 dark:border-orange-700',
  medium:   'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700',
  low:      'bg-blue-100 text-blue-800 border-blue-300 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700',
};

const CATEGORY_LABEL = {
  physical:      { icon: '🔧', text: 'Physical' },
  measurement:   { icon: '📏', text: 'Measurement' },
  tutorial:      { icon: '📖', text: 'Tutorial' },
  config_change: { icon: '⚙️', text: 'Config change' },
};

const SOURCE_BADGE = {
  agronomist: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
  planner:    'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300',
  manual:     'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200',
  watchdog:   'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
};

const STATUS_BADGE = {
  open:     'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  done:     'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  declined: 'bg-gray-200 text-gray-700 dark:bg-gray-600 dark:text-gray-200',
  snoozed:  'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  archived: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
};

export default function Tasks() {
  const { token, user } = useAuth();
  const { showError, showSuccess } = useToast();
  const { formatDateTime } = useSettings();
  const canControl = user?.role === 'admin' || user?.role === 'operator';

  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('open');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [activeTask, setActiveTask] = useState(null);
  const [actionMode, setActionMode] = useState(null); // 'complete' | 'decline' | 'snooze' | 'view'
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
      if (res.ok) setTasks(await res.json());
    } catch (e) { showError('Failed to load tasks: ' + e.message); }
    finally { setLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, sourceFilter, token]);

  useEffect(() => { load(); }, [load]);

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
        setActiveTask(null);
        setActionMode(null);
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
    <div className="p-4 md:p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Operator Tasks</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Actionable items from the agronomist and planner. Confirming a task tells the agent its theory was right; declining with a reason tells it why.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
            className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 dark:text-white">
            <option value="open">Open</option>
            <option value="done">Done</option>
            <option value="declined">Declined</option>
            <option value="snoozed">Snoozed</option>
            <option value="all">All</option>
          </select>
          <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}
            className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 dark:text-white">
            <option value="all">All sources</option>
            <option value="agronomist">Agronomist</option>
            <option value="planner">Planner</option>
            <option value="watchdog">Watchdog</option>
            <option value="manual">Manual</option>
          </select>
        </div>
      </div>

      {loading ? (
        <div className="text-sm text-gray-500 dark:text-gray-400 py-8 text-center">Loading…</div>
      ) : tasks.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-8 text-center text-gray-500 dark:text-gray-400">
          {statusFilter === 'open' ? 'No open tasks. The agents will surface new ones as they identify physical interventions or measurements you need to make.' : 'No tasks match the current filter.'}
        </div>
      ) : (
        <div className="space-y-3">
          {tasks.map(t => {
            const cat = CATEGORY_LABEL[t.category] || CATEGORY_LABEL.physical;
            const isOpen = t.status === 'open' || t.status === 'snoozed';
            return (
              <div key={t.id}
                className={`bg-white dark:bg-gray-800 rounded-lg shadow border-l-4 ${
                  t.priority === 'critical' ? 'border-l-red-500'
                  : t.priority === 'high' ? 'border-l-orange-500'
                  : t.priority === 'medium' ? 'border-l-amber-500'
                  : 'border-l-blue-500'
                }`}>
                <div className="p-4">
                  <div className="flex items-start justify-between gap-3 mb-2 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="text-xl" title={cat.text}>{cat.icon}</span>
                        <h3 className="text-base font-semibold text-gray-900 dark:text-white">{t.title}</h3>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium uppercase border ${PRIORITY_COLOR[t.priority]}`}>
                          {t.priority}
                        </span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${SOURCE_BADGE[t.source] || SOURCE_BADGE.manual}`}>
                          {t.source}
                        </span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${STATUS_BADGE[t.status] || STATUS_BADGE.open}`}>
                          {t.status}
                        </span>
                      </div>
                      {t.target_entity && (
                        <div className="text-xs text-gray-600 dark:text-gray-400 ml-7 mb-1">
                          Target: <span className="font-mono">{t.target_entity}</span>
                        </div>
                      )}
                      {t.description && (
                        <p className="text-sm text-gray-700 dark:text-gray-300 ml-7 mb-2 whitespace-pre-wrap">{t.description}</p>
                      )}
                      {t.expected_outcome && (
                        <div className="ml-7 mb-2 text-xs text-gray-600 dark:text-gray-400">
                          <span className="font-medium">Expected outcome:</span> {t.expected_outcome}
                        </div>
                      )}
                      {t.instructions && (
                        <details className="ml-7 mb-1">
                          <summary className="cursor-pointer text-xs text-primary-600 dark:text-primary-400 hover:underline">View instructions</summary>
                          <div className="mt-1 text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap bg-gray-50 dark:bg-gray-900/50 rounded p-2 border border-gray-200 dark:border-gray-700">
                            {t.instructions}
                          </div>
                        </details>
                      )}
                      <div className="text-[10px] text-gray-400 ml-7 mt-2">
                        Created {formatDateTime ? formatDateTime(t.created_at) : t.created_at}
                        {t.snoozed_until && ` · snoozed until ${formatDateTime ? formatDateTime(t.snoozed_until) : t.snoozed_until}`}
                        {t.completed_at && ` · ${t.status === 'declined' ? 'declined' : 'done'} ${formatDateTime ? formatDateTime(t.completed_at) : t.completed_at}${t.completed_by_email ? ' by ' + t.completed_by_email : ''}`}
                      </div>
                      {t.completion_notes && (
                        <div className="ml-7 mt-2 text-xs bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded p-2 text-green-900 dark:text-green-200">
                          <span className="font-medium">Completion notes:</span> {t.completion_notes}
                        </div>
                      )}
                      {t.decline_reason && (
                        <div className="ml-7 mt-2 text-xs bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded p-2 text-amber-900 dark:text-amber-200">
                          <span className="font-medium">Decline reason (fed back to agent):</span> {t.decline_reason}
                        </div>
                      )}
                    </div>
                    {canControl && (
                      <div className="flex flex-col gap-1 shrink-0">
                        {isOpen ? (
                          <>
                            <button onClick={() => openAction(t, 'complete')}
                              className="px-3 py-1.5 text-xs bg-green-600 hover:bg-green-700 text-white rounded">
                              ✓ Done
                            </button>
                            <button onClick={() => openAction(t, 'decline')}
                              className="px-3 py-1.5 text-xs bg-gray-100 hover:bg-gray-200 text-gray-800 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-gray-200 rounded">
                              Decline…
                            </button>
                            {t.status !== 'snoozed' && (
                              <button onClick={() => openAction(t, 'snooze')}
                                className="px-3 py-1.5 text-xs bg-purple-100 hover:bg-purple-200 text-purple-800 dark:bg-purple-900/30 dark:hover:bg-purple-900/50 dark:text-purple-300 rounded">
                                Snooze…
                              </button>
                            )}
                          </>
                        ) : (
                          <button onClick={() => reopen(t.id)}
                            className="px-3 py-1.5 text-xs bg-gray-100 hover:bg-gray-200 text-gray-800 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-gray-200 rounded">
                            Reopen
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Action modal */}
      {activeTask && actionMode && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-full max-w-lg p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                {actionMode === 'complete' && '✓ Mark as done'}
                {actionMode === 'decline' && 'Decline task'}
                {actionMode === 'snooze' && 'Snooze task'}
              </h3>
              <button onClick={() => setActiveTask(null)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <p className="text-sm text-gray-700 dark:text-gray-300 mb-4 italic">"{activeTask.title}"</p>

            {actionMode === 'complete' && (
              <>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-200 mb-1">
                  Completion notes <span className="text-gray-400">(optional but useful — confirms or refines the agent's theory)</span>
                </label>
                <textarea rows={4} value={actionText} onChange={e => setActionText(e.target.value)}
                  placeholder={activeTask.expected_outcome ? `Expected: ${activeTask.expected_outcome}\nObserved: ` : 'What you did and what you observed...'}
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 dark:text-white" />
              </>
            )}

            {actionMode === 'decline' && (
              <>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-200 mb-1">
                  Decline reason <span className="text-red-600">*</span>
                  <span className="text-gray-400 ml-1 font-normal">(required — the agent uses this to update its theory)</span>
                </label>
                <textarea rows={4} value={actionText} onChange={e => setActionText(e.target.value)}
                  placeholder="e.g. Tank 1 was already verified by lab on 2026-05-23 at 19,200 mg/L Ca — the concentration is correct, the issue must be elsewhere."
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 dark:text-white" />
              </>
            )}

            {actionMode === 'snooze' && (
              <>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-200 mb-1">Snooze until</label>
                <input type="datetime-local" value={actionDate} onChange={e => setActionDate(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 dark:text-white" />
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">Snoozed tasks reappear after this time. Use sparingly — the agent will keep noticing the underlying condition.</p>
              </>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setActiveTask(null)}
                className="px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded">
                Cancel
              </button>
              <button onClick={submitAction} disabled={submitting}
                className={`px-4 py-1.5 text-sm text-white rounded font-medium disabled:opacity-60 ${
                  actionMode === 'decline' ? 'bg-red-600 hover:bg-red-700'
                  : actionMode === 'snooze' ? 'bg-purple-600 hover:bg-purple-700'
                  : 'bg-green-600 hover:bg-green-700'
                }`}>
                {submitting ? 'Saving…' : actionMode === 'complete' ? '✓ Confirm done' : actionMode === 'decline' ? 'Decline with reason' : 'Snooze'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
