import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import ConfirmDialog from './ConfirmDialog';

const API_BASE = '/api';
const STATUS_POLL_MS = 30000;
const KEEPALIVE_MS = 1500;       // server watchdog stops after 2 s without a refresh
const SPEEDS = [25, 50, 100];

// Direction vectors: pan (+ right), tilt (+ up). These are the CAMERA's
// physical directions: the pad stays left-to-right in Arabic too (dir="ltr"),
// and the arrows are not mirrored. Labels: t(`ptz.dir.${key}`).
const DIRS = {
  up:         { pan: 0,  tilt: 1,  glyph: '↑' },
  down:       { pan: 0,  tilt: -1, glyph: '↓' },
  left:       { pan: -1, tilt: 0,  glyph: '←' },
  right:      { pan: 1,  tilt: 0,  glyph: '→' },
  upleft:     { pan: -1, tilt: 1,  glyph: '↖' },
  upright:    { pan: 1,  tilt: 1,  glyph: '↗' },
  downleft:   { pan: -1, tilt: -1, glyph: '↙' },
  downright:  { pan: 1,  tilt: -1, glyph: '↘' },
};
const KEY_TO_DIR = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

/**
 * Compact PTZ control pad for a Hikvision ISAPI camera.
 *
 * - 8 directions + centre stop, zoom +/-, speed 25/50/100
 * - press-and-hold: pointerdown -> move, pointerup/leave/cancel/blur -> stop,
 *   keepalive re-send every 1.5 s while held (server watchdog stops at 2 s)
 * - keyboard: arrows / + / - while the pad is focused
 * - presets: Go / Save as / Delete (confirm)
 * - disabled with tooltip "Camera unreachable" driven by GET ptz/status (polled every 30 s)
 * - 44 px touch targets; fits 390 px
 *
 * Props: camera, token, showToast?: { showError, showSuccess }, onStatus?: (info|null) => void
 */
export default function PtzControls({ camera, token, showError, showSuccess, onStatus }) {
  const { t } = useTranslation('cameras');
  const [status, setStatus] = useState({ state: 'checking' }); // checking | online | unreachable | auth | error
  const [speedIdx, setSpeedIdx] = useState(1);
  const [presets, setPresets] = useState([]);
  const [selectedPreset, setSelectedPreset] = useState('');
  const [newPresetName, setNewPresetName] = useState('');
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(null); // currently held control id
  const [lastError, setLastError] = useState(null);

  const holdRef = useRef(null); // { vec, timer }
  const padRef = useRef(null);
  const mountedRef = useRef(true);

  const online = status.state === 'online';
  const hasZoom = status.capabilities ? status.capabilities.zoom !== false : true;
  const speed = SPEEDS[speedIdx];

  const authHeaders = useCallback((extra = {}) => ({
    'Authorization': `Bearer ${token}`,
    ...extra,
  }), [token]);

  // --- status polling -------------------------------------------------------
  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/cameras/${camera.id}/ptz/status`, { headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!mountedRef.current) return;
      if (res.ok) {
        setStatus({ state: 'online', ...data });
        onStatus && onStatus(data);
      } else {
        const st = data.status === 'unreachable' ? 'unreachable' : (data.status === 'auth' ? 'auth' : 'error');
        setStatus({ state: st, message: data.message });
        onStatus && onStatus(null);
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setStatus({ state: 'error', message: err.message });
      onStatus && onStatus(null);
    }
  }, [camera.id, authHeaders, onStatus]);

  const fetchPresets = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/cameras/${camera.id}/ptz/presets`, { headers: authHeaders() });
      if (!res.ok) return;
      const list = await res.json();
      if (mountedRef.current && Array.isArray(list)) setPresets(list);
    } catch {
      // presets are optional; status handles the error display
    }
  }, [camera.id, authHeaders]);

  useEffect(() => {
    mountedRef.current = true;
    fetchStatus();
    const timer = setInterval(fetchStatus, STATUS_POLL_MS);
    return () => { mountedRef.current = false; clearInterval(timer); };
  }, [fetchStatus]);

  useEffect(() => {
    if (online) fetchPresets();
  }, [online, fetchPresets]);

  // --- move / stop ----------------------------------------------------------
  const post = useCallback(async (path, body) => {
    const res = await fetch(`${API_BASE}/cameras/${camera.id}/ptz/${path}`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const err = new Error(data.message || t('ptz.error.commandFailed', { path, status: res.status }));
      err.status = data.status;
      err.httpStatus = res.status;
      throw err;
    }
    return res.json();
  }, [camera.id, authHeaders, t]);

  const sendMove = useCallback(async (vec) => {
    try {
      await post('move', vec);
      setLastError(null);
    } catch (err) {
      if (err.status === 'rate_limited') return; // keepalive already covered
      setLastError(err.message);
      if (err.status === 'unreachable') setStatus({ state: 'unreachable', message: err.message });
      else if (err.status === 'auth') setStatus({ state: 'auth', message: err.message });
    }
  }, [post]);

  const stopImpl = useCallback(async (force) => {
    const hold = holdRef.current;
    holdRef.current = null;
    setActive(null);
    if (hold && hold.timer) clearInterval(hold.timer);
    if (!hold && !force) return;
    try {
      await post('stop');
    } catch (err) {
      setLastError(err.message);
    }
  }, [post]);
  // Event handlers pass an event as the first argument — never treat that as "force".
  const stop = useCallback(() => stopImpl(false), [stopImpl]);
  const forceStop = useCallback(() => stopImpl(true), [stopImpl]);

  const startMove = useCallback((id, vec) => {
    if (!online) return;
    if (holdRef.current && holdRef.current.id === id) return; // already holding (key repeat)
    if (holdRef.current) {
      // switch direction without an explicit stop: the new move supersedes the old vector
      clearInterval(holdRef.current.timer);
    }
    const timer = setInterval(() => sendMove(vec), KEEPALIVE_MS);
    holdRef.current = { id, vec, timer };
    setActive(id);
    sendMove(vec);
  }, [online, sendMove]);

  // Any way the hold can end -> stop. Window blur / visibility change covers lost focus.
  useEffect(() => {
    const onEnd = () => { if (holdRef.current) stop(); };
    const onVis = () => { if (document.hidden && holdRef.current) stop(); };
    window.addEventListener('blur', onEnd);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('blur', onEnd);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      document.removeEventListener('visibilitychange', onVis);
      if (holdRef.current) {
        clearInterval(holdRef.current.timer);
        const id = camera.id;
        holdRef.current = null;
        // Best-effort stop on unmount (modal closed mid-hold)
        fetch(`${API_BASE}/cameras/${id}/ptz/stop`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, keepalive: true }).catch(() => {});
      }
    };
  }, [stop, camera.id, token]);

  const vecFor = (dirKey) => ({ pan: DIRS[dirKey].pan * speed, tilt: DIRS[dirKey].tilt * speed, zoom: 0 });

  const holdProps = (id, vec) => ({
    onPointerDown: (e) => { e.preventDefault(); e.currentTarget.focus({ preventScroll: true }); startMove(id, vec); },
    onPointerUp: stop,
    onPointerLeave: () => { if (holdRef.current && holdRef.current.id === id) stop(); },
    onPointerCancel: stop,
    onBlur: () => { if (holdRef.current && holdRef.current.id === id) stop(); },
    onContextMenu: (e) => e.preventDefault(),
    onKeyDown: (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); startMove(id, vec); } },
    onKeyUp: (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); stop(); } },
  });

  // Keyboard on the pad container: arrows, + / -
  const onPadKeyDown = (e) => {
    if (!online) return;
    const dir = KEY_TO_DIR[e.key];
    if (dir) { e.preventDefault(); startMove(`dir:${dir}`, vecFor(dir)); return; }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); startMove('zoom:in', { pan: 0, tilt: 0, zoom: speed }); return; }
    if (e.key === '-' || e.key === '_') { e.preventDefault(); startMove('zoom:out', { pan: 0, tilt: 0, zoom: -speed }); return; }
    if (e.key === 'Escape' || e.key === ' ') { if (holdRef.current) { e.preventDefault(); stop(); } }
  };
  const onPadKeyUp = (e) => {
    if (KEY_TO_DIR[e.key] || ['+', '=', '-', '_'].includes(e.key)) { e.preventDefault(); stop(); }
  };

  // --- presets --------------------------------------------------------------
  const gotoPreset = async () => {
    if (!selectedPreset) return;
    setBusy(true);
    try {
      await post(`presets/${selectedPreset}/goto`);
      showSuccess && showSuccess(t('ptz.toast.moving', { name: presetName(selectedPreset) }));
    } catch (err) {
      showError ? showError(err.message) : setLastError(err.message);
    } finally { setBusy(false); }
  };

  const savePreset = async (e) => {
    e && e.preventDefault();
    const name = newPresetName.trim();
    if (!name) return;
    // Reuse the selected slot if one is chosen, else the first free id
    let id = selectedPreset ? Number(selectedPreset) : 0;
    if (!id) {
      const used = new Set(presets.map(p => p.id));
      id = 1;
      while (used.has(id) && id < 300) id += 1;
    }
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/cameras/${camera.id}/ptz/presets/${id}`, {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || t('ptz.error.saveFailed', { status: res.status }));
      }
      showSuccess && showSuccess(t('ptz.toast.saved', { name, id }));
      setNewPresetName('');
      setShowSaveForm(false);
      await fetchPresets();
      setSelectedPreset(String(id));
    } catch (err) {
      showError ? showError(err.message) : setLastError(err.message);
    } finally { setBusy(false); }
  };

  const deletePreset = async () => {
    if (!selectedPreset) return;
    const name = presetName(selectedPreset);
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/cameras/${camera.id}/ptz/presets/${selectedPreset}`, {
        method: 'DELETE', headers: authHeaders(),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || t('ptz.error.deleteFailed', { status: res.status }));
      }
      showSuccess && showSuccess(t('ptz.toast.deleted', { name }));
      setSelectedPreset('');
      setConfirmDelete(false);
      await fetchPresets();
    } catch (err) {
      showError ? showError(err.message) : setLastError(err.message);
    } finally { setBusy(false); }
  };

  const presetName = (id) => {
    const p = presets.find(x => String(x.id) === String(id));
    return p ? p.name : `#${id}`;
  };

  // --- render ---------------------------------------------------------------
  const disabled = !online;
  const unreachableTip = t('ptz.unreachable');
  const tip = status.state === 'checking' ? t('ptz.checkingCamera')
    : status.state === 'unreachable' ? unreachableTip
    : status.state === 'auth' ? (status.message ? t('ptz.authRejectedWith', { message: status.message }) : t('ptz.authRejected'))
    : status.state === 'error' ? (status.message || t('ptz.error.generic'))
    : '';

  const btnBase = 'select-none touch-none inline-flex items-center justify-center rounded-lg text-lg font-semibold ' +
    'min-w-[44px] min-h-[44px] w-11 h-11 sm:w-12 sm:h-12 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 ' +
    'disabled:opacity-40 disabled:cursor-not-allowed';
  const btnIdle = 'bg-gray-700 hover:bg-gray-600 text-white';
  const btnActive = 'bg-blue-600 text-white';
  const cls = (id) => `${btnBase} ${active === id ? btnActive : btnIdle}`;

  const dirBtn = (dirKey) => {
    const id = `dir:${dirKey}`;
    const label = t(`ptz.dir.${dirKey}`);
    return (
      <button
        key={id}
        type="button"
        aria-label={label}
        title={disabled ? tip : label}
        disabled={disabled}
        className={cls(id)}
        {...holdProps(id, vecFor(dirKey))}
      >
        {DIRS[dirKey].glyph}
      </button>
    );
  };

  return (
    <div
      ref={padRef}
      data-testid="ptz-controls"
      data-ptz-state={status.state}
      className="bg-gray-800/90 rounded-lg p-3 text-white w-full sm:w-auto"
      role="group"
      aria-label={t('ptz.groupLabel', { name: camera.name })}
      aria-disabled={disabled}
      title={disabled ? tip : undefined}
    >
      <div className="flex items-center justify-between mb-2 gap-2">
        <span className="text-sm font-medium" lang="en">{t('ptz.title')}</span>
        <span
          className={`text-xs px-2 py-0.5 rounded-full ${online ? 'bg-green-900/60 text-green-300' : status.state === 'checking' ? 'bg-gray-700 text-gray-300' : 'bg-red-900/60 text-red-300'}`}
          title={tip || (status.model ? `${status.model}${status.firmware ? ` · ${status.firmware}` : ''}` : '')}
          data-testid="ptz-status-badge"
        >
          {status.state === 'checking' ? t('ptz.badge.checking') : online ? t('ptz.badge.online') : status.state === 'unreachable' ? unreachableTip : status.state === 'auth' ? t('ptz.badge.auth') : t('ptz.badge.error')}
        </span>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 sm:items-start">
        {/* Direction pad: focusable container for keyboard control */}
        <div
          className="grid grid-cols-3 gap-1.5 outline-none rounded-lg focus:ring-2 focus:ring-blue-400 p-0.5 w-max mx-auto sm:mx-0"
          dir="ltr"
          tabIndex={disabled ? -1 : 0}
          role="application"
          aria-label={t('ptz.padLabel')}
          title={disabled ? tip : t('ptz.padHelp')}
          onKeyDown={onPadKeyDown}
          onKeyUp={onPadKeyUp}
          onBlur={() => { if (holdRef.current && String(holdRef.current.id).startsWith('dir:')) stop(); }}
        >
          {dirBtn('upleft')}{dirBtn('up')}{dirBtn('upright')}
          {dirBtn('left')}
          <button
            type="button"
            aria-label={t('ptz.stopMove')}
            title={disabled ? tip : t('ptz.stopMove')}
            disabled={disabled}
            className={`${btnBase} bg-red-700 hover:bg-red-600 text-white`}
            onClick={forceStop}
          >
            ■
          </button>
          {dirBtn('right')}
          {dirBtn('downleft')}{dirBtn('down')}{dirBtn('downright')}
        </div>

        {/* Zoom + speed */}
        <div className="flex flex-row sm:flex-col gap-2 items-center justify-center sm:justify-start">
          {hasZoom && (
            <div className="flex flex-row sm:flex-col gap-1.5">
              <button type="button" aria-label={t('ptz.zoomIn')} title={disabled ? tip : t('ptz.zoomInKey')} disabled={disabled}
                className={cls('zoom:in')} {...holdProps('zoom:in', { pan: 0, tilt: 0, zoom: speed })}>+</button>
              <button type="button" aria-label={t('ptz.zoomOut')} title={disabled ? tip : t('ptz.zoomOutKey')} disabled={disabled}
                className={cls('zoom:out')} {...holdProps('zoom:out', { pan: 0, tilt: 0, zoom: -speed })}>−</button>
            </div>
          )}
          <label className="flex flex-col items-center text-xs text-gray-300 gap-1 min-w-[88px]">
            <span>{t('ptz.speed', { speed })}</span>
            <input
              type="range" min={0} max={SPEEDS.length - 1} step={1} value={speedIdx}
              onChange={(e) => setSpeedIdx(Number(e.target.value))}
              disabled={disabled}
              aria-label={t('ptz.speedLabel')}
              aria-valuetext={`${speed}`}
              className="w-full h-11 accent-blue-500"
              list={`ptz-speeds-${camera.id}`}
            />
            <datalist id={`ptz-speeds-${camera.id}`}>
              {SPEEDS.map((s, i) => <option key={s} value={i} label={String(s)} />)}
            </datalist>
          </label>
        </div>
      </div>

      {/* Presets */}
      <div className="mt-3 pt-3 border-t border-gray-700">
        <div className="flex flex-wrap gap-2 items-center">
          <select
            value={selectedPreset}
            onChange={(e) => setSelectedPreset(e.target.value)}
            disabled={disabled}
            aria-label={t('ptz.preset')}
            title={disabled ? tip : t('ptz.presets')}
            className="flex-1 min-w-[140px] h-11 bg-gray-700 text-white rounded-lg px-3 text-sm disabled:opacity-40"
          >
            <option value="">{presets.length ? t('ptz.selectPreset') : (online ? t('ptz.noPresets') : t('ptz.presets'))}</option>
            {presets.map(p => <option key={p.id} value={p.id}>{p.id}: {p.name}</option>)}
          </select>
          <button type="button" onClick={gotoPreset} disabled={disabled || busy || !selectedPreset}
            title={disabled ? tip : t('ptz.goTitle')}
            className="h-11 px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed">
            {t('ptz.go')}
          </button>
          <button type="button" onClick={() => setShowSaveForm(v => !v)} disabled={disabled || busy}
            title={disabled ? tip : t('ptz.saveAsTitle')}
            className="h-11 px-3 rounded-lg bg-gray-700 hover:bg-gray-600 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed">
            {t('ptz.saveAs')}
          </button>
          <button type="button" onClick={() => setConfirmDelete(true)} disabled={disabled || busy || !selectedPreset}
            title={disabled ? tip : t('ptz.deleteTitle')}
            className="h-11 px-3 rounded-lg bg-red-900/60 hover:bg-red-800 text-red-200 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed">
            {t('common:actions.delete')}
          </button>
        </div>
        {showSaveForm && (
          <form onSubmit={savePreset} className="mt-2 flex gap-2">
            <input
              type="text" value={newPresetName} onChange={(e) => setNewPresetName(e.target.value)}
              placeholder={selectedPreset ? t('ptz.overwritePlaceholder', { id: selectedPreset }) : t('ptz.newPresetPlaceholder')}
              maxLength={32} autoFocus
              aria-label={t('ptz.presetName')}
              className="flex-1 min-w-0 h-11 bg-gray-700 text-white rounded-lg px-3 text-sm"
            />
            <button type="submit" disabled={busy || !newPresetName.trim()}
              className="h-11 px-3 rounded-lg bg-green-700 hover:bg-green-600 text-sm font-medium disabled:opacity-40">
              {busy ? t('common:actions.saving') : t('common:actions.save')}
            </button>
          </form>
        )}
      </div>

      {(lastError || (!online && status.state !== 'checking')) && (
        <p className="mt-2 text-xs text-amber-300" role="status">
          {lastError || tip}
          {!online && (
            <button type="button" onClick={fetchStatus} className="ms-2 underline text-blue-300 hover:text-blue-200">{t('common:actions.retry')}</button>
          )}
        </p>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title={t('ptz.deleteConfirm.title')}
        body={<Trans t={t} i18nKey="ptz.deleteConfirm.body" values={{ name: presetName(selectedPreset) }} components={{ b: <strong /> }} />}
        variant="danger"
        confirmLabel={t('common:actions.delete')}
        busy={busy}
        onConfirm={deletePreset}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
