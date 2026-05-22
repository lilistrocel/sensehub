import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

const API_BASE = '/api';

const SEVERITY_COLOR = {
  low:    'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-200',
  high:   'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
};

const CHANGE_COLOR = {
  add:    'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-200',
  remove: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  modify: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-200',
  keep:   'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200',
};

const STATUS_COLOR = {
  pending:   'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-200',
  confirmed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-200',
  rejected:  'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  failure:   'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  success:   'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200',
};

const STATUS_LABEL = {
  pending: 'Awaiting decision',
  confirmed: 'Confirmed & applied',
  rejected: 'Rejected',
  failure: 'Generation failed',
  success: 'Generated (legacy)',
};

const VERDICT_COLOR = {
  pass:             'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-200',
  partial:          'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-200',
  fail:             'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  uncomputable:     'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
  no_prior_targets: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
};

function fmtDate(s) {
  if (!s) return '';
  try { return new Date(s.includes('T') ? s : s + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return s; }
}

function fmtDateTime(s) {
  if (!s) return '';
  try { return new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z').toLocaleString(); }
  catch { return s; }
}

function fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${Math.round(v * 1000) / 10}%`;
}

function fmtNum(v, digits = 1) {
  if (v == null || !Number.isFinite(v)) return '—';
  return Number(v).toFixed(digits);
}

const OP_GLYPH = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=', neq: '≠' };

function ProposedAutomationCard({ a, idx, targetLinks, templatesById }) {
  const trig = a.trigger_config || {};
  let triggerLabel = trig.type || 'unknown';
  let triggerStyle = 'bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-200';
  if (trig.type === 'schedule') {
    triggerLabel = `Daily @ ${trig.time || '?'}`;
  } else if (trig.type === 'threshold') {
    const op = OP_GLYPH[trig.operator] || trig.operator || '?';
    const metric = trig.sensor_metric || '?';
    const unit = trig.threshold_unit || '';
    triggerLabel = `${metric} ${op} ${trig.threshold_value}${unit ? ' ' + unit : ''}`;
    triggerStyle = 'bg-rose-100 dark:bg-rose-900 text-rose-700 dark:text-rose-200';
  }

  const tplId = a.template_id || 0;
  const tpl = tplId > 0 && templatesById ? templatesById[tplId] : null;
  const isRaw = tplId === 0;

  return (
    <div className={`border rounded-lg p-4 bg-white dark:bg-gray-800 ${
      isRaw
        ? 'border-amber-300 dark:border-amber-600'
        : 'border-gray-200 dark:border-gray-700'
    }`}>
      <div className="flex items-start justify-between mb-2 gap-2">
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-gray-900 dark:text-white">{a.name}</div>
          {a.description && <div className="text-xs text-gray-600 dark:text-gray-400 mt-1">{a.description}</div>}
        </div>
        <span className={`text-xs px-2 py-0.5 rounded-full ${triggerStyle} whitespace-nowrap font-mono`}>
          {triggerLabel}
        </span>
      </div>
      {/* Template / Raw badge */}
      {tplId > 0 ? (
        <div className="flex items-center gap-1 mb-2 text-[11px]">
          <span className="px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-200 font-semibold">
            via template
          </span>
          <span className="text-gray-700 dark:text-gray-300 font-mono">
            {tpl ? tpl.name : `#${tplId}`}
          </span>
        </div>
      ) : (
        <div className="mb-2">
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-200 font-semibold">
            RAW — no template
          </span>
        </div>
      )}
      {targetLinks && targetLinks.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {targetLinks.map(k => (
            <span key={k} className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-200 font-mono">
              ↦ {k}
            </span>
          ))}
        </div>
      )}
      {a.rationale && (
        <div className="text-xs italic text-gray-600 dark:text-gray-400 border-l-2 border-indigo-300 dark:border-indigo-600 pl-2 my-2">
          {a.rationale}
        </div>
      )}
      {/* Template parameters (when template_id > 0). template_parameters is a JSON string per current schema. */}
      {tplId > 0 && (() => {
        let params = a.template_parameters;
        if (typeof params === 'string') {
          try { params = JSON.parse(params); } catch { params = null; }
        }
        if (!params || typeof params !== 'object') return null;
        const entries = Array.isArray(params)
          ? params.map(p => [p.name, p.value])
          : Object.entries(params);
        if (entries.length === 0) return null;
        return (
          <div className="mt-2">
            <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">Parameters</div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
              {entries.map(([k, v], i) => (
                <div key={i} className="flex items-baseline gap-1.5">
                  <span className="font-mono text-gray-500 dark:text-gray-400">{k}:</span>
                  <span className="font-mono text-gray-900 dark:text-gray-100 truncate">{String(v)}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })()}
      {/* Raw actions (when template_id == 0). actions_json is a JSON string per current schema; fall back to legacy actions[] for older plans. */}
      {tplId === 0 && (() => {
        let acts = [];
        if (typeof a.actions_json === 'string' && a.actions_json.trim()) {
          try { acts = JSON.parse(a.actions_json); } catch { acts = []; }
        } else if (Array.isArray(a.actions)) {
          acts = a.actions;
        }
        if (!Array.isArray(acts) || acts.length === 0) return null;
        return (
        <div className="mt-2">
          <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">Actions</div>
          <ol className="text-xs space-y-1">
            {acts.map((act, i) => (
              <li key={i} className="flex items-baseline gap-2 text-gray-700 dark:text-gray-300">
                <span className="text-gray-400 font-mono">{i + 1}.</span>
                <span className="flex-1">
                  <span className="font-mono text-indigo-700 dark:text-indigo-300">{act.type}</span>
                  {act.action && <span className="ml-1 font-semibold">{act.action.toUpperCase()}</span>}
                  {act.equipment_name && <span className="ml-1">{act.equipment_name}</span>}
                  {act.channel != null && act.channel > 0 && (
                    <span className="ml-1 text-gray-500">
                      ch{act.channel}{act.channel_name ? ` (${act.channel_name})` : ''}
                    </span>
                  )}
                  {act.channel === 0 && act.equipment_name && (
                    <span className="ml-1 text-gray-500">(all channels)</span>
                  )}
                  {act.duration_seconds != null && act.duration_seconds > 0 && (
                    <span className="ml-2 text-gray-500">for {Math.round(act.duration_seconds / 60 * 10) / 10}min</span>
                  )}
                  {act.delay_seconds != null && act.delay_seconds > 0 && (
                    <span className="ml-1 text-gray-500">after {act.delay_seconds}s</span>
                  )}
                  {act.type === 'alert' && act.message && (
                    <span className="ml-1 italic">"{act.message}"</span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </div>
        );
      })()}
    </div>
  );
}

function fmtWindow(t) {
  return t.window || 'all_day';
}

function TargetRow({ target, outcome }) {
  const verdict = outcome?.verdict || 'pending';
  const stats = outcome?.stats;
  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded p-3 bg-white dark:bg-gray-800">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-sm font-semibold text-gray-900 dark:text-gray-100">{target.key}</span>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            [{fmtNum(target.min)} – {fmtNum(target.max)}] · {fmtWindow(target)} · <span className="font-mono">{target.acceptance}</span>
          </span>
        </div>
        {outcome && (
          <span className={`text-xs px-2 py-0.5 rounded font-semibold uppercase ${VERDICT_COLOR[verdict] || VERDICT_COLOR.uncomputable}`}>
            {verdict}
          </span>
        )}
      </div>
      {target.rationale && (
        <div className="text-xs text-gray-600 dark:text-gray-400 mt-1 italic">{target.rationale}</div>
      )}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-1 text-[11px] mt-2 text-gray-700 dark:text-gray-300 font-mono">
          <div>in_range: <span className="font-semibold">{fmtPct(stats.in_range_pct)}</span></div>
          <div>mean: <span className="font-semibold">{fmtNum(stats.mean, 2)}</span></div>
          <div>p10/p90: {fmtNum(stats.p10, 1)} / {fmtNum(stats.p90, 1)}</div>
          <div>excursion: {fmtNum(stats.peak_excursion, 2)}</div>
          <div className="col-span-2">breaches: {stats.breach_episodes} (longest {stats.longest_breach_minutes}min)</div>
          <div className="col-span-2">samples: {outcome.sample_count}</div>
        </div>
      )}
      {outcome?.reason && (
        <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-1">{outcome.reason}</div>
      )}
    </div>
  );
}

function YesterdayReviewCard({ review, fullScorecard, partialScorecard }) {
  if (!review && !fullScorecard && !partialScorecard) return null;
  const grade = review?.overall_grade || fullScorecard?.overall_grade || 'no_prior_targets';
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <h2 className="text-sm uppercase tracking-wide text-gray-500 dark:text-gray-400">Yesterday's review</h2>
        <span className={`text-xs px-2 py-0.5 rounded font-semibold uppercase ${VERDICT_COLOR[grade] || VERDICT_COLOR.uncomputable}`}>
          {grade.replace(/_/g, ' ')}
        </span>
      </div>
      {review?.lessons_learned && (
        <div className="text-sm text-gray-800 dark:text-gray-200 mb-1">{review.lessons_learned}</div>
      )}
      {review?.strategy_adjustments_hypothesis && (
        <div className="text-sm italic text-indigo-700 dark:text-indigo-300 border-l-2 border-indigo-400 pl-2 mt-2 mb-2">
          Hypothesis: {review.strategy_adjustments_hypothesis}
        </div>
      )}
      {Array.isArray(review?.target_outcomes) && review.target_outcomes.length > 0 && (
        <div className="space-y-1.5 mt-3">
          {review.target_outcomes.map((o, i) => (
            <div key={i} className="flex items-start gap-2 text-sm">
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase ${VERDICT_COLOR[o.verdict] || VERDICT_COLOR.uncomputable} shrink-0 mt-0.5`}>
                {o.verdict}
              </span>
              <div className="flex-1 min-w-0">
                <span className="font-mono text-gray-700 dark:text-gray-300">{o.target_key}</span>
                <span className="text-gray-700 dark:text-gray-300 ml-2">{o.observed_summary}</span>
                {o.likely_cause && o.verdict !== 'pass' && (
                  <div className="text-xs text-gray-500 dark:text-gray-400 ml-1">cause: {o.likely_cause}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TargetsCard({ targets, scorecard }) {
  if (!Array.isArray(targets) || targets.length === 0) return null;
  const outcomesByKey = {};
  if (scorecard?.target_outcomes) {
    for (const o of scorecard.target_outcomes) outcomesByKey[o.target_key] = o;
  }
  return (
    <div>
      <div className="flex items-center justify-between mb-2 gap-2">
        <h2 className="text-sm uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Targets for tomorrow ({targets.length})
        </h2>
        {scorecard && (
          <span className="text-[11px] text-gray-500 dark:text-gray-400">
            scorecard preview from {scorecard.cutoff_at ? `partial today` : `full day`}
          </span>
        )}
      </div>
      <div className="space-y-2">
        {targets.map((t, i) => (
          <TargetRow key={i} target={t} outcome={outcomesByKey[t.key]} />
        ))}
      </div>
    </div>
  );
}

function AppliedSummaryCard({ summary, appliedAt }) {
  if (!summary) return null;
  const counts = (k) => Array.isArray(summary[k]) ? summary[k].length : 0;
  return (
    <div className="bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-200 dark:border-emerald-700 rounded p-3">
      <div className="text-sm font-semibold text-emerald-900 dark:text-emerald-200">Confirmed & applied {appliedAt && `at ${fmtDateTime(appliedAt)}`}</div>
      <div className="text-xs text-emerald-800 dark:text-emerald-300 mt-1 font-mono">
        added: {counts('added')} · modified: {counts('modified')} · disabled: {counts('disabled')} · kept: {counts('kept')}
        {counts('errors') > 0 && <span className="ml-2 text-red-700 dark:text-red-300">⚠ errors: {counts('errors')}</span>}
      </div>
      {counts('errors') > 0 && (
        <ul className="text-xs text-red-700 dark:text-red-300 mt-2 list-disc list-inside">
          {summary.errors.map((e, i) => (
            <li key={i}>{e.error}: {e.change?.target || e.change?.change_type}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ConsistencyWarningsCard({ warnings }) {
  if (!Array.isArray(warnings) || warnings.length === 0) return null;
  return (
    <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-300 dark:border-amber-700 rounded p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-amber-700 dark:text-amber-200">⚠</span>
        <div className="text-sm font-semibold text-amber-900 dark:text-amber-200">
          Consistency warnings ({warnings.length}) — the agent's prose disagrees with its structured data
        </div>
      </div>
      <ul className="text-xs space-y-1.5 text-amber-900 dark:text-amber-200">
        {warnings.map((w, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="text-amber-500 mt-0.5">•</span>
            <div className="flex-1">
              {w.kind === 'count_mismatch' && (
                <>
                  <span className="font-mono">{w.field}</span>: prose says <span className="font-semibold">{w.prose_claims}</span>, data says <span className="font-semibold">{w.data_says}</span>
                  {w.context && <span className="block text-amber-700 dark:text-amber-300 italic mt-0.5">"...{w.context}..."</span>}
                </>
              )}
              {w.kind === 'unknown_automation_id' && (
                <>
                  Prose references <span className="font-mono">{w.context}</span> but no live automation has id {w.id}.
                </>
              )}
              {w.kind === 'untracked_automation_id' && (
                <>
                  Prose discusses <span className="font-mono">{w.context}</span> but no diff entry touches automation #{w.id}.
                </>
              )}
              {(w.kind === 'time_range_actual_outside_claim' || w.kind === 'time_range_overstated') && (
                <>
                  <span className="font-mono">{w.subject}</span> time range: prose says <span className="font-semibold">{w.claimed_range}</span>, actual schedule spans <span className="font-semibold">{w.actual_range}</span>
                  {w.hint && <span className="block text-amber-700 dark:text-amber-300 italic mt-0.5">{w.hint}</span>}
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
      <div className="text-xs text-amber-700 dark:text-amber-300 italic mt-2">
        The structured data (proposed_automations + changes_from_today) is the source of truth for Confirm. The prose is informational and may drift.
      </div>
    </div>
  );
}

function RejectionCard({ feedback }) {
  if (!feedback) return null;
  return (
    <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded p-3">
      <div className="text-sm font-semibold text-red-900 dark:text-red-200">Rejected — operator feedback</div>
      <div className="text-sm text-red-800 dark:text-red-200 mt-1 whitespace-pre-wrap">{feedback}</div>
      <div className="text-xs text-red-700 dark:text-red-300 mt-2 italic">A new version of this plan was regenerated addressing this feedback.</div>
    </div>
  );
}

/**
 * PlanDiscussion — non-destructive thread on a plan. Operator posts a question
 * or highlight, planner responds inline with reasoning. Conversation does NOT
 * modify the plan. When the operator decides the open thread warrants a real
 * revision, "Apply open items as regenerate" rejects + regenerates the plan
 * with the full thread converted to feedback.
 */
const VERDICT_BADGE = {
  plan_correct:    { label: 'Plan is correct', cls: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300' },
  concern_valid:   { label: 'Concern is valid', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300' },
  need_more_data:  { label: 'Need more data', cls: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300' },
};

function PlanDiscussion({ planId, planStatus, canControl, headers, showError, showSuccess, onRegenerated }) {
  const [thread, setThread] = useState([]);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState('question');
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/planner/plans/${planId}/clarifications`, { headers });
      if (res.ok) setThread(await res.json());
    } catch (_) {} finally { setLoading(false); }
  };

  useEffect(() => { if (planId) load(); /* eslint-disable-next-line */ }, [planId]);

  const send = async () => {
    const msg = draft.trim();
    if (!msg) return;
    setPosting(true);
    try {
      const res = await fetch(`${API_BASE}/planner/plans/${planId}/clarifications`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ role, message: msg }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        showError(e.error || 'Failed to send clarification');
      } else {
        setDraft('');
        await load();
      }
    } catch (err) { showError(err.message); }
    finally { setPosting(false); }
  };

  const openItems = thread.filter(t => t.status === 'open');
  const hasOpen = openItems.length > 0;

  const regenerate = async () => {
    if (!confirm(`Convert ${openItems.length} open clarification(s) into a rejection feedback and regenerate the plan?`)) return;
    setRegenerating(true);
    try {
      const res = await fetch(`${API_BASE}/planner/plans/${planId}/clarifications/regenerate`, {
        method: 'POST', headers,
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        showError(e.error || 'Failed to regenerate');
      } else {
        const data = await res.json();
        showSuccess('Plan rejected and regenerated from clarifications');
        if (data.regenerated?.id && onRegenerated) onRegenerated(data.regenerated.id);
      }
    } catch (err) { showError(err.message); }
    finally { setRegenerating(false); }
  };

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
        <div>
          <div className="font-semibold text-gray-900 dark:text-gray-100">Discussion</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">
            Ask the planner to explain a decision, or highlight something it may have missed. Conversation only — won't modify the plan unless you convert it to a regenerate.
          </div>
        </div>
        {hasOpen && canControl && planStatus === 'pending' && (
          <button
            onClick={regenerate}
            disabled={regenerating}
            className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 disabled:opacity-60 text-white text-xs rounded-md whitespace-nowrap"
            title="Bundle all open clarifications as rejection feedback and regenerate the plan"
          >
            {regenerating ? 'Regenerating…' : `Apply ${openItems.length} open as regenerate`}
          </button>
        )}
      </div>

      <div className="divide-y divide-gray-100 dark:divide-gray-700">
        {loading ? (
          <div className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">Loading…</div>
        ) : thread.length === 0 ? (
          <div className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 italic">No clarifications on this plan yet.</div>
        ) : (
          thread.map(c => {
            const verdict = c.response_verdict ? VERDICT_BADGE[c.response_verdict] : null;
            return (
              <div key={c.id} className="px-4 py-3">
                <div className="flex items-start gap-2 mb-1">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide ${
                    c.role === 'highlight'
                      ? 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300'
                      : 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300'
                  }`}>
                    {c.role === 'highlight' ? '⚠ Highlight' : '💬 Question'}
                  </span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {c.user_name || 'operator'} · {fmtDateTime(c.created_at)}
                  </span>
                  {c.status === 'addressed' && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300">
                      addressed{c.addressed_by_plan_id ? ` (→ plan #${c.addressed_by_plan_id})` : ''}
                    </span>
                  )}
                </div>
                <div className="text-sm text-gray-900 dark:text-gray-100 whitespace-pre-wrap pl-2 border-l-2 border-gray-200 dark:border-gray-700">
                  {c.message}
                </div>
                {c.planner_response && (
                  <div className="mt-2 ml-3 pl-3 border-l-2 border-primary-300 dark:border-primary-700 bg-gray-50 dark:bg-gray-900/40 rounded-r py-2 pr-2">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase bg-primary-100 text-primary-800 dark:bg-primary-900/30 dark:text-primary-300">
                        Planner
                      </span>
                      {verdict && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${verdict.cls}`}>
                          {verdict.label}
                        </span>
                      )}
                      <span className="text-xs text-gray-500 dark:text-gray-400">{fmtDateTime(c.responded_at)}</span>
                    </div>
                    <div className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap">{c.planner_response}</div>
                  </div>
                )}
                {!c.planner_response && c.responded_at == null && (
                  <div className="text-xs text-gray-400 italic mt-1">waiting for planner…</div>
                )}
              </div>
            );
          })
        )}
      </div>

      {canControl && (
        <div className="px-4 py-3 border-t border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40">
          <div className="flex items-center gap-2 mb-2">
            <label className="text-xs font-medium text-gray-700 dark:text-gray-300">Type:</label>
            <button
              onClick={() => setRole('question')}
              className={`px-2 py-1 text-xs rounded ${
                role === 'question'
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-blue-700 border border-blue-300 hover:bg-blue-50 dark:bg-gray-800 dark:text-blue-300 dark:border-blue-700'
              }`}>
              💬 Question
            </button>
            <button
              onClick={() => setRole('highlight')}
              className={`px-2 py-1 text-xs rounded ${
                role === 'highlight'
                  ? 'bg-orange-600 text-white'
                  : 'bg-white text-orange-700 border border-orange-300 hover:bg-orange-50 dark:bg-gray-800 dark:text-orange-300 dark:border-orange-700'
              }`}>
              ⚠ Highlight
            </button>
            <span className="text-xs text-gray-500 dark:text-gray-400 ml-2 italic">
              {role === 'highlight'
                ? 'You believe the plan missed something — planner will acknowledge and propose adjustments.'
                : 'You want the planner to explain its reasoning — no plan change.'}
            </span>
          </div>
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder={role === 'highlight'
              ? 'e.g. "VWC peaks at 60% on Sensor 1 during all 3 irrigations — too aggressive?"'
              : 'e.g. "Why 3 fertigation cycles instead of 2? What\'s the rationale for the 12:00 timing?"'}
            rows={3}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-800 dark:text-white"
          />
          <div className="mt-2 flex justify-end">
            <button
              onClick={send}
              disabled={posting || !draft.trim()}
              className="px-4 py-1.5 bg-primary-600 hover:bg-primary-700 disabled:opacity-50 text-white text-sm rounded-md"
            >
              {posting ? 'Sending…' : 'Send to planner'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Planner() {
  const { token, user } = useAuth();
  const { showError, showSuccess } = useToast();
  const isAdmin = user?.role === 'admin';
  const canControl = isAdmin || user?.role === 'operator';

  const [plans, setPlans] = useState([]);
  const [selected, setSelected] = useState(null);
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showRawSnapshot, setShowRawSnapshot] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [rejectFeedback, setRejectFeedback] = useState('');

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const fetchPlans = async (selectId = null) => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/planner/plans?limit=60`, { headers });
      if (res.ok) {
        const list = await res.json();
        setPlans(list);
        if (selectId) {
          loadPlan(selectId);
        } else if (list.length > 0 && !selected) {
          const first = list.find(p => p.status === 'pending')
            || list.find(p => p.status === 'confirmed')
            || list[0];
          if (first) loadPlan(first.id);
        }
      }
    } catch (err) {
      showError('Failed to load plans: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const loadPlan = async (id) => {
    try {
      const res = await fetch(`${API_BASE}/planner/plans/${id}`, { headers });
      if (res.ok) setSelected(await res.json());
    } catch (err) {
      showError('Failed to load plan: ' + err.message);
    }
  };

  const fetchConfig = async () => {
    try {
      const res = await fetch(`${API_BASE}/planner/config`, { headers });
      if (res.ok) setConfig(await res.json());
    } catch (err) {
      // non-fatal
    }
  };

  useEffect(() => { fetchPlans(); fetchConfig(); /* eslint-disable-next-line */ }, []);

  const saveConfig = async () => {
    try {
      const res = await fetch(`${API_BASE}/planner/config`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          enabled: config.enabled,
          schedule_hour: config.schedule_hour,
          schedule_minute: config.schedule_minute,
        }),
      });
      if (res.ok) {
        showSuccess('Planner config saved');
        const updated = await res.json();
        setConfig(updated);
        setShowSettings(false);
      } else {
        const data = await res.json().catch(() => ({}));
        showError(data.error || 'Failed to save config');
      }
    } catch (err) {
      showError(err.message);
    }
  };

  const generateNow = async (force = false) => {
    if (!canControl) return;
    setGenerating(true);
    try {
      const res = await fetch(`${API_BASE}/planner/generate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ force }),
      });
      if (res.ok) {
        const data = await res.json();
        showSuccess('Plan generated for tomorrow');
        await fetchPlans(data.plan?.id);
      } else {
        const data = await res.json().catch(() => ({}));
        if (data.code === 'ALREADY_EXISTS') {
          if (window.confirm('A pending plan already exists for tomorrow. Regenerate (replaces it)?')) {
            return generateNow(true);
          }
        } else {
          showError(data.error || 'Generation failed');
        }
      }
    } catch (err) {
      showError(err.message);
    } finally {
      setGenerating(false);
    }
  };

  const confirmPlan = async () => {
    if (!canControl || !selected) return;
    if (!window.confirm('Confirm this plan and apply it to live automations? This will INSERT/UPDATE/DISABLE automations per the diff manifest.')) return;
    setConfirming(true);
    try {
      const res = await fetch(`${API_BASE}/planner/plans/${selected.id}/confirm`, { method: 'POST', headers });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        showSuccess('Plan confirmed — automations updated.');
        const errors = data.applied_summary?.errors?.length || 0;
        if (errors > 0) showError(`${errors} change(s) failed — see details on plan.`);
        await fetchPlans(selected.id);
      } else {
        showError(data.error || 'Confirm failed');
      }
    } catch (err) {
      showError(err.message);
    } finally {
      setConfirming(false);
    }
  };

  const submitReject = async () => {
    if (!canControl || !selected) return;
    const fb = (rejectFeedback || '').trim();
    if (!fb) {
      showError('Provide feedback so the planner can regenerate addressing your concerns.');
      return;
    }
    setRejecting(true);
    try {
      const res = await fetch(`${API_BASE}/planner/plans/${selected.id}/reject`, {
        method: 'POST', headers,
        body: JSON.stringify({ feedback: fb }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        showSuccess('Plan rejected — regenerating with feedback.');
        setShowReject(false);
        setRejectFeedback('');
        await fetchPlans(data.regenerated?.id);
      } else {
        showError(data.error || 'Reject failed');
      }
    } catch (err) {
      showError(err.message);
    } finally {
      setRejecting(false);
    }
  };

  const deletePlan = async (id) => {
    if (!isAdmin) return;
    if (!window.confirm('Delete this plan? Confirmed plans should NOT normally be deleted; this only removes the record, not the applied automations.')) return;
    try {
      const res = await fetch(`${API_BASE}/planner/plans/${id}`, { method: 'DELETE', headers });
      if (res.ok) {
        showSuccess('Plan deleted');
        setSelected(null);
        await fetchPlans();
      }
    } catch (err) {
      showError(err.message);
    }
  };

  const plan = selected?.proposed_plan;
  const snapshot = selected?.input_snapshot || {};
  const tokenUsage = useMemo(() => {
    if (!selected) return null;
    const t = selected;
    return {
      input: t.input_tokens || 0, output: t.output_tokens || 0,
      cache_read: t.cache_read_tokens || 0, cache_creation: t.cache_creation_tokens || 0,
    };
  }, [selected]);

  // Build idx → target.key links for proposed_automations
  const targetLinksByIndex = useMemo(() => {
    if (!plan?.targets) return {};
    const m = {};
    for (const t of plan.targets) {
      for (const i of (t.owner_automation_indexes || [])) {
        if (!m[i]) m[i] = [];
        m[i].push(t.key);
      }
    }
    return m;
  }, [plan]);

  // Templates lookup for rendering template-based automations
  const templatesById = useMemo(() => {
    const list = snapshot?.templates || [];
    const m = {};
    for (const t of list) m[t.id] = t;
    return m;
  }, [snapshot]);

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      <div className="flex items-start justify-between mb-4 gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Operational Planner</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            AI-generated automation plan for the next day, with closed-loop scoring against the prior day's targets. Plans require operator Confirm to apply.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canControl && (
            <button
              onClick={() => generateNow(false)}
              disabled={generating}
              className="px-3 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded disabled:opacity-50"
            >
              {generating ? 'Generating…' : 'Generate plan for tomorrow'}
            </button>
          )}
          {isAdmin && (
            <button
              onClick={() => setShowSettings(true)}
              className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-200"
            >
              Settings
            </button>
          )}
        </div>
      </div>

      {/* Config quick status */}
      {config && (
        <div className="mb-4 text-xs text-gray-600 dark:text-gray-400">
          {config.enabled
            ? <>Scheduler ON — fires daily at <span className="font-mono">{String(config.schedule_hour).padStart(2,'0')}:{String(config.schedule_minute).padStart(2,'0')}</span>.</>
            : <>Scheduler OFF — enable in Settings to auto-generate plans nightly.</>}
          {!config.api_key_present && <span className="ml-2 text-red-600 dark:text-red-300">⚠ ANTHROPIC_API_KEY not set</span>}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)] gap-4">
        {/* Plan list */}
        <aside className="lg:border-r lg:border-gray-200 dark:lg:border-gray-700 lg:pr-3">
          <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">Plans</div>
          {loading && <div className="text-sm text-gray-500">Loading…</div>}
          {!loading && plans.length === 0 && (
            <div className="text-sm text-gray-500 dark:text-gray-400">No plans yet.</div>
          )}
          <div className="space-y-1 max-h-[70vh] overflow-y-auto">
            {plans.map(p => (
              <button
                key={p.id}
                onClick={() => loadPlan(p.id)}
                className={`w-full text-left px-2 py-1.5 rounded text-sm transition-colors ${
                  selected?.id === p.id
                    ? 'bg-indigo-100 dark:bg-indigo-900 text-indigo-900 dark:text-indigo-100'
                    : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium">{fmtDate(p.plan_date)}</div>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase ${STATUS_COLOR[p.status] || STATUS_COLOR.success}`}>
                    {p.status}
                  </span>
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                  {p.headline || (p.status === 'failure' ? '⚠ failed' : '—')}
                  {p.version > 1 && <span className="ml-1 font-mono">v{p.version}</span>}
                </div>
              </button>
            ))}
          </div>
        </aside>

        {/* Plan detail */}
        <main>
          {!selected && !loading && (
            <div className="text-sm text-gray-500 dark:text-gray-400 p-8 text-center border border-dashed border-gray-300 dark:border-gray-700 rounded">
              Select a plan or generate one for tomorrow.
            </div>
          )}

          {selected?.status === 'failure' && (
            <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded p-4 mb-4">
              <div className="font-semibold text-red-800 dark:text-red-200">Plan generation failed</div>
              <div className="text-sm mt-1 text-red-700 dark:text-red-300">{selected.error}</div>
            </div>
          )}

          {selected && plan && selected.status !== 'failure' && (
            <div className="space-y-5">
              {/* Header */}
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="text-lg font-semibold text-gray-900 dark:text-white">
                      Plan for {fmtDate(selected.plan_date)}
                    </div>
                    {selected.version > 1 && (
                      <span className="text-xs px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 font-mono">v{selected.version}</span>
                    )}
                    <span className={`text-xs px-2 py-0.5 rounded font-semibold uppercase ${STATUS_COLOR[selected.status] || STATUS_COLOR.success}`}>
                      {STATUS_LABEL[selected.status] || selected.status}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    Generated {fmtDateTime(selected.generated_at)} · {selected.model}
                  </div>
                </div>
                <p className="text-base text-gray-900 dark:text-gray-100 mt-1">{plan.headline}</p>
                <p className="text-sm text-gray-700 dark:text-gray-300 mt-2 italic">{plan.summary}</p>
                {tokenUsage && (
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-3 font-mono">
                    tokens: in {tokenUsage.input.toLocaleString()} · out {tokenUsage.output.toLocaleString()}
                    {tokenUsage.cache_read > 0 && ` · cache hit ${tokenUsage.cache_read.toLocaleString()}`}
                  </div>
                )}

                {/* Confirm/Reject action bar */}
                {selected.status === 'pending' && canControl && (
                  <div className="mt-4 flex gap-2 flex-wrap border-t border-gray-200 dark:border-gray-700 pt-3">
                    <button
                      onClick={confirmPlan}
                      disabled={confirming || rejecting}
                      className="px-4 py-1.5 text-sm bg-emerald-600 hover:bg-emerald-700 text-white rounded disabled:opacity-50"
                    >
                      {confirming ? 'Applying…' : 'Confirm & Apply'}
                    </button>
                    <button
                      onClick={() => { setRejectFeedback(''); setShowReject(true); }}
                      disabled={confirming || rejecting}
                      className="px-4 py-1.5 text-sm bg-red-600 hover:bg-red-700 text-white rounded disabled:opacity-50"
                    >
                      Reject…
                    </button>
                    <div className="text-xs text-gray-500 dark:text-gray-400 self-center ml-2">
                      Confirm applies the diff manifest to live automations. Reject lets you give feedback and regenerate.
                    </div>
                  </div>
                )}
              </div>

              {/* Consistency warnings (prose vs structured data) */}
              <ConsistencyWarningsCard warnings={selected.consistency_warnings} />

              {/* Confirmed banner */}
              {selected.status === 'confirmed' && (
                <AppliedSummaryCard summary={selected.applied_summary} appliedAt={selected.applied_at} />
              )}

              {/* Rejected banner */}
              {selected.status === 'rejected' && (
                <RejectionCard feedback={selected.rejection_feedback} />
              )}

              {/* Non-destructive Q&A with the planner — operator asks questions or
                  flags concerns; planner responds with reasoning. No plan changes. */}
              <PlanDiscussion
                planId={selected.id}
                planStatus={selected.status}
                canControl={canControl}
                headers={headers}
                showError={showError}
                showSuccess={showSuccess}
                onRegenerated={(newPlanId) => fetchPlans(newPlanId)}
              />


              {/* Yesterday review (from agent) + scorecard cards (from input snapshot) */}
              <YesterdayReviewCard
                review={plan.yesterday_review}
                fullScorecard={snapshot.yesterday_full_scorecard}
                partialScorecard={snapshot.today_partial_scorecard}
              />

              {/* Targets for tomorrow */}
              <TargetsCard targets={plan.targets} scorecard={null} />

              {/* Template requests (agent flagging missing templates) */}
              {Array.isArray(plan.template_requests) && plan.template_requests.length > 0 && (
                <div>
                  <h2 className="text-sm uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">
                    Template requests from the planner ({plan.template_requests.length})
                  </h2>
                  <div className="space-y-2">
                    {plan.template_requests.map((tr, i) => (
                      <div key={i} className="border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 rounded p-3">
                        <div className="font-semibold text-amber-900 dark:text-amber-200">{tr.proposed_name}</div>
                        <div className="text-sm text-amber-900 dark:text-amber-200 mt-1">{tr.purpose}</div>
                        <div className="text-xs text-amber-800 dark:text-amber-300 mt-1 font-mono">Parameters: {tr.parameters_needed}</div>
                        {tr.example_use && (
                          <div className="text-xs text-amber-700 dark:text-amber-300 italic mt-1">e.g. {tr.example_use}</div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Risks */}
              {Array.isArray(plan.risks) && plan.risks.length > 0 && (
                <div>
                  <h2 className="text-sm uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">Risks flagged for operator</h2>
                  <div className="space-y-2">
                    {plan.risks.map((r, i) => (
                      <div key={i} className="border border-gray-200 dark:border-gray-700 rounded p-3 bg-white dark:bg-gray-800">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`text-xs px-2 py-0.5 rounded font-semibold uppercase ${SEVERITY_COLOR[r.severity] || SEVERITY_COLOR.low}`}>
                            {r.severity}
                          </span>
                          <span className="font-medium text-gray-900 dark:text-gray-100">{r.risk}</span>
                        </div>
                        <div className="text-sm text-gray-600 dark:text-gray-400 ml-1">→ {r.suggested_human_action}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Changes from today */}
              {Array.isArray(plan.changes_from_today) && plan.changes_from_today.length > 0 && (
                <div>
                  <h2 className="text-sm uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">Changes from today's operations (apply manifest)</h2>
                  <div className="space-y-2">
                    {plan.changes_from_today.map((c, i) => (
                      <div key={i} className="flex items-start gap-2 border-l-2 border-gray-200 dark:border-gray-700 pl-3 py-1">
                        <span className={`text-xs px-2 py-0.5 rounded font-semibold uppercase ${CHANGE_COLOR[c.change_type] || CHANGE_COLOR.keep}`}>
                          {c.change_type}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                            {c.target}
                            {c.current_automation_id ? <span className="ml-1">[id {c.current_automation_id}]</span> : null}
                            {c.proposed_automation_index >= 0 ? <span className="ml-1">[→ proposed #{c.proposed_automation_index}]</span> : null}
                          </div>
                          <div className="text-sm text-gray-900 dark:text-gray-100">{c.detail}</div>
                          <div className="text-xs text-gray-600 dark:text-gray-400 italic mt-0.5">{c.rationale}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Proposed automations */}
              <div>
                <h2 className="text-sm uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">
                  Proposed automations ({Array.isArray(plan.proposed_automations) ? plan.proposed_automations.length : 0})
                </h2>
                {Array.isArray(plan.proposed_automations) && plan.proposed_automations.length > 0 ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {plan.proposed_automations.map((a, i) => (
                      <ProposedAutomationCard key={i} a={a} idx={i} targetLinks={targetLinksByIndex[i] || []} templatesById={templatesById} />
                    ))}
                  </div>
                ) : (
                  <div className="text-sm text-gray-500 dark:text-gray-400 p-3 border border-dashed border-gray-300 dark:border-gray-700 rounded">
                    No automations proposed.
                  </div>
                )}
              </div>

              {/* Raw snapshot toggle */}
              <div>
                <button
                  onClick={() => setShowRawSnapshot(s => !s)}
                  className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
                >
                  {showRawSnapshot ? 'Hide' : 'Show'} raw input snapshot &amp; plan JSON
                </button>
                {showRawSnapshot && (
                  <div className="mt-2 space-y-3">
                    <details className="border border-gray-200 dark:border-gray-700 rounded">
                      <summary className="px-3 py-2 cursor-pointer text-sm font-medium">Input snapshot (fed to the planner)</summary>
                      <pre className="text-xs p-3 overflow-x-auto bg-gray-50 dark:bg-gray-900 max-h-96 overflow-y-auto">{JSON.stringify(selected.input_snapshot, null, 2)}</pre>
                    </details>
                    <details className="border border-gray-200 dark:border-gray-700 rounded">
                      <summary className="px-3 py-2 cursor-pointer text-sm font-medium">Full plan JSON</summary>
                      <pre className="text-xs p-3 overflow-x-auto bg-gray-50 dark:bg-gray-900 max-h-96 overflow-y-auto">{JSON.stringify(plan, null, 2)}</pre>
                    </details>
                  </div>
                )}
              </div>

              {/* Delete */}
              {isAdmin && (
                <div className="text-right">
                  <button
                    onClick={() => deletePlan(selected.id)}
                    className="text-xs text-red-600 dark:text-red-400 hover:underline"
                  >
                    Delete this plan record
                  </button>
                </div>
              )}
            </div>
          )}
        </main>
      </div>

      {/* Reject modal */}
      {showReject && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl max-w-lg w-full p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Reject plan with feedback</h3>
              <button onClick={() => setShowReject(false)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
              Describe what should change. The planner will regenerate addressing your feedback. Example: <span className="italic">"You shifted irrigation too early — the morning dry-down is fine. Focus on the afternoon dip instead."</span>
            </p>
            <textarea
              autoFocus
              rows={6}
              value={rejectFeedback}
              onChange={e => setRejectFeedback(e.target.value)}
              placeholder="What did the plan miss or get wrong?"
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded resize-y"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setShowReject(false)}
                disabled={rejecting}
                className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded text-gray-700 dark:text-gray-200 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={submitReject}
                disabled={rejecting || !rejectFeedback.trim()}
                className="px-3 py-1.5 text-sm bg-red-600 hover:bg-red-700 text-white rounded disabled:opacity-50"
              >
                {rejecting ? 'Regenerating…' : 'Reject & Regenerate'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Settings modal */}
      {showSettings && config && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl max-w-md w-full p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Planner settings</h3>
              <button onClick={() => setShowSettings(false)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <div className="space-y-4">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={!!config.enabled}
                  onChange={e => setConfig(c => ({ ...c, enabled: e.target.checked }))}
                />
                <span className="text-sm text-gray-700 dark:text-gray-200">Scheduler enabled (auto-generate plan every evening)</span>
              </label>
              <div className="flex gap-2 items-center">
                <span className="text-sm text-gray-700 dark:text-gray-200 w-24">Fires at</span>
                <input
                  type="number" min="0" max="23"
                  value={config.schedule_hour}
                  onChange={e => setConfig(c => ({ ...c, schedule_hour: parseInt(e.target.value) || 0 }))}
                  className="w-16 px-2 py-1 border border-gray-300 dark:border-gray-600 dark:bg-gray-800 rounded text-sm"
                />
                <span>:</span>
                <input
                  type="number" min="0" max="59"
                  value={config.schedule_minute}
                  onChange={e => setConfig(c => ({ ...c, schedule_minute: parseInt(e.target.value) || 0 }))}
                  className="w-16 px-2 py-1 border border-gray-300 dark:border-gray-600 dark:bg-gray-800 rounded text-sm"
                />
                <span className="text-xs text-gray-500">(local time, 24h)</span>
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 border-t border-gray-200 dark:border-gray-700 pt-3">
                Scheduled plans are saved as <span className="font-mono">pending</span>. An operator must Confirm or Reject — the scheduler never auto-applies changes to live automations.
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setShowSettings(false)}
                className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded text-gray-700 dark:text-gray-200"
              >
                Cancel
              </button>
              <button
                onClick={saveConfig}
                className="px-3 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
