import React, { useState, useEffect, useMemo } from 'react';
import { Trans, useTranslation } from 'react-i18next';
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
/** Sentinel value of the category filter ("all categories"); never shown as text. */
const ALL = 'All';
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
  const { t } = useTranslation('templates');
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
  const [categoryFilter, setCategoryFilter] = useState(ALL);

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
      showError(t('errors.loadFailed', { error: err.message }));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchTemplates(); /* eslint-disable-next-line */ }, []);

  const openEdit = (source) => {
    const tpl = source ? { ...source } : emptyTemplate();
    setEditing(tpl);
    setIsNew(!source);
    setActionsText(pretty(tpl.actions || []));
    setConditionsText(pretty(tpl.conditions || []));
    setTriggerText(tpl.instantiation_trigger ? pretty(tpl.instantiation_trigger) : '');
  };

  const closeEdit = () => {
    setEditing(null);
    setIsNew(false);
  };

  const saveTemplate = async () => {
    if (!editing.name?.trim()) { showError(t('errors.nameRequired')); return; }
    let parsedActions, parsedConditions, parsedTrigger;
    try { parsedActions = JSON.parse(actionsText || '[]'); }
    catch (e) { showError(t('errors.invalidActions', { error: e.message })); return; }
    if (!Array.isArray(parsedActions) || parsedActions.length === 0) {
      showError(t('errors.actionsNonEmpty')); return;
    }
    try { parsedConditions = JSON.parse(conditionsText || '[]'); }
    catch (e) { showError(t('errors.invalidConditions', { error: e.message })); return; }
    try { parsedTrigger = triggerText.trim() ? JSON.parse(triggerText) : null; }
    catch (e) { showError(t('errors.invalidTrigger', { error: e.message })); return; }

    // Validate parameter rows
    const cleanedParams = [];
    for (const p of (editing.parameters || [])) {
      if (!p.name?.trim()) { showError(t('errors.paramNeedsName')); return; }
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
        showError(t('errors.invalidDirection', { metric: e.metric_name, direction: e.direction }));
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
        showSuccess(isNew ? t('toast.created') : t('toast.updated'));
        closeEdit();
        await fetchTemplates();
        setSelected(saved);
      } else {
        const data = await res.json().catch(() => ({}));
        showError(data.error || t('errors.saveFailed'));
      }
    } catch (err) {
      showError(err.message);
    }
  };

  const deleteTemplate = async (tpl) => {
    if (!canEdit || tpl.is_system) return;
    if (!window.confirm(t('confirmDelete', { name: tpl.name }))) return;
    try {
      const res = await fetch(`${API_BASE}/automation-templates/${tpl.id}`, { method: 'DELETE', headers });
      if (res.ok) {
        showSuccess(t('toast.deleted'));
        setSelected(null);
        await fetchTemplates();
      } else {
        const data = await res.json().catch(() => ({}));
        showError(data.error || t('errors.deleteFailed'));
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
    const set = new Set([ALL]);
    for (const tpl of templates) if (tpl.category) set.add(tpl.category);
    return Array.from(set);
  }, [templates]);

  const filtered = useMemo(() => {
    const q = filter.toLowerCase().trim();
    return templates.filter(tpl => {
      if (categoryFilter !== ALL && tpl.category !== categoryFilter) return false;
      if (!q) return true;
      return (
        (tpl.name || '').toLowerCase().includes(q) ||
        (tpl.description || '').toLowerCase().includes(q) ||
        (tpl.agent_usage_notes || '').toLowerCase().includes(q)
      );
    });
  }, [templates, filter, categoryFilter]);

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      <div className="flex items-start justify-between mb-4 gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t('page.title')}</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            {t('page.intro')}
          </p>
        </div>
        {canEdit && (
          <button
            onClick={() => openEdit(null)}
            className="px-3 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded"
          >
            {t('page.newTemplate')}
          </button>
        )}
      </div>

      <div className="flex gap-2 flex-wrap mb-4 items-center">
        <input
          type="text"
          placeholder={t('page.searchPlaceholder')}
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="flex-1 min-w-[200px] px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded"
        />
        <select
          value={categoryFilter}
          aria-label={t('page.categoryFilter')}
          onChange={e => setCategoryFilter(e.target.value)}
          className="px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded"
        >
          {categories.map(c => <option key={c} value={c}>{c === ALL ? t('page.allCategories') : t(`category.${c}`, { defaultValue: c })}</option>)}
        </select>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)] gap-4">
        {/* List */}
        <aside className="lg:border-e lg:border-gray-200 dark:lg:border-gray-700 lg:pe-3">
          {loading && <div className="text-sm text-gray-500">{t('common:status.loading')}</div>}
          {!loading && filtered.length === 0 && (
            <div className="text-sm text-gray-500 dark:text-gray-400">{t('page.noTemplates')}</div>
          )}
          <div className="space-y-1 max-h-[75vh] overflow-y-auto">
            {filtered.map(tpl => (
              <button
                key={tpl.id}
                onClick={() => setSelected(tpl)}
                className={`w-full text-start px-2 py-1.5 rounded text-sm transition-colors ${
                  selected?.id === tpl.id
                    ? 'bg-indigo-100 dark:bg-indigo-900 text-indigo-900 dark:text-indigo-100'
                    : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium truncate" dir="auto">{tpl.name}</div>
                  {tpl.is_system ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 font-mono" title={t('system')}>{t('page.systemShort')}</span>
                  ) : null}
                </div>
                <div className="flex items-center gap-1 mt-0.5">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${CATEGORY_COLOR[tpl.category] || 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200'}`}>
                    {t(`category.${tpl.category}`, { defaultValue: tpl.category })}
                  </span>
                  {Array.isArray(tpl.parameters) && tpl.parameters.length > 0 && (
                    <span className="text-[10px] text-gray-500 dark:text-gray-400 font-mono">{t('page.paramCount', { count: tpl.parameters.length })}</span>
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
              {t('page.selectPrompt')}
            </div>
          )}
          {selected && (
            <div className="space-y-4">
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
                  <div>
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <h2 className="text-lg font-semibold text-gray-900 dark:text-white" dir="auto">{selected.name}</h2>
                      <span className={`text-xs px-2 py-0.5 rounded font-semibold ${CATEGORY_COLOR[selected.category] || 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200'}`}>
                        {t(`category.${selected.category}`, { defaultValue: selected.category })}
                      </span>
                      {selected.is_system && (
                        <span className="text-xs px-2 py-0.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 font-mono">{t('page.systemBadge')}</span>
                      )}
                      <span className="text-xs px-2 py-0.5 rounded bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-200 font-mono">
                        {t(`triggerType.${selected.default_trigger_type || 'schedule'}`, { defaultValue: selected.default_trigger_type })}
                      </span>
                    </div>
                    {selected.description && (
                      <p className="text-sm text-gray-700 dark:text-gray-300" dir="auto">{selected.description}</p>
                    )}
                  </div>
                  {canEdit && (
                    <div className="flex gap-2">
                      <button
                        onClick={() => openEdit(selected)}
                        className="px-3 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
                      >
                        {t('common:actions.edit')}
                      </button>
                      {!selected.is_system && (
                        <button
                          onClick={() => deleteTemplate(selected)}
                          className="px-3 py-1 text-xs text-red-600 dark:text-red-400 hover:underline"
                        >
                          {t('common:actions.delete')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {selected.agent_usage_notes && (
                  <div className="mt-3 text-sm text-indigo-800 dark:text-indigo-200 bg-indigo-50 dark:bg-indigo-900/30 border-s-2 border-indigo-400 px-3 py-2 rounded">
                    <span className="font-semibold">{t('page.forPlanner')}</span> <span dir="auto">{selected.agent_usage_notes}</span>
                  </div>
                )}
              </div>

              {Array.isArray(selected.parameters) && selected.parameters.length > 0 && (
                <div>
                  <h3 className="text-sm uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">{t('page.parameters', { n: selected.parameters.length })}</h3>
                  <div className="overflow-x-auto">
                    <table className="text-sm w-full">
                      <thead>
                        <tr className="text-start text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                          <th className="py-1 pe-2 text-start">{t('page.col.name')}</th>
                          <th className="py-1 pe-2 text-start">{t('page.col.type')}</th>
                          <th className="py-1 pe-2 text-start">{t('page.col.required')}</th>
                          <th className="py-1 pe-2 text-start">{t('page.col.default')}</th>
                          <th className="py-1 pe-2 text-start">{t('page.col.minMax')}</th>
                          <th className="py-1 pe-2 text-start">{t('page.col.description')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selected.parameters.map((p, i) => (
                          <tr key={i} className="border-b border-gray-100 dark:border-gray-700">
                            <td className="py-1 pe-2 font-mono text-gray-900 dark:text-gray-100" dir="ltr">{p.name}</td>
                            <td className="py-1 pe-2 text-gray-600 dark:text-gray-400 font-mono">{p.type}</td>
                            <td className="py-1 pe-2">{p.required ? <span aria-label={t('page.yes')}>✓</span> : ''}</td>
                            <td className="py-1 pe-2 font-mono text-gray-600 dark:text-gray-400" dir="ltr">{p.default ?? ''}</td>
                            <td className="py-1 pe-2 font-mono text-gray-600 dark:text-gray-400" dir="ltr">
                              {(p.min ?? '') + (p.max != null ? ` / ${p.max}` : '')}
                            </td>
                            <td className="py-1 pe-2 text-gray-700 dark:text-gray-300" dir="auto">{p.description}</td>
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
                    {t('page.targetEffectsTitle')}
                  </h3>
                  <div className="text-xs text-gray-600 dark:text-gray-400 mb-2 italic">
                    {t('page.targetEffectsHelp')}
                  </div>
                  <div className="space-y-1">
                    {selected.target_effects.map((e, i) => (
                      <div key={i} className="flex items-center gap-2 text-sm">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase ${EFFECT_DIRECTION_COLOR[e.direction] || EFFECT_DIRECTION_COLOR.neutral}`}>
                          {t(`direction.${e.direction}`, { defaultValue: e.direction })}
                        </span>
                        <span className="font-mono text-gray-900 dark:text-gray-100" dir="auto">{e.metric_name}</span>
                        {e.magnitude_hint && <span className="text-xs text-gray-500 dark:text-gray-400" dir="auto">({e.magnitude_hint})</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <h3 className="text-sm uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">{t('page.actionBlueprint')}</h3>
                <pre dir="ltr" className="text-xs p-3 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded overflow-x-auto">{pretty(selected.actions)}</pre>
              </div>

              {Array.isArray(selected.conditions) && selected.conditions.length > 0 && (
                <div>
                  <h3 className="text-sm uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">{t('page.conditions')}</h3>
                  <pre dir="ltr" className="text-xs p-3 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded overflow-x-auto">{pretty(selected.conditions)}</pre>
                </div>
              )}

              {selected.instantiation_trigger && (
                <div>
                  <h3 className="text-sm uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">{t('page.defaultTrigger')}</h3>
                  <pre dir="ltr" className="text-xs p-3 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded overflow-x-auto">{pretty(selected.instantiation_trigger)}</pre>
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
                {isNew ? t('editor.newTitle') : t('editor.editTitle', { name: editing.name })}
                {editing.is_system && <span className="ms-2 text-xs px-2 py-0.5 rounded bg-gray-200 dark:bg-gray-700 font-mono">{t('page.systemBadge')}</span>}
              </h3>
              <button onClick={closeEdit} className="text-gray-400 hover:text-gray-600" aria-label={t('common:actions.close')}>✕</button>
            </div>

            <div className="space-y-3 max-h-[70vh] overflow-y-auto pe-1">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('editor.nameRequired')}</label>
                  <input
                    type="text" dir="auto" value={editing.name || ''}
                    onChange={e => setEditing(s => ({ ...s, name: e.target.value }))}
                    className="w-full px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('editor.category')}</label>
                  <input
                    type="text" dir="auto" value={editing.category || ''}
                    onChange={e => setEditing(s => ({ ...s, category: e.target.value }))}
                    className="w-full px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('editor.description')}</label>
                <textarea
                  rows={2} dir="auto" value={editing.description || ''}
                  onChange={e => setEditing(s => ({ ...s, description: e.target.value }))}
                  className="w-full px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">
                  {t('editor.agentNotes')} <span className="text-indigo-600 dark:text-indigo-300">{t('editor.agentNotesHint')}</span>
                </label>
                <textarea
                  rows={3} dir="auto" value={editing.agent_usage_notes || ''}
                  onChange={e => setEditing(s => ({ ...s, agent_usage_notes: e.target.value }))}
                  placeholder={t('editor.agentNotesPlaceholder')}
                  className="w-full px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('editor.defaultTriggerType')}</label>
                <select
                  value={editing.default_trigger_type || 'schedule'}
                  onChange={e => setEditing(s => ({ ...s, default_trigger_type: e.target.value }))}
                  className="w-full px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded"
                >
                  {TRIGGER_TYPES.map(tt => <option key={tt} value={tt}>{t(`triggerType.${tt}`)}</option>)}
                </select>
              </div>

              {/* Parameters */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs text-gray-600 dark:text-gray-400">{t('editor.parameters')}</label>
                  <button
                    onClick={addParam}
                    className="text-xs text-indigo-600 dark:text-indigo-300 hover:underline"
                  >{t('editor.addParameter')}</button>
                </div>
                {(editing.parameters || []).length === 0 && (
                  <div className="text-xs text-gray-500 dark:text-gray-400 italic">{t('editor.noParameters')}</div>
                )}
                <div className="space-y-2">
                  {(editing.parameters || []).map((p, i) => (
                    <div key={i} className="border border-gray-200 dark:border-gray-700 rounded p-2 bg-gray-50 dark:bg-gray-800/50">
                      <div className="grid grid-cols-12 gap-2">
                        <input
                          placeholder={t('editor.paramName')}
                          aria-label={t('editor.paramName')}
                          dir="ltr"
                          value={p.name || ''}
                          onChange={e => updateParam(i, 'name', e.target.value)}
                          className="col-span-3 px-1.5 py-1 text-xs font-mono border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded"
                        />
                        <select
                          aria-label={t('editor.paramType')}
                          value={p.type || 'string'}
                          onChange={e => updateParam(i, 'type', e.target.value)}
                          className="col-span-2 px-1.5 py-1 text-xs border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded"
                        >
                          {PARAM_TYPES.map(pt => <option key={pt} value={pt}>{pt}</option>)}
                        </select>
                        <label className="col-span-2 flex items-center text-xs text-gray-600 dark:text-gray-400 gap-1">
                          <input
                            type="checkbox" checked={!!p.required}
                            onChange={e => updateParam(i, 'required', e.target.checked)}
                          />
                          {t('editor.paramRequired')}
                        </label>
                        <input
                          placeholder={t('editor.paramDefault')}
                          aria-label={t('editor.paramDefault')}
                          value={p.default ?? ''}
                          onChange={e => updateParam(i, 'default', e.target.value)}
                          className="col-span-2 px-1.5 py-1 text-xs border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded"
                        />
                        <input
                          placeholder={t('editor.paramMin')}
                          aria-label={t('editor.paramMin')}
                          dir="ltr"
                          value={p.min ?? ''}
                          onChange={e => updateParam(i, 'min', e.target.value)}
                          className="col-span-1 px-1.5 py-1 text-xs border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded"
                        />
                        <input
                          placeholder={t('editor.paramMax')}
                          aria-label={t('editor.paramMax')}
                          dir="ltr"
                          value={p.max ?? ''}
                          onChange={e => updateParam(i, 'max', e.target.value)}
                          className="col-span-1 px-1.5 py-1 text-xs border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded"
                        />
                        <button
                          onClick={() => removeParam(i)}
                          aria-label={t('editor.removeParameter')}
                          className="col-span-1 text-xs text-red-600 dark:text-red-400 hover:underline"
                        >✕</button>
                      </div>
                      <input
                        placeholder={t('editor.paramDescription')}
                        aria-label={t('editor.paramDescription')}
                        dir="auto"
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
                    {t('editor.targetEffects')} <span className="text-emerald-600 dark:text-emerald-300">{t('editor.targetEffectsHint')}</span>
                  </label>
                  <button
                    onClick={addEffect}
                    className="shrink-0 text-xs text-indigo-600 dark:text-indigo-300 hover:underline"
                  >{t('editor.addEffect')}</button>
                </div>
                {(editing.target_effects || []).length === 0 && (
                  <div className="text-xs text-gray-500 dark:text-gray-400 italic">{t('editor.noEffects')}</div>
                )}
                <div className="space-y-2">
                  {(editing.target_effects || []).map((e, i) => (
                    <div key={i} className="grid grid-cols-12 gap-2 items-center">
                      <input
                        placeholder={t('editor.effectMetric')}
                        aria-label={t('editor.effectMetric')}
                        dir="auto"
                        value={e.metric_name || ''}
                        onChange={ev => updateEffect(i, 'metric_name', ev.target.value)}
                        className="col-span-6 px-1.5 py-1 text-xs font-mono border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded"
                      />
                      <select
                        aria-label={t('editor.effectDirection')}
                        value={e.direction || 'raise'}
                        onChange={ev => updateEffect(i, 'direction', ev.target.value)}
                        className="col-span-2 px-1.5 py-1 text-xs border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded"
                      >
                        {EFFECT_DIRECTIONS.map(d => <option key={d} value={d}>{t(`direction.${d}`)}</option>)}
                      </select>
                      <input
                        placeholder={t('editor.effectMagnitude')}
                        aria-label={t('editor.effectMagnitude')}
                        dir="auto"
                        value={e.magnitude_hint || ''}
                        onChange={ev => updateEffect(i, 'magnitude_hint', ev.target.value)}
                        className="col-span-3 px-1.5 py-1 text-xs border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-white rounded"
                      />
                      <button
                        onClick={() => removeEffect(i)}
                        aria-label={t('editor.removeEffect')}
                        className="col-span-1 text-xs text-red-600 dark:text-red-400 hover:underline"
                      >✕</button>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">
                  <Trans t={t} i18nKey="editor.actionsJson" components={{ code: <code className="font-mono" dir="ltr" /> }} />
                </label>
                <textarea
                  rows={6} dir="ltr" value={actionsText}
                  onChange={e => setActionsText(e.target.value)}
                  className="w-full px-2 py-1 text-xs font-mono border border-gray-300 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('editor.conditionsJson')}</label>
                <textarea
                  rows={2} dir="ltr" value={conditionsText}
                  onChange={e => setConditionsText(e.target.value)}
                  className="w-full px-2 py-1 text-xs font-mono border border-gray-300 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('editor.triggerJson')}</label>
                <textarea
                  rows={2} dir="ltr" value={triggerText}
                  onChange={e => setTriggerText(e.target.value)}
                  placeholder={t('editor.triggerPlaceholder', { example: '{"type":"schedule","schedule_type":"daily","time":"06:00"}' })}
                  className="w-full px-2 py-1 text-xs font-mono border border-gray-300 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded"
                />
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={closeEdit}
                className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded text-gray-700 dark:text-gray-200"
              >{t('common:actions.cancel')}</button>
              <button
                onClick={saveTemplate}
                className="px-3 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded"
              >{t('common:actions.save')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
