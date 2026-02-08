import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

const API_BASE = '/api';

export default function Dashboard() {
  const { token } = useAuth();
  const [zones, setZones] = useState([]);
  const [selectedZoneId, setSelectedZoneId] = useState('');
  const [overview, setOverview] = useState(null);
  const [zoneData, setZoneData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

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
          // Fetch overview dashboard
          const response = await fetch(`${API_BASE}/dashboard/overview`, {
            headers: { 'Authorization': `Bearer ${token}` }
          });
          if (!response.ok) throw new Error('Failed to fetch dashboard');
          const data = await response.json();
          setOverview(data);
          setZoneData(null);
        }
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    fetchDashboardData();
  }, [token, selectedZoneId]);

  const handleZoneChange = (e) => {
    setSelectedZoneId(e.target.value);
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
        <div className="flex items-center gap-2">
          <label htmlFor="zone-filter" className="text-sm font-medium text-gray-700">
            Filter by Zone:
          </label>
          <select
            id="zone-filter"
            value={selectedZoneId}
            onChange={handleZoneChange}
            className="border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[200px]"
          >
            <option value="">All Zones</option>
            {zones.map((zone) => (
              <option key={zone.id} value={zone.id}>
                {zone.name}
              </option>
            ))}
          </select>
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

          {/* Overview Recent Alerts */}
          {overview && overview.recentAlerts && overview.recentAlerts.length > 0 && (
            <div className="bg-white rounded-lg shadow">
              <div className="px-6 py-4 border-b border-gray-200">
                <h2 className="text-lg font-semibold text-gray-900">Recent Alerts</h2>
              </div>
              <div className="divide-y divide-gray-200">
                {overview.recentAlerts.map((alert) => (
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
                          {alert.equipment_name && `${alert.equipment_name} • `}
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
        </>
      )}
    </div>
  );
}
