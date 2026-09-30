import React, { useCallback, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useFormat } from '../i18n/useFormat';
import { usePoll } from '../hooks/usePoll';
import { Card, StatusPill, ProvenanceLegend } from '../ui';
import ReportTabs, { tabPanelProps } from '../components/agronomist/ReportTabs';
import ProfilePanel from '../components/nutrition/ProfilePanel';
import FeedPanel from '../components/nutrition/FeedPanel';
import AdvisorPanel from '../components/nutrition/AdvisorPanel';

/**
 * Crop & Nutrition (operator request 2026-09-28): crop profile (crop + stage +
 * targets editable; the fertigation system derived live, read-only), "what the
 * plants are getting" (deterministic calculator) and the AI fertilizer advisor
 * (second opinion on the human agronomist's protocol; advisory only).
 * Viewing: every role. Editing + running the advisor: admin / operator.
 * UI strings: locales/<lng>/nutrition.json.
 * Provenance (2026-09-30): every value is marked protocol / operator / measured /
 * calculated / AI with the shared src/ui/Provenance.jsx; the legend sits on top.
 */

const API_BASE = '/api';
const VIEWS = ['profile', 'feed', 'advisor'];
const VIEW_KEY = 'sensehub.nutrition.view';

function readView() {
  try { const v = window.localStorage.getItem(VIEW_KEY); return VIEWS.includes(v) ? v : 'profile'; } catch (_) { return 'profile'; }
}

export default function Nutrition() {
  const { t } = useTranslation('nutrition');
  const fmt = useFormat();
  const { token, user } = useAuth();
  const { showSuccess } = useToast();
  const canEdit = user?.role === 'admin' || user?.role === 'operator';
  const isAdmin = user?.role === 'admin';
  const idBase = useId().replace(/:/g, '');
  const [view, setView] = useState(readView);
  const [profile, setProfile] = useState(undefined); // undefined = loading, null = none
  const [error, setError] = useState(null);

  const api = useMemo(() => {
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const parse = async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
      return data;
    };
    return {
      get: (path) => fetch(`${API_BASE}${path}`, { headers }).then(parse),
      send: (method, path, body) => fetch(`${API_BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }).then(parse),
    };
  }, [token]);

  const loadProfile = useCallback(async () => {
    try {
      const r = await api.get('/nutrition/profiles/active');
      setProfile(r.profile ? await api.get(`/nutrition/profiles/${r.profile.id}`) : null);
      setError(null);
    } catch (e) { setError(e.message); }
  }, [api]);
  usePoll(loadProfile, 300000);

  const switchView = (v) => {
    setView(v);
    try { window.localStorage.setItem(VIEW_KEY, v); } catch (_) { /* private mode */ }
  };
  const onSaved = (p) => { setProfile(p); showSuccess(t('toast.saved')); };
  const save = (body) => api.send('PUT', `/nutrition/profiles/${profile.id}`, body);

  const stage = profile?.stage;
  const tabs = VIEWS.map(id => ({ id, label: t(`views.${id}`) }));

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold text-ink">{t('title')}</h1>
          <p className="text-sm text-muted mt-0.5">{t('subtitle')}</p>
        </div>
        {profile && (
          <div className="flex flex-wrap items-center gap-2" data-testid="nutrition-header-stage">
            <span className="text-sm font-semibold" dir="auto">{profile.crop}{profile.variety ? ` · ${profile.variety}` : ''}</span>
            {stage?.effective
              ? <StatusPill state="ok" filled text={t('header.stageDay', { stage: t(`stage.${stage.effective}`), count: stage.days_after_transplant ?? 0 })} />
              : <StatusPill state="idle" text={t('stage.none')} className="!border-dashed" />}
            {stage?.next && <span className="text-xs text-muted">{t('header.next', { stage: t(`stage.${stage.next.stage}`), date: fmt.dayMonth(`${stage.next.date}T12:00:00Z`) })}</span>}
          </div>
        )}
      </div>

      <ProvenanceLegend />

      <ReportTabs variant="segmented" tabs={tabs} active={view} onChange={switchView} idBase={idBase} label={t('views.label')} />

      {error && <Card rail="alarm" padding="sm"><p role="alert" className="text-sm">{t('errors.loadFailed', { error })}</p></Card>}

      <div {...tabPanelProps(idBase, view)} className="focus:outline-none">
        {profile === undefined ? (
          <Card padding="md"><p className="text-sm text-muted">{t('common:status.loading')}</p></Card>
        ) : profile === null && view === 'profile' ? (
          <Card padding="md" data-testid="nutrition-no-profile"><p className="text-sm text-muted">{t('profile.none')}</p></Card>
        ) : view === 'profile' ? (
          <ProfilePanel profile={profile} canEdit={canEdit} save={save} onSaved={onSaved} api={api} />
        ) : view === 'feed' ? (
          <FeedPanel api={api} profile={profile} />
        ) : (
          <AdvisorPanel api={api} canEdit={canEdit} isAdmin={isAdmin} />
        )}
      </div>
    </div>
  );
}
