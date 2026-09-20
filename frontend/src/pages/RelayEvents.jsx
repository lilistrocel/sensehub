import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

const API_BASE = '/api';

// Format a number of seconds as "Xm Ys" or "Hh Mm".
const fmtDuration = (sec) => {
  if (sec == null) return '—';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
};

const SOURCE_BADGES = {
  manual: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  automation: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  automation_auto_off: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400',
  watchdog_force_off: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  all_channels: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
};
const sourceBadge = (s) => SOURCE_BADGES[s] || 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300';

export default function RelayEvents() {
  const { token, user } = useAuth();
  const { showError, showSuccess } = useToast();
  const isAdmin = user?.role === 'admin';
  const canControl = user?.role === 'admin' || user?.role === 'operator';

  const headers = useMemo(() => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }), [token]);

  // Tabs: 'runs' (paired ON/OFF with duration) | 'events' (raw stream) | 'safety' (config)
  const [tab, setTab] = useState('runs');
  const [runs, setRuns] = useState([]);
  const [events, setEvents] = useState([]);
  const [stats, setStats] = useState(null);
  const [equipment, setEquipment] = useState([]);
  const [filter, setFilter] = useState({ equipment_id: '', channel: '', source: '', from: '', to: '' });
  const [loading, setLoading] = useState(false);
  const [safetyConfig, setSafetyConfig] = useState(null);

  const loadEquipment = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/equipment`, { headers });
      if (res.ok) setEquipment(await res.json());
      else showError('Could not load equipment list');
    } catch (err) {
      showError(`Could not load equipment list: ${err.message}`);
    }
  }, [headers, showError]);

  const loadStats = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/relay-events/stats`, { headers });
      if (res.ok) setStats(await res.json());
      else showError('Could not load relay event statistics');
    } catch (err) {
      showError(`Could not load relay event statistics: ${err.message}`);
    }
  }, [headers, showError]);

  const loadRuns = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ limit: '200' });
      Object.entries(filter).forEach(([k, v]) => v && qs.append(k, v));
      const res = await fetch(`${API_BASE}/relay-events/runs?${qs}`, { headers });
      if (!res.ok) throw new Error('Failed to load runs');
      const data = await res.json();
      setRuns(data.runs || []);
    } catch (err) {
      showError(err.message);
    } finally {
      setLoading(false);
    }
  }, [headers, filter, showError]);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ limit: '300' });
      Object.entries(filter).forEach(([k, v]) => v && qs.append(k, v));
      const res = await fetch(`${API_BASE}/relay-events?${qs}`, { headers });
      if (!res.ok) throw new Error('Failed to load events');
      const data = await res.json();
      setEvents(data.events || []);
    } catch (err) {
      showError(err.message);
    } finally {
      setLoading(false);
    }
  }, [headers, filter, showError]);

  const loadSafetyConfig = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/relay-events/safety-config`, { headers });
      if (res.ok) setSafetyConfig(await res.json());
      else showError('Could not load relay safety configuration');
    } catch (err) {
      showError(`Could not load relay safety configuration: ${err.message}`);
    }
  }, [headers, showError]);

  useEffect(() => { loadEquipment(); loadStats(); loadSafetyConfig(); }, [loadEquipment, loadStats, loadSafetyConfig]);
  useEffect(() => {
    if (tab === 'runs') loadRuns();
    else if (tab === 'events') loadEvents();
  }, [tab, loadRuns, loadEvents]);

  const triggerSafetyCheck = async () => {
    try {
      const res = await fetch(`${API_BASE}/relay-events/safety-check`, { method: 'POST', headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      if (data.acted?.length) {
        showSuccess(`Watchdog acted on ${data.acted.length} stuck channel(s)`);
      } else {
        showSuccess('Watchdog ran — no stuck channels found');
      }
      loadStats();
    } catch (err) {
      showError(err.message);
    }
  };

  return (
    <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Relay Events</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Audit trail of every relay ON/OFF transition, with computed run durations and stuck-on safety controls.
          </p>
        </div>
        {canControl && (
          <button onClick={triggerSafetyCheck}
            className="px-3 py-2 text-sm bg-amber-600 hover:bg-amber-700 text-white rounded">
            Run safety check now
          </button>
        )}
      </div>

      {/* Stats summary */}
      {stats && <StatsBar stats={stats} />}

      {/* Tabs */}
      <div className="border-b border-gray-200 dark:border-gray-700 flex gap-1">
        {[
          { id: 'runs', label: 'Zone runs (paired)' },
          { id: 'events', label: 'Raw events' },
          { id: 'safety', label: 'Safety watchdog', adminOnly: true },
        ].filter(t => !t.adminOnly || isAdmin).map(t => (
          <button key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-2 text-sm font-medium ${tab === t.id
              ? 'border-b-2 border-primary-500 text-primary-700 dark:text-primary-400'
              : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Filter bar (runs and events) */}
      {(tab === 'runs' || tab === 'events') && (
        <FilterBar
          filter={filter}
          setFilter={setFilter}
          equipment={equipment}
          onApply={tab === 'runs' ? loadRuns : loadEvents}
          showSource={tab === 'events'}
        />
      )}

      {tab === 'runs' && <RunsTable runs={runs} loading={loading} />}
      {tab === 'events' && <EventsTable events={events} loading={loading} />}
      {tab === 'safety' && isAdmin && (
        <SafetyConfigPanel
          config={safetyConfig}
          equipment={equipment}
          onSaved={(c) => { setSafetyConfig(c); showSuccess('Safety config saved'); }}
          headers={headers}
        />
      )}
    </div>
  );
}

function StatsBar({ stats }) {
  const cur = stats.currently_on || [];
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      <StatCard label="Currently ON" value={cur.length} sub={cur.length === 0 ? 'all clear' : `${cur.length} channel${cur.length === 1 ? '' : 's'}`} tone={cur.length === 0 ? 'green' : 'blue'} />
      <StatCard label="Force-OFF events (24h)" value={stats['24h']?.force_off_events || 0}
        sub={(stats['24h']?.force_off_events || 0) > 0 ? '⚠ check Alerts' : 'none — healthy'}
        tone={(stats['24h']?.force_off_events || 0) > 0 ? 'red' : 'green'} />
      <StatCard label="Force-OFF events (7d)" value={stats['7d']?.force_off_events || 0}
        sub={(stats['7d']?.force_off_events || 0) > 0 ? 'past week' : 'none'}
        tone={(stats['7d']?.force_off_events || 0) > 0 ? 'amber' : 'gray'} />
      <StatCard label="Total events (24h)" value={stats['24h']?.total_events || 0} sub="all sources" tone="gray" />
      {cur.length > 0 && (
        <div className="sm:col-span-2 lg:col-span-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded p-3">
          <p className="text-xs font-semibold text-blue-900 dark:text-blue-300 uppercase mb-2">Channels currently ON</p>
          <div className="flex flex-wrap gap-2">
            {cur.map((c, i) => (
              <span key={i} className="text-xs px-2 py-1 bg-white dark:bg-gray-800 rounded border border-blue-200 dark:border-blue-800">
                <strong>{c.equipment_name}</strong> · CH{c.channel} · ON for {fmtDuration(c.on_for_seconds)} · src {c.source}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, sub, tone = 'gray' }) {
  const tones = {
    green: 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 text-green-700 dark:text-green-400',
    red: 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-700 dark:text-red-400',
    amber: 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400',
    blue: 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-400',
    gray: 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300',
  };
  return (
    <div className={`border rounded p-3 ${tones[tone]}`}>
      <p className="text-xs uppercase tracking-wide opacity-70">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
      <p className="text-xs opacity-70 mt-1">{sub}</p>
    </div>
  );
}

function FilterBar({ filter, setFilter, equipment, onApply, showSource }) {
  const set = (k, v) => setFilter(f => ({ ...f, [k]: v }));
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded p-3 flex flex-wrap items-end gap-3">
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Equipment</label>
        <select value={filter.equipment_id} onChange={e => set('equipment_id', e.target.value)}
          className="text-sm px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white">
          <option value="">All</option>
          {equipment.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
      </div>
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Channel</label>
        <input type="number" value={filter.channel} onChange={e => set('channel', e.target.value)} placeholder="any"
          className="text-sm px-2 py-1 w-20 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
      </div>
      {showSource && (
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Source</label>
          <select value={filter.source} onChange={e => set('source', e.target.value)}
            className="text-sm px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white">
            <option value="">All</option>
            <option value="manual">manual</option>
            <option value="automation">automation</option>
            <option value="automation_auto_off">automation_auto_off</option>
            <option value="watchdog_force_off">watchdog_force_off</option>
            <option value="all_channels">all_channels</option>
          </select>
        </div>
      )}
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">From</label>
        <input type="datetime-local" value={filter.from} onChange={e => set('from', e.target.value.replace('T', ' '))}
          className="text-sm px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
      </div>
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">To</label>
        <input type="datetime-local" value={filter.to} onChange={e => set('to', e.target.value.replace('T', ' '))}
          className="text-sm px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
      </div>
      <div className="flex gap-2">
        <button onClick={onApply}
          className="px-3 py-1.5 text-sm bg-primary-600 hover:bg-primary-700 text-white rounded">Apply</button>
        <button onClick={() => { setFilter({ equipment_id: '', channel: '', source: '', from: '', to: '' }); setTimeout(onApply, 0); }}
          className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded">Clear</button>
      </div>
    </div>
  );
}

function RunsTable({ runs, loading }) {
  if (loading) return <p className="text-center text-sm text-gray-500 py-8">Loading runs…</p>;
  if (runs.length === 0) return <p className="text-center text-sm text-gray-500 py-8">No runs found.</p>;
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50 dark:bg-gray-900 text-gray-700 dark:text-gray-300 text-xs uppercase">
          <tr>
            <th className="px-3 py-2 text-left">Started</th>
            <th className="px-3 py-2 text-left">Equipment / Ch</th>
            <th className="px-3 py-2 text-left">Duration</th>
            <th className="px-3 py-2 text-left">On source</th>
            <th className="px-3 py-2 text-left">Off source</th>
            <th className="px-3 py-2 text-left">Automation</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
          {runs.map(r => {
            const tooLong = r.duration_seconds > 1800; // > 30 min flagged
            const stillRunning = r.still_running;
            return (
              <tr key={r.on_id} className={`${tooLong ? 'bg-red-50 dark:bg-red-900/20' : stillRunning ? 'bg-blue-50 dark:bg-blue-900/20' : ''}`}>
                <td className="px-3 py-2 font-mono text-xs text-gray-700 dark:text-gray-300">{r.on_time}</td>
                <td className="px-3 py-2">
                  <strong>{r.equipment_name}</strong> · CH{r.channel}
                </td>
                <td className="px-3 py-2 font-mono">
                  {fmtDuration(r.duration_seconds)}
                  {stillRunning && <span className="ml-2 text-xs text-blue-600 dark:text-blue-400">running…</span>}
                  {tooLong && !stillRunning && <span className="ml-2 text-xs text-red-700 dark:text-red-400">⚠ overrun</span>}
                </td>
                <td className="px-3 py-2"><span className={`text-xs px-2 py-0.5 rounded ${sourceBadge(r.on_source)}`}>{r.on_source}</span></td>
                <td className="px-3 py-2">{r.off_source ? <span className={`text-xs px-2 py-0.5 rounded ${sourceBadge(r.off_source)}`}>{r.off_source}</span> : <span className="text-xs text-gray-400">—</span>}</td>
                <td className="px-3 py-2 text-xs text-gray-600 dark:text-gray-400">{r.automation_name ? `#${r.on_auto_id} ${r.automation_name}` : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EventsTable({ events, loading }) {
  if (loading) return <p className="text-center text-sm text-gray-500 py-8">Loading events…</p>;
  if (events.length === 0) return <p className="text-center text-sm text-gray-500 py-8">No events found.</p>;
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50 dark:bg-gray-900 text-gray-700 dark:text-gray-300 text-xs uppercase">
          <tr>
            <th className="px-3 py-2 text-left">Time</th>
            <th className="px-3 py-2 text-left">Equipment</th>
            <th className="px-3 py-2 text-left">Channel</th>
            <th className="px-3 py-2 text-left">State</th>
            <th className="px-3 py-2 text-left">Source</th>
            <th className="px-3 py-2 text-left">Automation</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
          {events.map(e => (
            <tr key={e.id}>
              <td className="px-3 py-2 font-mono text-xs">{e.created_at}</td>
              <td className="px-3 py-2">{e.equipment_name || `#${e.equipment_id}`}</td>
              <td className="px-3 py-2">CH{e.channel}</td>
              <td className="px-3 py-2">
                <span className={`text-xs font-mono px-2 py-0.5 rounded ${e.state ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'}`}>
                  {e.state ? 'ON' : 'OFF'}
                </span>
              </td>
              <td className="px-3 py-2"><span className={`text-xs px-2 py-0.5 rounded ${sourceBadge(e.source)}`}>{e.source}</span></td>
              <td className="px-3 py-2 text-xs text-gray-600 dark:text-gray-400">{e.automation_name ? `#${e.automation_id} ${e.automation_name}` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SafetyConfigPanel({ config, equipment, onSaved, headers }) {
  const { showError } = useToast();
  const [enabled, setEnabled] = useState(config?.enabled ?? true);
  const [interval, setInterval] = useState(config?.check_interval_seconds ?? 30);
  const [defaultMax, setDefaultMax] = useState(config?.default_max_on_seconds ?? 1500);
  const [perEquipment, setPerEquipment] = useState(config?.per_equipment || {});
  const [ignoreList, setIgnoreList] = useState(config?.ignore_equipment || []);
  const [useActionDuration, setUseActionDuration] = useState(config?.use_action_duration ?? true);
  const [gracePeriod, setGracePeriod] = useState(config?.grace_period_seconds ?? 60);
  const [minThreshold, setMinThreshold] = useState(config?.min_threshold_seconds ?? 60);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (config) {
      setEnabled(config.enabled);
      setInterval(config.check_interval_seconds);
      setDefaultMax(config.default_max_on_seconds);
      setPerEquipment(config.per_equipment || {});
      setIgnoreList(config.ignore_equipment || []);
      setUseActionDuration(config.use_action_duration ?? true);
      setGracePeriod(config.grace_period_seconds ?? 60);
      setMinThreshold(config.min_threshold_seconds ?? 60);
    }
  }, [config]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/relay-events/safety-config`, {
        method: 'PUT', headers,
        body: JSON.stringify({
          enabled,
          check_interval_seconds: parseInt(interval),
          default_max_on_seconds: parseInt(defaultMax),
          per_equipment: Object.fromEntries(Object.entries(perEquipment).filter(([_, v]) => v != null && v !== '').map(([k, v]) => [k, parseInt(v)])),
          ignore_equipment: ignoreList.map(Number),
          use_action_duration: useActionDuration,
          grace_period_seconds: parseInt(gracePeriod),
          min_threshold_seconds: parseInt(minThreshold),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      onSaved(data);
    } catch (err) {
      showError('Save failed: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  if (!config) return <p className="text-center text-sm text-gray-500 py-8">Loading config…</p>;

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded p-4 space-y-4">
      <div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
          <span className="font-medium text-gray-900 dark:text-white">Enable safety watchdog</span>
        </label>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 ml-6">
          When enabled, the backend will force-OFF any relay channel that has been ON longer than its configured maximum, log a watchdog event, and raise an alert. This is a safety net for crashed timers, dropped Modbus writes, and scheduler bugs.
        </p>
      </div>
      <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded p-3">
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={useActionDuration} onChange={e => setUseActionDuration(e.target.checked)} className="mt-0.5" />
          <div>
            <span className="font-medium text-gray-900 dark:text-white">Use action duration as threshold (recommended)</span>
            <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
              When ON, the watchdog reads the automation that turned the channel on, finds its <code>duration_seconds</code> (or the gap between transition steps), and force-OFFs at <strong>expected duration + grace period</strong>. A 4-min zone overruns by at most {gracePeriod}s instead of up to {defaultMax}s. Falls back to the flat thresholds below if no expected duration can be derived (manual ONs, deleted automations, etc).
            </p>
          </div>
        </label>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <label className="block">
          <span className="text-sm text-gray-700 dark:text-gray-300">Check interval (s)</span>
          <input type="number" min="5" value={interval} onChange={e => setInterval(e.target.value)}
            className="mt-1 w-full text-sm px-2 py-1.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
          <span className="text-xs text-gray-500">Default 30. How often the watchdog scans.</span>
        </label>
        <label className="block">
          <span className="text-sm text-gray-700 dark:text-gray-300">Grace period (s)</span>
          <input type="number" min="0" value={gracePeriod} onChange={e => setGracePeriod(e.target.value)}
            disabled={!useActionDuration}
            className="mt-1 w-full text-sm px-2 py-1.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white disabled:opacity-50" />
          <span className="text-xs text-gray-500">Added to expected duration. Should be ≥ check interval.</span>
        </label>
        <label className="block">
          <span className="text-sm text-gray-700 dark:text-gray-300">Min threshold (s)</span>
          <input type="number" min="10" value={minThreshold} onChange={e => setMinThreshold(e.target.value)}
            disabled={!useActionDuration}
            className="mt-1 w-full text-sm px-2 py-1.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white disabled:opacity-50" />
          <span className="text-xs text-gray-500">Floor — never force-OFF below this.</span>
        </label>
      </div>

      <div>
        <label className="block">
          <span className="text-sm text-gray-700 dark:text-gray-300">Fallback default max ON time (seconds)</span>
          <input type="number" min="60" value={defaultMax} onChange={e => setDefaultMax(e.target.value)}
            className="mt-1 w-full md:w-1/2 text-sm px-2 py-1.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
          <span className="text-xs text-gray-500">Used when expected duration can't be derived (manual ONs, deleted automations). Default 1500 (25 min).</span>
        </label>
      </div>
      <div>
        <p className="text-sm font-medium text-gray-900 dark:text-white mb-2">Per-equipment overrides</p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">Use this if a particular relay board runs longer cycles than the global default.</p>
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {equipment.map(eq => (
            <div key={eq.id} className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm w-72">
                <input type="checkbox" checked={ignoreList.includes(eq.id)}
                  onChange={e => setIgnoreList(l => e.target.checked ? [...l, eq.id] : l.filter(x => x !== eq.id))} />
                <span className="text-xs">Ignore</span>
                <span className="text-gray-700 dark:text-gray-300">{eq.name}</span>
              </label>
              <input type="number" min="0" placeholder={`default ${defaultMax}s`}
                value={perEquipment[eq.id] ?? ''}
                onChange={e => setPerEquipment(p => ({ ...p, [eq.id]: e.target.value }))}
                disabled={ignoreList.includes(eq.id)}
                className="text-sm px-2 py-1 w-32 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white disabled:opacity-50" />
              <span className="text-xs text-gray-500">seconds</span>
            </div>
          ))}
        </div>
      </div>
      <div className="flex justify-end pt-2 border-t border-gray-200 dark:border-gray-700">
        <button onClick={save} disabled={saving}
          className="px-4 py-2 text-sm bg-primary-600 hover:bg-primary-700 disabled:bg-gray-400 text-white rounded">
          {saving ? 'Saving…' : 'Save safety config'}
        </button>
      </div>
    </div>
  );
}
