import React from 'react';
import { Card, StatusPill, Button } from '../../ui';
import { TRIGGER_LABELS, relativeTime } from './automationSummary';

export function TriggerChip({ type }) {
  return (
    <span className="inline-flex items-center rounded border border-line px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-label text-muted whitespace-nowrap">
      {TRIGGER_LABELS[type] || type}
    </span>
  );
}

/**
 * One automation as a card row. The rail carries state (ok = enabled,
 * idle = disabled, caution = targets equipment that is disabled/offline) and
 * is always paired with a pill so the state reads without colour.
 */
export default function AutomationRow({
  auto, summary, enabled, offline = [], duplicate = false, doseProgram, doseMissing = false,
  canEdit, busy = {}, onView, onEdit, onToggle, onRun, onDuplicate, onDelete,
}) {
  const rail = enabled ? (offline.length ? 'caution' : 'ok') : 'idle';
  const runs = auto.run_count || 0;
  const isManual = summary.triggerType === 'manual';

  return (
    <Card as="li" rail={rail} padding="none" className="list-none" data-automation-id={auto.id}>
      <div className="p-3 sm:p-4 flex flex-col lg:flex-row lg:items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <button
              type="button"
              onClick={onView}
              className="inline-flex items-center min-h-touch font-display font-semibold text-ink text-left hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded-sm"
            >
              {auto.name}
            </button>
            <span className="text-xs font-mono tabular text-muted">#{auto.id}</span>
            <StatusPill state={enabled ? 'ok' : 'idle'} filled={enabled}>{enabled ? 'Enabled' : 'Disabled'}</StatusPill>
            <TriggerChip type={summary.triggerType} />
            {offline.length > 0 && (
              <StatusPill state="caution" filled title={`Targets equipment that is disabled or offline: ${offline.join(', ')}`}>
                offline: {offline.join(', ')}
              </StatusPill>
            )}
            {duplicate && <StatusPill state="caution">duplicate name</StatusPill>}
            {auto.template_id && (
              <span className="inline-flex items-center rounded border border-line px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-label text-muted" title="Linked to a template: actions are managed by the template">
                Template
              </span>
            )}
            {doseProgram && (
              <StatusPill state="water" filled title={`Dose program drives Waveshare Irrigation 2 injector valves while this automation runs. Strategy: ${doseProgram.compatibility_strategy || 'permissive'}`}>
                Dose: {doseProgram.name}
              </StatusPill>
            )}
            {doseMissing && (
              <StatusPill state="alarm" filled title="References a dose program that no longer exists">
                Dose #{auto.dose_program_id} missing
              </StatusPill>
            )}
          </div>

          <p className="mt-1.5 text-sm text-ink leading-5" title={summary.long} data-testid="automation-summary">
            <span className="font-mono tabular">{summary.when}</span>
            <span className="text-muted mx-1.5" aria-hidden="true">→</span>
            <span>{summary.what}</span>
          </p>

          <p className="mt-1 text-xs font-mono tabular text-muted">
            last run {relativeTime(auto.last_run)} · {runs} run{runs === 1 ? '' : 's'}
          </p>
        </div>

        {canEdit ? (
          <div className="flex flex-wrap gap-2 lg:justify-end lg:shrink-0">
            {isManual && enabled && (
              <Button variant="secondary" onClick={onRun} disabled={!!busy.run} title="Run this automation now">
                {busy.run ? 'Running…' : 'Run'}
              </Button>
            )}
            <Button variant="ghost" onClick={onToggle} disabled={!!busy.toggle}>
              {busy.toggle ? '…' : enabled ? 'Disable' : 'Enable'}
            </Button>
            <Button variant="secondary" onClick={onEdit}>Edit</Button>
            <Button variant="ghost" onClick={onDuplicate} disabled={!!busy.duplicate} title="Duplicate (created disabled)">
              {busy.duplicate ? 'Duplicating…' : 'Duplicate'}
            </Button>
            <Button variant="danger-ghost" onClick={onDelete}>Delete</Button>
          </div>
        ) : (
          <div className="lg:shrink-0">
            <Button variant="ghost" onClick={onView}>View</Button>
          </div>
        )}
      </div>
    </Card>
  );
}
