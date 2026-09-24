import React, { useEffect, useState } from 'react';
import { Button, Card, Label, Reading, StatusPill } from '../../ui';
import { useSettings } from '../../context/SettingsContext';
import ModalShell, { InlineNotice, Spinner } from './ModalShell';
import { getEquipmentPresentation, useNow, UnverifiedPill } from './equipmentStatus';

const API_BASE = '/api';
const ROW = 'flex items-center justify-between gap-3 py-3 border-b border-line';
const ROW_LABEL = 'text-sm font-medium text-muted';
const LINK_BTN = 'text-sm font-semibold text-brand hover:underline min-h-[36px] px-1';

function Notice({ msg, className = '' }) {
  if (!msg) return null;
  return <InlineNotice type={msg.type === 'error' ? 'error' : 'success'} className={className}>{msg.text}</InlineNotice>;
}

function Tab({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="tab"
      aria-selected={active}
      className={`min-h-touch px-2 border-b-2 text-sm font-semibold transition-colors ${
        active ? 'border-brand-600 text-brand' : 'border-transparent text-muted hover:text-ink hover:border-line'
      }`}
    >
      {children}
    </button>
  );
}

/** 44px switch, the same control the relay modal uses. */
function Switch({ checked, onChange, disabled, label, busy }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      disabled={disabled}
      className={`relative inline-flex items-center h-11 w-[68px] shrink-0 rounded-full p-1 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed ${checked ? 'bg-state-ok' : 'bg-gray-300 dark:bg-gray-600'}`}
    >
      <span className={`inline-flex items-center justify-center h-9 w-9 rounded-full bg-white shadow transform transition-transform ${checked ? 'translate-x-[24px]' : 'translate-x-0'}`}>
        {busy && <Spinner className="h-4 w-4 text-muted" />}
      </span>
    </button>
  );
}

export default function EquipmentDetailModal({ isOpen, onClose, equipment, token, onUpdate, user }) {
  const { formatDateTime, formatTime } = useSettings();
  const now = useNow(30000);
  const [loading, setLoading] = useState(false);
  const [details, setDetails] = useState(null);
  const [error, setError] = useState(null);
  const [allZones, setAllZones] = useState([]);
  const [selectedZone, setSelectedZone] = useState('');
  const [assigningZone, setAssigningZone] = useState(false);
  const [zoneMessage, setZoneMessage] = useState(null);
  const [controlLoading, setControlLoading] = useState(false);
  const [controlMessage, setControlMessage] = useState(null);
  const [enableLoading, setEnableLoading] = useState(false);
  const [enableMessage, setEnableMessage] = useState(null);
  const [showCalibration, setShowCalibration] = useState(false);
  const [calibrationOffset, setCalibrationOffset] = useState('0');
  const [calibrationScale, setCalibrationScale] = useState('1');
  const [calibrationLoading, setCalibrationLoading] = useState(false);
  const [calibrationMessage, setCalibrationMessage] = useState(null);
  const [testConnectionLoading, setTestConnectionLoading] = useState(false);
  const [testConnectionResult, setTestConnectionResult] = useState(null);

  const [channelLabels, setChannelLabels] = useState({});
  const [labelsLoading, setLabelsLoading] = useState(false);
  const [labelsMessage, setLabelsMessage] = useState(null);
  const [showChannelLabels, setShowChannelLabels] = useState(false);

  const [activeTab, setActiveTab] = useState('details');
  const [historyData, setHistoryData] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(null);
  const [timeRange, setTimeRange] = useState('1h');
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyStats, setHistoryStats] = useState({});
  const [historyOffset, setHistoryOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [chartData, setChartData] = useState([]);

  const [errorLogs, setErrorLogs] = useState([]);
  const [errorLogsLoading, setErrorLogsLoading] = useState(false);
  const [errorLogsError, setErrorLogsError] = useState(null);
  const [showResolved, setShowResolved] = useState(false);

  const canControl = user?.role === 'admin' || user?.role === 'operator';
  const isAdmin = user?.role === 'admin';
  const authHeaders = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  useEffect(() => {
    if (isOpen && equipment) {
      fetchDetails();
      fetchAllZones();
      setActiveTab('details');
      setShowCalibration(false);
      setShowChannelLabels(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, equipment]);

  useEffect(() => {
    if (activeTab === 'history' && equipment) fetchHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, timeRange, equipment]);

  useEffect(() => {
    if (activeTab === 'errors' && equipment) fetchErrorLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, showResolved, equipment]);

  useEffect(() => {
    if (details?.register_mappings && Array.isArray(details.register_mappings)) {
      const labels = {};
      details.register_mappings.forEach(m => { labels[String(m.register ?? m.address)] = m.label || ''; });
      setChannelLabels(labels);
    }
  }, [details]);

  const fetchDetails = async () => {
    if (!equipment) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/equipment/${equipment.id}`, { headers: authHeaders });
      if (!response.ok) {
        if (response.status === 404) throw new Error('This equipment no longer exists. It may have been deleted.');
        throw new Error('Failed to fetch equipment details');
      }
      const data = await response.json();
      setDetails(data);
      setCalibrationOffset(String(data.calibration_offset ?? 0));
      setCalibrationScale(String(data.calibration_scale ?? 1));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchAllZones = async () => {
    try {
      const response = await fetch(`${API_BASE}/zones`, { headers: authHeaders });
      if (response.ok) setAllZones(await response.json());
    } catch (err) {
      console.error('Failed to fetch zones:', err);
    }
  };

  const getFromDate = () => {
    const ms = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 }[timeRange] || 3600e3;
    return new Date(Date.now() - ms);
  };

  const fetchHistory = async () => {
    if (!equipment) return;
    setHistoryLoading(true);
    setHistoryError(null);
    setHistoryOffset(0);
    const from = getFromDate();
    try {
      const [historyRes, chartRes] = await Promise.all([
        fetch(`${API_BASE}/equipment/${equipment.id}/history?from=${from.toISOString()}&limit=25&offset=0`, { headers: authHeaders }),
        fetch(`${API_BASE}/equipment/${equipment.id}/history/chart?from=${from.toISOString()}`, { headers: authHeaders })
      ]);
      if (!historyRes.ok) throw new Error('Failed to fetch history');
      const data = await historyRes.json();
      setHistoryData(data.readings || []);
      setHistoryTotal(data.total || 0);
      setHistoryStats(data.stats || {});
      if (chartRes.ok) setChartData(await chartRes.json());
    } catch (err) {
      setHistoryError(err.message);
    } finally {
      setHistoryLoading(false);
    }
  };

  const loadMoreHistory = async () => {
    if (!equipment) return;
    setLoadingMore(true);
    const newOffset = historyOffset + 25;
    const from = getFromDate();
    try {
      const response = await fetch(`${API_BASE}/equipment/${equipment.id}/history?from=${from.toISOString()}&limit=25&offset=${newOffset}`, { headers: authHeaders });
      if (!response.ok) throw new Error('Failed to fetch more history');
      const data = await response.json();
      setHistoryData(prev => [...prev, ...(data.readings || [])]);
      setHistoryOffset(newOffset);
    } catch (err) {
      setHistoryError(err.message);
    } finally {
      setLoadingMore(false);
    }
  };

  const fetchErrorLogs = async () => {
    if (!equipment) return;
    setErrorLogsLoading(true);
    setErrorLogsError(null);
    try {
      const resolvedParam = showResolved ? '' : '&resolved=false';
      const response = await fetch(`${API_BASE}/equipment/${equipment.id}/errors?limit=50${resolvedParam}`, { headers: authHeaders });
      if (!response.ok) throw new Error('Failed to fetch error logs');
      setErrorLogs(await response.json());
    } catch (err) {
      setErrorLogsError(err.message);
    } finally {
      setErrorLogsLoading(false);
    }
  };

  const handleResolveError = async (errorId) => {
    if (!equipment || !canControl) return;
    try {
      const response = await fetch(`${API_BASE}/equipment/${equipment.id}/errors/${errorId}/resolve`, { method: 'PUT', headers: authHeaders });
      if (!response.ok) throw new Error('Failed to resolve error');
      await fetchErrorLogs();
      await fetchDetails();
      onUpdate?.();
    } catch (err) {
      console.error('Failed to resolve error:', err);
    }
  };

  const flash = (setter, msg, ms = 3000) => {
    setter(msg);
    setTimeout(() => setter(null), ms);
  };

  const handleAssignZone = async () => {
    if (!selectedZone || !equipment) return;
    setAssigningZone(true);
    setZoneMessage(null);
    try {
      const response = await fetch(`${API_BASE}/zones/${selectedZone}/equipment`, {
        method: 'POST', headers: authHeaders, body: JSON.stringify({ equipment_id: equipment.id })
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || 'Failed to assign zone');
      }
      setSelectedZone('');
      await fetchDetails();
      onUpdate?.();
      flash(setZoneMessage, { type: 'success', text: 'Zone assigned.' });
    } catch (err) {
      setZoneMessage({ type: 'error', text: err.message });
    } finally {
      setAssigningZone(false);
    }
  };

  const handleRemoveZone = async (zoneId) => {
    if (!equipment) return;
    setZoneMessage(null);
    try {
      const response = await fetch(`${API_BASE}/zones/${zoneId}/equipment/${equipment.id}`, { method: 'DELETE', headers: authHeaders });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || 'Failed to remove zone');
      }
      await fetchDetails();
      onUpdate?.();
      flash(setZoneMessage, { type: 'success', text: 'Zone removed.' });
    } catch (err) {
      setZoneMessage({ type: 'error', text: err.message });
    }
  };

  const handleControl = async (action) => {
    if (!equipment || !canControl) return;
    setControlLoading(true);
    setControlMessage(null);
    try {
      const response = await fetch(`${API_BASE}/equipment/${equipment.id}/control`, {
        method: 'POST', headers: authHeaders, body: JSON.stringify({ action })
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || 'Failed to control equipment');
      }
      await fetchDetails();
      onUpdate?.();
      flash(setControlMessage, { type: 'success', text: `Turn ${action} command sent.` });
    } catch (err) {
      setControlMessage({ type: 'error', text: err.message });
    } finally {
      setControlLoading(false);
    }
  };

  const handleToggleEnabled = async () => {
    if (!equipment || !canControl) return;
    const newEnabledState = !details?.enabled;
    setEnableLoading(true);
    setEnableMessage(null);
    try {
      const response = await fetch(`${API_BASE}/equipment/${equipment.id}`, {
        method: 'PUT', headers: authHeaders, body: JSON.stringify({ enabled: newEnabledState })
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || 'Failed to update equipment');
      }
      await fetchDetails();
      onUpdate?.();
      flash(setEnableMessage, { type: 'success', text: `Equipment ${newEnabledState ? 'enabled' : 'disabled'}.` });
    } catch (err) {
      setEnableMessage({ type: 'error', text: err.message });
    } finally {
      setEnableLoading(false);
    }
  };

  const handleCalibrateSave = async () => {
    if (!equipment || !isAdmin) return;
    setCalibrationLoading(true);
    setCalibrationMessage(null);
    try {
      const response = await fetch(`${API_BASE}/equipment/${equipment.id}/calibrate`, {
        method: 'POST', headers: authHeaders,
        body: JSON.stringify({ offset: parseFloat(calibrationOffset) || 0, scale: parseFloat(calibrationScale) || 1 })
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || 'Failed to save calibration');
      }
      const result = await response.json();
      setCalibrationOffset(String(result.offset));
      setCalibrationScale(String(result.scale));
      await fetchDetails();
      onUpdate?.();
      setCalibrationMessage({ type: 'success', text: 'Calibration saved.' });
      setTimeout(() => { setCalibrationMessage(null); setShowCalibration(false); }, 1500);
    } catch (err) {
      setCalibrationMessage({ type: 'error', text: err.message });
    } finally {
      setCalibrationLoading(false);
    }
  };

  const handleTestConnection = async () => {
    if (!equipment || !canControl) return;
    setTestConnectionLoading(true);
    setTestConnectionResult(null);
    try {
      const response = await fetch(`${API_BASE}/equipment/${equipment.id}/test-connection`, { method: 'POST', headers: authHeaders });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || 'Connection test failed');
      setTestConnectionResult(result);
      await fetchDetails();
      onUpdate?.();
    } catch (err) {
      setTestConnectionResult({ success: false, message: err.message });
    } finally {
      setTestConnectionLoading(false);
      setTimeout(() => setTestConnectionResult(null), 6000);
    }
  };

  const handleSaveLabels = async () => {
    if (!equipment) return;
    setLabelsLoading(true);
    setLabelsMessage(null);
    try {
      const response = await fetch(`${API_BASE}/equipment/${equipment.id}/channels/labels`, {
        method: 'PATCH', headers: authHeaders, body: JSON.stringify({ labels: channelLabels })
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || 'Failed to save labels');
      }
      const updated = await response.json();
      setDetails(prev => ({ ...prev, ...updated }));
      onUpdate?.();
      flash(setLabelsMessage, { type: 'success', text: 'Channel labels saved.' }, 2000);
    } catch (err) {
      setLabelsMessage({ type: 'error', text: err.message });
    } finally {
      setLabelsLoading(false);
    }
  };

  const handleToggleChannel = async (addr, enable) => {
    try {
      const response = await fetch(`${API_BASE}/equipment/${equipment.id}/channels/toggle`, {
        method: 'PATCH', headers: authHeaders, body: JSON.stringify({ toggles: { [addr]: enable } })
      });
      if (response.ok) {
        const updated = await response.json();
        setDetails(prev => ({ ...prev, ...updated }));
        onUpdate?.();
      }
    } catch (err) {
      console.error('Toggle error:', err);
    }
  };

  const exportHistoryCSV = () => {
    const headers = ['Timestamp', 'Metric', 'Value', 'Unit'];
    const esc = (val) => {
      if (val === null || val === undefined) return '';
      const str = String(val);
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const rows = historyData.map(r => [new Date(r.timestamp).toISOString(), r.name || '', r.value ?? '', r.unit || '']);
    const csv = [headers.map(esc).join(','), ...rows.map(row => row.map(esc).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    const eqName = (details?.name || equipment?.name || 'equipment').replace(/[^a-zA-Z0-9]/g, '_');
    link.href = url;
    link.download = `sensor-data-${eqName}-${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const availableZones = allZones.filter(zone => !details?.zones?.some(z => z.id === zone.id));

  if (!isOpen) return null;

  const eq = details || equipment;
  const presentation = getEquipmentPresentation(eq, {
    now,
    formatSinceFn: (d, sameDay) => (sameDay ? formatTime(d) : formatDateTime(d)),
  });

  return (
    <ModalShell
      open={isOpen}
      onClose={onClose}
      size="lg"
      title={eq?.name || 'Equipment details'}
      subtitle={eq?.description}
      icon={(
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
        </svg>
      )}
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}
    >
      <div className="border-b border-line mb-4" role="tablist">
        <nav className="-mb-px flex gap-4">
          <Tab active={activeTab === 'details'} onClick={() => setActiveTab('details')}>Details</Tab>
          <Tab active={activeTab === 'history'} onClick={() => setActiveTab('history')}>History</Tab>
          <Tab active={activeTab === 'errors'} onClick={() => setActiveTab('errors')}>Error logs</Tab>
        </nav>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8 text-muted"><Spinner className="h-6 w-6" /><span className="ml-3">Loading details…</span></div>
      ) : error ? (
        <InlineNotice type="error">{error}</InlineNotice>
      ) : activeTab === 'details' ? (
        <div>
          <div className={ROW}>
            <span className={ROW_LABEL}>Status</span>
            <StatusPill state={presentation.pill} filled={presentation.filled} text={presentation.text} />
          </div>
          <div className={ROW}>
            <span className={ROW_LABEL}>Type</span>
            <span className="text-sm text-ink">{eq?.type || '—'}</span>
          </div>
          <div className={ROW}>
            <span className={ROW_LABEL}>Protocol</span>
            <span className="text-sm text-ink uppercase font-mono bg-field border border-line px-2 py-0.5 rounded">{eq?.protocol || '—'}</span>
          </div>
          <div className={ROW}>
            <span className={ROW_LABEL}>Connection address</span>
            <span className="text-sm text-ink font-mono">{eq?.address || '—'}</span>
          </div>
          {eq?.protocol === 'modbus' && (
            <div className={ROW}>
              <span className={ROW_LABEL}>Unit · poll</span>
              <span className="text-sm text-ink font-mono tabular">{eq?.slave_id ?? '—'} · {eq?.polling_interval_ms ? `${eq.polling_interval_ms} ms` : '—'}</span>
            </div>
          )}

          <div className="py-3 border-b border-line">
            <div className="flex items-center justify-between gap-3">
              <span className={ROW_LABEL}>Enabled</span>
              {canControl ? (
                <Switch checked={!!eq?.enabled} onChange={handleToggleEnabled} disabled={enableLoading} busy={enableLoading} label="Enabled" />
              ) : (
                <span className="text-sm text-ink">{eq?.enabled ? 'Yes' : 'No'}</span>
              )}
            </div>
            <Notice msg={enableMessage} className="mt-2" />
          </div>

          <div className="py-3 border-b border-line">
            <span className={`${ROW_LABEL} block mb-2`}>Zones</span>
            <Notice msg={zoneMessage} className="mb-3" />
            {eq?.zones && eq.zones.length > 0 ? (
              <div className="flex flex-wrap gap-2 mb-3">
                {eq.zones.map((zone, idx) => (
                  <span key={zone.id || idx} className="inline-flex items-center gap-1 rounded border border-line bg-field pl-2 pr-1 py-0.5 text-xs text-ink">
                    {zone.name}
                    {canControl && (
                      <button type="button" onClick={() => handleRemoveZone(zone.id)} className="inline-flex items-center justify-center h-6 w-6 rounded text-muted hover:text-alarm-600" title="Remove from zone" aria-label={`Remove from ${zone.name}`}>
                        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                      </button>
                    )}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted mb-3">No zones assigned</p>
            )}
            {canControl && (availableZones.length > 0 ? (
              <div className="flex gap-2">
                <select value={selectedZone} onChange={(e) => setSelectedZone(e.target.value)} className="flex-1 min-w-0" aria-label="Zone to assign">
                  <option value="">Select a zone…</option>
                  {availableZones.map(zone => <option key={zone.id} value={zone.id}>{zone.name}</option>)}
                </select>
                <Button variant="secondary" onClick={handleAssignZone} disabled={!selectedZone || assigningZone}>
                  {assigningZone ? <><Spinner /> Assigning…</> : 'Assign'}
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted italic">{allZones.length === 0 ? 'No zones available. Create zones first.' : 'All zones already assigned.'}</p>
            ))}
          </div>

          <div className={ROW}>
            <span className={ROW_LABEL}>Last communication</span>
            <span className="text-sm text-ink font-mono tabular">{eq?.last_communication ? formatDateTime(eq.last_communication) : '—'}</span>
          </div>
          {eq?.last_reading && (
            <div className={`${ROW} items-start`}>
              <span className={ROW_LABEL}>Last reading</span>
              <span className="text-xs text-ink font-mono break-all text-right max-w-[60%]">{String(eq.last_reading)}</span>
            </div>
          )}
          <div className={ROW}>
            <span className={ROW_LABEL}>Created</span>
            <span className="text-sm text-ink font-mono tabular">{eq?.created_at ? formatDateTime(eq.created_at) : '—'}</span>
          </div>

          {/* Calibration */}
          <div className="py-3 border-b border-line">
            <div className="flex items-center justify-between mb-2">
              <span className={ROW_LABEL}>Calibration</span>
              {isAdmin && (
                <button type="button" onClick={() => setShowCalibration(!showCalibration)} className={LINK_BTN}>{showCalibration ? 'Hide' : 'Calibrate'}</button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Card padding="sm"><Label>Offset</Label><Reading size="sm" value={eq?.calibration_offset ?? 0} /></Card>
              <Card padding="sm"><Label>Scale</Label><Reading size="sm" value={eq?.calibration_scale ?? 1} /></Card>
            </div>
            {showCalibration && isAdmin && (
              <Card padding="md" className="mt-3 bg-field">
                <h4 className="font-display text-sm font-semibold text-ink mb-3">Calibration settings</h4>
                <Notice msg={calibrationMessage} className="mb-3" />
                <div className="space-y-3">
                  <div>
                    <label htmlFor="calibration-offset" className="block text-xs font-medium text-muted mb-1">Offset (added to raw value)</label>
                    <input type="number" id="calibration-offset" value={calibrationOffset} onChange={(e) => setCalibrationOffset(e.target.value)} step="0.01" className="w-full font-mono" placeholder="0" />
                  </div>
                  <div>
                    <label htmlFor="calibration-scale" className="block text-xs font-medium text-muted mb-1">Scale (multiplied by raw value)</label>
                    <input type="number" id="calibration-scale" value={calibrationScale} onChange={(e) => setCalibrationScale(e.target.value)} step="0.01" className="w-full font-mono" placeholder="1" />
                  </div>
                  <p className="text-xs text-muted">Formula: <span className="font-mono bg-panel border border-line px-1 py-0.5 rounded">calibrated = (raw × scale) + offset</span></p>
                  <div className="flex gap-2 pt-1">
                    <Button variant="ghost" className="flex-1" onClick={() => setShowCalibration(false)} disabled={calibrationLoading}>Cancel</Button>
                    <Button variant="primary" className="flex-1" onClick={handleCalibrateSave} disabled={calibrationLoading}>
                      {calibrationLoading ? <><Spinner /> Saving…</> : 'Save calibration'}
                    </Button>
                  </div>
                </div>
              </Card>
            )}
            {!isAdmin && <p className="text-xs text-muted mt-1 italic">Calibration settings require admin permissions</p>}
          </div>

          {/* Channels / register mappings */}
          {Array.isArray(eq?.register_mappings) && eq.register_mappings.length > 0 && (
            <div className="py-3 border-b border-line">
              <div className="flex items-center justify-between mb-2">
                <span className={ROW_LABEL}>Channels</span>
                {canControl && (
                  <button type="button" onClick={() => setShowChannelLabels(!showChannelLabels)} className={LINK_BTN}>{showChannelLabels ? 'Hide' : 'Edit labels'}</button>
                )}
              </div>

              {!showChannelLabels && (
                <ul className="space-y-1">
                  {eq.register_mappings.map(m => {
                    const addr = String(m.register ?? m.address);
                    const isDisabled = m.enabled === false;
                    return (
                      <li
                        key={addr}
                        className={`flex items-center justify-between gap-2 px-2 py-1.5 bg-field rounded text-sm border-l-[3px] ${m.unverified ? 'border-l-state-caution' : 'border-l-transparent'} ${isDisabled ? 'opacity-50' : ''}`}
                        data-unverified={m.unverified ? 'true' : undefined}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          {canControl && (
                            <input
                              type="checkbox"
                              checked={!isDisabled}
                              onChange={() => handleToggleChannel(addr, isDisabled)}
                              className="h-4 w-4"
                              title={isDisabled ? 'Enable this reading' : 'Disable this reading'}
                              aria-label={`${m.name} enabled`}
                            />
                          )}
                          <span className="text-muted truncate">{m.name}</span>
                          <span className="text-xs font-mono text-muted shrink-0">reg {addr}</span>
                          {m.unverified && <UnverifiedPill />}
                        </div>
                        {m.label ? (
                          <span className="font-medium text-ink truncate">{m.label}</span>
                        ) : (
                          <span className="text-muted italic">No label</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}

              {showChannelLabels && canControl && (
                <Card padding="sm" className="mt-2 bg-field">
                  <Notice msg={labelsMessage} className="mb-3" />
                  <div className="space-y-2">
                    {eq.register_mappings.map(m => {
                      const addr = String(m.register ?? m.address);
                      return (
                        <div key={addr} className="flex items-center gap-2">
                          <span className="text-xs text-muted w-28 shrink-0 truncate" title={m.name}>{m.name}</span>
                          <input
                            type="text"
                            value={channelLabels[addr] || ''}
                            onChange={(e) => setChannelLabels(prev => ({ ...prev, [addr]: e.target.value }))}
                            placeholder="e.g. Water Pump"
                            className="flex-1 min-w-0"
                            aria-label={`Label for ${m.name}`}
                          />
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex gap-2 mt-3">
                    <Button variant="ghost" className="flex-1" onClick={() => setShowChannelLabels(false)} disabled={labelsLoading}>Cancel</Button>
                    <Button variant="primary" className="flex-1" onClick={handleSaveLabels} disabled={labelsLoading}>{labelsLoading ? 'Saving…' : 'Save labels'}</Button>
                  </div>
                </Card>
              )}
            </div>
          )}

          {/* Equipment control */}
          <div className="py-3 border-b border-line">
            <span className={`${ROW_LABEL} block mb-3`}>Equipment control</span>
            <Notice msg={controlMessage} className="mb-3" />
            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => handleControl('on')} disabled={!canControl || controlLoading} title={!canControl ? 'Requires operator or admin' : undefined}>
                {controlLoading ? <Spinner /> : 'Turn on'}
              </Button>
              <Button variant="secondary" className="flex-1" onClick={() => handleControl('off')} disabled={!canControl || controlLoading} title={!canControl ? 'Requires operator or admin' : undefined}>
                {controlLoading ? <Spinner /> : 'Turn off'}
              </Button>
            </div>
            {!canControl && <p className="text-xs text-muted mt-2">Equipment control requires operator or admin permissions.</p>}
          </div>

          {/* Connection test */}
          <div className="py-3">
            <span className={`${ROW_LABEL} block mb-3`}>Connection test</span>
            {testConnectionResult && (
              <InlineNotice type={testConnectionResult.success ? 'success' : 'error'} className="mb-3">
                <div className="font-medium">{testConnectionResult.message}</div>
                {testConnectionResult.success && testConnectionResult.latency_ms != null && <div className="text-xs font-mono">Latency: {testConnectionResult.latency_ms} ms</div>}
                {!testConnectionResult.success && testConnectionResult.error && <div className="text-xs font-mono">{testConnectionResult.error}</div>}
                {testConnectionResult.last_communication && <div className="text-xs">Last communication: {formatDateTime(testConnectionResult.last_communication)}</div>}
              </InlineNotice>
            )}
            <Button variant="secondary" className="w-full" onClick={handleTestConnection} disabled={!canControl || testConnectionLoading} title={!canControl ? 'Requires operator or admin' : undefined}>
              {testConnectionLoading ? <><Spinner /> Testing connection…</> : 'Test connection'}
            </Button>
          </div>
        </div>
      ) : activeTab === 'history' ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="history-range" className="text-sm font-medium text-ink">Time range</label>
            <select id="history-range" value={timeRange} onChange={(e) => setTimeRange(e.target.value)} className="!py-1.5 min-h-[36px]">
              <option value="1h">Last hour</option>
              <option value="24h">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
            </select>
          </div>

          {historyLoading ? (
            <div className="flex items-center justify-center py-8 text-muted text-sm"><Spinner className="h-5 w-5" /><span className="ml-3">Loading history…</span></div>
          ) : historyError ? (
            <InlineNotice type="error">
              {historyError}
              <button type="button" onClick={fetchHistory} className="ml-2 underline">Try again</button>
            </InlineNotice>
          ) : historyData.length === 0 ? (
            <div className="text-center py-8">
              <h4 className="text-sm font-medium text-ink">No readings</h4>
              <p className="mt-1 text-sm text-muted">No historical data available for the selected time range.</p>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-muted font-mono tabular">{historyTotal.toLocaleString()} readings in range</p>
                <Button variant="ghost" size="sm" onClick={exportHistoryCSV} title="Export history data to CSV">Export CSV</Button>
              </div>

              {/* Mini chart - one line per metric (chart owned by another agent this wave; left as is) */}
              {chartData.length > 1 && (() => {
                const metricColors = ['#2563EB', '#22C55E', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6'];
                const grouped = {};
                chartData.forEach(d => {
                  const key = d.name || '_default';
                  if (!grouped[key]) grouped[key] = [];
                  grouped[key].push(d);
                });
                const metricNames = Object.keys(grouped);
                const isSingleMetric = metricNames.length === 1;
                const chartHeight = isSingleMetric ? 120 : 160;

                return (
                  <div className="border border-line rounded-card p-3 bg-field">
                    <Label className="mb-2">Trend</Label>
                    {metricNames.length > 1 && (
                      <div className="flex flex-wrap gap-3 mb-2">
                        {metricNames.map((name, i) => (
                          <span key={name} className="flex items-center text-xs text-muted">
                            <span className="inline-block w-3 h-1 rounded mr-1.5" style={{ backgroundColor: metricColors[i % metricColors.length] }}></span>
                            {name === '_default' ? 'Value' : name}
                            {grouped[name][0]?.unit ? ` (${grouped[name][0].unit})` : ''}
                          </span>
                        ))}
                      </div>
                    )}
                    <svg viewBox={`0 0 600 ${chartHeight}`} className="w-full h-auto">
                      <defs>
                        {metricNames.map((_, i) => (
                          <linearGradient key={i} id={`chartGrad${i}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={metricColors[i % metricColors.length]} />
                            <stop offset="100%" stopColor={metricColors[i % metricColors.length]} stopOpacity="0" />
                          </linearGradient>
                        ))}
                      </defs>
                      {metricNames.map((name, metricIdx) => {
                        const series = grouped[name];
                        const values = series.map(d => parseFloat(d.avg_value)).filter(v => !isNaN(v));
                        if (values.length < 2) return null;
                        const minV = Math.min(...values);
                        const maxV = Math.max(...values);
                        const range = maxV - minV || 1;
                        const pad = 10;
                        const w = 600 - pad * 2;
                        const h = chartHeight - pad * 2;
                        const points = values.map((v, i) => {
                          const x = pad + (i / (values.length - 1)) * w;
                          const y = pad + h - ((v - minV) / range) * h;
                          return `${x.toFixed(1)},${y.toFixed(1)}`;
                        });
                        const color = metricColors[metricIdx % metricColors.length];
                        const areaPoints = [...points, `${(pad + w).toFixed(1)},${(pad + h).toFixed(1)}`, `${pad.toFixed(1)},${(pad + h).toFixed(1)}`];
                        return (
                          <g key={name}>
                            {isSingleMetric && <polygon points={areaPoints.join(' ')} fill={`url(#chartGrad${metricIdx})`} opacity="0.3" />}
                            <polyline points={points.join(' ')} fill="none" stroke={color} strokeWidth="2" opacity={isSingleMetric ? 1 : 0.8} />
                          </g>
                        );
                      })}
                    </svg>
                  </div>
                );
              })()}

              {/* Per-metric stats as labelled Readings */}
              {(() => {
                const metricKeys = Object.keys(historyStats || {});
                if (metricKeys.length === 0) return null;
                return (
                  <div className={`grid gap-3 ${metricKeys.length === 1 ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2'}`}>
                    {metricKeys.map(key => {
                      const s = historyStats[key] || {};
                      const label = key === '_default' ? 'Value' : key;
                      const has = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
                      return (
                        <Card key={key} padding="sm" rail="idle">
                          <Label className="truncate mb-2" title={label}>{label}</Label>
                          <div className="grid grid-cols-3 gap-2 items-end">
                            <div>
                              <Label className="!text-[10px]">Avg</Label>
                              <Reading size="sm" value={has(s.avg) ? Number(s.avg) : null} precision={2} unit={s.unit || undefined} unknown={!has(s.avg)} />
                            </div>
                            <div>
                              <Label className="!text-[10px]">Range</Label>
                              <span className="inline-flex items-baseline gap-1 flex-wrap">
                                <Reading size="sm" value={has(s.min) ? Number(s.min) : null} precision={1} unknown={!has(s.min)} />
                                <span className="text-xs text-muted">–</span>
                                <Reading size="sm" value={has(s.max) ? Number(s.max) : null} precision={1} unit={s.unit || undefined} unknown={!has(s.max)} />
                              </span>
                            </div>
                            <div>
                              <Label className="!text-[10px]">Count</Label>
                              <Reading size="sm" value={has(s.count) ? Number(s.count) : null} precision={0} unknown={!has(s.count)} />
                            </div>
                          </div>
                        </Card>
                      );
                    })}
                  </div>
                );
              })()}

              {(() => {
                const hasNames = historyData.some(r => r.name);
                return (
                  <Card padding="none">
                    <table className="w-full table-fixed">
                      <thead className="bg-field border-b border-line">
                        <tr>
                          <th className="px-3 py-2 text-left">Timestamp</th>
                          {hasNames && <th className="px-3 py-2 text-left">Metric</th>}
                          <th className="px-3 py-2 text-right w-24">Value</th>
                          <th className="px-3 py-2 text-left w-16">Unit</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {historyData.map((reading, idx) => (
                          <tr key={reading.id || idx} className="hover:bg-field/70">
                            <td className="px-3 py-1.5 text-xs font-mono tabular text-ink truncate">{formatDateTime(reading.timestamp)}</td>
                            {hasNames && <td className="px-3 py-1.5 text-xs text-muted truncate">{reading.name || '—'}</td>}
                            <td className="px-3 py-1.5 text-sm font-mono tabular text-ink text-right">{reading.value}</td>
                            <td className="px-3 py-1.5 text-xs text-muted">{reading.unit || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {historyData.length < historyTotal && (
                      <div className="bg-field px-3 py-2 text-center border-t border-line">
                        <Button variant="secondary" size="sm" onClick={loadMoreHistory} disabled={loadingMore}>
                          {loadingMore ? <><Spinner /> Loading…</> : `Load more (showing ${historyData.length} of ${historyTotal})`}
                        </Button>
                      </div>
                    )}
                    {historyData.length >= historyTotal && historyTotal > 0 && (
                      <div className="bg-field px-3 py-2 text-xs text-muted text-center border-t border-line">All {historyTotal} readings loaded</div>
                    )}
                  </Card>
                );
              })()}
            </>
          )}
        </div>
      ) : activeTab === 'errors' ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-ink">Error history</span>
            <label className="flex items-center gap-2 cursor-pointer min-h-[36px] text-sm text-muted">
              <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} className="h-4 w-4" />
              Show resolved
            </label>
          </div>

          {errorLogsLoading ? (
            <div className="flex items-center justify-center py-8 text-muted text-sm"><Spinner className="h-5 w-5" /><span className="ml-3">Loading error logs…</span></div>
          ) : errorLogsError ? (
            <InlineNotice type="error">
              {errorLogsError}
              <button type="button" onClick={fetchErrorLogs} className="ml-2 underline">Try again</button>
            </InlineNotice>
          ) : errorLogs.length === 0 ? (
            <div className="text-center py-8">
              <h4 className="text-sm font-medium text-ink">No errors</h4>
              <p className="mt-1 text-sm text-muted">{showResolved ? 'No error logs found for this equipment.' : 'No active errors for this equipment.'}</p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Card padding="sm" rail={errorLogs.some(e => !e.resolved) ? 'alarm' : 'idle'}>
                  <Label>Active</Label>
                  <Reading size="md" value={errorLogs.filter(e => !e.resolved).length} precision={0} />
                </Card>
                <Card padding="sm" rail="idle">
                  <Label>Resolved</Label>
                  <Reading size="md" value={errorLogs.filter(e => e.resolved).length} precision={0} />
                </Card>
              </div>

              <ul className="space-y-2">
                {errorLogs.map((errorLog) => (
                  <Card as="li" key={errorLog.id} padding="sm" rail={errorLog.resolved ? 'idle' : 'alarm'} className={errorLog.resolved ? 'opacity-70' : ''}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="inline-flex items-center rounded border border-line bg-field px-1.5 py-0.5 text-xs font-mono text-muted">{errorLog.error_type || 'other'}</span>
                          {errorLog.resolved && <StatusPill state="ok" filled={false} text="Resolved" />}
                        </div>
                        <p className={`mt-1 text-sm ${errorLog.resolved ? 'text-muted' : 'text-ink'}`}>{errorLog.message}</p>
                        {errorLog.details && <p className="mt-1 text-xs text-muted font-mono break-all">{errorLog.details}</p>}
                        <p className="mt-1 text-xs text-muted font-mono tabular">
                          {formatDateTime(errorLog.created_at)}
                          {errorLog.resolved_at && <span className="ml-2">· resolved {formatDateTime(errorLog.resolved_at)}</span>}
                        </p>
                      </div>
                      {!errorLog.resolved && canControl && (
                        <Button variant="secondary" size="sm" onClick={() => handleResolveError(errorLog.id)} title="Mark as resolved">Resolve</Button>
                      )}
                    </div>
                  </Card>
                ))}
              </ul>
              {errorLogs.length >= 50 && <p className="text-center text-xs text-muted">Showing most recent 50 errors</p>}
            </>
          )}
        </div>
      ) : null}
    </ModalShell>
  );
}
