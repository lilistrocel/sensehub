import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

const API_BASE = '/api';

const formatDuration = (seconds) => {
  if (!seconds) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};

const formatDate = (dateStr) => {
  const d = new Date(dateStr + 'T12:00:00');
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (dateStr === today.toISOString().split('T')[0]) return 'Today';
  if (dateStr === yesterday.toISOString().split('T')[0]) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
};

export default function Reports() {
  const { token } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(7);
  const [expandedDay, setExpandedDay] = useState(null);

  const headers = { Authorization: `Bearer ${token}` };

  const fetchReport = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/reports/daily?days=${days}`, { headers });
      if (res.ok) setData(await res.json());
    } catch {}
    setLoading(false);
  };

  useEffect(() => { fetchReport(); }, [days]);

  const formatLiters = (l) => {
    if (!l) return '0 L';
    if (l >= 1000) return `${(l / 1000).toFixed(1)} m³`;
    return `${Math.round(l)} L`;
  };

  // Totals across all days
  const totals = data?.report?.reduce((acc, d) => ({
    water_seconds: acc.water_seconds + d.water.total_seconds,
    water_liters: acc.water_liters + (d.water.total_liters || 0),
    fert_seconds: acc.fert_seconds + d.fertigation.total_seconds,
    fert_liters: acc.fert_liters + (d.fertigation.total_liters || 0),
    water_events: acc.water_events + d.water.events,
    fert_events: acc.fert_events + d.fertigation.events,
    auto_runs: acc.auto_runs + d.automations.total_runs,
    failures: acc.failures + d.automations.failures,
    skipped: acc.skipped + d.automations.skipped_actions,
    drift: acc.drift + d.drift_events,
  }), { water_seconds: 0, water_liters: 0, fert_seconds: 0, fert_liters: 0, water_events: 0, fert_events: 0, auto_runs: 0, failures: 0, skipped: 0, drift: 0 });

  // Max values for bar chart scaling
  const maxWater = data?.report ? Math.max(...data.report.map(d => d.water.total_seconds), 1) : 1;
  const maxFert = data?.report ? Math.max(...data.report.map(d => d.fertigation.total_seconds), 1) : 1;

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Daily Reports</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Irrigation, fertigation, and automation summary</p>
        </div>
        <div className="flex items-center gap-3">
          <select value={days} onChange={e => setDays(parseInt(e.target.value))}
            className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-800 dark:text-white">
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
          </select>
          <button onClick={fetchReport} disabled={loading}
            className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 disabled:opacity-50">
            <svg className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      {loading && !data ? (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto mb-2" />
          Loading reports...
        </div>
      ) : data && (
        <>
          {/* Period totals */}
          {totals && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
              <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                <p className="text-xs text-blue-600 dark:text-blue-400 uppercase font-semibold">Total Water</p>
                <p className="text-2xl font-bold text-blue-900 dark:text-blue-200 mt-1">{formatLiters(totals.water_liters)}</p>
                <p className="text-xs text-blue-500 dark:text-blue-400 mt-1">{formatDuration(totals.water_seconds)} runtime, {totals.water_events} cycles</p>
              </div>
              <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
                <p className="text-xs text-green-600 dark:text-green-400 uppercase font-semibold">Total Fertigation</p>
                <p className="text-2xl font-bold text-green-900 dark:text-green-200 mt-1">{formatLiters(totals.fert_liters)}</p>
                <p className="text-xs text-green-500 dark:text-green-400 mt-1">{formatDuration(totals.fert_seconds)} runtime, {totals.fert_events} cycles</p>
              </div>
              <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-4">
                <p className="text-xs text-amber-600 dark:text-amber-400 uppercase font-semibold">Skipped by EC</p>
                <p className="text-2xl font-bold text-amber-900 dark:text-amber-200 mt-1">{totals.skipped}</p>
                <p className="text-xs text-amber-500 dark:text-amber-400 mt-1">actions blocked by dependency</p>
              </div>
              <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
                <p className="text-xs text-red-600 dark:text-red-400 uppercase font-semibold">Relay Drift</p>
                <p className="text-2xl font-bold text-red-900 dark:text-red-200 mt-1">{totals.drift}</p>
                <p className="text-xs text-red-500 dark:text-red-400 mt-1">hardware mismatches</p>
              </div>
            </div>
          )}

          {/* Daily breakdown */}
          <div className="space-y-2">
            {data.report.map((day) => (
              <div key={day.date} className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
                {/* Day header row */}
                <button
                  onClick={() => setExpandedDay(expandedDay === day.date ? null : day.date)}
                  className="w-full px-4 py-3 flex items-center gap-4 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                >
                  <div className="w-24 text-left">
                    <p className="text-sm font-semibold text-gray-900 dark:text-white">{formatDate(day.date)}</p>
                    <p className="text-[10px] text-gray-400">{day.date}</p>
                  </div>

                  {/* Water bar */}
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-blue-600 dark:text-blue-400 w-16 text-right font-medium">{formatLiters(day.water.total_liters)}</span>
                      <div className="flex-1 bg-gray-100 dark:bg-gray-700 rounded-full h-4 overflow-hidden">
                        <div className="bg-blue-500 h-full rounded-full transition-all"
                          style={{ width: `${(day.water.total_seconds / maxWater) * 100}%` }} />
                      </div>
                    </div>
                  </div>

                  {/* Fertigation bar */}
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-green-600 dark:text-green-400 w-16 text-right font-medium">{formatLiters(day.fertigation.total_liters)}</span>
                      <div className="flex-1 bg-gray-100 dark:bg-gray-700 rounded-full h-4 overflow-hidden">
                        <div className="bg-green-500 h-full rounded-full transition-all"
                          style={{ width: `${(day.fertigation.total_seconds / maxFert) * 100}%` }} />
                      </div>
                    </div>
                  </div>

                  {/* Status badges */}
                  <div className="flex items-center gap-2">
                    {day.automations.skipped_actions > 0 && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                        {day.automations.skipped_actions} skipped
                      </span>
                    )}
                    {day.drift_events > 0 && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                        {day.drift_events} drift
                      </span>
                    )}
                    {day.automations.failures > 0 && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                        {day.automations.failures} fail
                      </span>
                    )}
                  </div>

                  <svg className={`w-4 h-4 text-gray-400 transition-transform ${expandedDay === day.date ? 'rotate-180' : ''}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {/* Expanded detail */}
                {expandedDay === day.date && (
                  <div className="px-4 pb-4 border-t border-gray-100 dark:border-gray-700">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-3">
                      {/* Water detail */}
                      <div>
                        <h4 className="text-xs font-semibold text-blue-700 dark:text-blue-400 uppercase mb-2">
                          Water ({data.water_equipment?.name})
                        </h4>
                        <p className="text-lg font-bold text-gray-900 dark:text-white">{formatLiters(day.water.total_liters)}</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">{formatDuration(day.water.total_seconds)} runtime, {day.water.events} cycles</p>
                        {Object.keys(day.water.channel_details || {}).length > 0 && (
                          <div className="mt-2 space-y-1.5">
                            {Object.entries(day.water.channel_details).sort(([a],[b]) => a-b).map(([ch, d]) => (
                              <div key={ch} className="flex items-center justify-between text-xs bg-blue-50 dark:bg-blue-900/10 rounded px-2 py-1">
                                <span className="text-gray-600 dark:text-gray-400">
                                  Ch {ch} {d.ingredient && <span className="text-blue-600 dark:text-blue-400">({d.ingredient})</span>}
                                </span>
                                <span className="font-medium text-gray-900 dark:text-white">{formatLiters(d.liters)} <span className="text-gray-400">({formatDuration(d.seconds)})</span></span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Fertigation detail */}
                      <div>
                        <h4 className="text-xs font-semibold text-green-700 dark:text-green-400 uppercase mb-2">
                          Fertigation ({data.fertigation_equipment?.name})
                        </h4>
                        <p className="text-lg font-bold text-gray-900 dark:text-white">{formatLiters(day.fertigation.total_liters)}</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">{formatDuration(day.fertigation.total_seconds)} runtime, {day.fertigation.events} cycles</p>
                        {Object.keys(day.fertigation.channel_details || {}).length > 0 && (
                          <div className="mt-2 space-y-1.5">
                            {Object.entries(day.fertigation.channel_details).sort(([a],[b]) => a-b).map(([ch, d]) => (
                              <div key={ch} className="text-xs bg-green-50 dark:bg-green-900/10 rounded px-2 py-1.5">
                                <div className="flex items-center justify-between">
                                  <span className="text-gray-600 dark:text-gray-400">
                                    Ch {ch}
                                    {d.mixture && <span className="text-green-700 dark:text-green-400 font-medium ml-1">{d.mixture}</span>}
                                    {d.ingredient && !d.mixture && <span className="text-green-600 dark:text-green-400 ml-1">({d.ingredient})</span>}
                                  </span>
                                  <span className="font-medium text-gray-900 dark:text-white">{formatLiters(d.liters)}</span>
                                </div>
                                <div className="text-[10px] text-gray-400 mt-0.5">
                                  {formatDuration(d.seconds)} @ {d.flow_rate} {d.flow_unit}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Automations detail */}
                      <div>
                        <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-400 uppercase mb-2">Automations</h4>
                        <div className="space-y-1 text-xs">
                          <div className="flex justify-between">
                            <span className="text-gray-600 dark:text-gray-400">Total runs</span>
                            <span className="font-medium text-gray-900 dark:text-white">{day.automations.total_runs}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-600 dark:text-gray-400">Failures</span>
                            <span className={`font-medium ${day.automations.failures > 0 ? 'text-red-600' : 'text-gray-900 dark:text-white'}`}>
                              {day.automations.failures}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-600 dark:text-gray-400">Skipped by dependency</span>
                            <span className={`font-medium ${day.automations.skipped_actions > 0 ? 'text-amber-600' : 'text-gray-900 dark:text-white'}`}>
                              {day.automations.skipped_actions} actions in {day.automations.skipped_runs} runs
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-600 dark:text-gray-400">Relay drift events</span>
                            <span className={`font-medium ${day.drift_events > 0 ? 'text-red-600' : 'text-gray-900 dark:text-white'}`}>
                              {day.drift_events}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Legend */}
          <div className="flex items-center gap-6 mt-4 text-xs text-gray-500 dark:text-gray-400">
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-sm bg-blue-500" /> Water (Irrigation 1)
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-sm bg-green-500" /> Fertigation (Irrigation 2)
            </div>
          </div>
        </>
      )}
    </div>
  );
}
