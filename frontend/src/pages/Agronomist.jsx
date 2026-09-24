import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { StatusPill } from '../ui';
import DataSourcesPanel from '../components/agronomist/DataSourcesPanel';
import CapturePanel, { FrameStrip } from '../components/agronomist/CaptureStrip';

const API_BASE = '/api';

// Tiny safe markdown renderer (escape HTML, then convert a small subset).
// Claude output is trusted enough but we still escape to be safe.
function renderMarkdown(md) {
  if (!md) return '';
  const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let html = escape(md);

  // Code blocks ```...```
  html = html.replace(/```([\s\S]*?)```/g, (_, code) =>
    `<pre class="bg-gray-100 dark:bg-gray-900 rounded p-3 overflow-x-auto text-xs my-3"><code>${code}</code></pre>`);
  // Inline code `...`
  html = html.replace(/`([^`\n]+)`/g, '<code class="bg-gray-100 dark:bg-gray-900 px-1 rounded text-sm">$1</code>');
  // Headings
  html = html.replace(/^### (.+)$/gm, '<h3 class="text-base font-semibold mt-4 mb-2 text-gray-800 dark:text-gray-100">$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2 class="text-lg font-semibold mt-5 mb-2 text-gray-900 dark:text-white border-b border-gray-200 dark:border-gray-700 pb-1">$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1 class="text-xl font-bold mt-6 mb-3 text-gray-900 dark:text-white">$1</h1>');
  // Bold and italic
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  // Bullet lists (group consecutive lines starting with - or *)
  html = html.replace(/((?:^[-*] .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(l => l.replace(/^[-*]\s+/, ''));
    return `<ul class="list-disc list-inside my-2 space-y-1">${items.map(i => `<li>${i}</li>`).join('')}</ul>`;
  });
  // Paragraphs (split on blank lines, wrap if not already a block)
  const blocks = html.split(/\n\n+/).map(b => {
    const trimmed = b.trim();
    if (!trimmed) return '';
    if (/^<(h\d|ul|pre|ol|blockquote)/.test(trimmed)) return trimmed;
    return `<p class="my-2 leading-relaxed">${trimmed.replace(/\n/g, '<br/>')}</p>`;
  });
  return blocks.join('\n');
}

const PRIORITY_COLORS = {
  high: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  low: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
};

export default function Agronomist() {
  const { token, user } = useAuth();
  const { showError, showSuccess } = useToast();
  const isAdmin = user?.role === 'admin';
  const canControl = user?.role === 'admin' || user?.role === 'operator';

  const [reports, setReports] = useState([]);
  const [selectedReport, setSelectedReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [config, setConfig] = useState(null);
  const [zones, setZones] = useState([]);
  const [equipment, setEquipment] = useState([]);
  const [showSettings, setShowSettings] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [memory, setMemory] = useState(null);
  const [retrying, setRetrying] = useState(false);

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const ERROR_CLASS_LABELS = {
    billing: 'billing',
    auth: 'auth',
    rate_limit: 'rate limit',
    other: 'error',
  };
  const ERROR_CLASS_TITLES = {
    billing: 'Anthropic credit balance exhausted',
    auth: 'Anthropic API key rejected',
    rate_limit: 'Anthropic rate limit hit',
    other: 'Last agronomist report failed',
  };

  const retryNow = async () => {
    setRetrying(true);
    try {
      const res = await fetch(`${API_BASE}/agronomist/retry-now`, { method: 'POST', headers, body: JSON.stringify({}) });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        showSuccess("Today's report already exists — schedule resumed");
      } else if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      } else {
        showSuccess('Report generated — schedule resumed');
        if (data.report) setSelectedReport(data.report);
      }
    } catch (err) {
      showError('Retry failed: ' + err.message);
    } finally {
      setRetrying(false);
      await Promise.all([fetchReports(), fetchConfig()]);
    }
  };

  const fetchReports = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/agronomist/reports?limit=60`, { headers });
      if (res.ok) {
        const list = await res.json();
        setReports(list);
        if (list.length > 0 && !selectedReport) {
          // Auto-load full content of the most recent successful report
          const first = list.find(r => r.status === 'success') || list[0];
          if (first) loadReport(first.id);
        }
      }
    } catch (err) {
      showError('Failed to load reports: ' + err.message);
    }
    setLoading(false);
  };

  const loadReport = async (id) => {
    try {
      const res = await fetch(`${API_BASE}/agronomist/reports/${id}`, { headers });
      if (res.ok) setSelectedReport(await res.json());
    } catch (err) {
      showError('Failed to load report: ' + err.message);
    }
  };

  const fetchConfig = async () => {
    try {
      const res = await fetch(`${API_BASE}/agronomist/config`, { headers });
      if (res.ok) setConfig(await res.json());
    } catch {}
  };

  const fetchZones = async () => {
    try {
      const res = await fetch(`${API_BASE}/zones`, { headers });
      if (res.ok) setZones(await res.json());
    } catch {}
  };

  const fetchEquipment = async () => {
    try {
      const res = await fetch(`${API_BASE}/equipment`, { headers });
      if (res.ok) setEquipment(await res.json());
    } catch {}
  };

  const fetchMemory = async () => {
    try {
      const res = await fetch(`${API_BASE}/agronomist/memory`, { headers });
      if (res.ok) setMemory(await res.json());
    } catch {}
  };

  useEffect(() => { fetchReports(); fetchConfig(); fetchZones(); fetchEquipment(); }, []);
  useEffect(() => { if (showMemory) fetchMemory(); }, [showMemory]);

  const generateNow = async (force = false) => {
    setGenerating(true);
    try {
      const res = await fetch(`${API_BASE}/agronomist/generate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ force }),
      });
      if (res.status === 409) {
        if (window.confirm("Today's report already exists. Overwrite it?")) {
          return generateNow(true);
        }
      } else if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      } else {
        showSuccess('Report generated');
        await fetchReports();
        const data = await res.json();
        if (data.report) setSelectedReport(data.report);
      }
    } catch (err) {
      showError('Generation failed: ' + err.message);
    }
    setGenerating(false);
  };

  const runWeeklyRollup = async () => {
    if (!window.confirm('Run weekly rollup now? This compresses last week\'s daily reports and refreshes the long-term memory.')) return;
    try {
      const res = await fetch(`${API_BASE}/agronomist/weekly-rollup`, { method: 'POST', headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      if (data.skipped) showError('Rollup skipped: ' + data.reason);
      else showSuccess(`Weekly rollup written for ${data.week_start} → ${data.week_end}`);
      fetchMemory();
    } catch (err) {
      showError('Rollup failed: ' + err.message);
    }
  };

  const saveConfig = async (updates) => {
    try {
      const res = await fetch(`${API_BASE}/agronomist/config`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed');
      const updated = await res.json();
      setConfig(updated);
      showSuccess('Settings saved');
    } catch (err) {
      showError('Save failed: ' + err.message);
    }
  };

  const renderedHtml = useMemo(
    () => selectedReport?.full_markdown ? renderMarkdown(selectedReport.full_markdown) : '',
    [selectedReport]
  );

  return (
    <div className="max-w-7xl mx-auto p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Agronomist</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Daily AI-generated farm analysis with rolling long-term memory
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canControl && (
            <button
              onClick={() => generateNow(false)}
              disabled={generating || !config?.api_key_present}
              className="px-4 py-2 bg-primary-600 hover:bg-primary-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg flex items-center gap-2"
              title={!config?.api_key_present ? 'ANTHROPIC_API_KEY not set in backend env' : 'Generate today\'s report now'}
            >
              {generating ? (
                <><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z"/></svg>
                Generating...</>
              ) : 'Generate Now'}
            </button>
          )}
          <button
            onClick={() => setShowMemory(s => !s)}
            className="px-3 py-2 text-sm text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            Memory
          </button>
          {isAdmin && (
            <button
              onClick={() => setShowSettings(s => !s)}
              className="px-3 py-2 text-sm text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              Settings
            </button>
          )}
        </div>
      </div>

      {/* API key warning */}
      {config && !config.api_key_present && (
        <div className="mb-4 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200 text-sm">
          <strong>ANTHROPIC_API_KEY is not set in the backend container.</strong> The agronomist agent cannot run until it's configured. Set it via the <code className="bg-amber-100 dark:bg-amber-900 px-1 rounded">.env</code> file alongside <code className="bg-amber-100 dark:bg-amber-900 px-1 rounded">docker-compose.yml</code>, then restart the backend.
        </div>
      )}

      {/* Provider failure banner */}
      {config?.health && (config.health.paused || config.health.consecutiveFailures > 0) && (
        <div className={`mb-4 p-3 rounded-lg border text-sm ${
          config.health.paused
            ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-800 dark:text-red-200'
            : 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200'
        }`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <strong>{ERROR_CLASS_TITLES[config.health.lastErrorClass] || ERROR_CLASS_TITLES.other}</strong>
              {' '}
              <span className="opacity-80">
                ({config.health.consecutiveFailures} consecutive failure{config.health.consecutiveFailures === 1 ? '' : 's'}
                {config.health.lastFailureAt ? `, last at ${config.health.lastFailureAt} UTC` : ''})
              </span>
              {config.health.paused && (
                <p className="mt-1">{config.health.pauseReason}</p>
              )}
              {config.health.lastErrorMessage && (
                <pre className="mt-2 text-xs whitespace-pre-wrap bg-white/50 dark:bg-black/20 p-2 rounded max-h-32 overflow-y-auto">{config.health.lastErrorMessage}</pre>
              )}
            </div>
            {canControl && (
              <button
                onClick={retryNow}
                disabled={retrying || generating || !config.api_key_present}
                className="shrink-0 px-3 py-1.5 text-sm font-medium rounded-lg bg-white dark:bg-gray-800 border border-current hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                title="Run today's report immediately; a success resumes the schedule"
              >
                {retrying ? 'Retrying...' : 'Retry now'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Data sources: what the agronomist + planner may look at (shared setting) */}
      <DataSourcesPanel headers={headers} canEdit={canControl} equipment={equipment} />

      {/* Canopy captures: today's frames + Capture now (admin/operator) */}
      <CapturePanel headers={headers} canControl={canControl} config={config} />

      {/* Settings panel */}
      {showSettings && config && isAdmin && (
        <SettingsPanel config={config} zones={zones} equipment={equipment} onSave={saveConfig} onWeeklyRollup={runWeeklyRollup} onClose={() => setShowSettings(false)} />
      )}

      {/* Memory drawer */}
      {showMemory && (
        <MemoryPanel memory={memory} onClose={() => setShowMemory(false)} />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Sidebar list */}
        <div className="lg:col-span-1">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-2">
            Past Reports ({reports.length})
          </h2>
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
            {loading ? (
              <div className="p-4 text-center text-sm text-gray-500">Loading...</div>
            ) : reports.length === 0 ? (
              <div className="p-4 text-center text-sm text-gray-500">No reports yet. Click "Generate Now" to create one.</div>
            ) : (
              <ul className="divide-y divide-gray-200 dark:divide-gray-700 max-h-[70vh] overflow-y-auto">
                {reports.map(r => (
                  <li key={r.id}>
                    <button
                      onClick={() => loadReport(r.id)}
                      className={`w-full text-left p-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors ${
                        selectedReport?.id === r.id ? 'bg-primary-50 dark:bg-primary-900/20 border-l-4 border-primary-500' : ''
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-gray-900 dark:text-white">{r.report_date}</span>
                        {r.excluded_sources?.length > 0 && (
                          <StatusPill
                            state="caution"
                            className="ml-auto"
                            text={`${r.excluded_sources.length} source${r.excluded_sources.length === 1 ? '' : 's'} excluded`}
                            title={`Out of service when this report was built: ${r.excluded_sources.join(', ')}`}
                          />
                        )}
                        {r.status === 'failure' && (
                          <span
                            className="text-xs px-1.5 py-0.5 bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300 rounded"
                            title={r.error || 'Generation failed'}
                          >
                            {ERROR_CLASS_LABELS[r.error_class] || ERROR_CLASS_LABELS.other}
                          </span>
                        )}
                      </div>
                      {r.opinion && (
                        <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 line-clamp-2">{r.opinion}</p>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Main content */}
        <div className="lg:col-span-2">
          {selectedReport ? (
            selectedReport.status === 'failure' ? (
              <div className="bg-white dark:bg-gray-800 border border-red-200 dark:border-red-800 rounded-lg p-4">
                <h2 className="text-base font-semibold text-red-700 dark:text-red-300">
                  Generation failed for {selectedReport.report_date}
                  {selectedReport.error_class && (
                    <span className="ml-2 text-xs px-1.5 py-0.5 bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300 rounded align-middle">
                      {ERROR_CLASS_LABELS[selectedReport.error_class] || selectedReport.error_class}
                    </span>
                  )}
                </h2>
                <pre className="mt-3 text-xs whitespace-pre-wrap bg-red-50 dark:bg-red-900/20 p-3 rounded text-red-800 dark:text-red-200">{selectedReport.error}</pre>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Headline */}
                <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                  <div className="flex items-baseline justify-between flex-wrap gap-2">
                    <h2 className="text-lg font-bold text-gray-900 dark:text-white">{selectedReport.report_date}</h2>
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {selectedReport.model} · in {selectedReport.input_tokens} / out {selectedReport.output_tokens}
                      {selectedReport.cache_read_tokens > 0 && ` · ${selectedReport.cache_read_tokens} cached`}
                    </span>
                  </div>
                  <p className="mt-2 text-base text-gray-800 dark:text-gray-200 italic">"{selectedReport.opinion}"</p>
                </div>

                {/* Canopy frames the model saw */}
                {(selectedReport.captures?.length > 0 || selectedReport.capture) && (
                  <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4" data-testid="report-frames">
                    <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-2">
                      Canopy frames used
                      {selectedReport.capture_mode && (
                        <span className="ml-2 font-normal normal-case tracking-normal text-xs text-gray-500 dark:text-gray-400">
                          {{ noon: 'noon session', manual: 'manual capture', fallback_4h: '4-hourly fallback', latest: 'latest available', manual_night: 'manual capture (night)' }[selectedReport.capture_mode] || selectedReport.capture_mode}
                        </span>
                      )}
                    </h3>
                    <FrameStrip
                      frames={selectedReport.captures?.length ? selectedReport.captures : [selectedReport.capture]}
                      bestId={selectedReport.capture_id ?? selectedReport.capture?.id ?? null}
                    />
                    {selectedReport.photo_line && (
                      <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{selectedReport.photo_line}</p>
                    )}
                  </div>
                )}

                {/* Recommendations */}
                {selectedReport.recommendations?.length > 0 && (
                  <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                    <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-3">Recommendations</h3>
                    <ul className="space-y-3">
                      {selectedReport.recommendations.map((rec, i) => (
                        <li key={i} className="flex gap-3">
                          <span className={`text-xs font-semibold px-2 py-1 rounded uppercase h-fit ${PRIORITY_COLORS[rec.priority] || PRIORITY_COLORS.low}`}>
                            {rec.priority}
                          </span>
                          <div className="flex-1">
                            <p className="text-sm font-medium text-gray-900 dark:text-white">{rec.action}</p>
                            <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">{rec.rationale}</p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Full markdown report */}
                <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                  <div
                    className="text-sm text-gray-800 dark:text-gray-200"
                    dangerouslySetInnerHTML={{ __html: renderedHtml }}
                  />
                </div>

                {/* Clarifications / Discussion */}
                <ClarificationsPanel
                  report={selectedReport}
                  canControl={canControl}
                  headers={headers}
                  onUpdated={async (regeneratedReport) => {
                    if (regeneratedReport) {
                      setSelectedReport(regeneratedReport);
                      await fetchReports();
                    } else {
                      // Just appended a comment — reload the report so the thread refreshes
                      await loadReport(selectedReport.id);
                    }
                  }}
                />

                {/* Raw input snapshot (collapsed) */}
                <details className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg">
                  <summary className="cursor-pointer p-3 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    Input snapshot (data sent to the agent)
                  </summary>
                  <pre className="p-3 text-xs overflow-x-auto bg-gray-50 dark:bg-gray-900 text-gray-700 dark:text-gray-300 max-h-96 overflow-y-auto">
                    {JSON.stringify(selectedReport.input_snapshot, null, 2)}
                  </pre>
                </details>
              </div>
            )
          ) : (
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-8 text-center text-gray-500 dark:text-gray-400">
              Select a report from the list, or click "Generate Now" to create one.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SettingsPanel({ config, zones, equipment, onSave, onWeeklyRollup, onClose }) {
  const [enabled, setEnabled] = useState(config.enabled);
  const [model, setModel] = useState(config.model);
  const [hour, setHour] = useState(config.schedule_hour);
  const [minute, setMinute] = useState(config.schedule_minute);
  const [weeklyDay, setWeeklyDay] = useState(config.weekly_rollup_day);
  const [weeklyHour, setWeeklyHour] = useState(config.weekly_rollup_hour);
  const [weeklyMinute, setWeeklyMinute] = useState(config.weekly_rollup_minute);
  const [irrigIds, setIrrigIds] = useState(config.irrigation_zone_ids || []);
  const [drainIds, setDrainIds] = useState(config.drain_zone_ids || []);
  const [refTemp, setRefTemp] = useState(config.reference_temperature_equipment_id || '');
  const [refHum, setRefHum] = useState(config.reference_humidity_equipment_id || '');
  const [refSoil, setRefSoil] = useState(config.reference_soil_equipment_id || '');
  const [promptOverride, setPromptOverride] = useState(config.system_prompt_override || '');

  const sensorEquipment = (equipment || []).filter(e => e.type === 'sensor');

  const toggle = (list, setList, id) => {
    setList(list.includes(id) ? list.filter(x => x !== id) : [...list, id]);
  };

  const save = () => onSave({
    enabled, model,
    schedule_hour: parseInt(hour), schedule_minute: parseInt(minute),
    weekly_rollup_day: parseInt(weeklyDay),
    weekly_rollup_hour: parseInt(weeklyHour),
    weekly_rollup_minute: parseInt(weeklyMinute),
    irrigation_zone_ids: irrigIds,
    drain_zone_ids: drainIds,
    reference_temperature_equipment_id: refTemp ? parseInt(refTemp) : null,
    reference_humidity_equipment_id: refHum ? parseInt(refHum) : null,
    reference_soil_equipment_id: refSoil ? parseInt(refSoil) : null,
    system_prompt_override: promptOverride.trim() || null,
  });

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  return (
    <div className="mb-4 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">Agronomist Settings</h2>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">✕</button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} className="rounded" />
            <span className="font-medium text-gray-700 dark:text-gray-300">Enable scheduled daily report</span>
          </label>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">When off, only manual "Generate Now" runs work.</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Model</label>
          <select value={model} onChange={e => setModel(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 dark:text-white">
            <option value="claude-sonnet-4-6">Claude Sonnet 4.6 (recommended)</option>
            <option value="claude-opus-4-7">Claude Opus 4.7 (most capable, more expensive)</option>
            <option value="claude-haiku-4-5">Claude Haiku 4.5 (cheapest)</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Daily report time (local)</label>
          <div className="flex items-center gap-2">
            <input type="number" min="0" max="23" value={hour} onChange={e => setHour(e.target.value)}
              className="w-20 px-2 py-1 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-700 dark:text-white" />
            <span className="text-gray-500">:</span>
            <input type="number" min="0" max="59" value={minute} onChange={e => setMinute(e.target.value)}
              className="w-20 px-2 py-1 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-700 dark:text-white" />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Weekly rollup</label>
          <div className="flex items-center gap-2">
            <select value={weeklyDay} onChange={e => setWeeklyDay(e.target.value)}
              className="px-2 py-1 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-700 dark:text-white">
              {dayNames.map((d, i) => <option key={i} value={i}>{d}</option>)}
            </select>
            <input type="number" min="0" max="23" value={weeklyHour} onChange={e => setWeeklyHour(e.target.value)}
              className="w-16 px-2 py-1 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-700 dark:text-white" />
            <span className="text-gray-500">:</span>
            <input type="number" min="0" max="59" value={weeklyMinute} onChange={e => setWeeklyMinute(e.target.value)}
              className="w-16 px-2 py-1 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-700 dark:text-white" />
            <button onClick={onWeeklyRollup}
              className="ml-auto px-3 py-1 text-xs bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded">
              Run Now
            </button>
          </div>
        </div>

        <div className="md:col-span-2">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Reference sensors</label>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
            Pick the canonical sensor for each environment metric. The agent will quote these as the primary reading and treat all other sensors as cross-checks.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <p className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">Temperature</p>
              <select value={refTemp} onChange={e => setRefTemp(e.target.value)}
                className="w-full px-2 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-700 dark:text-white">
                <option value="">— None —</option>
                {sensorEquipment.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </div>
            <div>
              <p className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">Humidity</p>
              <select value={refHum} onChange={e => setRefHum(e.target.value)}
                className="w-full px-2 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-700 dark:text-white">
                <option value="">— None —</option>
                {sensorEquipment.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </div>
            <div>
              <p className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">Soil / Substrate</p>
              <select value={refSoil} onChange={e => setRefSoil(e.target.value)}
                className="w-full px-2 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-700 dark:text-white">
                <option value="">— None —</option>
                {sensorEquipment.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </div>
          </div>
        </div>

        <div className="md:col-span-2">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Zone roles (for AMIC nutrient context)</label>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
            Tag which zones represent the irrigation feed water and which the drain return. Without this, the agent falls back to matching zone names containing "irrigation" / "drain".
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <p className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">Irrigation (feed)</p>
              <div className="border border-gray-300 dark:border-gray-600 rounded p-2 max-h-32 overflow-y-auto bg-white dark:bg-gray-700">
                {zones.length === 0 && <p className="text-xs text-gray-500">No zones defined</p>}
                {zones.map(z => (
                  <label key={z.id} className="flex items-center gap-2 text-sm py-0.5">
                    <input type="checkbox" checked={irrigIds.includes(z.id)} onChange={() => toggle(irrigIds, setIrrigIds, z.id)} className="rounded" />
                    <span className="text-gray-800 dark:text-gray-200">{z.name}</span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">Drain (return)</p>
              <div className="border border-gray-300 dark:border-gray-600 rounded p-2 max-h-32 overflow-y-auto bg-white dark:bg-gray-700">
                {zones.length === 0 && <p className="text-xs text-gray-500">No zones defined</p>}
                {zones.map(z => (
                  <label key={z.id} className="flex items-center gap-2 text-sm py-0.5">
                    <input type="checkbox" checked={drainIds.includes(z.id)} onChange={() => toggle(drainIds, setDrainIds, z.id)} className="rounded" />
                    <span className="text-gray-800 dark:text-gray-200">{z.name}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="md:col-span-2">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            System prompt override <span className="text-xs text-gray-500">(optional, advanced)</span>
          </label>
          <textarea
            value={promptOverride}
            onChange={e => setPromptOverride(e.target.value)}
            placeholder="Leave blank to use the default UAE agronomist persona."
            rows={4}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 dark:text-white font-mono"
          />
        </div>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose}
          className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-600">
          Cancel
        </button>
        <button onClick={save}
          className="px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg">
          Save
        </button>
      </div>
    </div>
  );
}

function MemoryPanel({ memory, onClose }) {
  return (
    <div className="mb-4 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">Long-term Memory</h2>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">✕</button>
      </div>
      {!memory || !memory.current ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No long-term memory yet — it gets built after the first weekly rollup.</p>
      ) : (
        <>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
            Version {memory.current.version} · {memory.current.byte_size} bytes · updated {new Date(memory.current.created_at).toLocaleString()} · trigger: {memory.current.triggered_by}
          </p>
          <pre className="text-xs bg-gray-50 dark:bg-gray-900 p-3 rounded whitespace-pre-wrap text-gray-800 dark:text-gray-200 max-h-96 overflow-y-auto">{memory.current.content}</pre>
          {memory.history.length > 1 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-sm text-gray-600 dark:text-gray-400">Older versions ({memory.history.length - 1})</summary>
              <div className="mt-2 space-y-2">
                {memory.history.slice(1).map(v => (
                  <details key={v.version} className="border border-gray-200 dark:border-gray-700 rounded">
                    <summary className="p-2 text-xs cursor-pointer text-gray-700 dark:text-gray-300">v{v.version} · {new Date(v.created_at).toLocaleString()}</summary>
                    <pre className="text-xs p-2 whitespace-pre-wrap text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-900">{v.content}</pre>
                  </details>
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function ClarificationsPanel({ report, canControl, headers, onUpdated }) {
  const { showError, showSuccess } = useToast();
  const [message, setMessage] = useState('');
  const [posting, setPosting] = useState(null); // 'add' | 'regenerate' | null
  const clarifications = report?.clarifications || [];

  const post = async (regenerate) => {
    if (!message.trim()) {
      showError('Type a clarification before posting');
      return;
    }
    if (regenerate && !window.confirm(
      'Regenerate the report now with this clarification? This will call Claude and overwrite the current report. The previous version is not preserved.'
    )) return;

    setPosting(regenerate ? 'regenerate' : 'add');
    try {
      const res = await fetch(`${API_BASE}/agronomist/reports/${report.id}/clarifications`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ message: message.trim(), regenerate: !!regenerate }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setMessage('');
      if (regenerate && data.regenerated) {
        showSuccess('Clarification posted and report regenerated');
        onUpdated(data.report);
      } else {
        showSuccess(regenerate ? 'Clarification saved (regeneration failed — see error)' : 'Clarification posted');
        onUpdated(null);
      }
    } catch (err) {
      showError(err.message);
    } finally {
      setPosting(null);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">
          Clarifications & Discussion
        </h3>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {clarifications.length} note{clarifications.length === 1 ? '' : 's'}
        </span>
      </div>

      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
        Add context the agent doesn't know about — broken sensors, recent maintenance, "ignore today's pH because the probe is uncalibrated", etc. Notes are stored permanently and injected into the prompt on regeneration, so the new report (and any future weekly rollup) reflects your correction.
      </p>

      {clarifications.length > 0 ? (
        <ul className="space-y-2 mb-4">
          {clarifications.map(c => (
            <li key={c.id} className="bg-gray-50 dark:bg-gray-900 rounded p-3 border-l-2 border-primary-400">
              <div className="flex items-baseline justify-between flex-wrap gap-2">
                <span className="text-xs font-medium text-gray-700 dark:text-gray-300">
                  {c.user_name || 'Anonymous'}
                </span>
                <span className="text-xs text-gray-400 dark:text-gray-500">
                  {new Date(c.created_at).toLocaleString()}
                  {c.triggered_regenerate ? ' · triggered regeneration' : ''}
                </span>
              </div>
              <p className="text-sm text-gray-800 dark:text-gray-200 mt-1 whitespace-pre-wrap">{c.message}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-gray-400 dark:text-gray-500 italic mb-4">No clarifications yet.</p>
      )}

      {canControl && (
        <div className="space-y-2">
          <textarea
            value={message}
            onChange={e => setMessage(e.target.value)}
            disabled={!!posting}
            placeholder="Add context, correct an assumption, or flag a sensor issue. Example: 'The AMIC pH probe is uncalibrated — ignore pH readings until further notice.'"
            rows={3}
            className="w-full text-sm px-3 py-2 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
          <div className="flex flex-wrap items-center gap-2 justify-end">
            <span className="text-xs text-gray-400 mr-auto">{message.length} chars</span>
            <button
              onClick={() => post(false)}
              disabled={!!posting || !message.trim()}
              className="px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50">
              {posting === 'add' ? 'Saving…' : 'Add note only'}
            </button>
            <button
              onClick={() => post(true)}
              disabled={!!posting || !message.trim()}
              className="px-3 py-1.5 text-sm rounded bg-primary-600 hover:bg-primary-700 text-white disabled:bg-gray-400 disabled:cursor-not-allowed">
              {posting === 'regenerate' ? 'Regenerating…' : 'Add & regenerate report'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
