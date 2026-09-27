import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSettings } from '../context/SettingsContext';
import { useWebSocket } from '../context/WebSocketContext';
import { useToast } from '../context/ToastContext';
import { Card, Label, Button } from '../ui';
import LogRow from '../components/activity/LogRow';
import LogDetailDrawer from '../components/activity/LogDetailDrawer';
import { CATEGORY_LABELS, categoryLabel, groupByDay, StatusMark } from '../components/activity/logFormat';

/**
 * Logs — who did what, and what the system did, on one timeline.
 * People's actions come from the audit log (every change made through the
 * app); system actions (automation runs, relay bursts, alerts, flow watch,
 * irrigation / dose runs, drift) are merged in by GET /api/logs. Read-only.
 */

const PAGE_SIZE = 60;
const POLL_MS = 10000;

const selectCls = 'w-full min-h-touch px-3 py-2 bg-field text-ink border border-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-500';

const RANGES = [
  { id: 'today', label: 'Today' },
  { id: '24h', label: '24 h' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'custom', label: 'Custom' },
];

const PRESETS = [
  { id: 'irrigation-today', label: 'Who changed irrigation today', filters: { range: 'today', category: 'irrigation,dosing', actor_type: 'user' } },
  { id: 'stops', label: 'Stop All / emergency presses', filters: { range: '30d', action: 'stop_all,emergency_stop,rearm,irrigation.stop' } },
  { id: 'settings', label: 'Settings changes', filters: { range: '30d', category: 'settings' } },
  { id: 'failed-logins', label: 'Failed sign-ins', filters: { range: '30d', action: 'auth.login_failed' } },
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
      showError(e.message, 'Could not load older entries');
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
    const t = setInterval(refreshTop, POLL_MS);
    let unsub = null;
    let debounce = null;
    if (typeof subscribe === 'function') {
      unsub = subscribe('audit_log_new', () => {
        clearTimeout(debounce);
        debounce = setTimeout(refreshTop, 800);
      });
    }
    const onVis = () => { if (document.visibilityState === 'visible') refreshTop(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); clearTimeout(debounce); if (unsub) unsub(); document.removeEventListener('visibilitychange', onVis); };
  }, [canView, liveView, refreshTop, subscribe]);

  // Debounced text search
  useEffect(() => {
    if ((filters.q || '') === qDraft) return undefined;
    const t = setTimeout(() => setFilters({ q: qDraft.trim() }), 400);
    return () => clearTimeout(t);
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
      showError(e.message, 'CSV export failed');
    } finally {
      setExporting(false);
    }
  };

  // ----- derived --------------------------------------------------------
  const groups = useMemo(() => groupByDay(items, tz), [items, tz]);
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
        <h1 className="font-display text-2xl font-bold text-ink mb-4">Logs</h1>
        <Card rail="idle"><p className="text-sm text-ink">The activity log is visible to operators and admins.</p></Card>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto" data-testid="logs-page">
      <div className="flex flex-wrap justify-between items-center gap-3 mb-3">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold text-ink">Logs</h1>
          <p className="text-sm text-muted">Who changed or pressed what, and what the system did — newest first.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={exportCsv} disabled={exporting} data-testid="logs-export">{exporting ? 'Exporting…' : 'Export CSV'}</Button>
          <Button variant="ghost" size="sm" onClick={loadFirst} disabled={loading}>Refresh</Button>
        </div>
      </div>

      {/* Presets */}
      <div className="flex flex-wrap gap-2 mb-3" role="group" aria-label="Quick filters">
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
            {p.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <Card padding="sm" className="mb-3">
        <div className="flex flex-wrap gap-1.5 mb-3" role="group" aria-label="Time range">
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
              {r.label}
            </button>
          ))}
        </div>
        {filters.range === 'custom' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            <label className="block"><Label className="mb-1">From</Label>
              <input type="datetime-local" className={selectCls} value={isoToLocalInput(filters.from)} onChange={(e) => setFilters({ from: localInputToIso(e.target.value) })} />
            </label>
            <label className="block"><Label className="mb-1">To (empty = now)</Label>
              <input type="datetime-local" className={selectCls} value={isoToLocalInput(filters.to)} onChange={(e) => setFilters({ to: localInputToIso(e.target.value) })} />
            </label>
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)] gap-3">
          <div className="flex items-end gap-2">
            <label className="block flex-1 min-w-0">
              <Label className="mb-1">Search</Label>
              <input type="search" placeholder="Zone 4, Stop All, fan…" value={qDraft} onChange={(e) => setQDraft(e.target.value)} className={selectCls} data-testid="logs-search" />
            </label>
            {/* Phone: the four selects fold away behind this button */}
            <Button variant="secondary" className="sm:hidden shrink-0" onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters} data-testid="logs-filters-toggle">
              Filters{filterCount - (filters.q ? 1 : 0) > 0 ? ` (${filterCount - (filters.q ? 1 : 0)})` : ''}
            </Button>
          </div>
          <label className={`${showFilters ? 'block' : 'hidden'} sm:block`}>
            <Label className="mb-1">Who</Label>
            <select className={selectCls} value={filters.actor_type || ''} onChange={(e) => setFilters({ actor_type: e.target.value })} data-testid="filter-actor-type">
              <option value="">Everyone</option>
              <option value="user">People</option>
              <option value="system">System</option>
            </select>
          </label>
          <label className={`${showFilters ? 'block' : 'hidden'} sm:block`}>
            <Label className="mb-1">User</Label>
            <select className={selectCls} value={filters.actor || ''} onChange={(e) => setFilters({ actor: e.target.value })} data-testid="filter-actor">
              <option value="">Any user</option>
              {filters.actor && !(facets?.users || []).some((u) => u.email.toLowerCase() === filters.actor.toLowerCase()) && <option value={filters.actor}>{filters.actor}</option>}
              {(facets?.users || []).map((u) => <option key={u.email} value={u.email}>{u.email}{u.role ? ` (${u.role})` : ''}</option>)}
            </select>
          </label>
          <label className={`${showFilters ? 'block' : 'hidden'} sm:block`}>
            <Label className="mb-1">Category</Label>
            <select className={selectCls} value={filters.category || ''} onChange={(e) => setFilters({ category: e.target.value })} data-testid="filter-category">
              <option value="">All categories</option>
              {!categoryKnown && <option value={filters.category}>{filters.category.split(',').map(categoryLabel).join(' + ')}</option>}
              {Object.keys(CATEGORY_LABELS).map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
            </select>
          </label>
          <label className={`${showFilters ? 'block' : 'hidden'} sm:block`}>
            <Label className="mb-1">Equipment / automation</Label>
            <select
              className={selectCls}
              value={targetValue}
              onChange={(e) => {
                const [t, id] = e.target.value ? e.target.value.split(':') : ['', ''];
                setFilters({ target_type: t, target_id: id });
              }}
              data-testid="filter-target"
            >
              <option value="">Anything</option>
              {!targetKnown && <option value={targetValue}>{`${filters.target_type} #${filters.target_id}`}</option>}
              {facets?.equipment?.length > 0 && (
                <optgroup label="Equipment">
                  {facets.equipment.map((e) => <option key={`e${e.id}`} value={`equipment:${e.id}`}>{e.name}</option>)}
                </optgroup>
              )}
              {facets?.automations?.length > 0 && (
                <optgroup label="Automations">
                  {facets.automations.map((a) => <option key={`a${a.id}`} value={`automation:${a.id}`}>{a.name}</option>)}
                </optgroup>
              )}
            </select>
          </label>
        </div>
        {(filterCount > 0 || filters.action || filters.severity) && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
            {filters.action && <span className="rounded border border-line px-1.5 py-0.5 font-mono">action: {filters.action}</span>}
            {filters.severity && <span className="rounded border border-line px-1.5 py-0.5 font-mono">severity: {filters.severity}</span>}
            <Button variant="ghost" size="sm" onClick={() => setFilters({ range: filters.range === 'custom' ? '24h' : filters.range }, { replace: true })} data-testid="logs-clear">Clear filters</Button>
          </div>
        )}
      </Card>

      {/* Summary + legend */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 mb-2">
        <Label as="p" className="font-mono tabular" data-testid="logs-summary">
          {items.length.toLocaleString()} shown<span aria-hidden="true"> · </span>{counts.people} by people<span aria-hidden="true"> · </span>{counts.system} system<span aria-hidden="true"> · </span>{counts.problems} failed / refused / critical
          {liveView && lastRefresh && <><span aria-hidden="true"> · </span>live</>}
        </Label>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted" aria-label="Legend">
          <LegendItem shape="dot" tone="ok" label="Done" />
          <LegendItem shape="dot" tone="idle" label="Info" />
          <LegendItem shape="triangle" tone="caution" label="Notable / refused" />
          <LegendItem shape="square" tone="alarm" label="Failed / critical" />
          <LegendItem shape="ring" tone="caution" label="Unconfirmed" />
        </p>
      </div>

      {auditStart && (!filters.from || filters.from < auditStart) && (
        <p className="mb-2 text-xs text-muted">
          People's actions are fully recorded from {new Date(auditStart).toLocaleString('en-GB', { timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}. Earlier entries marked “Unknown user” come from the request log (device and path only).
        </p>
      )}
      {!auditStart && !loading && (
        <p className="mb-2 text-xs text-muted">People's actions are recorded from the next change on; earlier entries marked “Unknown user” come from the request log (device and path only).</p>
      )}

      {error && (
        <Card rail="alarm" className="mb-3">
          <p className="text-sm text-ink">Could not load the log: {error}</p>
          <Button variant="secondary" size="sm" className="mt-2" onClick={loadFirst}>Try again</Button>
        </Card>
      )}

      {loading && items.length === 0 ? (
        <div className="flex items-center justify-center h-40"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" /></div>
      ) : items.length === 0 && !error ? (
        <Card className="text-center text-sm text-muted py-10" data-testid="logs-empty">
          Nothing matches these filters{filters.range === 'today' ? ' today' : ''}.
          {hasMore && <div className="mt-3"><Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>Look further back</Button></div>}
        </Card>
      ) : (
        <div className="space-y-3" data-testid="logs-list">
          {groups.map((g) => (
            <section key={g.day} aria-labelledby={`day-${g.day}`}>
              <h2 id={`day-${g.day}`} className="sticky top-0 z-10 bg-canvas/95 backdrop-blur py-1 text-label uppercase text-muted">
                {g.heading} <span className="font-mono normal-case tracking-normal">· {g.items.length}</span>
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
          <p className="text-xs text-muted font-mono tabular">{items.length.toLocaleString()} entries loaded</p>
          {hasMore && (
            <Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore} data-testid="logs-more">
              {loadingMore ? 'Loading…' : 'Load older'}
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
