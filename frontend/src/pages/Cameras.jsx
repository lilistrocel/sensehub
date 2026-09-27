import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '../i18n/useFormat';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useAuthedImage } from '../hooks/useAuthedImage';
import PtzControls from '../components/PtzControls';
import ConfirmDialog from '../components/ConfirmDialog';
import { Card, Button, StatusPill } from '../ui';

const CAMERA_STATE = {
  online: { state: 'ok', filled: true, rail: 'ok' },
  error: { state: 'alarm', filled: true, rail: 'alarm' },
  offline: { state: 'idle', filled: false, rail: 'idle' },
};

const API_BASE = '/api';
const SNAPSHOT_REFRESH_INTERVAL = 30000; // 30s
const STALE_CAPTURE_MS = 24 * 60 * 60 * 1000; // 24 h

/**
 * Live snapshot thumbnail. /api/cameras/:id/snapshot sits behind the bearer-token
 * auth middleware, so a plain <img src> gets a 401; we fetch it with the token
 * and render the resulting object URL instead.
 */
function CameraSnapshot({ cameraId, tick, alt }) {
  const { t } = useTranslation('cameras');
  const { src, loading, error } = useAuthedImage(
    `${API_BASE}/cameras/${cameraId}/snapshot?t=${tick}`
  );

  if (src) {
    return <img src={src} alt={alt} className="w-full h-full object-cover" />;
  }
  return (
    <div className="w-full h-full flex items-center justify-center" aria-live="polite">
      <p className="text-gray-500 text-sm px-4 text-center">
        {loading ? t('snapshot.loading') : (error ? t('snapshot.unavailableWithError', { error }) : t('snapshot.unavailable'))}
      </p>
    </div>
  );
}

export default function Cameras() {
  const { t } = useTranslation('cameras');
  const fmt = useFormat();
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
    const timer = setInterval(() => setSnapshotTick(n => n + 1), SNAPSHOT_REFRESH_INTERVAL);
    return () => clearInterval(timer);
  }, []);

  const fetchCameras = async () => {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/cameras`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error(t('toast.loadFailed', { status: res.status }));
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
        showError(t('toast.snapshotsFailed'));
      }
    } catch (err) {
      showError(t('toast.snapshotsFailedWithError', { error: err.message }));
    }
  };

  const fetchCameraHistory = async (cameraId) => {
    try {
      const res = await fetch(`${API_BASE}/cameras/${cameraId}/snapshots?limit=42`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) return await res.json();
      showError(t('toast.historyFailed'));
    } catch (err) {
      showError(t('toast.historyFailedWithError', { error: err.message }));
    }
    return [];
  };

  // "Last capture" wording: none yet / fresh / stale (> 24 h old)
  const captureInfo = (snap) => {
    if (!snap || !snap.captured_at) return { text: t('capture.none'), stale: false, none: true };
    const age = Date.now() - new Date(snap.captured_at).getTime();
    const abs = formatDate(snap.captured_at);
    if (Number.isNaN(age)) return { text: t('capture.last', { time: abs }), abs, stale: false };
    const relRaw = fmt.relative(snap.captured_at, { thresholdHours: Infinity });
    const rel = relRaw && relRaw !== '-' ? relRaw : abs;
    if (age > STALE_CAPTURE_MS) {
      return { text: t('capture.stale', { time: rel }), abs, stale: true };
    }
    return { text: t('capture.last', { time: rel }), abs, stale: false };
  };

  const handleCapture = async (camera) => {
    setCapturing(camera.id);
    try {
      const res = await fetch(`${API_BASE}/cameras/${camera.id}/capture`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error(t('toast.captureFailed'));
      showSuccess(t('toast.captured', { name: camera.name }));
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

  // "Sep 27, 02:05 PM" / "27 Eyl 14:05" in the farm timezone.
  const formatDate = (iso) => {
    if (!iso) return '';
    return fmt.dateTime(iso, { year: undefined, second: undefined });
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
        throw new Error(err.message || t('toast.addFailed'));
      }
      showSuccess(t('toast.added'));
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
        throw new Error(err.message || t('toast.updateFailed'));
      }
      showSuccess(t('toast.updated'));
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
      if (!res.ok) throw new Error(t('toast.deleteFailed'));
      showSuccess(t('toast.deleted'));
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
        showError(data.message, t('toast.testFailed'));
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

  const statusPill = (status) => {
    const s = CAMERA_STATE[status] || CAMERA_STATE.offline;
    return (
      <StatusPill state={s.state} filled={s.filled} data-testid="camera-status">
        {t(`status.${status || 'offline'}`, { defaultValue: status || 'offline' })}
      </StatusPill>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center gap-3 mb-5 flex-wrap">
        <h1 className="font-display text-2xl font-bold text-ink">{t('title')}</h1>
        {canManage && (
          <Button variant="secondary" size="sm" onClick={() => { setForm(emptyForm); setShowAddModal(true); }}>
            {t('addCamera')}
          </Button>
        )}
      </div>

      {cameras.length === 0 ? (
        <Card className="text-center py-12">
          <svg className="w-16 h-16 mx-auto text-muted mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          <p className="text-ink text-lg">{t('empty.title')}</p>
          {canManage && (
            <Button variant="secondary" size="sm" className="mt-4" onClick={() => { setForm(emptyForm); setShowAddModal(true); }}>
              {t('empty.addFirst')}
            </Button>
          )}
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {cameras.map(camera => {
            const info = captureInfo(storedSnapshots[camera.id]);
            const cs = CAMERA_STATE[camera.status] || CAMERA_STATE.offline;
            return (
            <Card key={camera.id} rail={cs.rail} padding="none" className="overflow-hidden" data-testid="camera-card">
              {/* Snapshot thumbnail */}
              <div
                className="relative bg-gray-900 aspect-video cursor-pointer group"
                onClick={() => setShowLiveModal(camera)}
                title={t('card.openLive')}
              >
                {camera.status === 'online' ? (
                  <>
                    <CameraSnapshot cameraId={camera.id} tick={snapshotTick} alt={camera.name} />
                    <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-30 transition-all flex items-center justify-center">
                      <svg className="w-12 h-12 text-white opacity-0 group-hover:opacity-100 transition-opacity" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    </div>
                  </>
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <div className="text-center">
                      <svg className="w-12 h-12 mx-auto text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                      <p className="text-gray-400 text-sm mt-2">{camera.status === 'error' ? t('card.connectionError') : t('card.offline')}</p>
                    </div>
                  </div>
                )}
                <div className="absolute top-2 end-2">
                  {statusPill(camera.status)}
                </div>
              </div>

              {/* Camera info */}
              <div className="p-4">
                <h3 className="font-display text-base font-semibold text-ink truncate" dir="auto">{camera.name}</h3>
                {camera.description && (
                  <p className="text-muted text-sm mt-0.5 truncate" dir="auto">{camera.description}</p>
                )}
                <p className="text-muted text-xs mt-1 font-mono tabular" dir="ltr">
                  {camera.ip_address && `${camera.ip_address}`}
                  {camera.manufacturer && ` · ${camera.manufacturer}`}
                  {camera.model && ` ${camera.model}`}
                </p>
                {camera.error_message && (
                  <p className="text-alarm-600 dark:text-alarm-300 text-xs mt-1 break-words" title={camera.error_message} dir="auto">{camera.error_message}</p>
                )}
                {/unreachable/i.test(camera.error_message || '') && (
                  <p className="text-caution-700 dark:text-caution-300 text-xs mt-1" data-testid="dhcp-tip">
                    {t('card.dhcpTip')}
                  </p>
                )}

                {/* Last stored snapshot info: relative, with a caution pill when stale (> 24 h) */}
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs" data-testid="camera-capture">
                  {info.stale ? (
                    <StatusPill state="caution" className="!whitespace-normal" title={info.abs}>{info.text}</StatusPill>
                  ) : (
                    <span className="text-muted" title={info.abs}>{info.text}</span>
                  )}
                </div>

                {/* Actions */}
                <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-line">
                  <Button variant="primary" size="sm" onClick={() => setShowLiveModal(camera)} data-testid="camera-live">
                    {canManage ? t('card.livePtz') : t('card.live')}
                  </Button>
                  {canManage && (
                    <Button variant="secondary" size="sm" onClick={() => handleCapture(camera)} disabled={capturing === camera.id}>
                      {capturing === camera.id ? t('card.capturing') : t('card.captureNow')}
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => openHistory(camera)}>{t('card.history')}</Button>
                  {canManage && (
                    <>
                      <Button variant="ghost" size="sm" onClick={() => handleTest(camera)} disabled={testing === camera.id}>
                        {testing === camera.id ? t('card.testing') : t('card.test')}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openEdit(camera)}>{t('common:actions.edit')}</Button>
                    </>
                  )}
                  {canDelete && (
                    <Button variant="danger-ghost" size="sm" className="ms-auto" onClick={() => openDelete(camera)} data-testid="camera-delete">
                      {t('common:actions.delete')}
                    </Button>
                  )}
                </div>
              </div>
            </Card>
            );
          })}
        </div>
      )}

      {/* Add Camera Modal */}
      <Modal show={showAddModal} onClose={() => setShowAddModal(false)} title={t('form.addTitle')}>
        <form onSubmit={handleAdd}>
          <div className="px-6 py-4"><FormFields form={form} setForm={setForm} isEdit={false} /></div>
          <div className="px-6 py-4 bg-gray-50 dark:bg-gray-700/50 flex justify-end gap-3">
            <button type="button" onClick={() => setShowAddModal(false)}
              className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-600 border border-gray-300 dark:border-gray-500 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-500">
              {t('common:actions.cancel')}
            </button>
            <button type="submit" disabled={saving}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50">
              {saving ? t('form.adding') : t('form.addSubmit')}
            </button>
          </div>
        </form>
      </Modal>

      {/* Edit Camera Modal */}
      <Modal show={showEditModal} onClose={() => setShowEditModal(false)} title={t('form.editTitle')}>
        <form onSubmit={handleEdit}>
          <div className="px-6 py-4"><FormFields form={form} setForm={setForm} isEdit={true} hasPassword={!!selectedCamera?.has_password} /></div>
          <div className="px-6 py-4 bg-gray-50 dark:bg-gray-700/50 flex justify-end gap-3">
            <button type="button" onClick={() => setShowEditModal(false)}
              className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-600 border border-gray-300 dark:border-gray-500 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-500">
              {t('common:actions.cancel')}
            </button>
            <button type="submit" disabled={saving}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50">
              {saving ? t('common:actions.saving') : t('form.saveChanges')}
            </button>
          </div>
        </form>
      </Modal>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={showDeleteModal}
        variant="danger"
        title={t('delete.title')}
        body={t('delete.body')}
        items={selectedCamera ? [`${selectedCamera.name}${selectedCamera.ip_address ? ` · ${selectedCamera.ip_address}` : ''}`] : []}
        confirmLabel={t('delete.confirm')}
        busy={saving}
        onConfirm={handleDelete}
        onCancel={() => setShowDeleteModal(false)}
      />

      {/* Live View Modal */}
      {showLiveModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black bg-opacity-90" role="dialog" aria-modal="true" aria-label={t('live.dialogLabel', { name: showLiveModal.name })}>
          <div className="relative w-full max-w-6xl mx-auto px-4 py-4 min-h-full flex flex-col justify-center">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-white text-xl font-semibold truncate" dir="auto">{showLiveModal.name}</h2>
              <button onClick={() => setShowLiveModal(null)} aria-label={t('live.close')}
                className="text-gray-400 hover:text-white p-2 min-w-[44px] min-h-[44px] flex items-center justify-center">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex flex-col lg:flex-row gap-4 lg:items-start">
              <div className="flex-1 min-w-0">
                <LivePlayer camera={showLiveModal} lastSeen={storedSnapshots[showLiveModal.id]?.captured_at} formatDate={formatDate} />
              </div>
              {canManage && (
                <div className="lg:w-80 shrink-0">
                  <PtzControls camera={showLiveModal} token={token} showError={showError} showSuccess={showSuccess} />
                </div>
              )}
            </div>
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
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{t('history.title', { name: selectedHistory.camera.name })}</h2>
                  <p className="text-sm text-gray-500 dark:text-gray-400">{t('history.count', { count: selectedHistory.snapshots.length })}</p>
                </div>
                <button onClick={() => setSelectedHistory(null)} aria-label={t('common:actions.close')}
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
                    <p>{t('history.empty')}</p>
                    {canManage && (
                      <button onClick={() => { handleCapture(selectedHistory.camera); }}
                        className="mt-3 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
                        {t('card.captureNow')}
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
                          <p className="text-[10px] text-gray-400" dir="ltr">{fmt.withUnit(snap.file_size / 1024, 'KB', { decimals: 0 })}</p>
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

function FormFields({ form, setForm, isEdit, hasPassword }) {
  const { t } = useTranslation('cameras');
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('form.name')} *</label>
          <input type="text" required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
            className={inputCls} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('form.ip')} *</label>
          <input type="text" required dir="ltr" value={form.ip_address} onChange={e => setForm({ ...form, ip_address: e.target.value })}
            placeholder="192.168.1.104"
            className={inputCls} />
        </div>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('form.description')}</label>
        <input type="text" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })}
          className={inputCls} />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('form.rtspPort')}</label>
          <input type="number" dir="ltr" value={form.rtsp_port} onChange={e => setForm({ ...form, rtsp_port: e.target.value })}
            className={inputCls} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('form.httpPort')}</label>
          <input type="number" dir="ltr" value={form.http_port} onChange={e => setForm({ ...form, http_port: e.target.value })}
            className={inputCls} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('form.manufacturer')}</label>
          <input type="text" value={form.manufacturer} onChange={e => setForm({ ...form, manufacturer: e.target.value })}
            className={inputCls} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('form.model')}</label>
          <input type="text" value={form.model} onChange={e => setForm({ ...form, model: e.target.value })}
            className={inputCls} />
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('form.username')}</label>
          <input type="text" dir="ltr" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })}
            autoComplete="off"
            className={inputCls} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('form.password')}</label>
          <input type="password" dir="ltr" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })}
            autoComplete="new-password"
            placeholder={isEdit ? (hasPassword ? t('form.passwordUnchanged') : t('form.passwordNotSaved')) : ''}
            className={inputCls} />
          {isEdit && !hasPassword && (
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
              {t('form.noPasswordHelp')}
            </p>
          )}
        </div>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('form.streamPath')}</label>
        <input type="text" dir="ltr" value={form.stream_url} onChange={e => setForm({ ...form, stream_url: e.target.value })}
          placeholder="/Streaming/Channels/101"
          className={inputCls} />
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{t('form.streamPathHelp')}</p>
      </div>
      <div className="flex items-center">
        <input type="checkbox" id="enabled" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })}
          className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded" />
        <label htmlFor="enabled" className="ms-2 text-sm text-gray-700 dark:text-gray-300">{t('form.enabled')}</label>
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
        <div className="relative bg-white dark:bg-gray-800 rounded-lg text-start overflow-hidden shadow-xl transform transition-all sm:max-w-lg sm:w-full">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h3>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

// MSE live player component with MJPEG fallback.
// Failure handling: go2rtc answers the MSE websocket with {"type":"error"} (and
// closes) when it cannot reach the camera; a stalled first frame (10 s), an MJPEG
// <img> error, or a WS failure all land in the same "unreachable" state with a
// Retry button — never an endless spinner.
const FIRST_FRAME_TIMEOUT_MS = 10000;

// Our own failure reasons (English, kept as the raw value so the auth regex and
// logs see the same text) -> translation keys. go2rtc's own error text is
// technical and shown as sent.
const FAIL_KEYS = {
  'Stream failed': 'streamFailed',
  'No video received': 'noVideo',
  'WebSocket connection failed': 'wsFailed',
  'Stream error': 'streamError',
  'Stream closed before any video arrived': 'closedEarly',
  'MJPEG stream failed': 'mjpegFailed',
};

function LivePlayer({ camera, lastSeen, formatDate }) {
  const { t } = useTranslation('cameras');
  const videoRef = useRef(null);
  const wsRef = useRef(null);
  const timeoutRef = useRef(null);
  const [mode, setMode] = useState('mse'); // 'mse' | 'mjpeg'
  const [phase, setPhase] = useState('connecting'); // connecting | playing | failed
  const [failReason, setFailReason] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const gotFrameRef = useRef(false);

  const fail = useCallback((reason) => {
    gotFrameRef.current = false;
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    if (wsRef.current) { try { wsRef.current.close(); } catch {} wsRef.current = null; }
    setFailReason(reason || 'Stream failed');
    setPhase('failed');
  }, []);

  const armFirstFrameTimeout = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      if (!gotFrameRef.current) fail('No video received');
    }, FIRST_FRAME_TIMEOUT_MS);
  }, [fail]);

  const markPlaying = useCallback(() => {
    gotFrameRef.current = true;
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    setPhase('playing');
  }, []);

  useEffect(() => {
    gotFrameRef.current = false;
    setPhase('connecting');
    setFailReason(null);
    armFirstFrameTimeout();
    if (mode === 'mse') startMSE();
    return () => {
      if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, camera.go2rtc_name, attempt]);

  const retry = () => {
    setAttempt(a => a + 1);
  };

  const startMSE = () => {
    const video = videoRef.current;
    if (!video || !window.MediaSource) {
      setMode('mjpeg');
      return;
    }

    const ms = new MediaSource();
    video.src = URL.createObjectURL(ms);
    const onPlaying = () => markPlaying();
    video.addEventListener('playing', onPlaying, { once: true });
    video.addEventListener('loadeddata', onPlaying, { once: true });

    ms.addEventListener('sourceopen', () => {
      const wsUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/camera-stream/api/ws?src=${encodeURIComponent(camera.go2rtc_name)}`;
      let ws;
      try {
        ws = new WebSocket(wsUrl);
      } catch (e) {
        fail('WebSocket connection failed');
        return;
      }
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      let sb = null;
      let queue = [];

      ws.onopen = () => {
        // Ask go2rtc for the MSE stream (codecs we can play)
        try { ws.send(JSON.stringify({ type: 'mse', value: 'avc1.640029,avc1.64002A,avc1.640033,hvc1.1.6.L153.B0,mp4a.40.2,mp4a.40.5,flac,opus' })); } catch {}
      };

      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'error') {
              // e.g. "mse: streams: dial tcp 192.168.1.102:554: connect: no route to host"
              fail(String(msg.value || 'Stream error'));
              return;
            }
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
        if (!gotFrameRef.current) fail('WebSocket connection failed');
      };

      ws.onclose = () => {
        if (wsRef.current === ws && !gotFrameRef.current) fail('Stream closed before any video arrived');
      };
    });

    video.play().catch(() => {});
  };

  // go2rtc reports "wrong user/pass" when the camera answers but rejects the RTSP credentials
  const authProblem = /user\/pass|unauthori[sz]ed|401/i.test(failReason || '');
  const headline = authProblem
    ? t('live.authRejected')
    : (lastSeen
      ? t('live.unreachableLastSeen', { time: formatDate ? formatDate(lastSeen) : lastSeen })
      : t('live.unreachableNoSnapshot'));
  const failText = failReason && FAIL_KEYS[failReason] ? t(`live.fail.${FAIL_KEYS[failReason]}`) : failReason;

  const failedPanel = (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center bg-gray-900/95 text-center px-4 rounded-lg"
      role="alert"
      data-testid="live-unreachable"
    >
      <svg className="w-10 h-10 text-red-400 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 00-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z" />
      </svg>
      <p className="text-white font-medium">{headline}</p>
      {failReason && <p className="text-gray-400 text-xs mt-1 max-w-md break-words" title={failReason} dir="auto">{failText}</p>}
      <button
        type="button"
        onClick={retry}
        className="mt-3 min-h-[44px] px-5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium"
      >
        {t('common:actions.retry')}
      </button>
    </div>
  );

  const connectingPanel = (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-900/70 pointer-events-none" aria-live="polite">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white mb-2" />
      <p className="text-gray-200 text-sm">{t('live.connecting', { name: camera.name })}</p>
    </div>
  );

  if (mode === 'mjpeg') {
    const mjpegUrl = `/camera-stream/api/frame.mp4?src=${encodeURIComponent(camera.go2rtc_name)}&t=${attempt}`;
    return (
      <div>
        <div className="relative aspect-video bg-black rounded-lg overflow-hidden">
          {phase !== 'failed' && (
            <img
              src={mjpegUrl}
              alt={camera.name}
              className="w-full h-full object-contain bg-black"
              onLoad={markPlaying}
              onError={() => fail('MJPEG stream failed')}
            />
          )}
          {phase === 'connecting' && connectingPanel}
          {phase === 'failed' && failedPanel}
        </div>
        <div className="flex items-center gap-4 mt-3">
          <span className="text-gray-400 text-sm">{t('live.mjpegMode')}</span>
          <button onClick={() => setMode('mse')} className="text-blue-400 text-sm hover:underline min-h-[44px]">
            {t('live.tryMse')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="relative aspect-video bg-black rounded-lg overflow-hidden">
        <video ref={videoRef} autoPlay muted playsInline className="w-full h-full bg-black" data-testid="live-video" />
        {phase === 'connecting' && connectingPanel}
        {phase === 'failed' && failedPanel}
      </div>
      <div className="flex items-center gap-4 mt-3">
        <span className="text-gray-400 text-sm">{phase === 'failed' ? t('live.unavailable') : t('live.mseStream')}</span>
        <button onClick={() => setMode('mjpeg')} className="text-blue-400 text-sm hover:underline min-h-[44px]">
          {t('live.switchMjpeg')}
        </button>
      </div>
    </div>
  );
}
