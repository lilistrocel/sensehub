import React, { useEffect, useMemo, useState } from 'react';
import { useToast } from '../../context/ToastContext';
import { Card, Label, StatusPill, Button, SectionHeader } from '../../ui';

const API_BASE = '/api';

/**
 * Operator-controlled "Data sources" for the AI jobs (daily agronomist report +
 * nightly planner). One row per source: in use / out of service, a reason and an
 * optional "back on" date. Plus an ad-hoc excluded-equipment list.
 *
 * Reads/writes GET|PUT /api/ai/data-sources. Viewers get a read-only panel.
 */
export default function DataSourcesPanel({ headers, canEdit, equipment = [], embedded = false, onSaved = null }) {
  const { showError, showSuccess } = useToast();
  const [initial, setInitial] = useState(null);   // last saved (effective) config from the API
  const [draft, setDraft] = useState(null);       // { sources: {key:{enabled,reason,until}}, excluded_equipment_ids }
  const [order, setOrder] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const toDraft = (data) => ({
    sources: Object.fromEntries(data.order.map(k => {
      const s = data.sources[k] || {};
      return [k, { enabled: !!s.enabled, reason: s.reason || '', until: s.until || '' }];
    })),
    excluded_equipment_ids: [...(data.excluded_equipment_ids || [])],
  });

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/ai/data-sources`, { headers });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const data = await res.json();
      setInitial(data);
      setOrder(data.order || Object.keys(data.sources || {}));
      setDraft(toDraft(data));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const savedDraft = useMemo(() => (initial ? JSON.stringify(toDraft(initial)) : null), [initial]);
  const dirty = !!draft && savedDraft !== JSON.stringify(draft);
  const disabledCount = initial ? (initial.disabled || []).length : 0;

  const setSource = (key, patch) => {
    setDraft(d => ({ ...d, sources: { ...d.sources, [key]: { ...d.sources[key], ...patch } } }));
  };
  const toggleEquipment = (id) => {
    setDraft(d => {
      const ids = d.excluded_equipment_ids.includes(id)
        ? d.excluded_equipment_ids.filter(x => x !== id)
        : [...d.excluded_equipment_ids, id];
      return { ...d, excluded_equipment_ids: ids.sort((a, b) => a - b) };
    });
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const body = {
        sources: Object.fromEntries(Object.entries(draft.sources).map(([k, s]) => [k, {
          enabled: s.enabled,
          reason: s.enabled ? null : (s.reason.trim() || null),
          until: s.enabled ? null : (s.until || null),
        }])),
        excluded_equipment_ids: draft.excluded_equipment_ids,
      };
      const res = await fetch(`${API_BASE}/ai/data-sources`, { method: 'PUT', headers, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setInitial(data);
      setOrder(data.order || order);
      setDraft(toDraft(data));
      if (onSaved) onSaved(data);
      const n = (data.disabled || []).length;
      showSuccess(n ? `Data sources saved — ${n} out of service` : 'Data sources saved — everything in use');
    } catch (err) {
      showError('Save failed: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  const headerPill = loading
    ? <StatusPill state="idle" text="Loading" />
    : disabledCount > 0
      ? <StatusPill state="caution" filled text={`${disabledCount} out of service`} />
      : <StatusPill state="ok" filled text="All in use" />;

  const excludedNames = useMemo(() => {
    if (!draft) return [];
    const byId = Object.fromEntries((equipment || []).map(e => [e.id, e.name]));
    return draft.excluded_equipment_ids.map(id => byId[id] || `#${id}`);
  }, [draft, equipment]);

  // Embedded (inside the agronomist settings area) the section header already
  // names the panel and summarises it, so only the body is rendered.
  const Wrapper = embedded ? 'div' : Card;
  const wrapperProps = embedded
    ? { 'data-testid': 'data-sources-panel' }
    : { as: 'section', padding: 'md', className: 'mb-4', 'data-testid': 'data-sources-panel', rail: disabledCount > 0 ? 'caution' : null };

  return (
    <Wrapper {...wrapperProps}>
      {!embedded && (
        <SectionHeader
          title="Data sources"
          subtitle="What the AI is allowed to look at. Take a system out of service when it is broken and cannot be fixed yet."
          right={headerPill}
        />
      )}
      <p className="text-xs text-muted mb-3">
        {embedded && 'What the AI is allowed to look at. Take a system out of service when it is broken and cannot be fixed yet. '}
        Applies to the daily agronomist report and the nightly planner. An out-of-service system is removed from
        the data the AI sees and it is told not to reason about it, ask for samples, or create tasks for it.
        {!canEdit && ' View only — ask an operator or admin to change this.'}
      </p>

      {error && (
        <div className="text-sm text-alarm-700 dark:text-alarm-300 mb-3">
          Could not load data sources: {error}{' '}
          <button type="button" className="underline" onClick={load}>Retry</button>
        </div>
      )}

      {draft && (
        <ul className="divide-y divide-line" role="list">
          {order.map(key => {
            const meta = initial?.sources?.[key] || {};
            const s = draft.sources[key];
            const expired = !s.enabled && !!s.until && meta.expired && s.until === (meta.until || '');
            return (
              <li key={key} className="py-3 flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-4" data-source={key} data-enabled={s.enabled ? 'true' : 'false'}>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-ink">{meta.label || key}</div>
                  <p className="text-xs text-muted mt-0.5">{meta.feeds}</p>
                  {!s.enabled && (
                    <div className="mt-2 flex flex-col sm:flex-row gap-2">
                      <label className="flex-1 min-w-0">
                        <Label className="mb-1">Reason</Label>
                        <input
                          type="text"
                          value={s.reason}
                          readOnly={!canEdit}
                          maxLength={300}
                          placeholder="e.g. Down for the foreseeable future"
                          onChange={e => setSource(key, { reason: e.target.value })}
                          className="w-full min-h-[36px] px-3 py-1.5 text-sm rounded-md border border-line bg-panel text-ink placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-brand-500 read-only:bg-field"
                        />
                      </label>
                      <label className="sm:w-44">
                        <Label className="mb-1">Back on (optional)</Label>
                        <input
                          type="date"
                          value={s.until}
                          readOnly={!canEdit}
                          onChange={e => setSource(key, { until: e.target.value })}
                          className="w-full min-h-[36px] px-3 py-1.5 text-sm rounded-md border border-line bg-panel text-ink focus:outline-none focus:ring-2 focus:ring-brand-500 read-only:bg-field"
                        />
                      </label>
                    </div>
                  )}
                  {expired && (
                    <p className="text-xs text-caution-700 dark:text-caution-300 mt-1">
                      The back-on date has passed — this source is treated as in use again.
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => canEdit && setSource(key, { enabled: !s.enabled })}
                  disabled={!canEdit}
                  aria-pressed={s.enabled}
                  aria-label={`${meta.label || key}: ${s.enabled ? 'in use' : 'out of service'}`}
                  title={canEdit ? (s.enabled ? 'Click to take out of service' : 'Click to put back in use') : undefined}
                  className="self-start shrink-0 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-default"
                >
                  {s.enabled
                    ? <StatusPill state="ok" filled text="In use" />
                    : <StatusPill state="idle" text="Out of service" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {draft && (
        <div className="mt-4 pt-3 border-t border-line">
          <Label className="mb-1">Excluded equipment</Label>
          <p className="text-xs text-muted mb-2">
            Drop a single device from everything the AI sees (readings, reference sensors, diagnostics, alerts, the planner's inventory)
            without taking its whole system out of service.
            {excludedNames.length > 0 && <> Currently excluded: <span className="text-ink">{excludedNames.join(', ')}</span>.</>}
          </p>
          {equipment.length === 0 ? (
            <p className="text-xs text-muted">No equipment registered.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1 max-h-48 overflow-y-auto rounded-md border border-line bg-field p-2">
              {equipment.map(e => (
                <label key={e.id} className="flex items-center gap-2 text-sm text-ink min-h-[36px] cursor-pointer">
                  <input
                    type="checkbox"
                    className="rounded"
                    checked={draft.excluded_equipment_ids.includes(e.id)}
                    disabled={!canEdit}
                    onChange={() => toggleEquipment(e.id)}
                  />
                  <span className="truncate">{e.name}</span>
                  <span className="text-xs text-muted shrink-0">#{e.id}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      {canEdit && draft && (
        <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
          {dirty && <span className="text-xs text-caution-700 dark:text-caution-300 mr-auto">Unsaved changes — the next AI run still uses the saved settings.</span>}
          <Button variant="secondary" size="sm" onClick={() => setDraft(toDraft(initial))} disabled={!dirty || saving}>Discard</Button>
          <Button variant="primary" size="sm" onClick={save} disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save data sources'}</Button>
        </div>
      )}
    </Wrapper>
  );
}
