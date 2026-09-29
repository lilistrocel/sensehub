import React, { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Label, Button, StatusPill } from '../../ui';
import ConfirmDialog from '../ConfirmDialog';
import ReportMarkdown from '../agronomist/ReportMarkdown';
import { ReportTextContext, reportTextProps } from '../agronomist/reportText';
import { StatusMark, SectionStatusPill } from '../agronomist/SectionStatus';
import { useFormat } from '../../i18n/useFormat';
import { usePoll } from '../../hooks/usePoll';
import { normalizeLanguage } from '../../i18n/languages';
import { SourceBadge } from './parts';
import { shapeOf, railOf, warningState, isStaleAdvice, VS_PROTOCOL } from './nutritionUtil';

/**
 * AI fertilizer advisor — a SECOND OPINION on the human agronomist's protocol.
 * Advisory only: nothing is applied automatically. AI text is never translated
 * in the browser; the backend sends tr / ar when ready (translation_status).
 *
 * Operator notes (2026-09-29): an optional "Notes for this run" goes with a
 * manual run as context for the AI (observations to verify, never instructions);
 * the report shows the notes as written and the AI's answer to them.
 */

export const MAX_NOTES = 1000;

const TRIGGERS = ['manual', 'weekly', 'stage_change', 'tank_change', 'ratio_change'];
const ERROR_CLASSES = ['billing', 'auth', 'rate_limit', 'truncated_output', 'max_tokens', 'refusal', 'other'];
const DAYS = [0, 1, 2, 3, 4, 5, 6];
const pad2 = (n) => String(parseInt(n, 10) || 0).padStart(2, '0');

const VS_STYLE = {
  agrees: 'border-line text-ink',
  extends: 'border-brand-300 text-brand-700 dark:border-brand-700 dark:text-brand-300',
  differs: 'border-caution-300 text-caution-700 dark:border-caution-700 dark:text-caution-300',
};
const VS_ICON = { agrees: '=', extends: '+', differs: '≠' };

function VsProtocolBadge({ value }) {
  const { t } = useTranslation('nutrition');
  const v = VS_PROTOCOL.includes(value) ? value : 'agrees';
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap ${VS_STYLE[v]}`} data-vs-protocol={v}>
      <span aria-hidden="true" className="font-mono">{VS_ICON[v]}</span>{t(`advisor.vs.${v}`)}
    </span>
  );
}

function PriorityTag({ value }) {
  const { t } = useTranslation('nutrition');
  return <span className="inline-block rounded bg-field px-1.5 py-0.5 text-[11px] font-bold uppercase text-ink" data-priority={value}>{t(`advisor.priority.${value}`, { defaultValue: value })}</span>;
}

export default function AdvisorPanel({ api, canEdit, isAdmin }) {
  const { t, i18n } = useTranslation('nutrition');
  const fmt = useFormat();
  const ui = normalizeLanguage(i18n.language) || 'en';
  const [latest, setLatest] = useState(null);
  const [config, setConfig] = useState(null);
  const [history, setHistory] = useState(null);
  const [selected, setSelected] = useState(null); // advice loaded from the history (null = latest)
  const [original, setOriginal] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [estimate, setEstimate] = useState(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState(null);
  const [notes, setNotes] = useState('');
  const notesId = useId();
  const trimmedNotes = notes.trim();

  const load = useCallback(async () => {
    try {
      const [l, c, h] = await Promise.all([
        api.get(`/nutrition/advice/latest${original ? '?original=1' : ''}`),
        api.get('/nutrition/advisor/config'),
        api.get('/nutrition/advice?limit=20'),
      ]);
      setLatest(l); setConfig(c); setHistory(h); setError(null);
    } catch (e) { setError(e.message); }
  }, [api, original]);
  const running = !!(latest && latest.running);
  const pendingTr = latest?.advice?.translation_status === 'pending';
  usePoll(load, running ? 8000 : pendingTr ? 15000 : 120000);

  const loadOne = async (id) => {
    try { setSelected(await api.get(`/nutrition/advice/${id}${original ? '?original=1' : ''}`)); } catch (e) { setError(e.message); }
  };
  useEffect(() => { if (selected) loadOne(selected.id); }, [original]); // eslint-disable-line react-hooks/exhaustive-deps

  const askRun = async () => {
    setConfirm(true);
    setEstimate(null);
    try { setEstimate(await api.get('/nutrition/advisor/estimate')); } catch (_) { setEstimate({ error: true }); }
  };
  const run = async () => {
    setStarting(true);
    try {
      await api.send('POST', '/nutrition/advice/run', trimmedNotes ? { notes: trimmedNotes } : {});
      setConfirm(false);
      setSelected(null);
      setNotes('');
      await load();
    } catch (e) {
      setError(e.message);
      setConfirm(false);
    } finally {
      setStarting(false);
    }
  };

  const adv = selected || latest?.advice || null;
  const health = config?.health;

  return (
    <div className="space-y-4">
      <Card padding="sm" rail="idle" data-testid="advisor-advisory-note">
        <div className="flex flex-wrap items-start gap-2 text-sm">
          <SourceBadge kind="ai" />
          <p className="min-w-0 flex-1">{t('advisor.advisoryOnly')}</p>
        </div>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {config && (
            <>
              <StatusPill state={config.enabled && config.weekly_enabled ? 'ok' : 'idle'} filled={!!(config.enabled && config.weekly_enabled)}
                text={config.enabled && config.weekly_enabled ? t('advisor.weekly', { day: t(`advisor.day.${config.weekly_day}`), time: `${pad2(config.weekly_hour)}:${pad2(config.weekly_minute)}` }) : t('advisor.weeklyOff')} />
              <StatusPill state={config.enabled && config.auto_enabled ? 'ok' : 'idle'} filled={!!(config.enabled && config.auto_enabled)} text={config.enabled && config.auto_enabled ? t('advisor.autoOn') : t('advisor.autoOff')} />
              <span className="font-mono text-xs text-muted hidden sm:inline">{config.model}</span>
            </>
          )}
        </div>
        {canEdit && (
          <Button variant="primary" onClick={askRun} disabled={running || starting || !config?.api_key_present} data-testid="advisor-run"
            title={!config?.api_key_present ? t('advisor.noKey') : undefined}>
            {running ? t('advisor.running') : t('advisor.run')}
          </Button>
        )}
      </div>

      {canEdit && (
        <div className="rounded-card border border-line bg-panel p-3" data-testid="advisor-notes-input">
          <label htmlFor={notesId} className="block text-sm font-semibold text-ink">{t('advisor.notes.label')}</label>
          <textarea
            id={notesId}
            value={notes}
            onChange={(e) => setNotes(e.target.value.slice(0, MAX_NOTES))}
            maxLength={MAX_NOTES}
            rows={3}
            dir="auto"
            disabled={running || starting}
            placeholder={t('advisor.notes.placeholder')}
            aria-describedby={`${notesId}-help`}
            className="mt-1 w-full min-h-[72px] rounded-md border border-line bg-panel px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <div className="mt-0.5 flex flex-wrap justify-between gap-2 text-xs text-muted">
            <span id={`${notesId}-help`}>{t('advisor.notes.help')}</span>
            <span className="font-mono" dir="ltr">{t('advisor.notes.count', { count: notes.length, max: MAX_NOTES })}</span>
          </div>
        </div>
      )}

      {config && !config.api_key_present && <Card rail="caution" padding="sm" className="text-sm">{t('advisor.noKey')}</Card>}
      {error && <Card rail="alarm" padding="sm"><p role="alert" className="text-sm">{t('errors.loadFailed', { error })}</p></Card>}

      {health && (health.paused || health.consecutive_failures > 0) && (
        <Card rail={health.paused ? 'alarm' : 'caution'} padding="sm" className="text-sm" data-testid="advisor-health">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill state={health.paused ? 'alarm' : 'caution'} filled text={health.paused ? t('advisor.health.paused') : t('advisor.health.failing')} />
            <strong>{t(`advisor.errorClass.${ERROR_CLASSES.includes(health.last_error_class) ? health.last_error_class : 'other'}`)}</strong>
            <span className="text-muted">{t('advisor.health.failures', { count: health.consecutive_failures })}</span>
          </div>
          {health.paused && <p className="mt-1">{t('advisor.health.pausedHelp')}</p>}
        </Card>
      )}

      {latest?.newer && !selected && (
        <Card rail={latest.newer.status === 'running' ? 'water' : 'caution'} padding="sm" className="text-sm" data-testid="advisor-newer">
          {latest.newer.status === 'running' ? (
            <div className="flex flex-wrap items-center gap-2"><StatusPill state="water" pulse text={t('advisor.running')} /><span>{t('advisor.runningHelp')}</span></div>
          ) : (
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill state="caution" filled text={t('advisor.lastRunFailed')} />
                <span>{t('advisor.failedAt', { time: fmt.dateTime(latest.newer.created_at), reason: t(`advisor.errorClass.${ERROR_CLASSES.includes(latest.newer.error_class) ? latest.newer.error_class : 'other'}`) })}</span>
              </div>
              {latest.advice && <p className="text-muted mt-1">{t('advisor.keptGood')}</p>}
            </div>
          )}
        </Card>
      )}

      {selected && (
        <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>{t('advisor.backToLatest')}</Button>
      )}

      {!adv ? (
        <Card padding="md" data-testid="advisor-empty">
          <p className="text-sm text-muted">{latest === null ? t('common:status.loading') : t('advisor.none')}</p>
        </Card>
      ) : adv.status === 'success' && adv.advice ? (
        <AdviceView adv={adv} ui={ui} original={original} onToggleOriginal={() => setOriginal(o => !o)} />
      ) : (
        <Card rail={adv.status === 'running' ? 'water' : 'caution'} padding="md">
          <p className="text-sm">{adv.status === 'running' ? t('advisor.runningHelp') : t('advisor.failedAt', { time: fmt.dateTime(adv.created_at), reason: t(`advisor.errorClass.${ERROR_CLASSES.includes(adv.error_class) ? adv.error_class : 'other'}`) })}</p>
          {adv.error && <pre dir="ltr" className="mt-2 text-xs font-mono whitespace-pre-wrap break-words bg-field border border-line p-2 rounded max-h-32 overflow-y-auto text-start">{adv.error}</pre>}
          {adv.operator_notes && <OperatorNotes notes={adv.operator_notes} />}
        </Card>
      )}

      <HistoryList history={history} selectedId={adv?.id} onSelect={(id) => (latest?.advice?.id === id ? setSelected(null) : loadOne(id))} />

      {config && <AdvisorSettings config={config} isAdmin={isAdmin} api={api} onSaved={load} />}

      <ConfirmDialog
        open={confirm}
        title={t('advisor.confirmTitle')}
        body={(
          <div className="space-y-2">
            <p>{t('advisor.confirmBody')}</p>
            <p className="font-semibold" data-testid="advisor-estimate">
              {estimate && !estimate.error
                ? t('advisor.estimate', { usd: fmt.number(estimate.usd_est, { decimals: 2 }), high: fmt.number(estimate.usd_high, { decimals: 2 }), model: estimate.model })
                : estimate && estimate.error ? t('advisor.estimateFailed') : t('common:status.loading')}
            </p>
            {trimmedNotes && (
              <div data-testid="advisor-confirm-notes">
                <p className="text-xs font-semibold">{t('advisor.notes.confirm')}</p>
                <p className="text-xs whitespace-pre-wrap break-words border-s-2 border-line ps-2 max-h-24 overflow-y-auto" dir="auto">{trimmedNotes}</p>
              </div>
            )}
            <p className="text-xs text-muted">{t('advisor.advisoryOnlyShort')}</p>
          </div>
        )}
        confirmLabel={t('advisor.run')}
        busy={starting}
        onConfirm={run}
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
}

function AdviceView({ adv, ui, original, onToggleOriginal }) {
  const { t } = useTranslation('nutrition');
  const fmt = useFormat();
  const a = adv.advice;
  const textProps = reportTextProps(adv, ui);
  const stale = isStaleAdvice(adv.created_at);
  const trigger = TRIGGERS.includes(adv.trigger) ? adv.trigger : 'manual';
  return (
    <ReportTextContext.Provider value={textProps}>
      <Card rail={stale ? 'stale' : railOf(a.status)} padding="md" data-testid="advisor-advice" data-advice-status={a.status}>
        <div className="flex flex-wrap items-center gap-2">
          <SectionStatusPill status={a.status} />
          {stale && <StatusPill state="caution" text={t('advisor.stale')} />}
          <span className="text-xs text-muted">
            {t('advisor.generated', { time: fmt.dateTime(adv.created_at), trigger: t(`advisor.trigger.${trigger}`) })}
          </span>
          <span className="text-xs text-muted font-mono hidden sm:inline">{adv.model}{adv.cost_estimate != null ? ` · $${fmt.number(adv.cost_estimate, { decimals: 3 })}` : ''}</span>
        </div>

        {ui !== 'en' && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted" data-testid="advisor-translation" data-translation-status={original ? 'shown-original' : adv.translation_status}>
            {original ? <span>{t('advisor.translation.showingOriginal')}</span>
              : adv.translation_status === 'ready' ? <span>{t('advisor.translation.auto')}</span>
              : adv.translation_status === 'pending' ? <><StatusPill state="idle" pulse text={t('advisor.translation.pending')} /><span>{t('advisor.translation.pendingHelp')}</span></>
              : adv.translation_status === 'failed' ? <><StatusPill state="caution" filled text={t('advisor.translation.failed')} /><span>{t('advisor.translation.failedHelp')}</span></>
              : <span>{t('advisor.translation.englishOnly')}</span>}
            {(original || adv.translation_status === 'ready') && (
              <Button variant="ghost" size="sm" onClick={onToggleOriginal}>{original ? t('advisor.translation.showTranslation') : t('advisor.translation.showOriginal')}</Button>
            )}
          </div>
        )}

        {adv.operator_notes && <OperatorNotes notes={adv.operator_notes} />}

        <p className="mt-3 text-base text-ink" {...textProps} data-testid="advisor-summary">{a.summary}</p>

        {a.operator_notes_response && (
          <div className="mt-4" data-testid="advisor-notes-response">
            <Label>{t('advisor.notes.response')}</Label>
            <div className="mt-1"><ReportMarkdown markdown={a.operator_notes_response} /></div>
          </div>
        )}

        {a.warnings.length > 0 && (
          <div className="mt-4" data-testid="advisor-warnings">
            <Label>{t('advisor.warnings')}</Label>
            <ul className="mt-1 space-y-1.5">
              {a.warnings.map((w, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span className="mt-0.5"><StatusMark status={warningState(w.severity) === 'idle' ? 'unknown' : warningState(w.severity)} /></span>
                  <span className="min-w-0"><span className="font-semibold me-1">{t(`advisor.severity.${w.severity}`, { defaultValue: w.severity })}:</span><span {...textProps}>{w.message}</span></span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-4" data-testid="advisor-recommendations">
          <Label>{t('advisor.recommendations')}</Label>
          <ol className="mt-1 space-y-2">
            {a.recommendations.map((r, i) => (
              <li key={i} className="rounded-md border border-line p-2.5">
                <div className="flex flex-wrap items-center gap-1.5 mb-1">
                  <PriorityTag value={r.priority} />
                  <VsProtocolBadge value={r.vs_protocol} />
                  {r.when && <span className="text-xs text-muted">{t('advisor.when')}: <span {...textProps}>{r.when}</span></span>}
                </div>
                <p className="text-sm font-semibold text-ink" {...textProps}>{r.action}</p>
                {r.rationale && <p className="text-sm text-muted mt-0.5" {...textProps}>{r.rationale}</p>}
                {r.vs_protocol_reason && <p className="text-xs mt-1"><span className="text-muted">{t('advisor.vsReason')}: </span><span {...textProps}>{r.vs_protocol_reason}</span></p>}
              </li>
            ))}
          </ol>
        </div>

        <div className="mt-4" data-testid="advisor-elements">
          <Label>{t('advisor.perElement')}</Label>
          <ul className="mt-1 grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1">
            {a.per_element.map(e => (
              <li key={e.element} className="flex items-start gap-2 text-sm min-w-0" data-element={e.element} data-status={e.status}>
                <span className="mt-0.5"><StatusMark status={shapeOf(e.status, 'caution')} /></span>
                <span className="font-semibold w-6 shrink-0" lang="en">{e.element}</span>
                <span className="text-xs text-muted w-14 shrink-0 mt-0.5">{t(`cmp.${e.status}`)}</span>
                <span className="min-w-0 break-words" {...textProps}>{e.comment}</span>
              </li>
            ))}
          </ul>
        </div>

        {a.questions_for_operator.length > 0 && (
          <div className="mt-4" data-testid="advisor-questions">
            <Label>{t('advisor.questions')}</Label>
            <ul className="mt-1 list-disc ps-5 text-sm space-y-0.5">
              {a.questions_for_operator.map((q, i) => <li key={i} {...textProps}>{q}</li>)}
            </ul>
          </div>
        )}

        <details className="mt-4 group" data-testid="advisor-analysis">
          <summary className="cursor-pointer select-none text-sm font-semibold text-ink">{t('advisor.analysis')}</summary>
          <div className="mt-2"><ReportMarkdown markdown={a.analysis_markdown} /></div>
        </details>
      </Card>
    </ReportTextContext.Provider>
  );
}

/** The operator's notes for a run, as written (not translated). */
function OperatorNotes({ notes }) {
  const { t } = useTranslation('nutrition');
  return (
    <div className="mt-3 rounded-md border border-line bg-field p-2.5" data-testid="advisor-operator-notes">
      <Label>{t('advisor.notes.title')}</Label>
      <p className="mt-1 text-sm whitespace-pre-wrap break-words" dir="auto">{notes}</p>
    </div>
  );
}

function HistoryList({ history, selectedId, onSelect }) {
  const { t } = useTranslation('nutrition');
  const fmt = useFormat();
  if (!history || !history.items || history.items.length === 0) return null;
  return (
    <Card padding="md" data-testid="advisor-history">
      <h2 className="font-display text-base font-semibold text-ink mb-2">{t('advisor.history')}</h2>
      <ul className="divide-y divide-line">
        {history.items.map(h => {
          const shape = h.status === 'success' ? (h.advice_status || 'unknown') : h.status === 'running' ? 'unknown' : 'caution';
          return (
            <li key={h.id}>
              <button type="button" onClick={() => onSelect(h.id)} disabled={h.status === 'running'}
                className={`w-full text-start py-2 flex items-start gap-2 text-sm hover:bg-field rounded px-1 ${selectedId === h.id ? 'bg-field' : ''}`}>
                <span className="mt-0.5"><StatusMark status={shapeOf(shape)} /></span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap gap-x-2 text-xs text-muted">
                    <span className="font-mono">{fmt.dateTime(h.created_at)}</span>
                    <span>{t(`advisor.trigger.${TRIGGERS.includes(h.trigger) ? h.trigger : 'manual'}`)}</span>
                    {h.status !== 'success' && <span className="font-semibold">{h.status === 'running' ? t('advisor.running') : t('advisor.errorClass.' + (ERROR_CLASSES.includes(h.error_class) ? h.error_class : 'other'))}</span>}
                  </span>
                  {h.summary && <span className="block truncate" dir="auto">{h.summary}</span>}
                  {h.operator_notes && <span className="block truncate text-xs text-muted" dir="auto" data-testid="advisor-history-notes">{t('advisor.notes.history', { notes: h.operator_notes })}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function AdvisorSettings({ config, isAdmin, api, onSaved }) {
  const { t } = useTranslation('nutrition');
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const d = draft || config;
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.send('PUT', '/nutrition/advisor/config', {
        enabled: d.enabled, weekly_enabled: d.weekly_enabled, weekly_day: Number(d.weekly_day),
        weekly_hour: Number(d.weekly_hour), weekly_minute: Number(d.weekly_minute), auto_enabled: d.auto_enabled,
      });
      setDraft(null);
      onSaved();
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  };
  const set = (k, v) => setDraft({ ...d, [k]: v });
  return (
    <details className="rounded-card border border-line bg-panel p-4" data-testid="advisor-settings">
      <summary className="cursor-pointer select-none font-display text-base font-semibold text-ink">{t('advisor.settings.title')}</summary>
      <div className="mt-3 space-y-3 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" disabled={!isAdmin} checked={!!d.enabled} onChange={(e) => set('enabled', e.target.checked)} />{t('advisor.settings.enabled')}</label>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2"><input type="checkbox" disabled={!isAdmin} checked={!!d.weekly_enabled} onChange={(e) => set('weekly_enabled', e.target.checked)} />{t('advisor.settings.weekly')}</label>
          <select aria-label={t('advisor.settings.day')} disabled={!isAdmin} value={d.weekly_day} onChange={(e) => set('weekly_day', e.target.value)} className="min-h-[36px] rounded-md border border-line bg-panel px-2 text-sm">
            {DAYS.map(x => <option key={x} value={x}>{t(`advisor.day.${x}`)}</option>)}
          </select>
          <input aria-label={t('advisor.settings.time')} type="time" dir="ltr" disabled={!isAdmin} value={`${pad2(d.weekly_hour)}:${pad2(d.weekly_minute)}`}
            onChange={(e) => { const [h, m] = e.target.value.split(':'); setDraft({ ...d, weekly_hour: h, weekly_minute: m }); }}
            className="min-h-[36px] rounded-md border border-line bg-panel px-2 text-sm" />
        </div>
        <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" disabled={!isAdmin} checked={!!d.auto_enabled} onChange={(e) => set('auto_enabled', e.target.checked)} /><span>{t('advisor.settings.auto')}<span className="block text-xs text-muted">{t('advisor.settings.autoHelp', { hours: config.auto_min_interval_hours, minutes: config.auto_debounce_minutes })}</span></span></label>
        {isAdmin ? (
          <div className="flex gap-2">
            <Button variant="primary" size="sm" disabled={!draft || saving} onClick={save}>{saving ? t('common:actions.saving') : t('common:actions.save')}</Button>
            {draft && <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>{t('common:actions.cancel')}</Button>}
          </div>
        ) : <p className="text-xs text-muted">{t('advisor.settings.adminOnly')}</p>}
        {error && <p role="alert" className="text-state-alarm">{t('errors.saveFailed', { error })}</p>}
      </div>
    </details>
  );
}
