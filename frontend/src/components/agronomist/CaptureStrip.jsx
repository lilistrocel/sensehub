import React, { useEffect, useState } from 'react';
import { useToast } from '../../context/ToastContext';
import { Button, StatusPill } from '../../ui';

const API_BASE = '/api';

const SOURCE_PILL = {
  noon: { state: 'ok', filled: true, text: 'noon' },
  manual: { state: 'idle', filled: true, text: 'manual' },
  fallback_4h: { state: 'caution', filled: false, text: 'fallback' },
};

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * A small strip of canopy frames: thumbnail, sharpness (mono), source pill, time.
 * `frames`: [{ id, image_url, sharpness, source, sequence, captured_at }]
 */
export function FrameStrip({ frames = [], bestId = null, className = '' }) {
  if (!frames.length) return null;
  return (
    <div className={`flex flex-wrap gap-3 ${className}`.trim()} data-testid="frame-strip">
      {frames.map(f => {
        const pill = SOURCE_PILL[f.source] || SOURCE_PILL.manual;
        const isBest = bestId != null && f.id === bestId;
        return (
          <figure key={f.id} className="w-40 shrink-0" data-frame-id={f.id}>
            <a href={f.image_url} target="_blank" rel="noopener noreferrer" title={`Frame ${f.sequence ?? ''} — open full size`}>
              <img
                src={f.image_url}
                alt={`Canopy frame ${f.sequence ?? f.id}`}
                loading="lazy"
                className={`w-40 h-24 object-cover rounded-md border ${isBest ? 'border-brand-500 ring-2 ring-brand-500/40' : 'border-line'} bg-gray-100 dark:bg-gray-900`}
              />
            </a>
            <figcaption className="mt-1 flex items-center justify-between gap-1">
              <span className="font-mono text-[10px] text-muted" title="Sharpness (variance of Laplacian, higher = sharper)">
                #{f.sequence ?? '-'} · {f.sharpness == null ? 'n/a' : Math.round(f.sharpness)}
              </span>
              <StatusPill state={pill.state} filled={pill.filled} text={pill.text} className="!px-1.5 !py-0 !text-[10px]" />
            </figcaption>
            <div className="text-[10px] text-muted font-mono">{fmtTime(f.captured_at)}</div>
          </figure>
        );
      })}
    </div>
  );
}

/**
 * "Canopy captures" card: today's latest frames + a Capture now button (admin/operator)
 * that runs a 3-frame session and shows the resulting thumbnails.
 */
export default function CapturePanel({ headers, canControl, config }) {
  const { showError, showSuccess } = useToast();
  const [group, setGroup] = useState(null);   // today's group from GET /captures?days=1
  const [session, setSession] = useState(null); // frames returned by capture-now
  const [capturing, setCapturing] = useState(false);
  const [loading, setLoading] = useState(true);

  const frames = config?.capture_frames || 3;
  const spacing = config?.capture_spacing_seconds ?? 30;

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/agronomist/captures?days=1`, { headers });
      if (res.ok) {
        const data = await res.json();
        setGroup((data.groups || [])[0] || null);
      }
    } catch { /* non-fatal */ } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const captureNow = async () => {
    setCapturing(true);
    setSession(null);
    try {
      const res = await fetch(`${API_BASE}/agronomist/capture-now`, { method: 'POST', headers, body: JSON.stringify({}) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setSession(data);
      showSuccess(`Captured ${data.frames?.length || 1} frame${(data.frames?.length || 1) === 1 ? '' : 's'}`);
      await load();
    } catch (err) {
      showError('Capture failed: ' + err.message);
    } finally {
      setCapturing(false);
    }
  };

  const shown = session ? { frames: session.frames, best_id: session.session?.best_id } : group;
  const eta = Math.max(1, Math.round(((frames - 1) * spacing + 5) / 60));

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4" data-testid="capture-panel">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">Canopy captures</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Noon session: {frames} frame{frames === 1 ? '' : 's'} {spacing} s apart, scored for sharpness. The report gets the sharpest
            {config?.capture_frames_to_send ? ` ${config.capture_frames_to_send}` : ''}; without a noon session it falls back to the 10:00–14:00 4-hourly snapshots.
          </p>
        </div>
        {canControl && (
          <Button
            variant="secondary"
            size="sm"
            onClick={captureNow}
            disabled={capturing}
            title={`Take ${frames} frame${frames === 1 ? '' : 's'} now (~${eta} min)`}
            data-testid="capture-now"
          >
            {capturing ? `Capturing ${frames} frames (~${eta} min)…` : 'Capture now'}
          </Button>
        )}
      </div>
      <div className="mt-3">
        {shown?.frames?.length ? (
          <>
            <div className="text-xs text-gray-500 dark:text-gray-400 mb-2">
              {session ? `Manual session just taken (${session.frames.length} frame${session.frames.length === 1 ? '' : 's'})` : `Today (${shown.date}) — ${shown.frames.length} frame${shown.frames.length === 1 ? '' : 's'}`}
            </div>
            <FrameStrip frames={shown.frames} bestId={shown.best_id} />
          </>
        ) : (
          <div className="text-xs text-gray-500 dark:text-gray-400">{loading ? 'Loading captures…' : 'No captures yet today.'}</div>
        )}
      </div>
    </div>
  );
}
