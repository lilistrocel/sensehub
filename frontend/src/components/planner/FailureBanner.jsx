import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Button, StatusPill } from '../../ui';

/**
 * Turn the raw error text of a failed plan into one operator-readable line.
 * Returns { reason, kind, key } where kind is 'credits' | 'auth' | 'other'.
 * `key` (planner:failure.reason.<key>) is set when the line is ours to
 * translate; `reason` keeps the English text (tests/logs) and, for an
 * unclassified provider error, the raw error itself (never translated).
 * The patterns match the AI provider's raw English error text, not a
 * localized SenseHub message.
 */
export function classifyPlanError(text) {
  const s = String(text || '').trim();
  if (!s) return { reason: 'No error detail recorded', kind: 'other', key: 'none' };
  if (/credit balance/i.test(s)) {
    return { reason: 'Anthropic API credits exhausted — top up at Plans & Billing', kind: 'credits', key: 'credits' };
  }
  if (/\b40[13]\b|unauthori[sz]ed|forbidden|invalid (api[ _-]?key|x-api-key)|authentication_error/i.test(s)) {
    return { reason: 'API key rejected', kind: 'auth', key: 'auth' };
  }
  const oneLine = s.replace(/\s+/g, ' ');
  return { reason: oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine, kind: 'other', key: null };
}

/**
 * Leading run of consecutive failed plans in a newest-first list.
 * Returns null when the newest plan did not fail.
 */
export function leadingFailureRun(plans) {
  if (!Array.isArray(plans) || plans.length === 0 || plans[0].status !== 'failure') return null;
  const run = [];
  for (const p of plans) {
    if (p.status !== 'failure') break;
    run.push(p);
  }
  return {
    count: run.length,
    since: run[run.length - 1].plan_date,
    latest: run[0],
    error: run.find((p) => p.error)?.error || '',
  };
}

/**
 * One banner in place of N identical failure rows. Alarm rail, classified
 * reason, raw text behind a disclosure, and a Retry that re-runs generation.
 */
export default function FailureBanner({ run, sinceLabel, onRetry, retrying = false, canRetry = true }) {
  const { t } = useTranslation('planner');
  const [showRaw, setShowRaw] = useState(false);
  if (!run) return null;
  const { reason, key } = classifyPlanError(run.error);
  const n = run.count;
  return (
    <Card rail="alarm" padding="md" className="mb-4" role="alert" data-testid="planner-failure-banner">
      <div className="flex flex-col sm:flex-row sm:items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <StatusPill state="alarm" filled>{t('failure.pill')}</StatusPill>
          </div>
          <p className="font-display text-base font-semibold text-ink">
            {t('failure.headline', { count: n, since: sinceLabel || run.since })}
          </p>
          <p className="text-sm text-ink mt-1" data-testid="planner-failure-reason" dir={key ? undefined : 'auto'}>{key ? t(`failure.reason.${key}`) : reason}</p>
          {run.error && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setShowRaw((v) => !v)}
                className="text-xs font-semibold text-muted hover:text-ink underline"
              >
                {showRaw ? t('failure.hideRaw') : t('failure.showRaw')}
              </button>
              {showRaw && (
                <pre dir="ltr" className="text-start mt-1 text-xs font-mono whitespace-pre-wrap break-words bg-field border border-line rounded-md p-2 max-h-40 overflow-y-auto text-muted">
                  {run.error}
                </pre>
              )}
            </div>
          )}
        </div>
        <div className="shrink-0 sm:self-center">
          <Button
            variant="secondary"
            size="sm"
            className="w-full sm:w-auto"
            onClick={onRetry}
            disabled={!canRetry || retrying}
            title={!canRetry ? t('failure.retryNotAllowed') : t('failure.retryTitle')}
            data-testid="planner-retry"
          >
            {retrying ? t('failure.retrying') : t('common:actions.retry')}
          </Button>
        </div>
      </div>
    </Card>
  );
}
