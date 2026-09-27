import React, { useState, useEffect, useId, useMemo, useRef } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useFormat } from '../i18n/useFormat';
import { Card, Label, StatusPill, Button } from '../ui';
import DataSourcesPanel from '../components/agronomist/DataSourcesPanel';
import CapturePanel from '../components/agronomist/CaptureStrip';
import SettingsSection from '../components/agronomist/SettingsSection';
import ReportView from '../components/agronomist/ReportView';
import ReportTabs, { tabPanelProps } from '../components/agronomist/ReportTabs';
import { weekdayName } from '../components/agronomist/weekday';

/**
 * Agronomist page. i18n: UI chrome in locales/<lng>/agronomist.json. Report
 * text is AI-generated and never goes through t(); the backend returns it in
 * the request language when a translation exists (translation_status), and
 * ?original=1 forces English for one report ("Show original").
 */

const API_BASE = '/api';

// Short names for the status line ("2 sources out of service: AMIC, Lab"): keys
// into agronomist:sourceShort, the server label is the fallback.
const SOURCE_SHORT_KEYS = [
  'amic', 'lab', 'water_controller', 'canopy_capture', 'energy', 'fertigation',
  'substrate_sensors', 'climate_sensors', 'alerts', 'operator_tasks', 'automations_state',
];
const NOON_CAPTURE_TIME = '12:00'; // local; the capture scheduler runs the noon session at 12:00
const VIEW_IDS = ['reports', 'settings'];
const PENDING_TRANSLATION_POLL_MS = 15000;

const pad2 = (n) => String(parseInt(n, 10) || 0).padStart(2, '0');

const ERROR_CLASSES = ['billing', 'auth', 'rate_limit', 'truncated_output', 'max_tokens', 'refusal', 'other'];

export default function Agronomist() {
  const { t, i18n } = useTranslation('agronomist');
  const fmt = useFormat();
  const lng = i18n.language;
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
  // Reports shown in their English original (per report, this visit only - never persisted).
  const [originalIds, setOriginalIds] = useState(() => new Set());
  const originalIdsRef = useRef(originalIds);
  originalIdsRef.current = originalIds;
  const [translatingId, setTranslatingId] = useState(null); // admin "Translate" request in flight
  const loadSeq = useRef(0); // ignore responses from superseded report loads (fast prev/next taps)

  const views = VIEW_IDS.map(id => ({ id, label: t(`views.${id}`) }));

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
        showSuccess(t('toast.retryAlreadyExists'));
      } else if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      } else {
        showSuccess(t('toast.retryGenerated'));
        if (data.report) setSelectedReport(data.report);
      }
    } catch (err) {
      showError(t('toast.retryFailed', { error: err.message }));
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
      showError(t('toast.loadReportsFailed', { error: err.message }));
    }
    setLoading(false);
  };

  const loadReport = async (id, { original } = {}) => {
    const seq = ++loadSeq.current;
    const wantOriginal = original ?? originalIdsRef.current.has(id);
    setPendingReportId(id);
    try {
      const res = await fetch(`${API_BASE}/agronomist/reports/${id}${wantOriginal ? '?original=1' : ''}`, { headers });
      if (res.ok) {
        const data = await res.json();
        if (seq === loadSeq.current) setSelectedReport(data);
      }
    } catch (err) {
      showError(t('toast.loadReportFailed', { error: err.message }));
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

  // UI language switch: the report list and the open report come back in the new
  // language (Accept-Language), so refetch them once.
  const firstLng = useRef(lng);
  useEffect(() => {
    if (firstLng.current === lng) return;
    firstLng.current = lng;
    fetchReports();
    if (selectedReport?.id) loadReport(selectedReport.id);
  }, [lng]); // eslint-disable-line react-hooks/exhaustive-deps

  // Translation in progress: check again until it is ready (or fails).
  useEffect(() => {
    if (!selectedReport || selectedReport.translation_status !== 'pending') return undefined;
    if (originalIdsRef.current.has(selectedReport.id)) return undefined;
    const id = selectedReport.id;
    const timer = setTimeout(() => { loadReport(id); }, PENDING_TRANSLATION_POLL_MS);
    return () => clearTimeout(timer);
  }, [selectedReport]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleOriginal = (id) => {
    const next = new Set(originalIdsRef.current);
    const original = !next.has(id);
    if (original) next.add(id); else next.delete(id);
    originalIdsRef.current = next;
    setOriginalIds(next);
    loadReport(id, { original });
  };

  // Admin: ask the backend to (re)translate this report into the UI language.
  // One paid API call per language, queued server-side (202).
  const requestTranslation = async (id) => {
    if (!window.confirm(t('translation.confirmTranslate', { language: t(`translation.languageName.${lng}`, { defaultValue: lng }) }))) return;
    setTranslatingId(id);
    try {
      const res = await fetch(`${API_BASE}/agronomist/reports/${id}/translate`, {
        method: 'POST', headers, body: JSON.stringify({ lang: lng }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      showSuccess(t('toast.translationRequested'));
      if (originalIdsRef.current.has(id)) {
        const next = new Set(originalIdsRef.current);
        next.delete(id);
        originalIdsRef.current = next;
        setOriginalIds(next);
      }
      await loadReport(id, { original: false });
    } catch (err) {
      showError(t('toast.translationRequestFailed', { error: err.message }));
    } finally {
      setTranslatingId(null);
    }
  };

  const generateNow = async (force = false) => {
    setGenerating(true);
    try {
      const res = await fetch(`${API_BASE}/agronomist/generate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ force }),
      });
      if (res.status === 409) {
        if (window.confirm(t('confirm.replaceToday'))) {
          return generateNow(true);
        }
      } else if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      } else {
        showSuccess(t('toast.generated'));
        await fetchReports();
        const data = await res.json();
        if (data.report) setSelectedReport(data.report);
      }
    } catch (err) {
      showError(t('toast.generateFailed', { error: err.message }));
      // A failed regenerate keeps the existing report and marks it; refresh both.
      fetchReports();
      if (selectedReport?.id) loadReport(selectedReport.id);
    }
    setGenerating(false);
  };

  const runWeeklyRollup = async () => {
    if (!window.confirm(t('confirm.weeklyRollup'))) return;
    try {
      const res = await fetch(`${API_BASE}/agronomist/weekly-rollup`, { method: 'POST', headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      if (data.skipped) showError(t('toast.rollupSkipped', { reason: data.reason }));
      else showSuccess(t('toast.rollupWritten', { start: data.week_start, end: data.week_end }));
      fetchMemory();
    } catch (err) {
      showError(t('toast.rollupFailed', { error: err.message }));
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
      showSuccess(t('toast.settingsSaved'));
      return updated;
    } catch (err) {
      showError(t('toast.saveFailed', { error: err.message }));
      return null;
    }
  };

  const form = useConfigForm(config, saveConfig);

  // One-line summaries for the status line and the collapsed section headers.
  const summaries = useMemo(() => {
    const out = {};
    if (config) {
      out.schedule = config.enabled
        ? t('summary.daily', { time: `${pad2(config.schedule_hour)}:${pad2(config.schedule_minute)}` })
        : t('summary.scheduleOff');
      out.weekly = t('summary.weekly', {
        day: weekdayName(config.weekly_rollup_day, lng),
        time: `${pad2(config.weekly_rollup_hour)}:${pad2(config.weekly_rollup_minute)}`,
      });
      out.scheduleLine = `${out.schedule} · ${config.model} · ${out.weekly}`;
      const frames = config.capture_frames || 3;
      out.captureOn = config.capture_enabled !== false;
      out.capture = out.captureOn ? t('summary.captureFrames', { count: frames, time: NOON_CAPTURE_TIME }) : t('summary.captureOff');
      const byId = Object.fromEntries((equipment || []).map(e => [e.id, e.name]));
      const ref = (id) => (id ? (byId[id] || `#${id}`) : t('summary.none'));
      out.reference = t('summary.reference', {
        temp: ref(config.reference_temperature_equipment_id),
        rh: ref(config.reference_humidity_equipment_id),
        soil: ref(config.reference_soil_equipment_id),
      });
    }
    if (lastCapture?.frames?.length) {
      const first = [...lastCapture.frames].sort((a, b) => String(a.captured_at).localeCompare(String(b.captured_at)))[0];
      const n = lastCapture.frames.length;
      out.captureLast = t('summary.lastSession', {
        time: first?.captured_at ? fmt.dateTime(first.captured_at, { year: undefined, second: undefined }) : '',
        frames: t('count.frame', { count: n }),
      });
    } else if (lastCapture !== null || config) {
      out.captureLast = t('summary.noSession');
    }
    if (dataSources) {
      const order = dataSources.order || Object.keys(dataSources.sources || {});
      const disabled = dataSources.disabled || [];
      const names = disabled.map(k => (SOURCE_SHORT_KEYS.includes(k)
        ? t(`sourceShort.${k}`)
        : (dataSources.sources?.[k]?.label || k)));
      out.sourcesOut = disabled.length;
      out.sourcesIn = order.length - disabled.length;
      out.sourceNames = names;
      out.sourcesLine = disabled.length
        ? t('summary.sourcesSomeOut', { inUse: out.sourcesIn, count: disabled.length, names: names.join(', ') })
        : t('summary.sourcesAllIn', { count: order.length });
    }
    return out;
  }, [config, equipment, lastCapture, dataSources, t, lng, fmt]);

  const onClarificationUpdated = async (regeneratedReport) => {
    if (regeneratedReport) {
      setSelectedReport(regeneratedReport);
      await fetchReports();
    } else {
      // Just appended a comment — reload the report so the thread refreshes
      await loadReport(selectedReport.id);
    }
  };

  const shownSourceNames = summaries.sourceNames
    ? summaries.sourceNames.slice(0, 4).join(', ') + (summaries.sourceNames.length > 4 ? ` +${summaries.sourceNames.length - 4}` : '')
    : '';

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold text-ink">{t('title')}</h1>
          <p className="text-sm text-muted mt-0.5">{t('subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canControl && (
            <Button
              variant="primary"
              onClick={() => generateNow(false)}
              disabled={generating || !config?.api_key_present}
              title={!config?.api_key_present ? t('actions.apiKeyMissingTitle') : t('actions.generateNowTitle')}
            >
              {generating ? (
                <><svg aria-hidden="true" className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z"/></svg>
                {t('actions.generating')}</>
              ) : t('actions.generateNow')}
            </Button>
          )}
          <Button variant="secondary" onClick={() => setShowMemory(s => !s)} aria-expanded={showMemory}>
            {t('actions.memory')}
          </Button>
        </div>
      </div>

      <ReportTabs variant="segmented" tabs={views} active={view} onChange={switchView} idBase={viewId} label={t('views.label')} />

      {/* API key warning */}
      {config && !config.api_key_present && (
        <Card rail="caution" padding="sm" className="text-sm text-ink">
          <Trans
            t={t}
            i18nKey="apiKeyWarning"
            components={{
              b: <strong />,
              code: <code className="font-mono bg-field px-1 rounded" dir="ltr" />,
            }}
          />
        </Card>
      )}

      {/* Provider failure banner */}
      {config?.health && (config.health.paused || config.health.consecutiveFailures > 0) && (
        <Card rail={config.health.paused ? 'alarm' : 'caution'} padding="sm" className="text-sm text-ink" data-testid="agronomist-health-banner">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill state={config.health.paused ? 'alarm' : 'caution'} filled text={config.health.paused ? t('health.paused') : t('health.failing')} />
                <strong>{t(`health.errorTitle.${ERROR_CLASSES.includes(config.health.lastErrorClass) ? config.health.lastErrorClass : 'other'}`)}</strong>
              </div>
              <p className="mt-1 text-muted">
                {config.health.lastFailureAt
                  ? t('health.failuresLastAt', {
                    failures: t('count.consecutiveFailure', { count: config.health.consecutiveFailures }),
                    time: fmt.dateTime(config.health.lastFailureAt, { fallback: String(config.health.lastFailureAt) }),
                  })
                  : t('count.consecutiveFailure', { count: config.health.consecutiveFailures })}
              </p>
              {config.health.paused && (
                <p className="mt-1">{config.health.pauseReason}</p>
              )}
              {config.health.lastErrorMessage && (
                <pre dir="ltr" className="mt-2 text-xs font-mono whitespace-pre-wrap break-words bg-field border border-line p-2 rounded max-h-32 overflow-y-auto text-start">{config.health.lastErrorMessage}</pre>
              )}
            </div>
            {canControl && (
              <Button
                variant="secondary"
                size="sm"
                onClick={retryNow}
                disabled={retrying || generating || !config.api_key_present}
                className="shrink-0"
                title={t('actions.retryNowTitle')}
              >
                {retrying ? t('actions.retrying') : t('actions.retryNow')}
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
              <Label className="hidden sm:block shrink-0 me-1">{t('status.setup')}</Label>
              {config ? (
                <>
                  <StatusPill state={config.enabled ? 'ok' : 'idle'} filled={!!config.enabled} text={summaries.schedule} data-testid="status-schedule" />
                  <span className="hidden sm:inline font-mono text-xs text-muted" data-testid="status-model">{config.model}</span>
                  <StatusPill state={summaries.captureOn ? 'ok' : 'idle'} filled={summaries.captureOn} text={summaries.captureOn ? t('status.captureOn') : t('status.captureOff')} data-testid="status-capture" />
                </>
              ) : (
                <StatusPill state="idle" text={t('common:status.loading')} />
              )}
              {dataSources && (
                summaries.sourcesOut > 0 ? (
                  <StatusPill
                    state="caution"
                    filled
                    className="max-w-full !whitespace-normal sm:!whitespace-nowrap"
                    data-testid="status-sources"
                    title={t('status.outOfServiceTitle', { names: (dataSources.disabled || []).map(k => dataSources.sources?.[k]?.label || k).join(', ') })}
                  >
                    <span className="sm:hidden">{t('status.sourcesOutShort', { count: summaries.sourcesOut, names: shownSourceNames })}</span>
                    <span className="hidden sm:inline">{t('status.sourcesOut', { count: summaries.sourcesOut, names: shownSourceNames })}</span>
                  </StatusPill>
                ) : (
                  <StatusPill state="ok" filled text={t('status.allSourcesInUse')} data-testid="status-sources" />
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
              showingOriginal={originalIds.has(selectedReport.id)}
              onToggleOriginal={() => toggleOriginal(selectedReport.id)}
              onTranslate={() => requestTranslation(selectedReport.id)}
              translating={translatingId === selectedReport.id}
            />
          ) : (
            <Card padding="lg" className="text-center text-sm text-muted" data-testid="agronomist-empty">
              {loading || pendingReportId != null
                ? t('common:status.loading')
                : reports.length === 0
                  ? t('empty.noReports')
                  : t('empty.pickReport')}
            </Card>
          )}
        </div>
      ) : (
        <div {...tabPanelProps(viewId, 'settings')} className="focus:outline-none">
          {/* Settings: inline, collapsible sections, each closed until asked for. */}
          <Card padding="none" className="divide-y divide-line" data-testid="agronomist-settings">
            {isAdmin && config && (
              <SettingsSection id="schedule" title={t('settings.scheduleTitle')} summary={summaries.scheduleLine} open={!!openSections.schedule} onToggle={() => toggleSection('schedule')}>
                <ScheduleModelFields form={form} onWeeklyRollup={runWeeklyRollup} />
                <ConfigSaveBar form={form} />
              </SettingsSection>
            )}
            <SettingsSection id="sources" title={t('settings.sourcesTitle')} summary={summaries.sourcesLine || t('common:status.loading')} open={!!openSections.sources} onToggle={() => toggleSection('sources')}>
              <DataSourcesPanel embedded headers={headers} canEdit={canControl} equipment={equipment} onSaved={setDataSources} />
            </SettingsSection>
            <SettingsSection id="capture" title={t('settings.captureTitle')} summary={[summaries.capture, summaries.captureLast].filter(Boolean).join(' · ')} open={!!openSections.capture} onToggle={() => toggleSection('capture')}>
              <CapturePanel embedded headers={headers} canControl={canControl} config={config} />
            </SettingsSection>
            {isAdmin && config && (
              <SettingsSection id="reference" title={t('settings.referenceTitle')} summary={summaries.reference} open={!!openSections.reference} onToggle={() => toggleSection('reference')}>
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
// [model id, product name (never translated), optional note key under settings.modelNote]
const MODEL_OPTIONS = [
  ['claude-sonnet-5', 'Claude Sonnet 5', 'default'],
  ['claude-sonnet-4-6', 'Claude Sonnet 4.6', null],
  ['claude-opus-4-7', 'Claude Opus 4.7', 'mostCapable'],
  ['claude-haiku-4-5', 'Claude Haiku 4.5', 'cheapest'],
];

// output_config.effort for the daily report (thinking depth). Haiku ignores it.
// Labels: agronomist:settings.effort.<id>.
const EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh'];

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
  const { t } = useTranslation('agronomist');
  if (!form.values) return null;
  return (
    <div className="mt-4 flex flex-wrap items-center justify-end gap-3" data-testid="config-save-bar">
      {form.dirty && <span className="text-xs text-caution-700 dark:text-caution-300 me-auto">{t('settings.unsavedNextRun')}</span>}
      <Button variant="secondary" size="sm" onClick={form.reset} disabled={!form.dirty || form.saving}>{t('actions.discard')}</Button>
      <Button variant="primary" size="sm" onClick={form.save} disabled={!form.dirty || form.saving}>{form.saving ? t('common:actions.saving') : t('actions.saveSettings')}</Button>
    </div>
  );
}

function ScheduleModelFields({ form, onWeeklyRollup }) {
  const { t, i18n } = useTranslation('agronomist');
  const v = form.values;
  if (!v) return null;
  const dayIndexes = [0, 1, 2, 3, 4, 5, 6];
  const modelKnown = MODEL_OPTIONS.some(([id]) => id === v.model);
  const modelLabel = (name, note) => (note ? t('settings.modelWithNote', { name, note: t(`settings.modelNote.${note}`) }) : name);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={v.enabled} onChange={e => form.set({ enabled: e.target.checked })} className="rounded" />
          <span className="font-medium text-gray-700 dark:text-gray-300">{t('settings.enableDaily')}</span>
        </label>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{t('settings.enableDailyHelp')}</p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('settings.model')}</label>
        <select value={v.model} onChange={e => form.set({ model: e.target.value })}
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 dark:text-white">
          {!modelKnown && v.model && <option value={v.model}>{t('settings.currentOption', { value: v.model })}</option>}
          {MODEL_OPTIONS.map(([id, name, note]) => <option key={id} value={id}>{modelLabel(name, note)}</option>)}
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('settings.effortLabel')}</label>
        <select value={v.effort} onChange={e => form.set({ effort: e.target.value })}
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 dark:text-white">
          {!EFFORT_OPTIONS.includes(v.effort) && <option value={v.effort}>{t('settings.currentOption', { value: v.effort })}</option>}
          {EFFORT_OPTIONS.map(id => <option key={id} value={id}>{t(`settings.effort.${id}`)}</option>)}
        </select>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{t('settings.effortHelp')}</p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('settings.dailyTime')}</label>
        <div className="flex items-center gap-2" dir="ltr">
          <input type="number" min="0" max="23" value={v.hour} onChange={e => form.set({ hour: e.target.value })} className={`w-20 ${INPUT}`} aria-label={t('settings.hour')} />
          <span className="text-gray-500">:</span>
          <input type="number" min="0" max="59" value={v.minute} onChange={e => form.set({ minute: e.target.value })} className={`w-20 ${INPUT}`} aria-label={t('settings.minute')} />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('settings.weeklyRollup')}</label>
        <div className="flex flex-wrap items-center gap-2">
          <select value={v.weeklyDay} onChange={e => form.set({ weeklyDay: e.target.value })} className={INPUT}>
            {dayIndexes.map(i => <option key={i} value={i}>{weekdayName(i, i18n.language, 'long')}</option>)}
          </select>
          <span className="inline-flex items-center gap-2" dir="ltr">
            <input type="number" min="0" max="23" value={v.weeklyHour} onChange={e => form.set({ weeklyHour: e.target.value })} className={`w-16 ${INPUT}`} aria-label={t('settings.hour')} />
            <span className="text-gray-500">:</span>
            <input type="number" min="0" max="59" value={v.weeklyMinute} onChange={e => form.set({ weeklyMinute: e.target.value })} className={`w-16 ${INPUT}`} aria-label={t('settings.minute')} />
          </span>
          <button type="button" onClick={onWeeklyRollup}
            className="ms-auto px-3 py-1 text-xs bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded">
            {t('actions.runNow')}
          </button>
        </div>
      </div>

      <div className="md:col-span-2">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {t('settings.promptOverride')} <span className="text-xs text-gray-500">{t('settings.promptOverrideHint')}</span>
        </label>
        <textarea
          value={v.promptOverride}
          onChange={e => form.set({ promptOverride: e.target.value })}
          placeholder={t('settings.promptOverridePlaceholder')}
          rows={4}
          dir="auto"
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 dark:text-white font-mono"
        />
      </div>
    </div>
  );
}

function ReferenceSensorFields({ form, zones, equipment }) {
  const { t } = useTranslation('agronomist');
  const v = form.values;
  if (!v) return null;
  const sensorEquipment = (equipment || []).filter(e => e.type === 'sensor');
  const toggle = (key, id) => {
    const list = v[key];
    form.set({ [key]: list.includes(id) ? list.filter(x => x !== id) : [...list, id] });
  };
  const refSelect = (key, labelKey) => (
    <select value={v[key]} onChange={e => form.set({ [key]: e.target.value })} aria-label={t(labelKey)}
      className="w-full px-2 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-700 dark:text-white">
      <option value="">{t('reference.noneOption')}</option>
      {sensorEquipment.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
    </select>
  );
  const zoneList = (key) => (
    <div className="border border-gray-300 dark:border-gray-600 rounded p-2 max-h-32 overflow-y-auto bg-white dark:bg-gray-700">
      {zones.length === 0 && <p className="text-xs text-gray-500">{t('reference.noZones')}</p>}
      {zones.map(z => (
        <label key={z.id} className="flex items-center gap-2 text-sm py-0.5">
          <input type="checkbox" checked={v[key].includes(z.id)} onChange={() => toggle(key, z.id)} className="rounded" />
          <span className="text-gray-800 dark:text-gray-200" dir="auto">{z.name}</span>
        </label>
      ))}
    </div>
  );

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
          {t('reference.help')}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div><p className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">{t('reference.temperature')}</p>{refSelect('refTemp', 'reference.temperature')}</div>
          <div><p className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">{t('reference.humidity')}</p>{refSelect('refHum', 'reference.humidity')}</div>
          <div><p className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">{t('reference.soil')}</p>{refSelect('refSoil', 'reference.soil')}</div>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">{t('reference.zoneRoles')}</label>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
          {t('reference.zoneRolesHelp')}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div><p className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">{t('reference.feed')}</p>{zoneList('irrigIds')}</div>
          <div><p className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">{t('reference.drain')}</p>{zoneList('drainIds')}</div>
        </div>
      </div>
    </div>
  );
}

function MemoryPanel({ memory, onClose }) {
  const { t } = useTranslation('agronomist');
  const fmt = useFormat();
  return (
    <div className="mb-4 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">{t('memory.title')}</h2>
        <button onClick={onClose} aria-label={t('common:actions.close')} title={t('common:actions.close')} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">✕</button>
      </div>
      {!memory || !memory.current ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('memory.empty')}</p>
      ) : (
        <>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
            {t('memory.meta', {
              version: memory.current.version,
              size: fmt.int(memory.current.byte_size),
              time: fmt.dateTime(memory.current.created_at),
              trigger: memory.current.triggered_by,
            })}
          </p>
          <pre dir="auto" className="text-xs bg-gray-50 dark:bg-gray-900 p-3 rounded whitespace-pre-wrap text-gray-800 dark:text-gray-200 max-h-96 overflow-y-auto">{memory.current.content}</pre>
          {memory.history.length > 1 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-sm text-gray-600 dark:text-gray-400">{t('memory.olderVersions', { count: memory.history.length - 1 })}</summary>
              <div className="mt-2 space-y-2">
                {memory.history.slice(1).map(v => (
                  <details key={v.version} className="border border-gray-200 dark:border-gray-700 rounded">
                    <summary className="p-2 text-xs cursor-pointer text-gray-700 dark:text-gray-300">{t('memory.versionLine', { version: v.version, time: fmt.dateTime(v.created_at) })}</summary>
                    <pre dir="auto" className="text-xs p-2 whitespace-pre-wrap text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-900">{v.content}</pre>
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
