import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useWebSocket } from '../context/WebSocketContext';
import { useBreadcrumb } from '../components/Breadcrumb';
import { getUserFriendlyError } from '../utils/errorHandler';
import ErrorMessage from '../components/ErrorMessage';

const API_BASE = '/api';

// Modbus Register Mapping Preset Templates
// Waveshare relay modules use:
// - Coil addresses 0x0000-0x001F for relay control
// - Holding register 0x2000 (8192) for baud rate configuration
// - Holding register 0x4000 (16384) for device address configuration

// Helper function to generate relay coil mappings
const generateRelayMappings = (channelCount) => {
  const mappings = [];
  for (let i = 0; i < channelCount; i++) {
    mappings.push({
      name: `Relay ${i + 1}`,
      register: String(i),
      type: 'coil',
      dataType: 'bool',
      access: 'readwrite'
    });
  }
  // Add Waveshare configuration registers
  mappings.push({
    name: 'Baud Rate Config',
    register: '8192', // 0x2000
    type: 'holding',
    dataType: 'uint16',
    access: 'readwrite'
  });
  mappings.push({
    name: 'Device Address Config',
    register: '16384', // 0x4000
    type: 'holding',
    dataType: 'uint16',
    access: 'readwrite'
  });
  return mappings;
};

const REGISTER_PRESETS = {
  // Waveshare Relay Modules (all channel variants)
  waveshare_4ch_relay: {
    name: 'Waveshare 4-Channel Relay',
    category: 'waveshare',
    description: 'Waveshare Modbus RTU 4-channel relay module with configuration registers',
    mappings: generateRelayMappings(4)
  },
  waveshare_6ch_relay: {
    name: 'Waveshare 6-Channel Relay',
    category: 'waveshare',
    description: 'Waveshare Modbus RTU 6-channel relay module with configuration registers',
    mappings: generateRelayMappings(6)
  },
  waveshare_8ch_relay: {
    name: 'Waveshare 8-Channel Relay',
    category: 'waveshare',
    description: 'Waveshare Modbus RTU 8-channel relay module with configuration registers',
    mappings: generateRelayMappings(8)
  },
  waveshare_16ch_relay: {
    name: 'Waveshare 16-Channel Relay',
    category: 'waveshare',
    description: 'Waveshare Modbus RTU 16-channel relay module with configuration registers',
    mappings: generateRelayMappings(16)
  },
  waveshare_32ch_relay: {
    name: 'Waveshare 32-Channel Relay',
    category: 'waveshare',
    description: 'Waveshare Modbus RTU 32-channel relay module with configuration registers',
    mappings: generateRelayMappings(32)
  },
  // Generic device templates
  generic_temp_humidity: {
    name: 'Temperature/Humidity Sensor',
    category: 'sensor',
    description: 'Generic temperature and humidity sensor',
    mappings: [
      { name: 'Temperature', register: '0', type: 'input', dataType: 'int16', access: 'read' },
      { name: 'Humidity', register: '1', type: 'input', dataType: 'uint16', access: 'read' },
    ]
  },
  generic_power_meter: {
    name: 'Power Meter',
    category: 'meter',
    description: 'Generic power meter with voltage, current, power and energy readings',
    mappings: [
      { name: 'Voltage', register: '0', type: 'input', dataType: 'float32', access: 'read' },
      { name: 'Current', register: '2', type: 'input', dataType: 'float32', access: 'read' },
      { name: 'Power', register: '4', type: 'input', dataType: 'float32', access: 'read' },
      { name: 'Energy', register: '6', type: 'input', dataType: 'float32', access: 'read' },
    ]
  },
  generic_vfd: {
    name: 'Variable Frequency Drive (VFD)',
    category: 'controller',
    description: 'Generic VFD with frequency control and monitoring',
    mappings: [
      { name: 'Frequency Setpoint', register: '0', type: 'holding', dataType: 'uint16', access: 'readwrite' },
      { name: 'Actual Frequency', register: '1', type: 'input', dataType: 'uint16', access: 'read' },
      { name: 'Motor Current', register: '2', type: 'input', dataType: 'uint16', access: 'read' },
      { name: 'Motor Voltage', register: '3', type: 'input', dataType: 'uint16', access: 'read' },
      { name: 'Run/Stop Command', register: '0', type: 'coil', dataType: 'bool', access: 'readwrite' },
    ]
  }
};

// Status badge component with color coding
function StatusBadge({ status, large = false }) {
  const statusStyles = {
    online: 'bg-green-100 text-green-800 border-green-200',
    offline: 'bg-gray-100 text-gray-800 border-gray-200',
    error: 'bg-red-100 text-red-800 border-red-200',
    warning: 'bg-amber-100 text-amber-800 border-amber-200',
    disabled: 'bg-slate-100 text-slate-500 border-slate-200',
  };

  const statusLabels = {
    online: 'Online',
    offline: 'Offline',
    error: 'Error',
    warning: 'Warning',
    disabled: 'Disabled',
  };

  const style = statusStyles[status] || statusStyles.offline;
  const label = statusLabels[status] || status || 'Unknown';
  const sizeClass = large ? 'px-3 py-1 text-sm' : 'px-2.5 py-0.5 text-xs';
  const dotSize = large ? 'w-2 h-2' : 'w-1.5 h-1.5';

  return (
    <span className={`inline-flex items-center rounded-full font-medium border ${style} ${sizeClass}`}>
      <span className={`${dotSize} rounded-full mr-1.5 ${
        status === 'online' ? 'bg-green-500' :
        status === 'error' ? 'bg-red-500' :
        status === 'warning' ? 'bg-amber-500' :
        status === 'disabled' ? 'bg-slate-400' :
        'bg-gray-400'
      }`}></span>
      {label}
    </span>
  );
}

// Equipment Detail Modal
function EquipmentDetailModal({ isOpen, onClose, equipment, token, onUpdate, user }) {
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

  // History tab state
  const [activeTab, setActiveTab] = useState('details');
  const [historyData, setHistoryData] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(null);
  const [timeRange, setTimeRange] = useState('1h');

  // Error Logs tab state
  const [errorLogs, setErrorLogs] = useState([]);
  const [errorLogsLoading, setErrorLogsLoading] = useState(false);
  const [errorLogsError, setErrorLogsError] = useState(null);
  const [showResolved, setShowResolved] = useState(false);

  // Check if user can control equipment (admin or operator only)
  const canControl = user?.role === 'admin' || user?.role === 'operator';

  useEffect(() => {
    if (isOpen && equipment) {
      fetchDetails();
      fetchAllZones();
      setActiveTab('details'); // Reset to details tab when opening
    }
  }, [isOpen, equipment]);

  // Fetch history when history tab is selected or time range changes
  useEffect(() => {
    if (activeTab === 'history' && equipment) {
      fetchHistory();
    }
  }, [activeTab, timeRange, equipment]);

  // Fetch error logs when error logs tab is selected or showResolved changes
  useEffect(() => {
    if (activeTab === 'errors' && equipment) {
      fetchErrorLogs();
    }
  }, [activeTab, showResolved, equipment]);

  const fetchDetails = async () => {
    if (!equipment) return;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`${API_BASE}/equipment/${equipment.id}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('This equipment no longer exists. It may have been deleted.');
        }
        throw new Error('Failed to fetch equipment details');
      }

      const data = await response.json();
      setDetails(data);
      // Set calibration values from equipment data
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
      const response = await fetch(`${API_BASE}/zones`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        setAllZones(data);
      }
    } catch (err) {
      console.error('Failed to fetch zones:', err);
    }
  };

  const fetchHistory = async () => {
    if (!equipment) return;

    setHistoryLoading(true);
    setHistoryError(null);

    try {
      const now = new Date();
      let from;
      switch (timeRange) {
        case '1h':
          from = new Date(now.getTime() - 60 * 60 * 1000);
          break;
        case '24h':
          from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          break;
        case '7d':
          from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case '30d':
          from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          break;
        default:
          from = new Date(now.getTime() - 60 * 60 * 1000);
      }

      const response = await fetch(
        `${API_BASE}/equipment/${equipment.id}/history?from=${from.toISOString()}&limit=100`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (!response.ok) {
        throw new Error('Failed to fetch history');
      }

      const data = await response.json();
      setHistoryData(data);
    } catch (err) {
      setHistoryError(err.message);
    } finally {
      setHistoryLoading(false);
    }
  };

  const fetchErrorLogs = async () => {
    if (!equipment) return;

    setErrorLogsLoading(true);
    setErrorLogsError(null);

    try {
      const resolvedParam = showResolved ? '' : '&resolved=false';
      const response = await fetch(
        `${API_BASE}/equipment/${equipment.id}/errors?limit=50${resolvedParam}`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (!response.ok) {
        throw new Error('Failed to fetch error logs');
      }

      const data = await response.json();
      setErrorLogs(data);
    } catch (err) {
      setErrorLogsError(err.message);
    } finally {
      setErrorLogsLoading(false);
    }
  };

  const handleResolveError = async (errorId) => {
    if (!equipment || !canControl) return;

    try {
      const response = await fetch(
        `${API_BASE}/equipment/${equipment.id}/errors/${errorId}/resolve`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (!response.ok) {
        throw new Error('Failed to resolve error');
      }

      // Refresh error logs and equipment details
      await fetchErrorLogs();
      await fetchDetails();
      if (onUpdate) onUpdate();
    } catch (err) {
      console.error('Failed to resolve error:', err);
    }
  };

  const handleAssignZone = async () => {
    if (!selectedZone || !equipment) return;

    setAssigningZone(true);
    setZoneMessage(null);

    try {
      const response = await fetch(`${API_BASE}/zones/${selectedZone}/equipment`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ equipment_id: equipment.id })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Failed to assign zone');
      }

      setZoneMessage({ type: 'success', text: 'Zone assigned successfully!' });
      setSelectedZone('');

      // Refresh equipment details to show new zone
      await fetchDetails();

      // Notify parent to refresh
      if (onUpdate) onUpdate();

      // Clear success message after delay
      setTimeout(() => setZoneMessage(null), 3000);
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
      const response = await fetch(`${API_BASE}/zones/${zoneId}/equipment/${equipment.id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Failed to remove zone');
      }

      setZoneMessage({ type: 'success', text: 'Zone removed successfully!' });

      // Refresh equipment details
      await fetchDetails();

      // Notify parent to refresh
      if (onUpdate) onUpdate();

      // Clear success message after delay
      setTimeout(() => setZoneMessage(null), 3000);
    } catch (err) {
      setZoneMessage({ type: 'error', text: err.message });
    }
  };

  // Handle equipment control (on/off toggle)
  const handleControl = async (action) => {
    if (!equipment || !canControl) return;

    setControlLoading(true);
    setControlMessage(null);

    try {
      const response = await fetch(`${API_BASE}/equipment/${equipment.id}/control`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ action })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Failed to control equipment');
      }

      setControlMessage({ type: 'success', text: `Equipment turned ${action}!` });

      // Refresh equipment details
      await fetchDetails();

      // Notify parent to refresh
      if (onUpdate) onUpdate();

      // Clear success message after delay
      setTimeout(() => setControlMessage(null), 3000);
    } catch (err) {
      setControlMessage({ type: 'error', text: err.message });
    } finally {
      setControlLoading(false);
    }
  };

  // Handle enable/disable toggle
  const handleToggleEnabled = async () => {
    if (!equipment || !canControl) return;

    const newEnabledState = !details?.enabled;
    setEnableLoading(true);
    setEnableMessage(null);

    try {
      const response = await fetch(`${API_BASE}/equipment/${equipment.id}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ enabled: newEnabledState })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Failed to update equipment');
      }

      setEnableMessage({ type: 'success', text: `Equipment ${newEnabledState ? 'enabled' : 'disabled'} successfully!` });

      // Refresh equipment details
      await fetchDetails();

      // Notify parent to refresh
      if (onUpdate) onUpdate();

      // Clear success message after delay
      setTimeout(() => setEnableMessage(null), 3000);
    } catch (err) {
      setEnableMessage({ type: 'error', text: err.message });
    } finally {
      setEnableLoading(false);
    }
  };

  // Handle calibration save (admin only)
  const handleCalibrateSave = async () => {
    if (!equipment || user?.role !== 'admin') return;

    setCalibrationLoading(true);
    setCalibrationMessage(null);

    try {
      const response = await fetch(`${API_BASE}/equipment/${equipment.id}/calibrate`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          offset: parseFloat(calibrationOffset) || 0,
          scale: parseFloat(calibrationScale) || 1
        })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Failed to save calibration');
      }

      const result = await response.json();
      setCalibrationMessage({ type: 'success', text: 'Calibration saved successfully!' });

      // Update local values from response
      setCalibrationOffset(String(result.offset));
      setCalibrationScale(String(result.scale));

      // Refresh equipment details
      await fetchDetails();

      // Notify parent to refresh
      if (onUpdate) onUpdate();

      // Close calibration form after success
      setTimeout(() => {
        setCalibrationMessage(null);
        setShowCalibration(false);
      }, 2000);
    } catch (err) {
      setCalibrationMessage({ type: 'error', text: err.message });
    } finally {
      setCalibrationLoading(false);
    }
  };

  // Handle test connection
  const handleTestConnection = async () => {
    if (!equipment || !canControl) return;

    setTestConnectionLoading(true);
    setTestConnectionResult(null);

    try {
      const response = await fetch(`${API_BASE}/equipment/${equipment.id}/test-connection`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.message || 'Connection test failed');
      }

      setTestConnectionResult(result);

      // Refresh equipment details to show updated last_communication
      await fetchDetails();

      // Notify parent to refresh
      if (onUpdate) onUpdate();

      // Clear result after delay
      setTimeout(() => setTestConnectionResult(null), 5000);
    } catch (err) {
      setTestConnectionResult({ success: false, message: err.message });
      setTimeout(() => setTestConnectionResult(null), 5000);
    } finally {
      setTestConnectionLoading(false);
    }
  };

  // Get zones that are not already assigned
  const availableZones = allZones.filter(
    zone => !details?.zones?.some(z => z.id === zone.id)
  );

  if (!isOpen) return null;

  const eq = details || equipment;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0">
        {/* Backdrop */}
        <div
          className="fixed inset-0 transition-opacity bg-gray-500 bg-opacity-75"
          onClick={onClose}
        ></div>

        {/* Modal */}
        <div className="inline-block w-full max-w-lg p-6 my-8 overflow-hidden text-left align-middle transition-all transform bg-white shadow-xl rounded-lg relative">
          {/* Close button */}
          <button
            onClick={onClose}
            className="absolute top-4 right-4 text-gray-400 hover:text-gray-600"
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          {/* Header */}
          <div className="flex items-start mb-6">
            <div className="flex-shrink-0 h-12 w-12 bg-primary-100 rounded-lg flex items-center justify-center mr-4">
              <svg className="h-7 w-7 text-primary-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-lg font-semibold text-gray-900 truncate">
                {eq?.name || 'Equipment Details'}
              </h3>
              {eq?.description && (
                <p className="text-sm text-gray-500 mt-1">{eq.description}</p>
              )}
            </div>
          </div>

          {/* Tabs */}
          <div className="border-b border-gray-200 mb-4">
            <nav className="-mb-px flex space-x-8">
              <button
                onClick={() => setActiveTab('details')}
                className={`py-2 px-1 border-b-2 font-medium text-sm ${
                  activeTab === 'details'
                    ? 'border-primary-500 text-primary-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                Details
              </button>
              <button
                onClick={() => setActiveTab('history')}
                className={`py-2 px-1 border-b-2 font-medium text-sm ${
                  activeTab === 'history'
                    ? 'border-primary-500 text-primary-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                History
              </button>
              <button
                onClick={() => setActiveTab('errors')}
                className={`py-2 px-1 border-b-2 font-medium text-sm ${
                  activeTab === 'errors'
                    ? 'border-primary-500 text-primary-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                Error Logs
              </button>
            </nav>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
              <span className="ml-3 text-gray-500">Loading details...</span>
            </div>
          ) : error ? (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <div className="flex items-center">
                <svg className="h-5 w-5 text-red-400 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-red-800 text-sm">{error}</span>
              </div>
            </div>
          ) : activeTab === 'details' ? (
            <div className="space-y-4">
              {/* Status */}
              <div className="flex items-center justify-between py-3 border-b border-gray-100">
                <span className="text-sm font-medium text-gray-500">Status</span>
                <StatusBadge status={eq?.status} large />
              </div>

              {/* Type/Category */}
              <div className="flex items-center justify-between py-3 border-b border-gray-100">
                <span className="text-sm font-medium text-gray-500">Type / Category</span>
                <span className="text-sm text-gray-900">{eq?.type || '-'}</span>
              </div>

              {/* Protocol */}
              <div className="flex items-center justify-between py-3 border-b border-gray-100">
                <span className="text-sm font-medium text-gray-500">Protocol</span>
                <span className="text-sm text-gray-900 uppercase font-mono bg-gray-100 px-2 py-0.5 rounded">
                  {eq?.protocol || '-'}
                </span>
              </div>

              {/* Connection Address */}
              <div className="flex items-center justify-between py-3 border-b border-gray-100">
                <span className="text-sm font-medium text-gray-500">Connection Address</span>
                <span className="text-sm text-gray-900 font-mono">
                  {eq?.address || '-'}
                </span>
              </div>

              {/* Enabled Toggle */}
              <div className="py-3 border-b border-gray-100">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-500">Enabled</span>
                  {canControl ? (
                    <button
                      onClick={handleToggleEnabled}
                      disabled={enableLoading}
                      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:opacity-50 ${
                        eq?.enabled ? 'bg-green-500' : 'bg-gray-200'
                      }`}
                      role="switch"
                      aria-checked={eq?.enabled}
                    >
                      <span
                        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                          eq?.enabled ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  ) : (
                    <span className={`text-sm font-medium ${eq?.enabled ? 'text-green-600' : 'text-gray-400'}`}>
                      {eq?.enabled ? 'Yes' : 'No'}
                    </span>
                  )}
                </div>
                {/* Enable Message */}
                {enableMessage && (
                  <div className={`mt-2 p-2 rounded text-sm ${
                    enableMessage.type === 'success'
                      ? 'bg-green-50 text-green-800 border border-green-200'
                      : 'bg-red-50 text-red-800 border border-red-200'
                  }`}>
                    {enableMessage.text}
                  </div>
                )}
              </div>

              {/* Zone Assignment Section */}
              <div className="py-3 border-b border-gray-100">
                <span className="text-sm font-medium text-gray-500 block mb-2">Zone Assignment</span>

                {/* Zone Message */}
                {zoneMessage && (
                  <div className={`mb-3 p-2 rounded text-sm ${
                    zoneMessage.type === 'success'
                      ? 'bg-green-50 text-green-800 border border-green-200'
                      : 'bg-red-50 text-red-800 border border-red-200'
                  }`}>
                    {zoneMessage.text}
                  </div>
                )}

                {/* Current Zones */}
                {eq?.zones && eq.zones.length > 0 ? (
                  <div className="flex flex-wrap gap-2 mb-3">
                    {eq.zones.map((zone, idx) => (
                      <span
                        key={zone.id || idx}
                        className="inline-flex items-center px-2.5 py-1 rounded text-xs font-medium bg-blue-100 text-blue-800"
                      >
                        {zone.name}
                        <button
                          onClick={() => handleRemoveZone(zone.id)}
                          className="ml-1.5 text-blue-600 hover:text-blue-900 focus:outline-none"
                          title="Remove from zone"
                        >
                          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-gray-400 mb-3">No zones assigned</p>
                )}

                {/* Add Zone Section */}
                {availableZones.length > 0 ? (
                  <div className="flex gap-2">
                    <select
                      value={selectedZone}
                      onChange={(e) => setSelectedZone(e.target.value)}
                      className="flex-1 text-sm border border-gray-300 rounded-lg px-3 py-1.5 focus:ring-primary-500 focus:border-primary-500"
                    >
                      <option value="">Select a zone...</option>
                      {availableZones.map(zone => (
                        <option key={zone.id} value={zone.id}>{zone.name}</option>
                      ))}
                    </select>
                    <button
                      onClick={handleAssignZone}
                      disabled={!selectedZone || assigningZone}
                      className="px-3 py-1.5 text-sm text-white bg-primary-600 rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                    >
                      {assigningZone ? (
                        <>
                          <svg className="animate-spin -ml-0.5 mr-1.5 h-3 w-3 text-white" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                          Assigning...
                        </>
                      ) : (
                        'Assign'
                      )}
                    </button>
                  </div>
                ) : allZones.length === 0 ? (
                  <p className="text-sm text-gray-400 italic">No zones available. Create zones first.</p>
                ) : (
                  <p className="text-sm text-gray-400 italic">All zones already assigned.</p>
                )}
              </div>

              {/* Last Communication */}
              {eq?.last_communication && (
                <div className="flex items-center justify-between py-3 border-b border-gray-100">
                  <span className="text-sm font-medium text-gray-500">Last Communication</span>
                  <span className="text-sm text-gray-900">
                    {new Date(eq.last_communication).toLocaleString()}
                  </span>
                </div>
              )}

              {/* Last Reading */}
              {eq?.last_reading && (
                <div className="flex items-center justify-between py-3 border-b border-gray-100">
                  <span className="text-sm font-medium text-gray-500">Last Reading</span>
                  <span className="text-sm text-gray-900 font-mono">{eq.last_reading}</span>
                </div>
              )}

              {/* Created At */}
              <div className="flex items-center justify-between py-3 border-b border-gray-100">
                <span className="text-sm font-medium text-gray-500">Created</span>
                <span className="text-sm text-gray-900">
                  {eq?.created_at ? new Date(eq.created_at).toLocaleString() : '-'}
                </span>
              </div>

              {/* Equipment Calibration Section */}
              <div className="py-3 border-b border-gray-100">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-gray-500">Calibration</span>
                  {user?.role === 'admin' && (
                    <button
                      onClick={() => setShowCalibration(!showCalibration)}
                      className="text-sm text-primary-600 hover:text-primary-800 font-medium"
                    >
                      {showCalibration ? 'Hide' : 'Calibrate'}
                    </button>
                  )}
                </div>

                {/* Current calibration values display */}
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="flex items-center justify-between px-2 py-1 bg-gray-50 rounded">
                    <span className="text-gray-500">Offset:</span>
                    <span className="font-mono text-gray-900">{eq?.calibration_offset ?? 0}</span>
                  </div>
                  <div className="flex items-center justify-between px-2 py-1 bg-gray-50 rounded">
                    <span className="text-gray-500">Scale:</span>
                    <span className="font-mono text-gray-900">{eq?.calibration_scale ?? 1}</span>
                  </div>
                </div>

                {/* Calibration form (admin only) */}
                {showCalibration && user?.role === 'admin' && (
                  <div className="mt-4 p-4 bg-blue-50 rounded-lg border border-blue-200">
                    <h4 className="text-sm font-semibold text-blue-900 mb-3 flex items-center">
                      <svg className="h-5 w-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                      Calibration Settings
                    </h4>

                    {/* Calibration Message */}
                    {calibrationMessage && (
                      <div className={`mb-3 p-2 rounded text-sm ${
                        calibrationMessage.type === 'success'
                          ? 'bg-green-50 text-green-800 border border-green-200'
                          : 'bg-red-50 text-red-800 border border-red-200'
                      }`}>
                        {calibrationMessage.text}
                      </div>
                    )}

                    <div className="space-y-3">
                      <div>
                        <label htmlFor="calibration-offset" className="block text-xs font-medium text-blue-800 mb-1">
                          Offset (added to raw value)
                        </label>
                        <input
                          type="number"
                          id="calibration-offset"
                          value={calibrationOffset}
                          onChange={(e) => setCalibrationOffset(e.target.value)}
                          step="0.01"
                          className="w-full px-3 py-2 text-sm border border-blue-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
                          placeholder="0"
                        />
                      </div>

                      <div>
                        <label htmlFor="calibration-scale" className="block text-xs font-medium text-blue-800 mb-1">
                          Scale (multiplied by raw value)
                        </label>
                        <input
                          type="number"
                          id="calibration-scale"
                          value={calibrationScale}
                          onChange={(e) => setCalibrationScale(e.target.value)}
                          step="0.01"
                          className="w-full px-3 py-2 text-sm border border-blue-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
                          placeholder="1"
                        />
                      </div>

                      <p className="text-xs text-blue-700">
                        Formula: <span className="font-mono bg-blue-100 px-1 py-0.5 rounded">calibrated = (raw × scale) + offset</span>
                      </p>

                      <div className="flex gap-2 pt-2">
                        <button
                          onClick={() => setShowCalibration(false)}
                          className="flex-1 px-3 py-2 text-sm text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                          disabled={calibrationLoading}
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleCalibrateSave}
                          disabled={calibrationLoading}
                          className="flex-1 px-3 py-2 text-sm text-white bg-primary-600 rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center"
                        >
                          {calibrationLoading ? (
                            <>
                              <svg className="animate-spin -ml-0.5 mr-1.5 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                              </svg>
                              Saving...
                            </>
                          ) : (
                            'Save Calibration'
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Message for non-admin users */}
                {user?.role !== 'admin' && (
                  <p className="text-xs text-gray-400 mt-1 italic">Calibration settings require admin permissions</p>
                )}
              </div>

              {/* Equipment Control Section */}
              <div className="py-3">
                <span className="text-sm font-medium text-gray-500 block mb-3">Equipment Control</span>

                {/* Control Message */}
                {controlMessage && (
                  <div className={`mb-3 p-2 rounded text-sm ${
                    controlMessage.type === 'success'
                      ? 'bg-green-50 text-green-800 border border-green-200'
                      : 'bg-red-50 text-red-800 border border-red-200'
                  }`}>
                    {controlMessage.text}
                  </div>
                )}

                {canControl ? (
                  <div className="flex gap-3">
                    <button
                      onClick={() => handleControl('on')}
                      disabled={controlLoading}
                      className="flex-1 px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center"
                    >
                      {controlLoading ? (
                        <svg className="animate-spin h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                      ) : (
                        <>
                          <svg className="h-4 w-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                          </svg>
                          Turn On
                        </>
                      )}
                    </button>
                    <button
                      onClick={() => handleControl('off')}
                      disabled={controlLoading}
                      className="flex-1 px-4 py-2 text-sm font-medium text-white bg-gray-600 rounded-lg hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center"
                    >
                      {controlLoading ? (
                        <svg className="animate-spin h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                      ) : (
                        <>
                          <svg className="h-4 w-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                          </svg>
                          Turn Off
                        </>
                      )}
                    </button>
                  </div>
                ) : (
                  <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
                    <div className="flex items-center text-gray-500">
                      <svg className="h-5 w-5 mr-2 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                      </svg>
                      <span className="text-sm">Equipment control requires operator or admin permissions</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Test Connection Section */}
              <div className="py-3 border-t border-gray-200">
                <span className="text-sm font-medium text-gray-500 block mb-3">Connection Test</span>

                {/* Test Connection Result */}
                {testConnectionResult && (
                  <div className={`mb-3 p-3 rounded-lg text-sm ${
                    testConnectionResult.success
                      ? 'bg-green-50 text-green-800 border border-green-200'
                      : 'bg-red-50 text-red-800 border border-red-200'
                  }`}>
                    <div className="flex items-center mb-1">
                      {testConnectionResult.success ? (
                        <svg className="h-4 w-4 mr-2 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      ) : (
                        <svg className="h-4 w-4 mr-2 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      )}
                      <span className="font-medium">{testConnectionResult.message}</span>
                    </div>
                    {testConnectionResult.success && testConnectionResult.latency_ms && (
                      <div className="text-xs text-green-700 ml-6">
                        Latency: {testConnectionResult.latency_ms}ms
                      </div>
                    )}
                    {!testConnectionResult.success && testConnectionResult.error && (
                      <div className="text-xs text-red-700 ml-6">
                        Error: {testConnectionResult.error}
                      </div>
                    )}
                    {testConnectionResult.last_communication && (
                      <div className="text-xs text-green-700 ml-6">
                        Last communication: {new Date(testConnectionResult.last_communication).toLocaleString()}
                      </div>
                    )}
                  </div>
                )}

                {canControl ? (
                  <button
                    onClick={handleTestConnection}
                    disabled={testConnectionLoading}
                    className="w-full px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center"
                  >
                    {testConnectionLoading ? (
                      <>
                        <svg className="animate-spin h-4 w-4 mr-2 text-white" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        Testing Connection...
                      </>
                    ) : (
                      <>
                        <svg className="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0" />
                        </svg>
                        Test Connection
                      </>
                    )}
                  </button>
                ) : (
                  <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
                    <div className="flex items-center text-gray-500">
                      <svg className="h-5 w-5 mr-2 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                      </svg>
                      <span className="text-sm">Connection test requires operator or admin permissions</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : activeTab === 'history' ? (
            /* History Tab */
            <div className="space-y-4">
              {/* Time Range Selector */}
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-700">Time Range</span>
                <select
                  value={timeRange}
                  onChange={(e) => setTimeRange(e.target.value)}
                  className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 focus:ring-primary-500 focus:border-primary-500"
                >
                  <option value="1h">Last Hour</option>
                  <option value="24h">Last 24 Hours</option>
                  <option value="7d">Last 7 Days</option>
                  <option value="30d">Last 30 Days</option>
                </select>
              </div>

              {/* History Loading State */}
              {historyLoading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-600"></div>
                  <span className="ml-3 text-gray-500 text-sm">Loading history...</span>
                </div>
              ) : historyError ? (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                  <div className="flex items-center">
                    <svg className="h-5 w-5 text-red-400 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <span className="text-red-800 text-sm">{historyError}</span>
                  </div>
                  <button
                    onClick={fetchHistory}
                    className="mt-2 text-sm text-red-600 hover:text-red-800 underline"
                  >
                    Try again
                  </button>
                </div>
              ) : historyData.length === 0 ? (
                <div className="text-center py-8">
                  <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                  </svg>
                  <h3 className="mt-2 text-sm font-medium text-gray-900">No readings</h3>
                  <p className="mt-1 text-sm text-gray-500">
                    No historical data available for the selected time range.
                  </p>
                </div>
              ) : (
                <>
                  {/* Export History Button */}
                  <div className="flex justify-end mb-2">
                    <button
                      onClick={() => {
                        // Export history data to CSV
                        const headers = ['Timestamp', 'Value', 'Unit'];
                        const rows = historyData.map(r => [
                          new Date(r.timestamp).toISOString(),
                          r.value || '',
                          r.unit || ''
                        ]);
                        const escapeCSV = (val) => {
                          if (val === null || val === undefined) return '';
                          const str = String(val);
                          if (str.includes(',') || str.includes('"') || str.includes('\n')) {
                            return `"${str.replace(/"/g, '""')}"`;
                          }
                          return str;
                        };
                        const csvContent = [
                          headers.map(escapeCSV).join(','),
                          ...rows.map(row => row.map(escapeCSV).join(','))
                        ].join('\n');
                        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
                        const link = document.createElement('a');
                        const url = URL.createObjectURL(blob);
                        const equipmentName = (details?.name || equipment?.name || 'equipment').replace(/[^a-zA-Z0-9]/g, '_');
                        link.setAttribute('href', url);
                        link.setAttribute('download', `sensor-data-${equipmentName}-${new Date().toISOString().split('T')[0]}.csv`);
                        link.style.visibility = 'hidden';
                        document.body.appendChild(link);
                        link.click();
                        document.body.removeChild(link);
                        URL.revokeObjectURL(url);
                      }}
                      className="bg-gray-600 text-white px-3 py-1.5 rounded-lg hover:bg-gray-700 transition-colors flex items-center text-sm"
                      title="Export history data to CSV"
                    >
                      <svg className="h-4 w-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                      Export History
                    </button>
                  </div>

                  {/* Summary Stats */}
                  <div className="grid grid-cols-3 gap-3 mb-4">
                    <div className="bg-blue-50 rounded-lg p-3 text-center">
                      <div className="text-xs text-blue-600 uppercase font-medium">Readings</div>
                      <div className="text-xl font-bold text-blue-900">{historyData.length}</div>
                    </div>
                    <div className="bg-green-50 rounded-lg p-3 text-center">
                      <div className="text-xs text-green-600 uppercase font-medium">Avg Value</div>
                      <div className="text-xl font-bold text-green-900">
                        {(historyData.reduce((sum, r) => sum + (parseFloat(r.value) || 0), 0) / historyData.length).toFixed(2)}
                      </div>
                    </div>
                    <div className="bg-purple-50 rounded-lg p-3 text-center">
                      <div className="text-xs text-purple-600 uppercase font-medium">Range</div>
                      <div className="text-sm font-bold text-purple-900">
                        {Math.min(...historyData.map(r => parseFloat(r.value) || 0)).toFixed(1)} - {Math.max(...historyData.map(r => parseFloat(r.value) || 0)).toFixed(1)}
                      </div>
                    </div>
                  </div>

                  {/* History Table */}
                  <div className="border border-gray-200 rounded-lg overflow-hidden">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Timestamp</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Value</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Unit</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {historyData.slice(0, 10).map((reading, idx) => (
                          <tr key={reading.id || idx} className="hover:bg-gray-50">
                            <td className="px-4 py-2 text-sm text-gray-900">
                              {new Date(reading.timestamp).toLocaleString()}
                            </td>
                            <td className="px-4 py-2 text-sm font-mono text-gray-900">
                              {reading.value}
                            </td>
                            <td className="px-4 py-2 text-sm text-gray-500">
                              {reading.unit || '-'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {historyData.length > 10 && (
                      <div className="bg-gray-50 px-4 py-2 text-xs text-gray-500 text-center border-t">
                        Showing 10 of {historyData.length} readings
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          ) : activeTab === 'errors' ? (
            /* Error Logs Tab */
            <div className="space-y-4">
              {/* Filter Toggle */}
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-700">Error History</span>
                <label className="flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showResolved}
                    onChange={(e) => setShowResolved(e.target.checked)}
                    className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                  />
                  <span className="ml-2 text-sm text-gray-600">Show resolved</span>
                </label>
              </div>

              {/* Error Logs Loading State */}
              {errorLogsLoading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-600"></div>
                  <span className="ml-3 text-gray-500 text-sm">Loading error logs...</span>
                </div>
              ) : errorLogsError ? (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                  <div className="flex items-center">
                    <svg className="h-5 w-5 text-red-400 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <span className="text-red-800 text-sm">{errorLogsError}</span>
                  </div>
                  <button
                    onClick={fetchErrorLogs}
                    className="mt-2 text-sm text-red-600 hover:text-red-800 underline"
                  >
                    Try again
                  </button>
                </div>
              ) : errorLogs.length === 0 ? (
                <div className="text-center py-8">
                  <svg className="mx-auto h-12 w-12 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <h3 className="mt-2 text-sm font-medium text-gray-900">No errors</h3>
                  <p className="mt-1 text-sm text-gray-500">
                    {showResolved ? 'No error logs found for this equipment.' : 'No active errors for this equipment.'}
                  </p>
                </div>
              ) : (
                <>
                  {/* Summary Stats */}
                  <div className="grid grid-cols-2 gap-3 mb-4">
                    <div className="bg-red-50 rounded-lg p-3 text-center">
                      <div className="text-xs text-red-600 uppercase font-medium">Active</div>
                      <div className="text-xl font-bold text-red-900">
                        {errorLogs.filter(e => !e.resolved).length}
                      </div>
                    </div>
                    <div className="bg-green-50 rounded-lg p-3 text-center">
                      <div className="text-xs text-green-600 uppercase font-medium">Resolved</div>
                      <div className="text-xl font-bold text-green-900">
                        {errorLogs.filter(e => e.resolved).length}
                      </div>
                    </div>
                  </div>

                  {/* Error Logs List */}
                  <div className="space-y-3 max-h-64 overflow-y-auto">
                    {errorLogs.map((errorLog) => (
                      <div
                        key={errorLog.id}
                        className={`border rounded-lg p-3 ${
                          errorLog.resolved
                            ? 'bg-gray-50 border-gray-200'
                            : 'bg-red-50 border-red-200'
                        }`}
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                                errorLog.error_type === 'connection' ? 'bg-orange-100 text-orange-800' :
                                errorLog.error_type === 'timeout' ? 'bg-yellow-100 text-yellow-800' :
                                errorLog.error_type === 'protocol' ? 'bg-blue-100 text-blue-800' :
                                errorLog.error_type === 'validation' ? 'bg-purple-100 text-purple-800' :
                                errorLog.error_type === 'hardware' ? 'bg-red-100 text-red-800' :
                                'bg-gray-100 text-gray-800'
                              }`}>
                                {errorLog.error_type || 'other'}
                              </span>
                              {errorLog.resolved && (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
                                  Resolved
                                </span>
                              )}
                            </div>
                            <p className={`mt-1 text-sm ${errorLog.resolved ? 'text-gray-600' : 'text-gray-900'}`}>
                              {errorLog.message}
                            </p>
                            {errorLog.details && (
                              <p className="mt-1 text-xs text-gray-500 font-mono">{errorLog.details}</p>
                            )}
                            <p className="mt-1 text-xs text-gray-400">
                              {new Date(errorLog.created_at).toLocaleString()}
                              {errorLog.resolved_at && (
                                <span className="ml-2">
                                  • Resolved: {new Date(errorLog.resolved_at).toLocaleString()}
                                </span>
                              )}
                            </p>
                          </div>
                          {!errorLog.resolved && canControl && (
                            <button
                              onClick={() => handleResolveError(errorLog.id)}
                              className="ml-2 px-2 py-1 text-xs text-green-700 bg-green-100 rounded hover:bg-green-200 transition-colors"
                              title="Mark as resolved"
                            >
                              Resolve
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  {errorLogs.length >= 50 && (
                    <div className="text-center text-xs text-gray-500 pt-2">
                      Showing most recent 50 errors
                    </div>
                  )}
                </>
              )}
            </div>
          ) : null}

          {/* Close Button */}
          <div className="mt-6 flex justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Relay Control Modal - Controls Modbus relay devices using coil read/write operations
// Supports write-only mode for devices that can't send Modbus responses (e.g. RS485 DE/RE pin issue)
function RelayControlModal({ isOpen, onClose, equipment, token, user, onUpdate }) {
  const [loading, setLoading] = useState(false);
  const [coilStates, setCoilStates] = useState([]);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState({ connected: false, lastActivity: null });
  const [actionLoading, setActionLoading] = useState({});
  const [lastCommunication, setLastCommunication] = useState(null);
  const [writeOnlyMode, setWriteOnlyMode] = useState(false);

  // Check if user can control equipment (admin or operator only)
  const canControl = user?.role === 'admin' || user?.role === 'operator';

  // Get relay channels from register_mappings (filter for coil types with readwrite access)
  const getRelayChannels = () => {
    if (!equipment?.register_mappings || !Array.isArray(equipment.register_mappings)) {
      return [];
    }
    return equipment.register_mappings
      .filter(mapping => mapping.type === 'coil' && mapping.access === 'readwrite')
      .map((mapping, idx) => ({
        ...mapping,
        index: idx,
        address: parseInt(mapping.register, 10) || idx
      }));
  };

  const relayChannels = getRelayChannels();

  // Parse Modbus connection details from equipment address
  const parseModbusAddress = () => {
    if (!equipment?.address) return null;
    const match = equipment.address.match(/^([^:]+):(\d+)$/);
    if (match) {
      return { host: match[1], port: parseInt(match[2], 10) };
    }
    // Default to port 502 if no port specified
    return { host: equipment.address, port: 502 };
  };

  const modbusConfig = parseModbusAddress();

  // Fetch current coil states when modal opens
  useEffect(() => {
    if (isOpen && equipment && relayChannels.length > 0) {
      fetchCoilStates();
    }
  }, [isOpen, equipment]);

  // Fetch current states of all relay coils
  const fetchCoilStates = async () => {
    if (!equipment || relayChannels.length === 0) return;

    setLoading(true);
    setError(null);

    // Check if device is write-only
    const isWriteOnly = !!equipment.write_only;
    setWriteOnlyMode(isWriteOnly);

    if (isWriteOnly) {
      // For write-only devices, load cached states from the API
      try {
        const response = await fetch(`/api/equipment/${equipment.id}/relay/state`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (response.ok) {
          const data = await response.json();
          setCoilStates(data.channels.map(ch => ({
            ...ch,
            register: String(ch.address),
            type: 'coil',
            access: 'readwrite'
          })));
          setConnectionStatus({ connected: true, lastActivity: Date.now() });
          setLastCommunication(new Date());
        } else {
          // Fallback: initialize all as OFF
          setCoilStates(relayChannels.map(c => ({ ...c, state: false })));
          setConnectionStatus({ connected: true, lastActivity: Date.now() });
        }
      } catch (err) {
        setCoilStates(relayChannels.map(c => ({ ...c, state: false })));
        setConnectionStatus({ connected: true, lastActivity: Date.now() });
      }
      setLoading(false);
      return;
    }

    // Normal mode: read coil states via Modbus
    if (!modbusConfig) { setLoading(false); return; }
    try {
      const minAddress = Math.min(...relayChannels.map(c => c.address));
      const maxAddress = Math.max(...relayChannels.map(c => c.address));
      const quantity = maxAddress - minAddress + 1;

      const response = await fetch('/api/modbus/read/coils', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          host: modbusConfig.host,
          port: modbusConfig.port,
          unitId: equipment.slave_id || 1,
          address: minAddress,
          quantity: quantity
        })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to read coil states');
      }

      const result = await response.json();

      // Map the returned coil states to our channel structure
      const states = relayChannels.map(channel => {
        const offset = channel.address - minAddress;
        return {
          ...channel,
          state: result.data[offset] || false
        };
      });

      setCoilStates(states);
      setLastCommunication(new Date());
      setConnectionStatus({ connected: true, lastActivity: Date.now() });
    } catch (err) {
      console.error('Failed to fetch coil states:', err);
      setError(err.message);
      setConnectionStatus({ connected: false, lastActivity: null });
      // Initialize with unknown states
      setCoilStates(relayChannels.map(c => ({ ...c, state: false })));
    } finally {
      setLoading(false);
    }
  };

  // Write single coil — uses equipment relay API for write-only, direct Modbus for normal
  const handleToggleRelay = async (channel) => {
    if (!canControl) return;

    setActionLoading(prev => ({ ...prev, [channel.address]: true }));
    setMessage(null);

    try {
      const newState = !channel.state;
      let response;

      if (writeOnlyMode) {
        // Use equipment relay control API (handles write-only mode server-side)
        response = await fetch(`/api/equipment/${equipment.id}/relay/control`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ channel: channel.address, state: newState })
        });
      } else {
        // Direct Modbus write
        response = await fetch('/api/modbus/write/coil', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            host: modbusConfig.host,
            port: modbusConfig.port,
            unitId: equipment.slave_id || 1,
            address: channel.address,
            value: newState
          })
        });
      }

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to write coil');
      }

      // Update local state
      setCoilStates(prev => prev.map(c =>
        c.address === channel.address ? { ...c, state: newState } : c
      ));

      const confirmText = writeOnlyMode ? ' (command sent)' : '';
      setMessage({ type: 'success', text: `${channel.name} turned ${newState ? 'ON' : 'OFF'}${confirmText}` });
      setLastCommunication(new Date());
      setConnectionStatus({ connected: true, lastActivity: Date.now() });

      // Clear message after delay
      setTimeout(() => setMessage(null), 2000);

      // Notify parent to refresh
      if (onUpdate) onUpdate();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
      if (!writeOnlyMode) setConnectionStatus({ connected: false, lastActivity: null });
    } finally {
      setActionLoading(prev => ({ ...prev, [channel.address]: false }));
    }
  };

  // All On
  const handleAllOn = async () => {
    if (!canControl || coilStates.length === 0) return;

    setActionLoading(prev => ({ ...prev, allOn: true }));
    setMessage(null);

    try {
      let response;

      if (writeOnlyMode) {
        response = await fetch(`/api/equipment/${equipment.id}/relay/all`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ state: true })
        });
      } else {
        const minAddress = Math.min(...coilStates.map(c => c.address));
        const maxAddress = Math.max(...coilStates.map(c => c.address));
        const values = new Array(maxAddress - minAddress + 1).fill(true);

        response = await fetch('/api/modbus/write/coils', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            host: modbusConfig.host,
            port: modbusConfig.port,
            unitId: equipment.slave_id || 1,
            address: minAddress,
            values: values
          })
        });
      }

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to write coils');
      }

      // Update all local states to ON
      setCoilStates(prev => prev.map(c => ({ ...c, state: true })));

      setMessage({ type: 'success', text: 'All relays turned ON' });
      setLastCommunication(new Date());
      setConnectionStatus({ connected: true, lastActivity: Date.now() });

      setTimeout(() => setMessage(null), 2000);
      if (onUpdate) onUpdate();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
      if (!writeOnlyMode) setConnectionStatus({ connected: false, lastActivity: null });
    } finally {
      setActionLoading(prev => ({ ...prev, allOn: false }));
    }
  };

  // All Off
  const handleAllOff = async () => {
    if (!canControl || coilStates.length === 0) return;

    setActionLoading(prev => ({ ...prev, allOff: true }));
    setMessage(null);

    try {
      let response;

      if (writeOnlyMode) {
        response = await fetch(`/api/equipment/${equipment.id}/relay/all`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ state: false })
        });
      } else {
        const minAddress = Math.min(...coilStates.map(c => c.address));
        const maxAddress = Math.max(...coilStates.map(c => c.address));
        const values = new Array(maxAddress - minAddress + 1).fill(false);

        response = await fetch('/api/modbus/write/coils', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            host: modbusConfig.host,
            port: modbusConfig.port,
            unitId: equipment.slave_id || 1,
            address: minAddress,
            values: values
          })
        });
      }

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to write coils');
      }

      // Update all local states to OFF
      setCoilStates(prev => prev.map(c => ({ ...c, state: false })));

      setMessage({ type: 'success', text: 'All relays turned OFF' });
      setLastCommunication(new Date());
      setConnectionStatus({ connected: true, lastActivity: Date.now() });

      setTimeout(() => setMessage(null), 2000);
      if (onUpdate) onUpdate();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
      if (!writeOnlyMode) setConnectionStatus({ connected: false, lastActivity: null });
    } finally {
      setActionLoading(prev => ({ ...prev, allOff: false }));
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0">
        {/* Backdrop */}
        <div
          className="fixed inset-0 transition-opacity bg-gray-500 bg-opacity-75"
          onClick={onClose}
        ></div>

        {/* Modal */}
        <div className="inline-block w-full max-w-lg p-6 my-8 overflow-hidden text-left align-middle transition-all transform bg-white shadow-xl rounded-lg relative">
          {/* Close button */}
          <button
            onClick={onClose}
            className="absolute top-4 right-4 text-gray-400 hover:text-gray-600"
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          {/* Header */}
          <div className="flex items-start mb-6">
            <div className="flex-shrink-0 h-12 w-12 bg-amber-100 rounded-lg flex items-center justify-center mr-4">
              <svg className="h-7 w-7 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-lg font-semibold text-gray-900 truncate">
                Relay Control
              </h3>
              <p className="text-sm text-gray-500">{equipment?.name || 'Modbus Relay Device'}</p>
            </div>
          </div>

          {/* Connection Status */}
          <div className="mb-4 p-3 rounded-lg border border-gray-200 bg-gray-50">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className={`w-2.5 h-2.5 rounded-full ${connectionStatus.connected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}></span>
                <span className={`text-sm font-medium ${connectionStatus.connected ? 'text-green-700' : 'text-red-700'}`}>
                  {connectionStatus.connected ? 'Connected' : 'Disconnected'}
                </span>
                {writeOnlyMode && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">
                    Write-Only
                  </span>
                )}
              </div>
              <button
                onClick={fetchCoilStates}
                disabled={loading}
                className="text-sm text-primary-600 hover:text-primary-800 disabled:opacity-50 flex items-center gap-1"
              >
                <svg className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Refresh
              </button>
            </div>
            {writeOnlyMode && (
              <p className="text-xs text-amber-600 mt-1">
                Device cannot send responses. States shown are expected values from last commands sent.
              </p>
            )}
            {lastCommunication && (
              <p className="text-xs text-gray-500 mt-1">
                Last communication: {lastCommunication.toLocaleString()}
              </p>
            )}
            {modbusConfig && (
              <p className="text-xs text-gray-400 mt-1 font-mono">
                {modbusConfig.host}:{modbusConfig.port} (Unit ID: {equipment?.slave_id || 1})
              </p>
            )}
          </div>

          {/* Message */}
          {message && (
            <div className={`mb-4 p-3 rounded-lg text-sm ${
              message.type === 'success'
                ? 'bg-green-50 text-green-800 border border-green-200'
                : 'bg-red-50 text-red-800 border border-red-200'
            }`}>
              <div className="flex items-center">
                {message.type === 'success' ? (
                  <svg className="h-4 w-4 mr-2 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg className="h-4 w-4 mr-2 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                )}
                {message.text}
              </div>
            </div>
          )}

          {/* Error */}
          {error && !message && (
            <div className="mb-4 p-3 rounded-lg bg-red-50 text-red-800 border border-red-200 text-sm">
              <div className="flex items-center">
                <svg className="h-4 w-4 mr-2 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {error}
              </div>
            </div>
          )}

          {/* Loading State */}
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
              <span className="ml-3 text-gray-500">Reading relay states...</span>
            </div>
          ) : relayChannels.length === 0 ? (
            <div className="text-center py-8">
              <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              <h3 className="mt-2 text-sm font-medium text-gray-900">No relay channels configured</h3>
              <p className="mt-1 text-sm text-gray-500">
                This device doesn't have any coil mappings configured for relay control.
              </p>
            </div>
          ) : (
            <>
              {/* Quick Actions */}
              {canControl && (
                <div className="mb-4 flex gap-3">
                  <button
                    onClick={handleAllOn}
                    disabled={actionLoading.allOn || actionLoading.allOff}
                    className="flex-1 px-4 py-2.5 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center"
                  >
                    {actionLoading.allOn ? (
                      <svg className="animate-spin h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                    ) : (
                      <>
                        <svg className="h-4 w-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                        All On
                      </>
                    )}
                  </button>
                  <button
                    onClick={handleAllOff}
                    disabled={actionLoading.allOn || actionLoading.allOff}
                    className="flex-1 px-4 py-2.5 text-sm font-medium text-white bg-gray-600 rounded-lg hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center"
                  >
                    {actionLoading.allOff ? (
                      <svg className="animate-spin h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                    ) : (
                      <>
                        <svg className="h-4 w-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                        </svg>
                        All Off
                      </>
                    )}
                  </button>
                </div>
              )}

              {/* Relay Channels Grid */}
              <div className="space-y-2 max-h-80 overflow-y-auto">
                {coilStates.map((channel) => (
                  <div
                    key={channel.address}
                    className={`flex items-center justify-between p-3 rounded-lg border ${
                      channel.state
                        ? 'bg-green-50 border-green-200'
                        : 'bg-gray-50 border-gray-200'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      {/* State indicator */}
                      <div className={`w-3 h-3 rounded-full ${
                        channel.state ? 'bg-green-500 shadow-sm shadow-green-500' : 'bg-gray-400'
                      }`}></div>
                      <div>
                        <div className="font-medium text-gray-900">{channel.name}</div>
                        <div className="text-xs text-gray-500">Address: {channel.address}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`text-sm font-medium px-2 py-0.5 rounded ${
                        channel.state
                          ? 'bg-green-100 text-green-800'
                          : 'bg-gray-200 text-gray-600'
                      }`}>
                        {channel.state ? 'ON' : 'OFF'}
                      </span>
                      {canControl ? (
                        <button
                          onClick={() => handleToggleRelay(channel)}
                          disabled={actionLoading[channel.address]}
                          className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:opacity-50 ${
                            channel.state ? 'bg-green-500' : 'bg-gray-300'
                          }`}
                          role="switch"
                          aria-checked={channel.state}
                        >
                          {actionLoading[channel.address] ? (
                            <span className="absolute inset-0 flex items-center justify-center">
                              <svg className="animate-spin h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                              </svg>
                            </span>
                          ) : (
                            <span
                              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                                channel.state ? 'translate-x-5' : 'translate-x-0'
                              }`}
                            />
                          )}
                        </button>
                      ) : (
                        <span className="text-xs text-gray-400 italic">View only</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Close Button */}
          <div className="mt-6 flex justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Slave ID Scanner Modal - Scans for Modbus RTU devices behind a TCP gateway
function SlaveIdScannerModal({
  isOpen,
  onClose,
  config,
  onConfigChange,
  progress,
  results,
  selectedSlaves,
  onSelectedSlavesChange,
  onScan,
  onCreateEquipment
}) {
  if (!isOpen) return null;

  const handleConfigChange = (field, value) => {
    onConfigChange({ ...config, [field]: value });
  };

  const handleSelectAll = () => {
    if (results?.discovered?.length > 0) {
      if (selectedSlaves.length === results.discovered.length) {
        onSelectedSlavesChange([]);
      } else {
        onSelectedSlavesChange(results.discovered.map(d => d.slaveId));
      }
    }
  };

  const handleSlaveToggle = (slaveId) => {
    if (selectedSlaves.includes(slaveId)) {
      onSelectedSlavesChange(selectedSlaves.filter(id => id !== slaveId));
    } else {
      onSelectedSlavesChange([...selectedSlaves, slaveId]);
    }
  };

  const isScanning = progress !== null && progress < 100;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-3xl w-full mx-4 max-h-[90vh] overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">
            Modbus Slave ID Scanner
          </h2>
          <button
            onClick={onClose}
            disabled={isScanning}
            className="text-gray-500 hover:text-gray-700 disabled:opacity-50"
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-4 overflow-y-auto max-h-[70vh]">
          <div className="mb-6">
            <h3 className="text-sm font-medium text-gray-700 mb-3">Scan Configuration</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <div>
                <label htmlFor="scan-host" className="block text-xs font-medium text-gray-500 mb-1">Host IP Address</label>
                <input type="text" id="scan-host" value={config.host} onChange={(e) => handleConfigChange('host', e.target.value)} placeholder="192.168.1.100" disabled={isScanning} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-primary-500 focus:border-primary-500 disabled:bg-gray-100" />
              </div>
              <div>
                <label htmlFor="scan-port" className="block text-xs font-medium text-gray-500 mb-1">TCP Port</label>
                <input type="number" id="scan-port" value={config.port} onChange={(e) => handleConfigChange('port', e.target.value)} placeholder="502" min="1" max="65535" disabled={isScanning} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-primary-500 focus:border-primary-500 disabled:bg-gray-100" />
              </div>
              <div>
                <label htmlFor="scan-timeout" className="block text-xs font-medium text-gray-500 mb-1">Timeout (ms)</label>
                <input type="number" id="scan-timeout" value={config.timeout} onChange={(e) => handleConfigChange('timeout', e.target.value)} placeholder="500" min="100" max="5000" disabled={isScanning} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-primary-500 focus:border-primary-500 disabled:bg-gray-100" />
              </div>
              <div>
                <label htmlFor="scan-start" className="block text-xs font-medium text-gray-500 mb-1">Start Slave ID</label>
                <input type="number" id="scan-start" value={config.startSlaveId} onChange={(e) => handleConfigChange('startSlaveId', e.target.value)} placeholder="1" min="1" max="247" disabled={isScanning} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-primary-500 focus:border-primary-500 disabled:bg-gray-100" />
              </div>
              <div>
                <label htmlFor="scan-end" className="block text-xs font-medium text-gray-500 mb-1">End Slave ID</label>
                <input type="number" id="scan-end" value={config.endSlaveId} onChange={(e) => handleConfigChange('endSlaveId', e.target.value)} placeholder="247" min="1" max="247" disabled={isScanning} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-primary-500 focus:border-primary-500 disabled:bg-gray-100" />
              </div>
            </div>
            <p className="mt-2 text-xs text-gray-500">Scans for Modbus RTU devices connected to a TCP gateway (e.g., USR-DR134).</p>
          </div>

          {progress !== null && (
            <div className="mb-6">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-700">{isScanning ? 'Scanning...' : 'Scan Complete'}</span>
                <span className="text-sm text-gray-500">{Math.round(progress)}%</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div className={`h-2 rounded-full transition-all duration-300 ${isScanning ? 'bg-primary-600' : 'bg-green-600'}`} style={{ width: `${progress}%` }}></div>
              </div>
            </div>
          )}

          {results && (
            <div className="mb-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-gray-700">Discovered Devices ({results.discovered?.length || 0})</h3>
                {results.discovered?.length > 0 && (
                  <button onClick={handleSelectAll} className="text-sm text-primary-600 hover:text-primary-700">{selectedSlaves.length === results.discovered.length ? 'Deselect All' : 'Select All'}</button>
                )}
              </div>
              {results.discovered?.length === 0 ? (
                <div className="text-center py-8 bg-gray-50 rounded-lg">
                  <svg className="mx-auto h-10 w-10 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  <p className="mt-2 text-sm text-gray-500">No responding devices found in the scanned range.</p>
                </div>
              ) : (
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Select</th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Slave ID</th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Response Time</th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Sample Data</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {results.discovered.map((device) => (
                        <tr key={device.slaveId} className={`hover:bg-gray-50 cursor-pointer ${selectedSlaves.includes(device.slaveId) ? 'bg-primary-50' : ''}`} onClick={() => handleSlaveToggle(device.slaveId)}>
                          <td className="px-4 py-3"><input type="checkbox" checked={selectedSlaves.includes(device.slaveId)} onChange={() => {}} className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded" /></td>
                          <td className="px-4 py-3 text-sm font-medium text-gray-900">{device.slaveId}</td>
                          <td className="px-4 py-3 text-sm text-gray-500">{device.responseTime}ms</td>
                          <td className="px-4 py-3 text-sm text-gray-500 font-mono">{device.sampleData ? `[${device.sampleData.slice(0, 3).join(', ')}...]` : '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-between items-center p-4 border-t border-gray-200 bg-gray-50">
          <button onClick={onClose} disabled={isScanning} className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50">Close</button>
          <div className="flex gap-3">
            {results?.discovered?.length > 0 && selectedSlaves.length > 0 && (
              <button onClick={onCreateEquipment} className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors flex items-center">
                <svg className="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                Add {selectedSlaves.length} Device{selectedSlaves.length > 1 ? 's' : ''}
              </button>
            )}
            <button onClick={onScan} disabled={isScanning || !config.host} className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center">
              {isScanning ? (
                <><svg className="animate-spin h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>Scanning...</>
              ) : (
                <><svg className="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>Start Scan</>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Discovered Devices Modal - Shows devices found during network scan
function DiscoveredDevicesModal({ isOpen, onClose, devices, onAddDevice, addingDevice }) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[80vh] overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">
            Discovered Modbus TCP Devices
          </h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700"
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-4 overflow-y-auto max-h-[60vh]">
          {devices.length === 0 ? (
            <p className="text-center text-gray-500 py-8">
              No new Modbus devices discovered on the network.
            </p>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-gray-600 mb-4">
                Found {devices.length} Modbus TCP device(s) on the network. Click "Add" to add them to your equipment list.
              </p>

              {devices.map((device) => (
                <div
                  key={device.address}
                  className="border border-gray-200 rounded-lg p-4 hover:border-primary-300 transition-colors"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <h3 className="font-medium text-gray-900">
                        {device.suggestedName}
                      </h3>
                      <p className="text-sm text-gray-500 mt-1">
                        Address: <span className="font-mono">{device.address}</span>
                      </p>
                      {device.deviceInfo && Object.keys(device.deviceInfo).length > 0 && (
                        <div className="mt-2 text-xs text-gray-500">
                          {device.deviceInfo.VendorName && (
                            <p>Vendor: {device.deviceInfo.VendorName}</p>
                          )}
                          {device.deviceInfo.ProductName && (
                            <p>Product: {device.deviceInfo.ProductName}</p>
                          )}
                          {device.deviceInfo.MajorMinorRevision && (
                            <p>Version: {device.deviceInfo.MajorMinorRevision}</p>
                          )}
                        </div>
                      )}
                      <div className="mt-2 flex items-center">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                          device.responsive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                        }`}>
                          {device.responsive ? 'Responsive' : 'Detected'}
                        </span>
                        <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">
                          Port {device.port}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={() => onAddDevice(device)}
                      disabled={addingDevice === device.address}
                      className="ml-4 bg-primary-600 text-white px-4 py-2 rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                    >
                      {addingDevice === device.address ? (
                        <>
                          <svg className="animate-spin h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                          Adding...
                        </>
                      ) : (
                        <>
                          <svg className="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                          </svg>
                          Add
                        </>
                      )}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end p-4 border-t border-gray-200 bg-gray-50">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// Add Equipment Modal
function AddEquipmentModal({ isOpen, onClose, onSuccess, token }) {
  const initialFormData = {
    name: '',
    description: '',
    type: '',
    protocol: 'modbus',
    address: '',
    slave_id: '',
    polling_interval_ms: '1000',
    register_mappings: []
  };
  const [formData, setFormData] = useState(initialFormData);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);
  const [retryFn, setRetryFn] = useState(null);
  const [showModbusConfig, setShowModbusConfig] = useState(true);
  // Ref to track submission state synchronously for double-click protection
  const isSubmittingRef = React.useRef(false);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    // Update Modbus config visibility when protocol changes
    if (name === 'protocol') {
      setShowModbusConfig(value === 'modbus');
    }
  };

  const handleReset = () => {
    setFormData(initialFormData);
    setError(null);
    setSuccessMessage(null);
    setRetryFn(null);
    setShowModbusConfig(true);
  };

  // Handle adding a new register mapping
  const handleAddRegisterMapping = () => {
    setFormData(prev => ({
      ...prev,
      register_mappings: [...prev.register_mappings, {
        name: '',
        register: '',
        type: 'holding',
        dataType: 'uint16',
        access: 'read'
      }]
    }));
  };

  // Handle updating a register mapping
  const handleUpdateRegisterMapping = (index, field, value) => {
    setFormData(prev => {
      const updated = [...prev.register_mappings];
      updated[index] = { ...updated[index], [field]: value };
      return { ...prev, register_mappings: updated };
    });
  };

  // Handle removing a register mapping
  const handleRemoveRegisterMapping = (index) => {
    setFormData(prev => ({
      ...prev,
      register_mappings: prev.register_mappings.filter((_, i) => i !== index)
    }));
  };

  // Handle loading a preset template
  const handleLoadPreset = (presetKey) => {
    if (!presetKey || !REGISTER_PRESETS[presetKey]) return;
    const preset = REGISTER_PRESETS[presetKey];
    setFormData(prev => ({
      ...prev,
      register_mappings: [...preset.mappings]
    }));
  };

  // Handle exporting register mappings as JSON
  const handleExportMappings = () => {
    if (formData.register_mappings.length === 0) return;
    const exportData = {
      version: '1.0',
      exported_at: new Date().toISOString(),
      mappings: formData.register_mappings
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `register-mappings-${formData.name || 'export'}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Handle importing register mappings from JSON file
  const fileInputRef = React.useRef(null);
  const handleImportMappings = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const importData = JSON.parse(e.target.result);
        // Support both direct array and wrapped format
        const mappings = Array.isArray(importData) ? importData : importData.mappings;
        if (Array.isArray(mappings)) {
          // Validate mapping structure
          const validMappings = mappings.filter(m =>
            typeof m === 'object' && m.name && m.register !== undefined
          ).map(m => ({
            name: m.name || '',
            register: String(m.register || ''),
            type: m.type || 'holding',
            dataType: m.dataType || 'uint16',
            access: m.access || 'read'
          }));
          setFormData(prev => ({
            ...prev,
            register_mappings: validMappings
          }));
        } else {
          console.error('Invalid register mappings format');
        }
      } catch (err) {
        console.error('Failed to parse imported file:', err);
      }
    };
    reader.readAsText(file);
    // Reset file input so the same file can be selected again
    event.target.value = '';
  };

  const handleSubmit = async (e) => {
    if (e) e.preventDefault();

    // Double-click protection: use ref to check synchronously
    if (isSubmittingRef.current || saving) return;
    isSubmittingRef.current = true;

    setError(null);
    setSuccessMessage(null);
    setRetryFn(null);

    if (!formData.name.trim()) {
      isSubmittingRef.current = false;
      setError({ message: 'Name is required', canRetry: false });
      return;
    }

    setSaving(true);

    try {
      // Prepare Modbus-specific fields only if protocol is modbus
      const modbusFields = formData.protocol === 'modbus' ? {
        slave_id: formData.slave_id ? parseInt(formData.slave_id) : null,
        polling_interval_ms: formData.polling_interval_ms ? parseInt(formData.polling_interval_ms) : 1000,
        register_mappings: formData.register_mappings.length > 0 ? formData.register_mappings : null
      } : {};

      const response = await fetch(`${API_BASE}/equipment`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: formData.name.trim(),
          description: formData.description.trim(),
          type: formData.type.trim(),
          protocol: formData.protocol,
          address: formData.address.trim(),
          ...modbusFields
        })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Failed to create equipment');
      }

      const newEquipment = await response.json();
      setSuccessMessage(`Equipment "${newEquipment.name}" created successfully!`);

      // Reset form
      setFormData({
        name: '',
        description: '',
        type: '',
        protocol: 'modbus',
        address: '',
        slave_id: '',
        polling_interval_ms: '1000',
        register_mappings: []
      });
      setShowModbusConfig(true);

      // Notify parent and close after a brief delay
      setTimeout(() => {
        onSuccess(newEquipment);
        onClose();
        setSuccessMessage(null);
      }, 1500);

    } catch (err) {
      const friendlyError = getUserFriendlyError(err, 'saving equipment');
      setError(friendlyError);
      // Store retry function if error is retryable
      if (friendlyError.canRetry) {
        setRetryFn(() => () => handleSubmit());
      }
    } finally {
      setSaving(false);
      isSubmittingRef.current = false;
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0">
        {/* Backdrop */}
        <div
          className="fixed inset-0 transition-opacity bg-gray-500 bg-opacity-75"
          onClick={onClose}
        ></div>

        {/* Modal */}
        <div className="inline-block w-full max-w-md p-6 my-8 overflow-hidden text-left align-middle transition-all transform bg-white shadow-xl rounded-lg relative">
          {/* Close button */}
          <button
            onClick={onClose}
            className="absolute top-4 right-4 text-gray-400 hover:text-gray-600"
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            Add New Equipment
          </h3>

          {/* Success Message */}
          {successMessage && (
            <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg">
              <div className="flex items-center">
                <svg className="h-5 w-5 text-green-500 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <span className="text-green-800 text-sm">{successMessage}</span>
              </div>
            </div>
          )}

          {/* Error Message with retry option */}
          {error && (
            <ErrorMessage
              message={typeof error === 'string' ? error : error.message}
              canRetry={error.canRetry}
              onRetry={retryFn}
              isNetworkError={error.isNetworkError}
              className="mb-4"
            />
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Name */}
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">
                Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                id="name"
                name="name"
                value={formData.name}
                onChange={handleChange}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
                placeholder="e.g., Temperature Sensor 001"
                required
              />
            </div>

            {/* Description */}
            <div>
              <label htmlFor="description" className="block text-sm font-medium text-gray-700 mb-1">
                Description
              </label>
              <textarea
                id="description"
                name="description"
                value={formData.description}
                onChange={handleChange}
                rows={2}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
                placeholder="Optional description"
              />
            </div>

            {/* Type */}
            <div>
              <label htmlFor="type" className="block text-sm font-medium text-gray-700 mb-1">
                Type
              </label>
              <input
                type="text"
                id="type"
                name="type"
                value={formData.type}
                onChange={handleChange}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
                placeholder="e.g., Temperature Sensor, Relay, Controller"
              />
            </div>

            {/* Protocol */}
            <div>
              <label htmlFor="protocol" className="block text-sm font-medium text-gray-700 mb-1">
                Protocol
              </label>
              <select
                id="protocol"
                name="protocol"
                value={formData.protocol}
                onChange={handleChange}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
              >
                <option value="modbus">Modbus</option>
                <option value="mqtt">MQTT</option>
                <option value="zigbee">Zigbee</option>
                <option value="zwave">Z-Wave</option>
                <option value="other">Other</option>
              </select>
            </div>

            {/* Connection Address */}
            <div>
              <label htmlFor="address" className="block text-sm font-medium text-gray-700 mb-1">
                Connection Address
              </label>
              <input
                type="text"
                id="address"
                name="address"
                value={formData.address}
                onChange={handleChange}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
                placeholder="e.g., 192.168.1.100:502 or /dev/ttyUSB0"
              />
            </div>

            {/* Modbus Configuration Section */}
            {showModbusConfig && (
              <div className="border-t border-gray-200 pt-4 mt-4">
                <h4 className="text-sm font-semibold text-gray-900 mb-3 flex items-center">
                  <svg className="w-4 h-4 mr-2 text-primary-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  Modbus Configuration
                </h4>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="slave_id" className="block text-sm font-medium text-gray-700 mb-1">
                      Slave ID (1-247)
                    </label>
                    <input
                      type="number"
                      id="slave_id"
                      name="slave_id"
                      min="1"
                      max="247"
                      value={formData.slave_id}
                      onChange={handleChange}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
                      placeholder="e.g., 1"
                    />
                  </div>

                  <div>
                    <label htmlFor="polling_interval_ms" className="block text-sm font-medium text-gray-700 mb-1">
                      Polling Interval (ms)
                    </label>
                    <input
                      type="number"
                      id="polling_interval_ms"
                      name="polling_interval_ms"
                      min="100"
                      max="60000"
                      step="100"
                      value={formData.polling_interval_ms}
                      onChange={handleChange}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
                      placeholder="1000"
                    />
                  </div>
                </div>

                <div className="mt-4">
                  <div className="flex justify-between items-center mb-2">
                    <label className="block text-sm font-medium text-gray-700">
                      Register Mappings
                    </label>
                    <div className="flex items-center gap-2">
                      {/* Preset Templates Dropdown */}
                      <select
                        onChange={(e) => {
                          handleLoadPreset(e.target.value);
                          e.target.value = '';
                        }}
                        className="text-xs px-2 py-1 border border-gray-300 rounded focus:ring-primary-500 focus:border-primary-500"
                      >
                        <option value="">Load Preset...</option>
                        {Object.entries(REGISTER_PRESETS).map(([key, preset]) => (
                          <option key={key} value={key}>{preset.name}</option>
                        ))}
                      </select>
                      {/* Import Button */}
                      <input
                        type="file"
                        ref={fileInputRef}
                        onChange={handleImportMappings}
                        accept=".json"
                        className="hidden"
                      />
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="text-xs text-gray-600 hover:text-gray-800 px-2 py-1 border border-gray-300 rounded hover:bg-gray-50"
                        title="Import from JSON"
                      >
                        Import
                      </button>
                      {/* Export Button */}
                      <button
                        type="button"
                        onClick={handleExportMappings}
                        disabled={formData.register_mappings.length === 0}
                        className="text-xs text-gray-600 hover:text-gray-800 px-2 py-1 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                        title="Export to JSON"
                      >
                        Export
                      </button>
                      {/* Add Register Button */}
                      <button
                        type="button"
                        onClick={handleAddRegisterMapping}
                        className="text-sm text-primary-600 hover:text-primary-700 font-medium flex items-center"
                      >
                        <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                        </svg>
                        Add
                      </button>
                    </div>
                  </div>

                  {formData.register_mappings.length === 0 ? (
                    <p className="text-sm text-gray-500 italic">No register mappings defined. Use a preset template, import from JSON, or click "Add" to configure manually.</p>
                  ) : (
                    <div className="space-y-3 max-h-48 overflow-y-auto">
                      {formData.register_mappings.map((mapping, index) => (
                        <div key={index} className="bg-gray-50 p-3 rounded-lg border border-gray-200">
                          <div className="flex justify-between items-start mb-2">
                            <span className="text-xs font-medium text-gray-500">Register #{index + 1}</span>
                            <button
                              type="button"
                              onClick={() => handleRemoveRegisterMapping(index)}
                              className="text-red-500 hover:text-red-700"
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <input
                              type="text"
                              placeholder="Name"
                              value={mapping.name}
                              onChange={(e) => handleUpdateRegisterMapping(index, 'name', e.target.value)}
                              className="px-2 py-1 text-sm border border-gray-300 rounded focus:ring-primary-500 focus:border-primary-500"
                            />
                            <input
                              type="number"
                              placeholder="Register #"
                              value={mapping.register}
                              onChange={(e) => handleUpdateRegisterMapping(index, 'register', e.target.value)}
                              className="px-2 py-1 text-sm border border-gray-300 rounded focus:ring-primary-500 focus:border-primary-500"
                            />
                            <select
                              value={mapping.type}
                              onChange={(e) => handleUpdateRegisterMapping(index, 'type', e.target.value)}
                              className="px-2 py-1 text-sm border border-gray-300 rounded focus:ring-primary-500 focus:border-primary-500"
                            >
                              <option value="holding">Holding Register</option>
                              <option value="input">Input Register</option>
                              <option value="coil">Coil</option>
                              <option value="discrete">Discrete Input</option>
                            </select>
                            <select
                              value={mapping.dataType}
                              onChange={(e) => handleUpdateRegisterMapping(index, 'dataType', e.target.value)}
                              className="px-2 py-1 text-sm border border-gray-300 rounded focus:ring-primary-500 focus:border-primary-500"
                            >
                              <option value="uint16">UInt16</option>
                              <option value="int16">Int16</option>
                              <option value="uint32">UInt32</option>
                              <option value="int32">Int32</option>
                              <option value="float32">Float32</option>
                              <option value="bool">Boolean</option>
                            </select>
                          </div>
                          <div className="mt-2">
                            <select
                              value={mapping.access}
                              onChange={(e) => handleUpdateRegisterMapping(index, 'access', e.target.value)}
                              className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-primary-500 focus:border-primary-500"
                            >
                              <option value="read">Read Only</option>
                              <option value="write">Write Only</option>
                              <option value="readwrite">Read/Write</option>
                            </select>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Buttons */}
            <div className="flex justify-end gap-3 pt-4">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
                disabled={saving}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleReset}
                className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
                disabled={saving}
              >
                Reset
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                disabled={saving}
              >
                {saving ? (
                  <>
                    <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Saving...
                  </>
                ) : (
                  'Add Equipment'
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

// Edit Equipment Modal
function EditEquipmentModal({ isOpen, onClose, equipment, onSuccess, token }) {
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    type: '',
    protocol: 'modbus',
    address: '',
    slave_id: '',
    polling_interval_ms: '1000',
    register_mappings: []
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);
  const [retryFn, setRetryFn] = useState(null);
  const [showModbusConfig, setShowModbusConfig] = useState(true);
  // Ref to track submission state synchronously for double-click protection
  const isSubmittingRef = React.useRef(false);

  // Initialize form data when equipment changes
  useEffect(() => {
    if (equipment) {
      setFormData({
        name: equipment.name || '',
        description: equipment.description || '',
        type: equipment.type || '',
        protocol: equipment.protocol || 'modbus',
        address: equipment.address || '',
        slave_id: equipment.slave_id !== null && equipment.slave_id !== undefined ? String(equipment.slave_id) : '',
        polling_interval_ms: equipment.polling_interval_ms ? String(equipment.polling_interval_ms) : '1000',
        register_mappings: Array.isArray(equipment.register_mappings) ? equipment.register_mappings : []
      });
      setShowModbusConfig(equipment.protocol === 'modbus');
      setError(null);
      setSuccessMessage(null);
      setRetryFn(null);
      isSubmittingRef.current = false;
    }
  }, [equipment]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    // Update Modbus config visibility when protocol changes
    if (name === 'protocol') {
      setShowModbusConfig(value === 'modbus');
    }
  };

  // Handle adding a new register mapping
  const handleAddRegisterMapping = () => {
    setFormData(prev => ({
      ...prev,
      register_mappings: [...prev.register_mappings, {
        name: '',
        register: '',
        type: 'holding',
        dataType: 'uint16',
        access: 'read'
      }]
    }));
  };

  // Handle updating a register mapping
  const handleUpdateRegisterMapping = (index, field, value) => {
    setFormData(prev => {
      const updated = [...prev.register_mappings];
      updated[index] = { ...updated[index], [field]: value };
      return { ...prev, register_mappings: updated };
    });
  };

  // Handle removing a register mapping
  const handleRemoveRegisterMapping = (index) => {
    setFormData(prev => ({
      ...prev,
      register_mappings: prev.register_mappings.filter((_, i) => i !== index)
    }));
  };

  // Handle loading a preset template
  const handleLoadPreset = (presetKey) => {
    if (!presetKey || !REGISTER_PRESETS[presetKey]) return;
    const preset = REGISTER_PRESETS[presetKey];
    setFormData(prev => ({
      ...prev,
      register_mappings: [...preset.mappings]
    }));
  };

  // Handle exporting register mappings as JSON
  const handleExportMappings = () => {
    if (formData.register_mappings.length === 0) return;
    const exportData = {
      version: '1.0',
      exported_at: new Date().toISOString(),
      mappings: formData.register_mappings
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `register-mappings-${formData.name || 'export'}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Handle importing register mappings from JSON file
  const fileInputRef = React.useRef(null);
  const handleImportMappings = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const importData = JSON.parse(e.target.result);
        // Support both direct array and wrapped format
        const mappings = Array.isArray(importData) ? importData : importData.mappings;
        if (Array.isArray(mappings)) {
          // Validate mapping structure
          const validMappings = mappings.filter(m =>
            typeof m === 'object' && m.name && m.register !== undefined
          ).map(m => ({
            name: m.name || '',
            register: String(m.register || ''),
            type: m.type || 'holding',
            dataType: m.dataType || 'uint16',
            access: m.access || 'read'
          }));
          setFormData(prev => ({
            ...prev,
            register_mappings: validMappings
          }));
        } else {
          console.error('Invalid register mappings format');
        }
      } catch (err) {
        console.error('Failed to parse imported file:', err);
      }
    };
    reader.readAsText(file);
    // Reset file input so the same file can be selected again
    event.target.value = '';
  };

  const handleSubmit = async (e) => {
    if (e) e.preventDefault();

    // Double-click protection: use ref to check synchronously
    if (isSubmittingRef.current || saving) return;
    isSubmittingRef.current = true;

    setError(null);
    setSuccessMessage(null);
    setRetryFn(null);

    if (!formData.name.trim()) {
      isSubmittingRef.current = false;
      setError({ message: 'Name is required', canRetry: false });
      return;
    }

    setSaving(true);

    try {
      // Prepare Modbus-specific fields only if protocol is modbus
      const modbusFields = formData.protocol === 'modbus' ? {
        slave_id: formData.slave_id ? parseInt(formData.slave_id) : null,
        polling_interval_ms: formData.polling_interval_ms ? parseInt(formData.polling_interval_ms) : 1000,
        register_mappings: formData.register_mappings.length > 0 ? formData.register_mappings : null
      } : {};

      const response = await fetch(`${API_BASE}/equipment/${equipment.id}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: formData.name.trim(),
          description: formData.description.trim(),
          type: formData.type.trim(),
          protocol: formData.protocol,
          address: formData.address.trim(),
          ...modbusFields
        })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Failed to update equipment');
      }

      const updatedEquipment = await response.json();
      setSuccessMessage(`Equipment "${updatedEquipment.name}" updated successfully!`);

      // Notify parent and close after a brief delay
      setTimeout(() => {
        onSuccess(updatedEquipment);
        onClose();
        setSuccessMessage(null);
      }, 1500);

    } catch (err) {
      const friendlyError = getUserFriendlyError(err, 'updating equipment');
      setError(friendlyError);
      // Store retry function if error is retryable
      if (friendlyError.canRetry) {
        setRetryFn(() => () => handleSubmit());
      }
    } finally {
      setSaving(false);
      isSubmittingRef.current = false;
    }
  };

  if (!isOpen || !equipment) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0">
        {/* Backdrop */}
        <div
          className="fixed inset-0 transition-opacity bg-gray-500 bg-opacity-75"
          onClick={onClose}
        ></div>

        {/* Modal */}
        <div className="inline-block w-full max-w-md p-6 my-8 overflow-hidden text-left align-middle transition-all transform bg-white shadow-xl rounded-lg relative">
          {/* Close button */}
          <button
            onClick={onClose}
            className="absolute top-4 right-4 text-gray-400 hover:text-gray-600"
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            Edit Equipment
          </h3>

          {/* Success Message */}
          {successMessage && (
            <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg">
              <div className="flex items-center">
                <svg className="h-5 w-5 text-green-500 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <span className="text-green-800 text-sm">{successMessage}</span>
              </div>
            </div>
          )}

          {/* Error Message with retry option */}
          {error && (
            <ErrorMessage
              message={typeof error === 'string' ? error : error.message}
              canRetry={error.canRetry}
              onRetry={retryFn}
              isNetworkError={error.isNetworkError}
              className="mb-4"
            />
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Name */}
            <div>
              <label htmlFor="edit-name" className="block text-sm font-medium text-gray-700 mb-1">
                Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                id="edit-name"
                name="name"
                value={formData.name}
                onChange={handleChange}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
                placeholder="e.g., Temperature Sensor 001"
                required
              />
            </div>

            {/* Description */}
            <div>
              <label htmlFor="edit-description" className="block text-sm font-medium text-gray-700 mb-1">
                Description
              </label>
              <textarea
                id="edit-description"
                name="description"
                value={formData.description}
                onChange={handleChange}
                rows={2}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
                placeholder="Optional description"
              />
            </div>

            {/* Type */}
            <div>
              <label htmlFor="edit-type" className="block text-sm font-medium text-gray-700 mb-1">
                Type
              </label>
              <input
                type="text"
                id="edit-type"
                name="type"
                value={formData.type}
                onChange={handleChange}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
                placeholder="e.g., Temperature Sensor, Relay, Controller"
              />
            </div>

            {/* Protocol */}
            <div>
              <label htmlFor="edit-protocol" className="block text-sm font-medium text-gray-700 mb-1">
                Protocol
              </label>
              <select
                id="edit-protocol"
                name="protocol"
                value={formData.protocol}
                onChange={handleChange}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
              >
                <option value="modbus">Modbus</option>
                <option value="mqtt">MQTT</option>
                <option value="zigbee">Zigbee</option>
                <option value="zwave">Z-Wave</option>
                <option value="other">Other</option>
              </select>
            </div>

            {/* Connection Address */}
            <div>
              <label htmlFor="edit-address" className="block text-sm font-medium text-gray-700 mb-1">
                Connection Address
              </label>
              <input
                type="text"
                id="edit-address"
                name="address"
                value={formData.address}
                onChange={handleChange}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
                placeholder="e.g., 192.168.1.100:502 or /dev/ttyUSB0"
              />
            </div>

            {/* Modbus Configuration Section */}
            {showModbusConfig && (
              <div className="border-t border-gray-200 pt-4 mt-4">
                <h4 className="text-sm font-semibold text-gray-900 mb-3 flex items-center">
                  <svg className="w-4 h-4 mr-2 text-primary-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  Modbus Configuration
                </h4>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="edit-slave_id" className="block text-sm font-medium text-gray-700 mb-1">
                      Slave ID (1-247)
                    </label>
                    <input
                      type="number"
                      id="edit-slave_id"
                      name="slave_id"
                      min="1"
                      max="247"
                      value={formData.slave_id}
                      onChange={handleChange}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
                      placeholder="e.g., 1"
                    />
                  </div>

                  <div>
                    <label htmlFor="edit-polling_interval_ms" className="block text-sm font-medium text-gray-700 mb-1">
                      Polling Interval (ms)
                    </label>
                    <input
                      type="number"
                      id="edit-polling_interval_ms"
                      name="polling_interval_ms"
                      min="100"
                      max="60000"
                      step="100"
                      value={formData.polling_interval_ms}
                      onChange={handleChange}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
                      placeholder="1000"
                    />
                  </div>
                </div>

                <div className="mt-4">
                  <div className="flex justify-between items-center mb-2">
                    <label className="block text-sm font-medium text-gray-700">
                      Register Mappings
                    </label>
                    <div className="flex items-center gap-2">
                      {/* Preset Templates Dropdown */}
                      <select
                        onChange={(e) => {
                          handleLoadPreset(e.target.value);
                          e.target.value = '';
                        }}
                        className="text-xs px-2 py-1 border border-gray-300 rounded focus:ring-primary-500 focus:border-primary-500"
                      >
                        <option value="">Load Preset...</option>
                        {Object.entries(REGISTER_PRESETS).map(([key, preset]) => (
                          <option key={key} value={key}>{preset.name}</option>
                        ))}
                      </select>
                      {/* Import Button */}
                      <input
                        type="file"
                        ref={fileInputRef}
                        onChange={handleImportMappings}
                        accept=".json"
                        className="hidden"
                      />
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="text-xs text-gray-600 hover:text-gray-800 px-2 py-1 border border-gray-300 rounded hover:bg-gray-50"
                        title="Import from JSON"
                      >
                        Import
                      </button>
                      {/* Export Button */}
                      <button
                        type="button"
                        onClick={handleExportMappings}
                        disabled={formData.register_mappings.length === 0}
                        className="text-xs text-gray-600 hover:text-gray-800 px-2 py-1 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                        title="Export to JSON"
                      >
                        Export
                      </button>
                      {/* Add Register Button */}
                      <button
                        type="button"
                        onClick={handleAddRegisterMapping}
                        className="text-sm text-primary-600 hover:text-primary-700 font-medium flex items-center"
                      >
                        <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                        </svg>
                        Add
                      </button>
                    </div>
                  </div>

                  {formData.register_mappings.length === 0 ? (
                    <p className="text-sm text-gray-500 italic">No register mappings defined. Use a preset template, import from JSON, or click "Add" to configure manually.</p>
                  ) : (
                    <div className="space-y-3 max-h-48 overflow-y-auto">
                      {formData.register_mappings.map((mapping, index) => (
                        <div key={index} className="bg-gray-50 p-3 rounded-lg border border-gray-200">
                          <div className="flex justify-between items-start mb-2">
                            <span className="text-xs font-medium text-gray-500">Register #{index + 1}</span>
                            <button
                              type="button"
                              onClick={() => handleRemoveRegisterMapping(index)}
                              className="text-red-500 hover:text-red-700"
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <input
                              type="text"
                              placeholder="Name"
                              value={mapping.name}
                              onChange={(e) => handleUpdateRegisterMapping(index, 'name', e.target.value)}
                              className="px-2 py-1 text-sm border border-gray-300 rounded focus:ring-primary-500 focus:border-primary-500"
                            />
                            <input
                              type="number"
                              placeholder="Register #"
                              value={mapping.register}
                              onChange={(e) => handleUpdateRegisterMapping(index, 'register', e.target.value)}
                              className="px-2 py-1 text-sm border border-gray-300 rounded focus:ring-primary-500 focus:border-primary-500"
                            />
                            <select
                              value={mapping.type}
                              onChange={(e) => handleUpdateRegisterMapping(index, 'type', e.target.value)}
                              className="px-2 py-1 text-sm border border-gray-300 rounded focus:ring-primary-500 focus:border-primary-500"
                            >
                              <option value="holding">Holding Register</option>
                              <option value="input">Input Register</option>
                              <option value="coil">Coil</option>
                              <option value="discrete">Discrete Input</option>
                            </select>
                            <select
                              value={mapping.dataType}
                              onChange={(e) => handleUpdateRegisterMapping(index, 'dataType', e.target.value)}
                              className="px-2 py-1 text-sm border border-gray-300 rounded focus:ring-primary-500 focus:border-primary-500"
                            >
                              <option value="uint16">UInt16</option>
                              <option value="int16">Int16</option>
                              <option value="uint32">UInt32</option>
                              <option value="int32">Int32</option>
                              <option value="float32">Float32</option>
                              <option value="bool">Boolean</option>
                            </select>
                          </div>
                          <div className="mt-2">
                            <select
                              value={mapping.access}
                              onChange={(e) => handleUpdateRegisterMapping(index, 'access', e.target.value)}
                              className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-primary-500 focus:border-primary-500"
                            >
                              <option value="read">Read Only</option>
                              <option value="write">Write Only</option>
                              <option value="readwrite">Read/Write</option>
                            </select>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Buttons */}
            <div className="flex justify-end gap-3 pt-4">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
                disabled={saving}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                disabled={saving}
              >
                {saving ? (
                  <>
                    <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Saving...
                  </>
                ) : (
                  'Save Changes'
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

export default function Equipment() {
  const { token, user } = useAuth();
  const { subscribe, connected } = useWebSocket();
  const { id: urlEquipmentId } = useParams();
  const navigate = useNavigate();
  const { setCustomSegment } = useBreadcrumb();
  const [equipment, setEquipment] = useState([]);
  const [zones, setZones] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedEquipment, setSelectedEquipment] = useState(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [equipmentToDelete, setEquipmentToDelete] = useState(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteMessage, setDeleteMessage] = useState(null);
  const [sortColumn, setSortColumn] = useState('name');
  const [sortDirection, setSortDirection] = useState('asc');
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState(null);
  const [discoveredDevices, setDiscoveredDevices] = useState([]);
  const [showDiscoveredModal, setShowDiscoveredModal] = useState(false);
  // Slave ID Scanner state
  const [showSlaveScanner, setShowSlaveScanner] = useState(false);
  const [slaveScanConfig, setSlaveScanConfig] = useState({
    host: '',
    port: '502',
    startSlaveId: '1',
    endSlaveId: '247',
    timeout: '500'
  });
  const [slaveScanProgress, setSlaveScanProgress] = useState(null);
  const [slaveScanResults, setSlaveScanResults] = useState(null);
  const [selectedSlaves, setSelectedSlaves] = useState([]);
  const [addingDevice, setAddingDevice] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  // Relay Control Modal state
  const [showRelayControl, setShowRelayControl] = useState(false);
  const [relayControlEquipment, setRelayControlEquipment] = useState(null);
  const [equipmentNotFound, setEquipmentNotFound] = useState(false);

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(10);

  useEffect(() => {
    fetchData();
  }, [token]);

  // Update breadcrumb when viewing equipment detail
  useEffect(() => {
    if (selectedEquipment && showDetailModal) {
      setCustomSegment(selectedEquipment.name);
    } else {
      setCustomSegment(null);
    }
    // Cleanup when unmounting
    return () => setCustomSegment(null);
  }, [selectedEquipment, showDetailModal, setCustomSegment]);

  // Handle deep linking - open equipment detail when URL contains equipment ID
  useEffect(() => {
    if (urlEquipmentId && equipment.length > 0 && !loading) {
      const eq = equipment.find(e => e.id === parseInt(urlEquipmentId, 10));
      if (eq) {
        setSelectedEquipment(eq);
        setShowDetailModal(true);
        setEquipmentNotFound(false);
      } else {
        // Equipment ID in URL not found in the list
        setEquipmentNotFound(true);
        setShowDetailModal(false);
        setSelectedEquipment(null);
      }
    } else if (!urlEquipmentId) {
      // No equipment ID in URL, clear not found state
      setEquipmentNotFound(false);
    }
  }, [urlEquipmentId, equipment, loading]);

  // Subscribe to real-time equipment updates via WebSocket
  useEffect(() => {
    // Handle equipment updates (status changes, edits)
    const unsubUpdate = subscribe('equipment_updated', (data) => {
      console.log('Equipment updated via WebSocket:', data);
      setEquipment(prev => prev.map(eq =>
        eq.id === data.id ? { ...eq, ...data } : eq
      ));
      setLastUpdate(new Date().toISOString());
    });

    // Handle new equipment created
    const unsubCreate = subscribe('equipment_created', (data) => {
      console.log('Equipment created via WebSocket:', data);
      setEquipment(prev => [...prev, { ...data, zones: [] }]);
      setLastUpdate(new Date().toISOString());
    });

    // Handle equipment deleted
    const unsubDelete = subscribe('equipment_deleted', (data) => {
      console.log('Equipment deleted via WebSocket:', data);
      setEquipment(prev => prev.filter(eq => eq.id !== data.id));
      setLastUpdate(new Date().toISOString());
    });

    // Handle equipment control events (on/off)
    const unsubControl = subscribe('equipment_control', (data) => {
      console.log('Equipment control via WebSocket:', data);
      // Update status based on control action
      setEquipment(prev => prev.map(eq => {
        if (eq.id === data.id) {
          const newStatus = data.action === 'on' ? 'online' :
                           data.action === 'off' ? 'offline' : eq.status;
          return { ...eq, status: newStatus };
        }
        return eq;
      }));
      setLastUpdate(new Date().toISOString());
    });

    // Handle equipment status updates (from simulated sensors/devices)
    const unsubStatus = subscribe('equipment_status', (data) => {
      console.log('Equipment status via WebSocket:', data);
      setEquipment(prev => prev.map(eq =>
        eq.id === data.id ? { ...eq, status: data.status, last_reading: data.last_reading } : eq
      ));
      setLastUpdate(new Date().toISOString());
    });

    return () => {
      unsubUpdate();
      unsubCreate();
      unsubDelete();
      unsubControl();
      unsubStatus();
    };
  }, [subscribe]);

  const fetchData = async () => {
    try {
      setLoading(true);
      setError(null);

      // Fetch equipment
      const equipmentResponse = await fetch(`${API_BASE}/equipment`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!equipmentResponse.ok) {
        throw new Error('Failed to fetch equipment');
      }

      const equipmentData = await equipmentResponse.json();
      setEquipment(equipmentData);

      // Fetch zones to map zone IDs to names
      const zonesResponse = await fetch(`${API_BASE}/zones`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (zonesResponse.ok) {
        const zonesData = await zonesResponse.json();
        const zonesMap = {};
        zonesData.forEach(zone => {
          zonesMap[zone.id] = zone.name;
        });
        setZones(zonesMap);
      }

      // Fetch equipment-zone assignments
      // For each equipment, get its zones
      const equipmentWithZones = await Promise.all(
        equipmentData.map(async (eq) => {
          try {
            const detailResponse = await fetch(`${API_BASE}/equipment/${eq.id}`, {
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
              }
            });
            if (detailResponse.ok) {
              const detailData = await detailResponse.json();
              return { ...eq, zones: detailData.zones || [] };
            }
          } catch (e) {
            // Ignore individual fetch errors
          }
          return { ...eq, zones: [] };
        })
      );

      setEquipment(equipmentWithZones);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleAddSuccess = (newEquipment) => {
    // Refresh the equipment list
    fetchData();
  };

  // Export equipment to CSV
  const handleExportCSV = () => {
    // Define CSV headers
    const headers = ['ID', 'Name', 'Description', 'Type', 'Protocol', 'Address', 'Status', 'Enabled', 'Last Reading', 'Last Communication', 'Zones', 'Created At', 'Updated At'];

    // Convert equipment data to CSV rows
    const rows = equipment.map(eq => {
      const zoneNames = eq.zones ? eq.zones.map(z => z.name).join('; ') : '';
      return [
        eq.id,
        eq.name || '',
        eq.description || '',
        eq.type || '',
        eq.protocol || '',
        eq.address || '',
        eq.status || '',
        eq.enabled ? 'Yes' : 'No',
        eq.last_reading || '',
        eq.last_communication || '',
        zoneNames,
        eq.created_at || '',
        eq.updated_at || ''
      ];
    });

    // Escape CSV values (handle commas, quotes, newlines)
    const escapeCSV = (value) => {
      if (value === null || value === undefined) return '';
      const str = String(value);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    // Build CSV content
    const csvContent = [
      headers.map(escapeCSV).join(','),
      ...rows.map(row => row.map(escapeCSV).join(','))
    ].join('\n');

    // Create and download file
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `equipment-export-${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleScan = async () => {
    setScanning(true);
    setScanResult(null);
    setDiscoveredDevices([]);

    try {
      const response = await fetch(`${API_BASE}/equipment/scan`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ scanType: 'network' })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Scan failed');
      }

      const data = await response.json();
      const discovered = data.discovered || [];

      setScanResult({
        type: 'success',
        message: data.message,
        discovered: discovered,
        totalFound: data.totalFound || 0,
        existingDevicesFound: data.existingDevicesFound || 0
      });

      // If devices were discovered, store them and show the modal
      if (discovered.length > 0) {
        setDiscoveredDevices(discovered);
        setShowDiscoveredModal(true);
      }

      // Refresh equipment list after scan
      await fetchData();

      // Don't auto-clear if devices found - let user dismiss
      if (discovered.length === 0) {
        setTimeout(() => setScanResult(null), 5000);
      }
    } catch (err) {
      setScanResult({ type: 'error', message: err.message });
      setTimeout(() => setScanResult(null), 5000);
    } finally {
      setScanning(false);
    }
  };

  // Slave ID Scanner handlers
  const handleSlaveScan = async () => {
    setSlaveScanProgress(0);
    setSlaveScanResults(null);
    setSelectedSlaves([]);

    try {
      const response = await fetch(`${API_BASE}/equipment/scan-slaves`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          host: slaveScanConfig.host,
          port: parseInt(slaveScanConfig.port) || 502,
          startSlaveId: parseInt(slaveScanConfig.startSlaveId) || 1,
          endSlaveId: parseInt(slaveScanConfig.endSlaveId) || 247,
          timeout: parseInt(slaveScanConfig.timeout) || 500
        })
      });

      // Simulate progress since we don't have streaming
      const progressInterval = setInterval(() => {
        setSlaveScanProgress(prev => Math.min(prev + 5, 95));
      }, 500);

      if (!response.ok) {
        clearInterval(progressInterval);
        const data = await response.json();
        throw new Error(data.message || 'Slave scan failed');
      }

      clearInterval(progressInterval);
      const data = await response.json();
      setSlaveScanProgress(100);
      setSlaveScanResults(data);

      // Auto-select all discovered devices
      if (data.discovered && data.discovered.length > 0) {
        setSelectedSlaves(data.discovered.map(d => d.slaveId));
      }
    } catch (err) {
      setSlaveScanProgress(null);
      alert('Scan failed: ' + err.message);
    }
  };

  const handleCreateSlavesAsEquipment = async () => {
    if (selectedSlaves.length === 0) return;

    try {
      const response = await fetch(`${API_BASE}/equipment/scan-slaves/create-bulk`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          host: slaveScanConfig.host,
          port: parseInt(slaveScanConfig.port) || 502,
          slaves: selectedSlaves.map(slaveId => ({ slaveId })),
          namePrefix: 'Modbus Device'
        })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Failed to create equipment');
      }

      const data = await response.json();
      alert(`Successfully created ${data.count} equipment entries!`);

      // Close modal and refresh
      setShowSlaveScanner(false);
      setSlaveScanProgress(null);
      setSlaveScanResults(null);
      setSelectedSlaves([]);
      await fetchData();
    } catch (err) {
      alert('Failed to create equipment: ' + err.message);
    }
  };

  // Add discovered device to equipment list
  const handleAddDiscoveredDevice = async (device) => {
    setAddingDevice(device.address);

    try {
      const response = await fetch(`${API_BASE}/equipment`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: device.suggestedName || `Modbus Device (${device.ip})`,
          description: device.deviceInfo?.ProductName
            ? `${device.deviceInfo.VendorName || ''} ${device.deviceInfo.ProductName}`.trim()
            : `Discovered Modbus TCP device at ${device.address}`,
          type: 'sensor',
          protocol: 'modbus',
          address: device.address
        })
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.message || 'Failed to add device');
      }

      // Remove device from discovered list
      setDiscoveredDevices(prev => prev.filter(d => d.address !== device.address));

      // Refresh equipment list
      await fetchData();

      // If no more devices, close modal
      if (discoveredDevices.length <= 1) {
        setShowDiscoveredModal(false);
        setScanResult(null);
      }
    } catch (err) {
      console.error('Error adding device:', err);
      alert(`Failed to add device: ${err.message}`);
    } finally {
      setAddingDevice(null);
    }
  };

  const handleViewEquipment = (eq) => {
    setSelectedEquipment(eq);
    setShowDetailModal(true);
    // Update URL to enable deep linking
    navigate(`/equipment/${eq.id}`, { replace: true });
  };

  const handleCloseDetailModal = () => {
    setShowDetailModal(false);
    setSelectedEquipment(null);
    // Clear URL when closing modal
    navigate('/equipment', { replace: true });
  };

  const handleEditEquipment = (eq) => {
    setSelectedEquipment(eq);
    setShowEditModal(true);
  };

  const handleEditSuccess = () => {
    fetchData();
  };

  const openDeleteConfirmation = (eq) => {
    setEquipmentToDelete(eq);
    setShowDeleteConfirm(true);
    setDeleteMessage(null);
  };

  const closeDeleteConfirmation = () => {
    setShowDeleteConfirm(false);
    setEquipmentToDelete(null);
    setDeleteMessage(null);
  };

  const handleDeleteEquipment = async () => {
    if (!equipmentToDelete) return;

    setDeleteLoading(true);
    setDeleteMessage(null);

    try {
      const response = await fetch(`${API_BASE}/equipment/${equipmentToDelete.id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Failed to delete equipment');
      }

      setDeleteMessage({ type: 'success', text: 'Equipment deleted successfully!' });

      // Refresh the list after a brief delay
      setTimeout(() => {
        closeDeleteConfirmation();
        fetchData();
      }, 1500);
    } catch (err) {
      setDeleteMessage({ type: 'error', text: err.message });
    } finally {
      setDeleteLoading(false);
    }
  };

  // Handle column header click for sorting
  const handleSort = (column) => {
    if (sortColumn === column) {
      // Toggle direction if same column
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      // New column, default to ascending
      setSortColumn(column);
      setSortDirection('asc');
    }
  };

  // Filter and sort equipment
  const filteredEquipment = equipment
    .filter(eq => {
      const matchesSearch = !searchTerm ||
        eq.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        eq.type?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        eq.description?.toLowerCase().includes(searchTerm.toLowerCase());

      const matchesStatus = !statusFilter || eq.status === statusFilter;

      return matchesSearch && matchesStatus;
    })
    .sort((a, b) => {
      let aVal, bVal;

      switch (sortColumn) {
        case 'name':
          aVal = (a.name || '').toLowerCase();
          bVal = (b.name || '').toLowerCase();
          break;
        case 'type':
          aVal = (a.type || '').toLowerCase();
          bVal = (b.type || '').toLowerCase();
          break;
        case 'status':
          aVal = (a.status || '').toLowerCase();
          bVal = (b.status || '').toLowerCase();
          break;
        case 'zone':
          aVal = (a.zones && a.zones.length > 0 ? a.zones[0].name : '').toLowerCase();
          bVal = (b.zones && b.zones.length > 0 ? b.zones[0].name : '').toLowerCase();
          break;
        default:
          aVal = (a.name || '').toLowerCase();
          bVal = (b.name || '').toLowerCase();
      }

      if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });

  // Pagination calculations
  const totalPages = Math.ceil(filteredEquipment.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedEquipment = filteredEquipment.slice(startIndex, endIndex);

  // Ensure current page is valid when data changes (pagination stability)
  // This effect runs when filteredEquipment length changes
  React.useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(filteredEquipment.length / itemsPerPage));
    if (currentPage > maxPage) {
      setCurrentPage(maxPage);
    }
  }, [filteredEquipment.length, itemsPerPage, currentPage]);

  // Reset to page 1 when filters change
  React.useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, statusFilter]);

  // Pagination handlers
  const goToPage = (page) => {
    const maxPage = Math.max(1, totalPages);
    setCurrentPage(Math.min(Math.max(1, page), maxPage));
  };

  const goToFirstPage = () => goToPage(1);
  const goToLastPage = () => goToPage(totalPages);
  const goToPrevPage = () => goToPage(currentPage - 1);
  const goToNextPage = () => goToPage(currentPage + 1);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
        <span className="ml-3 text-gray-500">Loading equipment...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <div className="flex items-center">
          <svg className="h-5 w-5 text-red-400 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-red-800">{error}</span>
        </div>
        <button
          onClick={fetchData}
          className="mt-2 text-sm text-red-600 hover:text-red-800 underline"
        >
          Try again
        </button>
      </div>
    );
  }

  // Show not found message when URL contains invalid equipment ID
  if (equipmentNotFound) {
    return (
      <div className="max-w-lg mx-auto mt-12">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-6 text-center">
          <svg className="h-12 w-12 text-amber-500 mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <h2 className="text-xl font-semibold text-amber-800 mb-2">Equipment Not Found</h2>
          <p className="text-amber-700 mb-4">
            The equipment with ID "{urlEquipmentId}" does not exist or may have been deleted.
          </p>
          <button
            onClick={() => navigate('/equipment')}
            className="bg-primary-600 text-white px-4 py-2 rounded-lg hover:bg-primary-700 transition-colors inline-flex items-center"
          >
            <svg className="h-5 w-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            Back to Equipment List
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Equipment</h1>
        <div className="flex gap-3">
          <button
            onClick={handleScan}
            disabled={scanning}
            className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition-colors flex items-center disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {scanning ? (
              <>
                <svg className="animate-spin h-5 w-5 mr-2" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Scanning...
              </>
            ) : (
              <>
                <svg className="h-5 w-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                Scan Network for Modbus Devices
              </>
            )}
          </button>
          <button
            onClick={() => setShowSlaveScanner(true)}
            className="bg-amber-600 text-white px-4 py-2 rounded-lg hover:bg-amber-700 transition-colors flex items-center"
          >
            <svg className="h-5 w-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
            </svg>
            Scan Slave IDs
          </button>
          <button
            onClick={() => setShowAddModal(true)}
            className="bg-primary-600 text-white px-4 py-2 rounded-lg hover:bg-primary-700 transition-colors flex items-center"
          >
            <svg className="h-5 w-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add Equipment
          </button>
          <button
            onClick={handleExportCSV}
            disabled={equipment.length === 0}
            className="bg-gray-600 text-white px-4 py-2 rounded-lg hover:bg-gray-700 transition-colors flex items-center disabled:opacity-50 disabled:cursor-not-allowed"
            title="Export equipment to CSV"
          >
            <svg className="h-5 w-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Export CSV
          </button>
        </div>
      </div>

      {/* Scan Result Message */}
      {scanResult && (
        <div className={`mb-6 p-4 rounded-lg ${
          scanResult.type === 'success'
            ? 'bg-green-50 border border-green-200'
            : 'bg-red-50 border border-red-200'
        }`}>
          <div className="flex items-center">
            {scanResult.type === 'success' ? (
              <svg className="h-5 w-5 text-green-500 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="h-5 w-5 text-red-500 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            )}
            <span className={scanResult.type === 'success' ? 'text-green-800' : 'text-red-800'}>
              {scanResult.message}
              {scanResult.discovered && scanResult.discovered.length > 0 && (
                <span className="ml-2">({scanResult.discovered.length} devices found)</span>
              )}
              {scanResult.discovered && scanResult.discovered.length === 0 && scanResult.type === 'success' && (
                <span className="ml-2">(No new devices found)</span>
              )}
            </span>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="bg-white rounded-lg shadow mb-6 p-4">
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
            <label htmlFor="search" className="sr-only">Search equipment</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <input
                type="text"
                id="search"
                className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
                placeholder="Search by name, type, or description..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
          </div>
          <div className="sm:w-48">
            <label htmlFor="status-filter" className="sr-only">Filter by status</label>
            <select
              id="status-filter"
              className="block w-full py-2 px-3 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">All Statuses</option>
              <option value="online">Online</option>
              <option value="offline">Offline</option>
              <option value="warning">Warning</option>
              <option value="error">Error</option>
              <option value="disabled">Disabled</option>
            </select>
          </div>
          {/* Clear Filters Button - only shown when filters are active */}
          {(searchTerm || statusFilter) && (
            <button
              onClick={() => {
                setSearchTerm('');
                setStatusFilter('');
              }}
              className="px-4 py-2 text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors flex items-center whitespace-nowrap"
            >
              <svg className="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
              Clear Filters
            </button>
          )}
        </div>
      </div>

      {/* Equipment Table */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        {filteredEquipment.length === 0 ? (
          <div className="text-center py-12">
            <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
            </svg>
            <h3 className="mt-2 text-sm font-medium text-gray-900">No equipment</h3>
            <p className="mt-1 text-sm text-gray-500">
              {equipment.length === 0
                ? 'Get started by adding your first piece of equipment.'
                : 'No equipment matches your current filters.'}
            </p>
            {equipment.length === 0 && (
              <div className="mt-6">
                <button
                  onClick={() => setShowAddModal(true)}
                  className="bg-primary-600 text-white px-4 py-2 rounded-lg hover:bg-primary-700 transition-colors inline-flex items-center"
                >
                  <svg className="h-5 w-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  Add Equipment
                </button>
              </div>
            )}
          </div>
        ) : (
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 select-none"
                  onClick={() => handleSort('name')}
                >
                  <div className="flex items-center gap-1">
                    Name
                    {sortColumn === 'name' && (
                      <svg className={`h-4 w-4 ${sortDirection === 'desc' ? 'rotate-180' : ''} transition-transform`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                      </svg>
                    )}
                  </div>
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 select-none"
                  onClick={() => handleSort('type')}
                >
                  <div className="flex items-center gap-1">
                    Type
                    {sortColumn === 'type' && (
                      <svg className={`h-4 w-4 ${sortDirection === 'desc' ? 'rotate-180' : ''} transition-transform`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                      </svg>
                    )}
                  </div>
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 select-none"
                  onClick={() => handleSort('status')}
                >
                  <div className="flex items-center gap-1">
                    Status
                    {sortColumn === 'status' && (
                      <svg className={`h-4 w-4 ${sortDirection === 'desc' ? 'rotate-180' : ''} transition-transform`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                      </svg>
                    )}
                  </div>
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 select-none"
                  onClick={() => handleSort('zone')}
                >
                  <div className="flex items-center gap-1">
                    Zone
                    {sortColumn === 'zone' && (
                      <svg className={`h-4 w-4 ${sortDirection === 'desc' ? 'rotate-180' : ''} transition-transform`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                      </svg>
                    )}
                  </div>
                </th>
                <th scope="col" className="relative px-6 py-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {paginatedEquipment.map((eq) => {
                const isDisabled = eq.enabled === 0 || eq.enabled === false;
                return (
                <tr
                  key={eq.id}
                  className={`hover:bg-gray-50 transition-colors cursor-pointer ${isDisabled ? 'opacity-60 bg-gray-50' : ''}`}
                  onClick={() => handleViewEquipment(eq)}
                >
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center">
                      <div className={`flex-shrink-0 h-10 w-10 rounded-lg flex items-center justify-center ${isDisabled ? 'bg-gray-200' : 'bg-gray-100'}`}>
                        <svg className={`h-6 w-6 ${isDisabled ? 'text-gray-400' : 'text-gray-500'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
                        </svg>
                      </div>
                      <div className="ml-4">
                        <div className={`text-sm font-medium ${isDisabled ? 'text-gray-500' : 'text-gray-900'}`}>
                          {eq.name}
                          {isDisabled && <span className="ml-2 text-xs text-gray-400">(Disabled)</span>}
                        </div>
                        {eq.description && (
                          <div className="text-sm text-gray-500 truncate max-w-xs">{eq.description}</div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className={`text-sm ${isDisabled ? 'text-gray-500' : 'text-gray-900'}`}>{eq.type || '-'}</div>
                    {eq.protocol && (
                      <div className="text-xs text-gray-500 uppercase">{eq.protocol}</div>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <StatusBadge status={isDisabled ? 'disabled' : eq.status} />
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    {eq.zones && eq.zones.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {eq.zones.map((zone, idx) => (
                          <span
                            key={zone.id || idx}
                            className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800"
                          >
                            {zone.name}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-gray-400 text-sm">-</span>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleViewEquipment(eq);
                      }}
                      className="text-primary-600 hover:text-primary-900 mr-3"
                    >
                      View
                    </button>
                    {/* Relay Control button - show for Modbus equipment with coil mappings */}
                    {eq.protocol === 'modbus' && eq.register_mappings &&
                     Array.isArray(eq.register_mappings) &&
                     eq.register_mappings.some(m => m.type === 'coil' && m.access === 'readwrite') && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setRelayControlEquipment(eq);
                          setShowRelayControl(true);
                        }}
                        className="text-amber-600 hover:text-amber-900 mr-3"
                        title="Control Relays"
                      >
                        Relays
                      </button>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleEditEquipment(eq);
                      }}
                      className="text-gray-600 hover:text-gray-900 mr-3"
                    >
                      Edit
                    </button>
                    {user?.role === 'admin' && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openDeleteConfirmation(eq);
                        }}
                        className="text-red-600 hover:text-red-900"
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination Controls */}
      {filteredEquipment.length > 0 && (
        <div className="mt-4 bg-white border border-gray-200 rounded-lg p-4">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            {/* Items per page selector */}
            <div className="flex items-center gap-2 text-sm text-gray-600">
              <label htmlFor="items-per-page">Show</label>
              <select
                id="items-per-page"
                value={itemsPerPage}
                onChange={(e) => {
                  setItemsPerPage(Number(e.target.value));
                  setCurrentPage(1);
                }}
                className="border border-gray-300 rounded px-2 py-1 focus:ring-primary-500 focus:border-primary-500"
              >
                <option value={5}>5</option>
                <option value={10}>10</option>
                <option value={25}>25</option>
                <option value={50}>50</option>
              </select>
              <span>per page</span>
            </div>

            {/* Page info */}
            <div className="text-sm text-gray-600">
              Showing {startIndex + 1} to {Math.min(endIndex, filteredEquipment.length)} of {filteredEquipment.length} equipment
              {equipment.length !== filteredEquipment.length && (
                <span className="text-gray-400"> (filtered from {equipment.length} total)</span>
              )}
            </div>

            {/* Pagination buttons */}
            <div className="flex items-center gap-1">
              <button
                onClick={goToFirstPage}
                disabled={currentPage === 1}
                className="px-2 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                title="First page"
              >
                «
              </button>
              <button
                onClick={goToPrevPage}
                disabled={currentPage === 1}
                className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                title="Previous page"
              >
                ‹ Prev
              </button>

              {/* Page numbers */}
              <div className="flex items-center gap-1 mx-2">
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  // Calculate which page numbers to show
                  let pageNum;
                  if (totalPages <= 5) {
                    pageNum = i + 1;
                  } else if (currentPage <= 3) {
                    pageNum = i + 1;
                  } else if (currentPage >= totalPages - 2) {
                    pageNum = totalPages - 4 + i;
                  } else {
                    pageNum = currentPage - 2 + i;
                  }

                  if (pageNum < 1 || pageNum > totalPages) return null;

                  return (
                    <button
                      key={pageNum}
                      onClick={() => goToPage(pageNum)}
                      className={`px-3 py-1 text-sm border rounded ${
                        currentPage === pageNum
                          ? 'bg-primary-600 text-white border-primary-600'
                          : 'border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      {pageNum}
                    </button>
                  );
                })}
              </div>

              <button
                onClick={goToNextPage}
                disabled={currentPage === totalPages || totalPages === 0}
                className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                title="Next page"
              >
                Next ›
              </button>
              <button
                onClick={goToLastPage}
                disabled={currentPage === totalPages || totalPages === 0}
                className="px-2 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                title="Last page"
              >
                »
              </button>
            </div>
          </div>

          {/* Connection status */}
          <div className="mt-3 pt-3 border-t border-gray-100 flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              {connected ? (
                <>
                  <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                  <span className="text-green-600">Live updates active</span>
                </>
              ) : (
                <>
                  <span className="w-2 h-2 bg-gray-400 rounded-full"></span>
                  <span className="text-gray-400">Live updates disconnected</span>
                </>
              )}
            </span>
            {lastUpdate && (
              <span className="text-gray-400">
                Last update: {new Date(lastUpdate).toLocaleTimeString()}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Add Equipment Modal */}
      <AddEquipmentModal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        onSuccess={handleAddSuccess}
        token={token}
      />

      {/* Equipment Detail Modal */}
      <EquipmentDetailModal
        isOpen={showDetailModal}
        onClose={handleCloseDetailModal}
        equipment={selectedEquipment}
        token={token}
        onUpdate={fetchData}
        user={user}
      />

      {/* Edit Equipment Modal */}
      <EditEquipmentModal
        isOpen={showEditModal}
        onClose={() => {
          setShowEditModal(false);
          setSelectedEquipment(null);
        }}
        equipment={selectedEquipment}
        onSuccess={handleEditSuccess}
        token={token}
      />

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0">
            {/* Backdrop */}
            <div
              className="fixed inset-0 transition-opacity bg-gray-500 bg-opacity-75"
              onClick={closeDeleteConfirmation}
            ></div>

            {/* Modal */}
            <div className="inline-block w-full max-w-md p-6 my-8 overflow-hidden text-left align-middle transition-all transform bg-white shadow-xl rounded-lg relative">
              {/* Warning Icon */}
              <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-red-100 mb-4">
                <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>

              <h3 className="text-lg font-semibold text-gray-900 text-center mb-2">
                Delete Equipment
              </h3>

              <p className="text-sm text-gray-500 text-center mb-4">
                Are you sure you want to delete <span className="font-semibold text-gray-900">{equipmentToDelete?.name}</span>?
                This action cannot be undone.
              </p>

              {/* Delete Message */}
              {deleteMessage && (
                <div className={`mb-4 p-3 rounded-lg text-sm ${
                  deleteMessage.type === 'success'
                    ? 'bg-green-50 text-green-800 border border-green-200'
                    : 'bg-red-50 text-red-800 border border-red-200'
                }`}>
                  <div className="flex items-center justify-center">
                    {deleteMessage.type === 'success' ? (
                      <svg className="h-5 w-5 text-green-500 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      <svg className="h-5 w-5 text-red-500 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    )}
                    {deleteMessage.text}
                  </div>
                </div>
              )}

              {/* Buttons */}
              <div className="flex justify-center gap-3">
                <button
                  type="button"
                  onClick={closeDeleteConfirmation}
                  className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
                  disabled={deleteLoading}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDeleteEquipment}
                  className="px-4 py-2 text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                  disabled={deleteLoading}
                >
                  {deleteLoading ? (
                    <>
                      <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      Deleting...
                    </>
                  ) : (
                    'Delete'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Discovered Devices Modal */}
      <DiscoveredDevicesModal
        isOpen={showDiscoveredModal}
        onClose={() => {
          setShowDiscoveredModal(false);
          setScanResult(null);
        }}
        devices={discoveredDevices}
        onAddDevice={handleAddDiscoveredDevice}
        addingDevice={addingDevice}
      />

      {/* Slave ID Scanner Modal */}
      <SlaveIdScannerModal
        isOpen={showSlaveScanner}
        onClose={() => {
          setShowSlaveScanner(false);
          setSlaveScanProgress(null);
          setSlaveScanResults(null);
          setSelectedSlaves([]);
        }}
        config={slaveScanConfig}
        onConfigChange={setSlaveScanConfig}
        progress={slaveScanProgress}
        results={slaveScanResults}
        selectedSlaves={selectedSlaves}
        onSelectedSlavesChange={setSelectedSlaves}
        onScan={handleSlaveScan}
        onCreateEquipment={handleCreateSlavesAsEquipment}
      />

      {/* Relay Control Modal */}
      <RelayControlModal
        isOpen={showRelayControl}
        onClose={() => {
          setShowRelayControl(false);
          setRelayControlEquipment(null);
        }}
        equipment={relayControlEquipment}
        token={token}
        user={user}
        onUpdate={fetchData}
      />
    </div>
  );
}
