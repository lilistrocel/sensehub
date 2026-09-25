import React, { useState } from 'react';
import { useToast } from '../../context/ToastContext';
import { Button, Card, Label } from '../../ui';

const API_BASE = '/api';

/**
 * Operator notes on a report. "Add note only" stores the note; "Add &
 * regenerate" stores it and re-runs the report with the note in the prompt.
 * onUpdated(report) gets the regenerated report, or null after a plain note.
 */
export default function ClarificationsPanel({ report, canControl, headers, onUpdated }) {
  const { showError, showSuccess } = useToast();
  const [message, setMessage] = useState('');
  const [posting, setPosting] = useState(null); // 'add' | 'regenerate' | null
  const clarifications = report?.clarifications || [];

  const post = async (regenerate) => {
    if (!message.trim()) {
      showError('Type a clarification before posting');
      return;
    }
    if (regenerate && !window.confirm(
      'Regenerate the report now with this clarification? This will call Claude and replace the current report if the new one passes its checks. If regeneration fails, the current report is kept.'
    )) return;

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
        showSuccess('Clarification posted and report regenerated');
        onUpdated(data.report);
      } else {
        showSuccess(regenerate ? 'Clarification saved (regeneration failed — see error)' : 'Clarification posted');
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
        <Label as="h3">Clarifications & discussion</Label>
        <span className="text-xs text-muted font-mono">
          {clarifications.length} note{clarifications.length === 1 ? '' : 's'}
        </span>
      </div>

      <p className="text-sm text-muted mb-4 max-w-prose">
        Add context the agent doesn't know about — broken sensors, recent maintenance, "ignore today's pH because the probe is uncalibrated", etc. Notes are stored permanently and injected into the prompt on regeneration, so the new report (and any future weekly rollup) reflects your correction.
      </p>

      {clarifications.length > 0 ? (
        <ul className="space-y-2 mb-4">
          {clarifications.map(c => (
            <li key={c.id} className="bg-field rounded-md p-3 border-l-[3px] border-l-brand-500">
              <div className="flex items-baseline justify-between flex-wrap gap-x-2">
                <span className="text-xs font-semibold text-ink">{c.user_name || 'Anonymous'}</span>
                <span className="text-xs text-muted font-mono">
                  {new Date(c.created_at).toLocaleString()}
                  {c.triggered_regenerate ? ' · triggered regeneration' : ''}
                </span>
              </div>
              <p className="text-sm text-ink mt-1 whitespace-pre-wrap break-words">{c.message}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted mb-4">No clarifications yet.</p>
      )}

      {canControl && (
        <div className="space-y-2">
          <label htmlFor={`clarification-${report.id}`} className="sr-only">Clarification</label>
          <textarea
            id={`clarification-${report.id}`}
            value={message}
            onChange={e => setMessage(e.target.value)}
            disabled={!!posting}
            placeholder="Add context, correct an assumption, or flag a sensor issue. Example: 'The AMIC pH probe is uncalibrated — ignore pH readings until further notice.'"
            rows={3}
            className="w-full"
          />
          <div className="flex flex-wrap items-center gap-2 justify-end">
            <span className="text-xs text-muted font-mono mr-auto">{message.length} chars</span>
            <Button variant="secondary" size="sm" onClick={() => post(false)} disabled={!!posting || !message.trim()}>
              {posting === 'add' ? 'Saving…' : 'Add note only'}
            </Button>
            <Button variant="primary" size="sm" onClick={() => post(true)} disabled={!!posting || !message.trim()}>
              {posting === 'regenerate' ? 'Regenerating…' : 'Add & regenerate report'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
