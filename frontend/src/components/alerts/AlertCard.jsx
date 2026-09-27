import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Button, StatusPill } from '../../ui';
import { useFormat } from '../../i18n/useFormat';

const SEVERITY_STATE = { critical: 'alarm', warning: 'caution', info: 'water' };

/**
 * One alert as a list row: the rail and pill carry severity, the message is
 * the main line (full text, wraps), and Acknowledge is always visible on the
 * end side (stacked under the text at phone width). Viewers see the button
 * disabled, not hidden.
 *
 * `alert.message` arrives already localized by the backend (Accept-Language);
 * `alert.message_en` is the stored English text, offered behind a toggle.
 */
export default function AlertCard({ alert, canAcknowledge, acknowledging, onAcknowledge, formatDateTime }) {
  const { t } = useTranslation('alerts');
  const fmt = useFormat();
  const [showOriginal, setShowOriginal] = useState(false);
  const state = SEVERITY_STATE[alert.severity] || 'idle';
  const acked = !!alert.acknowledged;
  const repeats = alert.occurrence_count || 1;
  const where = alert.equipment_name || alert.zone_name || null;
  const firstSeen = alert.created_at;
  const lastSeen = repeats > 1 ? (alert.last_seen_at || alert.created_at) : null;
  const hasOriginal = !!alert.message_en && alert.message_en !== alert.message;
  const message = showOriginal && hasOriginal ? alert.message_en : alert.message;

  const stamp = (label, ts) => {
    const rel = ts ? fmt.relative(ts, { thresholdHours: Infinity }) : '—';
    return (
      <span>
        {label}{' '}
        <span className="font-mono tabular text-ink" title={formatDateTime ? formatDateTime(ts) : fmt.dateTime(ts)}>
          {rel === '-' ? '—' : rel}
        </span>
      </span>
    );
  };

  return (
    <Card
      rail={acked ? 'idle' : state}
      padding="md"
      className={acked ? 'opacity-75' : ''}
      data-testid="alert-card"
      data-severity={alert.severity}
    >
      <div className="flex flex-col sm:flex-row sm:items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 mb-1.5">
            <StatusPill state={state} filled={!acked}>
              {t(`common:severity.${alert.severity}`, { defaultValue: alert.severity })}
            </StatusPill>
            {repeats > 1 && (
              <span
                className="inline-flex items-center rounded-full border border-line bg-field px-2 py-0.5 text-xs font-mono tabular font-semibold text-ink"
                title={t('card.repeatsTitle', { count: repeats, n: fmt.int(repeats) })}
                data-testid="alert-repeats"
              >
                &times;{fmt.int(repeats)}
              </span>
            )}
          </div>
          {/* server text: localized by the backend; English original behind the toggle */}
          <p
            className="text-sm text-ink whitespace-pre-wrap break-words"
            dir="auto"
            lang={showOriginal && hasOriginal ? 'en' : undefined}
          >
            {message}
          </p>
          <p className="mt-1.5 text-xs text-muted flex flex-wrap gap-x-1.5 gap-y-0.5">
            {where && <span className="font-medium text-ink" dir="auto">{where}</span>}
            {where && <span aria-hidden="true">·</span>}
            {alert.source && <span dir="auto">{alert.source}</span>}
            {alert.source && <span aria-hidden="true">·</span>}
            {stamp(t('card.firstSeen'), firstSeen)}
            {lastSeen && <span aria-hidden="true">·</span>}
            {lastSeen && stamp(t('card.lastSeen'), lastSeen)}
            {hasOriginal && <span aria-hidden="true">·</span>}
            {hasOriginal && (
              <button
                type="button"
                className="underline decoration-dotted underline-offset-2 hover:text-ink focus:outline-none focus:ring-2 focus:ring-brand-500 rounded-sm"
                onClick={() => setShowOriginal((v) => !v)}
                aria-pressed={showOriginal}
                data-testid="alert-original-toggle"
              >
                {showOriginal ? t('card.showTranslation') : t('card.showOriginal')}
              </button>
            )}
          </p>
        </div>

        <div className="shrink-0 sm:ps-2 sm:self-center">
          {acked ? (
            <StatusPill state="ok" filled>
              {alert.acknowledged_by_name
                ? t('card.acknowledgedBy', { name: alert.acknowledged_by_name })
                : t('card.acknowledged')}
            </StatusPill>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              className="w-full sm:w-auto"
              disabled={!canAcknowledge || acknowledging}
              title={!canAcknowledge ? t('viewerCannotAck') : undefined}
              onClick={() => onAcknowledge?.(alert.id)}
              data-testid="alert-ack"
            >
              {acknowledging ? t('acknowledging') : t('card.acknowledge')}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
