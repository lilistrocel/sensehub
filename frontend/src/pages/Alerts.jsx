import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '../i18n/useFormat';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useSettings } from '../context/SettingsContext';
import { Card, Label, Button } from '../ui';
import ConfirmDialog from '../components/ConfirmDialog';
import AlertCard from '../components/alerts/AlertCard';

const PAGE_SIZE = 100;

const selectCls = 'w-full min-h-touch px-3 py-2 bg-field text-ink border border-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-500';

export default function Alerts() {
  const { t } = useTranslation('alerts');
  const fmt = useFormat();
  const { token, user } = useAuth();
  const { showError, showSuccess } = useToast();
  const { formatDateTime } = useSettings();
  const [alerts, setAlerts] = useState([]);
  const [total, setTotal] = useState(0);
  const [unacknowledgedCount, setUnacknowledgedCount] = useState(0);
  const [equipment, setEquipment] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [acknowledgingAll, setAcknowledgingAll] = useState(false);
  const [acknowledgingId, setAcknowledgingId] = useState(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [error, setError] = useState(null);
  const [severityFilter, setSeverityFilter] = useState('all');
  const [acknowledgedFilter, setAcknowledgedFilter] = useState('unacknowledged');
  const [equipmentFilter, setEquipmentFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  const buildQuery = useCallback((offset) => {
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String(offset));
    if (acknowledgedFilter === 'unacknowledged') params.set('acknowledged', 'false');
    if (acknowledgedFilter === 'acknowledged') params.set('acknowledged', 'true');
    if (severityFilter !== 'all') params.set('severity', severityFilter);
    if (equipmentFilter !== 'all' && equipmentFilter !== 'none') params.set('equipment_id', equipmentFilter);
    return params.toString();
  }, [acknowledgedFilter, severityFilter, equipmentFilter]);

  const fetchAlerts = useCallback(async ({ append = false } = {}) => {
    const offset = append ? alerts.length : 0;
    try {
      if (append) setLoadingMore(true); else setLoading(true);
      const response = await fetch(`/api/alerts?${buildQuery(offset)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      // Backwards compatibility: tolerate a bare array from an older backend.
      const items = Array.isArray(data) ? data : (data.items || []);
      setAlerts((prev) => (append ? [...prev, ...items] : items));
      setTotal(Array.isArray(data) ? items.length : (data.total ?? items.length));
      setUnacknowledgedCount(Array.isArray(data) ? items.filter((a) => !a.acknowledged).length : (data.unacknowledged ?? 0));
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, buildQuery, alerts.length]);

  const fetchEquipment = async () => {
    try {
      const response = await fetch('/api/equipment', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        const data = await response.json();
        setEquipment(Array.isArray(data) ? data : []);
      }
    } catch (err) {
      console.error('Failed to fetch equipment:', err);
    }
  };

  useEffect(() => {
    fetchEquipment();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    fetchAlerts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, severityFilter, acknowledgedFilter, equipmentFilter]);

  const handleAcknowledge = async (alertId) => {
    try {
      setAcknowledgingId(alertId);
      const response = await fetch(`/api/alerts/${alertId}/acknowledge`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      fetchAlerts();
      showSuccess(t('toast.acknowledged'));
    } catch (err) {
      showError(err.message, t('toast.ackFailed'));
    } finally {
      setAcknowledgingId(null);
    }
  };

  // What "Acknowledge all" will touch: the server applies severity / equipment,
  // never the client-side "no equipment" or search refinements.
  const ackScope = useMemo(() => {
    const items = [];
    items.push(severityFilter !== 'all'
      ? t('scope.severity', { severity: t(`common:severity.${severityFilter}`, { defaultValue: severityFilter }) })
      : t('filters.allSeverities'));
    if (equipmentFilter !== 'all' && equipmentFilter !== 'none') {
      const eq = equipment.find((e) => String(e.id) === equipmentFilter);
      items.push(t('scope.equipment', { name: eq?.name || equipmentFilter }));
    } else {
      items.push(t('filters.allEquipment'));
    }
    const count = acknowledgedFilter === 'unacknowledged' ? total : unacknowledgedCount;
    return { items, count };
  }, [severityFilter, equipmentFilter, acknowledgedFilter, equipment, total, unacknowledgedCount, t]);

  const handleAcknowledgeAll = async () => {
    const body = {};
    if (severityFilter !== 'all') body.severity = severityFilter;
    if (equipmentFilter !== 'all' && equipmentFilter !== 'none') body.equipment_id = Number(equipmentFilter);
    try {
      setAcknowledgingAll(true);
      const response = await fetch('/api/alerts/acknowledge-all', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.message || data.error || `HTTP ${response.status}`);
      }
      const n = Number(data.acknowledged || 0);
      showSuccess(t('toast.acknowledgedMany', { count: n, n: fmt.int(n) }));
      setConfirmAll(false);
      fetchAlerts();
    } catch (err) {
      showError(err.message, t('toast.ackAllFailed'));
    } finally {
      setAcknowledgingAll(false);
    }
  };

  // Client-side refinements on the loaded page (server handles severity / status / equipment id)
  const filteredAlerts = alerts.filter((alert) => {
    if (equipmentFilter === 'none' && alert.equipment_id) {
      return false;
    }
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      return (
        String(alert.message || '').toLowerCase().includes(query) ||
        (alert.message_en && alert.message_en.toLowerCase().includes(query)) ||
        (alert.equipment_name && alert.equipment_name.toLowerCase().includes(query)) ||
        (alert.zone_name && alert.zone_name.toLowerCase().includes(query)) ||
        (alert.source && alert.source.toLowerCase().includes(query))
      );
    }
    return true;
  });

  const canAcknowledge = user?.role === 'admin' || user?.role === 'operator';
  const hasMore = alerts.length < total;
  const criticalLoaded = alerts.filter((a) => a.severity === 'critical' && !a.acknowledged).length;
  const collapsedDuplicates = alerts.reduce((sum, a) => sum + Math.max((a.occurrence_count || 1) - 1, 0), 0);

  if (loading && alerts.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
      </div>
    );
  }

  if (error) {
    return (
      <Card rail="alarm">
        <p className="text-sm text-ink">{t('errors.loadFailed', { error })}</p>
        <Button variant="secondary" size="sm" className="mt-3" onClick={() => fetchAlerts()}>{t('common:actions.tryAgain')}</Button>
      </Card>
    );
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex flex-wrap justify-between items-center gap-3 mb-4">
        <h1 className="font-display text-2xl font-bold text-ink">{t('title')}</h1>
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={() => setConfirmAll(true)}
            disabled={!canAcknowledge || acknowledgingAll || ackScope.count === 0}
            title={!canAcknowledge ? t('viewerCannotAck') : t('ackAllHelp')}
            data-testid="ack-all"
          >
            {acknowledgingAll ? t('acknowledging') : t('ackAll')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => fetchAlerts()} disabled={loading}>
            {t('common:actions.refresh')}
          </Button>
        </div>
      </div>

      {/* Summary line — one Label, not four tiles */}
      <Label as="p" className="mb-4 font-mono tabular" data-testid="alert-summary">
        {t('summary.open', { count: unacknowledgedCount, n: fmt.int(unacknowledgedCount) })}
        <span aria-hidden="true"> · </span>{t('summary.critical', { count: criticalLoaded, n: fmt.int(criticalLoaded) })}
        <span aria-hidden="true"> · </span>{t('summary.repeats', { count: collapsedDuplicates, n: fmt.int(collapsedDuplicates) })}
        {total > alerts.length && (
          <>
            <span aria-hidden="true"> · </span>{t('summary.loaded', { loaded: fmt.int(alerts.length), total: fmt.int(total) })}
          </>
        )}
      </Label>

      {/* Filters */}
      <Card padding="sm" className="mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_10rem_11rem_12rem] gap-3">
          <label className="block">
            <Label className="mb-1">{t('common:actions.search')}</Label>
            <input
              type="text"
              placeholder={t('filters.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className={selectCls}
            />
          </label>
          <label className="block">
            <Label className="mb-1">{t('filters.severity')}</Label>
            <select value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value)} className={selectCls}>
              <option value="all">{t('filters.allSeverities')}</option>
              <option value="critical">{t('filters.critical')}</option>
              <option value="warning">{t('filters.warning')}</option>
              <option value="info">{t('filters.info')}</option>
            </select>
          </label>
          <label className="block">
            <Label className="mb-1">{t('filters.status')}</Label>
            <select value={acknowledgedFilter} onChange={(e) => setAcknowledgedFilter(e.target.value)} className={selectCls}>
              <option value="unacknowledged">{t('filters.unacknowledged')}</option>
              <option value="acknowledged">{t('filters.acknowledged')}</option>
              <option value="all">{t('filters.allAlerts')}</option>
            </select>
          </label>
          <label className="block">
            <Label className="mb-1">{t('filters.equipment')}</Label>
            <select value={equipmentFilter} onChange={(e) => setEquipmentFilter(e.target.value)} className={selectCls}>
              <option value="all">{t('filters.allEquipment')}</option>
              <option value="none">{t('filters.noEquipment')}</option>
              {equipment.map((eq) => (
                <option key={eq.id} value={eq.id}>{eq.name}</option>
              ))}
            </select>
          </label>
        </div>
      </Card>

      {/* Alert list */}
      {filteredAlerts.length === 0 ? (
        <Card className="text-center text-sm text-muted py-10">
          {alerts.length === 0
            ? (acknowledgedFilter === 'unacknowledged' ? t('empty.noOpen') : t('empty.none'))
            : t('empty.noMatch')}
        </Card>
      ) : (
        <div className="space-y-2" data-testid="alert-list">
          {filteredAlerts.map((alert) => (
            <AlertCard
              key={alert.id}
              alert={alert}
              canAcknowledge={canAcknowledge}
              acknowledging={acknowledgingId === alert.id}
              onAcknowledge={handleAcknowledge}
              formatDateTime={formatDateTime}
            />
          ))}
        </div>
      )}

      {/* Footer */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted font-mono tabular">
          {t('footer.showing', { count: total, shown: fmt.int(filteredAlerts.length), total: fmt.int(total) })}
          {searchQuery && filteredAlerts.length !== alerts.length ? ` ${t('footer.loaded', { n: fmt.int(alerts.length) })}` : ''}
        </p>
        {hasMore && (
          <Button variant="secondary" size="sm" onClick={() => fetchAlerts({ append: true })} disabled={loadingMore}>
            {loadingMore ? t('common:status.loading') : t('loadMore', { n: fmt.int(Math.min(PAGE_SIZE, total - alerts.length)) })}
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={confirmAll}
        title={t('confirmAll.title')}
        body={t('confirmAll.body', { count: ackScope.count, n: fmt.int(ackScope.count) })}
        items={ackScope.items}
        confirmLabel={t('confirmAll.confirm', { n: fmt.int(ackScope.count) })}
        busy={acknowledgingAll}
        onConfirm={handleAcknowledgeAll}
        onCancel={() => setConfirmAll(false)}
      />
    </div>
  );
}
