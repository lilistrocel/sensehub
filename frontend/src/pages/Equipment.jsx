import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

const API_BASE = '/api';

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

  // Check if user can control equipment (admin or operator only)
  const canControl = user?.role === 'admin' || user?.role === 'operator';

  useEffect(() => {
    if (isOpen && equipment) {
      fetchDetails();
      fetchAllZones();
    }
  }, [isOpen, equipment]);

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
        throw new Error('Failed to fetch equipment details');
      }

      const data = await response.json();
      setDetails(data);
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
          ) : (
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

              {/* Enabled */}
              <div className="flex items-center justify-between py-3 border-b border-gray-100">
                <span className="text-sm font-medium text-gray-500">Enabled</span>
                <span className={`text-sm font-medium ${eq?.enabled ? 'text-green-600' : 'text-gray-400'}`}>
                  {eq?.enabled ? 'Yes' : 'No'}
                </span>
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
            </div>
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

// Add Equipment Modal
function AddEquipmentModal({ isOpen, onClose, onSuccess, token }) {
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    type: '',
    protocol: 'modbus',
    address: ''
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSuccessMessage(null);

    if (!formData.name.trim()) {
      setError('Name is required');
      return;
    }

    setSaving(true);

    try {
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
          address: formData.address.trim()
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
        address: ''
      });

      // Notify parent and close after a brief delay
      setTimeout(() => {
        onSuccess(newEquipment);
        onClose();
        setSuccessMessage(null);
      }, 1500);

    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
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

          {/* Error Message */}
          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
              <div className="flex items-center">
                <svg className="h-5 w-5 text-red-500 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-red-800 text-sm">{error}</span>
              </div>
            </div>
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
    address: ''
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);

  // Initialize form data when equipment changes
  useEffect(() => {
    if (equipment) {
      setFormData({
        name: equipment.name || '',
        description: equipment.description || '',
        type: equipment.type || '',
        protocol: equipment.protocol || 'modbus',
        address: equipment.address || ''
      });
      setError(null);
      setSuccessMessage(null);
    }
  }, [equipment]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSuccessMessage(null);

    if (!formData.name.trim()) {
      setError('Name is required');
      return;
    }

    setSaving(true);

    try {
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
          address: formData.address.trim()
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
      setError(err.message);
    } finally {
      setSaving(false);
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

          {/* Error Message */}
          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
              <div className="flex items-center">
                <svg className="h-5 w-5 text-red-500 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-red-800 text-sm">{error}</span>
              </div>
            </div>
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

  useEffect(() => {
    fetchData();
  }, [token]);

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

  const handleViewEquipment = (eq) => {
    setSelectedEquipment(eq);
    setShowDetailModal(true);
  };

  const handleEditEquipment = (eq) => {
    setSelectedEquipment(eq);
    setShowEditModal(true);
  };

  const handleEditSuccess = () => {
    fetchData();
  };

  // Filter equipment based on search and status
  const filteredEquipment = equipment.filter(eq => {
    const matchesSearch = !searchTerm ||
      eq.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      eq.type?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      eq.description?.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesStatus = !statusFilter || eq.status === statusFilter;

    return matchesSearch && matchesStatus;
  });

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

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Equipment</h1>
        <button
          onClick={() => setShowAddModal(true)}
          className="bg-primary-600 text-white px-4 py-2 rounded-lg hover:bg-primary-700 transition-colors flex items-center"
        >
          <svg className="h-5 w-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Equipment
        </button>
      </div>

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
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Name
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Type
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Zone
                </th>
                <th scope="col" className="relative px-6 py-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {filteredEquipment.map((eq) => (
                <tr
                  key={eq.id}
                  className="hover:bg-gray-50 transition-colors cursor-pointer"
                  onClick={() => handleViewEquipment(eq)}
                >
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center">
                      <div className="flex-shrink-0 h-10 w-10 bg-gray-100 rounded-lg flex items-center justify-center">
                        <svg className="h-6 w-6 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
                        </svg>
                      </div>
                      <div className="ml-4">
                        <div className="text-sm font-medium text-gray-900">{eq.name}</div>
                        {eq.description && (
                          <div className="text-sm text-gray-500 truncate max-w-xs">{eq.description}</div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm text-gray-900">{eq.type || '-'}</div>
                    {eq.protocol && (
                      <div className="text-xs text-gray-500 uppercase">{eq.protocol}</div>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <StatusBadge status={eq.status} />
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
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleEditEquipment(eq);
                      }}
                      className="text-gray-600 hover:text-gray-900"
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Equipment count */}
      {equipment.length > 0 && (
        <div className="mt-4 text-sm text-gray-500">
          Showing {filteredEquipment.length} of {equipment.length} equipment
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
        onClose={() => {
          setShowDetailModal(false);
          setSelectedEquipment(null);
        }}
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
    </div>
  );
}
