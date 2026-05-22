import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

const API_BASE = '/api';

const DOMAIN_OPTIONS = [
  { key: 'sensors',     label: 'Sensor readings',     hint: 'substrate moisture, EC, temp, humidity, pH (aggregated by hour/day)' },
  { key: 'fertigation', label: 'Fertigation events',  hint: 'water + nutrient volumes per zone, computed from relay events' },
  { key: 'automations', label: 'Automation history',  hint: 'success / failure / skipped per automation (with reasons in raw view)' },
  { key: 'reference',   label: 'Reference data',      hint: 'lab readings, AMIC cycles, agronomist reports, operational plans' },
];

const RECENT_WINDOWS = [
  { value: 7,   label: '7 days' },
  { value: 30,  label: '30 days' },
  { value: 90,  label: '90 days' },
  { value: 180, label: '180 days' },
];

export default function Analytics() {
  const { token } = useAuth();
  const { showError, showSuccess } = useToast();

  const [domains, setDomains] = useState({ sensors: true, fertigation: true, automations: true, reference: true });
  const [recentDays, setRecentDays] = useState(30);
  const [recentGranularity, setRecentGranularity] = useState('hourly');
  const [includeTrend, setIncludeTrend] = useState(true);
  const [downloading, setDownloading] = useState(false);

  const toggleDomain = (key) => setDomains(d => ({ ...d, [key]: !d[key] }));

  const startDownload = async () => {
    const picked = Object.entries(domains).filter(([_, v]) => v).map(([k]) => k);
    if (picked.length === 0) {
      showError('Pick at least one data domain');
      return;
    }
    setDownloading(true);
    try {
      const params = new URLSearchParams({
        domains: picked.join(','),
        recent_days: String(recentDays),
        recent_granularity: recentGranularity,
        include_trend: String(includeTrend),
      });
      const res = await fetch(`${API_BASE}/analytics/export?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const today = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `sensehub_analytics_${today}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showSuccess('Export ready — check your downloads');
    } catch (err) {
      showError('Export failed: ' + err.message);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Analytics Export</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          Download an Excel-friendly ZIP of historical data, pre-aggregated for analysis. Raw rows stay in the database;
          only summaries are exported (typically a few MB).
        </p>
      </div>

      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-5 space-y-5">
        {/* Domains */}
        <section>
          <h2 className="text-sm uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">Data domains</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {DOMAIN_OPTIONS.map(d => (
              <label key={d.key} className={`flex items-start gap-2 border rounded p-2 cursor-pointer transition-colors ${
                domains[d.key]
                  ? 'border-indigo-300 bg-indigo-50 dark:border-indigo-600 dark:bg-indigo-900/30'
                  : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50'
              }`}>
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={!!domains[d.key]}
                  onChange={() => toggleDomain(d.key)}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{d.label}</div>
                  <div className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">{d.hint}</div>
                </div>
              </label>
            ))}
          </div>
        </section>

        {/* Trend file */}
        <section>
          <h2 className="text-sm uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">Long-horizon trend file</h2>
          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
            <input
              type="checkbox"
              checked={includeTrend}
              onChange={e => setIncludeTrend(e.target.checked)}
            />
            <span>Include <span className="font-mono">trend/</span> folder with all-time daily aggregates</span>
          </label>
        </section>

        {/* Recent window */}
        <section>
          <h2 className="text-sm uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">Recent detail window</h2>
          <div className="flex gap-3 flex-wrap items-center">
            <label className="text-sm text-gray-700 dark:text-gray-200">
              Last
              <select
                value={recentDays}
                onChange={e => setRecentDays(parseInt(e.target.value))}
                className="ml-2 px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded"
              >
                {RECENT_WINDOWS.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
              </select>
            </label>
            <div className="flex items-center gap-3 text-sm text-gray-700 dark:text-gray-200">
              <span>granularity:</span>
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  name="granularity"
                  checked={recentGranularity === 'hourly'}
                  onChange={() => setRecentGranularity('hourly')}
                />
                <span>hourly aggregates <span className="text-xs text-gray-500">(small files, smooth)</span></span>
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  name="granularity"
                  checked={recentGranularity === 'raw'}
                  onChange={() => setRecentGranularity('raw')}
                />
                <span>raw samples <span className="text-xs text-gray-500">(big files, every poll)</span></span>
              </label>
            </div>
          </div>
          {recentGranularity === 'raw' && recentDays > 30 && (
            <div className="mt-2 text-xs text-amber-700 dark:text-amber-300">
              ⚠ Raw samples for {recentDays} days may produce a multi-million-row file. Excel can only open files with up to ~1M rows per sheet.
            </div>
          )}
        </section>

        {/* Action */}
        <div className="pt-3 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={startDownload}
            disabled={downloading}
            className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded disabled:opacity-50"
          >
            {downloading ? 'Building ZIP…' : 'Download CSV pack'}
          </button>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-2">
            Each ZIP contains a <span className="font-mono">README.txt</span> with row counts and a column dictionary.
            CSVs are UTF-8 with BOM and ISO timestamps for Excel compatibility.
          </div>
        </div>
      </div>

      {/* What's inside reference */}
      <details className="mt-4 text-sm text-gray-600 dark:text-gray-400">
        <summary className="cursor-pointer text-gray-700 dark:text-gray-300 font-medium">What's inside the ZIP?</summary>
        <pre className="mt-2 text-xs p-3 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded overflow-x-auto">{`analytics_export_YYYY-MM-DD.zip
├── README.txt                              (row counts + column dictionary)
├── trend/
│   ├── sensor_readings_daily.csv           (all-time, per equipment + metric)
│   ├── fertigation_daily.csv               (all-time, per zone + ingredient)
│   └── automation_logs_daily.csv           (all-time, per automation + status)
├── recent_${recentDays}d/
│   ├── sensor_readings_${recentGranularity === 'hourly' ? 'hourly' : 'raw'}.csv
│   ├── fertigation_events.csv              (raw relay events)
│   └── automation_logs.csv                 (raw logs with skip reasons)
└── reference/
    ├── lab_readings.csv                    (all-time raw)
    ├── amic_cycles.csv                     (all-time raw)
    ├── agronomist_reports.csv              (all-time, headline + summary)
    └── operational_plans.csv               (all-time, headline + summary)`}</pre>
      </details>
    </div>
  );
}
