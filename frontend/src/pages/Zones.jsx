import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

const API_BASE = '/api';

export default function Zones() {
  const { token, user } = useAuth();
  const [zones, setZones] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newZone, setNewZone] = useState({ name: '', description: '' });
  const [saving, setSaving] = useState(false);
  const [selectedZone, setSelectedZone] = useState(null);
  const [zoneDetail, setZoneDetail] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [showAssignEquipmentModal, setShowAssignEquipmentModal] = useState(false);
  const [availableEquipment, setAvailableEquipment] = useState([]);
  const [loadingEquipment, setLoadingEquipment] = useState(false);
  const [selectedEquipmentId, setSelectedEquipmentId] = useState('');
  const [assigningEquipment, setAssigningEquipment] = useState(false);

  useEffect(() => {
    fetchZones();
  }, []);

  const fetchZones = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${API_BASE}/zones`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        throw new Error('Failed to fetch zones');
      }

      const data = await response.json();
      setZones(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchZoneDetail = async (zoneId) => {
    try {
      setLoadingDetail(true);
      const response = await fetch(`${API_BASE}/zones/${zoneId}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        throw new Error('Failed to fetch zone details');
      }

      const data = await response.json();
      setZoneDetail(data);
    } catch (err) {
      alert(err.message);
    } finally {
      setLoadingDetail(false);
    }
  };

  const handleZoneClick = (zone) => {
    setSelectedZone(zone);
    fetchZoneDetail(zone.id);
  };

  const closeDetailModal = () => {
    setSelectedZone(null);
    setZoneDetail(null);
  };

  const fetchAvailableEquipment = async () => {
    try {
      setLoadingEquipment(true);
      const response = await fetch(`${API_BASE}/equipment`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        throw new Error('Failed to fetch equipment');
      }

      const allEquipment = await response.json();

      // Filter out equipment already in this zone
      const assignedIds = new Set((zoneDetail?.equipment || []).map(e => e.id));
      const available = allEquipment.filter(e => !assignedIds.has(e.id));

      setAvailableEquipment(available);
    } catch (err) {
      alert(err.message);
    } finally {
      setLoadingEquipment(false);
    }
  };

  const openAssignEquipmentModal = () => {
    setShowAssignEquipmentModal(true);
    setSelectedEquipmentId('');
    fetchAvailableEquipment();
  };

  const closeAssignEquipmentModal = () => {
    setShowAssignEquipmentModal(false);
    setSelectedEquipmentId('');
  };

  const handleAssignEquipment = async () => {
    if (!selectedEquipmentId || !selectedZone) return;

    try {
      setAssigningEquipment(true);
      const response = await fetch(`${API_BASE}/zones/${selectedZone.id}/equipment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ equipment_id: parseInt(selectedEquipmentId) })
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || 'Failed to assign equipment');
      }

      // Refresh zone detail to show newly assigned equipment
      await fetchZoneDetail(selectedZone.id);
      closeAssignEquipmentModal();
      // Refresh zones list to update equipment counts
      fetchZones();
    } catch (err) {
      alert(err.message);
    } finally {
      setAssigningEquipment(false);
    }
  };

  const handleRemoveEquipment = async (equipmentId) => {
    if (!selectedZone) return;

    if (!confirm('Remove this equipment from the zone?')) return;

    try {
      const response = await fetch(`${API_BASE}/zones/${selectedZone.id}/equipment/${equipmentId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || 'Failed to remove equipment');
      }

      // Refresh zone detail
      await fetchZoneDetail(selectedZone.id);
      // Refresh zones list to update equipment counts
      fetchZones();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleAddZone = async (e) => {
    e.preventDefault();
    if (!newZone.name.trim()) return;

    try {
      setSaving(true);
      const response = await fetch(`${API_BASE}/zones`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(newZone)
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || 'Failed to create zone');
      }

      setNewZone({ name: '', description: '' });
      setShowAddModal(false);
      fetchZones();
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  };

  const canManageZones = user?.role === 'admin' || user?.role === 'operator';

  if (loading) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Zones</h1>
        <div className="flex justify-center items-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Zones</h1>
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-600">{error}</p>
          <button
            onClick={fetchZones}
            className="mt-2 text-sm text-red-700 underline"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Zones</h1>
        {canManageZones && (
          <button
            onClick={() => setShowAddModal(true)}
            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg flex items-center gap-2"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add Zone
          </button>
        )}
      </div>

      {zones.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-6">
          <p className="text-gray-500 text-center">No zones configured yet.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {zones.map((zone) => (
            <div
              key={zone.id}
              onClick={() => handleZoneClick(zone)}
              className="bg-white rounded-lg shadow p-6 hover:shadow-md transition-shadow cursor-pointer"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <h3 className="text-lg font-semibold text-gray-900">{zone.name}</h3>
                  {zone.description && (
                    <p className="text-gray-500 text-sm mt-1">{zone.description}</p>
                  )}
                </div>
                <div className="ml-4">
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                    <svg className="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
                    </svg>
                    {zone.equipment_count} equipment
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Zone Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md">
            <h2 className="text-xl font-bold text-gray-900 mb-4">Add New Zone</h2>
            <form onSubmit={handleAddZone}>
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Zone Name *
                </label>
                <input
                  type="text"
                  value={newZone.name}
                  onChange={(e) => setNewZone({ ...newZone, name: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="e.g., Production Floor"
                  required
                />
              </div>
              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Description
                </label>
                <textarea
                  value={newZone.description}
                  onChange={(e) => setNewZone({ ...newZone, description: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Optional description of this zone"
                  rows={3}
                />
              </div>
              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg"
                  disabled={saving}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving || !newZone.name.trim()}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg disabled:opacity-50"
                >
                  {saving ? 'Creating...' : 'Create Zone'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Zone Detail Modal */}
      {selectedZone && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-2xl max-h-[80vh] overflow-y-auto">
            <div className="flex justify-between items-start mb-4">
              <h2 className="text-xl font-bold text-gray-900">{selectedZone.name}</h2>
              <button
                onClick={closeDetailModal}
                className="text-gray-400 hover:text-gray-600"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {loadingDetail ? (
              <div className="flex justify-center items-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
              </div>
            ) : zoneDetail ? (
              <div className="space-y-6">
                {/* Zone Info */}
                <div className="bg-gray-50 rounded-lg p-4">
                  <h3 className="text-sm font-medium text-gray-500 mb-2">Zone Information</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs text-gray-500">Name</p>
                      <p className="font-medium text-gray-900">{zoneDetail.name}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">ID</p>
                      <p className="font-medium text-gray-900">{zoneDetail.id}</p>
                    </div>
                  </div>
                  {zoneDetail.description && (
                    <div className="mt-4">
                      <p className="text-xs text-gray-500">Description</p>
                      <p className="text-gray-700">{zoneDetail.description}</p>
                    </div>
                  )}
                  <div className="mt-4 grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs text-gray-500">Created</p>
                      <p className="text-gray-700">{new Date(zoneDetail.created_at).toLocaleString()}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Updated</p>
                      <p className="text-gray-700">{new Date(zoneDetail.updated_at).toLocaleString()}</p>
                    </div>
                  </div>
                </div>

                {/* Assigned Equipment */}
                <div>
                  <div className="flex justify-between items-center mb-2">
                    <h3 className="text-sm font-medium text-gray-500">
                      Assigned Equipment ({zoneDetail.equipment?.length || 0})
                    </h3>
                    {canManageZones && (
                      <button
                        onClick={openAssignEquipmentModal}
                        className="text-sm bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded flex items-center gap-1"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                        </svg>
                        Assign Equipment
                      </button>
                    )}
                  </div>
                  {zoneDetail.equipment && zoneDetail.equipment.length > 0 ? (
                    <div className="bg-white border border-gray-200 rounded-lg divide-y">
                      {zoneDetail.equipment.map((equip) => (
                        <div key={equip.id} className="p-3 flex items-center justify-between">
                          <div>
                            <p className="font-medium text-gray-900">{equip.name}</p>
                            <p className="text-sm text-gray-500">{equip.type} • {equip.protocol}</p>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className={`px-2 py-1 text-xs rounded-full ${
                              equip.status === 'online' ? 'bg-green-100 text-green-800' :
                              equip.status === 'offline' ? 'bg-gray-100 text-gray-800' :
                              equip.status === 'warning' ? 'bg-amber-100 text-amber-800' :
                              'bg-red-100 text-red-800'
                            }`}>
                              {equip.status}
                            </span>
                            {canManageZones && (
                              <button
                                onClick={() => handleRemoveEquipment(equip.id)}
                                className="text-red-600 hover:text-red-800 p-1"
                                title="Remove from zone"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="bg-gray-50 rounded-lg p-4 text-center">
                      <p className="text-gray-500">No equipment assigned to this zone</p>
                      {canManageZones && (
                        <button
                          onClick={openAssignEquipmentModal}
                          className="mt-2 text-blue-600 hover:text-blue-800 text-sm"
                        >
                          Assign equipment now
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Child Zones */}
                {zoneDetail.children && zoneDetail.children.length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium text-gray-500 mb-2">
                      Child Zones ({zoneDetail.children.length})
                    </h3>
                    <div className="bg-white border border-gray-200 rounded-lg divide-y">
                      {zoneDetail.children.map((child) => (
                        <div key={child.id} className="p-3">
                          <p className="font-medium text-gray-900">{child.name}</p>
                          {child.description && (
                            <p className="text-sm text-gray-500">{child.description}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : null}

            <div className="mt-6 flex justify-end">
              <button
                onClick={closeDetailModal}
                className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Assign Equipment Modal */}
      {showAssignEquipmentModal && selectedZone && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60]">
          <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md">
            <h2 className="text-xl font-bold text-gray-900 mb-4">
              Assign Equipment to {selectedZone.name}
            </h2>

            {loadingEquipment ? (
              <div className="flex justify-center items-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
              </div>
            ) : availableEquipment.length === 0 ? (
              <div className="py-4 text-center">
                <p className="text-gray-500">No available equipment to assign.</p>
                <p className="text-sm text-gray-400 mt-1">
                  All equipment is either already assigned to this zone or no equipment exists.
                </p>
              </div>
            ) : (
              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Select Equipment
                </label>
                <select
                  value={selectedEquipmentId}
                  onChange={(e) => setSelectedEquipmentId(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">-- Select Equipment --</option>
                  {availableEquipment.map((equip) => (
                    <option key={equip.id} value={equip.id}>
                      {equip.name} ({equip.type} - {equip.status})
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={closeAssignEquipmentModal}
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg"
                disabled={assigningEquipment}
              >
                Cancel
              </button>
              {availableEquipment.length > 0 && (
                <button
                  onClick={handleAssignEquipment}
                  disabled={assigningEquipment || !selectedEquipmentId}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg disabled:opacity-50"
                >
                  {assigningEquipment ? 'Assigning...' : 'Assign'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
