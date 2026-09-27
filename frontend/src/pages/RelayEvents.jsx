import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useFormat } from '../i18n/useFormat';

const API_BASE = '/api';

// Source codes come from the relay_events table; labels via t(`source.${code}`).
const SOURCES = ['manual', 'automation', 'automation_auto_off', 'watchdog_force_off', 'all_channels'];

const SOURCE_BADGES = {
  manual: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  automation: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  automation_auto_off: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400',
  watchdog_force_off: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  all_channels: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
};
const sourceBadge = (s) => SOURCE_BADGES[s] || 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300';

export default function RelayEvents() {
  const { t } = useTranslation('relayEvents');
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
      else showError(t('err.loadEquipment'));
    } catch (err) {
      showError(t('err.loadEquipmentWith', { error: err.message }));
    }
  }, [headers, showError, t]);

  const loadStats = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/relay-events/stats`, { headers });
      if (res.ok) setStats(await res.json());
      else showError(t('err.loadStats'));
    } catch (err) {
      showError(t('err.loadStatsWith', { error: err.message }));
    }
  }, [headers, showError, t]);

  const loadRuns = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ limit: '200' });
      Object.entries(filter).forEach(([k, v]) => v && qs.append(k, v));
      const res = await fetch(`${API_BASE}/relay-events/runs?${qs}`, { headers });
      if (!res.ok) throw new Error(t('err.loadRuns'));
      const data = await res.json();
      setRuns(data.runs || []);
    } catch (err) {
      showError(err.message);
    } finally {
      setLoading(false);
    }
  }, [headers, filter, showError, t]);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ limit: '300' });
      Object.entries(filter).forEach(([k, v]) => v && qs.append(k, v));
      const res = await fetch(`${API_BASE}/relay-events?${qs}`, { headers });
      if (!res.ok) throw new Error(t('err.loadEvents'));
      const data = await res.json();
      setEvents(data.events || []);
    } catch (err) {
      showError(err.message);
    } finally {
      setLoading(false);
    }
  }, [headers, filter, showError, t]);

  const loadSafetyConfig = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/relay-events/safety-config`, { headers });
      if (res.ok) setSafetyConfig(await res.json());
      else showError(t('err.loadSafety'));
    } catch (err) {
      showError(t('err.loadSafetyWith', { error: err.message }));
    }
  }, [headers, showError, t]);

  useEffect(() => { loadEquipment(); loadStats(); loadSafetyConfig(); }, [loadEquipment, loadStats, loadSafetyConfig]);
  useEffect(() => {
    if (tab === 'runs') loadRuns();
    else if (tab === 'events') loadEvents();
  }, [tab, loadRuns, loadEvents]);

  const triggerSafetyCheck = async () => {
    try {
      const res = await fetch(`${API_BASE}/relay-events/safety-check`, { method: 'POST', headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('err.failed'));
      if (data.acted?.length) {
        showSuccess(t('toast.watchdogActed', { count: data.acted.length }));
      } else {
        showSuccess(t('toast.watchdogClean'));
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
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t('title')}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {t('subtitle')}
          </p>
        </div>
        {canControl && (
          <button onClick={triggerSafetyCheck}
            className="px-3 py-2 text-sm bg-amber-600 hover:bg-amber-700 text-white rounded">
            {t('runSafetyCheck')}
          </button>
        )}
      </div>

      {/* Stats summary */}
      {stats && <StatsBar stats={stats} />}

      {/* Tabs */}
      <div className="border-b border-gray-200 dark:border-gray-700 flex gap-1">
        {[
          { id: 'runs' },
          { id: 'events' },
          { id: 'safety', adminOnly: true },
        ].filter(tb => !tb.adminOnly || isAdmin).map(tb => (
          <button key={tb.id}
            onClick={() => setTab(tb.id)}
            className={`px-3 py-2 text-sm font-medium ${tab === tb.id
              ? 'border-b-2 border-primary-500 text-primary-700 dark:text-primary-400'
              : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}>
            {t(`tab.${tb.id}`)}
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
          onSaved={(c) => { setSafetyConfig(c); showSuccess(t('toast.safetySaved')); }}
          headers={headers}
        />
      )}
    </div>
  );
}

function StatsBar({ stats }) {
  const { t } = useTranslation('relayEvents');
  const fmt = useFormat();
  const cur = stats.currently_on || [];
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      <StatCard label={t('stats.currentlyOn')} value={cur.length} sub={cur.length === 0 ? t('stats.allClear') : t('stats.channels', { count: cur.length })} tone={cur.length === 0 ? 'green' : 'blue'} />
      <StatCard label={t('stats.forceOff24h')} value={stats['24h']?.force_off_events || 0}
        sub={(stats['24h']?.force_off_events || 0) > 0 ? t('stats.checkAlerts') : t('stats.noneHealthy')}
        tone={(stats['24h']?.force_off_events || 0) > 0 ? 'red' : 'green'} />
      <StatCard label={t('stats.forceOff7d')} value={stats['7d']?.force_off_events || 0}
        sub={(stats['7d']?.force_off_events || 0) > 0 ? t('stats.pastWeek') : t('stats.none')}
        tone={(stats['7d']?.force_off_events || 0) > 0 ? 'amber' : 'gray'} />
      <StatCard label={t('stats.total24h')} value={stats['24h']?.total_events || 0} sub={t('stats.allSources')} tone="gray" />
      {cur.length > 0 && (
        <div className="sm:col-span-2 lg:col-span-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded p-3">
          <p className="text-xs font-semibold text-blue-900 dark:text-blue-300 uppercase mb-2">{t('stats.channelsOn')}</p>
          <div className="flex flex-wrap gap-2">
            {cur.map((c, i) => (
              <span key={i} className="text-xs px-2 py-1 bg-white dark:bg-gray-800 rounded border border-blue-200 dark:border-blue-800">
                <strong dir="auto">{c.equipment_name}</strong> · {t('ch', { n: c.channel })} · {t('stats.onFor', { duration: fmt.duration(c.on_for_seconds) })} · {t('stats.src', { source: t(`source.${c.source}`, { defaultValue: c.source }) })}
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
      <p className="text-2xl font-bold mt-1 font-mono tabular">{value}</p>
      <p className="text-xs opacity-70 mt-1">{sub}</p>
    </div>
  );
}

function FilterBar({ filter, setFilter, equipment, onApply, showSource }) {
  const { t } = useTranslation('relayEvents');
  const set = (k, v) => setFilter(f => ({ ...f, [k]: v }));
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded p-3 flex flex-wrap items-end gap-3">
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">{t('filter.equipment')}</label>
        <select value={filter.equipment_id} onChange={e => set('equipment_id', e.target.value)}
          className="text-sm px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white">
          <option value="">{t('filter.all')}</option>
          {equipment.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
      </div>
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">{t('filter.channel')}</label>
        <input type="number" value={filter.channel} onChange={e => set('channel', e.target.value)} placeholder={t('filter.any')}
          dir="ltr"
          className="text-sm px-2 py-1 w-20 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
      </div>
      {showSource && (
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">{t('filter.source')}</label>
          <select value={filter.source} onChange={e => set('source', e.target.value)}
            className="text-sm px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white">
            <option value="">{t('filter.all')}</option>
            {SOURCES.map(src => <option key={src} value={src}>{t(`source.${src}`)}</option>)}
          </select>
        </div>
      )}
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">{t('filter.from')}</label>
        <input type="datetime-local" value={filter.from} onChange={e => set('from', e.target.value.replace('T', ' '))}
          className="text-sm px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
      </div>
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">{t('filter.to')}</label>
        <input type="datetime-local" value={filter.to} onChange={e => set('to', e.target.value.replace('T', ' '))}
          className="text-sm px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
      </div>
      <div className="flex gap-2">
        <button onClick={onApply}
          className="px-3 py-1.5 text-sm bg-primary-600 hover:bg-primary-700 text-white rounded">{t('common:actions.apply')}</button>
        <button onClick={() => { setFilter({ equipment_id: '', channel: '', source: '', from: '', to: '' }); setTimeout(onApply, 0); }}
          className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded">{t('filter.clear')}</button>
      </div>
    </div>
  );
}

function RunsTable({ runs, loading }) {
  const { t } = useTranslation('relayEvents');
  const fmt = useFormat();
  if (loading) return <p className="text-center text-sm text-gray-500 py-8">{t('runs.loading')}</p>;
  if (runs.length === 0) return <p className="text-center text-sm text-gray-500 py-8">{t('runs.empty')}</p>;
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50 dark:bg-gray-900 text-gray-700 dark:text-gray-300 text-xs uppercase">
          <tr>
            <th className="px-3 py-2 text-start">{t('runs.col.started')}</th>
            <th className="px-3 py-2 text-start">{t('runs.col.equipmentCh')}</th>
            <th className="px-3 py-2 text-start">{t('runs.col.duration')}</th>
            <th className="px-3 py-2 text-start">{t('runs.col.onSource')}</th>
            <th className="px-3 py-2 text-start">{t('runs.col.offSource')}</th>
            <th className="px-3 py-2 text-start">{t('col.automation')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
          {runs.map(r => {
            const tooLong = r.duration_seconds > 1800; // > 30 min flagged
            const stillRunning = r.still_running;
            return (
              <tr key={r.on_id} className={`${tooLong ? 'bg-red-50 dark:bg-red-900/20' : stillRunning ? 'bg-blue-50 dark:bg-blue-900/20' : ''}`}>
                <td className="px-3 py-2 font-mono tabular text-xs text-gray-700 dark:text-gray-300 whitespace-nowrap">{fmt.dateTime(r.on_time)}</td>
                <td className="px-3 py-2">
                  <strong dir="auto">{r.equipment_name}</strong> · {t('ch', { n: r.channel })}
                </td>
                <td className="px-3 py-2 font-mono whitespace-nowrap">
                  {fmt.duration(r.duration_seconds)}
                  {stillRunning && <span className="ms-2 text-xs text-blue-600 dark:text-blue-400">{t('runs.running')}</span>}
                  {tooLong && !stillRunning && <span className="ms-2 text-xs text-red-700 dark:text-red-400">⚠ {t('runs.overrun')}</span>}
                </td>
                <td className="px-3 py-2"><span className={`text-xs px-2 py-0.5 rounded whitespace-nowrap ${sourceBadge(r.on_source)}`}>{t(`source.${r.on_source}`, { defaultValue: r.on_source })}</span></td>
                <td className="px-3 py-2">{r.off_source ? <span className={`text-xs px-2 py-0.5 rounded whitespace-nowrap ${sourceBadge(r.off_source)}`}>{t(`source.${r.off_source}`, { defaultValue: r.off_source })}</span> : <span className="text-xs text-gray-400">—</span>}</td>
                <td dir="auto" className="px-3 py-2 text-xs text-gray-600 dark:text-gray-400">{r.automation_name ? `#${r.on_auto_id} ${r.automation_name}` : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EventsTable({ events, loading }) {
  const { t } = useTranslation('relayEvents');
  const fmt = useFormat();
  if (loading) return <p className="text-center text-sm text-gray-500 py-8">{t('events.loading')}</p>;
  if (events.length === 0) return <p className="text-center text-sm text-gray-500 py-8">{t('events.empty')}</p>;
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50 dark:bg-gray-900 text-gray-700 dark:text-gray-300 text-xs uppercase">
          <tr>
            <th className="px-3 py-2 text-start">{t('events.col.time')}</th>
            <th className="px-3 py-2 text-start">{t('filter.equipment')}</th>
            <th className="px-3 py-2 text-start">{t('filter.channel')}</th>
            <th className="px-3 py-2 text-start">{t('events.col.state')}</th>
            <th className="px-3 py-2 text-start">{t('filter.source')}</th>
            <th className="px-3 py-2 text-start">{t('col.automation')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
          {events.map(e => (
            <tr key={e.id}>
              <td className="px-3 py-2 font-mono tabular text-xs whitespace-nowrap">{fmt.dateTime(e.created_at)}</td>
              <td dir="auto" className="px-3 py-2">{e.equipment_name || `#${e.equipment_id}`}</td>
              <td className="px-3 py-2 whitespace-nowrap">{t('ch', { n: e.channel })}</td>
              <td className="px-3 py-2">
                <span className={`text-xs font-mono px-2 py-0.5 rounded ${e.state ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'}`}>
                  {e.state ? t('common:status.on') : t('common:status.off')}
                </span>
              </td>
              <td className="px-3 py-2"><span className={`text-xs px-2 py-0.5 rounded whitespace-nowrap ${sourceBadge(e.source)}`}>{t(`source.${e.source}`, { defaultValue: e.source })}</span></td>
              <td dir="auto" className="px-3 py-2 text-xs text-gray-600 dark:text-gray-400">{e.automation_name ? `#${e.automation_id} ${e.automation_name}` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SafetyConfigPanel({ config, equipment, onSaved, headers }) {
  const { t } = useTranslation('relayEvents');
  const fmt = useFormat();
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
      if (!res.ok) throw new Error(data.error || t('err.failed'));
      onSaved(data);
    } catch (err) {
      showError(t('err.saveFailed', { error: err.message }));
    } finally {
      setSaving(false);
    }
  };

  if (!config) return <p className="text-center text-sm text-gray-500 py-8">{t('safety.loading')}</p>;

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded p-4 space-y-4">
      <div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
          <span className="font-medium text-gray-900 dark:text-white">{t('safety.enable')}</span>
        </label>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 ms-6">
          {t('safety.enableHelp')}
        </p>
      </div>
      <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded p-3">
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={useActionDuration} onChange={e => setUseActionDuration(e.target.checked)} className="mt-0.5" />
          <div>
            <span className="font-medium text-gray-900 dark:text-white">{t('safety.useActionDuration')}</span>
            <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
              <Trans
                t={t}
                i18nKey="safety.useActionDurationHelp"
                values={{ grace: fmt.duration(Number(gracePeriod)), max: fmt.duration(Number(defaultMax)) }}
                components={{ code: <code dir="ltr" />, b: <strong /> }}
              />
            </p>
          </div>
        </label>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <label className="block">
          <span className="text-sm text-gray-700 dark:text-gray-300">{t('safety.checkInterval')}</span>
          <input type="number" min="5" value={interval} onChange={e => setInterval(e.target.value)}
            className="mt-1 w-full text-sm px-2 py-1.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
          <span className="text-xs text-gray-500">{t('safety.checkIntervalHelp')}</span>
        </label>
        <label className="block">
          <span className="text-sm text-gray-700 dark:text-gray-300">{t('safety.grace')}</span>
          <input type="number" min="0" value={gracePeriod} onChange={e => setGracePeriod(e.target.value)}
            disabled={!useActionDuration}
            className="mt-1 w-full text-sm px-2 py-1.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white disabled:opacity-50" />
          <span className="text-xs text-gray-500">{t('safety.graceHelp')}</span>
        </label>
        <label className="block">
          <span className="text-sm text-gray-700 dark:text-gray-300">{t('safety.minThreshold')}</span>
          <input type="number" min="10" value={minThreshold} onChange={e => setMinThreshold(e.target.value)}
            disabled={!useActionDuration}
            className="mt-1 w-full text-sm px-2 py-1.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white disabled:opacity-50" />
          <span className="text-xs text-gray-500">{t('safety.minThresholdHelp')}</span>
        </label>
      </div>

      <div>
        <label className="block">
          <span className="text-sm text-gray-700 dark:text-gray-300">{t('safety.defaultMax')}</span>
          <input type="number" min="60" value={defaultMax} onChange={e => setDefaultMax(e.target.value)}
            className="mt-1 w-full md:w-1/2 text-sm px-2 py-1.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
          <span className="text-xs text-gray-500">{t('safety.defaultMaxHelp')}</span>
        </label>
      </div>
      <div>
        <p className="text-sm font-medium text-gray-900 dark:text-white mb-2">{t('safety.perEquipment')}</p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">{t('safety.perEquipmentHelp')}</p>
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {equipment.map(eq => (
            <div key={eq.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <label className="flex items-center gap-2 text-sm w-full sm:w-72 min-w-0">
                <input type="checkbox" checked={ignoreList.includes(eq.id)}
                  onChange={e => setIgnoreList(l => e.target.checked ? [...l, eq.id] : l.filter(x => x !== eq.id))} />
                <span className="text-xs">{t('safety.ignore')}</span>
                <span dir="auto" className="text-gray-700 dark:text-gray-300 truncate">{eq.name}</span>
              </label>
              <input type="number" min="0" placeholder={t('safety.defaultPlaceholder', { value: defaultMax })}
                dir="ltr"
                value={perEquipment[eq.id] ?? ''}
                onChange={e => setPerEquipment(p => ({ ...p, [eq.id]: e.target.value }))}
                disabled={ignoreList.includes(eq.id)}
                className="text-sm px-2 py-1 w-32 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white disabled:opacity-50" />
              <span className="text-xs text-gray-500">{t('safety.seconds')}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="flex justify-end pt-2 border-t border-gray-200 dark:border-gray-700">
        <button onClick={save} disabled={saving}
          className="px-4 py-2 text-sm bg-primary-600 hover:bg-primary-700 disabled:bg-gray-400 text-white rounded">
          {saving ? t('common:actions.saving') : t('safety.save')}
        </button>
      </div>
    </div>
  );
}
