import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

const API_BASE = '/api';

const formatBytes = (bytes) => {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
};

const formatUptime = (seconds) => {
  if (!seconds) return '-';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ');
};

const StatusDot = ({ status }) => {
  const colors = {
    online: 'bg-green-500',
    offline: 'bg-red-500',
    error: 'bg-red-500',
    unknown: 'bg-yellow-500',
  };
  return (
    <span className={`inline-block w-2.5 h-2.5 rounded-full ${colors[status] || colors.unknown}`} />
  );
};

const StatusBadge = ({ status }) => {
  const styles = {
    online: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
    offline: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
    error: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
    unknown: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
  };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${styles[status] || styles.unknown}`}>
      <StatusDot status={status} />
      {status}
    </span>
  );
};

export default function Debug() {
  const { token, user } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const isAdmin = user?.role === 'admin';

  const fetchStatus = async () => {
    try {
      const [servicesRes, infoRes] = await Promise.all([
        fetch(`${API_BASE}/system/services`, { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch(`${API_BASE}/system/info`, { headers: { 'Authorization': `Bearer ${token}` } }),
      ]);

      if (!servicesRes.ok) throw new Error(`Services: ${servicesRes.status}`);
      if (!infoRes.ok) throw new Error(`Info: ${infoRes.status}`);

      const [services, info] = await Promise.all([servicesRes.json(), infoRes.json()]);
      setData({ ...services, info });
      setLastRefresh(new Date());
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(fetchStatus, 10000);
    return () => clearInterval(timer);
  }, [autoRefresh]);

  if (!isAdmin) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-8 text-center">
        <svg className="w-16 h-16 mx-auto text-red-300 dark:text-red-600 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v.01M12 12v-4m0 0a1 1 0 110-2 1 1 0 010 2zm-7 7h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
        <p className="text-gray-500 dark:text-gray-400 text-lg">Admin access required</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  const containers = data?.services?.filter(s => s.container) || [];
  const internalServices = data?.services?.filter(s => s.type === 'internal') || [];
  const dbService = data?.services?.find(s => s.name.includes('SQLite'));
  const system = data?.system;
  const info = data?.info;

  const onlineCount = data?.services?.filter(s => s.status === 'online').length || 0;
  const totalCount = data?.services?.length || 0;
  const allHealthy = onlineCount === totalCount;

  const memPercent = system ? ((system.memory.used / system.memory.total) * 100).toFixed(0) : 0;

  return (
    <div>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">System Debug</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {lastRefresh ? `Last refreshed: ${lastRefresh.toLocaleTimeString()}` : 'Loading...'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
            <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)}
              className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded" />
            Auto-refresh (10s)
          </label>
          <button onClick={fetchStatus}
            className="px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600">
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 mb-6">
          <p className="text-red-700 dark:text-red-400 text-sm">{error}</p>
        </div>
      )}

      {/* Overview Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">Services</p>
          <p className={`text-2xl font-bold mt-1 ${allHealthy ? 'text-green-600 dark:text-green-400' : 'text-yellow-600 dark:text-yellow-400'}`}>
            {onlineCount}/{totalCount}
          </p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">{allHealthy ? 'All healthy' : 'Some issues'}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">CPU</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1">{system?.cpus || '-'} cores</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Load: {system?.loadAvg?.[0]?.toFixed(2) || '-'}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">Memory</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1">{memPercent}%</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">{formatBytes(system?.memory?.used)} / {formatBytes(system?.memory?.total)}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">Uptime</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1">{formatUptime(system?.uptime)}</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">{system?.hostname || '-'}</p>
        </div>
      </div>

      {/* Docker Containers */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow mb-6">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Docker Containers</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-left text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                <th className="px-6 py-3">Service</th>
                <th className="px-6 py-3">Container</th>
                <th className="px-6 py-3">Status</th>
                <th className="px-6 py-3">Port</th>
                <th className="px-6 py-3">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {containers.map((svc, i) => (
                <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                  <td className="px-6 py-3">
                    <div className="flex items-center gap-2">
                      <StatusDot status={svc.status} />
                      <span className="text-sm font-medium text-gray-900 dark:text-white">{svc.name}</span>
                    </div>
                  </td>
                  <td className="px-6 py-3">
                    <code className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 px-2 py-0.5 rounded">{svc.container}</code>
                  </td>
                  <td className="px-6 py-3">
                    <StatusBadge status={svc.status} />
                  </td>
                  <td className="px-6 py-3 text-sm text-gray-600 dark:text-gray-400">
                    {svc.port ? `:${svc.port}` : '-'}
                  </td>
                  <td className="px-6 py-3 text-xs text-gray-500 dark:text-gray-400">
                    {svc.uptime ? `Up ${formatUptime(svc.uptime)}` : ''}
                    {svc.details?.version ? `v${svc.details.version}` : ''}
                    {svc.error ? <span className="text-red-500">{svc.error}</span> : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Internal Services */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow mb-6">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Internal Services</h2>
        </div>
        <div className="divide-y divide-gray-100 dark:divide-gray-700">
          {[...(dbService ? [dbService] : []), ...internalServices].map((svc, i) => (
            <div key={i} className="flex items-center justify-between px-6 py-3">
              <div className="flex items-center gap-3">
                <StatusDot status={svc.status} />
                <span className="text-sm font-medium text-gray-900 dark:text-white">{svc.name}</span>
              </div>
              <div className="flex items-center gap-3">
                {svc.details?.deviceCount !== undefined && (
                  <span className="text-xs text-gray-500 dark:text-gray-400">{svc.details.deviceCount} devices</span>
                )}
                <StatusBadge status={svc.status} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* System Info */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">System Info</h2>
        </div>
        <div className="px-6 py-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-gray-500 dark:text-gray-400">Hostname</p>
            <p className="text-gray-900 dark:text-white font-medium">{system?.hostname || '-'}</p>
          </div>
          <div>
            <p className="text-gray-500 dark:text-gray-400">Platform</p>
            <p className="text-gray-900 dark:text-white font-medium">{system?.platform || '-'}</p>
          </div>
          <div>
            <p className="text-gray-500 dark:text-gray-400">Node.js</p>
            <p className="text-gray-900 dark:text-white font-medium">{info?.node_version || '-'}</p>
          </div>
          <div>
            <p className="text-gray-500 dark:text-gray-400">SenseHub Version</p>
            <p className="text-gray-900 dark:text-white font-medium">{info?.version || '-'} ({info?.codename || '-'})</p>
          </div>
          <div>
            <p className="text-gray-500 dark:text-gray-400">CPU Load (1m / 5m / 15m)</p>
            <p className="text-gray-900 dark:text-white font-medium">
              {system?.loadAvg?.map(l => l.toFixed(2)).join(' / ') || '-'}
            </p>
          </div>
          <div>
            <p className="text-gray-500 dark:text-gray-400">Memory</p>
            <div className="mt-1">
              <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                <div className={`h-2 rounded-full ${parseInt(memPercent) > 90 ? 'bg-red-500' : parseInt(memPercent) > 70 ? 'bg-yellow-500' : 'bg-green-500'}`}
                  style={{ width: `${memPercent}%` }} />
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {formatBytes(system?.memory?.used)} used of {formatBytes(system?.memory?.total)} ({memPercent}%)
              </p>
            </div>
          </div>
          <div>
            <p className="text-gray-500 dark:text-gray-400">Backend Memory (RSS)</p>
            <p className="text-gray-900 dark:text-white font-medium">{info?.memory ? formatBytes(info.memory.used) : '-'}</p>
          </div>
          <div>
            <p className="text-gray-500 dark:text-gray-400">Database</p>
            <p className="text-gray-900 dark:text-white font-medium">{info?.database?.path || '-'} ({info?.database?.connected ? 'connected' : 'disconnected'})</p>
          </div>
        </div>
      </div>
    </div>
  );
}
