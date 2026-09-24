import React from 'react';
import { Card, Button, StatusPill } from '../../ui';
import { timeAgo } from './relativeTime';

const SEVERITY_STATE = { critical: 'alarm', warning: 'caution', info: 'water' };

/**
 * One alert as a list row: the rail and pill carry severity, the message is
 * the main line (full text, wraps), and Acknowledge is always visible on the
 * right (stacked under the text at phone width). Viewers see the button
 * disabled, not hidden.
 */
export default function AlertCard({ alert, canAcknowledge, acknowledging, onAcknowledge, formatDateTime }) {
  const state = SEVERITY_STATE[alert.severity] || 'idle';
  const acked = !!alert.acknowledged;
  const repeats = alert.occurrence_count || 1;
  const where = alert.equipment_name || alert.zone_name || null;
  const firstSeen = alert.created_at;
  const lastSeen = repeats > 1 ? (alert.last_seen_at || alert.created_at) : null;

  const Stamp = ({ label, ts }) => (
    <span>
      {label}{' '}
      <span className="font-mono tabular text-ink" title={formatDateTime ? formatDateTime(ts) : ts}>
        {timeAgo(ts) || '—'}
      </span>
    </span>
  );

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
            <StatusPill state={state} filled={!acked}>{alert.severity}</StatusPill>
            {repeats > 1 && (
              <span
                className="inline-flex items-center rounded-full border border-line bg-field px-2 py-0.5 text-xs font-mono tabular font-semibold text-ink"
                title={`This condition has recurred ${repeats.toLocaleString()} times since it was first raised`}
                data-testid="alert-repeats"
              >
                &times;{repeats.toLocaleString()}
              </span>
            )}
          </div>
          <p className="text-sm text-ink whitespace-pre-wrap break-words">{alert.message}</p>
          <p className="mt-1.5 text-xs text-muted flex flex-wrap gap-x-1.5 gap-y-0.5">
            {where && <span className="font-medium text-ink">{where}</span>}
            {where && <span aria-hidden="true">·</span>}
            {alert.source && <span>{alert.source}</span>}
            {alert.source && <span aria-hidden="true">·</span>}
            <Stamp label="first seen" ts={firstSeen} />
            {lastSeen && <span aria-hidden="true">·</span>}
            {lastSeen && <Stamp label="last seen" ts={lastSeen} />}
          </p>
        </div>

        <div className="shrink-0 sm:pl-2 sm:self-center">
          {acked ? (
            <StatusPill state="ok" filled>
              Acknowledged{alert.acknowledged_by_name ? ` by ${alert.acknowledged_by_name}` : ''}
            </StatusPill>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              className="w-full sm:w-auto"
              disabled={!canAcknowledge || acknowledging}
              title={!canAcknowledge ? 'Viewers cannot acknowledge alerts' : undefined}
              onClick={() => onAcknowledge?.(alert.id)}
              data-testid="alert-ack"
            >
              {acknowledging ? 'Acknowledging…' : 'Acknowledge'}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
