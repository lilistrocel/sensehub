import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useThrottledError } from '../hooks/useThrottledError';
import { useTranslation, Trans } from 'react-i18next';
import { useFormat } from '../i18n/useFormat';

const API_BASE = '/api';

// Values only; labels come from amic:nutrient.<value> at render ('' and pH are special-cased).
const NUTRIENT_OPTIONS = [
  { value: '' },
  { value: 'nitrate_NO3' },
  { value: 'phosphate_PO4' },
  { value: 'potassium_K' },
  { value: 'calcium_Ca' },
  { value: 'magnesium_Mg' },
  { value: 'sodium_Na' },
  { value: 'ammonium_NH4' },
  { value: 'chloride_Cl' },
  { value: 'sulfate_SO4' },
  { value: 'pH' },
];

// Fallback host shown when the backend reports no error text.
const AMIC_DEFAULT_HOST = '192.168.1.104:502';

export default function Amic() {
  const { token, user } = useAuth();
  const { showError, showSuccess } = useToast();
  const { t } = useTranslation('amic');
  const fmt = useFormat();
  const canControl = user?.role === 'admin' || user?.role === 'operator';

  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [actionInFlight, setActionInFlight] = useState(null);
  const [now, setNow] = useState(Date.now());

  const [channels, setChannels] = useState([]);
  const [editingChannels, setEditingChannels] = useState(false);
  const [zones, setZones] = useState([]);

  // Save to lab
  const [savingToLab, setSavingToLab] = useState(false);
  const [labZoneId, setLabZoneId] = useState('');
  const [labUseNow, setLabUseNow] = useState(true);
  const [labSampleDate, setLabSampleDate] = useState('');

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const pollIntervalRef = useRef(null);

  // Tick clock for elapsed time display
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const fetchStatus = async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/amic/status`, { headers });
      const data = await res.json();
      setStatus(data);
    } catch (err) {
      // keep last status
    } finally {
      if (showSpinner) setLoading(false);
    }
  };

  const fetchChannels = async () => {
    try {
      const res = await fetch(`${API_BASE}/amic/channels`, { headers });
      if (res.ok) setChannels(await res.json());
      else showError(t('errors.loadChannels'));
    } catch (err) {
      showError(t('errors.loadChannelsWith', { error: err.message }));
    }
  };

  const fetchZones = async () => {
    try {
      const res = await fetch(`${API_BASE}/zones`, { headers });
      if (res.ok) setZones(await res.json());
      else showError(t('errors.loadZones'));
    } catch (err) {
      showError(t('errors.loadZonesWith', { error: err.message }));
    }
  };

  useEffect(() => {
    fetchStatus(true);
    fetchChannels();
    fetchZones();
  }, []);

  // Poll faster while a cycle is running
  useEffect(() => {
    const isRunning = status?.state && Object.values(status.state).some(Boolean);
    const interval = isRunning ? 15000 : 60000;

    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    pollIntervalRef.current = setInterval(() => fetchStatus(false), interval);
    return () => { if (pollIntervalRef.current) clearInterval(pollIntervalRef.current); };
  }, [status?.state?.measuring, status?.state?.calibrating, status?.state?.draining, status?.state?.empty_system, status?.state?.conditioning]);

  const runAction = async (action, label, expectedMin) => {
    if (!confirm(t('ops.confirmStart', { label, count: expectedMin }))) return;
    setActionInFlight(action);
    try {
      const res = await fetch(`${API_BASE}/amic/${action}`, { method: 'POST', headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || t('errors.failed'));
      showSuccess(data.message || t('ops.started', { label }));
      // Backend stamps current_cycle on trigger; refresh status to pick it up
      setTimeout(() => fetchStatus(false), 2000);
    } catch (err) {
      showError(err.message);
    } finally {
      setActionInFlight(null);
    }
  };

  const saveChannels = async () => {
    try {
      const res = await fetch(`${API_BASE}/amic/channels`, {
        method: 'PUT', headers, body: JSON.stringify({ channels })
      });
      if (!res.ok) throw new Error(t('channels.saveFailed'));
      showSuccess(t('channels.saved'));
      setEditingChannels(false);
    } catch (err) {
      showError(err.message);
    }
  };

  const saveToLab = async () => {
    setSavingToLab(true);
    try {
      // Convert datetime-local (browser local time) to ISO UTC, or use now
      const sampleDate = labUseNow
        ? new Date().toISOString()
        : (labSampleDate ? new Date(labSampleDate).toISOString() : new Date().toISOString());

      const res = await fetch(`${API_BASE}/amic/save-to-lab`, {
        method: 'POST', headers,
        body: JSON.stringify({ zone_id: labZoneId || null, sample_date: sampleDate })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('errors.failed'));
      const when = labUseNow ? t('measurements.whenNow') : fmt.dateTime(sampleDate);
      showSuccess(t('measurements.savedToLab', { count: data.count, when }));
      // Reset to "now" after save
      setLabUseNow(true);
      setLabSampleDate('');
    } catch (err) {
      showError(err.message);
    } finally {
      setSavingToLab(false);
    }
  };

  const formatLocalDatetime = (date) => {
    const d = new Date(date);
    d.setSeconds(0, 0);
    const tz = d.getTimezoneOffset() * 60000;
    return new Date(d - tz).toISOString().slice(0, 16);
  };

  // Display metadata per state — colors and human-readable names (amic:state.*). Expected duration comes from API.
  const STATE_DISPLAY = {
    measuring:    { name: t('state.measuring'),    color: 'blue' },
    calibrating:  { name: t('state.calibrating'),  color: 'amber' },
    draining:     { name: t('state.draining'),     color: 'cyan' },
    empty_system: { name: t('state.empty_system'), color: 'purple' },
    conditioning: { name: t('state.conditioning'), color: 'pink' },
  };

  // Static, full class strings per color so Tailwind's JIT keeps them. Dynamic
  // strings like `bg-${color}-50` get purged at build time and never render, so
  // we look up complete literal class names instead. Keep keys in sync with the
  // `color` values in STATE_DISPLAY above.
  const STATE_COLOR_CLASSES = {
    blue:   { banner: 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800',         text: 'text-blue-700 dark:text-blue-400',     bar: 'bg-blue-500' },
    amber:  { banner: 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800',      text: 'text-amber-700 dark:text-amber-400',   bar: 'bg-amber-500' },
    cyan:   { banner: 'bg-cyan-50 dark:bg-cyan-900/20 border-cyan-200 dark:border-cyan-800',          text: 'text-cyan-700 dark:text-cyan-400',     bar: 'bg-cyan-500' },
    purple: { banner: 'bg-purple-50 dark:bg-purple-900/20 border-purple-200 dark:border-purple-800',  text: 'text-purple-700 dark:text-purple-400', bar: 'bg-purple-500' },
    pink:   { banner: 'bg-pink-50 dark:bg-pink-900/20 border-pink-200 dark:border-pink-800',          text: 'text-pink-700 dark:text-pink-400',     bar: 'bg-pink-500' },
  };

  // Drive the cycle banner from the persisted current_cycle (survives page reload + backend restart).
  // Falls back to live state flags if the API is older than this build.
  const currentCycle = (() => {
    const cc = status?.current_cycle;
    if (cc?.state && STATE_DISPLAY[cc.state]) {
      return {
        ...STATE_DISPLAY[cc.state],
        state: cc.state,
        expected: cc.expected_duration_min || 0,
        startedAt: cc.started_at ? new Date(cc.started_at).getTime() : null,
        source: cc.source || 'unknown',
      };
    }
    // Legacy fallback (no current_cycle in API response)
    if (!status?.state) return null;
    for (const k of ['measuring','calibrating','draining','empty_system','conditioning']) {
      if (status.state[k]) return { ...STATE_DISPLAY[k], state: k, expected: 0, startedAt: null, source: 'legacy' };
    }
    return null;
  })();

  const cycleColor = currentCycle ? STATE_COLOR_CLASSES[currentCycle.color] : null;

  const elapsedSecTotal = currentCycle?.startedAt ? Math.max(0, Math.floor((now - currentCycle.startedAt) / 1000)) : 0;
  const elapsedMin = Math.floor(elapsedSecTotal / 60);
  const elapsedSec = elapsedSecTotal % 60;
  const expectedSecTotal = (currentCycle?.expected || 0) * 60;
  const remainingSecTotal = Math.max(0, expectedSecTotal - elapsedSecTotal);
  const remainingMin = Math.ceil(remainingSecTotal / 60);
  const progressPct = expectedSecTotal > 0
    ? Math.min(100, Math.round((elapsedSecTotal / expectedSecTotal) * 100))
    : 0;
  const overrunning = expectedSecTotal > 0 && elapsedSecTotal > expectedSecTotal * 1.5;

  if (loading) {
    return <div className="p-6 text-center text-gray-500">{t('loading')}</div>;
  }

  if (!status?.connected) {
    return (
      <div className="max-w-4xl mx-auto p-4 sm:p-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">{t('title')}</h1>
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
          <p className="font-semibold text-red-800 dark:text-red-400">{t('notConnected.title')}</p>
          <p className="text-sm text-red-700 dark:text-red-400 mt-1" dir="auto">{status?.error || t('notConnected.unreachable', { host: AMIC_DEFAULT_HOST })}</p>
          <button onClick={() => fetchStatus(true)} className="mt-3 px-3 py-1.5 text-sm bg-red-600 text-white rounded">{t('common:actions.retry')}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t('title')}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400" lang="en" dir="ltr">{'NT Sensors A7-303-MB'} · {status.host}</p>
        </div>
        <button onClick={() => fetchStatus(true)} aria-label={t('refreshAria')} title={t('refreshAria')} className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
        </button>
      </div>

      {/* Status banner */}
      <div className={`rounded-lg p-4 border ${
        cycleColor
          ? cycleColor.banner
          : 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800'
      }`}>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <p className="text-xs uppercase font-semibold text-gray-600 dark:text-gray-400">{t('banner.currentState')}</p>
            <p className={`text-2xl font-bold ${cycleColor ? cycleColor.text : 'text-green-700 dark:text-green-400'}`}>
              {currentCycle ? t('banner.inProgress', { name: currentCycle.name }) : <>✓ {t('banner.idle')}</>}
            </p>
            {currentCycle?.source === 'panel' && (
              <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">{t('banner.fromPanel')}</p>
            )}
            {currentCycle?.source === 'unknown' && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-0.5">{t('banner.startUnknown')}</p>
            )}
          </div>
          {currentCycle && currentCycle.startedAt && (
            <div className="text-end">
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('banner.elapsed')}</p>
              <p className="text-2xl font-mono font-bold text-gray-900 dark:text-white" dir="ltr">
                {String(elapsedMin).padStart(2,'0')}:{String(elapsedSec).padStart(2,'0')}
              </p>
              {currentCycle.expected > 0 && currentCycle.source !== 'unknown' && !overrunning && (
                <p className="text-xs text-gray-500">{t('banner.remaining', { remaining: remainingMin, total: currentCycle.expected })}</p>
              )}
              {overrunning && (
                <p className="text-xs text-amber-600 dark:text-amber-400">⚠ {t('banner.overrunning', { min: currentCycle.expected })}</p>
              )}
              {currentCycle.expected > 0 && currentCycle.source === 'unknown' && (
                <p className="text-xs text-gray-500">{t('banner.expectedTotal', { min: currentCycle.expected })}</p>
              )}
            </div>
          )}
        </div>
        {currentCycle && currentCycle.expected > 0 && currentCycle.startedAt && (
          <div className="mt-3 w-full bg-white/60 dark:bg-black/30 rounded-full h-1.5 overflow-hidden">
            <div
              className={`h-full transition-all duration-500 ease-out ${overrunning ? 'bg-amber-500' : (cycleColor ? cycleColor.bar : 'bg-green-500')}`}
              style={{ width: `${progressPct}%` }}
            />
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">{t('ops.title')}</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
          <ActionBtn label={t('ops.runMeasurement')} subtitle={t('ops.subMin', { min: 5 })} color="blue"
            disabled={!!currentCycle || !canControl}
            loading={actionInFlight === 'measure'}
            onClick={() => runAction('measure', t('ops.measurement'), 5)} />
          <ActionBtn label={t('ops.runCalibration')} subtitle={t('ops.subCalibrate', { min: 20 })} color="amber"
            disabled={!!currentCycle || !canControl}
            loading={actionInFlight === 'calibrate'}
            onClick={() => runAction('calibrate', t('ops.calibration'), 20)} />
          <ActionBtn label={t('ops.drain')} subtitle={t('ops.subMin', { min: 1 })} color="cyan"
            disabled={!!currentCycle || !canControl}
            loading={actionInFlight === 'drain'}
            onClick={() => runAction('drain', t('ops.drain'), 1)} />
          <ActionBtn label={t('ops.emptySystem')} subtitle={t('ops.subEmpty', { min: 5 })} color="purple"
            disabled={!!currentCycle || !canControl}
            loading={actionInFlight === 'empty-system'}
            onClick={() => runAction('empty-system', t('ops.emptySystem'), 5)} />
          <ActionBtn label={t('ops.conditioning')} subtitle={t('ops.subConditioning', { min: 120 })} color="pink"
            disabled={!!currentCycle || !canControl}
            loading={actionInFlight === 'condition'}
            onClick={() => runAction('condition', t('ops.conditioning'), 120)} />
        </div>
      </div>

      {/* Latest measurements */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
        <div className="flex items-start justify-between mb-3 flex-wrap gap-3">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{t('measurements.title')}</h3>
          {canControl && (
            <div className="flex items-end gap-2 flex-wrap">
              <div>
                <label className="block text-[10px] text-gray-500 dark:text-gray-400 mb-0.5 uppercase">{t('measurements.zone')}</label>
                <select value={labZoneId} onChange={e => setLabZoneId(e.target.value)}
                  className="text-xs px-2 py-1.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300">
                  <option value="">{t('measurements.noZone')}</option>
                  {zones.map(z => <option key={z.id} value={z.id}>{z.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[10px] text-gray-500 dark:text-gray-400 mb-0.5 uppercase">{t('measurements.sampleTaken')}</label>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1 text-xs cursor-pointer select-none">
                    <input type="checkbox" checked={labUseNow}
                      onChange={e => {
                        setLabUseNow(e.target.checked);
                        if (!e.target.checked && !labSampleDate) {
                          setLabSampleDate(formatLocalDatetime(new Date()));
                        }
                      }} className="w-3.5 h-3.5" />
                    <span className="text-gray-700 dark:text-gray-300">{t('measurements.now')}</span>
                  </label>
                  {!labUseNow && (
                    <input type="datetime-local" value={labSampleDate}
                      onChange={e => setLabSampleDate(e.target.value)}
                      dir="ltr"
                      className="text-xs px-2 py-1.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300" />
                  )}
                </div>
              </div>
              <button onClick={saveToLab} disabled={savingToLab || (!labUseNow && !labSampleDate)}
                className="text-xs px-3 py-1.5 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50">
                {savingToLab ? t('measurements.saving') : <><span aria-hidden="true" className="inline-block rtl:-scale-x-100">→</span> {t('measurements.saveToLab')}</>}
              </button>
            </div>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-start text-xs text-gray-500 dark:text-gray-400 uppercase border-b border-gray-200 dark:border-gray-700">
                <th className="pb-2 pe-3 text-start">{t('measurements.colChannel')}</th>
                <th className="pb-2 pe-3 text-start">{t('measurements.colIon')}</th>
                <th className="pb-2 pe-3 text-end">{t('measurements.colValue')}</th>
                <th className="pb-2 pe-3 text-start">{t('measurements.colUnit')}</th>
                <th className="pb-2 pe-3 text-start">{t('measurements.colCalibration')}</th>
                <th className="pb-2 pe-3 text-start">{t('measurements.colMeasurement')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {status.measurements.map((m, i) => {
                const cal = status.calibration_check[i];
                const meas = status.measurement_check[i];
                return (
                  <tr key={m.channel} className={`text-gray-700 dark:text-gray-300 ${!m.enabled ? 'opacity-40' : ''}`}>
                    <td className="py-2 pe-3 font-medium" dir="auto">{m.label}</td>
                    <td className="py-2 pe-3 text-gray-500" dir="ltr">{m.ion || '—'}</td>
                    <td className="py-2 pe-3 text-end font-mono font-bold text-gray-900 dark:text-white" dir="ltr">
                      {fmt.number(m.value, { decimals: 2, grouping: false })}
                    </td>
                    <td className="py-2 pe-3 text-gray-500" dir="ltr">{m.unit}</td>
                    <td className="py-2 pe-3">
                      {cal.passed ? <span className="text-green-600">✓ {t('measurements.passed')}</span> : <span className="text-red-600">✗ {t('measurements.error')}</span>}
                    </td>
                    <td className="py-2 pe-3">
                      {meas.passed ? <span className="text-green-600">✓ {t('measurements.passed')}</span> : <span className="text-red-600">✗ {t('measurements.error')}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Sum of ions — visual cross-check against the operator's handheld EC meter.
            We sum every enabled non-pH channel in mg/L, then bracket the equivalent EC
            using the common TDS↔EC conversion factor range for mixed hydroponic salts
            (0.55-0.75 mg/L per µS/cm = roughly 550-750 mg/L per dS/m). */}
        {(() => {
          const enabledIons = status.measurements.filter(m => m.enabled !== false && m.unit === 'mg/L');
          const sum = enabledIons.reduce((acc, m) => acc + (m.value || 0), 0);
          // EC range using TDS/EC factor 0.55-0.75: EC = sum / factor / 1000
          const ecLow = +(sum / 750).toFixed(2);
          const ecHigh = +(sum / 550).toFixed(2);
          return (
            <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('ionSum.sumTitle')}</p>
                  <p className="text-2xl font-mono font-bold text-gray-900 dark:text-white" dir="ltr">{fmt.int(sum)} <span className="text-base font-normal text-gray-500">mg/L</span></p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    {t('ionSum.sumHelp')}
                  </p>
                </div>
                <div className="text-end">
                  <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('ionSum.ecTitle')}</p>
                  <p className="text-2xl font-mono font-bold text-gray-900 dark:text-white" dir="ltr">{fmt.number(ecLow, { maxDecimals: 2 })} – {fmt.number(ecHigh, { maxDecimals: 2 })} <span className="text-base font-normal text-gray-500">dS/m</span></p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    {t('ionSum.ecHelp')}
                  </p>
                </div>
              </div>
              <div className="mt-2 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded p-2 text-xs text-blue-900 dark:text-blue-300">
                <Trans t={t} i18nKey="ionSum.howTo" values={{ low: fmt.number(ecLow, { maxDecimals: 2 }), high: fmt.number(ecHigh, { maxDecimals: 2 }) }} components={{ b: <strong /> }} />
              </div>
            </div>
          );
        })()}
      </div>

      {/* pH Calibration */}
      <PhCalibration status={status} canControl={canControl} headers={headers} onUpdate={() => fetchStatus(false)} />

      {/* Channel configuration */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{t('channels.title')}</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">{t('channels.help')}</p>
          </div>
          {canControl && (
            <button onClick={() => editingChannels ? saveChannels() : setEditingChannels(true)}
              className="text-xs px-3 py-1 bg-primary-600 text-white rounded hover:bg-primary-700">
              {editingChannels ? t('common:actions.save') : t('common:actions.edit')}
            </button>
          )}
        </div>
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded p-2 mb-3 text-xs text-amber-900 dark:text-amber-200">
          <Trans t={t} i18nKey="channels.verify" components={{ b: <strong /> }} />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {channels.map((ch, i) => (
            <div key={ch.channel} className="bg-gray-50 dark:bg-gray-900 rounded p-2 border border-gray-200 dark:border-gray-700">
              <p className="text-xs text-gray-500 dark:text-gray-400" dir="ltr">{'CH'}{ch.channel}</p>
              {editingChannels ? (
                <>
                  <input type="text" value={ch.label} onChange={e => {
                    const next = [...channels]; next[i] = { ...ch, label: e.target.value }; setChannels(next);
                  }} dir="auto" className="w-full text-sm font-medium px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white mt-1" />
                  <select value={ch.ion} onChange={e => {
                    const next = [...channels]; next[i] = { ...ch, ion: e.target.value }; setChannels(next);
                  }} className="w-full text-xs px-2 py-1 mt-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300"
                    disabled={ch.channel === 8}>
                    {NUTRIENT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.value === '' ? t('channels.notConfiguredOption') : o.value === 'pH' ? 'pH' : t(`nutrient.${o.value}`, { defaultValue: o.value })}</option>)}
                  </select>
                  <label className="flex items-center gap-1 mt-1 text-xs">
                    <input type="checkbox" checked={ch.enabled !== false} onChange={e => {
                      const next = [...channels]; next[i] = { ...ch, enabled: e.target.checked }; setChannels(next);
                    }} />
                    <span className="text-gray-600 dark:text-gray-400">{t('channels.enabled')}</span>
                  </label>
                </>
              ) : (
                <>
                  <p className="text-sm font-bold text-gray-900 dark:text-white" dir="auto">{ch.label}</p>
                  <p className="text-xs text-gray-500">{ch.ion ? <span dir="ltr">{ch.ion}</span> : t('channels.notConfigured')}</p>
                  {ch.enabled === false && <p className="text-xs text-amber-600 mt-1">{t('channels.disabled')}</p>}
                </>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Pump timings (admin-editable) */}
      <PumpTimings status={status} isAdmin={user?.role === 'admin'} headers={headers} onUpdate={() => fetchStatus(false)} />

      {/* Scheduled calibrations */}
      <ScheduledCalibrations isAdmin={user?.role === 'admin'} headers={headers} />

      {/* Cycle history */}
      <CycleHistory headers={headers} />
    </div>
  );
}

function ScheduledCalibrations({ isAdmin, headers }) {
  const { showError, showSuccess } = useToast();
  const { t } = useTranslation('amic');
  const fmt = useFormat();
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = React.useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/amic/schedule`, { headers });
      if (res.ok) setData(await res.json());
      else showError(t('errors.loadSchedule'));
    } catch (err) {
      showError(t('errors.loadScheduleWith', { error: err.message }));
    }
  }, [headers, showError, t]);

  React.useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  const startEdit = () => {
    setDraft(JSON.parse(JSON.stringify(data?.schedule || { enabled: false, times: [] })));
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/amic/schedule`, {
        method: 'PUT', headers,
        body: JSON.stringify(draft),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || t('errors.failed'));
      showSuccess(t('schedule.saved'));
      setEditing(false);
      load();
    } catch (err) { showError(err.message); }
    finally { setSaving(false); }
  };

  const updateSlot = (idx, patch) => {
    setDraft(d => ({ ...d, times: d.times.map((t, i) => i === idx ? { ...t, ...patch } : t) }));
  };
  const addSlot = () => setDraft(d => ({ ...d, times: [...(d.times||[]), { hour: 12, minute: 0, enabled: true, label: '' }] }));
  const removeSlot = (idx) => setDraft(d => ({ ...d, times: d.times.filter((_, i) => i !== idx) }));

  if (!data) return null;

  const fmtTime = (h, m) => String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0');
  const fmtLastFired = (iso) => iso ? fmt.dateTime(iso) : t('common:status.never');

  const ls = data.last_scheduled_calibration;
  const lsAge = ls ? Math.floor((Date.now() - new Date(ls.ended_at).getTime()) / 3600000) : null;
  const lsCalFails = ls ? (ls.cal_check || []).filter(c => !c.passed) : [];
  const lsHealthy = ls && ls.mv_swing != null && ls.mv_swing >= 20 && lsCalFails.length === 0;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{t('schedule.title')}</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t('schedule.help')}
          </p>
        </div>
        {isAdmin && !editing && (
          <button onClick={startEdit} className="text-xs px-3 py-1 bg-primary-600 text-white rounded hover:bg-primary-700">{t('common:actions.edit')}</button>
        )}
      </div>

      {/* Status: when's the next one, when was the last one */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <div className="bg-gray-50 dark:bg-gray-900 rounded p-3">
          <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('schedule.next')}</p>
          {data.schedule.enabled && data.next_firing_at ? (
            <p className="text-sm text-gray-900 dark:text-white mt-1">{fmt.dateTime(data.next_firing_at)}</p>
          ) : (
            <p className="text-sm text-gray-500 italic mt-1">{data.schedule.enabled ? t('schedule.noEnabledSlots') : t('schedule.disabledSchedule')}</p>
          )}
        </div>
        <div className="bg-gray-50 dark:bg-gray-900 rounded p-3">
          <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('schedule.mostRecent')}</p>
          {ls ? (
            <div className="mt-1 text-sm">
              <p className="text-gray-900 dark:text-white">
                {fmt.dateTime(ls.ended_at)}
                {lsAge != null && <span className="text-xs text-gray-500 ms-2">({lsAge < 1 ? t('schedule.ageUnderHour') : t('schedule.ageHours', { hours: lsAge })})</span>}
              </p>
              <p className="text-xs mt-1">
                {lsHealthy ? <span className="text-green-700 dark:text-green-400">✓ {t('schedule.completedCleanly')}</span>
                  : lsCalFails.length > 0 ? <span className="text-red-700 dark:text-red-400">⚠ {t('schedule.calCheckFail', { count: lsCalFails.length, labels: lsCalFails.map(c=>c.label).join(', ') })}</span>
                  : ls.mv_swing != null && ls.mv_swing < 20 ? <span className="text-amber-700 dark:text-amber-400">⚠ {t('schedule.lowSwing', { mv: ls.mv_swing })}</span>
                  : <span className="text-gray-500">{t('schedule.completed')}</span>}
                {ls.mv_swing != null && <span className="text-gray-500 ms-2">{t('schedule.swing', { mv: ls.mv_swing })}</span>}
                {ls.duration_seconds != null && <span className="text-gray-500 ms-2">· {fmt.duration(ls.duration_seconds)}</span>}
              </p>
            </div>
          ) : <p className="text-sm text-gray-500 italic mt-1">{t('schedule.noneYet')}</p>}
        </div>
      </div>

      {/* View / edit schedule slots */}
      {editing ? (
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />
            <span className="font-medium text-gray-900 dark:text-white">{t('schedule.enabledToggle')}</span>
          </label>
          {(draft.times || []).map((slot, i) => (
            <div key={i} className="flex items-center gap-2 flex-wrap bg-gray-50 dark:bg-gray-900 rounded p-3">
              <label className="flex items-center gap-1 text-xs">
                <input type="checkbox" checked={slot.enabled} onChange={e => updateSlot(i, { enabled: e.target.checked })} />
                <span className="text-gray-600 dark:text-gray-400">{t('schedule.slotOn')}</span>
              </label>
              <span className="inline-flex items-center gap-2" dir="ltr">
              <input type="number" min="0" max="23" value={slot.hour} aria-label={t('schedule.hourAria')}
                onChange={e => updateSlot(i, { hour: parseInt(e.target.value) || 0 })}
                className="w-16 px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
              <span className="text-gray-500">:</span>
              <input type="number" min="0" max="59" value={slot.minute} aria-label={t('schedule.minuteAria')}
                onChange={e => updateSlot(i, { minute: parseInt(e.target.value) || 0 })}
                className="w-16 px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
              </span>
              <input type="text" placeholder={t('schedule.slotLabel')} value={slot.label || ''} dir="auto"
                onChange={e => updateSlot(i, { label: e.target.value })}
                className="flex-1 min-w-[120px] px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300" />
              <button onClick={() => removeSlot(i)} className="text-xs px-2 py-1 text-red-700 dark:text-red-400 hover:underline">{t('schedule.remove')}</button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <button onClick={addSlot} className="text-xs px-3 py-1 border border-gray-300 dark:border-gray-600 rounded text-gray-700 dark:text-gray-300">{t('schedule.addSlot')}</button>
            <span className="text-xs text-gray-500 ms-auto">{t('schedule.timezoneNote', { tz: 'Asia/Dubai' })}</span>
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t border-gray-200 dark:border-gray-700">
            <button onClick={() => setEditing(false)} className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded text-gray-700 dark:text-gray-300">{t('common:actions.cancel')}</button>
            <button onClick={save} disabled={saving} className="px-3 py-1.5 text-sm bg-primary-600 text-white rounded hover:bg-primary-700 disabled:opacity-50">{saving ? t('common:actions.saving') : t('common:actions.save')}</button>
          </div>
        </div>
      ) : (
        <div className="space-y-1.5">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t('schedule.status')} {data.schedule.enabled ? <span className="text-green-700 dark:text-green-400 font-medium">{t('schedule.statusEnabled')}</span> : <span className="text-gray-500 italic">{t('schedule.statusDisabled')}</span>}
          </p>
          {(data.schedule.times || []).map((slot, i) => (
            <div key={i} className="flex items-center gap-3 text-sm">
              <span className={`inline-block w-2 h-2 rounded-full ${slot.enabled ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}`}></span>
              <span className="font-mono font-medium text-gray-900 dark:text-white" dir="ltr">{fmtTime(slot.hour, slot.minute)}</span>
              {slot.label && <span className="text-xs text-gray-500" dir="auto">({slot.label})</span>}
              <span className="text-xs text-gray-500 ms-auto">{t('schedule.lastFired', { time: fmtLastFired(slot.last_fired) })}</span>
            </div>
          ))}
          {(!data.schedule.times || data.schedule.times.length === 0) && (
            <p className="text-sm text-gray-500 italic">{t('schedule.noSlots')} {isAdmin ? t('schedule.clickEditToAdd') : ''}</p>
          )}
        </div>
      )}
    </div>
  );
}

function PumpTimings({ status, isAdmin, headers, onUpdate }) {
  const { showError, showSuccess } = useToast();
  const { t } = useTranslation('amic');
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState(status.timing.pump_input_seconds);
  const [output, setOutput] = useState(status.timing.pump_output_seconds);
  const [saving, setSaving] = useState(false);

  React.useEffect(() => {
    if (!editing) {
      setInput(status.timing.pump_input_seconds);
      setOutput(status.timing.pump_output_seconds);
    }
  }, [status.timing.pump_input_seconds, status.timing.pump_output_seconds, editing]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/amic/pump-times`, {
        method: 'PUT', headers,
        body: JSON.stringify({ input_seconds: parseInt(input), output_seconds: parseInt(output) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('errors.failed'));
      showSuccess(t('pump.saved', { input: data.pump_input_seconds, output: data.pump_output_seconds }));
      setEditing(false);
      onUpdate();
    } catch (err) {
      showError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{t('pump.title')}</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            <Trans t={t} i18nKey="pump.help" components={{ code: <code /> }} />
          </p>
        </div>
        {isAdmin && (
          <button onClick={() => editing ? save() : setEditing(true)} disabled={saving}
            className="text-xs px-3 py-1 bg-primary-600 text-white rounded hover:bg-primary-700 disabled:opacity-50">
            {saving ? t('common:actions.saving') : editing ? t('common:actions.save') : t('common:actions.edit')}
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-4 mt-3">
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1" dir="ltr">{'PMP_INPUT_TIME'} (s)</label>
          {editing ? (
            <input type="number" min="1" max="120" value={input} onChange={e => setInput(e.target.value)}
              className="w-24 px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
          ) : (
            <p className="text-2xl font-mono font-bold text-gray-900 dark:text-white" dir="ltr">{status.timing.pump_input_seconds}<span className="text-sm font-normal text-gray-500"> s</span></p>
          )}
        </div>
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1" dir="ltr">{'PMP_OUTPUT_TIME'} (s)</label>
          {editing ? (
            <input type="number" min="1" max="120" value={output} onChange={e => setOutput(e.target.value)}
              className="w-24 px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
          ) : (
            <p className="text-2xl font-mono font-bold text-gray-900 dark:text-white" dir="ltr">{status.timing.pump_output_seconds}<span className="text-sm font-normal text-gray-500"> s</span></p>
          )}
        </div>
        {editing && <button onClick={() => { setEditing(false); setInput(status.timing.pump_input_seconds); setOutput(status.timing.pump_output_seconds); }}
          className="text-xs px-3 py-1 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded">{t('common:actions.cancel')}</button>}
      </div>
    </div>
  );
}

function CycleHistory({ headers }) {
  const { showError } = useToast();
  const { t } = useTranslation('amic');
  const fmt = useFormat();
  // 30 s poll: throttle to one toast per minute rather than one per tick
  const notifyPollError = useThrottledError(showError);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [liveTrace, setLiveTrace] = useState(null);

  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/amic/cycle-history?limit=20&with_trace=1`, { headers });
        if (res.ok && !cancelled) setHistory(await res.json());
        const lt = await fetch(`${API_BASE}/amic/live-trace`, { headers });
        if (lt.ok && !cancelled) setLiveTrace(await lt.json());
        if ((!res.ok && res.status >= 500) || (!lt.ok && lt.status >= 500)) {
          notifyPollError(t('errors.loadHistory'), 'amic-cycle-history');
        }
      } catch (err) {
        if (!cancelled) notifyPollError(t('errors.loadHistoryWith', { error: err.message }), 'amic-cycle-history');
      }
      finally { if (!cancelled) setLoading(false); }
    };
    load();
    const t = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(t); };
  }, [headers, notifyPollError, t]);

  const fmtDuration = (sec) => fmt.duration(sec);
  const stateColor = (s) => ({
    measuring: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
    calibrating: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
    draining: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300',
    empty_system: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
    conditioning: 'bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300',
  }[s] || 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300');

  // Find last calibration for the prominent "When was last cal?" callout
  const lastCal = history.find(r => r.cycle_state === 'calibrating');
  const lastCalAge = lastCal ? Math.floor((Date.now() - new Date(lastCal.ended_at).getTime()) / 86400000) : null;

  // Diagnose probe-contact for a cycle: spread = max - min over the trace.
  // Calibration uses multi-ion standards (P1 Low, P2 High), NOT pH buffers — so the
  // pH probe sees whatever pH each standard happens to be at. P1 and P2 are usually
  // 1–2 pH units apart, giving 30–120 mV swing. The pH-buffer 170 mV swing only
  // happens during manual pH calibration (separate procedure, p.17 of the manual).
  const contactDiagnosis = (r) => {
    if (!r.live_mv_samples || r.live_mv_samples < 3) return { label: t('history.dx.noTrace'), tone: 'gray' };
    const spread = (r.live_mv_max ?? 0) - (r.live_mv_min ?? 0);
    const mv = fmt.int(spread);
    if (r.cycle_state === 'calibrating') {
      if (spread < 5) return { label: t('history.dx.flatNoContact'), tone: 'red', spread };
      if (spread < 20) return { label: t('history.dx.lowSwing', { mv }), tone: 'amber', spread };
      return { label: t('history.dx.healthy', { mv }), tone: 'green', spread };
    }
    // Measure / Drain / Empty / Conditioning — less stringent
    if (spread < 3 && (r.cycle_state === 'measuring' || r.cycle_state === 'conditioning')) return { label: t('history.dx.flatSuspect'), tone: 'amber', spread };
    return { label: t('history.dx.variation', { mv }), tone: 'gray', spread };
  };

  // Build a tiny SVG sparkline from a trace
  const Sparkline = ({ trace, width = 110, height = 26 }) => {
    if (!trace || trace.length < 2) return <span className="text-xs text-gray-400">—</span>;
    const ys = trace.map(s => s.mv);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const range = maxY - minY || 1;
    const pts = trace.map((s, i) => {
      const x = (i / (trace.length - 1)) * width;
      const y = height - ((s.mv - minY) / range) * height;
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    return (
      <svg width={width} height={height} className="inline-block align-middle" aria-hidden="true">
        <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.2" className="text-blue-600 dark:text-blue-400" />
      </svg>
    );
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
      <div className="flex items-baseline justify-between flex-wrap gap-2 mb-3">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{t('history.title')}</h3>
        {lastCal ? (
          <span className={`text-xs px-2 py-0.5 rounded ${lastCalAge > 1 ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' : 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'}`}>
            {t('history.lastCal', { age: lastCalAge === 0 ? t('history.today') : t('history.daysAgo', { count: lastCalAge }), time: fmt.dateTime(lastCal.ended_at) })}
          </span>
        ) : (
          <span className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">⚠ {t('history.noCal')}</span>
        )}
      </div>

      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
        <Trans t={t} i18nKey="history.help" components={{ b: <strong /> }} />
      </p>

      {/* Live diagnostic during an active cycle */}
      {liveTrace && liveTrace.sample_count >= 2 && (
        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded p-3 mb-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <p className="text-xs font-semibold text-blue-900 dark:text-blue-300 uppercase">{t('history.liveTitle')}</p>
              <p className="text-xs text-blue-700 dark:text-blue-400">
                {t('history.liveSummary', {
                  count: liveTrace.sample_count,
                  time: liveTrace.cycle_started_at ? fmt.clock(liveTrace.cycle_started_at) : '—',
                  spread: fmt.number(Math.max(...liveTrace.samples.map(s=>s.mv)) - Math.min(...liveTrace.samples.map(s=>s.mv)), { decimals: 1 }),
                })}
              </p>
            </div>
            <span dir="ltr"><Sparkline trace={liveTrace.samples} width={200} height={40} /></span>
          </div>
        </div>
      )}

      {loading ? <p className="text-sm text-gray-500">{t('common:status.loading')}</p> :
       history.length === 0 ? <p className="text-sm text-gray-500">{t('history.empty')}</p> : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-xs uppercase text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
              <tr>
                <th className="px-2 py-1 text-start">{t('history.colStarted')}</th>
                <th className="px-2 py-1 text-start">{t('history.colCycle')}</th>
                <th className="px-2 py-1 text-start">{t('history.colDuration')}</th>
                <th className="px-2 py-1 text-start">{t('history.colSource')}</th>
                <th className="px-2 py-1 text-start">{t('history.colCalCheck')}</th>
                <th className="px-2 py-1 text-start">{t('history.colMeasCheck')}</th>
                <th className="px-2 py-1 text-start">{t('history.colContact')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {history.slice(0, 20).map(r => {
                const calFails = (r.cal_check || []).filter(c => !c.passed);
                const measFails = (r.measurement_check || []).filter(c => !c.passed);
                const dx = contactDiagnosis(r);
                const toneCls = {
                  red: 'text-red-700 dark:text-red-400',
                  amber: 'text-amber-700 dark:text-amber-400',
                  green: 'text-green-700 dark:text-green-400',
                  gray: 'text-gray-500 dark:text-gray-400',
                }[dx.tone];
                return (
                  <tr key={r.id}>
                    <td className="px-2 py-1.5 font-mono text-xs whitespace-nowrap">{fmt.dateTime(r.started_at)}</td>
                    <td className="px-2 py-1.5"><span className={`text-xs px-2 py-0.5 rounded ${stateColor(r.cycle_state)}`}>{t(`state.${r.cycle_state}`, { defaultValue: r.cycle_state })}</span></td>
                    <td className="px-2 py-1.5 font-mono text-xs whitespace-nowrap">{fmtDuration(r.duration_seconds)}</td>
                    <td className="px-2 py-1.5 text-xs text-gray-500">{t(`source.${r.source}`, { defaultValue: r.source })}</td>
                    <td className="px-2 py-1.5 text-xs">{calFails.length === 0 ? <span className="text-green-600">{t('history.allOk')}</span> : <span className="text-red-700 dark:text-red-400">{t('history.fails', { count: calFails.length, labels: calFails.map(c => c.label).join(', ') })}</span>}</td>
                    <td className="px-2 py-1.5 text-xs">{measFails.length === 0 ? <span className="text-green-600">{t('history.allOk')}</span> : <span className="text-red-700 dark:text-red-400">{t('history.fails', { count: measFails.length, labels: measFails.map(c => c.label).join(', ') })}</span>}</td>
                    <td className="px-2 py-1.5 text-xs">
                      <span dir="ltr"><Sparkline trace={r.live_mv_trace} /></span>
                      <span className={`ms-2 ${toneCls}`}>{dx.label}</span>
                      {r.live_mv_samples > 0 && (
                        <span className="ms-1 text-gray-400" dir="ltr">{t('history.range', { min: fmt.int(r.live_mv_min), max: fmt.int(r.live_mv_max), n: r.live_mv_samples })}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
       )}
    </div>
  );
}

function PhCalibration({ status, canControl, headers, onUpdate }) {
  const { showError, showSuccess } = useToast();
  const { t } = useTranslation('amic');
  const fmt = useFormat();
  const ph2 = (v) => fmt.number(v, { decimals: 2, grouping: false });
  const [capturing, setCapturing] = useState(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [manualLow, setManualLow] = useState('');
  const [manualHigh, setManualHigh] = useState('');
  const [savingManual, setSavingManual] = useState(false);

  // Buffer pH values (defaults to AMIC standard 4.0/7.0; can be overridden e.g. 7.01/10.01)
  const phOffset = status?.ph_offset || { offset: 0, buffer_low: 4.0, buffer_high: 7.0, configured: false };
  const [bufferLow, setBufferLow] = useState(phOffset.buffer_low);
  const [bufferHigh, setBufferHigh] = useState(phOffset.buffer_high);
  const [savingBuffers, setSavingBuffers] = useState(false);

  React.useEffect(() => {
    setBufferLow(phOffset.buffer_low);
    setBufferHigh(phOffset.buffer_high);
  }, [phOffset.buffer_low, phOffset.buffer_high]);

  const liveMv = status?.ph_live_mv;
  const liveMvDisplay = liveMv !== null && liveMv !== undefined ? ph2(liveMv / 100) : '—';
  const cal = status?.ph_calibration;
  const phCalReady = cal && cal.mv_at_ph4 > 0 && cal.mv_at_ph7 !== cal.mv_at_ph4;

  const saveBuffers = async () => {
    setSavingBuffers(true);
    try {
      const res = await fetch('/api/amic/ph-buffers', {
        method: 'POST', headers,
        body: JSON.stringify({ buffer_low: parseFloat(bufferLow), buffer_high: parseFloat(bufferHigh) })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('errors.failed'));
      showSuccess(t('ph.buffersSaved', { low: data.buffer_low, high: data.buffer_high, offset: fmt.number(data.offset, { decimals: 2, signed: true, grouping: false }) }));
      onUpdate();
    } catch (err) {
      showError(err.message);
    } finally {
      setSavingBuffers(false);
    }
  };

  const capture = async (point) => {
    const bl = parseFloat(bufferLow);
    const bh = parseFloat(bufferHigh);
    const labelPh = point === 'low' ? ph2(bl) : ph2(bh);
    const label = point === 'low' ? t('ph.pointLow', { ph: labelPh }) : t('ph.pointHigh', { ph: labelPh });
    if (!isFinite(bl) || !isFinite(bh) || bh <= bl) {
      showError(t('ph.invalidBuffers'));
      return;
    }
    if (!confirm(t('ph.confirmCapture', { mv: liveMvDisplay, label, low: ph2(bl), high: ph2(bh) }))) return;

    setCapturing(point);
    try {
      const res = await fetch(`/api/amic/capture-ph/${point}`, {
        method: 'POST', headers,
        body: JSON.stringify({ buffer_low: bl, buffer_high: bh }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('errors.failed'));
      const offsetMsg = data.ph_offset?.configured
        ? t('ph.capturedOffset', { offset: fmt.number(data.ph_offset.offset, { decimals: 2, signed: true, grouping: false }) })
        : '';
      showSuccess(t('ph.captured', { label, mv: ph2(data.captured_mv), offset: offsetMsg }));
      onUpdate();
    } catch (err) {
      showError(err.message);
    } finally {
      setCapturing(null);
    }
  };

  const saveManual = async (e) => {
    e.preventDefault();
    setSavingManual(true);
    try {
      const res = await fetch('/api/amic/calibrate-ph', {
        method: 'POST', headers,
        body: JSON.stringify({
          mv_at_ph4: parseInt(manualLow),
          mv_at_ph7: parseInt(manualHigh)
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('errors.failed'));
      showSuccess(t('ph.manualSaved'));
      setManualLow(''); setManualHigh('');
      onUpdate();
    } catch (err) {
      showError(err.message);
    } finally {
      setSavingManual(false);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{t('ph.title')}</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('ph.help')}</p>
        </div>
        <span className={`px-2 py-0.5 rounded text-xs font-medium ${phCalReady ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'}`}>
          {phCalReady ? <>✓ {t('ph.calibrated')}</> : t('ph.notCalibrated')}
        </span>
      </div>

      {/* Live mV reading */}
      <div className="bg-gray-50 dark:bg-gray-900 rounded p-3 mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('ph.liveReading')}</p>
          <p className="text-3xl font-mono font-bold text-gray-900 dark:text-white" dir="ltr">{liveMvDisplay} <span className="text-base font-normal text-gray-500">mV</span></p>
        </div>
        <p className="text-xs text-gray-400 italic max-w-xs text-end">{t('ph.liveHelp')}</p>
      </div>

      {/* Buffer pH configuration */}
      <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded p-3 mb-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <p className="text-xs font-semibold text-blue-900 dark:text-blue-300 uppercase">{t('ph.buffersTitle')}</p>
            <p className="text-xs text-blue-700 dark:text-blue-400 mt-0.5">
              {t('ph.buffersHelp')}
            </p>
          </div>
          {phOffset.configured && (
            <div className="text-end text-xs">
              <p className="text-gray-500 dark:text-gray-400">{t('ph.displayOffset')}</p>
              <p className="text-lg font-bold text-blue-700 dark:text-blue-300" dir="ltr">
                {phOffset.offset >= 0 ? '+' : ''}{ph2(phOffset.offset)} pH
              </p>
            </div>
          )}
        </div>

        {/* Quick-select presets */}
        <div className="flex flex-wrap items-center gap-2 mt-3">
          <span className="text-xs text-gray-600 dark:text-gray-400">{t('ph.preset')}</span>
          {[
            { label: t('ph.presetStandard'), low: 4.0, high: 7.0 },
            { label: t('ph.presetAlkaline'), low: 7.0, high: 10.0 },
            { label: t('ph.presetNist'), low: 7.01, high: 10.01 },
          ].map(p => {
            const active = parseFloat(bufferLow) === p.low && parseFloat(bufferHigh) === p.high;
            return (
              <button key={p.label} type="button"
                onClick={() => { setBufferLow(p.low); setBufferHigh(p.high); }}
                className={`px-2.5 py-1 text-xs rounded border transition ${active
                  ? 'bg-blue-600 border-blue-600 text-white'
                  : 'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:border-blue-400'}`}>
                {p.label}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-end gap-3 mt-3">
          <div>
            <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('ph.lowBuffer')}</label>
            <input type="number" step="0.01" min="0" max="14" value={bufferLow} dir="ltr"
              onChange={e => setBufferLow(e.target.value)}
              className="w-24 px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
          </div>
          <div>
            <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('ph.highBuffer')}</label>
            <input type="number" step="0.01" min="0" max="14" value={bufferHigh} dir="ltr"
              onChange={e => setBufferHigh(e.target.value)}
              className="w-24 px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
          </div>
          {canControl && (
            <button onClick={saveBuffers} disabled={savingBuffers}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
              {savingBuffers ? t('ph.saving') : t('ph.saveBuffers')}
            </button>
          )}
        </div>
        {phOffset.span_warning && (
          <p className="text-xs text-amber-700 dark:text-amber-400 mt-2">
            ⚠ {t('ph.spanWarning')}
          </p>
        )}
      </div>

      {/* Calibration steps */}
      <div className="space-y-3 mb-4">
        <Step number={1} title={t('ph.step1Title')}>
          {t('ph.step1Body')}
        </Step>

        <Step number={2} title={t('ph.step2Title', { ph: ph2(parseFloat(bufferLow)) })} highlight>
          <p><Trans t={t} i18nKey="ph.step2Body" values={{ ph: ph2(parseFloat(bufferLow)) }} components={{ b: <strong /> }} /></p>
          <div className="flex items-center gap-3 mt-2 flex-wrap">
            {canControl && (
              <button onClick={() => capture('low')} disabled={capturing !== null}
                className="px-3 py-1.5 text-sm bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50">
                {capturing === 'low' ? t('ph.capturing') : t('ph.captureAs', { ph: ph2(parseFloat(bufferLow)), mv: liveMvDisplay })}
              </button>
            )}
            {cal && (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {t('ph.stored')} <strong className="text-gray-700 dark:text-gray-300" dir="ltr">{ph2(cal.mv_at_ph4 / 100)} mV</strong>
              </span>
            )}
          </div>
        </Step>

        <Step number={3} title={t('ph.step3Title')}>
          {t('ph.step3Body')}
        </Step>

        <Step number={4} title={t('ph.step4Title', { ph: ph2(parseFloat(bufferHigh)) })} highlight>
          <p><Trans t={t} i18nKey="ph.step4Body" values={{ ph: ph2(parseFloat(bufferHigh)) }} components={{ b: <strong /> }} /></p>
          <div className="flex items-center gap-3 mt-2 flex-wrap">
            {canControl && (
              <button onClick={() => capture('high')} disabled={capturing !== null}
                className="px-3 py-1.5 text-sm bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50">
                {capturing === 'high' ? t('ph.capturing') : t('ph.captureAs', { ph: ph2(parseFloat(bufferHigh)), mv: liveMvDisplay })}
              </button>
            )}
            {cal && (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {t('ph.stored')} <strong className="text-gray-700 dark:text-gray-300" dir="ltr">{ph2(cal.mv_at_ph7 / 100)} mV</strong>
              </span>
            )}
          </div>
        </Step>

        <Step number={5} title={t('ph.step5Title')}>
          {phOffset.configured && phOffset.offset !== 0
            ? t('ph.step5BodyOffset', { offset: fmt.number(phOffset.offset, { decimals: 2, signed: true, grouping: false }) })
            : t('ph.step5Body')}
        </Step>
      </div>

      {/* Advanced manual entry */}
      <div className="border-t border-gray-200 dark:border-gray-700 pt-3">
        <button onClick={() => setAdvancedOpen(!advancedOpen)} className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300">
          <span aria-hidden="true" className={advancedOpen ? '' : 'inline-block rtl:-scale-x-100'}>{advancedOpen ? '▾' : '▸'}</span> {t('ph.advanced')}
        </button>
        {advancedOpen && canControl && (
          <form onSubmit={saveManual} className="mt-3 flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('ph.rawLow')}</label>
              <input type="number" value={manualLow} onChange={e => setManualLow(e.target.value)} dir="ltr"
                placeholder="17060"
                className="w-32 px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
              <p className="text-[10px] text-gray-400 mt-0.5">{t('ph.rawLowHint')}</p>
            </div>
            <div>
              <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('ph.rawHigh')}</label>
              <input type="number" value={manualHigh} onChange={e => setManualHigh(e.target.value)} dir="ltr"
                placeholder="80"
                className="w-32 px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
              <p className="text-[10px] text-gray-400 mt-0.5">{t('ph.rawHighHint')}</p>
            </div>
            <button type="submit" disabled={savingManual || !manualLow || !manualHigh}
              className="px-4 py-2 text-sm bg-gray-600 text-white rounded hover:bg-gray-700 disabled:opacity-50">
              {savingManual ? t('ph.saving') : t('ph.writeRaw')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function Step({ number, title, highlight, children }) {
  return (
    <div className={`flex gap-3 p-2 rounded ${highlight ? 'bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800' : ''}`}>
      <div className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${highlight ? 'bg-amber-600 text-white' : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300'}`}>
        {number}
      </div>
      <div className="flex-1 min-w-0 text-sm">
        <p className="font-semibold text-gray-900 dark:text-white">{title}</p>
        <div className="text-gray-600 dark:text-gray-400 text-xs mt-0.5">{children}</div>
      </div>
    </div>
  );
}

function ActionBtn({ label, subtitle, color, disabled, loading, onClick }) {
  const { t } = useTranslation('amic');
  const colors = {
    blue: 'bg-blue-600 hover:bg-blue-700',
    amber: 'bg-amber-600 hover:bg-amber-700',
    cyan: 'bg-cyan-600 hover:bg-cyan-700',
    purple: 'bg-purple-600 hover:bg-purple-700',
    pink: 'bg-pink-600 hover:bg-pink-700',
  };
  return (
    <button onClick={onClick} disabled={disabled || loading}
      className={`px-3 py-2 text-white rounded text-sm font-medium ${colors[color]} disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-start`}>
      <div>{loading ? t('ops.sending') : label}</div>
      <div className="text-xs opacity-80 font-normal">{subtitle}</div>
    </button>
  );
}
