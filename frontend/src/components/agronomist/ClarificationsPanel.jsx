import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../../context/ToastContext';
import { useFormat } from '../../i18n/useFormat';
import { Button, Card, Label } from '../../ui';

const API_BASE = '/api';

/**
 * Operator notes on a report. "Add note only" stores the note; "Add &
 * regenerate" stores it and re-runs the report with the note in the prompt.
 * onUpdated(report) gets the regenerated report, or null after a plain note.
 */
export default function ClarificationsPanel({ report, canControl, headers, onUpdated }) {
  const { t } = useTranslation('agronomist');
  const fmt = useFormat();
  const { showError, showSuccess } = useToast();
  const [message, setMessage] = useState('');
  const [posting, setPosting] = useState(null); // 'add' | 'regenerate' | null
  const clarifications = report?.clarifications || [];

  const post = async (regenerate) => {
    if (!message.trim()) {
      showError(t('discussion.typeFirst'));
      return;
    }
    if (regenerate && !window.confirm(t('discussion.confirmRegenerate'))) return;

    setPosting(regenerate ? 'regenerate' : 'add');
    try {
      const res = await fetch(`${API_BASE}/agronomist/reports/${report.id}/clarifications`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ message: message.trim(), regenerate: !!regenerate }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // The clarification itself is saved even when regeneration fails; reload so
        // the thread and the kept report's 'regenerate failed' marker show.
        if (data.clarification) { setMessage(''); onUpdated(null); }
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setMessage('');
      if (regenerate && data.regenerated) {
        showSuccess(t('discussion.toastRegenerated'));
        onUpdated(data.report);
      } else {
        showSuccess(regenerate ? t('discussion.toastSavedRegenFailed') : t('discussion.toastPosted'));
        onUpdated(null);
      }
    } catch (err) {
      showError(err.message);
    } finally {
      setPosting(null);
    }
  };

  return (
    <Card data-testid="report-clarifications">
      <div className="flex items-baseline justify-between mb-2 flex-wrap gap-2">
        <Label as="h3">{t('discussion.title')}</Label>
        <span className="text-xs text-muted font-mono">
          {t('count.note', { count: clarifications.length })}
        </span>
      </div>

      <p className="text-sm text-muted mb-4 max-w-prose">
        {t('discussion.help')}
      </p>

      {clarifications.length > 0 ? (
        <ul className="space-y-2 mb-4">
          {clarifications.map(c => (
            <li key={c.id} className="bg-field rounded-md p-3 border-s-[3px] border-s-brand-500">
              <div className="flex items-baseline justify-between flex-wrap gap-x-2">
                <span className="text-xs font-semibold text-ink" dir="auto">{c.user_name || t('discussion.anonymous')}</span>
                <span className="text-xs text-muted font-mono">
                  {fmt.dateTime(c.created_at)}
                  {c.triggered_regenerate ? ` · ${t('discussion.triggeredRegen')}` : ''}
                </span>
              </div>
              <p className="text-sm text-ink mt-1 whitespace-pre-wrap break-words" dir="auto">{c.message}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted mb-4">{t('discussion.empty')}</p>
      )}

      {canControl && (
        <div className="space-y-2">
          <label htmlFor={`clarification-${report.id}`} className="sr-only">{t('discussion.fieldLabel')}</label>
          <textarea
            id={`clarification-${report.id}`}
            value={message}
            onChange={e => setMessage(e.target.value)}
            disabled={!!posting}
            placeholder={t('discussion.placeholder')}
            rows={3}
            dir="auto"
            className="w-full"
          />
          <div className="flex flex-wrap items-center gap-2 justify-end">
            <span className="text-xs text-muted font-mono me-auto">{t('discussion.chars', { count: message.length })}</span>
            <Button variant="secondary" size="sm" onClick={() => post(false)} disabled={!!posting || !message.trim()}>
              {posting === 'add' ? t('common:actions.saving') : t('discussion.addOnly')}
            </Button>
            <Button variant="primary" size="sm" onClick={() => post(true)} disabled={!!posting || !message.trim()}>
              {posting === 'regenerate' ? t('discussion.regenerating') : t('discussion.addAndRegenerate')}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
