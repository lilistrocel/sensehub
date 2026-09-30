import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useFormat } from '../i18n/useFormat';
import { Card, Label, Button, StatusPill, ProvenanceBadge } from '../ui';
import ConfirmDialog from '../components/ConfirmDialog';
import FailureBanner, { classifyPlanError, leadingFailureRun } from '../components/planner/FailureBanner';

/**
 * Operational planner. i18n: chrome in locales/<lng>/planner.json. Plan text
 * (headline, summary, rationales, risks, targets, discussion replies) is
 * AI-generated English and is never passed through t(); guardrail names and
 * descriptions come from the server. Confirm / reject / override logic is
 * unchanged by the translation (labels only).
 */
const API_BASE = '/api';

const STATUS_PILL = {
  pending:   { state: 'caution', filled: true },
  confirmed: { state: 'ok', filled: true },
  rejected:  { state: 'idle', filled: true },
  failure:   { state: 'alarm', filled: false },
  success:   { state: 'water', filled: false },
};

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

// Long status words: planner:statusLabel.<status>; list pill: planner:statusShort.<status>.
const STATUS_KEYS = ['pending', 'confirmed', 'rejected', 'failure', 'success'];

const VERDICT_COLOR = {
  pass:             'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-200',
  partial:          'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-200',
  fail:             'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  uncomputable:     'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
  no_prior_targets: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
};

// plan_date is a calendar day (YYYY-MM-DD): format it at noon UTC in UTC so the
// weekday never shifts with the timezone. Timestamps (SQLite UTC) go through
// fmt.dateTime in the farm timezone.
function fmtDate(fmt, s) {
  if (!s) return '';
  const iso = String(s).includes('T') ? String(s) : `${s}T12:00:00Z`;
  return fmt.date(iso, { weekday: 'short', timeZone: 'UTC', fallback: String(s) });
}

function fmtDateTime(fmt, s) {
  if (!s) return '';
  return fmt.dateTime(s, { fallback: String(s) });
}

function fmtPct(fmt, v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return fmt.percent(v * 100, { decimals: 1 });
}

function fmtNum(fmt, v, digits = 1) {
  if (v == null || !Number.isFinite(v)) return '—';
  return fmt.number(v, { decimals: digits, grouping: false });
}

// Duty % as the server sent it (whole numbers stay whole, "12.5" keeps its decimal).
function dutyPct(fmt, v) {
  const n = Number(v);
  if (v == null || !Number.isFinite(n)) return '—';
  return fmt.percent(n, { decimals: Number.isInteger(n) ? 0 : 1 });
}

const onOffWord = (t, action) => {
  const a = String(action || '').toLowerCase();
  if (a === 'on') return t('common:status.on');
  if (a === 'off') return t('common:status.off');
  return String(action || '').toUpperCase();
};

const OP_GLYPH = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=', neq: '≠' };

function ProposedAutomationCard({ a, idx, targetLinks, templatesById }) {
  const { t } = useTranslation('planner');
  const trig = a.trigger_config || {};
  let triggerLabel = trig.type || t('card.unknownTrigger');
  let triggerStyle = 'bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-200';
  if (trig.type === 'schedule') {
    triggerLabel = t('card.dailyAt', { time: trig.time || '?' });
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
          <div className="font-semibold text-gray-900 dark:text-white" dir="auto">{a.name}</div>
          {a.description && <div className="text-xs text-gray-600 dark:text-gray-400 mt-1" dir="auto">{a.description}</div>}
        </div>
        <span className={`text-xs px-2 py-0.5 rounded-full ${triggerStyle} whitespace-nowrap font-mono`} dir="ltr">
          {triggerLabel}
        </span>
      </div>
      {/* Template / Raw badge */}
      {tplId > 0 ? (
        <div className="flex items-center gap-1 mb-2 text-[11px]">
          <span className="px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-200 font-semibold">
            {t('card.viaTemplate')}
          </span>
          <span className="text-gray-700 dark:text-gray-300 font-mono" dir="auto">
            {tpl ? tpl.name : `#${tplId}`}
          </span>
        </div>
      ) : (
        <div className="mb-2">
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-200 font-semibold">
            {t('card.rawNoTemplate')}
          </span>
        </div>
      )}
      {targetLinks && targetLinks.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {targetLinks.map(k => (
            <span key={k} dir="ltr" className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-200 font-mono">
              ↦ {k}
            </span>
          ))}
        </div>
      )}
      {a.rationale && (
        <div className="text-xs italic text-gray-600 dark:text-gray-400 border-s-2 border-indigo-300 dark:border-indigo-600 ps-2 my-2" dir="auto">
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
            <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">{t('card.parameters')}</div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs" dir="ltr">
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
          <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">{t('card.actions')}</div>
          <ol className="text-xs space-y-1">
            {acts.map((act, i) => (
              <li key={i} className="flex items-baseline gap-2 text-gray-700 dark:text-gray-300">
                <span className="text-gray-400 font-mono">{i + 1}.</span>
                <span className="flex-1">
                  <span className="font-mono text-indigo-700 dark:text-indigo-300">{act.type}</span>
                  {act.action && <span className="ms-1 font-semibold">{onOffWord(t, act.action)}</span>}
                  {act.equipment_name && <span className="ms-1" dir="auto">{act.equipment_name}</span>}
                  {act.channel != null && act.channel > 0 && (
                    <span className="ms-1 text-gray-500">
                      {act.channel_name
                        ? t('card.channelNamed', { n: act.channel, name: act.channel_name })
                        : t('card.channel', { n: act.channel })}
                    </span>
                  )}
                  {act.channel === 0 && act.equipment_name && (
                    <span className="ms-1 text-gray-500">{t('card.allChannels')}</span>
                  )}
                  {act.duration_seconds != null && act.duration_seconds > 0 && (
                    <span className="ms-2 text-gray-500">{t('card.forMinutes', { minutes: Math.round(act.duration_seconds / 60 * 10) / 10 })}</span>
                  )}
                  {act.delay_seconds != null && act.delay_seconds > 0 && (
                    <span className="ms-1 text-gray-500">{t('card.afterSeconds', { seconds: act.delay_seconds })}</span>
                  )}
                  {act.type === 'alert' && act.message && (
                    <span className="ms-1 italic" dir="auto">"{act.message}"</span>
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

function fmtWindow(t, target) {
  const w = target.window || 'all_day';
  return t(`window.${w}`, { defaultValue: w });
}

const verdictLabel = (t, v) => t(`verdict.${v}`, { defaultValue: String(v || '').replace(/_/g, ' ') });

function TargetRow({ target, outcome }) {
  const { t } = useTranslation('planner');
  const fmt = useFormat();
  const verdict = outcome?.verdict || 'pending';
  const stats = outcome?.stats;
  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded p-3 bg-white dark:bg-gray-800">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-sm font-semibold text-gray-900 dark:text-gray-100" dir="ltr">{target.key}</span>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            <span dir="ltr">[{fmtNum(fmt, target.min)} – {fmtNum(fmt, target.max)}]</span> · {fmtWindow(t, target)} · <span className="font-mono" dir="ltr">{target.acceptance}</span>
          </span>
        </div>
        {outcome && (
          <span className={`text-xs px-2 py-0.5 rounded font-semibold uppercase ${VERDICT_COLOR[verdict] || VERDICT_COLOR.uncomputable}`}>
            {verdictLabel(t, verdict)}
          </span>
        )}
      </div>
      {target.rationale && (
        <div className="text-xs text-gray-600 dark:text-gray-400 mt-1 italic" dir="auto">{target.rationale}</div>
      )}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-1 text-[11px] mt-2 text-gray-700 dark:text-gray-300 font-mono">
          <div>{t('stats.inRange')} <span className="font-semibold">{fmtPct(fmt, stats.in_range_pct)}</span></div>
          <div>{t('stats.mean')} <span className="font-semibold">{fmtNum(fmt, stats.mean, 2)}</span></div>
          <div>{t('stats.p10p90')} <span dir="ltr">{fmtNum(fmt, stats.p10, 1)} / {fmtNum(fmt, stats.p90, 1)}</span></div>
          <div>{t('stats.excursion')} {fmtNum(fmt, stats.peak_excursion, 2)}</div>
          <div className="col-span-2">{t('stats.breaches', { count: stats.breach_episodes ?? 0, minutes: stats.longest_breach_minutes })}</div>
          <div className="col-span-2">{t('stats.samples', { count: outcome.sample_count ?? 0 })}</div>
        </div>
      )}
      {outcome?.reason && (
        <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-1" dir="auto">{outcome.reason}</div>
      )}
    </div>
  );
}

function YesterdayReviewCard({ review, fullScorecard, partialScorecard }) {
  const { t } = useTranslation('planner');
  if (!review && !fullScorecard && !partialScorecard) return null;
  const grade = review?.overall_grade || fullScorecard?.overall_grade || 'no_prior_targets';
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <h2 className="text-sm uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('review.title')}</h2>
        <span className={`text-xs px-2 py-0.5 rounded font-semibold uppercase ${VERDICT_COLOR[grade] || VERDICT_COLOR.uncomputable}`}>
          {verdictLabel(t, grade)}
        </span>
      </div>
      {review?.lessons_learned && (
        <div className="text-sm text-gray-800 dark:text-gray-200 mb-1" dir="auto">{review.lessons_learned}</div>
      )}
      {review?.strategy_adjustments_hypothesis && (
        <div className="text-sm italic text-indigo-700 dark:text-indigo-300 border-s-2 border-indigo-400 ps-2 mt-2 mb-2">
          <span className="not-italic font-semibold">{t('review.hypothesis')}</span>{' '}
          <span dir="auto">{review.strategy_adjustments_hypothesis}</span>
        </div>
      )}
      {Array.isArray(review?.target_outcomes) && review.target_outcomes.length > 0 && (
        <div className="space-y-1.5 mt-3">
          {review.target_outcomes.map((o, i) => (
            <div key={i} className="flex items-start gap-2 text-sm">
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase ${VERDICT_COLOR[o.verdict] || VERDICT_COLOR.uncomputable} shrink-0 mt-0.5`}>
                {verdictLabel(t, o.verdict)}
              </span>
              <div className="flex-1 min-w-0">
                <span className="font-mono text-gray-700 dark:text-gray-300" dir="ltr">{o.target_key}</span>
                <span className="text-gray-700 dark:text-gray-300 ms-2" dir="auto">{o.observed_summary}</span>
                {o.likely_cause && o.verdict !== 'pass' && (
                  <div className="text-xs text-gray-500 dark:text-gray-400 ms-1">{t('review.cause')} <span dir="auto">{o.likely_cause}</span></div>
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
  const { t } = useTranslation('planner');
  if (!Array.isArray(targets) || targets.length === 0) return null;
  const outcomesByKey = {};
  if (scorecard?.target_outcomes) {
    for (const o of scorecard.target_outcomes) outcomesByKey[o.target_key] = o;
  }
  return (
    <div>
      <div className="flex items-center justify-between mb-2 gap-2">
        <h2 className="text-sm uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {t('targets.title', { count: targets.length })}
        </h2>
        {scorecard && (
          <span className="text-[11px] text-gray-500 dark:text-gray-400">
            {scorecard.cutoff_at ? t('targets.previewPartial') : t('targets.previewFull')}
          </span>
        )}
      </div>
      <div className="space-y-2">
        {targets.map((target, i) => (
          <TargetRow key={i} target={target} outcome={outcomesByKey[target.key]} />
        ))}
      </div>
    </div>
  );
}

function AppliedSummaryCard({ summary, appliedAt }) {
  const { t } = useTranslation('planner');
  const fmt = useFormat();
  if (!summary) return null;
  const counts = (k) => Array.isArray(summary[k]) ? summary[k].length : 0;
  return (
    <div className="bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-200 dark:border-emerald-700 rounded p-3">
      <div className="text-sm font-semibold text-emerald-900 dark:text-emerald-200">{appliedAt ? t('applied.titleAt', { time: fmtDateTime(fmt, appliedAt) }) : t('applied.title')}</div>
      <div className="text-xs text-emerald-800 dark:text-emerald-300 mt-1 font-mono">
        {t('applied.counts', { added: counts('added'), modified: counts('modified'), disabled: counts('disabled'), kept: counts('kept') })}
        {counts('errors') > 0 && <span className="ms-2 text-red-700 dark:text-red-300">⚠ {t('applied.errors', { count: counts('errors') })}</span>}
      </div>
      {counts('errors') > 0 && (
        <ul className="text-xs text-red-700 dark:text-red-300 mt-2 list-disc list-inside" dir="auto">
          {summary.errors.map((e, i) => (
            <li key={i}>{e.error}: {e.change?.target || e.change?.change_type}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ConsistencyWarningsCard({ warnings }) {
  const { t } = useTranslation('planner');
  if (!Array.isArray(warnings) || warnings.length === 0) return null;
  const mono = <span className="font-mono" dir="ltr" />;
  const b = <span className="font-semibold" />;
  return (
    <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-300 dark:border-amber-700 rounded p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-amber-700 dark:text-amber-200">⚠</span>
        <div className="text-sm font-semibold text-amber-900 dark:text-amber-200">
          {t('consistency.title', { count: warnings.length })}
        </div>
      </div>
      <ul className="text-xs space-y-1.5 text-amber-900 dark:text-amber-200">
        {warnings.map((w, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="text-amber-500 mt-0.5" aria-hidden="true">•</span>
            <div className="flex-1">
              {w.kind === 'count_mismatch' && (
                <>
                  <Trans t={t} i18nKey="consistency.countMismatch" values={{ field: w.field, claims: w.prose_claims, data: w.data_says }} components={{ mono, b }} />
                  {w.context && <span className="block text-amber-700 dark:text-amber-300 italic mt-0.5" dir="auto">"...{w.context}..."</span>}
                </>
              )}
              {w.kind === 'unknown_automation_id' && (
                <>
                  <Trans t={t} i18nKey="consistency.unknownAutomation" values={{ context: w.context, id: w.id }} components={{ mono }} />
                </>
              )}
              {w.kind === 'untracked_automation_id' && (
                <>
                  <Trans t={t} i18nKey="consistency.untrackedAutomation" values={{ context: w.context, id: w.id }} components={{ mono }} />
                </>
              )}
              {(w.kind === 'time_range_actual_outside_claim' || w.kind === 'time_range_overstated') && (
                <>
                  <Trans t={t} i18nKey="consistency.timeRange" values={{ subject: w.subject, claimed: w.claimed_range, actual: w.actual_range }} components={{ mono, b }} />
                  {w.hint && <span className="block text-amber-700 dark:text-amber-300 italic mt-0.5" dir="auto">{w.hint}</span>}
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
      <div className="text-xs text-amber-700 dark:text-amber-300 italic mt-2">
        {t('consistency.footer')}
      </div>
    </div>
  );
}

function RejectionCard({ feedback }) {
  const { t } = useTranslation('planner');
  if (!feedback) return null;
  return (
    <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded p-3">
      <div className="text-sm font-semibold text-red-900 dark:text-red-200">{t('rejection.title')}</div>
      <div className="text-sm text-red-800 dark:text-red-200 mt-1 whitespace-pre-wrap" dir="auto">{feedback}</div>
      <div className="text-xs text-red-700 dark:text-red-300 mt-2 italic">{t('rejection.footer')}</div>
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
// Label: planner:discussion.verdict.<key> (`label` = English reference).
const VERDICT_BADGE = {
  plan_correct:    { label: 'Plan is correct', cls: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300' },
  concern_valid:   { label: 'Concern is valid', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300' },
  need_more_data:  { label: 'Need more data', cls: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300' },
};

function PlanDiscussion({ planId, planStatus, canControl, headers, showError, showSuccess, onRegenerated }) {
  const { t } = useTranslation('planner');
  const fmt = useFormat();
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
      else showError?.(t('discussion.loadFailed'));
    } catch (err) {
      showError?.(t('discussion.loadFailedWithError', { error: err.message }));
    } finally { setLoading(false); }
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
        showError(e.error || t('discussion.sendFailed'));
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
    if (!confirm(t('discussion.confirmRegenerate', { count: openItems.length }))) return;
    setRegenerating(true);
    try {
      const res = await fetch(`${API_BASE}/planner/plans/${planId}/clarifications/regenerate`, {
        method: 'POST', headers,
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        showError(e.error || t('discussion.regenerateFailed'));
      } else {
        const data = await res.json();
        showSuccess(t('discussion.toastRegenerated'));
        if (data.regenerated?.id && onRegenerated) onRegenerated(data.regenerated.id);
      }
    } catch (err) { showError(err.message); }
    finally { setRegenerating(false); }
  };

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
        <div>
          <div className="font-semibold text-gray-900 dark:text-gray-100">{t('discussion.title')}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {t('discussion.help')}
          </div>
        </div>
        {hasOpen && canControl && planStatus === 'pending' && (
          <button
            onClick={regenerate}
            disabled={regenerating}
            className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 disabled:opacity-60 text-white text-xs rounded-md whitespace-nowrap"
            title={t('discussion.applyOpenTitle')}
          >
            {regenerating ? t('discussion.regenerating') : t('discussion.applyOpen', { count: openItems.length })}
          </button>
        )}
      </div>

      <div className="divide-y divide-gray-100 dark:divide-gray-700">
        {loading ? (
          <div className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{t('common:status.loading')}</div>
        ) : thread.length === 0 ? (
          <div className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 italic">{t('discussion.empty')}</div>
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
                    <span aria-hidden="true">{c.role === 'highlight' ? '⚠' : '💬'}</span> {c.role === 'highlight' ? t('discussion.role.highlight') : t('discussion.role.question')}
                  </span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    <span dir="auto">{c.user_name || t('discussion.operator')}</span> · {fmtDateTime(fmt, c.created_at)}
                  </span>
                  {c.status === 'addressed' && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300">
                      {c.addressed_by_plan_id ? t('discussion.addressedByPlan', { id: c.addressed_by_plan_id }) : t('discussion.addressed')}
                    </span>
                  )}
                </div>
                <div className="text-sm text-gray-900 dark:text-gray-100 whitespace-pre-wrap ps-2 border-s-2 border-gray-200 dark:border-gray-700" dir="auto">
                  {c.message}
                </div>
                {c.planner_response && (
                  <div className="mt-2 ms-3 ps-3 border-s-2 border-primary-300 dark:border-primary-700 bg-gray-50 dark:bg-gray-900/40 rounded-e py-2 pe-2">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase bg-primary-100 text-primary-800 dark:bg-primary-900/30 dark:text-primary-300">
                        {t('discussion.plannerBadge')}
                      </span>
                      {verdict && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${verdict.cls}`}>
                          {t(`discussion.verdict.${c.response_verdict}`)}
                        </span>
                      )}
                      <span className="text-xs text-gray-500 dark:text-gray-400">{fmtDateTime(fmt, c.responded_at)}</span>
                    </div>
                    <div className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap" dir="auto">{c.planner_response}</div>
                  </div>
                )}
                {!c.planner_response && c.responded_at == null && (
                  <div className="text-xs text-gray-400 italic mt-1">{t('discussion.waiting')}</div>
                )}
              </div>
            );
          })
        )}
      </div>

      {canControl && (
        <div className="px-4 py-3 border-t border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <label className="text-xs font-medium text-gray-700 dark:text-gray-300">{t('discussion.typeLabel')}</label>
            <button
              onClick={() => setRole('question')}
              className={`px-2 py-1 text-xs rounded ${
                role === 'question'
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-blue-700 border border-blue-300 hover:bg-blue-50 dark:bg-gray-800 dark:text-blue-300 dark:border-blue-700'
              }`}>
              <span aria-hidden="true">💬</span> {t('discussion.role.question')}
            </button>
            <button
              onClick={() => setRole('highlight')}
              className={`px-2 py-1 text-xs rounded ${
                role === 'highlight'
                  ? 'bg-orange-600 text-white'
                  : 'bg-white text-orange-700 border border-orange-300 hover:bg-orange-50 dark:bg-gray-800 dark:text-orange-300 dark:border-orange-700'
              }`}>
              <span aria-hidden="true">⚠</span> {t('discussion.role.highlight')}
            </button>
            <span className="text-xs text-gray-500 dark:text-gray-400 ms-2 italic">
              {role === 'highlight'
                ? t('discussion.highlightHelp')
                : t('discussion.questionHelp')}
            </span>
          </div>
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder={role === 'highlight'
              ? t('discussion.highlightPlaceholder')
              : t('discussion.questionPlaceholder')}
            rows={3}
            dir="auto"
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-800 dark:text-white"
          />
          <div className="mt-2 flex justify-end">
            <button
              onClick={send}
              disabled={posting || !draft.trim()}
              className="px-4 py-1.5 bg-primary-600 hover:bg-primary-700 disabled:opacity-50 text-white text-sm rounded-md"
            >
              {posting ? t('discussion.sending') : t('discussion.send')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Planner() {
  const { t } = useTranslation('planner');
  const fmt = useFormat();
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
  const [guardrails, setGuardrails] = useState([]);
  const [overrideDialog, setOverrideDialog] = useState(null); // { rules, reasons: {rule_id: text} }
  const [showSettings, setShowSettings] = useState(false);
  const [showRawSnapshot, setShowRawSnapshot] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [rejectFeedback, setRejectFeedback] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const fetchPlans = async (selectId = null) => {
    setLoading(true);
    try {
      // 100 is the route's cap; a long failure streak must not truncate the banner count.
      const res = await fetch(`${API_BASE}/planner/plans?limit=100`, { headers });
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
      showError(t('toast.loadPlansFailed', { error: err.message }));
    } finally {
      setLoading(false);
    }
  };

  const loadPlan = async (id) => {
    try {
      const res = await fetch(`${API_BASE}/planner/plans/${id}`, { headers });
      if (res.ok) setSelected(await res.json());
      // Guardrails are cheap to evaluate and the warning needs to be visible
      // BEFORE the operator clicks Confirm — so prefetch alongside the plan.
      const gres = await fetch(`${API_BASE}/planner/plans/${id}/guardrails`, { headers });
      if (gres.ok) setGuardrails(await gres.json());
      else setGuardrails([]);
    } catch (err) {
      showError(t('toast.loadPlanFailed', { error: err.message }));
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
        showSuccess(t('toast.configSaved'));
        const updated = await res.json();
        setConfig(updated);
        setShowSettings(false);
      } else {
        const data = await res.json().catch(() => ({}));
        showError(data.error || t('toast.configSaveFailed'));
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
        showSuccess(t('toast.generated'));
        await fetchPlans(data.plan?.id);
      } else {
        const data = await res.json().catch(() => ({}));
        if (data.code === 'ALREADY_EXISTS') {
          if (window.confirm(t('confirm.replacePending'))) {
            return generateNow(true);
          }
        } else {
          showError(data.error || t('toast.generateFailed'));
        }
      }
    } catch (err) {
      showError(err.message);
    } finally {
      setGenerating(false);
    }
  };

  const confirmPlan = async (overrides = []) => {
    // Defensive: if a synthetic React event somehow leaks in (e.g. someone wires
    // onClick={confirmPlan}), treat it as no-overrides instead of trying to
    // JSON.stringify the DOM/Fiber graph.
    if (!Array.isArray(overrides)) overrides = [];
    if (!canControl || !selected) return;
    // The no-override path is confirmed through <ConfirmDialog> (see confirmOpen),
    // which names how many automations the diff manifest will INSERT/UPDATE/DISABLE.
    setConfirmOpen(false);
    setConfirming(true);
    try {
      const res = await fetch(`${API_BASE}/planner/plans/${selected.id}/confirm`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ overrides }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        showSuccess(overrides.length > 0 ? t('toast.confirmedWithOverrides') : t('toast.confirmed'));
        const errors = data.applied_summary?.errors?.length || 0;
        if (errors > 0) showError(t('toast.changesFailed', { count: errors }));
        setOverrideDialog(null);
        await fetchPlans(selected.id);
      } else if (data.code === 'GUARDRAIL_BLOCKED') {
        // Open the override dialog with the triggered rules.
        setOverrideDialog({ rules: data.guardrails || [], reasons: {} });
      } else if (data.code === 'OVERRIDE_FORBIDDEN') {
        showError(t('toast.overrideForbidden', { error: data.error }));
      } else {
        showError(data.error || t('toast.confirmFailed'));
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
      showError(t('toast.feedbackRequired'));
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
        showSuccess(t('toast.rejected'));
        setShowReject(false);
        setRejectFeedback('');
        await fetchPlans(data.regenerated?.id);
      } else {
        showError(data.error || t('toast.rejectFailed'));
      }
    } catch (err) {
      showError(err.message);
    } finally {
      setRejecting(false);
    }
  };

  const deletePlan = async (id) => {
    if (!isAdmin) return;
    if (!window.confirm(t('confirm.deletePlan'))) return;
    try {
      const res = await fetch(`${API_BASE}/planner/plans/${id}`, { method: 'DELETE', headers });
      if (res.ok) {
        showSuccess(t('toast.deleted'));
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
    const s = selected;
    return {
      input: s.input_tokens || 0, output: s.output_tokens || 0,
      cache_read: s.cache_read_tokens || 0, cache_creation: s.cache_creation_tokens || 0,
    };
  }, [selected]);

  // Build idx → target.key links for proposed_automations
  const targetLinksByIndex = useMemo(() => {
    if (!plan?.targets) return {};
    const m = {};
    for (const target of plan.targets) {
      for (const i of (target.owner_automation_indexes || [])) {
        if (!m[i]) m[i] = [];
        m[i].push(target.key);
      }
    }
    return m;
  }, [plan]);

  // Templates lookup for rendering template-based automations
  const templatesById = useMemo(() => {
    const list = snapshot?.templates || [];
    const m = {};
    for (const tpl of list) m[tpl.id] = tpl;
    return m;
  }, [snapshot]);

  // Consecutive failures at the head of the (newest-first) plan list collapse
  // into one banner instead of N raw-JSON rows.
  const failureRun = useMemo(() => leadingFailureRun(plans), [plans]);

  // What Confirm will do to live automations, from the diff manifest.
  // (Counting is unchanged; only the item words are translated.)
  const changeCounts = useMemo(() => {
    const c = { add: 0, modify: 0, remove: 0, keep: 0, items: [] };
    for (const ch of (plan?.changes_from_today || [])) {
      if (c[ch.change_type] === undefined) continue;
      c[ch.change_type] += 1;
      if (ch.change_type !== 'keep') {
        const verb = ch.change_type === 'add' ? t('manifest.insert') : ch.change_type === 'modify' ? t('manifest.update') : t('manifest.disable');
        const target = ch.target || t('manifest.automation');
        c.items.push(ch.current_automation_id
          ? t('manifest.itemWithId', { verb, target, id: ch.current_automation_id })
          : t('manifest.item', { verb, target }));
      }
    }
    return c;
  }, [plan, t]);

  const selectedFailure = selected?.status === 'failure' ? classifyPlanError(selected.error) : null;

  return (
    <div className="max-w-7xl mx-auto">
      <div className="flex items-start justify-between mb-4 gap-3 flex-wrap">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold text-ink">{t('title')}</h1>
          <p className="text-sm text-muted mt-1">
            {t('subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="primary"
            size="sm"
            onClick={() => generateNow(false)}
            disabled={!canControl || generating}
            title={!canControl ? t('header.generateNotAllowed') : undefined}
          >
            {generating ? t('header.generating') : t('header.generate')}
          </Button>
          {isAdmin && (
            <Button variant="secondary" size="sm" onClick={() => setShowSettings(true)}>{t('header.settings')}</Button>
          )}
        </div>
      </div>

      {/* Config quick status */}
      {config && (
        <Label as="p" className="mb-4">
          {config.enabled
            ? <Trans t={t} i18nKey="scheduler.on" values={{ time: `${String(config.schedule_hour).padStart(2,'0')}:${String(config.schedule_minute).padStart(2,'0')}` }} components={{ time: <span className="font-mono tabular text-ink" dir="ltr" /> }} />
            : t('scheduler.off')}
          {!config.api_key_present && <span className="ms-2 text-alarm-600 dark:text-alarm-300">· {t('scheduler.apiKeyMissing')}</span>}
        </Label>
      )}

      <FailureBanner
        run={failureRun}
        sinceLabel={failureRun ? fmtDate(fmt, failureRun.since) : ''}
        onRetry={() => generateNow(false)}
        retrying={generating}
        canRetry={canControl}
      />

      <div className="grid grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)] gap-4">
        {/* Plan list */}
        <aside className="lg:border-e lg:border-line lg:pe-3">
          <Label className="mb-2">{t('list.title')}</Label>
          {loading && <div className="text-sm text-muted">{t('common:status.loading')}</div>}
          {!loading && plans.length === 0 && (
            <div className="text-sm text-muted">{t('list.empty')}</div>
          )}
          <div className="space-y-1 max-h-[70vh] overflow-y-auto" data-testid="plan-list">
            {plans.map(p => {
              const failed = p.status === 'failure';
              const pill = STATUS_PILL[p.status] || STATUS_PILL.success;
              const active = selected?.id === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => loadPlan(p.id)}
                  aria-current={active ? 'true' : undefined}
                  data-status={p.status}
                  className={`w-full text-start px-2 rounded-md text-sm transition-colors ${
                    failed ? 'py-1 opacity-60 hover:opacity-100' : 'py-1.5'
                  } ${active ? 'bg-brand-100 dark:bg-brand-900 text-ink' : 'hover:bg-field text-ink'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className={`${failed ? 'font-normal' : 'font-medium'} truncate`}>{fmtDate(fmt, p.plan_date)}</div>
                    <StatusPill state={pill.state} filled={pill.filled} className="!px-1.5 !py-0 text-[10px]">
                      {t(`statusShort.${p.status}`, { defaultValue: p.status })}
                    </StatusPill>
                  </div>
                  {!failed && (
                    <div className="text-xs text-muted truncate">
                      <span dir="auto">{p.headline || '—'}</span>
                      {p.version > 1 && <span className="ms-1 font-mono">v{p.version}</span>}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </aside>

        {/* Plan detail */}
        <main>
          {!selected && !loading && (
            <div className="text-sm text-muted p-8 text-center border border-dashed border-line rounded-card">
              {t('detail.selectPrompt')}
            </div>
          )}

          {selected?.status === 'failure' && selectedFailure && (
            <Card rail="alarm" className="mb-4">
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <StatusPill state="alarm">{t('statusShort.failure')}</StatusPill>
                <span className="font-display font-semibold text-ink">{t('detail.notGenerated', { date: fmtDate(fmt, selected.plan_date) })}</span>
              </div>
              <p className="text-sm text-ink">{selectedFailure.key ? t(`failure.reason.${selectedFailure.key}`) : selectedFailure.reason}</p>
              {selected.error && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs font-semibold text-muted hover:text-ink">{t('detail.rawError')}</summary>
                  <pre dir="ltr" className="text-start mt-1 text-xs font-mono whitespace-pre-wrap break-words bg-field border border-line rounded-md p-2 max-h-40 overflow-y-auto text-muted">{selected.error}</pre>
                </details>
              )}
            </Card>
          )}

          {selected && plan && selected.status !== 'failure' && (
            <div className="space-y-5">
              {/* Header */}
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="text-lg font-semibold text-gray-900 dark:text-white">
                      {t('detail.planFor', { date: fmtDate(fmt, selected.plan_date) })}
                    </div>
                    <ProvenanceBadge kind="ai" data-testid="plan-ai-badge" />
                    {selected.version > 1 && (
                      <span className="text-xs px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 font-mono">v{selected.version}</span>
                    )}
                    <span className={`text-xs px-2 py-0.5 rounded font-semibold uppercase ${STATUS_COLOR[selected.status] || STATUS_COLOR.success}`}>
                      {STATUS_KEYS.includes(selected.status) ? t(`statusLabel.${selected.status}`) : selected.status}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {t('detail.generated', { time: fmtDateTime(fmt, selected.generated_at) })} · <span className="font-mono" dir="ltr">{selected.model}</span>
                  </div>
                </div>
                <p className="text-base text-gray-900 dark:text-gray-100 mt-1" dir="auto">{plan.headline}</p>
                <p className="text-sm text-gray-700 dark:text-gray-300 mt-2 italic" dir="auto">{plan.summary}</p>
                {tokenUsage && (
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-3 font-mono">
                    {t('detail.tokens', { input: fmt.int(tokenUsage.input), output: fmt.int(tokenUsage.output) })}
                    {tokenUsage.cache_read > 0 && ` · ${t('detail.cacheHit', { n: fmt.int(tokenUsage.cache_read) })}`}
                  </div>
                )}

                {/* Guardrail warnings — visible BEFORE Confirm so operator knows what they'll need to override.
                    Split into blockers (would_block !== false) and informational warnings (would_block === false). */}
                {selected.status === 'pending' && guardrails.filter(g => g.would_block !== false).length > 0 && (
                  <div className="mt-4 border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/30 rounded p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <svg className="w-5 h-5 text-red-600 dark:text-red-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                      <span className="font-semibold text-red-900 dark:text-red-100">
                        {t('guardrails.wouldBlock', { count: guardrails.filter(g => g.would_block !== false).length })}
                      </span>
                    </div>
                    <div className="space-y-2">
                      {guardrails.filter(g => g.would_block !== false).map(g => (
                        <div key={g.rule_id} className="text-sm">
                          <div className="font-semibold text-red-900 dark:text-red-200" dir="auto">{g.rule_name}</div>
                          <div className="text-red-800 dark:text-red-200 text-xs mt-0.5">
                            {t('guardrails.latestLine', {
                              element: g.element,
                              value: g.latest_value != null ? fmt.withUnit(g.latest_value, 'mg/L') : t('guardrails.noRecentSample'),
                              comparison: `${g.comparison} ${g.threshold}`,
                              duty: dutyPct(fmt, g.minimum_tank_duty_pct),
                            })}
                          </div>
                          {g.triggering_automations?.length > 0 && (
                            <div className="text-red-800 dark:text-red-200 text-xs mt-1 italic">
                              {t('guardrails.triggeredBy', {
                                list: g.triggering_automations.map(a => t('guardrails.triggerItem', { name: a.automation_name, program: a.dose_program_name, duty: dutyPct(fmt, a.tank_duty_pct) })).join('; '),
                              })}
                            </div>
                          )}
                          <div className="text-red-700 dark:text-red-300 text-xs mt-1">
                            {t('guardrails.overrideRole')} <span className="font-mono">{t(`common:role.${g.override_role}`, { defaultValue: g.override_role })}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Non-blocking informational warnings (e.g. flush near fertigation during deficit). */}
                {selected.status === 'pending' && guardrails.filter(g => g.would_block === false).length > 0 && (
                  <div className="mt-4 border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 rounded p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <svg className="w-5 h-5 text-amber-600 dark:text-amber-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <span className="font-semibold text-amber-900 dark:text-amber-100">
                        {t('guardrails.informational', { count: guardrails.filter(g => g.would_block === false).length })}
                      </span>
                    </div>
                    <div className="space-y-2">
                      {guardrails.filter(g => g.would_block === false).map(g => (
                        <div key={g.rule_id} className="text-sm">
                          <div className="font-semibold text-amber-900 dark:text-amber-200" dir="auto">{g.rule_name}</div>
                          <div className="text-amber-800 dark:text-amber-200 text-xs mt-1" dir="auto">{g.description}</div>
                          {g.triggering_automations?.length > 0 && (
                            <ul className="text-amber-800 dark:text-amber-200 text-xs mt-1 ms-4 list-disc">
                              {g.triggering_automations.map((a, idx) => (
                                <li key={idx}>
                                  {a.kind === 'water_flush' && <span className="font-mono">[{t('guardrails.flush')}]</span>}
                                  {a.kind === 'fertigation' && <span className="font-mono">[{t('guardrails.fertigationOffset', { minutes: `${a.minutes_from_flush >= 0 ? '+' : ''}${a.minutes_from_flush}` })}]</span>}
                                  {' '}"<span dir="auto">{a.automation_name}</span>"
                                  {a.dose_program_name && <span className="text-amber-700 dark:text-amber-300"> · {t('guardrails.program', { name: a.dose_program_name })}</span>}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Confirm/Reject action bar */}
                {selected.status === 'pending' && canControl && (
                  <div className="mt-4 flex gap-2 flex-wrap items-center border-t border-line pt-3">
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => setConfirmOpen(true)}
                      disabled={confirming || rejecting}
                      data-testid="plan-confirm"
                    >
                      {confirming ? t('actions.applying') : t('actions.confirmApply')}
                    </Button>
                    <Button
                      variant="danger-ghost"
                      size="sm"
                      onClick={() => { setRejectFeedback(''); setShowReject(true); }}
                      disabled={confirming || rejecting}
                    >
                      {t('actions.reject')}
                    </Button>
                    <span className="text-xs text-muted font-mono tabular">
                      {t('actions.changeCounts', { add: changeCounts.add, modify: changeCounts.modify, remove: changeCounts.remove, keep: changeCounts.keep })}
                    </span>
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
                    {t('sections.templateRequests', { count: plan.template_requests.length })}
                  </h2>
                  <div className="space-y-2">
                    {plan.template_requests.map((tr, i) => (
                      <div key={i} className="border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 rounded p-3">
                        <div className="font-semibold text-amber-900 dark:text-amber-200" dir="auto">{tr.proposed_name}</div>
                        <div className="text-sm text-amber-900 dark:text-amber-200 mt-1" dir="auto">{tr.purpose}</div>
                        <div className="text-xs text-amber-800 dark:text-amber-300 mt-1 font-mono">{t('sections.templateParameters')} <span dir="auto">{tr.parameters_needed}</span></div>
                        {tr.example_use && (
                          <div className="text-xs text-amber-700 dark:text-amber-300 italic mt-1">{t('sections.example')} <span dir="auto">{tr.example_use}</span></div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Risks */}
              {Array.isArray(plan.risks) && plan.risks.length > 0 && (
                <div>
                  <h2 className="text-sm uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">{t('sections.risks')}</h2>
                  <div className="space-y-2">
                    {plan.risks.map((r, i) => (
                      <div key={i} className="border border-gray-200 dark:border-gray-700 rounded p-3 bg-white dark:bg-gray-800">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`text-xs px-2 py-0.5 rounded font-semibold uppercase ${SEVERITY_COLOR[r.severity] || SEVERITY_COLOR.low}`}>
                            {t(`severity.${r.severity}`, { defaultValue: r.severity })}
                          </span>
                          <span className="font-medium text-gray-900 dark:text-gray-100" dir="auto">{r.risk}</span>
                        </div>
                        <div className="text-sm text-gray-600 dark:text-gray-400 ms-1"><span aria-hidden="true" className="inline-block rtl:-scale-x-100">→</span> <span dir="auto">{r.suggested_human_action}</span></div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Changes from today */}
              {Array.isArray(plan.changes_from_today) && plan.changes_from_today.length > 0 && (
                <div>
                  <h2 className="text-sm uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">{t('sections.changes')}</h2>
                  <div className="space-y-2">
                    {plan.changes_from_today.map((c, i) => (
                      <div key={i} className="flex items-start gap-2 border-s-2 border-gray-200 dark:border-gray-700 ps-3 py-1">
                        <span className={`text-xs px-2 py-0.5 rounded font-semibold uppercase ${CHANGE_COLOR[c.change_type] || CHANGE_COLOR.keep}`}>
                          {t(`change.${c.change_type}`, { defaultValue: c.change_type })}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                            <span dir="auto">{c.target}</span>
                            {c.current_automation_id ? <span className="ms-1">{t('sections.idTag', { id: c.current_automation_id })}</span> : null}
                            {c.proposed_automation_index >= 0 ? <span className="ms-1">{t('sections.proposedTag', { n: c.proposed_automation_index })}</span> : null}
                          </div>
                          <div className="text-sm text-gray-900 dark:text-gray-100" dir="auto">{c.detail}</div>
                          <div className="text-xs text-gray-600 dark:text-gray-400 italic mt-0.5" dir="auto">{c.rationale}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Proposed automations */}
              <div>
                <h2 className="text-sm uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">
                  {t('sections.proposed', { count: Array.isArray(plan.proposed_automations) ? plan.proposed_automations.length : 0 })}
                </h2>
                {Array.isArray(plan.proposed_automations) && plan.proposed_automations.length > 0 ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {plan.proposed_automations.map((a, i) => (
                      <ProposedAutomationCard key={i} a={a} idx={i} targetLinks={targetLinksByIndex[i] || []} templatesById={templatesById} />
                    ))}
                  </div>
                ) : (
                  <div className="text-sm text-gray-500 dark:text-gray-400 p-3 border border-dashed border-gray-300 dark:border-gray-700 rounded">
                    {t('sections.noneProposed')}
                  </div>
                )}
              </div>

              {/* Raw snapshot toggle */}
              <div>
                <button
                  onClick={() => setShowRawSnapshot(s => !s)}
                  className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
                >
                  {showRawSnapshot ? t('raw.hide') : t('raw.show')}
                </button>
                {showRawSnapshot && (
                  <div className="mt-2 space-y-3">
                    <details className="border border-gray-200 dark:border-gray-700 rounded">
                      <summary className="px-3 py-2 cursor-pointer text-sm font-medium">{t('raw.inputSnapshot')}</summary>
                      <pre dir="ltr" className="text-start text-xs p-3 overflow-x-auto bg-gray-50 dark:bg-gray-900 max-h-96 overflow-y-auto">{JSON.stringify(selected.input_snapshot, null, 2)}</pre>
                    </details>
                    <details className="border border-gray-200 dark:border-gray-700 rounded">
                      <summary className="px-3 py-2 cursor-pointer text-sm font-medium">{t('raw.planJson')}</summary>
                      <pre dir="ltr" className="text-start text-xs p-3 overflow-x-auto bg-gray-50 dark:bg-gray-900 max-h-96 overflow-y-auto">{JSON.stringify(plan, null, 2)}</pre>
                    </details>
                  </div>
                )}
              </div>

              {/* Delete */}
              {isAdmin && (
                <div className="text-end">
                  <button
                    onClick={() => deletePlan(selected.id)}
                    className="text-xs text-red-600 dark:text-red-400 hover:underline"
                  >
                    {t('actions.deletePlan')}
                  </button>
                </div>
              )}
            </div>
          )}
        </main>
      </div>

      {/* Confirm & apply — names what the diff manifest will do to live automations */}
      <ConfirmDialog
        open={confirmOpen}
        title={t('confirmDialog.title')}
        body={t('confirmDialog.body', {
          count: changeCounts.add + changeCounts.modify + changeCounts.remove,
          date: selected ? fmtDate(fmt, selected.plan_date) : '',
          add: changeCounts.add,
          modify: changeCounts.modify,
          remove: changeCounts.remove,
          keep: changeCounts.keep,
        })}
        items={changeCounts.items}
        confirmLabel={t('actions.confirmApply')}
        busy={confirming}
        onConfirm={() => confirmPlan([])}
        onCancel={() => setConfirmOpen(false)}
      />

      {/* Reject modal */}
      {showReject && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl max-w-lg w-full p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t('reject.title')}</h3>
              <button onClick={() => setShowReject(false)} aria-label={t('common:actions.close')} title={t('common:actions.close')} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
              <Trans t={t} i18nKey="reject.help" components={{ i: <span className="italic" /> }} />
            </p>
            <textarea
              autoFocus
              rows={6}
              value={rejectFeedback}
              onChange={e => setRejectFeedback(e.target.value)}
              placeholder={t('reject.placeholder')}
              dir="auto"
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded resize-y"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setShowReject(false)}
                disabled={rejecting}
                className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded text-gray-700 dark:text-gray-200 disabled:opacity-50"
              >
                {t('common:actions.cancel')}
              </button>
              <button
                onClick={submitReject}
                disabled={rejecting || !rejectFeedback.trim()}
                className="px-3 py-1.5 text-sm bg-red-600 hover:bg-red-700 text-white rounded disabled:opacity-50"
              >
                {rejecting ? t('reject.regenerating') : t('reject.submit')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Guardrail override dialog — pops when Confirm returns 409 GUARDRAIL_BLOCKED.
          Requires a typed reason per blocked rule before re-submitting Confirm. */}
      {overrideDialog && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl max-w-2xl w-full p-5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <svg className="w-6 h-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                  {t('override.title')}
                </h3>
              </div>
              <button onClick={() => setOverrideDialog(null)} aria-label={t('common:actions.close')} title={t('common:actions.close')} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <p className="text-sm text-gray-700 dark:text-gray-300 mb-4">
              {t('override.help')} {overrideDialog.rules.some(r => r.override_role === 'admin') && (!isAdmin) && (
                <span className="block mt-1 text-red-600 dark:text-red-400 font-medium">⚠ {t('override.adminRequired')}</span>
              )}
            </p>
            <div className="space-y-4 mb-4">
              {overrideDialog.rules.map(g => (
                <div key={g.rule_id} className="border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/30 rounded p-3">
                  <div className="font-semibold text-red-900 dark:text-red-100" dir="auto">{g.rule_name}</div>
                  <div className="text-xs text-red-800 dark:text-red-200 mt-1" dir="auto">{g.description}</div>
                  <div className="text-xs text-red-700 dark:text-red-300 mt-2 font-mono">
                    {t('override.ruleLine', {
                      element: g.element,
                      value: g.latest_value != null ? fmt.withUnit(g.latest_value, 'mg/L') : t('guardrails.noRecentSample'),
                      comparison: `${g.comparison} ${g.threshold}`,
                      duty: dutyPct(fmt, g.minimum_tank_duty_pct),
                    })}
                  </div>
                  <label className="block mt-3">
                    <span className="text-xs font-medium text-gray-700 dark:text-gray-200">{t('override.reason')} <span className="text-red-600">*</span></span>
                    <textarea
                      rows={2}
                      value={overrideDialog.reasons[g.rule_id] || ''}
                      onChange={e => setOverrideDialog(d => ({
                        ...d,
                        reasons: { ...d.reasons, [g.rule_id]: e.target.value },
                      }))}
                      placeholder={t('override.reasonPlaceholder')}
                      dir="auto"
                      className="w-full mt-1 px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 dark:text-white"
                    />
                  </label>
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setOverrideDialog(null)}
                className="px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded">
                {t('common:actions.cancel')}
              </button>
              <button
                onClick={() => {
                  const overrides = overrideDialog.rules.map(g => ({
                    rule_id: g.rule_id,
                    rule_name: g.rule_name,
                    reason: (overrideDialog.reasons[g.rule_id] || '').trim(),
                  }));
                  const missing = overrides.filter(o => !o.reason);
                  if (missing.length > 0) {
                    showError(t('override.missingReasons', { count: missing.length }));
                    return;
                  }
                  confirmPlan(overrides);
                }}
                disabled={confirming}
                className="px-4 py-1.5 text-sm bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white rounded font-medium">
                {confirming ? t('actions.applying') : t('override.apply')}
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
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t('settings.title')}</h3>
              <button onClick={() => setShowSettings(false)} aria-label={t('common:actions.close')} title={t('common:actions.close')} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <div className="space-y-4">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={!!config.enabled}
                  onChange={e => setConfig(c => ({ ...c, enabled: e.target.checked }))}
                />
                <span className="text-sm text-gray-700 dark:text-gray-200">{t('settings.enabled')}</span>
              </label>
              <div className="flex flex-wrap gap-2 items-center">
                <span className="text-sm text-gray-700 dark:text-gray-200 w-24">{t('settings.firesAt')}</span>
                <span className="inline-flex items-center gap-2" dir="ltr">
                <input
                  type="number" min="0" max="23"
                  value={config.schedule_hour}
                  onChange={e => setConfig(c => ({ ...c, schedule_hour: parseInt(e.target.value) || 0 }))}
                  aria-label={t('settings.hour')}
                  className="w-16 px-2 py-1 border border-gray-300 dark:border-gray-600 dark:bg-gray-800 rounded text-sm"
                />
                <span>:</span>
                <input
                  type="number" min="0" max="59"
                  value={config.schedule_minute}
                  onChange={e => setConfig(c => ({ ...c, schedule_minute: parseInt(e.target.value) || 0 }))}
                  aria-label={t('settings.minute')}
                  className="w-16 px-2 py-1 border border-gray-300 dark:border-gray-600 dark:bg-gray-800 rounded text-sm"
                />
                </span>
                <span className="text-xs text-gray-500">{t('settings.localTime')}</span>
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 border-t border-gray-200 dark:border-gray-700 pt-3">
                <Trans t={t} i18nKey="settings.pendingNote" components={{ mono: <span className="font-mono" /> }} />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setShowSettings(false)}
                className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded text-gray-700 dark:text-gray-200"
              >
                {t('common:actions.cancel')}
              </button>
              <button
                onClick={saveConfig}
                className="px-3 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded"
              >
                {t('common:actions.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
