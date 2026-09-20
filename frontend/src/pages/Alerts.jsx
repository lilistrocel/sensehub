import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useSettings } from '../context/SettingsContext';

const PAGE_SIZE = 100;

export default function Alerts() {
  const { token, user } = useAuth();
  const { showError, showSuccess } = useToast();
  const { formatDateTime, formatRelativeTime } = useSettings();
  const [alerts, setAlerts] = useState([]);
  const [total, setTotal] = useState(0);
  const [unacknowledgedCount, setUnacknowledgedCount] = useState(0);
  const [equipment, setEquipment] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [acknowledgingAll, setAcknowledgingAll] = useState(false);
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
        throw new Error('Failed to fetch alerts');
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
        setEquipment(data);
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
      const response = await fetch(`/api/alerts/${alertId}/acknowledge`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
      if (!response.ok) {
        throw new Error('Failed to acknowledge alert');
      }
      fetchAlerts();
      showSuccess('Alert acknowledged');
    } catch (err) {
      showError(err.message, 'Failed to acknowledge alert');
    }
  };

  const handleAcknowledgeAll = async () => {
    const scope = [];
    if (severityFilter !== 'all') scope.push(`severity "${severityFilter}"`);
    if (equipmentFilter !== 'all' && equipmentFilter !== 'none') {
      const eq = equipment.find((e) => String(e.id) === equipmentFilter);
      scope.push(`equipment "${eq?.name || equipmentFilter}"`);
    }
    const scopeText = scope.length ? ` matching ${scope.join(' and ')}` : '';
    if (!window.confirm(`Acknowledge ALL ${unacknowledgedCount.toLocaleString()} open alerts${scopeText}? This cannot be undone.`)) {
      return;
    }
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
        throw new Error(data.message || data.error || 'Failed to acknowledge alerts');
      }
      showSuccess(`Acknowledged ${Number(data.acknowledged || 0).toLocaleString()} alerts`);
      fetchAlerts();
    } catch (err) {
      showError(err.message, 'Failed to acknowledge alerts');
    } finally {
      setAcknowledgingAll(false);
    }
  };

  const getSeverityBadge = (severity) => {
    const colors = {
      critical: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
      warning: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
      info: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
    };
    return colors[severity] || 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300';
  };

  const getSeverityIcon = (severity) => {
    switch (severity) {
      case 'critical':
        return (
          <svg className="w-5 h-5 text-red-500" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
          </svg>
        );
      case 'warning':
        return (
          <svg className="w-5 h-5 text-amber-500" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
        );
      default:
        return (
          <svg className="w-5 h-5 text-blue-500" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
          </svg>
        );
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
        alert.message.toLowerCase().includes(query) ||
        (alert.equipment_name && alert.equipment_name.toLowerCase().includes(query)) ||
        (alert.zone_name && alert.zone_name.toLowerCase().includes(query)) ||
        (alert.source && alert.source.toLowerCase().includes(query))
      );
    }
    return true;
  });

  const canAcknowledge = user?.role === 'admin' || user?.role === 'operator';
  const hasMore = alerts.length < total;
  const collapsedDuplicates = alerts.reduce((sum, a) => sum + Math.max((a.occurrence_count || 1) - 1, 0), 0);

  if (loading && alerts.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
        <p className="text-red-800 dark:text-red-200">Error: {error}</p>
        <button
          onClick={() => fetchAlerts()}
          className="mt-2 text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 underline"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap justify-between items-center gap-3 mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Alerts</h1>
        <div className="flex items-center gap-2">
          {canAcknowledge && unacknowledgedCount > 0 && (
            <button
              onClick={handleAcknowledgeAll}
              disabled={acknowledgingAll}
              className="inline-flex items-center px-3 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              title="Acknowledge every open alert matching the current severity / equipment filter"
            >
              <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
              {acknowledgingAll ? 'Acknowledging...' : 'Acknowledge all'}
            </button>
          )}
          <button
            onClick={() => fetchAlerts()}
            className="inline-flex items-center px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4 mb-6">
        <div className="flex flex-wrap gap-4">
          {/* Search */}
          <div className="flex-1 min-w-[200px]">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Search</label>
            <input
              type="text"
              placeholder="Search loaded alerts..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400"
            />
          </div>

          {/* Severity Filter */}
          <div className="w-full sm:w-40">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Severity</label>
            <select
              value={severityFilter}
              onChange={(e) => setSeverityFilter(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400"
            >
              <option value="all">All Severities</option>
              <option value="critical">Critical</option>
              <option value="warning">Warning</option>
              <option value="info">Info</option>
            </select>
          </div>

          {/* Acknowledged Filter */}
          <div className="w-full sm:w-48">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Status</label>
            <select
              value={acknowledgedFilter}
              onChange={(e) => setAcknowledgedFilter(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400"
            >
              <option value="unacknowledged">Unacknowledged</option>
              <option value="acknowledged">Acknowledged</option>
              <option value="all">All Alerts</option>
            </select>
          </div>

          {/* Equipment Filter */}
          <div className="w-full sm:w-48">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Equipment</label>
            <select
              value={equipmentFilter}
              onChange={(e) => setEquipmentFilter(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400"
            >
              <option value="all">All Equipment</option>
              <option value="none">No Equipment</option>
              {equipment.map((eq) => (
                <option key={eq.id} value={eq.id}>
                  {eq.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Matching Filters</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">{total.toLocaleString()}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Unacknowledged (all)</p>
          <p className="text-2xl font-bold text-blue-600">{unacknowledgedCount.toLocaleString()}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Critical (loaded)</p>
          <p className="text-2xl font-bold text-red-600">
            {alerts.filter((a) => a.severity === 'critical').length}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Repeats collapsed (loaded)</p>
          <p className="text-2xl font-bold text-amber-600">{collapsedDuplicates.toLocaleString()}</p>
        </div>
      </div>

      {/* Alerts Table */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-900">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Message
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Severity
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Equipment
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Timestamp
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Status
                </th>
                {canAcknowledge && (
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Actions
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
              {filteredAlerts.length === 0 ? (
                <tr>
                  <td colSpan={canAcknowledge ? 6 : 5} className="px-6 py-12 text-center text-gray-500 dark:text-gray-400">
                    {alerts.length === 0
                      ? (acknowledgedFilter === 'unacknowledged' ? 'No open alerts. Everything is acknowledged.' : 'No alerts in the system.')
                      : 'No alerts match your search.'}
                  </td>
                </tr>
              ) : (
                filteredAlerts.map((alert) => {
                  const repeats = alert.occurrence_count || 1;
                  return (
                    <tr key={alert.id} className={alert.acknowledged ? 'bg-gray-50 dark:bg-gray-900' : ''}>
                      <td className="px-6 py-4">
                        <div className="flex items-start">
                          <span className="flex-shrink-0 mr-3">{getSeverityIcon(alert.severity)}</span>
                          <div className="min-w-0">
                            <span className="text-sm text-gray-900 dark:text-white">{alert.message}</span>
                            {repeats > 1 && (
                              <span
                                className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-200 text-gray-800 dark:bg-gray-700 dark:text-gray-200 align-middle"
                                title={`This condition has recurred ${repeats.toLocaleString()} times since it was first raised`}
                              >
                                &times;{repeats.toLocaleString()}
                              </span>
                            )}
                            {alert.source && (
                              <span className="block text-xs text-gray-400 dark:text-gray-500 mt-0.5">source: {alert.source}</span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getSeverityBadge(alert.severity)}`}>
                          {alert.severity}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="text-sm text-gray-500 dark:text-gray-400">
                          {alert.equipment_name || alert.zone_name || '-'}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                        <div title={formatDateTime(alert.created_at)}>{formatRelativeTime(alert.created_at)}</div>
                        {repeats > 1 && alert.last_seen_at && (
                          <div className="text-xs text-gray-400 dark:text-gray-500" title={formatDateTime(alert.last_seen_at)}>
                            last seen {formatRelativeTime(alert.last_seen_at)}
                          </div>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        {alert.acknowledged ? (
                          <div className="flex flex-col">
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300">
                              <svg className="w-3 h-3 mr-1" fill="currentColor" viewBox="0 0 20 20">
                                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                              </svg>
                              Acknowledged
                            </span>
                            {alert.acknowledged_by_name && (
                              <span className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                by {alert.acknowledged_by_name}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300">
                            <svg className="w-3 h-3 mr-1" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
                            </svg>
                            Pending
                          </span>
                        )}
                      </td>
                      {canAcknowledge && (
                        <td className="px-6 py-4 whitespace-nowrap text-sm">
                          {!alert.acknowledged && (
                            <button
                              onClick={() => handleAcknowledge(alert.id)}
                              className="text-blue-600 hover:text-blue-900 dark:text-blue-400 dark:hover:text-blue-300 font-medium"
                            >
                              Acknowledge
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="bg-gray-50 dark:bg-gray-900 px-6 py-3 border-t border-gray-200 dark:border-gray-700 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Showing {filteredAlerts.length.toLocaleString()} of {total.toLocaleString()} alerts
            {searchQuery && filteredAlerts.length !== alerts.length ? ` (${alerts.length.toLocaleString()} loaded)` : ''}
          </p>
          {hasMore && (
            <button
              onClick={() => fetchAlerts({ append: true })}
              disabled={loadingMore}
              className="inline-flex items-center px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-md text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
            >
              {loadingMore ? 'Loading...' : `Load more (${Math.min(PAGE_SIZE, total - alerts.length).toLocaleString()})`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
