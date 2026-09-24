import React, { useState } from 'react';
import { Card, Button, StatusPill } from '../../ui';

/**
 * Turn the raw error text of a failed plan into one operator-readable line.
 * Returns { reason, kind } where kind is 'credits' | 'auth' | 'other'.
 */
export function classifyPlanError(text) {
  const s = String(text || '').trim();
  if (!s) return { reason: 'No error detail recorded', kind: 'other' };
  if (/credit balance/i.test(s)) {
    return { reason: 'Anthropic API credits exhausted — top up at Plans & Billing', kind: 'credits' };
  }
  if (/\b40[13]\b|unauthori[sz]ed|forbidden|invalid (api[ _-]?key|x-api-key)|authentication_error/i.test(s)) {
    return { reason: 'API key rejected', kind: 'auth' };
  }
  const oneLine = s.replace(/\s+/g, ' ');
  return { reason: oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine, kind: 'other' };
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
  const [showRaw, setShowRaw] = useState(false);
  if (!run) return null;
  const { reason } = classifyPlanError(run.error);
  const n = run.count;
  return (
    <Card rail="alarm" padding="md" className="mb-4" role="alert" data-testid="planner-failure-banner">
      <div className="flex flex-col sm:flex-row sm:items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <StatusPill state="alarm" filled>Generation failing</StatusPill>
          </div>
          <p className="font-display text-base font-semibold text-ink">
            Plan generation has failed {n} day{n === 1 ? '' : 's'} in a row since{' '}
            <span className="font-mono tabular">{sinceLabel || run.since}</span>
          </p>
          <p className="text-sm text-ink mt-1" data-testid="planner-failure-reason">{reason}</p>
          {run.error && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setShowRaw((v) => !v)}
                className="text-xs font-semibold text-muted hover:text-ink underline"
              >
                {showRaw ? 'Hide raw error' : 'Show raw error'}
              </button>
              {showRaw && (
                <pre className="mt-1 text-xs font-mono whitespace-pre-wrap break-words bg-field border border-line rounded-md p-2 max-h-40 overflow-y-auto text-muted">
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
            title={!canRetry ? 'Operators and admins can retry generation' : 'Run plan generation again now'}
            data-testid="planner-retry"
          >
            {retrying ? 'Retrying…' : 'Retry'}
          </Button>
        </div>
      </div>
    </Card>
  );
}
