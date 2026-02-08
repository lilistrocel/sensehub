import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useWebSocket } from '../context/WebSocketContext';

const API_BASE = '/api';

// Simple readings chart component
function ReadingsChart({ readings }) {
  if (!readings || readings.length === 0) {
    return (
      <div className="text-center text-gray-500 py-8">
        No readings data available for this time range
      </div>
    );
  }

  // Group readings by equipment
  const equipmentReadings = {};
  readings.forEach((reading) => {
    const name = reading.equipment_name || `Equipment ${reading.equipment_id}`;
    if (!equipmentReadings[name]) {
      equipmentReadings[name] = [];
    }
    equipmentReadings[name].push(reading);
  });

  // Chart dimensions
  const width = 800;
  const height = 300;
  const padding = { top: 20, right: 40, bottom: 40, left: 60 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  // Get time range
  const timestamps = readings.map(r => new Date(r.timestamp).getTime());
  const minTime = Math.min(...timestamps);
  const maxTime = Math.max(...timestamps);
  const timeRange = maxTime - minTime || 1;

  // Get value range
  const values = readings.map(r => parseFloat(r.value)).filter(v => !isNaN(v));
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const valueRange = maxValue - minValue || 1;
  const valueBuffer = valueRange * 0.1;

  // Color palette for different equipment
  const colors = ['#2563EB', '#22C55E', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899'];

  // Generate paths for each equipment
  const equipmentNames = Object.keys(equipmentReadings);
  const paths = equipmentNames.map((name, idx) => {
    const data = equipmentReadings[name].sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    const pathPoints = data.map((reading) => {
      const x = padding.left + ((new Date(reading.timestamp).getTime() - minTime) / timeRange) * chartWidth;
      const y = padding.top + chartHeight - ((parseFloat(reading.value) - minValue + valueBuffer) / (valueRange + valueBuffer * 2)) * chartHeight;
      return { x, y };
    });

    const pathD = pathPoints.map((p, i) =>
      `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`
    ).join(' ');

    return { name, path: pathD, color: colors[idx % colors.length], data };
  });

  // Format time labels
  const formatTime = (ms) => {
    const date = new Date(ms);
    const diff = maxTime - minTime;
    if (diff > 48 * 60 * 60 * 1000) {
      // More than 48 hours - show date
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } else {
      // Less than 48 hours - show time
      return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }
  };

  // Generate axis labels
  const timeLabels = [0, 0.25, 0.5, 0.75, 1].map(p => ({
    x: padding.left + p * chartWidth,
    label: formatTime(minTime + p * timeRange)
  }));

  const valueLabels = [0, 0.25, 0.5, 0.75, 1].map(p => ({
    y: padding.top + chartHeight - p * chartHeight,
    label: (minValue - valueBuffer + p * (valueRange + valueBuffer * 2)).toFixed(1)
  }));

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto">
        {/* Grid lines */}
        {valueLabels.map((label, i) => (
          <line
            key={`grid-h-${i}`}
            x1={padding.left}
            y1={label.y}
            x2={width - padding.right}
            y2={label.y}
            stroke="#E5E7EB"
            strokeWidth="1"
          />
        ))}
        {timeLabels.map((label, i) => (
          <line
            key={`grid-v-${i}`}
            x1={label.x}
            y1={padding.top}
            x2={label.x}
            y2={height - padding.bottom}
            stroke="#E5E7EB"
            strokeWidth="1"
          />
        ))}

        {/* Axes */}
        <line
          x1={padding.left}
          y1={height - padding.bottom}
          x2={width - padding.right}
          y2={height - padding.bottom}
          stroke="#9CA3AF"
          strokeWidth="1"
        />
        <line
          x1={padding.left}
          y1={padding.top}
          x2={padding.left}
          y2={height - padding.bottom}
          stroke="#9CA3AF"
          strokeWidth="1"
        />

        {/* Time labels */}
        {timeLabels.map((label, i) => (
          <text
            key={`time-${i}`}
            x={label.x}
            y={height - padding.bottom + 20}
            textAnchor="middle"
            className="text-xs fill-gray-500"
          >
            {label.label}
          </text>
        ))}

        {/* Value labels */}
        {valueLabels.map((label, i) => (
          <text
            key={`value-${i}`}
            x={padding.left - 10}
            y={label.y + 4}
            textAnchor="end"
            className="text-xs fill-gray-500"
          >
            {label.label}
          </text>
        ))}

        {/* Data lines */}
        {paths.map(({ name, path, color }) => (
          <path
            key={name}
            d={path}
            fill="none"
            stroke={color}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </svg>

      {/* Legend */}
      <div className="flex flex-wrap gap-4 mt-4 justify-center">
        {paths.map(({ name, color }) => (
          <div key={name} className="flex items-center gap-2">
            <div
              className="w-3 h-3 rounded-full"
              style={{ backgroundColor: color }}
            ></div>
            <span className="text-sm text-gray-600">{name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { token, user } = useAuth();
  const { subscribe, connected } = useWebSocket();
  const [zones, setZones] = useState([]);
  const [selectedZoneId, setSelectedZoneId] = useState('');
  const [overview, setOverview] = useState(null);
  const [zoneData, setZoneData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sensorReadings, setSensorReadings] = useState([]);
  const [lastReadingUpdate, setLastReadingUpdate] = useState(null);
  const [timeRange, setTimeRange] = useState('24'); // hours
  const [selectedAlert, setSelectedAlert] = useState(null); // For alert details modal
  const [equipmentList, setEquipmentList] = useState([]); // For equipment controls
  const [controlLoading, setControlLoading] = useState({}); // Track loading state per equipment
  const [controlMessage, setControlMessage] = useState(null); // Control feedback message
  const [isRefreshing, setIsRefreshing] = useState(false); // Track manual refresh state
  const [lastRefreshTime, setLastRefreshTime] = useState(null); // Track last refresh time

  // Check if user can control equipment (admin or operator only)
  const canControl = user?.role === 'admin' || user?.role === 'operator';

  // Quick actions configuration
  const quickActions = [
    {
      id: 'add-equipment',
      label: 'Add Equipment',
      icon: (
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
        </svg>
      ),
      path: '/equipment',
      action: 'add',
      color: 'bg-blue-500 hover:bg-blue-600',
      description: 'Add new equipment'
    },
    {
      id: 'create-zone',
      label: 'Create Zone',
      icon: (
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      ),
      path: '/zones',
      action: 'add',
      color: 'bg-green-500 hover:bg-green-600',
      description: 'Create new zone'
    },
    {
      id: 'new-automation',
      label: 'New Automation',
      icon: (
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
      ),
      path: '/automations',
      action: 'add',
      color: 'bg-purple-500 hover:bg-purple-600',
      description: 'Create automation rule'
    },
    {
      id: 'view-alerts',
      label: 'View Alerts',
      icon: (
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
      ),
      path: '/alerts',
      color: 'bg-amber-500 hover:bg-amber-600',
      description: 'View all alerts'
    }
  ];

  const handleQuickAction = (action) => {
    if (action.action === 'add') {
      // Navigate with state to trigger add modal
      navigate(action.path, { state: { openAddModal: true } });
    } else {
      navigate(action.path);
    }
  };

  // Time range options
  const timeRangeOptions = [
    { value: '1', label: 'Last 1 hour' },
    { value: '6', label: 'Last 6 hours' },
    { value: '24', label: 'Last 24 hours' },
    { value: '168', label: 'Last 7 days' },
    { value: '720', label: 'Last 30 days' },
  ];

  // Subscribe to real-time sensor updates
  useEffect(() => {
    const unsubscribe = subscribe('sensor_reading', (data) => {
      // Update the specific sensor reading in state
      setSensorReadings(prev => {
        const updated = prev.map(reading =>
          reading.equipment_id === data.equipment_id
            ? { ...reading, value: data.value, unit: data.unit, timestamp: data.timestamp }
            : reading
        );
        // If it's a new equipment, add it
        if (!prev.some(r => r.equipment_id === data.equipment_id)) {
          updated.push(data);
        }
        return updated;
      });
      setLastReadingUpdate(new Date());
    });

    return () => unsubscribe();
  }, [subscribe]);

  // Subscribe to equipment control events for real-time status updates
  useEffect(() => {
    const unsubscribeControl = subscribe('equipment_control', (data) => {
      // Update equipment status in real-time
      setEquipmentList(prev => prev.map(eq => {
        if (eq.id === data.id) {
          const newStatus = data.action === 'on' ? 'online' :
                           data.action === 'off' ? 'offline' : eq.status;
          return { ...eq, status: newStatus };
        }
        return eq;
      }));
    });

    const unsubscribeStatus = subscribe('equipment_status', (data) => {
      // Update equipment status when it changes
      setEquipmentList(prev => prev.map(eq =>
        eq.id === data.id ? { ...eq, status: data.status } : eq
      ));
    });

    return () => {
      unsubscribeControl();
      unsubscribeStatus();
    };
  }, [subscribe]);

  // Handle equipment control (on/off toggle)
  const handleEquipmentControl = async (equipmentId, action) => {
    if (!canControl) return;

    setControlLoading(prev => ({ ...prev, [equipmentId]: true }));
    setControlMessage(null);

    try {
      const response = await fetch(`${API_BASE}/equipment/${equipmentId}/control`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ action })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Failed to control equipment');
      }

      // Update local state immediately
      setEquipmentList(prev => prev.map(eq =>
        eq.id === equipmentId
          ? { ...eq, status: action === 'on' ? 'online' : 'offline' }
          : eq
      ));

      setControlMessage({ type: 'success', text: `Equipment turned ${action}!` });
      setTimeout(() => setControlMessage(null), 3000);
    } catch (err) {
      setControlMessage({ type: 'error', text: err.message });
    } finally {
      setControlLoading(prev => ({ ...prev, [equipmentId]: false }));
    }
  };

  // Fetch zones for the dropdown
  useEffect(() => {
    const fetchZones = async () => {
      try {
        const response = await fetch(`${API_BASE}/zones`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (response.ok) {
          const data = await response.json();
          setZones(data);
        }
      } catch (err) {
        console.error('Failed to fetch zones:', err);
      }
    };
    fetchZones();
  }, [token]);

  // Fetch dashboard data
  useEffect(() => {
    const fetchDashboardData = async () => {
      try {
        setLoading(true);
        setError(null);

        if (selectedZoneId) {
          // Fetch zone-specific dashboard
          const response = await fetch(`${API_BASE}/dashboard/zone/${selectedZoneId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
          });
          if (!response.ok) throw new Error('Failed to fetch zone dashboard');
          const data = await response.json();
          setZoneData(data);
          setOverview(null);
        } else {
          // Fetch overview dashboard with time range
          const response = await fetch(`${API_BASE}/dashboard/overview?hours=${timeRange}`, {
            headers: { 'Authorization': `Bearer ${token}` }
          });
          if (!response.ok) throw new Error('Failed to fetch dashboard');
          const data = await response.json();
          setOverview(data);
          setZoneData(null);
          // Initialize sensor readings from overview data
          if (data.latestReadings) {
            setSensorReadings(data.latestReadings);
            setLastReadingUpdate(new Date());
          }
          // Initialize equipment list for controls
          if (data.equipmentList) {
            setEquipmentList(data.equipmentList);
          }
        }
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    fetchDashboardData();
  }, [token, selectedZoneId, timeRange]);

  const handleZoneChange = (e) => {
    setSelectedZoneId(e.target.value);
  };

  // Manual refresh function
  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      if (selectedZoneId) {
        const response = await fetch(`${API_BASE}/dashboard/zone/${selectedZoneId}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!response.ok) throw new Error('Failed to fetch zone dashboard');
        const data = await response.json();
        setZoneData(data);
        setOverview(null);
      } else {
        const response = await fetch(`${API_BASE}/dashboard/overview?hours=${timeRange}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!response.ok) throw new Error('Failed to fetch dashboard');
        const data = await response.json();
        setOverview(data);
        setZoneData(null);
        if (data.latestReadings) {
          setSensorReadings(data.latestReadings);
          setLastReadingUpdate(new Date());
        }
        if (data.equipmentList) {
          setEquipmentList(data.equipmentList);
        }
      }
      setLastRefreshTime(new Date());
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsRefreshing(false);
    }
  };

  // Calculate stats based on selected view
  const getStats = () => {
    if (zoneData) {
      // Zone-specific stats
      const equipment = zoneData.equipment || [];
      const onlineCount = equipment.filter(e => e.status === 'online').length;
      const alerts = zoneData.alerts || [];
      return {
        equipmentOnline: onlineCount,
        totalEquipment: equipment.length,
        activeZones: 1, // Viewing single zone
        automationsRunning: '-', // Not available in zone view
        activeAlerts: alerts.filter(a => !a.acknowledged).length
      };
    } else if (overview) {
      return {
        equipmentOnline: overview.equipment?.online || 0,
        totalEquipment: overview.equipment?.total || 0,
        activeZones: overview.zones?.total || 0,
        automationsRunning: overview.automations?.active || 0,
        activeAlerts: overview.alerts?.unacknowledged || 0
      };
    }
    return {
      equipmentOnline: 0,
      totalEquipment: 0,
      activeZones: 0,
      automationsRunning: 0,
      activeAlerts: 0
    };
  };

  const stats = getStats();
  const selectedZone = zones.find(z => z.id === parseInt(selectedZoneId));

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>

        {/* Zone Filter */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <label htmlFor="zone-filter" className="text-sm font-medium text-gray-700">
              Zone:
            </label>
            <select
              id="zone-filter"
              value={selectedZoneId}
              onChange={handleZoneChange}
              className="border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[150px]"
            >
              <option value="">All Zones</option>
              {zones.map((zone) => (
                <option key={zone.id} value={zone.id}>
                  {zone.name}
                </option>
              ))}
            </select>
          </div>

          {/* Time Range Selector */}
          <div className="flex items-center gap-2">
            <label htmlFor="time-range" className="text-sm font-medium text-gray-700">
              Time Range:
            </label>
            <select
              id="time-range"
              value={timeRange}
              onChange={(e) => setTimeRange(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[150px]"
            >
              {timeRangeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          {/* Refresh Button */}
          <button
            onClick={handleRefresh}
            disabled={isRefreshing || loading}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
              isRefreshing || loading
                ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                : 'bg-blue-600 text-white hover:bg-blue-700'
            }`}
            title={lastRefreshTime ? `Last refreshed: ${lastRefreshTime.toLocaleTimeString()}` : 'Click to refresh data'}
          >
            <svg
              className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            {isRefreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Zone indicator */}
      {selectedZone && (
        <div className="mb-4 bg-blue-50 border border-blue-200 rounded-lg px-4 py-2 flex items-center gap-2">
          <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <span className="text-blue-800 font-medium">
            Viewing: {selectedZone.name}
          </span>
          <button
            onClick={() => setSelectedZoneId('')}
            className="ml-auto text-blue-600 hover:text-blue-800 text-sm underline"
          >
            Clear filter
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center items-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-600">{error}</p>
        </div>
      ) : (
        <>
          {/* Statistics Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <div className="bg-white rounded-lg shadow p-6">
              <h3 className="text-sm font-medium text-gray-500">Equipment Online</h3>
              <p className="text-3xl font-bold text-gray-900 mt-2">
                {stats.equipmentOnline}
                {stats.totalEquipment > 0 && (
                  <span className="text-sm font-normal text-gray-500 ml-2">
                    / {stats.totalEquipment}
                  </span>
                )}
              </p>
            </div>
            <div className="bg-white rounded-lg shadow p-6">
              <h3 className="text-sm font-medium text-gray-500">Active Zones</h3>
              <p className="text-3xl font-bold text-gray-900 mt-2">{stats.activeZones}</p>
            </div>
            <div className="bg-white rounded-lg shadow p-6">
              <h3 className="text-sm font-medium text-gray-500">Automations Running</h3>
              <p className="text-3xl font-bold text-gray-900 mt-2">{stats.automationsRunning}</p>
            </div>
            <div className="bg-white rounded-lg shadow p-6">
              <h3 className="text-sm font-medium text-gray-500">Active Alerts</h3>
              <p className="text-3xl font-bold text-gray-900 mt-2">{stats.activeAlerts}</p>
            </div>
          </div>

          {/* Zone Equipment List */}
          {zoneData && zoneData.equipment && (
            <div className="bg-white rounded-lg shadow">
              <div className="px-6 py-4 border-b border-gray-200">
                <h2 className="text-lg font-semibold text-gray-900">
                  Equipment in {selectedZone?.name || 'Zone'}
                </h2>
              </div>
              {zoneData.equipment.length === 0 ? (
                <div className="px-6 py-8 text-center text-gray-500">
                  No equipment assigned to this zone
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Last Communication</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {zoneData.equipment.map((equip) => (
                        <tr key={equip.id} className="hover:bg-gray-50">
                          <td className="px-6 py-4 whitespace-nowrap">
                            <div className="text-sm font-medium text-gray-900">{equip.name}</div>
                            {equip.description && (
                              <div className="text-sm text-gray-500">{equip.description}</div>
                            )}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{equip.type}</td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <span className={`px-2 py-1 text-xs rounded-full ${
                              equip.status === 'online' ? 'bg-green-100 text-green-800' :
                              equip.status === 'offline' ? 'bg-gray-100 text-gray-800' :
                              equip.status === 'warning' ? 'bg-amber-100 text-amber-800' :
                              'bg-red-100 text-red-800'
                            }`}>
                              {equip.status}
                            </span>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                            {equip.last_communication
                              ? new Date(equip.last_communication).toLocaleString()
                              : 'Never'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Recent Alerts for Zone View */}
          {zoneData && zoneData.alerts && zoneData.alerts.length > 0 && (
            <div className="mt-6 bg-white rounded-lg shadow">
              <div className="px-6 py-4 border-b border-gray-200">
                <h2 className="text-lg font-semibold text-gray-900">
                  Recent Alerts in {selectedZone?.name || 'Zone'}
                </h2>
              </div>
              <div className="divide-y divide-gray-200">
                {zoneData.alerts.map((alert) => (
                  <div key={alert.id} className="px-6 py-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className={`w-2 h-2 rounded-full ${
                        alert.severity === 'critical' ? 'bg-red-500' :
                        alert.severity === 'warning' ? 'bg-amber-500' :
                        'bg-blue-500'
                      }`}></span>
                      <div>
                        <p className="text-sm font-medium text-gray-900">{alert.message}</p>
                        <p className="text-xs text-gray-500">
                          {new Date(alert.created_at).toLocaleString()}
                        </p>
                      </div>
                    </div>
                    {alert.acknowledged && (
                      <span className="text-xs text-green-600">Acknowledged</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Sensor Readings Widget */}
          {!selectedZoneId && sensorReadings && sensorReadings.length > 0 && (
            <div className="bg-white rounded-lg shadow mb-6">
              <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
                <h2 className="text-lg font-semibold text-gray-900">Live Sensor Readings</h2>
                <div className="flex items-center gap-2">
                  {connected && (
                    <span className="flex items-center gap-1 text-xs text-green-600">
                      <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                      Live
                    </span>
                  )}
                  {lastReadingUpdate && (
                    <span className="text-xs text-gray-400">
                      Updated: {lastReadingUpdate.toLocaleTimeString()}
                    </span>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-6">
                {sensorReadings.map((reading) => (
                  <div
                    key={reading.id || reading.equipment_id}
                    className="bg-gray-50 rounded-lg p-4 border border-gray-200"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-gray-700">
                        {reading.equipment_name || `Equipment #${reading.equipment_id}`}
                      </span>
                      <span className={`w-2 h-2 rounded-full ${
                        reading.equipment_status === 'online' ? 'bg-green-500' :
                        reading.equipment_status === 'warning' ? 'bg-amber-500' :
                        reading.equipment_status === 'error' ? 'bg-red-500' :
                        'bg-gray-400'
                      }`}></span>
                    </div>
                    <div className="flex items-baseline gap-1">
                      <span className="text-3xl font-bold text-gray-900">
                        {typeof reading.value === 'number' ? reading.value.toFixed(1) : reading.value}
                      </span>
                      <span className="text-lg text-gray-500">{reading.unit || ''}</span>
                    </div>
                    <div className="text-xs text-gray-400 mt-2">
                      {reading.timestamp
                        ? new Date(reading.timestamp).toLocaleString()
                        : 'No timestamp'}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Historical Readings Chart */}
          {!selectedZoneId && overview && overview.chartReadings && overview.chartReadings.length > 0 && (
            <div className="bg-white rounded-lg shadow mb-6">
              <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
                <h2 className="text-lg font-semibold text-gray-900">Sensor Readings Chart</h2>
                <span className="text-sm text-gray-500">
                  {timeRangeOptions.find(o => o.value === timeRange)?.label || 'Last 24 hours'}
                </span>
              </div>
              <div className="p-6">
                {/* Simple SVG-based line chart */}
                <ReadingsChart readings={overview.chartReadings} />
              </div>
            </div>
          )}

          {/* Equipment Control Widget */}
          {!selectedZoneId && equipmentList && equipmentList.length > 0 && (
            <div className="bg-white rounded-lg shadow mb-6">
              <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
                <h2 className="text-lg font-semibold text-gray-900">Equipment Control</h2>
                <span className="text-sm text-gray-500">
                  {equipmentList.filter(e => e.status === 'online').length} / {equipmentList.length} online
                </span>
              </div>

              {/* Control Message */}
              {controlMessage && (
                <div className={`mx-6 mt-4 p-3 rounded-lg text-sm ${
                  controlMessage.type === 'success'
                    ? 'bg-green-50 text-green-800 border border-green-200'
                    : 'bg-red-50 text-red-800 border border-red-200'
                }`}>
                  {controlMessage.text}
                </div>
              )}

              <div className="divide-y divide-gray-200">
                {equipmentList.map((equipment) => (
                  <div key={equipment.id} className="px-6 py-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {/* Status indicator */}
                      <span className={`w-3 h-3 rounded-full ${
                        equipment.status === 'online' ? 'bg-green-500' :
                        equipment.status === 'offline' ? 'bg-gray-400' :
                        equipment.status === 'warning' ? 'bg-amber-500' :
                        equipment.status === 'error' ? 'bg-red-500' :
                        'bg-gray-400'
                      }`}></span>
                      <div>
                        <p className="text-sm font-medium text-gray-900">{equipment.name}</p>
                        <div className="flex items-center gap-2 text-xs text-gray-500">
                          {equipment.type && <span>{equipment.type}</span>}
                          <span className={`px-1.5 py-0.5 rounded ${
                            equipment.status === 'online' ? 'bg-green-100 text-green-700' :
                            equipment.status === 'offline' ? 'bg-gray-100 text-gray-600' :
                            equipment.status === 'warning' ? 'bg-amber-100 text-amber-700' :
                            equipment.status === 'error' ? 'bg-red-100 text-red-700' :
                            'bg-gray-100 text-gray-600'
                          }`}>
                            {equipment.status || 'unknown'}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {canControl ? (
                        <>
                          <button
                            onClick={() => handleEquipmentControl(equipment.id, 'on')}
                            disabled={controlLoading[equipment.id] || equipment.status === 'online'}
                            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors flex items-center gap-1 ${
                              equipment.status === 'online'
                                ? 'bg-green-100 text-green-700 cursor-default'
                                : 'bg-green-600 text-white hover:bg-green-700 disabled:opacity-50'
                            }`}
                          >
                            {controlLoading[equipment.id] ? (
                              <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                              </svg>
                            ) : (
                              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                              </svg>
                            )}
                            On
                          </button>
                          <button
                            onClick={() => handleEquipmentControl(equipment.id, 'off')}
                            disabled={controlLoading[equipment.id] || equipment.status === 'offline'}
                            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors flex items-center gap-1 ${
                              equipment.status === 'offline'
                                ? 'bg-gray-100 text-gray-500 cursor-default'
                                : 'bg-gray-600 text-white hover:bg-gray-700 disabled:opacity-50'
                            }`}
                          >
                            {controlLoading[equipment.id] ? (
                              <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                              </svg>
                            ) : (
                              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                              </svg>
                            )}
                            Off
                          </button>
                        </>
                      ) : (
                        <span className="text-xs text-gray-400 italic">View only</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Active Automations Panel */}
          {!selectedZoneId && overview && overview.activeAutomations && overview.activeAutomations.length > 0 && (
            <div className="bg-white rounded-lg shadow mb-6">
              <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
                <h2 className="text-lg font-semibold text-gray-900">Active Automations</h2>
                <span className="text-sm text-gray-500">
                  {overview.activeAutomations.length} enabled
                </span>
              </div>
              <div className="divide-y divide-gray-200">
                {overview.activeAutomations.map((automation) => {
                  // Parse trigger config to get trigger type
                  let triggerType = 'Unknown';
                  try {
                    const config = typeof automation.trigger_config === 'string'
                      ? JSON.parse(automation.trigger_config)
                      : automation.trigger_config;
                    triggerType = config?.type || 'Unknown';
                  } catch (e) {
                    // ignore parse errors
                  }

                  return (
                    <div key={automation.id} className="px-6 py-4 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {/* Status indicator */}
                        <span className={`w-3 h-3 rounded-full ${
                          automation.last_status === 'success' ? 'bg-green-500' :
                          automation.last_status === 'error' ? 'bg-red-500' :
                          automation.last_status === 'running' ? 'bg-blue-500 animate-pulse' :
                          'bg-gray-400'
                        }`}></span>
                        <div>
                          <p className="text-sm font-medium text-gray-900">{automation.name}</p>
                          <div className="flex items-center gap-2 text-xs text-gray-500">
                            <span className="px-1.5 py-0.5 bg-gray-100 rounded">
                              {triggerType}
                            </span>
                            {automation.run_count > 0 && (
                              <span>{automation.run_count} runs</span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-xs text-gray-500">
                          {automation.last_run
                            ? `Last run: ${new Date(automation.last_run).toLocaleString()}`
                            : 'Never run'}
                        </div>
                        <span className={`text-xs px-2 py-0.5 rounded-full ${
                          automation.enabled
                            ? 'bg-green-100 text-green-800'
                            : 'bg-gray-100 text-gray-600'
                        }`}>
                          {automation.enabled ? 'Enabled' : 'Disabled'}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Overview Recent Alerts */}
          {overview && overview.recentAlerts && overview.recentAlerts.length > 0 && (
            <div className="bg-white rounded-lg shadow">
              <div className="px-6 py-4 border-b border-gray-200">
                <h2 className="text-lg font-semibold text-gray-900">Recent Alerts</h2>
              </div>
              <div className="divide-y divide-gray-200">
                {overview.recentAlerts.map((alert) => (
                  <div
                    key={alert.id}
                    className="px-6 py-4 flex items-center justify-between hover:bg-gray-50 cursor-pointer transition-colors"
                    onClick={() => setSelectedAlert(alert)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === 'Enter' && setSelectedAlert(alert)}
                  >
                    <div className="flex items-center gap-3">
                      <span className={`w-2 h-2 rounded-full ${
                        alert.severity === 'critical' ? 'bg-red-500' :
                        alert.severity === 'warning' ? 'bg-amber-500' :
                        'bg-blue-500'
                      }`}></span>
                      <div>
                        <p className="text-sm font-medium text-gray-900">{alert.message}</p>
                        <p className="text-xs text-gray-500">
                          {alert.equipment_name && `${alert.equipment_name} • `}
                          {new Date(alert.created_at).toLocaleString()}
                        </p>
                      </div>
                    </div>
                    {alert.acknowledged ? (
                      <span className="text-xs text-green-600">Acknowledged</span>
                    ) : (
                      <span className="text-xs text-gray-400">0</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Alert Details Modal */}
          {selectedAlert && (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onClick={() => setSelectedAlert(null)}>
              <div className="bg-white rounded-lg shadow-xl max-w-lg w-full mx-4" onClick={(e) => e.stopPropagation()}>
                <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
                  <h3 className="text-lg font-semibold text-gray-900">Alert Details</h3>
                  <button
                    onClick={() => setSelectedAlert(null)}
                    className="text-gray-400 hover:text-gray-600"
                  >
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                <div className="px-6 py-4 space-y-4">
                  {/* Severity Badge */}
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-500">Severity:</span>
                    <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                      selectedAlert.severity === 'critical' ? 'bg-red-100 text-red-800' :
                      selectedAlert.severity === 'warning' ? 'bg-amber-100 text-amber-800' :
                      'bg-blue-100 text-blue-800'
                    }`}>
                      {selectedAlert.severity?.toUpperCase() || 'INFO'}
                    </span>
                  </div>

                  {/* Message */}
                  <div>
                    <span className="text-sm font-medium text-gray-500">Message:</span>
                    <p className="mt-1 text-sm text-gray-900">{selectedAlert.message}</p>
                  </div>

                  {/* Equipment */}
                  {selectedAlert.equipment_name && (
                    <div>
                      <span className="text-sm font-medium text-gray-500">Equipment:</span>
                      <p className="mt-1 text-sm text-gray-900">{selectedAlert.equipment_name}</p>
                    </div>
                  )}

                  {/* Zone */}
                  {selectedAlert.zone_name && (
                    <div>
                      <span className="text-sm font-medium text-gray-500">Zone:</span>
                      <p className="mt-1 text-sm text-gray-900">{selectedAlert.zone_name}</p>
                    </div>
                  )}

                  {/* Timestamp */}
                  <div>
                    <span className="text-sm font-medium text-gray-500">Created:</span>
                    <p className="mt-1 text-sm text-gray-900">
                      {new Date(selectedAlert.created_at).toLocaleString()}
                    </p>
                  </div>

                  {/* Acknowledged Status */}
                  <div>
                    <span className="text-sm font-medium text-gray-500">Status:</span>
                    <p className="mt-1 text-sm">
                      {selectedAlert.acknowledged ? (
                        <span className="text-green-600">
                          Acknowledged
                          {selectedAlert.acknowledged_at && ` on ${new Date(selectedAlert.acknowledged_at).toLocaleString()}`}
                        </span>
                      ) : (
                        <span className="text-amber-600">Unacknowledged</span>
                      )}
                    </p>
                  </div>

                  {/* Alert ID */}
                  <div>
                    <span className="text-sm font-medium text-gray-500">Alert ID:</span>
                    <p className="mt-1 text-sm text-gray-400">#{selectedAlert.id}</p>
                  </div>
                </div>
                <div className="px-6 py-4 border-t border-gray-200 flex justify-end">
                  <button
                    onClick={() => setSelectedAlert(null)}
                    className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
