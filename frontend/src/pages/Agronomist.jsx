import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { Card, Label, StatusPill, Button } from '../ui';
import DataSourcesPanel from '../components/agronomist/DataSourcesPanel';
import CapturePanel, { FrameStrip } from '../components/agronomist/CaptureStrip';
import SettingsSection from '../components/agronomist/SettingsSection';

const API_BASE = '/api';
const SETTINGS_OPEN_KEY = 'agronomist:settingsOpen';

// Short names for the status line ("2 sources out of service: AMIC, Lab").
const SOURCE_SHORT = {
  amic: 'AMIC', lab: 'Lab', water_controller: 'SEKO', canopy_capture: 'Camera', energy: 'Energy',
  fertigation: 'Fertigation', substrate_sensors: 'Substrate', climate_sensors: 'Climate',
  alerts: 'Alerts', operator_tasks: 'Tasks', automations_state: 'Automations',
};
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const NOON_CAPTURE_TIME = '12:00'; // local; the capture scheduler runs the noon session at 12:00

const pad2 = (n) => String(parseInt(n, 10) || 0).padStart(2, '0');
const fmtDayTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const readSettingsOpen = () => {
  try { return localStorage.getItem(SETTINGS_OPEN_KEY) === 'true'; } catch { return false; }
};

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
  const [showMemory, setShowMemory] = useState(false);
  const [memory, setMemory] = useState(null);
  const [retrying, setRetrying] = useState(false);
  // Settings area: closed by default, remembered per browser. Sections are collapsed on every open.
  const [settingsOpen, setSettingsOpen] = useState(readSettingsOpen);
  const [openSections, setOpenSections] = useState({});
  const [dataSources, setDataSources] = useState(null); // GET /api/ai/data-sources, for the status line
  const [lastCapture, setLastCapture] = useState(null); // latest capture group, for the settings summary

  const toggleSettings = () => {
    setSettingsOpen(open => {
      const next = !open;
      try { localStorage.setItem(SETTINGS_OPEN_KEY, next ? 'true' : 'false'); } catch { /* private mode etc. */ }
      if (!next) setOpenSections({});
      return next;
    });
  };
  const toggleSection = (id) => setOpenSections(o => ({ ...o, [id]: !o[id] }));

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

  const fetchDataSources = async () => {
    try {
      const res = await fetch(`${API_BASE}/ai/data-sources`, { headers });
      if (res.ok) setDataSources(await res.json());
    } catch {}
  };

  const fetchLastCapture = async () => {
    try {
      const res = await fetch(`${API_BASE}/agronomist/captures?days=7`, { headers });
      if (res.ok) {
        const data = await res.json();
        setLastCapture((data.groups || [])[0] || null);
      }
    } catch {}
  };

  useEffect(() => { fetchReports(); fetchConfig(); fetchZones(); fetchEquipment(); fetchDataSources(); fetchLastCapture(); }, []);
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
      return updated;
    } catch (err) {
      showError('Save failed: ' + err.message);
      return null;
    }
  };

  const form = useConfigForm(config, saveConfig);

  // One-line summaries for the status line and the collapsed section headers.
  const summaries = useMemo(() => {
    const out = {};
    if (config) {
      out.schedule = config.enabled ? `Daily ${pad2(config.schedule_hour)}:${pad2(config.schedule_minute)}` : 'Scheduled run off';
      out.weekly = `weekly rollup ${DAY_SHORT[config.weekly_rollup_day] || '?'} ${pad2(config.weekly_rollup_hour)}:${pad2(config.weekly_rollup_minute)}`;
      out.scheduleLine = `${out.schedule} · ${config.model} · ${out.weekly}`;
      const frames = config.capture_frames || 3;
      out.captureOn = config.capture_enabled !== false;
      out.capture = out.captureOn ? `${frames} frame${frames === 1 ? '' : 's'} at ${NOON_CAPTURE_TIME}` : 'Noon capture off';
      const byId = Object.fromEntries((equipment || []).map(e => [e.id, e.name]));
      const ref = (id) => (id ? (byId[id] || `#${id}`) : 'none');
      out.reference = `Temp ${ref(config.reference_temperature_equipment_id)} · RH ${ref(config.reference_humidity_equipment_id)} · Soil ${ref(config.reference_soil_equipment_id)}`;
    }
    if (lastCapture?.frames?.length) {
      const first = [...lastCapture.frames].sort((a, b) => String(a.captured_at).localeCompare(String(b.captured_at)))[0];
      const n = lastCapture.frames.length;
      out.captureLast = `last session ${fmtDayTime(first?.captured_at)} · ${n} frame${n === 1 ? '' : 's'}`;
    } else if (lastCapture !== null || config) {
      out.captureLast = 'no session in the last 7 days';
    }
    if (dataSources) {
      const order = dataSources.order || Object.keys(dataSources.sources || {});
      const disabled = dataSources.disabled || [];
      const names = disabled.map(k => SOURCE_SHORT[k] || dataSources.sources?.[k]?.label || k);
      out.sourcesOut = disabled.length;
      out.sourcesIn = order.length - disabled.length;
      out.sourceNames = names;
      out.sourcesLine = disabled.length
        ? `${out.sourcesIn} in use, ${disabled.length} out of service: ${names.join(', ')}`
        : `${order.length} in use, all sources in service`;
    }
    return out;
  }, [config, equipment, lastCapture, dataSources]);

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

      {/* Status line: what the agronomist is set to, one row. Settings live behind the button. */}
      <Card padding="sm" className="mb-4" data-testid="agronomist-status-line">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2 min-w-0 flex-1">
            <Label className="hidden sm:block shrink-0 mr-1">Setup</Label>
            {config ? (
              <>
                <StatusPill state={config.enabled ? 'ok' : 'idle'} filled={!!config.enabled} text={summaries.schedule} data-testid="status-schedule" />
                <span className="hidden sm:inline font-mono text-xs text-muted" data-testid="status-model">{config.model}</span>
                <StatusPill state={summaries.captureOn ? 'ok' : 'idle'} filled={summaries.captureOn} text={summaries.captureOn ? 'noon capture on' : 'noon capture off'} data-testid="status-capture" />
              </>
            ) : (
              <StatusPill state="idle" text="Loading" />
            )}
            {dataSources && (
              summaries.sourcesOut > 0 ? (
                <StatusPill
                  state="caution"
                  filled
                  className="max-w-full !whitespace-normal sm:!whitespace-nowrap"
                  data-testid="status-sources"
                  title={`Out of service: ${(dataSources.disabled || []).map(k => dataSources.sources?.[k]?.label || k).join(', ')}`}
                >
                  <span>
                    {summaries.sourcesOut}
                    <span className="hidden sm:inline"> source{summaries.sourcesOut === 1 ? '' : 's'}</span>
                    {' '}out of service: {summaries.sourceNames.slice(0, 4).join(', ')}
                    {summaries.sourceNames.length > 4 ? ` +${summaries.sourceNames.length - 4}` : ''}
                  </span>
                </StatusPill>
              ) : (
                <StatusPill state="ok" filled text="all sources in use" data-testid="status-sources" />
              )
            )}
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={toggleSettings}
            aria-expanded={settingsOpen}
            aria-label="Settings"
            title={settingsOpen ? 'Hide agronomist settings' : 'Show agronomist settings'}
            className="shrink-0"
            data-testid="agronomist-settings-toggle"
          >
            <svg aria-hidden="true" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span className="hidden sm:inline">Settings</span>
          </Button>
        </div>
      </Card>

      {/* Settings area: inline, collapsible sections, each closed until asked for. */}
      {settingsOpen && (
        <Card padding="none" className="mb-4 divide-y divide-line" data-testid="agronomist-settings">
          {isAdmin && config && (
            <SettingsSection id="schedule" title="Schedule & model" summary={summaries.scheduleLine} open={!!openSections.schedule} onToggle={() => toggleSection('schedule')}>
              <ScheduleModelFields form={form} onWeeklyRollup={runWeeklyRollup} />
              <ConfigSaveBar form={form} />
            </SettingsSection>
          )}
          <SettingsSection id="sources" title="Data sources" summary={summaries.sourcesLine || 'Loading'} open={!!openSections.sources} onToggle={() => toggleSection('sources')}>
            <DataSourcesPanel embedded headers={headers} canEdit={canControl} equipment={equipment} onSaved={setDataSources} />
          </SettingsSection>
          <SettingsSection id="capture" title="Canopy capture" summary={[summaries.capture, summaries.captureLast].filter(Boolean).join(' · ')} open={!!openSections.capture} onToggle={() => toggleSection('capture')}>
            <CapturePanel embedded headers={headers} canControl={canControl} config={config} />
          </SettingsSection>
          {isAdmin && config && (
            <SettingsSection id="reference" title="Reference sensors" summary={summaries.reference} open={!!openSections.reference} onToggle={() => toggleSection('reference')}>
              <ReferenceSensorFields form={form} zones={zones} equipment={equipment} />
              <ConfigSaveBar form={form} />
            </SettingsSection>
          )}
        </Card>
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

const INPUT = 'px-2 py-1 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-700 dark:text-white disabled:opacity-60';
const MODEL_OPTIONS = [
  ['claude-sonnet-5', 'Claude Sonnet 5 (default)'],
  ['claude-sonnet-4-6', 'Claude Sonnet 4.6'],
  ['claude-opus-4-7', 'Claude Opus 4.7 (most capable, more expensive)'],
  ['claude-haiku-4-5', 'Claude Haiku 4.5 (cheapest)'],
];

function valuesFromConfig(config) {
  return {
    enabled: !!config.enabled,
    model: config.model || '',
    hour: String(config.schedule_hour ?? 20),
    minute: String(config.schedule_minute ?? 0),
    weeklyDay: String(config.weekly_rollup_day ?? 0),
    weeklyHour: String(config.weekly_rollup_hour ?? 20),
    weeklyMinute: String(config.weekly_rollup_minute ?? 0),
    irrigIds: [...(config.irrigation_zone_ids || [])],
    drainIds: [...(config.drain_zone_ids || [])],
    refTemp: config.reference_temperature_equipment_id ? String(config.reference_temperature_equipment_id) : '',
    refHum: config.reference_humidity_equipment_id ? String(config.reference_humidity_equipment_id) : '',
    refSoil: config.reference_soil_equipment_id ? String(config.reference_soil_equipment_id) : '',
    promptOverride: config.system_prompt_override || '',
  };
}

/**
 * One draft of the agronomist config shared by the "Schedule & model" and
 * "Reference sensors" sections (they save the same row). The draft follows the
 * server config until the admin edits something; a successful save resets it.
 */
function useConfigForm(config, onSave) {
  const [values, setValues] = useState(() => (config ? valuesFromConfig(config) : null));
  const [saving, setSaving] = useState(false);
  const saved = useMemo(() => (config ? JSON.stringify(valuesFromConfig(config)) : null), [config]);
  const dirty = !!values && !!saved && JSON.stringify(values) !== saved;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    if (!config) return;
    if (!dirtyRef.current || values === null) setValues(valuesFromConfig(config));
  }, [config]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch) => setValues(v => ({ ...v, ...patch }));
  const reset = () => { if (config) setValues(valuesFromConfig(config)); };
  const save = async () => {
    if (!values) return;
    setSaving(true);
    try {
      const updated = await onSave({
        enabled: values.enabled,
        model: values.model,
        schedule_hour: parseInt(values.hour, 10),
        schedule_minute: parseInt(values.minute, 10),
        weekly_rollup_day: parseInt(values.weeklyDay, 10),
        weekly_rollup_hour: parseInt(values.weeklyHour, 10),
        weekly_rollup_minute: parseInt(values.weeklyMinute, 10),
        irrigation_zone_ids: values.irrigIds,
        drain_zone_ids: values.drainIds,
        reference_temperature_equipment_id: values.refTemp ? parseInt(values.refTemp, 10) : null,
        reference_humidity_equipment_id: values.refHum ? parseInt(values.refHum, 10) : null,
        reference_soil_equipment_id: values.refSoil ? parseInt(values.refSoil, 10) : null,
        system_prompt_override: values.promptOverride.trim() || null,
      });
      if (updated) setValues(valuesFromConfig(updated));
    } finally {
      setSaving(false);
    }
  };

  return { values, set, dirty, saving, save, reset };
}

function ConfigSaveBar({ form }) {
  if (!form.values) return null;
  return (
    <div className="mt-4 flex flex-wrap items-center justify-end gap-3" data-testid="config-save-bar">
      {form.dirty && <span className="text-xs text-caution-700 dark:text-caution-300 mr-auto">Unsaved changes — the next run still uses the saved settings.</span>}
      <Button variant="secondary" size="sm" onClick={form.reset} disabled={!form.dirty || form.saving}>Discard</Button>
      <Button variant="primary" size="sm" onClick={form.save} disabled={!form.dirty || form.saving}>{form.saving ? 'Saving…' : 'Save settings'}</Button>
    </div>
  );
}

function ScheduleModelFields({ form, onWeeklyRollup }) {
  const v = form.values;
  if (!v) return null;
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const modelKnown = MODEL_OPTIONS.some(([id]) => id === v.model);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={v.enabled} onChange={e => form.set({ enabled: e.target.checked })} className="rounded" />
          <span className="font-medium text-gray-700 dark:text-gray-300">Enable scheduled daily report</span>
        </label>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">When off, only manual "Generate Now" runs work.</p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Model</label>
        <select value={v.model} onChange={e => form.set({ model: e.target.value })}
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 dark:text-white">
          {!modelKnown && v.model && <option value={v.model}>{v.model} (current)</option>}
          {MODEL_OPTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Daily report time (local)</label>
        <div className="flex items-center gap-2">
          <input type="number" min="0" max="23" value={v.hour} onChange={e => form.set({ hour: e.target.value })} className={`w-20 ${INPUT}`} />
          <span className="text-gray-500">:</span>
          <input type="number" min="0" max="59" value={v.minute} onChange={e => form.set({ minute: e.target.value })} className={`w-20 ${INPUT}`} />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Weekly rollup</label>
        <div className="flex flex-wrap items-center gap-2">
          <select value={v.weeklyDay} onChange={e => form.set({ weeklyDay: e.target.value })} className={INPUT}>
            {dayNames.map((d, i) => <option key={i} value={i}>{d}</option>)}
          </select>
          <input type="number" min="0" max="23" value={v.weeklyHour} onChange={e => form.set({ weeklyHour: e.target.value })} className={`w-16 ${INPUT}`} />
          <span className="text-gray-500">:</span>
          <input type="number" min="0" max="59" value={v.weeklyMinute} onChange={e => form.set({ weeklyMinute: e.target.value })} className={`w-16 ${INPUT}`} />
          <button type="button" onClick={onWeeklyRollup}
            className="ml-auto px-3 py-1 text-xs bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded">
            Run Now
          </button>
        </div>
      </div>

      <div className="md:col-span-2">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          System prompt override <span className="text-xs text-gray-500">(optional, advanced)</span>
        </label>
        <textarea
          value={v.promptOverride}
          onChange={e => form.set({ promptOverride: e.target.value })}
          placeholder="Leave blank to use the default UAE agronomist persona."
          rows={4}
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 dark:text-white font-mono"
        />
      </div>
    </div>
  );
}

function ReferenceSensorFields({ form, zones, equipment }) {
  const v = form.values;
  if (!v) return null;
  const sensorEquipment = (equipment || []).filter(e => e.type === 'sensor');
  const toggle = (key, id) => {
    const list = v[key];
    form.set({ [key]: list.includes(id) ? list.filter(x => x !== id) : [...list, id] });
  };
  const refSelect = (key) => (
    <select value={v[key]} onChange={e => form.set({ [key]: e.target.value })}
      className="w-full px-2 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-700 dark:text-white">
      <option value="">— None —</option>
      {sensorEquipment.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
    </select>
  );
  const zoneList = (key) => (
    <div className="border border-gray-300 dark:border-gray-600 rounded p-2 max-h-32 overflow-y-auto bg-white dark:bg-gray-700">
      {zones.length === 0 && <p className="text-xs text-gray-500">No zones defined</p>}
      {zones.map(z => (
        <label key={z.id} className="flex items-center gap-2 text-sm py-0.5">
          <input type="checkbox" checked={v[key].includes(z.id)} onChange={() => toggle(key, z.id)} className="rounded" />
          <span className="text-gray-800 dark:text-gray-200">{z.name}</span>
        </label>
      ))}
    </div>
  );

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
          Pick the canonical sensor for each environment metric. The agent will quote these as the primary reading and treat all other sensors as cross-checks.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div><p className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">Temperature</p>{refSelect('refTemp')}</div>
          <div><p className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">Humidity</p>{refSelect('refHum')}</div>
          <div><p className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">Soil / Substrate</p>{refSelect('refSoil')}</div>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Zone roles (for AMIC nutrient context)</label>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
          Tag which zones represent the irrigation feed water and which the drain return. Without this, the agent falls back to matching zone names containing "irrigation" / "drain".
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div><p className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">Irrigation (feed)</p>{zoneList('irrigIds')}</div>
          <div><p className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">Drain (return)</p>{zoneList('drainIds')}</div>
        </div>
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
