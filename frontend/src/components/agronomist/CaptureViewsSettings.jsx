import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, StatusPill } from '../../ui';

const API_BASE = '/api';
const MAX_VIEWS = 3; // one image per view goes to the report: the backend's cost guard
const INPUT = 'w-full min-w-0 px-2 py-1 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-700 dark:text-white';

function fromConfig(config) {
  const list = Array.isArray(config?.capture_presets) ? config.capture_presets : [];
  return {
    names: Array.from({ length: MAX_VIEWS }, (_, i) => list[i] || ''),
    home: config?.capture_home_preset || '',
    perView: String(config?.capture_frames_per_view || 2),
  };
}

const norm = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Admin settings for the preset tour: which camera presets are the agronomist's
 * views (by name), where the camera goes afterwards, frames per view. "Check on
 * camera" reads the camera's preset list once (one ISAPI request) and shows which
 * names exist and their ids — nothing is moved.
 */
export default function CaptureViewsSettings({ headers, config, onSave }) {
  const { t } = useTranslation('agronomist');
  const [draft, setDraft] = useState(() => fromConfig(config));
  const [saving, setSaving] = useState(false);
  const [camPresets, setCamPresets] = useState(null); // [{ id, name }] | null
  const [checkError, setCheckError] = useState(null);
  const [checking, setChecking] = useState(false);
  const saved = useMemo(() => JSON.stringify(fromConfig(config)), [config]);
  const dirty = JSON.stringify(draft) !== saved;

  useEffect(() => { if (!dirty) setDraft(fromConfig(config)); }, [saved]); // eslint-disable-line react-hooks/exhaustive-deps

  const check = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      let camId = config?.capture_camera_id || null;
      if (!camId) {
        const r = await fetch(`${API_BASE}/cameras`, { headers });
        const list = r.ok ? await r.json() : [];
        const cams = Array.isArray(list) ? list : (list.cameras || []);
        camId = (cams.find(c => c.enabled) || cams[0] || {}).id || null;
      }
      if (!camId) throw new Error(t('canopyViews.settings.noCamera'));
      const res = await fetch(`${API_BASE}/cameras/${camId}/ptz/presets`, { headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
      setCamPresets(Array.isArray(data) ? data : (data.presets || []));
    } catch (err) {
      setCamPresets(null);
      setCheckError(err.message);
    } finally {
      setChecking(false);
    }
  };

  const lookup = name => {
    if (!camPresets || !norm(name)) return null;
    const hits = camPresets.filter(p => norm(p.name) === norm(name)).sort((a, b) => a.id - b.id);
    return hits[0] || false;
  };

  const save = async () => {
    setSaving(true);
    try {
      await onSave({
        capture_presets: draft.names.map(n => n.trim()).filter(Boolean),
        capture_home_preset: draft.home.trim() || null,
        capture_frames_per_view: parseInt(draft.perView, 10) || 2,
      });
    } finally {
      setSaving(false);
    }
  };

  const set = patch => setDraft(d => ({ ...d, ...patch }));
  const setName = (i, v) => set({ names: draft.names.map((n, k) => (k === i ? v : n)) });

  const Found = ({ name }) => {
    const hit = lookup(name);
    if (hit === null) return null;
    return hit
      ? <StatusPill state="ok" filled text={t('canopyViews.settings.found', { id: hit.id })} className="!px-1.5 !py-0 !text-[10px]" />
      : <StatusPill state="caution" text={t('canopyViews.settings.notFound')} className="!px-1.5 !py-0 !text-[10px]" />;
  };

  return (
    <div className="mt-4 pt-3 border-t border-line" data-testid="capture-views-settings">
      <div className="text-xs font-bold uppercase tracking-wider text-muted">{t('canopyViews.settings.title')}</div>
      <p className="mt-1 text-xs text-muted max-w-prose">{t('canopyViews.settings.help')}</p>
      <div className="mt-2 grid gap-2 max-w-md">
        {draft.names.map((n, i) => (
          <label key={i} className="grid grid-cols-[5.5rem_minmax(0,1fr)_auto] items-center gap-2 text-xs">
            <span className="text-muted">{t('canopyViews.viewN', { n: i + 1 })}</span>
            <input
              className={INPUT}
              value={n}
              maxLength={64}
              placeholder={i === 0 ? t('canopyViews.settings.namePlaceholder') : t('canopyViews.settings.unused')}
              onChange={e => setName(i, e.target.value)}
              data-testid={`view-preset-${i + 1}`}
            />
            <Found name={n} />
          </label>
        ))}
        <label className="grid grid-cols-[5.5rem_minmax(0,1fr)_auto] items-center gap-2 text-xs">
          <span className="text-muted">{t('canopyViews.settings.returnTo')}</span>
          <input
            className={INPUT}
            value={draft.home}
            maxLength={64}
            placeholder={t('canopyViews.settings.returnPlaceholder')}
            onChange={e => set({ home: e.target.value })}
            data-testid="view-home-preset"
          />
          <Found name={draft.home} />
        </label>
        <label className="grid grid-cols-[5.5rem_minmax(0,1fr)_auto] items-center gap-2 text-xs">
          <span className="text-muted">{t('canopyViews.settings.perView')}</span>
          <select className={INPUT} value={draft.perView} onChange={e => set({ perView: e.target.value })}>
            {[1, 2, 3].map(n => <option key={n} value={String(n)}>{t('count.frame', { count: n })}</option>)}
          </select>
          <span />
        </label>
      </div>
      {!draft.names.some(n => n.trim()) && (
        <p className="mt-2 text-xs text-caution-700 dark:text-caution-300">{t('canopyViews.settings.noneConfigured')}</p>
      )}
      {checkError && <p className="mt-2 text-xs text-alarm-700 dark:text-alarm-300 break-words">{t('canopyViews.settings.checkFailed', { error: checkError })}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={check} disabled={checking} data-testid="check-presets">
          {checking ? t('canopyViews.settings.checking') : t('canopyViews.settings.check')}
        </Button>
        <Button size="sm" onClick={save} disabled={!dirty || saving} data-testid="save-view-presets">
          {saving ? t('canopyViews.settings.saving') : t('canopyViews.settings.save')}
        </Button>
        {dirty && <Button variant="ghost" size="sm" onClick={() => setDraft(fromConfig(config))}>{t('canopyViews.settings.reset')}</Button>}
      </div>
    </div>
  );
}
