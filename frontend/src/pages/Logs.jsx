import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useFormat } from '../i18n/useFormat';
import { useAuth } from '../context/AuthContext';
import { useSettings } from '../context/SettingsContext';
import { useWebSocket } from '../context/WebSocketContext';
import { useToast } from '../context/ToastContext';
import { Card, Label, Button } from '../ui';
import LogRow from '../components/activity/LogRow';
import LogDetailDrawer from '../components/activity/LogDetailDrawer';
import { CATEGORY_LABELS, categoryLabel, groupByDay, StatusMark } from '../components/activity/logFormat';
import { startPolling } from '../hooks/usePoll';

/**
 * Logs — who did what, and what the system did, on one timeline.
 * People's actions come from the audit log (every change made through the
 * app); system actions (automation runs, relay bursts, alerts, flow watch,
 * irrigation / dose runs, drift) are merged in by GET /api/logs. Read-only.
 */

const PAGE_SIZE = 60;
const POLL_MS = 10000;

const selectCls = 'w-full min-h-touch px-3 py-2 bg-field text-ink border border-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-500';

// Labels come from t(`range.${id}`) / t(`preset.${id}`) at render.
const RANGES = [
  { id: 'today' },
  { id: '24h' },
  { id: '7d' },
  { id: '30d' },
  { id: 'custom' },
];

const PRESETS = [
  { id: 'irrigation-today', filters: { range: 'today', category: 'irrigation,dosing', actor_type: 'user' } },
  { id: 'stops', filters: { range: '30d', action: 'stop_all,emergency_stop,rearm,irrigation.stop' } },
  { id: 'settings', filters: { range: '30d', category: 'settings' } },
  { id: 'failed-logins', filters: { range: '30d', action: 'auth.login_failed' } },
];

const FILTER_KEYS = ['range', 'from', 'to', 'category', 'actor', 'actor_type', 'target_type', 'target_id', 'action', 'q', 'severity'];
const DEFAULTS = { range: '24h' };

function filtersFromParams(sp) {
  const f = {};
  for (const k of FILTER_KEYS) { const v = sp.get(k); if (v) f[k] = v; }
  if (!f.range && !f.from) f.range = DEFAULTS.range;
  if (f.from || f.to) f.range = 'custom';
  return f;
}

function toQuery(f, extra = {}) {
  const p = new URLSearchParams();
  for (const k of FILTER_KEYS) {
    if (!f[k]) continue;
    if (k === 'range' && f.range === 'custom') continue;
    if ((k === 'from' || k === 'to') && f.range !== 'custom') continue;
    p.set(k, f[k]);
  }
  for (const [k, v] of Object.entries(extra)) if (v != null) p.set(k, v);
  return p;
}

// datetime-local value (farm time) <-> ISO. The input has no zone, so it is
// read as the browser's local time; on the farm phones that is the farm zone.
const isoToLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const localInputToIso = (v) => (v ? new Date(v).toISOString() : '');

function LegendItem({ shape, tone, label }) {
  return <span className="inline-flex items-center gap-1"><StatusMark mark={{ shape, tone, label }} />{label}</span>;
}

export default function Logs() {
  const { t, i18n } = useTranslation('logs');
  const fmt = useFormat();
  const lng = i18n.language;
  const { token, user } = useAuth();
  const { timezone } = useSettings();
  const { subscribe } = useWebSocket() || {};
  const { showError } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => filtersFromParams(searchParams), [searchParams]);

  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [forbidden, setForbidden] = useState(false);
  const [facets, setFacets] = useState(null);
  const [selected, setSelected] = useState(null);
  const [auditStart, setAuditStart] = useState(null);
  const [qDraft, setQDraft] = useState(filters.q || '');
  const [exporting, setExporting] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [showFilters, setShowFilters] = useState(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const tz = timezone || 'UTC';
  const canView = user?.role === 'admin' || user?.role === 'operator';
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const setFilters = useCallback((next, { replace = false } = {}) => {
    const merged = replace ? { ...next } : { ...filters, ...next };
    for (const k of Object.keys(merged)) if (merged[k] === '' || merged[k] == null) delete merged[k];
    if (!merged.range && !merged.from) merged.range = DEFAULTS.range;
    setSearchParams(toQuery(merged), { replace: false });
    setSelected(null);
  }, [filters, setSearchParams]);

  // ----- data -----------------------------------------------------------
  const fetchPage = useCallback(async (cur) => {
    const res = await fetch(`/api/logs?${toQuery(filters, { limit: String(PAGE_SIZE), cursor: cur || undefined })}`, { headers });
    if (res.status === 403) { const e = new Error('forbidden'); e.forbidden = true; throw e; }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || body.error || `HTTP ${res.status}`);
    return body;
  }, [filters, headers]);

  const loadFirst = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fetchPage(null);
      setItems(d.items || []);
      setCursor(d.next_cursor || null);
      setHasMore(!!d.has_more && !!d.next_cursor);
      setAuditStart(d.audit_started_at || null);
      setError(null);
      setForbidden(false);
      setLastRefresh(new Date());
    } catch (e) {
      if (e.forbidden) setForbidden(true); else setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [fetchPage]);

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const d = await fetchPage(cursor);
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.id));
        return [...prev, ...(d.items || []).filter((i) => !seen.has(i.id))];
      });
      setCursor(d.next_cursor || null);
      setHasMore(!!d.has_more && !!d.next_cursor);
    } catch (e) {
      showError(e.message, t('toast.loadOlderFailed'));
    } finally {
      setLoadingMore(false);
    }
  };

  // New entries on top without disturbing the pages already loaded.
  const refreshTop = useCallback(async () => {
    if (document.visibilityState !== 'visible') return;
    try {
      const d = await fetchPage(null);
      const fresh = d.items || [];
      setItems((prev) => {
        if (!prev.length) return fresh;
        const byId = new Map(fresh.map((i) => [i.id, i]));
        const newest = prev[0].time;
        const added = fresh.filter((i) => !prev.some((p) => p.id === i.id) && i.time >= newest);
        // Items still on the first page get their latest version (a burst can grow, a run can end).
        const updated = prev.map((p) => byId.get(p.id) || p);
        return added.length || updated.some((u, idx) => u !== prev[idx]) ? [...added, ...updated] : prev;
      });
      setLastRefresh(new Date());
    } catch (_) { /* keep the list; the next poll retries */ }
  }, [fetchPage]);

  useEffect(() => { if (canView) loadFirst(); else setLoading(false); }, [loadFirst, canView]);
  useEffect(() => { setQDraft(filters.q || ''); }, [filters.q]);

  useEffect(() => {
    if (!canView) return undefined;
    fetch('/api/logs/facets', { headers })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setFacets(d); })
      .catch(() => {});
    return undefined;
  }, [headers, canView]);

  // Live: WebSocket nudge on every audit row + 10 s poll while visible (system
  // sources such as relay bursts and automation runs have no nudge).
  const liveView = filters.range !== 'custom' || !filters.to;
  useEffect(() => {
    if (!canView || !liveView) return undefined;
    // Paused while hidden; ONE refresh on resume (visible + online, debounced).
    const stopPoll = startPolling(refreshTop, POLL_MS);
    let unsub = null;
    let debounce = null;
    if (typeof subscribe === 'function') {
      unsub = subscribe('audit_log_new', () => {
        clearTimeout(debounce);
        debounce = setTimeout(refreshTop, 800);
      });
    }
    return () => { stopPoll(); clearTimeout(debounce); if (unsub) unsub(); };
  }, [canView, liveView, refreshTop, subscribe]);

  // Debounced text search
  useEffect(() => {
    if ((filters.q || '') === qDraft) return undefined;
    const timer = setTimeout(() => setFilters({ q: qDraft.trim() }), 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qDraft]);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const res = await fetch(`/api/logs/export.csv?${toQuery(filters)}`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sensehub-logs-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      showError(e.message, t('toast.exportFailed'));
    } finally {
      setExporting(false);
    }
  };

  // ----- derived --------------------------------------------------------
  const groups = useMemo(() => groupByDay(items, tz, { t, lng }), [items, tz, t, lng]);
  const activePreset = PRESETS.find((p) => Object.entries(p.filters).every(([k, v]) => filters[k] === v)
    && FILTER_KEYS.every((k) => k in p.filters || !filters[k]));
  const targetValue = filters.target_type && filters.target_id ? `${filters.target_type}:${filters.target_id}` : '';
  const targetKnown = !targetValue || (facets && (
    (filters.target_type === 'equipment' && facets.equipment.some((e) => String(e.id) === filters.target_id))
    || (filters.target_type === 'automation' && facets.automations.some((a) => String(a.id) === filters.target_id))));
  const categoryKnown = !filters.category || CATEGORY_LABELS[filters.category];
  const counts = useMemo(() => {
    const c = { people: 0, system: 0, problems: 0 };
    for (const i of items) {
      if (i.actor_type === 'user') c.people++; else c.system++;
      if (i.result === 'error' || i.result === 'denied' || i.severity === 'critical') c.problems++;
    }
    return c;
  }, [items]);
  const filterCount = FILTER_KEYS.filter((k) => !['range', 'from', 'to'].includes(k) && filters[k]).length;

  // ----- render -----------------------------------------------------------
  if (!canView || forbidden) {
    return (
      <div className="max-w-5xl mx-auto">
        <h1 className="font-display text-2xl font-bold text-ink mb-4">{t('title')}</h1>
        <Card rail="idle"><p className="text-sm text-ink">{t('forbidden')}</p></Card>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto" data-testid="logs-page">
      <div className="flex flex-wrap justify-between items-center gap-3 mb-3">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold text-ink">{t('title')}</h1>
          <p className="text-sm text-muted">{t('subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={exportCsv} disabled={exporting} data-testid="logs-export">{exporting ? t('exporting') : t('exportCsv')}</Button>
          <Button variant="ghost" size="sm" onClick={loadFirst} disabled={loading}>{t('common:actions.refresh')}</Button>
        </div>
      </div>

      {/* Presets */}
      <div className="flex flex-wrap gap-2 mb-3" role="group" aria-label={t('quickFilters')}>
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setFilters(p.filters, { replace: true })}
            aria-pressed={activePreset?.id === p.id}
            className={`min-h-[36px] px-3 rounded-full border text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
              activePreset?.id === p.id ? 'border-brand-600 bg-brand-600 text-white' : 'border-line bg-panel text-ink hover:bg-field'
            }`}
            data-testid={`preset-${p.id}`}
          >
            {t(`preset.${p.id}`)}
          </button>
        ))}
      </div>

      {/* Filters */}
      <Card padding="sm" className="mb-3">
        <div className="flex flex-wrap gap-1.5 mb-3" role="group" aria-label={t('timeRange')}>
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              aria-pressed={filters.range === r.id}
              onClick={() => (r.id === 'custom'
                ? setFilters({ range: 'custom', from: filters.from || new Date(Date.now() - 86400e3).toISOString(), to: filters.to || '' })
                : setFilters({ range: r.id, from: '', to: '' }))}
              className={`min-h-[36px] px-3 rounded-md border text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                filters.range === r.id ? 'border-ink bg-ink text-canvas' : 'border-line bg-field text-ink hover:bg-panel'
              }`}
              data-testid={`range-${r.id}`}
            >
              {t(`range.${r.id}`)}
            </button>
          ))}
        </div>
        {filters.range === 'custom' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            <label className="block"><Label className="mb-1">{t('filters.from')}</Label>
              <input type="datetime-local" className={selectCls} value={isoToLocalInput(filters.from)} onChange={(e) => setFilters({ from: localInputToIso(e.target.value) })} />
            </label>
            <label className="block"><Label className="mb-1">{t('filters.to')}</Label>
              <input type="datetime-local" className={selectCls} value={isoToLocalInput(filters.to)} onChange={(e) => setFilters({ to: localInputToIso(e.target.value) })} />
            </label>
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)] gap-3">
          <div className="flex items-end gap-2">
            <label className="block flex-1 min-w-0">
              <Label className="mb-1">{t('common:actions.search')}</Label>
              <input type="search" placeholder={t('filters.searchPlaceholder')} value={qDraft} onChange={(e) => setQDraft(e.target.value)} className={selectCls} data-testid="logs-search" />
            </label>
            {/* Phone: the four selects fold away behind this button */}
            <Button variant="secondary" className="sm:hidden shrink-0" onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters} data-testid="logs-filters-toggle">
              {filterCount - (filters.q ? 1 : 0) > 0
                ? t('filters.toggleCount', { n: filterCount - (filters.q ? 1 : 0) })
                : t('filters.toggle')}
            </Button>
          </div>
          <label className={`${showFilters ? 'block' : 'hidden'} sm:block`}>
            <Label className="mb-1">{t('filters.who')}</Label>
            <select className={selectCls} value={filters.actor_type || ''} onChange={(e) => setFilters({ actor_type: e.target.value })} data-testid="filter-actor-type">
              <option value="">{t('filters.everyone')}</option>
              <option value="user">{t('filters.people')}</option>
              <option value="system">{t('filters.system')}</option>
            </select>
          </label>
          <label className={`${showFilters ? 'block' : 'hidden'} sm:block`}>
            <Label className="mb-1">{t('filters.user')}</Label>
            <select className={selectCls} value={filters.actor || ''} onChange={(e) => setFilters({ actor: e.target.value })} data-testid="filter-actor">
              <option value="">{t('filters.anyUser')}</option>
              {filters.actor && !(facets?.users || []).some((u) => u.email.toLowerCase() === filters.actor.toLowerCase()) && <option value={filters.actor}>{filters.actor}</option>}
              {(facets?.users || []).map((u) => <option key={u.email} value={u.email}>{u.email}{u.role ? ` (${t(`common:role.${u.role}`, { defaultValue: u.role })})` : ''}</option>)}
            </select>
          </label>
          <label className={`${showFilters ? 'block' : 'hidden'} sm:block`}>
            <Label className="mb-1">{t('filters.category')}</Label>
            <select className={selectCls} value={filters.category || ''} onChange={(e) => setFilters({ category: e.target.value })} data-testid="filter-category">
              <option value="">{t('filters.allCategories')}</option>
              {!categoryKnown && <option value={filters.category}>{filters.category.split(',').map((c) => categoryLabel(c, t)).join(' + ')}</option>}
              {Object.keys(CATEGORY_LABELS).map((c) => <option key={c} value={c}>{categoryLabel(c, t)}</option>)}
            </select>
          </label>
          <label className={`${showFilters ? 'block' : 'hidden'} sm:block`}>
            <Label className="mb-1">{t('filters.target')}</Label>
            <select
              className={selectCls}
              value={targetValue}
              onChange={(e) => {
                const [type, id] = e.target.value ? e.target.value.split(':') : ['', ''];
                setFilters({ target_type: type, target_id: id });
              }}
              data-testid="filter-target"
            >
              <option value="">{t('filters.anything')}</option>
              {!targetKnown && <option value={targetValue}>{`${filters.target_type} #${filters.target_id}`}</option>}
              {facets?.equipment?.length > 0 && (
                <optgroup label={t('filters.equipmentGroup')}>
                  {facets.equipment.map((e) => <option key={`e${e.id}`} value={`equipment:${e.id}`}>{e.name}</option>)}
                </optgroup>
              )}
              {facets?.automations?.length > 0 && (
                <optgroup label={t('filters.automationsGroup')}>
                  {facets.automations.map((a) => <option key={`a${a.id}`} value={`automation:${a.id}`}>{a.name}</option>)}
                </optgroup>
              )}
            </select>
          </label>
        </div>
        {(filterCount > 0 || filters.action || filters.severity) && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
            {filters.action && <span className="rounded border border-line px-1.5 py-0.5 font-mono">{t('filters.actionChip')} <span dir="ltr">{filters.action}</span></span>}
            {filters.severity && <span className="rounded border border-line px-1.5 py-0.5 font-mono">{t('filters.severityChip')} {t(`common:severity.${filters.severity}`, { defaultValue: filters.severity })}</span>}
            <Button variant="ghost" size="sm" onClick={() => setFilters({ range: filters.range === 'custom' ? '24h' : filters.range }, { replace: true })} data-testid="logs-clear">{t('filters.clear')}</Button>
          </div>
        )}
      </Card>

      {/* Summary + legend */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 mb-2">
        <Label as="p" className="font-mono tabular" data-testid="logs-summary">
          {t('summary.shown', { n: fmt.int(items.length) })}<span aria-hidden="true"> · </span>{t('summary.people', { n: fmt.int(counts.people) })}<span aria-hidden="true"> · </span>{t('summary.system', { n: fmt.int(counts.system) })}<span aria-hidden="true"> · </span>{t('summary.problems', { n: fmt.int(counts.problems) })}
          {liveView && lastRefresh && <><span aria-hidden="true"> · </span>{t('summary.live')}</>}
        </Label>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted" aria-label={t('legend.title')}>
          <LegendItem shape="dot" tone="ok" label={t('legend.done')} />
          <LegendItem shape="dot" tone="idle" label={t('legend.info')} />
          <LegendItem shape="triangle" tone="caution" label={t('legend.notable')} />
          <LegendItem shape="square" tone="alarm" label={t('legend.failed')} />
          <LegendItem shape="ring" tone="caution" label={t('legend.unconfirmed')} />
        </p>
      </div>

      {auditStart && (!filters.from || filters.from < auditStart) && (
        <p className="mb-2 text-xs text-muted">
          {t('auditStart.from', { time: fmt.dateTime(auditStart, { timeZone: tz, year: undefined, second: undefined }) })}
        </p>
      )}
      {!auditStart && !loading && (
        <p className="mb-2 text-xs text-muted">{t('auditStart.none')}</p>
      )}

      {error && (
        <Card rail="alarm" className="mb-3">
          <p className="text-sm text-ink">{t('errors.loadFailed', { error })}</p>
          <Button variant="secondary" size="sm" className="mt-2" onClick={loadFirst}>{t('common:actions.tryAgain')}</Button>
        </Card>
      )}

      {loading && items.length === 0 ? (
        <div className="flex items-center justify-center h-40"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" /></div>
      ) : items.length === 0 && !error ? (
        <Card className="text-center text-sm text-muted py-10" data-testid="logs-empty">
          {filters.range === 'today' ? t('empty.today') : t('empty.any')}
          {hasMore && <div className="mt-3"><Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>{t('empty.lookBack')}</Button></div>}
        </Card>
      ) : (
        <div className="space-y-3" data-testid="logs-list">
          {groups.map((g) => (
            <section key={g.day} aria-labelledby={`day-${g.day}`}>
              <h2 id={`day-${g.day}`} className="sticky top-0 z-10 bg-canvas/95 backdrop-blur py-1 text-label uppercase text-muted">
                {g.heading} <span className="font-mono normal-case tracking-normal">· {fmt.int(g.items.length)}</span>
              </h2>
              <Card padding="none">
                <ul>
                  {g.items.map((it) => (
                    <LogRow key={it.id} item={it} tz={tz} onOpen={setSelected} selected={selected?.id === it.id} />
                  ))}
                </ul>
              </Card>
            </section>
          ))}
        </div>
      )}

      {items.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted font-mono tabular">{t('footer.loaded', { count: items.length, n: fmt.int(items.length) })}</p>
          {hasMore && (
            <Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore} data-testid="logs-more">
              {loadingMore ? t('common:status.loading') : t('footer.loadOlder')}
            </Button>
          )}
        </div>
      )}

      <LogDetailDrawer
        item={selected}
        token={token}
        tz={tz}
        onClose={() => setSelected(null)}
        onFilterTarget={(type, id) => setFilters({ target_type: type, target_id: String(id) })}
        onFilterActor={(email) => setFilters({ actor: email, actor_type: '' })}
      />
    </div>
  );
}
