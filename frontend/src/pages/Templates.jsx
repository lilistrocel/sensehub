import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

const API_BASE = '/api';

const PARAM_TYPES = ['string', 'integer', 'number', 'boolean', 'array'];
const TRIGGER_TYPES = ['schedule', 'threshold', 'both'];

const CATEGORY_COLOR = {
  Irrigation: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200',
  Climate:    'bg-rose-100 text-rose-700 dark:bg-rose-900 dark:text-rose-200',
  Maintenance:'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-200',
  Monitoring: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-200',
  Control:    'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-200',
  Safety:     'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
};

function pretty(j) {
  try { return JSON.stringify(j, null, 2); }
  catch { return String(j); }
}

function emptyTemplate() {
  return {
    name: '',
    description: '',
    category: 'General',
    agent_usage_notes: '',
    default_trigger_type: 'schedule',
    parameters: [],
    conditions: [],
    actions: [{ type: 'control', action: 'on', equipment_id: 0, channel: 1 }],
    instantiation_trigger: null,
    target_effects: [],
  };
}

const EFFECT_DIRECTIONS = ['raise', 'lower', 'neutral'];
const EFFECT_DIRECTION_COLOR = {
  raise:   'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-200',
  lower:   'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200',
  neutral: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
};

function emptyEffect() {
  return { metric_name: '', direction: 'raise', magnitude_hint: '' };
}

function emptyParameter() {
  return { name: '', type: 'integer', required: true, default: '', description: '' };
}

export default function Templates() {
  const { token, user } = useAuth();
  const { showError, showSuccess } = useToast();
  const canEdit = user?.role === 'admin' || user?.role === 'operator';

  const [templates, setTemplates] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);   // template object being edited (new or existing)
  const [isNew, setIsNew] = useState(false);
  const [actionsText, setActionsText] = useState('');
  const [conditionsText, setConditionsText] = useState('');
  const [triggerText, setTriggerText] = useState('');
  const [filter, setFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('All');

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const fetchTemplates = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/automation-templates`, { headers });
      if (res.ok) {
        const list = await res.json();
        setTemplates(list);
        if (!selected && list.length > 0) setSelected(list[0]);
      }
    } catch (err) {
      showError('Failed to load templates: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchTemplates(); /* eslint-disable-next-line */ }, []);

  const openEdit = (t) => {
    const tpl = t ? { ...t } : emptyTemplate();
    setEditing(tpl);
    setIsNew(!t);
    setActionsText(pretty(tpl.actions || []));
    setConditionsText(pretty(tpl.conditions || []));
    setTriggerText(tpl.instantiation_trigger ? pretty(tpl.instantiation_trigger) : '');
  };

  const closeEdit = () => {
    setEditing(null);
    setIsNew(false);
  };

  const saveTemplate = async () => {
    if (!editing.name?.trim()) { showError('Name is required'); return; }
    let parsedActions, parsedConditions, parsedTrigger;
    try { parsedActions = JSON.parse(actionsText || '[]'); }
    catch (e) { showError('Invalid Actions JSON: ' + e.message); return; }
    if (!Array.isArray(parsedActions) || parsedActions.length === 0) {
      showError('Actions must be a non-empty array'); return;
    }
    try { parsedConditions = JSON.parse(conditionsText || '[]'); }
    catch (e) { showError('Invalid Conditions JSON: ' + e.message); return; }
    try { parsedTrigger = triggerText.trim() ? JSON.parse(triggerText) : null; }
    catch (e) { showError('Invalid Instantiation Trigger JSON: ' + e.message); return; }

    // Validate parameter rows
    const cleanedParams = [];
    for (const p of (editing.parameters || [])) {
      if (!p.name?.trim()) { showError('Every parameter needs a name'); return; }
      const cleaned = {
        name: p.name.trim(),
        type: p.type || 'string',
        required: !!p.required,
        description: p.description || '',
      };
      if (p.default !== undefined && p.default !== '') cleaned.default = p.default;
      if (p.min !== undefined && p.min !== '' && p.min !== null) cleaned.min = Number(p.min);
      if (p.max !== undefined && p.max !== '' && p.max !== null) cleaned.max = Number(p.max);
      if (p.choices && Array.isArray(p.choices) && p.choices.length) cleaned.choices = p.choices;
      cleanedParams.push(cleaned);
    }

    // Validate target_effects rows
    const cleanedEffects = [];
    for (const e of (editing.target_effects || [])) {
      if (!e.metric_name?.trim()) continue; // skip empty rows
      if (!['raise', 'lower', 'neutral'].includes(e.direction)) {
        showError(`Effect for "${e.metric_name}" has invalid direction "${e.direction}"`);
        return;
      }
      cleanedEffects.push({
        metric_name: e.metric_name.trim(),
        direction: e.direction,
        magnitude_hint: e.magnitude_hint || '',
      });
    }

    const payload = {
      name: editing.name.trim(),
      description: editing.description || '',
      category: editing.category || 'General',
      agent_usage_notes: editing.agent_usage_notes || '',
      default_trigger_type: editing.default_trigger_type || 'schedule',
      parameters: cleanedParams,
      conditions: parsedConditions,
      actions: parsedActions,
      instantiation_trigger: parsedTrigger,
      target_effects: cleanedEffects,
    };

    try {
      const url = isNew
        ? `${API_BASE}/automation-templates`
        : `${API_BASE}/automation-templates/${editing.id}`;
      const res = await fetch(url, {
        method: isNew ? 'POST' : 'PUT',
        headers,
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const saved = await res.json();
        showSuccess(isNew ? 'Template created' : 'Template updated');
        closeEdit();
        await fetchTemplates();
        setSelected(saved);
      } else {
        const data = await res.json().catch(() => ({}));
        showError(data.error || 'Save failed');
      }
    } catch (err) {
      showError(err.message);
    }
  };

  const deleteTemplate = async (t) => {
    if (!canEdit || t.is_system) return;
    if (!window.confirm(`Delete template "${t.name}"? Linked automations keep their actions but lose the template reference.`)) return;
    try {
      const res = await fetch(`${API_BASE}/automation-templates/${t.id}`, { method: 'DELETE', headers });
      if (res.ok) {
        showSuccess('Template deleted');
        setSelected(null);
        await fetchTemplates();
      } else {
        const data = await res.json().catch(() => ({}));
        showError(data.error || 'Delete failed');
      }
    } catch (err) {
      showError(err.message);
    }
  };

  const updateParam = (idx, key, value) => {
    setEditing(e => {
      const params = [...(e.parameters || [])];
      params[idx] = { ...params[idx], [key]: value };
      return { ...e, parameters: params };
    });
  };
  const addParam = () => setEditing(e => ({ ...e, parameters: [...(e.parameters || []), emptyParameter()] }));
  const removeParam = (idx) => setEditing(e => {
    const params = [...(e.parameters || [])];
    params.splice(idx, 1);
    return { ...e, parameters: params };
  });

  const updateEffect = (idx, key, value) => {
    setEditing(e => {
      const effs = [...(e.target_effects || [])];
      effs[idx] = { ...effs[idx], [key]: value };
      return { ...e, target_effects: effs };
    });
  };
  const addEffect = () => setEditing(e => ({ ...e, target_effects: [...(e.target_effects || []), emptyEffect()] }));
  const removeEffect = (idx) => setEditing(e => {
    const effs = [...(e.target_effects || [])];
    effs.splice(idx, 1);
    return { ...e, target_effects: effs };
  });

  const categories = useMemo(() => {
    const set = new Set(['All']);
    for (const t of templates) if (t.category) set.add(t.category);
    return Array.from(set);
  }, [templates]);

  const filtered = useMemo(() => {
    const q = filter.toLowerCase().trim();
    return templates.filter(t => {
      if (categoryFilter !== 'All' && t.category !== categoryFilter) return false;
      if (!q) return true;
      return (
        (t.name || '').toLowerCase().includes(q) ||
        (t.description || '').toLowerCase().includes(q) ||
        (t.agent_usage_notes || '').toLowerCase().includes(q)
      );
    });
  }, [templates, filter, categoryFilter]);

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      <div className="flex items-start justify-between mb-4 gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Automation Templates</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            Pre-validated recipes the AI planner instantiates with parameters. Encode your domain rules (paired pumps, hysteresis pairs, alert escalation) here.
          </p>
        </div>
        {canEdit && (
          <button
            onClick={() => openEdit(null)}
            className="px-3 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded"
          >
            + New Template
          </button>
        )}
      </div>

      <div className="flex gap-2 flex-wrap mb-4 items-center">
        <input
          type="text"
          placeholder="Search name / description / agent notes…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="flex-1 min-w-[200px] px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded"
        />
        <select
          value={categoryFilter}
          onChange={e => setCategoryFilter(e.target.value)}
          className="px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded"
        >
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)] gap-4">
        {/* List */}
        <aside className="lg:border-r lg:border-gray-200 dark:lg:border-gray-700 lg:pr-3">
          {loading && <div className="text-sm text-gray-500">Loading…</div>}
          {!loading && filtered.length === 0 && (
            <div className="text-sm text-gray-500 dark:text-gray-400">No templates.</div>
          )}
          <div className="space-y-1 max-h-[75vh] overflow-y-auto">
            {filtered.map(t => (
              <button
                key={t.id}
                onClick={() => setSelected(t)}
                className={`w-full text-left px-2 py-1.5 rounded text-sm transition-colors ${
                  selected?.id === t.id
                    ? 'bg-indigo-100 dark:bg-indigo-900 text-indigo-900 dark:text-indigo-100'
                    : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium truncate">{t.name}</div>
                  {t.is_system ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 font-mono">SYS</span>
                  ) : null}
                </div>
                <div className="flex items-center gap-1 mt-0.5">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${CATEGORY_COLOR[t.category] || 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200'}`}>
                    {t.category}
                  </span>
                  {Array.isArray(t.parameters) && t.parameters.length > 0 && (
                    <span className="text-[10px] text-gray-500 dark:text-gray-400 font-mono">{t.parameters.length} param{t.parameters.length === 1 ? '' : 's'}</span>
                  )}
                </div>
              </button>
            ))}
          </div>
        </aside>

        {/* Detail */}
        <main>
          {!selected && (
            <div className="text-sm text-gray-500 dark:text-gray-400 p-8 text-center border border-dashed border-gray-300 dark:border-gray-700 rounded">
              Select a template or create a new one.
            </div>
          )}
          {selected && (
            <div className="space-y-4">
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{selected.name}</h2>
                      <span className={`text-xs px-2 py-0.5 rounded font-semibold ${CATEGORY_COLOR[selected.category] || 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200'}`}>
                        {selected.category}
                      </span>
                      {selected.is_system && (
                        <span className="text-xs px-2 py-0.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 font-mono">system</span>
                      )}
                      <span className="text-xs px-2 py-0.5 rounded bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-200 font-mono">
                        {selected.default_trigger_type || 'schedule'}
                      </span>
                    </div>
                    {selected.description && (
                      <p className="text-sm text-gray-700 dark:text-gray-300">{selected.description}</p>
                    )}
                  </div>
                  {canEdit && (
                    <div className="flex gap-2">
                      <button
                        onClick={() => openEdit(selected)}
                        className="px-3 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
                      >
                        Edit
                      </button>
                      {!selected.is_system && (
                        <button
                          onClick={() => deleteTemplate(selected)}
                          className="px-3 py-1 text-xs text-red-600 dark:text-red-400 hover:underline"
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {selected.agent_usage_notes && (
                  <div className="mt-3 text-sm text-indigo-800 dark:text-indigo-200 bg-indigo-50 dark:bg-indigo-900/30 border-l-2 border-indigo-400 px-3 py-2 rounded">
                    <span className="font-semibold">For the AI planner:</span> {selected.agent_usage_notes}
                  </div>
                )}
              </div>

              {Array.isArray(selected.parameters) && selected.parameters.length > 0 && (
                <div>
                  <h3 className="text-sm uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">Parameters ({selected.parameters.length})</h3>
                  <div className="overflow-x-auto">
                    <table className="text-sm w-full">
                      <thead>
                        <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                          <th className="py-1 pr-2">Name</th>
                          <th className="py-1 pr-2">Type</th>
                          <th className="py-1 pr-2">Required</th>
                          <th className="py-1 pr-2">Default</th>
                          <th className="py-1 pr-2">Min/Max</th>
                          <th className="py-1 pr-2">Description</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selected.parameters.map((p, i) => (
                          <tr key={i} className="border-b border-gray-100 dark:border-gray-700">
                            <td className="py-1 pr-2 font-mono text-gray-900 dark:text-gray-100">{p.name}</td>
                            <td className="py-1 pr-2 text-gray-600 dark:text-gray-400 font-mono">{p.type}</td>
                            <td className="py-1 pr-2">{p.required ? '✓' : ''}</td>
                            <td className="py-1 pr-2 font-mono text-gray-600 dark:text-gray-400">{p.default ?? ''}</td>
                            <td className="py-1 pr-2 font-mono text-gray-600 dark:text-gray-400">
                              {(p.min ?? '') + (p.max != null ? ` / ${p.max}` : '')}
                            </td>
                            <td className="py-1 pr-2 text-gray-700 dark:text-gray-300">{p.description}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {Array.isArray(selected.target_effects) && selected.target_effects.length > 0 && (
                <div>
                  <h3 className="text-sm uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">
                    Target effects — used by the skip evaluator
                  </h3>
                  <div className="text-xs text-gray-600 dark:text-gray-400 mb-2 italic">
                    When the active plan declares a target on one of these metrics, the engine will auto-skip this automation
                    if the sensor is already past the band (with a 10% margin) in the direction this template would push.
                  </div>
                  <div className="space-y-1">
                    {selected.target_effects.map((e, i) => (
                      <div key={i} className="flex items-center gap-2 text-sm">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase ${EFFECT_DIRECTION_COLOR[e.direction] || EFFECT_DIRECTION_COLOR.neutral}`}>
                          {e.direction}
                        </span>
                        <span className="font-mono text-gray-900 dark:text-gray-100">{e.metric_name}</span>
                        {e.magnitude_hint && <span className="text-xs text-gray-500 dark:text-gray-400">({e.magnitude_hint})</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <h3 className="text-sm uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">Action blueprint</h3>
                <pre className="text-xs p-3 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded overflow-x-auto">{pretty(selected.actions)}</pre>
              </div>

              {Array.isArray(selected.conditions) && selected.conditions.length > 0 && (
                <div>
                  <h3 className="text-sm uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">Conditions</h3>
                  <pre className="text-xs p-3 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded overflow-x-auto">{pretty(selected.conditions)}</pre>
                </div>
              )}

              {selected.instantiation_trigger && (
                <div>
                  <h3 className="text-sm uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">Default trigger (overridable)</h3>
                  <pre className="text-xs p-3 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded overflow-x-auto">{pretty(selected.instantiation_trigger)}</pre>
                </div>
              )}
            </div>
          )}
        </main>
      </div>

      {/* Edit modal */}
      {editing && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl max-w-3xl w-full p-5 my-8">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                {isNew ? 'New template' : `Edit "${editing.name}"`}
                {editing.is_system && <span className="ml-2 text-xs px-2 py-0.5 rounded bg-gray-200 dark:bg-gray-700 font-mono">system</span>}
              </h3>
              <button onClick={closeEdit} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>

            <div className="space-y-3 max-h-[70vh] overflow-y-auto pr-1">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Name *</label>
                  <input
                    type="text" value={editing.name || ''}
                    onChange={e => setEditing(s => ({ ...s, name: e.target.value }))}
                    className="w-full px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Category</label>
                  <input
                    type="text" value={editing.category || ''}
                    onChange={e => setEditing(s => ({ ...s, category: e.target.value }))}
                    className="w-full px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Description (human-readable)</label>
                <textarea
                  rows={2} value={editing.description || ''}
                  onChange={e => setEditing(s => ({ ...s, description: e.target.value }))}
                  className="w-full px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">
                  Agent usage notes <span className="text-indigo-600 dark:text-indigo-300">(what the AI planner reads to decide when to use this)</span>
                </label>
                <textarea
                  rows={3} value={editing.agent_usage_notes || ''}
                  onChange={e => setEditing(s => ({ ...s, agent_usage_notes: e.target.value }))}
                  placeholder="When to use this template, when NOT to use it, constraints, paired-template requirements…"
                  className="w-full px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Default trigger type</label>
                <select
                  value={editing.default_trigger_type || 'schedule'}
                  onChange={e => setEditing(s => ({ ...s, default_trigger_type: e.target.value }))}
                  className="w-full px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded"
                >
                  {TRIGGER_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>

              {/* Parameters */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs text-gray-600 dark:text-gray-400">Parameters</label>
                  <button
                    onClick={addParam}
                    className="text-xs text-indigo-600 dark:text-indigo-300 hover:underline"
                  >+ Add parameter</button>
                </div>
                {(editing.parameters || []).length === 0 && (
                  <div className="text-xs text-gray-500 dark:text-gray-400 italic">No parameters — the agent has nothing to fill in.</div>
                )}
                <div className="space-y-2">
                  {(editing.parameters || []).map((p, i) => (
                    <div key={i} className="border border-gray-200 dark:border-gray-700 rounded p-2 bg-gray-50 dark:bg-gray-800/50">
                      <div className="grid grid-cols-12 gap-2">
                        <input
                          placeholder="name"
                          value={p.name || ''}
                          onChange={e => updateParam(i, 'name', e.target.value)}
                          className="col-span-3 px-1.5 py-1 text-xs font-mono border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded"
                        />
                        <select
                          value={p.type || 'string'}
                          onChange={e => updateParam(i, 'type', e.target.value)}
                          className="col-span-2 px-1.5 py-1 text-xs border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded"
                        >
                          {PARAM_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                        </select>
                        <label className="col-span-2 flex items-center text-xs text-gray-600 dark:text-gray-400 gap-1">
                          <input
                            type="checkbox" checked={!!p.required}
                            onChange={e => updateParam(i, 'required', e.target.checked)}
                          />
                          required
                        </label>
                        <input
                          placeholder="default"
                          value={p.default ?? ''}
                          onChange={e => updateParam(i, 'default', e.target.value)}
                          className="col-span-2 px-1.5 py-1 text-xs border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded"
                        />
                        <input
                          placeholder="min"
                          value={p.min ?? ''}
                          onChange={e => updateParam(i, 'min', e.target.value)}
                          className="col-span-1 px-1.5 py-1 text-xs border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded"
                        />
                        <input
                          placeholder="max"
                          value={p.max ?? ''}
                          onChange={e => updateParam(i, 'max', e.target.value)}
                          className="col-span-1 px-1.5 py-1 text-xs border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded"
                        />
                        <button
                          onClick={() => removeParam(i)}
                          className="col-span-1 text-xs text-red-600 dark:text-red-400 hover:underline"
                        >✕</button>
                      </div>
                      <input
                        placeholder="description (shown to the AI planner)"
                        value={p.description || ''}
                        onChange={e => updateParam(i, 'description', e.target.value)}
                        className="w-full mt-1 px-1.5 py-1 text-xs border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded"
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* Target effects */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs text-gray-600 dark:text-gray-400">
                    Target effects <span className="text-emerald-600 dark:text-emerald-300">(drives auto-skip when a plan target on this metric is in the wrong direction)</span>
                  </label>
                  <button
                    onClick={addEffect}
                    className="text-xs text-indigo-600 dark:text-indigo-300 hover:underline"
                  >+ Add effect</button>
                </div>
                {(editing.target_effects || []).length === 0 && (
                  <div className="text-xs text-gray-500 dark:text-gray-400 italic">No target effects — the skip evaluator will only use manual skip_conditions on each instance.</div>
                )}
                <div className="space-y-2">
                  {(editing.target_effects || []).map((e, i) => (
                    <div key={i} className="grid grid-cols-12 gap-2 items-center">
                      <input
                        placeholder='metric (e.g. "Substrate Moisture")'
                        value={e.metric_name || ''}
                        onChange={ev => updateEffect(i, 'metric_name', ev.target.value)}
                        className="col-span-6 px-1.5 py-1 text-xs font-mono border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded"
                      />
                      <select
                        value={e.direction || 'raise'}
                        onChange={ev => updateEffect(i, 'direction', ev.target.value)}
                        className="col-span-2 px-1.5 py-1 text-xs border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded"
                      >
                        {EFFECT_DIRECTIONS.map(d => <option key={d} value={d}>{d}</option>)}
                      </select>
                      <input
                        placeholder='magnitude hint (e.g. "moderate")'
                        value={e.magnitude_hint || ''}
                        onChange={ev => updateEffect(i, 'magnitude_hint', ev.target.value)}
                        className="col-span-3 px-1.5 py-1 text-xs border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded"
                      />
                      <button
                        onClick={() => removeEffect(i)}
                        className="col-span-1 text-xs text-red-600 dark:text-red-400 hover:underline"
                      >✕</button>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">
                  Actions blueprint (JSON, supports <code className="font-mono">${'{param_name}'}</code> placeholders)
                </label>
                <textarea
                  rows={6} value={actionsText}
                  onChange={e => setActionsText(e.target.value)}
                  className="w-full px-2 py-1 text-xs font-mono border border-gray-300 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Conditions (JSON, optional)</label>
                <textarea
                  rows={2} value={conditionsText}
                  onChange={e => setConditionsText(e.target.value)}
                  className="w-full px-2 py-1 text-xs font-mono border border-gray-300 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Instantiation trigger (JSON, optional — agent can override)</label>
                <textarea
                  rows={2} value={triggerText}
                  onChange={e => setTriggerText(e.target.value)}
                  placeholder='e.g. {"type":"schedule","schedule_type":"daily","time":"06:00"}'
                  className="w-full px-2 py-1 text-xs font-mono border border-gray-300 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded"
                />
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={closeEdit}
                className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded text-gray-700 dark:text-gray-200"
              >Cancel</button>
              <button
                onClick={saveTemplate}
                className="px-3 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded"
              >Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
