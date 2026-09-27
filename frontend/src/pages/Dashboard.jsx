import React, { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { useWebSocket } from '../context/WebSocketContext';
import { useSettings } from '../context/SettingsContext';
import { useToast } from '../context/ToastContext';
import { useThrottledError } from '../hooks/useThrottledError';
import { usePendingRelayCommands } from '../hooks/usePendingRelayCommands';
import { useFormat } from '../i18n/useFormat';
import { Button, SectionHeader, StatusPill } from '../ui';
import { TIME_RANGES } from '../components/dashboard/constants';
import { useStatusBoard } from '../components/dashboard/useStatusBoard';
import NowStrip from '../components/dashboard/NowStrip';
import AttentionRow from '../components/dashboard/AttentionRow';
import RunningGroups from '../components/dashboard/RunningGroups';
import AutomationsPanel from '../components/dashboard/AutomationsPanel';
import TrendsPanel, { useTrendSeries } from '../components/dashboard/TrendsPanel';
import CropRecord from '../components/dashboard/CropRecord';
import IrrigationCard from '../components/dashboard/IrrigationCard';

/**
 * Operator STATUS BOARD.
 *
 * Top to bottom: Now (12 climate readings), Attention (only what is abnormal),
 * Irrigation (live flow / zone / dosing from the MQTT monitor), What's running
 * (relay groups), Automations, Trends, Cloud crop record.
 * Data: GET /api/dashboard/status-board every 15 s patched by WebSocket
 * relay_state_changed / sensor_reading events; chart series from
 * GET /api/dashboard/overview on range change and every 5 min.
 *
 * i18n reference page: every visible string is in locales/<lng>/dashboard.json
 * (irrigation card: irrigation.json); numbers/times go through useFormat().
 */
export default function Dashboard() {
  const { t } = useTranslation('dashboard');
  const { token, user } = useAuth();
  const { subscribe, connected } = useWebSocket();
  const { showError, showSuccess } = useToast();
  const { timezone, formatTime, formatDate, formatRelativeTime } = useSettings();
  const fmt = useFormat();
  const notifyBackgroundError = useThrottledError(showError);
  const { markPending, getPending } = usePendingRelayCommands(subscribe);

  const [hours, setHours] = useState('24');
  const [refreshing, setRefreshing] = useState(false);

  const { board, equipmentById, loading, fetchedAt, refresh } = useStatusBoard({ token, subscribe, notifyError: notifyBackgroundError });
  const trends = useTrendSeries({ token, hours, notifyError: notifyBackgroundError });

  const canControl = user?.role === 'admin' || user?.role === 'operator';
  const disarmed = !!board?.automations?.disarmed?.disarmed;

  const sinceFormatter = useCallback((ts) => fmt.since(ts, { fallback: t('common:reading.unknownTime') }), [fmt, t]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try { await Promise.all([refresh(), trends.refresh()]); } finally { setRefreshing(false); }
  };

  const clockFormatter = useCallback((ms) => fmt.clock(ms), [fmt]);

  const nowLabel = useMemo(() => (fetchedAt ? fmt.time(fetchedAt) : null), [fetchedAt, fmt]);
  const rangeLabel = (value) => t(`range.${value}`, { defaultValue: value });

  return (
    <div className="space-y-6" data-testid="dashboard">
      {/* 1. Now */}
      <section aria-label={t('now.title')}>
        <SectionHeader
          title={t('now.title')}
          subtitle={nowLabel
            ? `${t('now.boardRead', { time: nowLabel })}${connected ? '' : ` · ${t('now.liveDisconnected')}`}`
            : t('common:status.loadingShort')}
          right={(
            <>
              <label className="sr-only" htmlFor="trend-range">{t('trends.rangeLabel')}</label>
              <select
                id="trend-range"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                className="min-h-[36px] text-sm font-mono tabular"
                aria-label={t('trends.rangeAria')}
              >
                {TIME_RANGES.map((r) => <option key={r.value} value={r.value}>{rangeLabel(r.value)}</option>)}
              </select>
              <Button size="sm" variant="ghost" onClick={handleRefresh} disabled={refreshing} aria-label={t('common:actions.refresh')}>
                {refreshing ? t('common:actions.refreshing') : t('common:actions.refresh')}
              </Button>
            </>
          )}
        />
        {loading && !board ? (
          <p className="text-sm text-muted">{t('now.loadingBoard')}</p>
        ) : (
          <NowStrip climate={board?.climate || []} formatSince={sinceFormatter} now={Date.now()} />
        )}
      </section>

      {/* 2. Attention */}
      {board && (
        <section aria-label={t('attention.title')}>
          <AttentionRow alerts={board.alerts} automations={board.automations} system={board.system} formatRelativeTime={formatRelativeTime} />
        </section>
      )}

      {/* 3. Irrigation (safety-relevant: live flow vs open zone vs dosing) */}
      <IrrigationCard token={token} subscribe={subscribe} board={board} formatClock={clockFormatter} />

      {/* 4 + 5. What's running / Automations */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <section aria-label={t('running.aria')}>
          <SectionHeader
            title={t('running.title')}
            subtitle={board?.system
              ? t('running.subtitle', {
                online: board.system.devicesOnline,
                total: board.system.devicesTotal,
                boards: t('running.heartbeatBoards', { count: board.system.heartbeatDeviceCount ?? 0 }),
              })
              : undefined}
            right={board?.system?.pollingPaused ? <StatusPill state="caution">{t('running.pollingPaused')}</StatusPill> : null}
          />
          <RunningGroups
            groups={board?.relayGroups || []}
            equipmentById={equipmentById}
            canControl={canControl}
            token={token}
            markPending={markPending}
            getPending={getPending}
            showError={showError}
            showSuccess={showSuccess}
            formatTime={formatTime}
          />
        </section>

        <section aria-label={t('automations.title')}>
          <SectionHeader
            title={t('automations.title')}
            right={(
              <>
                <StatusPill state={disarmed ? 'alarm' : 'ok'} filled={!disarmed}>
                  {disarmed ? t('common:status.disarmed') : t('common:status.armed')}
                </StatusPill>
                <Link to="/automations" className="text-sm text-muted underline">{t('common:actions.open')}</Link>
              </>
            )}
          />
          <AutomationsPanel automations={board?.automations} formatRelativeTime={formatRelativeTime} formatTime={formatTime} />
        </section>
      </div>

      {/* 6. Trends */}
      <section aria-label={t('trends.title')}>
        <SectionHeader
          title={t('trends.title')}
          subtitle={t('trends.subtitle', { range: rangeLabel(hours) })}
          right={(
            <span className="text-xs text-muted">
              {t('trends.energy')} <Link to="/reports" className="underline">{t('trends.seeReports')}</Link>
            </span>
          )}
        />
        <TrendsPanel
          rows={trends.rows}
          hours={hours}
          disabledDevices={board?.system?.disabledDevices || []}
          timezone={board?.timezone || timezone}
          loading={trends.loading}
        />
      </section>

      {/* 7. Cloud crop record */}
      <CropRecord token={token} formatDate={formatDate} notifyError={notifyBackgroundError} />
    </div>
  );
}
