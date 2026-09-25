import React, { useState, useEffect, useId, useMemo, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { Card, Label, StatusPill, Button } from '../ui';
import DataSourcesPanel from '../components/agronomist/DataSourcesPanel';
import CapturePanel from '../components/agronomist/CaptureStrip';
import SettingsSection from '../components/agronomist/SettingsSection';
import ReportView from '../components/agronomist/ReportView';
import ReportTabs, { tabPanelProps } from '../components/agronomist/ReportTabs';

const API_BASE = '/api';

// Short names for the status line ("2 sources out of service: AMIC, Lab").
const SOURCE_SHORT = {
  amic: 'AMIC', lab: 'Lab', water_controller: 'SEKO', canopy_capture: 'Camera', energy: 'Energy',
  fertigation: 'Fertigation', substrate_sensors: 'Substrate', climate_sensors: 'Climate',
  alerts: 'Alerts', operator_tasks: 'Tasks', automations_state: 'Automations',
};
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const NOON_CAPTURE_TIME = '12:00'; // local; the capture scheduler runs the noon session at 12:00
const VIEWS = [{ id: 'reports', label: 'Reports' }, { id: 'settings', label: 'Settings' }];

const pad2 = (n) => String(parseInt(n, 10) || 0).padStart(2, '0');
const fmtDayTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

const ERROR_CLASS_TITLES = {
  billing: 'Anthropic credit balance exhausted',
  auth: 'Anthropic API key rejected',
  rate_limit: 'Anthropic rate limit hit',
  truncated_output: 'Last report output was cut off or invalid',
  max_tokens: 'Last report hit the output token limit',
  refusal: 'Last report was declined by the model',
  other: 'Last agronomist report failed',
};

export default function Agronomist() {
  const { token, user } = useAuth();
  const { showError, showSuccess } = useToast();
  const isAdmin = user?.role === 'admin';
  const canControl = user?.role === 'admin' || user?.role === 'operator';
  const viewId = useId().replace(/:/g, '');

  const [reports, setReports] = useState([]);
  const [selectedReport, setSelectedReport] = useState(null);
  const [pendingReportId, setPendingReportId] = useState(null); // report being fetched by prev/next/select
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [config, setConfig] = useState(null);
  const [zones, setZones] = useState([]);
  const [equipment, setEquipment] = useState([]);
  const [showMemory, setShowMemory] = useState(false);
  const [memory, setMemory] = useState(null);
  const [retrying, setRetrying] = useState(false);
  // Reports | Settings. Opens on Reports every visit; settings sections start collapsed.
  const [view, setView] = useState('reports');
  const [openSections, setOpenSections] = useState({});
  const [dataSources, setDataSources] = useState(null); // GET /api/ai/data-sources, for the status line
  const [lastCapture, setLastCapture] = useState(null); // latest capture group, for the settings summary
  const loadSeq = useRef(0); // ignore responses from superseded report loads (fast prev/next taps)

  const switchView = (next) => {
    setView(next);
    if (next !== 'settings') setOpenSections({});
  };
  const toggleSection = (id) => setOpenSections(o => ({ ...o, [id]: !o[id] }));

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

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
    const seq = ++loadSeq.current;
    setPendingReportId(id);
    try {
      const res = await fetch(`${API_BASE}/agronomist/reports/${id}`, { headers });
      if (res.ok) {
        const data = await res.json();
        if (seq === loadSeq.current) setSelectedReport(data);
      }
    } catch (err) {
      showError('Failed to load report: ' + err.message);
    } finally {
      if (seq === loadSeq.current) setPendingReportId(null);
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
        if (window.confirm("Today's report already exists. Replace it? If the new report fails, the current one is kept.")) {
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
      // A failed regenerate keeps the existing report and marks it; refresh both.
      fetchReports();
      if (selectedReport?.id) loadReport(selectedReport.id);
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

  const onClarificationUpdated = async (regeneratedReport) => {
    if (regeneratedReport) {
      setSelectedReport(regeneratedReport);
      await fetchReports();
    } else {
      // Just appended a comment — reload the report so the thread refreshes
      await loadReport(selectedReport.id);
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold text-ink">Agronomist</h1>
          <p className="text-sm text-muted mt-0.5">Daily AI farm analysis with rolling long-term memory</p>
        </div>
        <div className="flex items-center gap-2">
          {canControl && (
            <Button
              variant="primary"
              onClick={() => generateNow(false)}
              disabled={generating || !config?.api_key_present}
              title={!config?.api_key_present ? 'ANTHROPIC_API_KEY not set in backend env' : 'Generate today\'s report now'}
            >
              {generating ? (
                <><svg aria-hidden="true" className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z"/></svg>
                Generating...</>
              ) : 'Generate Now'}
            </Button>
          )}
          <Button variant="secondary" onClick={() => setShowMemory(s => !s)} aria-expanded={showMemory}>
            Memory
          </Button>
        </div>
      </div>

      <ReportTabs variant="segmented" tabs={VIEWS} active={view} onChange={switchView} idBase={viewId} label="Agronomist view" />

      {/* API key warning */}
      {config && !config.api_key_present && (
        <Card rail="caution" padding="sm" className="text-sm text-ink">
          <strong>ANTHROPIC_API_KEY is not set in the backend container.</strong> The agronomist agent cannot run until it's configured. Set it via the <code className="font-mono bg-field px-1 rounded">.env</code> file alongside <code className="font-mono bg-field px-1 rounded">docker-compose.yml</code>, then restart the backend.
        </Card>
      )}

      {/* Provider failure banner */}
      {config?.health && (config.health.paused || config.health.consecutiveFailures > 0) && (
        <Card rail={config.health.paused ? 'alarm' : 'caution'} padding="sm" className="text-sm text-ink" data-testid="agronomist-health-banner">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill state={config.health.paused ? 'alarm' : 'caution'} filled text={config.health.paused ? 'paused' : 'failing'} />
                <strong>{ERROR_CLASS_TITLES[config.health.lastErrorClass] || ERROR_CLASS_TITLES.other}</strong>
              </div>
              <p className="mt-1 text-muted">
                {config.health.consecutiveFailures} consecutive failure{config.health.consecutiveFailures === 1 ? '' : 's'}
                {config.health.lastFailureAt ? <>, last at <span className="font-mono">{config.health.lastFailureAt} UTC</span></> : ''}
              </p>
              {config.health.paused && (
                <p className="mt-1">{config.health.pauseReason}</p>
              )}
              {config.health.lastErrorMessage && (
                <pre className="mt-2 text-xs font-mono whitespace-pre-wrap break-words bg-field border border-line p-2 rounded max-h-32 overflow-y-auto">{config.health.lastErrorMessage}</pre>
              )}
            </div>
            {canControl && (
              <Button
                variant="secondary"
                size="sm"
                onClick={retryNow}
                disabled={retrying || generating || !config.api_key_present}
                className="shrink-0"
                title="Run today's report immediately; a success resumes the schedule"
              >
                {retrying ? 'Retrying...' : 'Retry now'}
              </Button>
            )}
          </div>
        </Card>
      )}

      {/* Memory drawer */}
      {showMemory && (
        <MemoryPanel memory={memory} onClose={() => setShowMemory(false)} />
      )}

      {view === 'reports' ? (
        <div {...tabPanelProps(viewId, 'reports')} className="space-y-4 focus:outline-none">
          {/* Status line: what the agronomist is set to, one row. Settings live behind the switch above. */}
          <Card padding="sm" data-testid="agronomist-status-line">
            <div className="flex flex-wrap items-center gap-2 min-w-0">
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
          </Card>

          {selectedReport ? (
            <ReportView
              report={selectedReport}
              reports={reports}
              onSelect={loadReport}
              pending={pendingReportId != null && pendingReportId !== selectedReport.id}
              isAdmin={isAdmin}
              canControl={canControl}
              headers={headers}
              onClarificationUpdated={onClarificationUpdated}
            />
          ) : (
            <Card padding="lg" className="text-center text-sm text-muted" data-testid="agronomist-empty">
              {loading || pendingReportId != null
                ? 'Loading...'
                : reports.length === 0
                  ? 'No reports yet. Click "Generate Now" to create one.'
                  : 'Pick a report date, or click "Generate Now" to create one.'}
            </Card>
          )}
        </div>
      ) : (
        <div {...tabPanelProps(viewId, 'settings')} className="focus:outline-none">
          {/* Settings: inline, collapsible sections, each closed until asked for. */}
          <Card padding="none" className="divide-y divide-line" data-testid="agronomist-settings">
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
        </div>
      )}
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

// output_config.effort for the daily report (thinking depth). Haiku ignores it.
const EFFORT_OPTIONS = [
  ['low', 'Low (fastest, cheapest)'],
  ['medium', 'Medium (default)'],
  ['high', 'High (more thinking, less room for the report)'],
  ['xhigh', 'Extra high'],
];

function valuesFromConfig(config) {
  return {
    enabled: !!config.enabled,
    model: config.model || '',
    effort: config.effort || 'medium',
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
        effort: values.effort,
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
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Thinking effort</label>
        <select value={v.effort} onChange={e => form.set({ effort: e.target.value })}
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 dark:text-white">
          {!EFFORT_OPTIONS.some(([id]) => id === v.effort) && <option value={v.effort}>{v.effort} (current)</option>}
          {EFFORT_OPTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Thinking shares the output budget with the report. Not sent for Haiku.</p>
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
