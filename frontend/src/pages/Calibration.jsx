import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

const API_BASE = '/api';

// Preferred default: an EC sensor calibrated against the EC lab nutrient.
// The equipment itself is derived from the fetched list (first device whose
// register mappings include this metric, else the first non-relay device);
// the user's last choice is remembered in localStorage.
const PREFERRED_METRIC = 'Conductivity (EC)';
const DEFAULT_NUTRIENT = 'EC';
const STORAGE_KEY = 'calibration:lastSelection';

const parseMappings = (eq) => {
  if (!eq || !eq.register_mappings) return [];
  try {
    const m = typeof eq.register_mappings === 'string' ? JSON.parse(eq.register_mappings) : eq.register_mappings;
    return Array.isArray(m) ? m : [];
  } catch {
    return [];
  }
};

const readSavedSelection = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

export default function Calibration() {
  const { token, user } = useAuth();
  const { showError, showSuccess } = useToast();

  const [equipmentList, setEquipmentList] = useState([]);
  const [equipmentId, setEquipmentId] = useState(() => readSavedSelection()?.equipmentId ?? '');
  const [metricName, setMetricName] = useState(() => readSavedSelection()?.metricName ?? '');
  const [labNutrient, setLabNutrient] = useState(() => readSavedSelection()?.labNutrient ?? DEFAULT_NUTRIENT);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [recomputing, setRecomputing] = useState(false);

  // Quick add EC form
  const [newValue, setNewValue] = useState('');
  const [newUnit, setNewUnit] = useState('mS/cm');
  const [newZone, setNewZone] = useState('');
  const [useNow, setUseNow] = useState(true);
  const [newTime, setNewTime] = useState('');
  const [zones, setZones] = useState([]);
  const [adding, setAdding] = useState(false);

  // Per-metric linear calibration (scale & offset) — the correction actually
  // applied to readings at poll time. Keyed by the register mapping's `name`.
  const [linearScale, setLinearScale] = useState('1');
  const [linearOffset, setLinearOffset] = useState('0');
  const [savedLinear, setSavedLinear] = useState({ scale: 1, offset: 0 });
  const [linearMetrics, setLinearMetrics] = useState([]);
  const [savingLinear, setSavingLinear] = useState(false);

  const formatLocalDatetime = (date) => {
    const d = new Date(date);
    d.setSeconds(0, 0);
    const tz = d.getTimezoneOffset() * 60000;
    return new Date(d - tz).toISOString().slice(0, 16);
  };

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const canEdit = user?.role === 'admin' || user?.role === 'operator';

  useEffect(() => {
    fetch(`${API_BASE}/equipment`, { headers })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(list => {
        const arr = Array.isArray(list) ? list : [];
        setEquipmentList(arr);
        if (arr.length === 0) setLoading(false);
      })
      .catch(err => { setLoading(false); showError(`Could not load equipment list: ${err.message}`); });
    fetch(`${API_BASE}/zones`, { headers })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(setZones)
      .catch(err => showError(`Could not load zones: ${err.message}`));
  }, []);

  // Derive the default equipment once the list arrives (only when nothing valid
  // is selected): prefer the first device exposing the EC metric, else the
  // first non-relay device.
  useEffect(() => {
    if (equipmentList.length === 0) return;
    const candidates = equipmentList.filter(e => e.type !== 'relay');
    const stillValid = equipmentId !== '' && candidates.some(e => e.id === parseInt(equipmentId));
    if (stillValid) return;
    const withEc = candidates.find(e => parseMappings(e).some(m => m.name === PREFERRED_METRIC));
    const chosen = withEc || candidates[0] || equipmentList[0];
    if (chosen) {
      setEquipmentId(chosen.id);
      if (withEc) setMetricName(PREFERRED_METRIC);
    } else {
      setLoading(false);
    }
  }, [equipmentList]);

  // Remember the last choice (storage may be unavailable in private mode)
  useEffect(() => {
    if (equipmentId === '' || !metricName) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ equipmentId, metricName, labNutrient }));
    } catch { /* storage unavailable */ }
  }, [equipmentId, metricName, labNutrient]);

  // Set default metric when equipment changes
  useEffect(() => {
    const eq = equipmentList.find(e => e.id === parseInt(equipmentId));
    if (!eq) return;
    const mappings = parseMappings(eq);
    if (mappings.length === 0 && eq.register_mappings) {
      showError(`Could not read register mappings for ${eq.name || 'the selected equipment'}`);
      return;
    }
    // Try to keep current metric if it exists, otherwise prefer EC, then first sensor
    if (!mappings.some(m => m.name === metricName)) {
      const preferred = mappings.find(m => m.name === PREFERRED_METRIC);
      const firstSensor = preferred || mappings.find(m => m.type !== 'coil');
      if (firstSensor) setMetricName(firstSensor.name);
    }
  }, [equipmentId, equipmentList]);

  const fetchCalibration = async () => {
    if (!equipmentId || !metricName) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ lab_nutrient: labNutrient });
      const res = await fetch(`${API_BASE}/calibration/${equipmentId}/${encodeURIComponent(metricName)}?${params}`, { headers });
      if (res.ok) setData(await res.json());
    } catch (err) {
      showError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchCalibration(); }, [equipmentId, metricName, labNutrient]);

  // Load every metric's scale/offset for the selected device, then sync the
  // editor to the currently-selected metric.
  const fetchLinear = async () => {
    if (!equipmentId) return;
    try {
      const res = await fetch(`${API_BASE}/calibration/${equipmentId}/linear`, { headers });
      if (res.ok) {
        const json = await res.json();
        setLinearMetrics(json.metrics || []);
      }
    } catch { /* non-fatal */ }
  };

  useEffect(() => { fetchLinear(); }, [equipmentId]);

  // Whenever the selected metric (or the loaded list) changes, reflect its
  // saved scale/offset into the editor fields.
  useEffect(() => {
    const m = linearMetrics.find(x => x.name === metricName);
    const scale = m ? m.scale : 1;
    const offset = m ? m.offset : 0;
    setSavedLinear({ scale, offset });
    setLinearScale(String(scale));
    setLinearOffset(String(offset));
  }, [metricName, linearMetrics]);

  const saveLinear = async (e) => {
    e.preventDefault();
    const scale = parseFloat(linearScale);
    const offset = parseFloat(linearOffset);
    if (isNaN(scale) || isNaN(offset)) { showError('Scale and offset must be numbers'); return; }
    setSavingLinear(true);
    try {
      const res = await fetch(`${API_BASE}/calibration/${equipmentId}/${encodeURIComponent(metricName)}/linear`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ scale, offset })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Save failed');
      }
      const json = await res.json();
      setSavedLinear({ scale: json.scale, offset: json.offset });
      // Keep the per-device list in sync so other metrics keep their values.
      setLinearMetrics(prev => prev.map(m => m.name === metricName ? { ...m, scale: json.scale, offset: json.offset } : m));
      showSuccess(`Saved calibration for ${metricName}`);
    } catch (err) {
      showError(err.message);
    } finally {
      setSavingLinear(false);
    }
  };

  const recompute = async () => {
    setRecomputing(true);
    try {
      const res = await fetch(`${API_BASE}/calibration/${equipmentId}/${encodeURIComponent(metricName)}/recompute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ lab_nutrient: labNutrient })
      });
      if (!res.ok) throw new Error('Recompute failed');
      showSuccess('Calibration recomputed');
      fetchCalibration();
    } catch (err) {
      showError(err.message);
    } finally {
      setRecomputing(false);
    }
  };

  const deletePair = async (labId) => {
    if (!confirm('Delete this lab reading? Calibration will recompute automatically.')) return;
    try {
      const res = await fetch(`${API_BASE}/lab-readings/${labId}`, { method: 'DELETE', headers });
      if (!res.ok) throw new Error('Delete failed');
      showSuccess('Lab reading deleted');
      setTimeout(fetchCalibration, 300);
    } catch (err) {
      showError(err.message);
    }
  };

  const editPair = async (pair) => {
    const newVal = prompt(`Edit lab value for ${new Date(pair.lab_time).toLocaleString()}\n\nCurrent: ${pair.lab_value}`, pair.lab_value);
    if (newVal === null) return;
    const parsed = parseFloat(newVal);
    if (isNaN(parsed)) { showError('Invalid number'); return; }
    try {
      const res = await fetch(`${API_BASE}/lab-readings/${pair.lab_id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ value: parsed })
      });
      if (!res.ok) throw new Error('Update failed');
      showSuccess(`Updated to ${parsed}`);
      setTimeout(fetchCalibration, 300);
    } catch (err) {
      showError(err.message);
    }
  };

  const addReading = async (e) => {
    e.preventDefault();
    if (!newValue) return;
    setAdding(true);
    try {
      // Convert mS/cm to µS/cm if needed (assume sensor is µS/cm)
      let value = parseFloat(newValue);
      const targetUnit = data?.sensorHistory?.[0] ? 'µS/cm' : newUnit;
      if (newUnit === 'mS/cm' && targetUnit === 'µS/cm') {
        value = value * 1000;
      }
      // Always use current time when "useNow" is checked, otherwise use the picker value
      // (browser interprets datetime-local as local time, .toISOString() converts to UTC)
      const sampleIso = useNow
        ? new Date().toISOString()
        : new Date(newTime).toISOString();
      const res = await fetch(`${API_BASE}/lab-readings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          entries: [{
            sample_date: sampleIso,
            nutrient: labNutrient,
            value,
            unit: targetUnit,
            zone_id: newZone || null,
            notes: 'Calibration entry'
          }]
        })
      });
      if (!res.ok) throw new Error('Failed to add reading');
      showSuccess(`Added ${newValue} ${newUnit} - calibration recomputed`);
      setNewValue('');
      setUseNow(true);
      setNewTime('');
      setTimeout(fetchCalibration, 500); // give backend time to recompute
    } catch (err) {
      showError(err.message);
    } finally {
      setAdding(false);
    }
  };

  // Get available metrics for the selected equipment
  const availableMetrics = (() => {
    const eq = equipmentList.find(e => e.id === parseInt(equipmentId));
    if (!eq) return [];
    try {
      const mappings = typeof eq.register_mappings === 'string'
        ? JSON.parse(eq.register_mappings)
        : (eq.register_mappings || []);
      return mappings.filter(m => m.type !== 'coil').map(m => m.name);
    } catch {
      return [];
    }
  })();

  // Build chart data
  const chartData = (() => {
    if (!data) return null;
    const sensorPoints = (data.sensorHistory || []).map(r => ({
      time: new Date(r.timestamp).getTime(),
      raw: r.value,
      calibrated: data.calibration ? data.calibration.slope * r.value + data.calibration.intercept : r.value
    }));
    const labPoints = (data.pairs || []).filter(p => p.matched).map(p => ({
      time: new Date(p.lab_time.includes('T') ? p.lab_time : p.lab_time + 'T12:00:00Z').getTime(),
      lab: p.lab_value,
      sensor: p.sensor_value
    }));
    return { sensorPoints, labPoints };
  })();

  const cal = data?.calibration;

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Sensor Calibration</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Map raw sensor readings to real-world values using manual lab measurements (linear regression).
        </p>
      </div>

      {/* Selection */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4 mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Equipment</label>
            <select value={equipmentId} onChange={e => setEquipmentId(parseInt(e.target.value))}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 dark:text-white">
              {equipmentList.filter(e => e.type !== 'relay').map(e => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Sensor Metric</label>
            <select value={metricName} onChange={e => setMetricName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 dark:text-white">
              {availableMetrics.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Lab Nutrient</label>
            <select value={labNutrient} onChange={e => setLabNutrient(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 dark:text-white">
              <option value="EC">EC</option>
              <option value="pH">pH</option>
              <option value="nitrate_NO3">Nitrate (NO3)</option>
              <option value="phosphate_PO4">Phosphate (PO4)</option>
              <option value="potassium_K">Potassium (K)</option>
            </select>
          </div>
        </div>
      </div>

      {/* Per-metric linear calibration (scale & offset) — applied to readings */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4 mb-4">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">
          Linear Calibration — <span className="text-primary-600 dark:text-primary-400">{metricName || '(no metric)'}</span>
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          Applied to every reading of this metric: <code className="px-1 rounded bg-gray-100 dark:bg-gray-700">real = raw × scale + offset</code>.
          Each metric on this device has its own scale/offset.
        </p>
        {canEdit ? (
          <form onSubmit={saveLinear} className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Scale (multiplier)</label>
              <input type="number" step="any" value={linearScale} onChange={e => setLinearScale(e.target.value)}
                className="w-28 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 dark:text-white" />
            </div>
            <div>
              <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Offset (added)</label>
              <input type="number" step="any" value={linearOffset} onChange={e => setLinearOffset(e.target.value)}
                className="w-28 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 dark:text-white" />
            </div>
            <button type="submit" disabled={savingLinear || !metricName}
              className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50">
              {savingLinear ? 'Saving...' : 'Save Calibration'}
            </button>
            <span className="text-xs text-gray-400">
              Saved: scale {savedLinear.scale}, offset {savedLinear.offset}
            </span>
          </form>
        ) : (
          <p className="text-sm text-gray-700 dark:text-gray-300">
            Scale <strong>{savedLinear.scale}</strong>, offset <strong>{savedLinear.offset}</strong>
          </p>
        )}

        {linearMetrics.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-gray-500 dark:text-gray-400 uppercase border-b border-gray-200 dark:border-gray-700">
                  <th className="pb-2 pr-3">Metric</th>
                  <th className="pb-2 pr-3 text-right">Scale</th>
                  <th className="pb-2 pr-3 text-right">Offset</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {linearMetrics.map(m => (
                  <tr key={m.name}
                    onClick={() => setMetricName(m.name)}
                    className={`cursor-pointer text-gray-700 dark:text-gray-300 ${m.name === metricName ? 'bg-primary-50 dark:bg-primary-900/20' : ''}`}>
                    <td className="py-2 pr-3">{m.name}{m.unit ? ` (${m.unit})` : ''}</td>
                    <td className="py-2 pr-3 text-right">{m.scale}</td>
                    <td className="py-2 pr-3 text-right">{m.offset}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Stats */}
      {cal && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
            <p className="text-xs text-gray-500 dark:text-gray-400">Slope</p>
            <p className="text-xl font-bold text-gray-900 dark:text-white">{cal.slope.toFixed(4)}</p>
            <p className="text-xs text-gray-400">multiplier</p>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
            <p className="text-xs text-gray-500 dark:text-gray-400">Intercept</p>
            <p className="text-xl font-bold text-gray-900 dark:text-white">{cal.intercept.toFixed(2)}</p>
            <p className="text-xs text-gray-400">offset</p>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
            <p className="text-xs text-gray-500 dark:text-gray-400">R² (fit quality)</p>
            <p className="text-xl font-bold text-gray-900 dark:text-white">{cal.r_squared !== null ? cal.r_squared.toFixed(3) : '—'}</p>
            <p className="text-xs text-gray-400">{cal.r_squared !== null && cal.r_squared > 0.8 ? 'good fit' : cal.r_squared !== null && cal.r_squared > 0.5 ? 'fair fit' : 'needs more data'}</p>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
            <p className="text-xs text-gray-500 dark:text-gray-400">Data Points</p>
            <p className="text-xl font-bold text-gray-900 dark:text-white">{cal.n_pairs}</p>
            <p className="text-xs text-gray-400">matched pairs</p>
          </div>
        </div>
      )}

      {/* Latest estimate */}
      {data?.latestEstimate && (
        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 mb-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <p className="text-xs text-blue-700 dark:text-blue-400 uppercase font-semibold">Latest Reading</p>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                Raw sensor: <strong className="text-gray-900 dark:text-white">{data.latestEstimate.raw?.toFixed(1)}</strong> →
                Estimated real: <strong className="text-blue-700 dark:text-blue-300 text-xl ml-1">{data.latestEstimate.calibrated?.toFixed(1)}</strong>
                <span className="ml-1 text-xs">µS/cm ({(data.latestEstimate.calibrated / 1000).toFixed(2)} mS/cm)</span>
              </p>
            </div>
            <button onClick={recompute} disabled={recomputing}
              className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50">
              {recomputing ? 'Recomputing...' : 'Recompute Calibration'}
            </button>
          </div>
        </div>
      )}

      {/* Quick add EC */}
      {canEdit && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4 mb-4">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Add Manual Measurement</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
            Measure with your conductivity pen and enter the value below. Calibration is recomputed automatically.
          </p>
          <form onSubmit={addReading} className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Value</label>
              <input type="number" step="0.01" value={newValue} onChange={e => setNewValue(e.target.value)}
                placeholder="3.7"
                className="w-24 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 dark:text-white" />
            </div>
            <div>
              <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Unit</label>
              <select value={newUnit} onChange={e => setNewUnit(e.target.value)}
                className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 dark:text-white">
                <option value="mS/cm">mS/cm</option>
                <option value="µS/cm">µS/cm</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">When measured</label>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
                  <input type="checkbox" checked={useNow} onChange={e => {
                    setUseNow(e.target.checked);
                    if (!e.target.checked && !newTime) {
                      setNewTime(formatLocalDatetime(new Date()));
                    }
                  }} className="w-4 h-4" />
                  <span className="text-gray-700 dark:text-gray-300">Now</span>
                </label>
                {!useNow && (
                  <input type="datetime-local" value={newTime} onChange={e => setNewTime(e.target.value)}
                    className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 dark:text-white" />
                )}
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Zone (optional)</label>
              <select value={newZone} onChange={e => setNewZone(e.target.value)}
                className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 dark:text-white">
                <option value="">— None —</option>
                {zones.map(z => <option key={z.id} value={z.id}>{z.name}</option>)}
              </select>
            </div>
            <button type="submit" disabled={adding || !newValue}
              className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50">
              {adding ? 'Adding...' : 'Add Measurement'}
            </button>
          </form>
        </div>
      )}

      {/* Chart */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4 mb-4">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Last 24 hours</h3>
        {loading ? (
          <div className="text-center py-12 text-gray-500">Loading...</div>
        ) : !chartData || chartData.sensorPoints.length === 0 ? (
          <div className="text-center py-12 text-gray-500">No sensor data in the last 24 hours</div>
        ) : (
          <CalibrationChart data={chartData} />
        )}
      </div>

      {/* Pairs table */}
      {data?.pairs?.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Calibration Pairs</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-gray-500 dark:text-gray-400 uppercase border-b border-gray-200 dark:border-gray-700">
                  <th className="pb-2 pr-3">Lab Time</th>
                  <th className="pb-2 pr-3 text-right">Lab Value</th>
                  <th className="pb-2 pr-3 text-right">Sensor Value</th>
                  <th className="pb-2 pr-3 text-right">Ratio</th>
                  <th className="pb-2 pr-3">Status</th>
                  {canEdit && <th className="pb-2 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {data.pairs.map(p => (
                  <tr key={p.lab_id} className="text-gray-700 dark:text-gray-300">
                    <td className="py-2 pr-3">{new Date(p.lab_time.includes('T') ? p.lab_time : p.lab_time + 'T12:00:00Z').toLocaleString()}</td>
                    <td className="py-2 pr-3 text-right font-medium">{p.lab_value}</td>
                    <td className="py-2 pr-3 text-right">{p.sensor_value !== null ? p.sensor_value.toFixed(1) : '—'}</td>
                    <td className="py-2 pr-3 text-right">{p.matched && p.sensor_value > 0 ? (p.lab_value / p.sensor_value).toFixed(3) : '—'}</td>
                    <td className="py-2 pr-3">{p.matched ? <span className="text-green-600">✓ matched</span> : <span className="text-amber-600">no sensor data</span>}</td>
                    {canEdit && (
                      <td className="py-2 text-right whitespace-nowrap">
                        <button onClick={() => editPair(p)} className="text-blue-600 hover:text-blue-800 mr-3" title="Edit value">
                          <svg className="h-4 w-4 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                        </button>
                        <button onClick={() => deletePair(p.lab_id)} className="text-red-500 hover:text-red-700" title="Delete">
                          <svg className="h-4 w-4 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// Simple SVG line chart for calibration
function CalibrationChart({ data }) {
  const width = 800;
  const height = 300;
  const padding = { top: 20, right: 60, bottom: 40, left: 60 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const allRaw = data.sensorPoints.map(p => p.raw);
  const allCal = data.sensorPoints.map(p => p.calibrated);
  const allLab = data.labPoints.map(p => p.lab);
  const allValues = [...allRaw, ...allCal, ...allLab].filter(v => v != null && !isNaN(v));
  if (allValues.length === 0) return <div>No data</div>;

  const yMin = Math.min(...allValues);
  const yMax = Math.max(...allValues);
  const yRange = yMax - yMin || 1;
  const yPad = yRange * 0.1;

  const allTimes = [...data.sensorPoints, ...data.labPoints].map(p => p.time);
  const tMin = Math.min(...allTimes);
  const tMax = Math.max(...allTimes);
  const tRange = tMax - tMin || 1;

  const x = t => padding.left + ((t - tMin) / tRange) * innerW;
  const y = v => padding.top + innerH - ((v - (yMin - yPad)) / (yRange + 2 * yPad)) * innerH;

  const rawPath = data.sensorPoints.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.time)},${y(p.raw)}`).join(' ');
  const calPath = data.sensorPoints.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.time)},${y(p.calibrated)}`).join(' ');

  // Y-axis ticks
  const yTicks = [];
  for (let i = 0; i <= 5; i++) {
    const v = yMin - yPad + (yRange + 2 * yPad) * (i / 5);
    yTicks.push({ v, y: y(v) });
  }

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto" style={{ minWidth: '600px' }}>
        {/* Grid + Y axis */}
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={padding.left} y1={t.y} x2={width - padding.right} y2={t.y} stroke="currentColor" strokeOpacity="0.1" />
            <text x={padding.left - 6} y={t.y + 4} textAnchor="end" className="fill-gray-500 dark:fill-gray-400" fontSize="10">{t.v.toFixed(0)}</text>
          </g>
        ))}
        {/* Raw sensor line */}
        <path d={rawPath} fill="none" stroke="#9CA3AF" strokeWidth="1.5" strokeDasharray="3,3" />
        {/* Calibrated line */}
        <path d={calPath} fill="none" stroke="#3B82F6" strokeWidth="2" />
        {/* Lab reading dots */}
        {data.labPoints.map((p, i) => (
          <g key={i}>
            <circle cx={x(p.time)} cy={y(p.lab)} r="6" fill="#10B981" stroke="white" strokeWidth="2" />
            <text x={x(p.time)} y={y(p.lab) - 10} textAnchor="middle" className="fill-green-700 dark:fill-green-400" fontSize="10" fontWeight="bold">{p.lab}</text>
          </g>
        ))}
        {/* Legend */}
        <g transform={`translate(${padding.left}, ${height - 10})`}>
          <line x1="0" y1="0" x2="20" y2="0" stroke="#9CA3AF" strokeWidth="1.5" strokeDasharray="3,3" />
          <text x="25" y="4" className="fill-gray-600 dark:fill-gray-400" fontSize="11">Raw sensor</text>
          <line x1="120" y1="0" x2="140" y2="0" stroke="#3B82F6" strokeWidth="2" />
          <text x="145" y="4" className="fill-gray-600 dark:fill-gray-400" fontSize="11">Calibrated estimate</text>
          <circle cx="280" cy="0" r="5" fill="#10B981" stroke="white" strokeWidth="2" />
          <text x="290" y="4" className="fill-gray-600 dark:fill-gray-400" fontSize="11">Manual lab reading</text>
        </g>
      </svg>
    </div>
  );
}
