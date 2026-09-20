import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useAuthedImage } from '../hooks/useAuthedImage';

const API_BASE = '/api';
const SNAPSHOT_REFRESH_INTERVAL = 30000; // 30s
const STALE_CAPTURE_MS = 24 * 60 * 60 * 1000; // 24 h

/**
 * Live snapshot thumbnail. /api/cameras/:id/snapshot sits behind the bearer-token
 * auth middleware, so a plain <img src> gets a 401; we fetch it with the token
 * and render the resulting object URL instead.
 */
function CameraSnapshot({ cameraId, tick, alt }) {
  const { src, loading, error } = useAuthedImage(
    `${API_BASE}/cameras/${cameraId}/snapshot?t=${tick}`
  );

  if (src) {
    return <img src={src} alt={alt} className="w-full h-full object-cover" />;
  }
  return (
    <div className="w-full h-full flex items-center justify-center" aria-live="polite">
      <p className="text-gray-500 text-sm px-4 text-center">
        {loading ? 'Loading snapshot...' : (error ? `Snapshot unavailable (${error})` : 'Snapshot unavailable')}
      </p>
    </div>
  );
}

export default function Cameras() {
  const { token, user } = useAuth();
  const { showError, showSuccess } = useToast();
  const [cameras, setCameras] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showLiveModal, setShowLiveModal] = useState(null);
  const [selectedCamera, setSelectedCamera] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(null);
  const [snapshotTick, setSnapshotTick] = useState(0);
  const [storedSnapshots, setStoredSnapshots] = useState({});
  const [selectedHistory, setSelectedHistory] = useState(null);
  const [capturing, setCapturing] = useState(null);

  const canManage = user?.role === 'admin' || user?.role === 'operator';
  const canDelete = user?.role === 'admin';

  const emptyForm = {
    name: '', description: '', ip_address: '', rtsp_port: '554', http_port: '80',
    username: '', password: '', stream_url: '/Streaming/Channels/101',
    manufacturer: 'Hikvision', model: '', enabled: true
  };
  const [form, setForm] = useState(emptyForm);

  useEffect(() => {
    fetchCameras();
    fetchStoredSnapshots();
  }, []);

  // Auto-refresh snapshots
  useEffect(() => {
    const timer = setInterval(() => setSnapshotTick(t => t + 1), SNAPSHOT_REFRESH_INTERVAL);
    return () => clearInterval(timer);
  }, []);

  const fetchCameras = async () => {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/cameras`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to fetch cameras');
      setCameras(await res.json());
    } catch (err) {
      showError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchStoredSnapshots = async () => {
    try {
      const res = await fetch(`${API_BASE}/cameras/snapshots/latest`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        const map = {};
        data.forEach(s => { map[s.camera_id] = s; });
        setStoredSnapshots(map);
      } else {
        showError('Could not load stored snapshots');
      }
    } catch (err) {
      showError(`Could not load stored snapshots: ${err.message}`);
    }
  };

  const fetchCameraHistory = async (cameraId) => {
    try {
      const res = await fetch(`${API_BASE}/cameras/${cameraId}/snapshots?limit=42`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) return await res.json();
      showError('Could not load snapshot history');
    } catch (err) {
      showError(`Could not load snapshot history: ${err.message}`);
    }
    return [];
  };

  // "Last capture" wording: none yet / fresh / stale (> 24 h old)
  const captureInfo = (snap) => {
    if (!snap || !snap.captured_at) return { text: 'No capture yet', stale: false, none: true };
    const age = Date.now() - new Date(snap.captured_at).getTime();
    if (Number.isNaN(age)) return { text: `Last capture: ${formatDate(snap.captured_at)}`, stale: false };
    if (age > STALE_CAPTURE_MS) {
      const days = Math.floor(age / (24 * 60 * 60 * 1000));
      return {
        text: `Stale capture: last saved ${formatDate(snap.captured_at)} (${days >= 1 ? `${days} day${days === 1 ? '' : 's'}` : 'over 24 h'} ago)`,
        stale: true,
      };
    }
    return { text: `Last capture: ${formatDate(snap.captured_at)}`, stale: false };
  };

  const handleCapture = async (camera) => {
    setCapturing(camera.id);
    try {
      const res = await fetch(`${API_BASE}/cameras/${camera.id}/capture`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Capture failed');
      showSuccess(`Snapshot captured for ${camera.name}`);
      fetchStoredSnapshots();
    } catch (err) {
      showError(err.message);
    } finally {
      setCapturing(null);
    }
  };

  const openHistory = async (camera) => {
    const snaps = await fetchCameraHistory(camera.id);
    setSelectedHistory({ camera, snapshots: snaps });
  };

  const formatDate = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  };

  const handleAdd = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/cameras`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          rtsp_port: parseInt(form.rtsp_port) || 554,
          http_port: parseInt(form.http_port) || 80
        })
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || 'Failed to add camera');
      }
      showSuccess('Camera added successfully');
      setShowAddModal(false);
      setForm(emptyForm);
      fetchCameras();
    } catch (err) {
      showError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/cameras/${selectedCamera.id}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          rtsp_port: parseInt(form.rtsp_port) || 554,
          http_port: parseInt(form.http_port) || 80
        })
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || 'Failed to update camera');
      }
      showSuccess('Camera updated successfully');
      setShowEditModal(false);
      setSelectedCamera(null);
      fetchCameras();
    } catch (err) {
      showError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/cameras/${selectedCamera.id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to delete camera');
      showSuccess('Camera deleted');
      setShowDeleteModal(false);
      setSelectedCamera(null);
      fetchCameras();
    } catch (err) {
      showError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (camera) => {
    setTesting(camera.id);
    try {
      const res = await fetch(`${API_BASE}/cameras/${camera.id}/test`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (data.success) {
        showSuccess(data.message);
      } else {
        showError(data.message, 'Connection test failed');
      }
      fetchCameras();
    } catch (err) {
      showError(err.message);
    } finally {
      setTesting(null);
    }
  };

  const openEdit = (camera) => {
    setSelectedCamera(camera);
    setForm({
      name: camera.name || '',
      description: camera.description || '',
      ip_address: camera.ip_address || '',
      rtsp_port: String(camera.rtsp_port || 554),
      http_port: String(camera.http_port || 80),
      username: camera.username || '',
      password: '',
      stream_url: camera.stream_url || '',
      manufacturer: camera.manufacturer || '',
      model: camera.model || '',
      enabled: !!camera.enabled
    });
    setShowEditModal(true);
  };

  const openDelete = (camera) => {
    setSelectedCamera(camera);
    setShowDeleteModal(true);
  };

  const statusBadge = (status) => {
    const styles = {
      online: 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300',
      offline: 'bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-300',
      error: 'bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300'
    };
    return (
      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${styles[status] || styles.offline}`}>
        <span className={`w-1.5 h-1.5 rounded-full mr-1.5 ${status === 'online' ? 'bg-green-500' : status === 'error' ? 'bg-red-500' : 'bg-gray-400'}`} />
        {status}
      </span>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Cameras</h1>
        {canManage && (
          <button
            onClick={() => { setForm(emptyForm); setShowAddModal(true); }}
            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg flex items-center gap-2"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add Camera
          </button>
        )}
      </div>

      {cameras.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-12 text-center">
          <svg className="w-16 h-16 mx-auto text-gray-300 dark:text-gray-600 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          <p className="text-gray-500 dark:text-gray-400 text-lg">No cameras configured yet</p>
          {canManage && (
            <button onClick={() => { setForm(emptyForm); setShowAddModal(true); }}
              className="mt-4 text-blue-600 dark:text-blue-400 hover:underline">
              Add your first camera
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {cameras.map(camera => (
            <div key={camera.id} className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
              {/* Snapshot thumbnail */}
              <div
                className="relative bg-gray-900 aspect-video cursor-pointer group"
                onClick={() => camera.status === 'online' && setShowLiveModal(camera)}
              >
                {camera.status === 'online' ? (
                  <>
                    <CameraSnapshot cameraId={camera.id} tick={snapshotTick} alt={camera.name} />
                    <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-30 transition-all flex items-center justify-center">
                      <svg className="w-12 h-12 text-white opacity-0 group-hover:opacity-100 transition-opacity" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    </div>
                  </>
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <div className="text-center">
                      <svg className="w-12 h-12 mx-auto text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                      <p className="text-gray-500 text-sm mt-2">{camera.status === 'error' ? 'Connection error' : 'Offline'}</p>
                    </div>
                  </div>
                )}
                <div className="absolute top-2 right-2">
                  {statusBadge(camera.status)}
                </div>
              </div>

              {/* Camera info */}
              <div className="p-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <h3 className="text-lg font-semibold text-gray-900 dark:text-white truncate">{camera.name}</h3>
                    {camera.description && (
                      <p className="text-gray-500 dark:text-gray-400 text-sm mt-0.5 truncate">{camera.description}</p>
                    )}
                    <p className="text-gray-400 dark:text-gray-500 text-xs mt-1">
                      {camera.ip_address && `${camera.ip_address}`}
                      {camera.manufacturer && ` - ${camera.manufacturer}`}
                      {camera.model && ` ${camera.model}`}
                    </p>
                    {camera.error_message && (
                      <p className="text-red-500 text-xs mt-1 truncate" title={camera.error_message}>{camera.error_message}</p>
                    )}
                  </div>
                </div>

                {/* Last stored snapshot info */}
                {(() => {
                  const info = captureInfo(storedSnapshots[camera.id]);
                  return (
                    <p className={`text-xs mt-1 ${
                      info.stale ? 'text-amber-600 dark:text-amber-400' : 'text-gray-400 dark:text-gray-500'
                    }`}>
                      {info.text}
                    </p>
                  );
                })()}

                {/* Actions */}
                <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-100 dark:border-gray-700">
                  {canManage && (
                    <button onClick={() => handleCapture(camera)} disabled={capturing === camera.id}
                      className="text-xs px-3 py-1.5 rounded bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/40 disabled:opacity-50">
                      {capturing === camera.id ? 'Capturing...' : 'Capture Now'}
                    </button>
                  )}
                  <button onClick={() => openHistory(camera)}
                    className="text-xs px-3 py-1.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600">
                    History
                  </button>
                  {canManage && (
                    <>
                      <button onClick={() => handleTest(camera)} disabled={testing === camera.id}
                        className="text-xs px-3 py-1.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50">
                        {testing === camera.id ? 'Testing...' : 'Test'}
                      </button>
                      <button onClick={() => openEdit(camera)}
                        className="text-xs px-3 py-1.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600">
                        Edit
                      </button>
                    </>
                  )}
                  {canDelete && (
                    <button onClick={() => openDelete(camera)}
                      className="text-xs px-3 py-1.5 rounded bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 ml-auto">
                      Delete
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Camera Modal */}
      <Modal show={showAddModal} onClose={() => setShowAddModal(false)} title="Add Camera">
        <form onSubmit={handleAdd}>
          <div className="px-6 py-4"><FormFields form={form} setForm={setForm} isEdit={false} /></div>
          <div className="px-6 py-4 bg-gray-50 dark:bg-gray-700/50 flex justify-end gap-3">
            <button type="button" onClick={() => setShowAddModal(false)}
              className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-600 border border-gray-300 dark:border-gray-500 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-500">
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50">
              {saving ? 'Adding...' : 'Add Camera'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Edit Camera Modal */}
      <Modal show={showEditModal} onClose={() => setShowEditModal(false)} title="Edit Camera">
        <form onSubmit={handleEdit}>
          <div className="px-6 py-4"><FormFields form={form} setForm={setForm} isEdit={true} /></div>
          <div className="px-6 py-4 bg-gray-50 dark:bg-gray-700/50 flex justify-end gap-3">
            <button type="button" onClick={() => setShowEditModal(false)}
              className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-600 border border-gray-300 dark:border-gray-500 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-500">
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50">
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal show={showDeleteModal} onClose={() => setShowDeleteModal(false)} title="Delete Camera">
        <div className="px-6 py-4">
          <p className="text-gray-700 dark:text-gray-300">
            Are you sure you want to delete <strong>{selectedCamera?.name}</strong>? This will also remove the stream from go2rtc.
          </p>
        </div>
        <div className="px-6 py-4 bg-gray-50 dark:bg-gray-700/50 flex justify-end gap-3">
          <button onClick={() => setShowDeleteModal(false)}
            className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-600 border border-gray-300 dark:border-gray-500 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-500">
            Cancel
          </button>
          <button onClick={handleDelete} disabled={saving}
            className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50">
            {saving ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </Modal>

      {/* Live View Modal */}
      {showLiveModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-90">
          <div className="relative w-full max-w-5xl mx-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-white text-xl font-semibold">{showLiveModal.name}</h2>
              <button onClick={() => setShowLiveModal(null)}
                className="text-gray-400 hover:text-white p-2">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <LivePlayer camera={showLiveModal} />
          </div>
        </div>
      )}

      {/* Snapshot History Modal */}
      {selectedHistory && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-start justify-center min-h-screen px-4 pt-8 pb-20">
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75 dark:bg-gray-900 dark:bg-opacity-75" onClick={() => setSelectedHistory(null)} />
            <div className="relative w-full max-w-5xl bg-white dark:bg-gray-800 rounded-lg shadow-xl">
              <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{selectedHistory.camera.name} - Snapshot History</h2>
                  <p className="text-sm text-gray-500 dark:text-gray-400">{selectedHistory.snapshots.length} snapshots (captured every 4 hours)</p>
                </div>
                <button onClick={() => setSelectedHistory(null)}
                  className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 p-2">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="p-4">
                {selectedHistory.snapshots.length === 0 ? (
                  <div className="text-center py-12 text-gray-500 dark:text-gray-400">
                    <svg className="w-12 h-12 mx-auto mb-3 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                    <p>No snapshots yet. The first capture runs 1 minute after startup, then every 4 hours.</p>
                    {canManage && (
                      <button onClick={() => { handleCapture(selectedHistory.camera); }}
                        className="mt-3 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
                        Capture Now
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                    {selectedHistory.snapshots.map(snap => (
                      <div key={snap.id} className="group relative">
                        <a href={`${API_BASE}/cameras/snapshots/file/${snap.filename}`} target="_blank" rel="noopener noreferrer">
                          <img
                            src={`${API_BASE}/cameras/snapshots/file/${snap.filename}`}
                            alt={formatDate(snap.captured_at)}
                            className="w-full aspect-video object-cover rounded-lg border border-gray-200 dark:border-gray-700 group-hover:border-blue-500 transition-colors"
                            loading="lazy"
                          />
                        </a>
                        <div className="mt-1 flex items-center justify-between">
                          <p className="text-xs text-gray-500 dark:text-gray-400">{formatDate(snap.captured_at)}</p>
                          <p className="text-[10px] text-gray-400">{(snap.file_size / 1024).toFixed(0)} KB</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Hoisted to module scope so it keeps a stable identity across renders of
// Cameras() — otherwise React remounts these inputs on every keystroke and the
// cursor jumps out of the field while typing. State is passed in via props.
const inputCls = "w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-white";

function FormFields({ form, setForm, isEdit }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name *</label>
          <input type="text" required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
            className={inputCls} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">IP Address *</label>
          <input type="text" required value={form.ip_address} onChange={e => setForm({ ...form, ip_address: e.target.value })}
            placeholder="192.168.1.104"
            className={inputCls} />
        </div>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
        <input type="text" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })}
          className={inputCls} />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">RTSP Port</label>
          <input type="number" value={form.rtsp_port} onChange={e => setForm({ ...form, rtsp_port: e.target.value })}
            className={inputCls} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">HTTP Port</label>
          <input type="number" value={form.http_port} onChange={e => setForm({ ...form, http_port: e.target.value })}
            className={inputCls} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Manufacturer</label>
          <input type="text" value={form.manufacturer} onChange={e => setForm({ ...form, manufacturer: e.target.value })}
            className={inputCls} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Model</label>
          <input type="text" value={form.model} onChange={e => setForm({ ...form, model: e.target.value })}
            className={inputCls} />
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Username</label>
          <input type="text" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })}
            autoComplete="off"
            className={inputCls} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Password</label>
          <input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })}
            autoComplete="new-password"
            placeholder={isEdit ? '(unchanged if empty)' : ''}
            className={inputCls} />
        </div>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">RTSP Stream Path</label>
        <input type="text" value={form.stream_url} onChange={e => setForm({ ...form, stream_url: e.target.value })}
          placeholder="/Streaming/Channels/101"
          className={inputCls} />
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Hikvision default: /Streaming/Channels/101 (main) or /102 (sub)</p>
      </div>
      <div className="flex items-center">
        <input type="checkbox" id="enabled" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })}
          className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded" />
        <label htmlFor="enabled" className="ml-2 text-sm text-gray-700 dark:text-gray-300">Enabled</label>
      </div>
    </div>
  );
}

// Modal wrapper component — hoisted to module scope for stable identity.
function Modal({ show, onClose, title, children }) {
  if (!show) return null;
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:p-0">
        <div className="fixed inset-0 bg-gray-500 dark:bg-gray-900 bg-opacity-75 dark:bg-opacity-75 transition-opacity" onClick={onClose} />
        <div className="relative bg-white dark:bg-gray-800 rounded-lg text-left overflow-hidden shadow-xl transform transition-all sm:max-w-lg sm:w-full">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h3>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

// MSE live player component with MJPEG fallback
function LivePlayer({ camera }) {
  const videoRef = useRef(null);
  const wsRef = useRef(null);
  const [mode, setMode] = useState('mse'); // 'mse' | 'mjpeg'
  const [error, setError] = useState(null);

  useEffect(() => {
    if (mode === 'mse') {
      startMSE();
    }
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [mode, camera.go2rtc_name]);

  const startMSE = () => {
    setError(null);
    const video = videoRef.current;
    if (!video || !window.MediaSource) {
      setMode('mjpeg');
      return;
    }

    const ms = new MediaSource();
    video.src = URL.createObjectURL(ms);

    ms.addEventListener('sourceopen', () => {
      const wsUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/camera-stream/api/ws?src=${encodeURIComponent(camera.go2rtc_name)}`;
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      let sb = null;
      let queue = [];

      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          // Codec info message from go2rtc
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'mse' && msg.value) {
              // msg.value is the codec string e.g. "video/mp4; codecs=\"avc1.640029\""
              if (!sb) {
                try {
                  sb = ms.addSourceBuffer(msg.value);
                  sb.mode = 'segments';
                  sb.addEventListener('updateend', () => {
                    if (queue.length > 0 && !sb.updating) {
                      sb.appendBuffer(queue.shift());
                    }
                  });
                } catch (e) {
                  console.warn('[MSE] addSourceBuffer failed:', e);
                  setError('MSE codec not supported');
                  setMode('mjpeg');
                }
              }
            }
          } catch (e) {
            // ignore non-JSON
          }
          return;
        }

        // Binary data — append to source buffer
        if (sb) {
          if (sb.updating || queue.length > 0) {
            queue.push(ev.data);
          } else {
            try {
              sb.appendBuffer(ev.data);
            } catch (e) {
              // Buffer full or error — skip
            }
          }
        }
      };

      ws.onerror = () => {
        setError('WebSocket connection failed');
        setMode('mjpeg');
      };

      ws.onclose = () => {
        // Don't switch to mjpeg on normal close
      };
    });

    video.play().catch(() => {});
  };

  if (mode === 'mjpeg') {
    const mjpegUrl = `/camera-stream/api/frame.mp4?src=${encodeURIComponent(camera.go2rtc_name)}`;
    return (
      <div>
        <img src={mjpegUrl} alt={camera.name} className="w-full rounded-lg bg-black" />
        <div className="flex items-center gap-4 mt-3">
          <span className="text-gray-400 text-sm">MJPEG fallback mode</span>
          <button onClick={() => setMode('mse')} className="text-blue-400 text-sm hover:underline">
            Try MSE again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <video ref={videoRef} autoPlay muted playsInline className="w-full rounded-lg bg-black" />
      {error && (
        <p className="text-yellow-400 text-sm mt-2">{error}</p>
      )}
      <div className="flex items-center gap-4 mt-3">
        <span className="text-gray-400 text-sm">MSE live stream</span>
        <button onClick={() => setMode('mjpeg')} className="text-blue-400 text-sm hover:underline">
          Switch to MJPEG
        </button>
      </div>
    </div>
  );
}
