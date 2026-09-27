import React, { useState, useEffect } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useSettings } from '../context/SettingsContext';

const API_BASE = '/api';

export default function Zones() {
  const { t } = useTranslation('zones');
  const { token, user } = useAuth();
  const { formatDateTime } = useSettings();
  const { showError, showSuccess } = useToast();
  const { id: urlZoneId } = useParams();
  const navigate = useNavigate();
  const [zones, setZones] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newZone, setNewZone] = useState({ name: '', description: '', parent_id: '' });
  const [saving, setSaving] = useState(false);
  const [selectedZone, setSelectedZone] = useState(null);
  const [zoneDetail, setZoneDetail] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [showAssignEquipmentModal, setShowAssignEquipmentModal] = useState(false);
  const [availableEquipment, setAvailableEquipment] = useState([]);
  const [loadingEquipment, setLoadingEquipment] = useState(false);
  const [selectedEquipmentId, setSelectedEquipmentId] = useState('');
  const [assigningEquipment, setAssigningEquipment] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editZone, setEditZone] = useState({ name: '', description: '', parent_id: '' });
  const [editSaving, setEditSaving] = useState(false);
  const [editSuccess, setEditSuccess] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    fetchZones();
  }, []);

  // Handle deep linking - open zone detail when URL contains zone ID
  useEffect(() => {
    if (urlZoneId && zones.length > 0 && !loading) {
      const zone = zones.find(z => z.id === parseInt(urlZoneId, 10));
      if (zone) {
        setSelectedZone(zone);
        fetchZoneDetail(zone.id);
      }
    }
  }, [urlZoneId, zones, loading]);

  const fetchZones = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${API_BASE}/zones`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        throw new Error(t('err.fetchZones'));
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
        throw new Error(t('err.fetchDetail'));
      }

      const data = await response.json();
      setZoneDetail(data);
    } catch (err) {
      showError(err.message, t('err.loadDetail'));
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
    // If we navigated here via deep link, go back to zones list
    if (urlZoneId) {
      navigate('/zones');
    }
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
        throw new Error(t('err.fetchEquipment'));
      }

      const allEquipment = await response.json();

      // Filter out equipment already in this zone
      const assignedIds = new Set((zoneDetail?.equipment || []).map(e => e.id));
      const available = allEquipment.filter(e => !assignedIds.has(e.id));

      setAvailableEquipment(available);
    } catch (err) {
      showError(err.message, t('err.loadEquipment'));
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
        throw new Error(err.message || t('err.assign'));
      }

      // Refresh zone detail to show newly assigned equipment
      await fetchZoneDetail(selectedZone.id);
      closeAssignEquipmentModal();
      // Refresh zones list to update equipment counts
      fetchZones();
      showSuccess(t('toast.assigned'));
    } catch (err) {
      showError(err.message, t('err.assign'));
    } finally {
      setAssigningEquipment(false);
    }
  };

  const handleRemoveEquipment = async (equipmentId) => {
    if (!selectedZone) return;

    if (!confirm(t('confirmRemoveEquipment'))) return;

    try {
      const response = await fetch(`${API_BASE}/zones/${selectedZone.id}/equipment/${equipmentId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || t('err.remove'));
      }

      // Refresh zone detail
      await fetchZoneDetail(selectedZone.id);
      // Refresh zones list to update equipment counts
      fetchZones();
      showSuccess(t('toast.removed'));
    } catch (err) {
      showError(err.message, t('err.remove'));
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
        body: JSON.stringify({
          name: newZone.name.trim(),
          description: newZone.description.trim(),
          parent_id: newZone.parent_id ? parseInt(newZone.parent_id) : null
        })
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || t('err.create'));
      }

      setNewZone({ name: '', description: '', parent_id: '' });
      setShowAddModal(false);
      fetchZones();
      showSuccess(t('toast.created'));
    } catch (err) {
      showError(err.message, t('err.create'));
    } finally {
      setSaving(false);
    }
  };

  const canManageZones = user?.role === 'admin' || user?.role === 'operator';

  // Filter zones based on search term
  const filteredZones = zones.filter((zone) => {
    if (!searchTerm.trim()) return true;
    const searchLower = searchTerm.toLowerCase().trim();
    return (
      zone.name.toLowerCase().includes(searchLower) ||
      (zone.description && zone.description.toLowerCase().includes(searchLower))
    );
  });

  const openEditModal = () => {
    if (zoneDetail) {
      setEditZone({
        name: zoneDetail.name || '',
        description: zoneDetail.description || '',
        parent_id: zoneDetail.parent_id || ''
      });
      setShowEditModal(true);
      setEditSuccess(false);
    }
  };

  const closeEditModal = () => {
    setShowEditModal(false);
    setEditZone({ name: '', description: '', parent_id: '' });
    setEditSuccess(false);
  };

  const handleEditZone = async (e) => {
    e.preventDefault();
    if (!editZone.name.trim() || !selectedZone) return;

    try {
      setEditSaving(true);
      const response = await fetch(`${API_BASE}/zones/${selectedZone.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          name: editZone.name.trim(),
          description: editZone.description.trim(),
          parent_id: editZone.parent_id ? parseInt(editZone.parent_id) : null
        })
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || t('err.update'));
      }

      // Update the selected zone and zone detail
      const updatedZone = await response.json();
      setSelectedZone({ ...selectedZone, name: updatedZone.name, description: updatedZone.description, parent_id: updatedZone.parent_id });
      setZoneDetail({ ...zoneDetail, name: updatedZone.name, description: updatedZone.description, parent_id: updatedZone.parent_id, updated_at: updatedZone.updated_at });

      // Refresh zones list
      fetchZones();

      // Show success and close modal
      setEditSuccess(true);
      setTimeout(() => {
        closeEditModal();
      }, 1500);
      showSuccess(t('toast.updated'));
    } catch (err) {
      showError(err.message, t('err.update'));
    } finally {
      setEditSaving(false);
    }
  };

  const openDeleteModal = () => {
    setShowDeleteModal(true);
  };

  const closeDeleteModal = () => {
    setShowDeleteModal(false);
  };

  const handleDeleteZone = async () => {
    if (!selectedZone) return;

    try {
      setDeleting(true);
      const response = await fetch(`${API_BASE}/zones/${selectedZone.id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || t('err.delete'));
      }

      // Close modals and refresh list
      closeDeleteModal();
      closeDetailModal();
      fetchZones();
      showSuccess(t('toast.deleted'));
    } catch (err) {
      showError(err.message, t('err.delete'));
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-6">{t('title')}</h1>
        <div className="flex justify-center items-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-6">{t('title')}</h1>
        <div role="alert" aria-live="assertive" className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
          <p className="text-red-600">{error}</p>
          <button
            onClick={fetchZones}
            className="mt-2 text-sm text-red-700 underline"
          >
            {t('common:actions.tryAgain')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t('title')}</h1>
        {canManageZones && (
          <button
            onClick={() => setShowAddModal(true)}
            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg flex items-center gap-2"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            {t('addZone')}
          </button>
        )}
      </div>

      {/* Search Bar */}
      <div className="mb-6">
        <div className="relative max-w-md">
          <div className="absolute inset-y-0 start-0 ps-3 flex items-center pointer-events-none">
            <svg className="h-5 w-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <input
            type="text"
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="block w-full ps-10 pe-10 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400"
          />
          {searchTerm && (
            <button
              onClick={() => setSearchTerm('')}
              className="absolute inset-y-0 end-0 pe-3 flex items-center"
              aria-label={t('clearSearch')}
              title={t('clearSearch')}
            >
              <svg className="h-5 w-5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
        {searchTerm && (
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
            {t('showingCount', { shown: filteredZones.length, count: zones.length })}
          </p>
        )}
      </div>

      {zones.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
          <p className="text-gray-500 dark:text-gray-400 text-center">{t('empty')}</p>
        </div>
      ) : filteredZones.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
          <p className="text-gray-500 dark:text-gray-400 text-center">{t('noMatch')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredZones.map((zone) => (
            <div
              key={zone.id}
              onClick={() => handleZoneClick(zone)}
              className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 hover:shadow-md transition-shadow cursor-pointer"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <h3 dir="auto" className="text-lg font-semibold text-gray-900 dark:text-white">{zone.name}</h3>
                  {zone.description && (
                    <p dir="auto" className="text-gray-500 dark:text-gray-400 text-sm mt-1">{zone.description}</p>
                  )}
                </div>
                <div className="ms-4 shrink-0">
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300">
                    <svg className="w-3 h-3 me-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
                    </svg>
                    {t('equipmentCount', { count: zone.equipment_count ?? 0 })}
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
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 w-full max-w-md">
            <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-4">{t('addTitle')}</h2>
            <form onSubmit={handleAddZone}>
              <div className="mb-4">
                <label htmlFor="zone-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('form.name')} *
                </label>
                <input
                  id="zone-name"
                  type="text"
                  value={newZone.name}
                  onChange={(e) => setNewZone({ ...newZone, name: e.target.value })}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400"
                  placeholder={t('form.namePlaceholder')}
                  dir="auto"
                  required
                />
              </div>
              <div className="mb-4">
                <label htmlFor="zone-description" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('form.description')}
                </label>
                <textarea
                  id="zone-description"
                  value={newZone.description}
                  onChange={(e) => setNewZone({ ...newZone, description: e.target.value })}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400"
                  placeholder={t('form.descriptionPlaceholder')}
                  dir="auto"
                  rows={3}
                />
              </div>
              <div className="mb-6">
                <label htmlFor="zone-parent" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('form.parent')}
                </label>
                <select
                  id="zone-parent"
                  value={newZone.parent_id}
                  onChange={(e) => setNewZone({ ...newZone, parent_id: e.target.value })}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400"
                >
                  <option value="">{t('form.parentNone')}</option>
                  {zones.map((zone) => (
                    <option key={zone.id} value={zone.id}>
                      {zone.name}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {t('form.parentHelp')}
                </p>
              </div>
              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
                  disabled={saving}
                >
                  {t('common:actions.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={saving || !newZone.name.trim()}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg disabled:opacity-50"
                >
                  {saving ? t('form.creating') : t('form.create')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Zone Detail Modal */}
      {selectedZone && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 w-full max-w-2xl max-h-[80vh] overflow-y-auto">
            <div className="flex justify-between items-start mb-4">
              <h2 dir="auto" className="text-xl font-bold text-gray-900 dark:text-white min-w-0 break-words">{selectedZone.name}</h2>
              <div className="flex items-center gap-2">
                {canManageZones && (
                  <>
                    <button
                      onClick={openEditModal}
                      className="text-blue-600 hover:text-blue-800 p-1"
                      title={t('editZone')}
                      aria-label={t('editZone')}
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </button>
                    {user?.role === 'admin' && (
                      <button
                        onClick={openDeleteModal}
                        className="text-red-600 hover:text-red-800 p-1"
                        title={t('deleteZone')}
                        aria-label={t('deleteZone')}
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    )}
                  </>
                )}
                <button
                  onClick={closeDetailModal}
                  className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                  aria-label={t('common:actions.close')}
                  title={t('common:actions.close')}
                >
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            {loadingDetail ? (
              <div className="flex justify-center items-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
              </div>
            ) : zoneDetail ? (
              <div className="space-y-6">
                {/* Zone Info */}
                <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4">
                  <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">{t('info.title')}</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs text-gray-500 dark:text-gray-400">{t('info.name')}</p>
                      <p dir="auto" className="font-medium text-gray-900 dark:text-white break-words">{zoneDetail.name}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500 dark:text-gray-400">{t('info.id')}</p>
                      <p className="font-medium text-gray-900 dark:text-white">{zoneDetail.id}</p>
                    </div>
                  </div>
                  {zoneDetail.description && (
                    <div className="mt-4">
                      <p className="text-xs text-gray-500 dark:text-gray-400">{t('info.description')}</p>
                      <p dir="auto" className="text-gray-700 dark:text-gray-300">{zoneDetail.description}</p>
                    </div>
                  )}
                  {zoneDetail.parent_id && (
                    <div className="mt-4">
                      <p className="text-xs text-gray-500 dark:text-gray-400">{t('form.parent')}</p>
                      <p className="text-gray-700 dark:text-gray-300 font-medium">
                        {zones.find(z => z.id === zoneDetail.parent_id)?.name || t('zoneNumber', { id: zoneDetail.parent_id })}
                      </p>
                    </div>
                  )}
                  <div className="mt-4 grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs text-gray-500 dark:text-gray-400">{t('info.created')}</p>
                      <p className="text-gray-700 dark:text-gray-300">{formatDateTime(zoneDetail.created_at)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500 dark:text-gray-400">{t('info.updated')}</p>
                      <p className="text-gray-700 dark:text-gray-300">{formatDateTime(zoneDetail.updated_at)}</p>
                    </div>
                  </div>
                </div>

                {/* Assigned Equipment */}
                <div>
                  <div className="flex justify-between items-center mb-2">
                    <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">
                      {t('assigned.title', { count: zoneDetail.equipment?.length || 0 })}
                    </h3>
                    {canManageZones && (
                      <button
                        onClick={openAssignEquipmentModal}
                        className="text-sm bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded flex items-center gap-1"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                        </svg>
                        {t('assigned.assignButton')}
                      </button>
                    )}
                  </div>
                  {zoneDetail.equipment && zoneDetail.equipment.length > 0 ? (
                    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg divide-y divide-gray-200 dark:divide-gray-700">
                      {zoneDetail.equipment.map((equip) => (
                        <div key={equip.id} className="p-3 flex items-center justify-between">
                          <div>
                            <p dir="auto" className="font-medium text-gray-900 dark:text-white">{equip.name}</p>
                            <p dir="auto" className="text-sm text-gray-500 dark:text-gray-400">{equip.type} • {equip.protocol}</p>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className={`px-2 py-1 text-xs rounded-full ${
                              equip.status === 'online' ? 'bg-green-100 text-green-800' :
                              equip.status === 'offline' ? 'bg-gray-100 text-gray-800' :
                              equip.status === 'warning' ? 'bg-amber-100 text-amber-800' :
                              'bg-red-100 text-red-800'
                            }`}>
                              {t(`equipStatus.${equip.status}`, { defaultValue: equip.status })}
                            </span>
                            {canManageZones && (
                              <button
                                onClick={() => handleRemoveEquipment(equip.id)}
                                className="text-red-600 hover:text-red-800 p-1"
                                title={t('assigned.remove')}
                                aria-label={t('assigned.removeNamed', { name: equip.name })}
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
                    <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4 text-center">
                      <p className="text-gray-500 dark:text-gray-400">{t('assigned.empty')}</p>
                      {canManageZones && (
                        <button
                          onClick={openAssignEquipmentModal}
                          className="mt-2 text-blue-600 hover:text-blue-800 text-sm"
                        >
                          {t('assigned.assignNow')}
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Child Zones */}
                {zoneDetail.children && zoneDetail.children.length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">
                      {t('children', { count: zoneDetail.children.length })}
                    </h3>
                    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg divide-y divide-gray-200 dark:divide-gray-700">
                      {zoneDetail.children.map((child) => (
                        <div key={child.id} className="p-3">
                          <p dir="auto" className="font-medium text-gray-900 dark:text-white">{child.name}</p>
                          {child.description && (
                            <p dir="auto" className="text-sm text-gray-500 dark:text-gray-400">{child.description}</p>
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
                className="px-4 py-2 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded-lg"
              >
                {t('common:actions.close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Assign Equipment Modal */}
      {showAssignEquipmentModal && selectedZone && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60]">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 w-full max-w-md">
            <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-4">
              {t('assign.title', { name: selectedZone.name })}
            </h2>

            {loadingEquipment ? (
              <div className="flex justify-center items-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
              </div>
            ) : availableEquipment.length === 0 ? (
              <div className="py-4 text-center">
                <p className="text-gray-500 dark:text-gray-400">{t('assign.none')}</p>
                <p className="text-sm text-gray-400 mt-1">
                  {t('assign.noneHelp')}
                </p>
              </div>
            ) : (
              <div className="mb-6">
                <label htmlFor="select-equipment" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  {t('assign.select')}
                </label>
                <select
                  id="select-equipment"
                  value={selectedEquipmentId}
                  onChange={(e) => setSelectedEquipmentId(e.target.value)}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400"
                >
                  <option value="">{t('assign.selectOption')}</option>
                  {availableEquipment.map((equip) => (
                    <option key={equip.id} value={equip.id}>
                      {t('assign.option', { name: equip.name, type: equip.type, status: t(`equipStatus.${equip.status}`, { defaultValue: equip.status }) })}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={closeAssignEquipmentModal}
                className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
                disabled={assigningEquipment}
              >
                {t('common:actions.cancel')}
              </button>
              {availableEquipment.length > 0 && (
                <button
                  onClick={handleAssignEquipment}
                  disabled={assigningEquipment || !selectedEquipmentId}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg disabled:opacity-50"
                >
                  {assigningEquipment ? t('assign.assigning') : t('assign.assign')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Edit Zone Modal */}
      {showEditModal && selectedZone && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60]">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 w-full max-w-md">
            <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-4">{t('editTitle')}</h2>

            {editSuccess ? (
              <div className="py-6 text-center">
                <div className="mx-auto w-12 h-12 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mb-3">
                  <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <p className="text-green-600 font-medium">{t('updatedBanner')}</p>
              </div>
            ) : (
              <form onSubmit={handleEditZone}>
                <div className="mb-4">
                  <label htmlFor="edit-zone-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {t('form.name')} *
                  </label>
                  <input
                    id="edit-zone-name"
                    type="text"
                    value={editZone.name}
                    onChange={(e) => setEditZone({ ...editZone, name: e.target.value })}
                    className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400"
                    placeholder={t('form.namePlaceholder')}
                  dir="auto"
                    required
                  />
                </div>
                <div className="mb-4">
                  <label htmlFor="edit-zone-description" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {t('form.description')}
                  </label>
                  <textarea
                    id="edit-zone-description"
                    value={editZone.description}
                    onChange={(e) => setEditZone({ ...editZone, description: e.target.value })}
                    className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400"
                    placeholder={t('form.descriptionPlaceholder')}
                  dir="auto"
                    rows={3}
                  />
                </div>
                <div className="mb-6">
                  <label htmlFor="edit-zone-parent" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {t('form.parent')}
                  </label>
                  <select
                    id="edit-zone-parent"
                    value={editZone.parent_id || ''}
                    onChange={(e) => setEditZone({ ...editZone, parent_id: e.target.value })}
                    className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400"
                  >
                    <option value="">{t('form.parentNone')}</option>
                    {zones.filter(z => z.id !== selectedZone.id).map((zone) => (
                      <option key={zone.id} value={zone.id}>
                        {zone.name}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    {t('form.parentHelp')}
                  </p>
                </div>
                <div className="flex justify-end gap-3">
                  <button
                    type="button"
                    onClick={closeEditModal}
                    className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
                    disabled={editSaving}
                  >
                    {t('common:actions.cancel')}
                  </button>
                  <button
                    type="submit"
                    disabled={editSaving || !editZone.name.trim()}
                    className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg disabled:opacity-50"
                  >
                    {editSaving ? t('common:actions.saving') : t('form.saveChanges')}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Delete Zone Confirmation Modal */}
      {showDeleteModal && selectedZone && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[70]">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 w-full max-w-md">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center">
                <svg className="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <h2 className="text-xl font-bold text-gray-900 dark:text-white">{t('deleteTitle')}</h2>
            </div>

            <p className="text-gray-600 dark:text-gray-400 mb-4">
              <Trans t={t} i18nKey="delete.confirm" values={{ name: selectedZone.name }} components={{ b: <span dir="auto" className="font-semibold" /> }} />
            </p>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
              {t('delete.help')}
            </p>

            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={closeDeleteModal}
                className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
                disabled={deleting}
              >
                {t('common:actions.cancel')}
              </button>
              <button
                onClick={handleDeleteZone}
                disabled={deleting}
                className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg disabled:opacity-50"
              >
                {deleting ? t('delete.deleting') : t('deleteTitle')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
