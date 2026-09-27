import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, StatusPill } from '../../ui';

const SEVERITY_STATE = { critical: 'alarm', warning: 'caution', info: 'idle' };

/**
 * Attention row: only what needs attention. When nothing does, one quiet line.
 */
export default function AttentionRow({ alerts, automations, system, formatRelativeTime }) {
  const { t } = useTranslation('dashboard');
  const critical = alerts?.critical || 0;
  const warning = alerts?.warning || 0;
  const info = alerts?.info || 0;
  const disarmed = !!automations?.disarmed?.disarmed;
  const pollingPaused = !!system?.pollingPaused;
  const disabled = Array.isArray(system?.disabledDevices) ? system.disabledDevices.length : 0;
  const online = system?.devicesOnline ?? 0;
  const total = system?.devicesTotal ?? 0;
  const offline = Math.max(0, total - online);
  const camera = system?.camera || null;
  const cameraBad = camera && camera.status !== 'online';

  const items = [];
  const cameraStatus = (s) => (s ? t(`attention.cameraStatus.${s}`, { defaultValue: s }) : t('common:status.unknown'));
  if (critical > 0) items.push({ key: 'critical', state: 'alarm', filled: true, to: '/alerts', text: t('attention.critical', { count: critical }) });
  if (warning > 0) items.push({ key: 'warning', state: 'caution', filled: true, to: '/alerts', text: t('attention.warning', { count: warning }) });
  if (info > 0) items.push({ key: 'info', state: 'idle', filled: false, to: '/alerts', text: t('attention.info', { count: info }) });
  if (disarmed) items.push({ key: 'disarmed', state: 'alarm', filled: false, to: '/automations', text: t('attention.disarmed') });
  if (pollingPaused) items.push({ key: 'paused', state: 'caution', filled: false, to: '/equipment', text: t('attention.pollingPaused') });
  if (offline > 0) items.push({ key: 'offline', state: 'alarm', filled: false, to: '/equipment', text: t('attention.devicesOffline', { count: offline, total }) });
  if (disabled > 0) items.push({ key: 'disabled', state: 'idle', filled: false, to: '/equipment', text: t('attention.devicesDisabled', { count: disabled }) });
  if (cameraBad) items.push({ key: 'camera', state: 'caution', filled: false, to: '/cameras', text: t('attention.camera', { name: camera.name, status: cameraStatus(camera.status) }) });

  const latest = Array.isArray(alerts?.latest) ? alerts.latest : [];
  const quiet = items.length === 0;

  const fine = [];
  if (critical + warning + info === 0) fine.push(t('attention.noAlerts'));
  if (offline === 0 && total > 0) fine.push(t('attention.allOnline', { count: total }));
  if (!disarmed) fine.push(t('attention.armed'));
  if (camera && !cameraBad) fine.push(t('attention.cameraOk', { status: cameraStatus(camera.status) }));

  const worst = critical > 0 || disarmed || offline > 0 ? 'alarm' : items.length > 0 ? 'caution' : 'ok';

  return (
    <Card rail={worst} padding="sm" data-testid="attention-row">
      {quiet ? (
        <p className="text-sm text-muted">{fine.join(' · ')}</p>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {items.map((it) => (
              <Link key={it.key} to={it.to} className="rounded-full focus:outline-none">
                <StatusPill state={it.state} filled={it.filled}>{it.text}</StatusPill>
              </Link>
            ))}
          </div>
          {latest.length > 0 && (
            <ul className="divide-y divide-line text-sm">
              {latest.map((a) => {
                const firstLine = String(a.message || '').split('\n')[0];
                return (
                  <li key={a.id} className="flex items-start gap-2 py-1.5 min-w-0">
                    <StatusPill state={SEVERITY_STATE[a.severity] || 'idle'} filled={a.severity === 'critical'} className="shrink-0">
                      {t(`common:severity.${a.severity}`, { defaultValue: a.severity })}
                    </StatusPill>
                    {/* server text: already localized by the backend (Accept-Language) */}
                    <span className="min-w-0 flex-1 truncate text-ink" dir="auto" title={a.message}>{firstLine}</span>
                    {a.occurrence_count > 1 && (
                      <span className="shrink-0 font-mono tabular text-muted">&times;{a.occurrence_count}</span>
                    )}
                    {formatRelativeTime && a.ts && (
                      <span className="shrink-0 hidden sm:inline font-mono tabular text-xs text-muted">{formatRelativeTime(a.ts)}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {fine.length > 0 && <p className="text-xs text-muted">{fine.join(' · ')}</p>}
        </div>
      )}
    </Card>
  );
}
