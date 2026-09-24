import React, { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useWebSocket } from '../context/WebSocketContext';
import { useSettings } from '../context/SettingsContext';
import { useToast } from '../context/ToastContext';
import { useThrottledError } from '../hooks/useThrottledError';
import { usePendingRelayCommands } from '../hooks/usePendingRelayCommands';
import { Button, SectionHeader, StatusPill } from '../ui';
import { formatSince } from '../utils/freshness';
import { TIME_RANGES } from '../components/dashboard/constants';
import { useStatusBoard } from '../components/dashboard/useStatusBoard';
import NowStrip from '../components/dashboard/NowStrip';
import AttentionRow from '../components/dashboard/AttentionRow';
import RunningGroups from '../components/dashboard/RunningGroups';
import AutomationsPanel from '../components/dashboard/AutomationsPanel';
import TrendsPanel, { useTrendSeries } from '../components/dashboard/TrendsPanel';
import CropRecord from '../components/dashboard/CropRecord';

/**
 * Operator STATUS BOARD.
 *
 * Top to bottom: Now (12 climate readings), Attention (only what is abnormal),
 * What's running (relay groups), Automations, Trends, Cloud crop record.
 * Data: GET /api/dashboard/status-board every 15 s patched by WebSocket
 * relay_state_changed / sensor_reading events; chart series from
 * GET /api/dashboard/overview on range change and every 5 min.
 */
export default function Dashboard() {
  const { token, user } = useAuth();
  const { subscribe, connected } = useWebSocket();
  const { showError, showSuccess } = useToast();
  const { timezone, formatTime, formatDate, formatRelativeTime } = useSettings();
  const notifyBackgroundError = useThrottledError(showError);
  const { markPending, getPending } = usePendingRelayCommands(subscribe);

  const [hours, setHours] = useState('24');
  const [refreshing, setRefreshing] = useState(false);

  const { board, equipmentById, loading, fetchedAt, refresh } = useStatusBoard({ token, subscribe, notifyError: notifyBackgroundError });
  const trends = useTrendSeries({ token, hours, notifyError: notifyBackgroundError });

  const canControl = user?.role === 'admin' || user?.role === 'operator';
  const disarmed = !!board?.automations?.disarmed?.disarmed;

  const sinceFormatter = useCallback((ts) => formatSince(ts, {
    format: (d, sameDay) => formatTime(d).replace(/:\d{2}(?=\s|$)/, '') + (sameDay ? '' : ` (${formatDate(d)})`),
  }), [formatTime, formatDate]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try { await Promise.all([refresh(), trends.refresh()]); } finally { setRefreshing(false); }
  };

  const nowLabel = useMemo(() => (fetchedAt ? formatTime(new Date(fetchedAt)) : null), [fetchedAt, formatTime]);

  return (
    <div className="space-y-6" data-testid="dashboard">
      {/* 1. Now */}
      <section aria-label="Now">
        <SectionHeader
          title="Now"
          subtitle={nowLabel ? `board read ${nowLabel}${connected ? '' : ' · live updates disconnected'}` : 'loading…'}
          right={(
            <>
              <label className="sr-only" htmlFor="trend-range">Trend range</label>
              <select
                id="trend-range"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                className="min-h-[36px] text-sm font-mono tabular"
                aria-label="Trend time range"
              >
                {TIME_RANGES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
              <Button size="sm" variant="ghost" onClick={handleRefresh} disabled={refreshing} aria-label="Refresh">
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </Button>
            </>
          )}
        />
        {loading && !board ? (
          <p className="text-sm text-muted">Loading status board…</p>
        ) : (
          <NowStrip climate={board?.climate || []} formatSince={sinceFormatter} now={Date.now()} />
        )}
      </section>

      {/* 2. Attention */}
      {board && (
        <section aria-label="Attention">
          <AttentionRow alerts={board.alerts} automations={board.automations} system={board.system} formatRelativeTime={formatRelativeTime} />
        </section>
      )}

      {/* 3 + 4. What's running / Automations */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <section aria-label="What is running">
          <SectionHeader
            title="What's running"
            subtitle={board?.system ? `${board.system.devicesOnline}/${board.system.devicesTotal} devices online · ${board.system.heartbeatDeviceCount} relay boards on heartbeat` : undefined}
            right={board?.system?.pollingPaused ? <StatusPill state="caution">Polling paused</StatusPill> : null}
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

        <section aria-label="Automations">
          <SectionHeader
            title="Automations"
            right={(
              <>
                <StatusPill state={disarmed ? 'alarm' : 'ok'} filled={!disarmed}>{disarmed ? 'Disarmed' : 'Armed'}</StatusPill>
                <Link to="/automations" className="text-sm text-muted underline">Open</Link>
              </>
            )}
          />
          <AutomationsPanel automations={board?.automations} formatRelativeTime={formatRelativeTime} formatTime={formatTime} />
        </section>
      </div>

      {/* 5. Trends */}
      <section aria-label="Trends">
        <SectionHeader
          title="Trends"
          subtitle={`last ${TIME_RANGES.find((r) => r.value === hours)?.label || hours}`}
          right={<span className="text-xs text-muted">Energy: <Link to="/reports" className="underline">see Reports</Link></span>}
        />
        <TrendsPanel
          rows={trends.rows}
          hours={hours}
          disabledDevices={board?.system?.disabledDevices || []}
          timezone={board?.timezone || timezone}
          loading={trends.loading}
        />
      </section>

      {/* 6. Cloud crop record */}
      <CropRecord token={token} formatDate={formatDate} notifyError={notifyBackgroundError} />
    </div>
  );
}
