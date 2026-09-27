import React from 'react';
import { useTranslation } from 'react-i18next';
import { Card, StatusPill, Button } from '../../ui';
import { TRIGGER_LABELS, relativeTime } from './automationSummary';
import { useSummaryLocale } from './useSummaryLocale';

/** Equipment the dose scheduler drives (a board name: data, never translated). */
export const DOSE_BOARD = 'Waveshare Irrigation 2';

export function TriggerChip({ type }) {
  const { t } = useTranslation('automations');
  return (
    <span className="inline-flex items-center rounded border border-line px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-label text-muted whitespace-nowrap">
      {t(`trigger.${type}`, { defaultValue: TRIGGER_LABELS[type] || type })}
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
  const { t } = useTranslation('automations');
  const loc = useSummaryLocale();
  const rail = enabled ? (offline.length ? 'caution' : 'ok') : 'idle';
  const offlineNames = offline.join(t('summary.joinComma'));
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
              className="inline-flex items-center min-h-touch font-display font-semibold text-ink text-start hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded-sm"
              dir="auto"
            >
              {auto.name}
            </button>
            <span className="text-xs font-mono tabular text-muted">#{auto.id}</span>
            <StatusPill state={enabled ? 'ok' : 'idle'} filled={enabled}>{enabled ? t('common:status.enabled') : t('common:status.disabled')}</StatusPill>
            <TriggerChip type={summary.triggerType} />
            {offline.length > 0 && (
              <StatusPill state="caution" filled title={t('row.offlineTitle', { names: offlineNames })}>
                {t('row.offline', { names: offlineNames })}
              </StatusPill>
            )}
            {duplicate && <StatusPill state="caution">{t('row.duplicateName')}</StatusPill>}
            {auto.template_id && (
              <span className="inline-flex items-center rounded border border-line px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-label text-muted" title={t('row.templateTitle')}>
                {t('row.template')}
              </span>
            )}
            {doseProgram && (
              <StatusPill
                state="water"
                filled
                title={t('row.doseTitle', {
                  board: DOSE_BOARD,
                  strategy: t(`doseStrategy.${doseProgram.compatibility_strategy || 'permissive'}`, { defaultValue: doseProgram.compatibility_strategy }),
                })}
              >
                {t('row.dose', { name: doseProgram.name })}
              </StatusPill>
            )}
            {doseMissing && (
              <StatusPill state="alarm" filled title={t('row.doseMissingTitle')}>
                {t('row.doseMissing', { id: auto.dose_program_id })}
              </StatusPill>
            )}
          </div>

          <p className="mt-1.5 text-sm text-ink leading-5" title={summary.long} data-testid="automation-summary">
            <span className="font-mono tabular">{summary.when}</span>
            <span className="inline-block text-muted mx-1.5 rtl:-scale-x-100" aria-hidden="true">→</span>
            <span>{summary.what}</span>
          </p>

          <p className="mt-1 text-xs font-mono tabular text-muted">
            {t('row.lastRun', { time: relativeTime(auto.last_run, undefined, loc), runs: t('row.runCount', { count: runs }) })}
          </p>
        </div>

        {canEdit ? (
          <div className="flex flex-wrap gap-2 lg:justify-end lg:shrink-0">
            {isManual && enabled && (
              <Button variant="secondary" onClick={onRun} disabled={!!busy.run} title={t('row.runTitle')}>
                {busy.run ? t('row.running') : t('row.run')}
              </Button>
            )}
            <Button variant="ghost" onClick={onToggle} disabled={!!busy.toggle}>
              {busy.toggle ? '…' : enabled ? t('row.disable') : t('row.enable')}
            </Button>
            <Button variant="secondary" onClick={onEdit}>{t('common:actions.edit')}</Button>
            <Button variant="ghost" onClick={onDuplicate} disabled={!!busy.duplicate} title={t('row.duplicateTitle')}>
              {busy.duplicate ? t('row.duplicating') : t('row.duplicate')}
            </Button>
            <Button variant="danger-ghost" onClick={onDelete}>{t('common:actions.delete')}</Button>
          </div>
        ) : (
          <div className="lg:shrink-0">
            <Button variant="ghost" onClick={onView}>{t('row.view')}</Button>
          </div>
        )}
      </div>
    </Card>
  );
}
