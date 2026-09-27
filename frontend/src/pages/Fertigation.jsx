import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useSettings } from '../context/SettingsContext';
import { useToast } from '../context/ToastContext';
import { useThrottledError } from '../hooks/useThrottledError';
import { startPolling } from '../hooks/usePoll';
import { MeasuredDosingCard } from '../components/reports/MeasuredWater';
import FlowWatchStatus from '../components/FlowWatchStatus';
import DoseControllerStatus from '../components/DoseControllerStatus';
import StopIrrigationButton from '../components/irrigation/StopIrrigationButton';

const API_BASE = '/api';

const TABS = [
  { key: 'tanks', label: 'Tanks' },
  { key: 'dose_programs', label: 'Dose Programs' },
  { key: 'targets', label: 'Element Targets' },
  { key: 'consumption', label: 'Consumption' },
  { key: 'mixtures', label: 'Mixtures' },
  { key: 'channels', label: 'Channel Config' },
  { key: 'events', label: 'Event Log' },
];

export default function Fertigation() {
  const { token, user } = useAuth();
  const { formatDateTime } = useSettings();
  const canEdit = user?.role === 'admin' || user?.role === 'operator';
  const [activeTab, setActiveTab] = useState('tanks');
  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-6">Fertigation</h1>

      <div className="border-b border-gray-200 dark:border-gray-700 mb-6">
        <nav className="flex space-x-4 overflow-x-auto" aria-label="Tabs">
          {TABS.map(tab => (
            <button key={tab.key} onClick={() => setActiveTab(tab.key)}
              className={`py-2 px-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab.key
                  ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300'
              }`}>{tab.label}</button>
          ))}
        </nav>
      </div>

      {activeTab === 'tanks' && <TanksTab headers={headers} canEdit={canEdit} formatDateTime={formatDateTime} />}
      {activeTab === 'dose_programs' && <DoseProgramsTab headers={headers} canEdit={canEdit} />}
      {activeTab === 'targets' && <ElementTargetsTab headers={headers} canEdit={canEdit} />}
      {activeTab === 'consumption' && <ConsumptionTab headers={headers} formatDateTime={formatDateTime} />}
      {activeTab === 'mixtures' && <MixturesTab headers={headers} canEdit={canEdit} />}
      {activeTab === 'channels' && <ChannelConfigTab headers={headers} canEdit={canEdit} />}
      {activeTab === 'events' && <EventLogTab headers={headers} formatDateTime={formatDateTime} />}
    </div>
  );
}

/* ─── Consumption Tab ─── */
function ConsumptionTab({ headers, formatDateTime }) {
  const { showError: showConsumptionError } = useToast();
  const today = new Date().toISOString().split('T')[0];
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
  const [from, setFrom] = useState(weekAgo);
  const [to, setTo] = useState(today);
  const [data, setData] = useState(null);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchSummary = useCallback(() => {
    fetch(`${API_BASE}/fertigation/consumption/summary`, { headers })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(setSummary)
      .catch(err => showConsumptionError(`Could not load consumption summary: ${err.message}`));
  }, []);

  const fetchConsumption = useCallback(() => {
    setLoading(true);
    const toEnd = new Date(new Date(to).getTime() + 86400000).toISOString();
    fetch(`${API_BASE}/fertigation/consumption?from=${new Date(from).toISOString()}&to=${toEnd}&group_by=day`, { headers })
      .then(r => r.json()).then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false));
  }, [from, to]);

  useEffect(() => { fetchSummary(); fetchConsumption(); }, [fetchSummary, fetchConsumption]);

  return (
    <div className="space-y-6">
      {summary && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <SummaryCard title="Today" data={summary.today} />
          <SummaryCard title="This Week" data={summary.week} />
        </div>
      )}

      <MeasuredDosingCard headers={headers} />

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">From</label>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)}
            className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">To</label>
          <input type="date" value={to} onChange={e => setTo(e.target.value)}
            className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm" />
        </div>
        <button onClick={fetchConsumption}
          className="px-4 py-2 bg-primary-600 text-white text-sm rounded-lg hover:bg-primary-700 transition-colors">Refresh</button>
      </div>

      {loading ? <Spinner text="Loading consumption data..." /> : data ? (
        <div className="space-y-4">
          {data.ingredients.length > 0 ? (
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead className="bg-gray-50 dark:bg-gray-900">
                  <tr>
                    <TH>Ingredient</TH><TH right>Volume</TH><TH right>Run Time</TH>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {data.ingredients.map(ing => (
                    <tr key={ing.name}>
                      <TD bold>{ing.name}</TD>
                      <TD right>{ing.volume} {ing.unit}</TD>
                      <TD right>{ing.duration_minutes} min</TD>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="text-sm text-gray-500 dark:text-gray-400">No consumption data for this period.</p>}

          {data.daily && Object.keys(data.daily).length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Daily Breakdown</h3>
              <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
                <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                  <thead className="bg-gray-50 dark:bg-gray-900">
                    <tr><TH>Date</TH><TH>Ingredient</TH><TH right>Volume</TH><TH right>Run Time</TH></tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                    {Object.entries(data.daily).sort(([a], [b]) => b.localeCompare(a)).map(([day, ings]) =>
                      ings.map((ing, i) => (
                        <tr key={`${day}-${ing.name}`}>
                          {i === 0 && <td rowSpan={ings.length} className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-white align-top">{day}</td>}
                          <TD>{ing.name}</TD><TD right>{ing.volume} {ing.unit}</TD><TD right>{ing.duration_minutes} min</TD>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {data.unconfigured?.length > 0 && (
            <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-4">
              <p className="text-sm font-medium text-amber-800 dark:text-amber-400">Unconfigured channels had activity:</p>
              <ul className="mt-1 text-sm text-amber-700 dark:text-amber-300 list-disc list-inside">
                {data.unconfigured.map(u => <li key={`${u.equipment_id}-${u.channel}`}>Equipment #{u.equipment_id}, Channel {u.channel}</li>)}
              </ul>
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">Configure these in the Channel Config tab.</p>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function SummaryCard({ title, data }) {
  if (!data?.ingredients?.length) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
        <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 mb-2">{title}</h3>
        <p className="text-xs text-gray-400 dark:text-gray-500">No consumption</p>
      </div>
    );
  }
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
      <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 mb-3">{title}</h3>
      <div className="space-y-2">
        {data.ingredients.map(ing => (
          <div key={ing.name} className="flex justify-between items-center">
            <span className="text-sm font-medium text-gray-900 dark:text-white">{ing.name}</span>
            <span className="text-sm text-gray-600 dark:text-gray-300">{ing.volume} {ing.unit}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Mixtures Tab ─── */
function MixturesTab({ headers, canEdit }) {
  const [mixtures, setMixtures] = useState([]);
  const [ingredients, setIngredients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState(null); // null = list, 'new' = create, number = edit
  const [form, setForm] = useState({ name: '', description: '', items: [] });
  const [newIngredient, setNewIngredient] = useState('');
  const [editingIngredient, setEditingIngredient] = useState(null); // ingredient object or null
  const [message, setMessage] = useState(null);

  const fetchAll = () => {
    setLoading(true);
    Promise.all([
      fetch(`${API_BASE}/fertigation/mixtures`, { headers }).then(r => r.json()),
      fetch(`${API_BASE}/fertigation/ingredients`, { headers }).then(r => r.json()),
    ]).then(([m, i]) => { setMixtures(m); setIngredients(i); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(fetchAll, []);

  const addIngredient = async () => {
    if (!newIngredient.trim()) return;
    try {
      const res = await fetch(`${API_BASE}/fertigation/ingredients`, {
        method: 'POST', headers, body: JSON.stringify({ name: newIngredient.trim() })
      });
      if (!res.ok) { const e = await res.json(); setMessage({ type: 'error', text: e.error }); return; }
      const ing = await res.json();
      setIngredients(prev => [...prev, ing].sort((a, b) => a.name.localeCompare(b.name)));
      setNewIngredient('');
    } catch (err) { setMessage({ type: 'error', text: err.message }); }
  };

  const deleteIngredient = async (id) => {
    if (!confirm('Delete this ingredient?')) return;
    try {
      const res = await fetch(`${API_BASE}/fertigation/ingredients/${id}`, { method: 'DELETE', headers });
      if (!res.ok) { const e = await res.json(); setMessage({ type: 'error', text: e.error }); return; }
      setIngredients(prev => prev.filter(i => i.id !== id));
    } catch (err) { setMessage({ type: 'error', text: err.message }); }
  };

  const startEdit = (mixture) => {
    setEditingId(mixture ? mixture.id : 'new');
    setForm({
      name: mixture?.name || '',
      description: mixture?.description || '',
      items: mixture?.items?.map(i => ({
        ingredient_id: i.ingredient_id,
        parts: i.parts,
        amount: i.amount ?? '',
        unit: i.unit || 'kg',
      })) || [{ ingredient_id: '', parts: 1, amount: '', unit: 'kg' }],
    });
  };

  const saveMixture = async () => {
    if (!form.name.trim()) { setMessage({ type: 'error', text: 'Name is required' }); return; }
    const validItems = form.items
      .filter(i => i.ingredient_id && (i.parts > 0 || (i.amount && parseFloat(i.amount) > 0)))
      .map(i => ({
        ingredient_id: i.ingredient_id,
        parts: i.parts > 0 ? i.parts : 1,
        amount: i.amount === '' || i.amount == null ? null : parseFloat(i.amount),
        unit: i.unit || 'kg',
      }));
    if (validItems.length === 0) { setMessage({ type: 'error', text: 'Add at least one ingredient' }); return; }

    try {
      const url = editingId === 'new'
        ? `${API_BASE}/fertigation/mixtures`
        : `${API_BASE}/fertigation/mixtures/${editingId}`;
      const res = await fetch(url, {
        method: editingId === 'new' ? 'POST' : 'PUT',
        headers,
        body: JSON.stringify({ name: form.name, description: form.description, items: validItems })
      });
      if (!res.ok) { const e = await res.json(); setMessage({ type: 'error', text: e.error }); return; }
      setEditingId(null);
      setMessage({ type: 'success', text: `Mixture ${editingId === 'new' ? 'created' : 'updated'}` });
      fetchAll();
    } catch (err) { setMessage({ type: 'error', text: err.message }); }
  };

  const deleteMixture = async (id) => {
    if (!confirm('Delete this mixture? Channel configs using it will be unlinked.')) return;
    try {
      await fetch(`${API_BASE}/fertigation/mixtures/${id}`, { method: 'DELETE', headers });
      setMessage({ type: 'success', text: 'Mixture deleted' });
      fetchAll();
    } catch (err) { setMessage({ type: 'error', text: err.message }); }
  };

  const updateFormItem = (idx, field, value) => {
    setForm(prev => {
      const items = [...prev.items];
      const coerced = field === 'parts' ? (parseFloat(value) || 0)
        : field === 'amount' ? value // keep as string so empty input is allowed
        : value;
      items[idx] = { ...items[idx], [field]: coerced };
      return { ...prev, items };
    });
  };

  const addFormItem = () => setForm(prev => ({ ...prev, items: [...prev.items, { ingredient_id: '', parts: 1, amount: '', unit: 'kg' }] }));
  const removeFormItem = (idx) => setForm(prev => ({ ...prev, items: prev.items.filter((_, i) => i !== idx) }));

  if (loading) return <Spinner text="Loading mixtures..." />;

  // Editing / Creating a mixture
  if (editingId !== null) {
    const totalParts = form.items.reduce((s, i) => s + (i.parts || 0), 0);
    return (
      <div className="space-y-4 max-w-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            {editingId === 'new' ? 'New Mixture' : 'Edit Mixture'}
          </h2>
          <button onClick={() => setEditingId(null)} className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">Cancel</button>
        </div>

        {message && <Msg message={message} />}

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Mixture Name</label>
            <input value={form.name} onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
              placeholder="e.g. Veg Feed Solution"
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Description (optional)</label>
            <input value={form.description} onChange={e => setForm(prev => ({ ...prev, description: e.target.value }))}
              placeholder="e.g. For vegetative stage"
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm" />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">
              Ingredients — enter absolute amount (kg/L) per recipe. Parts is kept for legacy / proportion display.
            </label>
            <div className="space-y-2">
              <div className="grid grid-cols-[1fr_5rem_6rem_4rem_4.5rem_2rem] gap-2 text-[10px] font-semibold uppercase text-gray-400 dark:text-gray-500 px-1">
                <div>Ingredient</div>
                <div className="text-right">Amount</div>
                <div>Unit</div>
                <div className="text-right">Parts</div>
                <div className="text-right">%</div>
                <div />
              </div>
              {form.items.map((item, idx) => {
                const proportion = totalParts > 0 ? ((item.parts || 0) / totalParts * 100).toFixed(1) : '0.0';
                return (
                  <div key={idx} className="grid grid-cols-[1fr_5rem_6rem_4rem_4.5rem_2rem] gap-2 items-center">
                    <select value={item.ingredient_id} onChange={e => updateFormItem(idx, 'ingredient_id', parseInt(e.target.value) || '')}
                      className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm">
                      <option value="">Select ingredient...</option>
                      {ingredients.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
                    </select>
                    <input type="number" min="0" step="0.1" value={item.amount} onChange={e => updateFormItem(idx, 'amount', e.target.value)}
                      placeholder="0"
                      className="px-2 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm text-right" />
                    <select value={item.unit || 'kg'} onChange={e => updateFormItem(idx, 'unit', e.target.value)}
                      className="px-2 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm">
                      <option value="kg">kg</option>
                      <option value="g">g</option>
                      <option value="L">L</option>
                      <option value="mL">mL</option>
                    </select>
                    <input type="number" min="0.01" step="0.1" value={item.parts || ''} onChange={e => updateFormItem(idx, 'parts', e.target.value)}
                      placeholder="1"
                      className="px-2 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm text-right" />
                    <span className="text-xs text-gray-400 dark:text-gray-500 text-right tabular-nums">{proportion}%</span>
                    {form.items.length > 1 ? (
                      <button onClick={() => removeFormItem(idx)} className="p-1 text-red-500 hover:text-red-700">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                      </button>
                    ) : <span />}
                  </div>
                );
              })}
            </div>
            <button onClick={addFormItem} className="mt-2 text-sm text-primary-600 dark:text-primary-400 hover:underline">+ Add ingredient</button>
          </div>

          {totalParts > 0 && (
            <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-3">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Proportion Preview</p>
              <div className="flex rounded-full overflow-hidden h-3">
                {form.items.filter(i => i.ingredient_id && i.parts > 0).map((item, idx) => {
                  const pct = (item.parts / totalParts * 100);
                  const ingName = ingredients.find(i => i.id === item.ingredient_id)?.name || '?';
                  const colors = ['bg-blue-500', 'bg-green-500', 'bg-yellow-500', 'bg-purple-500', 'bg-pink-500', 'bg-indigo-500', 'bg-red-500', 'bg-teal-500'];
                  return <div key={idx} className={`${colors[idx % colors.length]}`} style={{ width: `${pct}%` }} title={`${ingName}: ${pct.toFixed(1)}%`} />;
                })}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
                {form.items.filter(i => i.ingredient_id && i.parts > 0).map((item, idx) => {
                  const ingName = ingredients.find(i => i.id === item.ingredient_id)?.name || '?';
                  const colors = ['text-blue-600', 'text-green-600', 'text-yellow-600', 'text-purple-600', 'text-pink-600', 'text-indigo-600', 'text-red-600', 'text-teal-600'];
                  return <span key={idx} className={`text-xs ${colors[idx % colors.length]}`}>{ingName}: {(item.parts / totalParts * 100).toFixed(1)}%</span>;
                })}
              </div>
            </div>
          )}
        </div>

        <div className="flex gap-2 pt-2">
          <button onClick={saveMixture} className="px-4 py-2 bg-primary-600 text-white text-sm rounded-lg hover:bg-primary-700">Save Mixture</button>
          <button onClick={() => setEditingId(null)} className="px-4 py-2 bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 text-sm rounded-lg hover:bg-gray-300 dark:hover:bg-gray-500">Cancel</button>
        </div>
      </div>
    );
  }

  // List view
  return (
    <div className="space-y-6">
      {message && <Msg message={message} />}

      {/* Ingredient Management */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
          Ingredients <span className="text-xs font-normal text-gray-400">(click an ingredient to edit elemental composition)</span>
        </h3>
        <div className="flex flex-wrap gap-2 items-center">
          {ingredients.map(ing => {
            let comp = {};
            try { comp = ing.composition ? JSON.parse(ing.composition) : {}; } catch (_) {}
            const summary = Object.entries(comp).map(([k, v]) => `${k} ${v}%`).join(' · ');
            const hasComp = Object.keys(comp).length > 0;
            return (
              <span key={ing.id} className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm
                  ${hasComp
                    ? 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-200 border border-green-200 dark:border-green-800'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'}`}>
                <button onClick={() => canEdit && setEditingIngredient(ing)} title={summary || 'No composition on file'}
                  className={canEdit ? 'hover:underline' : 'cursor-default'}>
                  {ing.name}
                  {summary && <span className="text-[10px] ml-1 opacity-75">[{summary}]</span>}
                </button>
                {canEdit && (
                  <button onClick={() => deleteIngredient(ing.id)} className="text-gray-400 hover:text-red-500 ml-1" title="Delete">
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                )}
              </span>
            );
          })}
          {canEdit && (
            <form onSubmit={e => { e.preventDefault(); addIngredient(); }} className="inline-flex gap-1">
              <input value={newIngredient} onChange={e => setNewIngredient(e.target.value)}
                placeholder="New ingredient..."
                className="px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm w-36" />
              <button type="submit" className="px-2 py-2 bg-primary-600 text-white text-xs rounded hover:bg-primary-700">Add</button>
            </form>
          )}
        </div>
      </div>

      {editingIngredient && (
        <IngredientEditModal
          ingredient={editingIngredient}
          headers={headers}
          onClose={() => setEditingIngredient(null)}
          onSaved={() => { setEditingIngredient(null); fetchAll(); }}
        />
      )}

      {/* Mixtures List */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Mixtures</h3>
          {canEdit && (
            <button onClick={() => startEdit(null)} className="px-3 py-1.5 bg-primary-600 text-white text-sm rounded-lg hover:bg-primary-700">New Mixture</button>
          )}
        </div>

        {mixtures.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No mixtures configured yet. Create one to assign to relay channels.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {mixtures.map(mix => {
              const totalParts = mix.items.reduce((s, i) => s + i.parts, 0);
              return (
                <div key={mix.id} className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <h4 className="text-sm font-semibold text-gray-900 dark:text-white">{mix.name}</h4>
                      {mix.description && <p className="text-xs text-gray-500 dark:text-gray-400">{mix.description}</p>}
                    </div>
                    {canEdit && (
                      <div className="flex gap-1">
                        <button onClick={() => startEdit(mix)} className="px-2 py-2 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded">Edit</button>
                        <button onClick={() => deleteMixture(mix.id)} className="px-2 py-2 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded">Delete</button>
                      </div>
                    )}
                  </div>
                  {/* Proportion bar */}
                  <div className="flex rounded-full overflow-hidden h-2 mb-2">
                    {mix.items.map((item, idx) => {
                      const pct = totalParts > 0 ? (item.parts / totalParts * 100) : 0;
                      const colors = ['bg-blue-500', 'bg-green-500', 'bg-yellow-500', 'bg-purple-500', 'bg-pink-500', 'bg-indigo-500', 'bg-red-500', 'bg-teal-500'];
                      return <div key={idx} className={colors[idx % colors.length]} style={{ width: `${pct}%` }} title={`${item.ingredient_name}: ${pct.toFixed(1)}%`} />;
                    })}
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                    {mix.items.map((item, idx) => {
                      const pct = totalParts > 0 ? (item.parts / totalParts * 100).toFixed(1) : '0';
                      return <span key={idx} className="text-xs text-gray-600 dark:text-gray-400">{item.ingredient_name}: {item.parts} parts ({pct}%)</span>;
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Channel Config Tab ─── */
function ChannelConfigTab({ headers, canEdit }) {
  const [channels, setChannels] = useState([]);
  const [equipment, setEquipment] = useState([]);
  const [mixtures, setMixtures] = useState([]);
  const [ingredients, setIngredients] = useState([]);
  const [tanks, setTanks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editKey, setEditKey] = useState(null);
  const [form, setForm] = useState({ mode: 'tank', tank_id: '', ingredient_name: '', mixture_id: '', flow_rate: '', flow_unit: 'L/min' });
  const [message, setMessage] = useState(null);

  const fetchAll = () => {
    setLoading(true);
    Promise.all([
      fetch(`${API_BASE}/fertigation/channels`, { headers }).then(r => r.json()),
      fetch(`${API_BASE}/equipment`, { headers }).then(r => r.json()),
      fetch(`${API_BASE}/fertigation/mixtures`, { headers }).then(r => r.json()),
      fetch(`${API_BASE}/fertigation/ingredients`, { headers }).then(r => r.json()),
      fetch(`${API_BASE}/fertigation/tanks`, { headers }).then(r => r.json()),
    ]).then(([ch, eq, mix, ing, tnk]) => {
      setChannels(ch);
      setEquipment(eq.filter(e => {
        const m = Array.isArray(e.register_mappings) ? e.register_mappings : [];
        return m.some(m => m.type === 'coil' && m.access === 'readwrite');
      }));
      setMixtures(mix);
      setIngredients(ing);
      setTanks(Array.isArray(tnk) ? tnk : []);
      setLoading(false);
    }).catch(() => setLoading(false));
  };

  useEffect(fetchAll, []);

  const handleSave = async (equipmentId, channel) => {
    if (!form.flow_rate) { setMessage({ type: 'error', text: 'Flow rate is required' }); return; }
    const body = { flow_rate: form.flow_rate, flow_unit: form.flow_unit };
    if (form.mode === 'tank') {
      if (!form.tank_id) { setMessage({ type: 'error', text: 'Select a tank' }); return; }
      body.tank_id = form.tank_id;
    } else if (form.mode === 'mixture') {
      if (!form.mixture_id) { setMessage({ type: 'error', text: 'Select a mixture' }); return; }
      body.mixture_id = form.mixture_id;
    } else {
      if (!form.ingredient_name) { setMessage({ type: 'error', text: 'Select an ingredient' }); return; }
      body.ingredient_name = form.ingredient_name;
    }
    try {
      const res = await fetch(`${API_BASE}/fertigation/channels/${equipmentId}/${channel}`, {
        method: 'PUT', headers, body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setEditKey(null);
      setMessage({ type: 'success', text: 'Channel config saved' });
      fetchAll();
    } catch (err) { setMessage({ type: 'error', text: err.message }); }
  };

  const handleDelete = async (equipmentId, channel) => {
    if (!confirm('Remove this channel configuration?')) return;
    try {
      await fetch(`${API_BASE}/fertigation/channels/${equipmentId}/${channel}`, { method: 'DELETE', headers });
      fetchAll();
      setMessage({ type: 'success', text: 'Channel config removed' });
    } catch (err) { setMessage({ type: 'error', text: err.message }); }
  };

  const startEdit = (equipmentId, channel, existing) => {
    setEditKey(`${equipmentId}:${channel}`);
    const mode = existing?.tank_id ? 'tank'
      : existing?.mixture_id ? 'mixture'
      : existing?.ingredient_name ? 'single'
      : 'tank';
    setForm({
      mode,
      tank_id: existing?.tank_id || '',
      ingredient_name: existing?.ingredient_name || '',
      mixture_id: existing?.mixture_id || '',
      flow_rate: existing?.flow_rate || '',
      flow_unit: existing?.flow_unit || 'L/min'
    });
  };

  if (loading) return <Spinner text="Loading channel configs..." />;

  const allChannels = [];
  equipment.forEach(eq => {
    const mappings = Array.isArray(eq.register_mappings) ? eq.register_mappings : [];
    mappings.filter(m => m.type === 'coil' && m.access === 'readwrite').forEach(coil => {
      const ch = parseInt(coil.register ?? coil.address, 10);
      const config = channels.find(c => c.equipment_id === eq.id && c.channel === ch);
      allChannels.push({ equipment_id: eq.id, equipment_name: eq.name, channel: ch, channel_label: coil.label || coil.name || `Coil ${ch}`, config });
    });
  });

  return (
    <div className="space-y-4">
      {message && <Msg message={message} />}

      {allChannels.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No relay equipment found.</p>
      ) : (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-900">
              <tr>
                <TH>Equipment</TH><TH>Channel</TH><TH>Dispenses</TH><TH>Flow Rate</TH>
                {canEdit && <TH right>Actions</TH>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {allChannels.map(ch => {
                const key = `${ch.equipment_id}:${ch.channel}`;
                const isEditing = editKey === key;
                const displayName = ch.config?.mixture_name || ch.config?.ingredient_name || null;

                return (
                  <tr key={key}>
                    <TD>{ch.equipment_name}</TD>
                    <TD>{ch.channel_label}</TD>
                    <td className="px-4 py-3 text-sm">
                      {isEditing ? (
                        <div className="space-y-2">
                          <div className="flex flex-wrap gap-2">
                            <label className="inline-flex items-center text-xs">
                              <input type="radio" checked={form.mode === 'tank'} onChange={() => setForm(prev => ({ ...prev, mode: 'tank' }))} className="mr-1" />
                              Tank
                            </label>
                            <label className="inline-flex items-center text-xs">
                              <input type="radio" checked={form.mode === 'mixture'} onChange={() => setForm(prev => ({ ...prev, mode: 'mixture' }))} className="mr-1" />
                              Mixture
                            </label>
                            <label className="inline-flex items-center text-xs">
                              <input type="radio" checked={form.mode === 'single'} onChange={() => setForm(prev => ({ ...prev, mode: 'single' }))} className="mr-1" />
                              Single Ingredient
                            </label>
                          </div>
                          {form.mode === 'tank' ? (
                            <select value={form.tank_id} onChange={e => setForm(prev => ({ ...prev, tank_id: e.target.value }))}
                              className="w-full px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm">
                              <option value="">Select tank...</option>
                              {tanks.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                            </select>
                          ) : form.mode === 'mixture' ? (
                            <select value={form.mixture_id} onChange={e => setForm(prev => ({ ...prev, mixture_id: e.target.value }))}
                              className="w-full px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm">
                              <option value="">Select mixture...</option>
                              {mixtures.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                            </select>
                          ) : (
                            <select value={form.ingredient_name} onChange={e => setForm(prev => ({ ...prev, ingredient_name: e.target.value }))}
                              className="w-full px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm">
                              <option value="">Select ingredient...</option>
                              {ingredients.map(i => <option key={i.id} value={i.name}>{i.name}</option>)}
                            </select>
                          )}
                        </div>
                      ) : (
                        <span className={(ch.config?.tank_name || displayName) ? 'text-gray-900 dark:text-white' : 'text-gray-400 dark:text-gray-500 italic'}>
                          {ch.config?.tank_name || displayName || 'Not configured'}
                          {ch.config?.tank_name
                            ? <span className="ml-1 text-xs text-blue-500">(tank)</span>
                            : ch.config?.mixture_name && <span className="ml-1 text-xs text-gray-400">(mix)</span>}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {isEditing ? (
                        <div className="flex gap-1">
                          <input type="number" step="0.01" min="0" value={form.flow_rate} onChange={e => setForm(prev => ({ ...prev, flow_rate: e.target.value }))}
                            placeholder="0.0" className="w-20 px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm" />
                          <select value={form.flow_unit} onChange={e => setForm(prev => ({ ...prev, flow_unit: e.target.value }))}
                            className="px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm">
                            <option value="L/min">L/min</option><option value="mL/min">mL/min</option><option value="gal/hr">gal/hr</option>
                          </select>
                        </div>
                      ) : (
                        <span className="text-gray-700 dark:text-gray-300">{ch.config ? `${ch.config.flow_rate} ${ch.config.flow_unit}` : '—'}</span>
                      )}
                    </td>
                    {canEdit && (
                      <td className="px-4 py-3 text-sm text-right">
                        {isEditing ? (
                          <div className="flex justify-end gap-2">
                            <button onClick={() => handleSave(ch.equipment_id, ch.channel)} className="px-3 py-2 bg-primary-600 text-white text-xs rounded hover:bg-primary-700">Save</button>
                            <button onClick={() => setEditKey(null)} className="px-3 py-2 bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 text-xs rounded hover:bg-gray-300 dark:hover:bg-gray-500">Cancel</button>
                          </div>
                        ) : (
                          <div className="flex justify-end gap-2">
                            <button onClick={() => startEdit(ch.equipment_id, ch.channel, ch.config)}
                              className="px-3 py-2 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-xs rounded hover:bg-gray-200 dark:hover:bg-gray-600">
                              {ch.config ? 'Edit' : 'Configure'}
                            </button>
                            {ch.config && (
                              <button onClick={() => handleDelete(ch.equipment_id, ch.channel)}
                                className="px-3 py-2 text-red-600 dark:text-red-400 text-xs hover:bg-red-50 dark:hover:bg-red-900/20 rounded">Remove</button>
                            )}
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ─── Event Log Tab ─── */
function EventLogTab({ headers, formatDateTime }) {
  const { showError: showEventLogError } = useToast();
  const [events, setEvents] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [filterEquipment, setFilterEquipment] = useState('');
  const [filterSource, setFilterSource] = useState('');
  const [equipment, setEquipment] = useState([]);
  const pageSize = 50;

  useEffect(() => {
    fetch(`${API_BASE}/equipment`, { headers })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(setEquipment)
      .catch(err => showEventLogError(`Could not load equipment list: ${err.message}`));
  }, []);

  const fetchEvents = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ limit: pageSize, offset: page * pageSize });
    if (filterEquipment) params.set('equipment_id', filterEquipment);
    if (filterSource) params.set('source', filterSource);
    fetch(`${API_BASE}/fertigation/events?${params}`, { headers })
      .then(r => r.json()).then(d => { setEvents(d.events); setTotal(d.total); setLoading(false); }).catch(() => setLoading(false));
  }, [page, filterEquipment, filterSource]);

  useEffect(() => { fetchEvents(); }, [fetchEvents]);
  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <select value={filterEquipment} onChange={e => { setFilterEquipment(e.target.value); setPage(0); }}
          className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm">
          <option value="">All Equipment</option>
          {equipment.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        <select value={filterSource} onChange={e => { setFilterSource(e.target.value); setPage(0); }}
          className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm">
          <option value="">All Sources</option>
          <option value="manual">Manual</option><option value="automation">Automation</option>
          <option value="automation_auto_off">Auto-Off</option><option value="all_channels">All Channels</option>
        </select>
      </div>

      {loading ? <Spinner text="Loading events..." /> : events.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 py-4">No relay events recorded yet.</p>
      ) : (
        <>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900">
                <tr><TH>Time</TH><TH>Equipment</TH><TH>Channel</TH><TH>State</TH><TH>Source</TH></tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {events.map(ev => (
                  <tr key={ev.id}>
                    <TD nowrap>{formatDateTime(ev.created_at)}</TD>
                    <TD>{ev.equipment_name}</TD>
                    <TD>Ch {ev.channel}</TD>
                    <td className="px-4 py-3 text-sm">
                      <span className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full ${
                        ev.state ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400' : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
                      }`}>{ev.state ? 'ON' : 'OFF'}</span>
                    </td>
                    <TD>{ev.source}</TD>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-500 dark:text-gray-400">{total} total events</p>
              <div className="flex gap-2">
                <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
                  className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300">Previous</button>
                <span className="px-3 py-1 text-sm text-gray-600 dark:text-gray-400">Page {page + 1} of {totalPages}</span>
                <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
                  className="px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-lg disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300">Next</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ─── Shared UI helpers ─── */
function Spinner({ text }) {
  return (
    <div className="text-center py-8 text-gray-500 dark:text-gray-400">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto mb-2" />
      {text}
    </div>
  );
}

function Msg({ message }) {
  return (
    <div className={`p-3 rounded-lg text-sm ${message.type === 'success' ? 'bg-green-50 text-green-800 dark:bg-green-900/30 dark:text-green-400' : 'bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-400'}`}>
      {message.text}
    </div>
  );
}

function TH({ children, right }) {
  return <th className={`px-4 py-3 text-${right ? 'right' : 'left'} text-xs font-medium text-gray-500 dark:text-gray-400 uppercase`}>{children}</th>;
}

function TD({ children, right, bold, nowrap }) {
  return (
    <td className={`px-4 py-3 text-sm ${right ? 'text-right' : ''} ${bold ? 'font-medium text-gray-900 dark:text-white' : 'text-gray-700 dark:text-gray-300'} ${nowrap ? 'whitespace-nowrap' : ''}`}>
      {children}
    </td>
  );
}

/* ─── Tanks Tab ───
 *
 * Each tank is a physical stock container (typically 1000 L) wired to one fertigation
 * pump channel. The card shows current stock level, the recipe currently loaded, and
 * the predicted ppm of each element delivered to the irrigation line at a 1:1000 dose.
 * "Refill" logs a refill event (snapshots composition) and resets the stock level.
 */

const ROLE_LABELS = { nutrient: 'Nutrient', ph_up: 'pH Up', ph_down: 'pH Down', other: 'Other' };
const ROLE_COLORS = {
  nutrient: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  ph_up:    'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  ph_down:  'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  other:    'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
};
const ELEMENT_ORDER = ['N','P','K','Ca','Mg','S','Fe','Mn','Zn','Cu','B','Mo','Cl','Na'];

function TanksTab({ headers, canEdit, formatDateTime }) {
  const [tanks, setTanks] = useState([]);
  const [mixtures, setMixtures] = useState([]);
  const [equipment, setEquipment] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState(null);
  const [refillTank, setRefillTank] = useState(null);
  const [editTank, setEditTank] = useState(null); // tank object or 'new'

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [t, m, e] = await Promise.all([
        fetch(`${API_BASE}/fertigation/tanks`, { headers }).then(r => r.json()),
        fetch(`${API_BASE}/fertigation/mixtures`, { headers }).then(r => r.json()),
        fetch(`${API_BASE}/equipment`, { headers }).then(r => r.json()),
      ]);
      setTanks(Array.isArray(t) ? t : []);
      setMixtures(Array.isArray(m) ? m : []);
      setEquipment(Array.isArray(e) ? e : []);
    } catch (err) {
      console.error('Failed to load tanks', err);
    } finally {
      setLoading(false);
    }
  }, [headers]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <Spinner text="Loading tanks..." />;

  return (
    <div className="space-y-4">
      <StopIrrigationButton className="bg-panel border border-line rounded-card p-3" />
      <FlowWatchStatus formatDateTime={formatDateTime} />
      <DoseControllerStatus formatDateTime={formatDateTime} />
      <LiveDoseCycleBanner headers={headers} canEdit={canEdit} />

      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Physical stock tanks (typically 1000 L) feeding fertigation channels. Refill records snapshot the recipe for traceability.
        </p>
        {canEdit && (
          <button onClick={() => setEditTank('new')}
            className="px-3 py-1.5 bg-primary-600 hover:bg-primary-700 text-white text-sm rounded-md">
            + New Tank
          </button>
        )}
      </div>

      {tanks.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 text-center text-sm text-gray-500 dark:text-gray-400">
          No tanks configured. Create one to start tracking stock and predicting nutrient ppm.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {tanks.map(tank => (
            <TankCard
              key={tank.id}
              tank={tank}
              expanded={expandedId === tank.id}
              onExpand={() => setExpandedId(expandedId === tank.id ? null : tank.id)}
              canEdit={canEdit}
              onRefill={() => setRefillTank(tank)}
              onEdit={() => setEditTank(tank)}
              headers={headers}
              formatDateTime={formatDateTime}
            />
          ))}
        </div>
      )}

      {refillTank && (
        <RefillModal
          tank={refillTank}
          mixtures={mixtures}
          headers={headers}
          onClose={() => setRefillTank(null)}
          onSaved={() => { setRefillTank(null); load(); }}
        />
      )}
      {editTank && (
        <TankEditModal
          tank={editTank === 'new' ? null : editTank}
          mixtures={mixtures}
          equipment={equipment}
          headers={headers}
          onClose={() => setEditTank(null)}
          onSaved={() => { setEditTank(null); load(); }}
        />
      )}

      <DoseCycleHistory headers={headers} formatDateTime={formatDateTime} />
    </div>
  );
}

/* ─── Live Dose Cycle Banner ───
 *
 * Polls /api/fertigation/dose-cycle/status every 2 seconds. When a cycle is
 * running, shows program name, progress, per-tank live valve states, and an
 * Abort button. Hidden when idle.
 */
function LiveDoseCycleBanner({ headers, canEdit }) {
  const { showError, showSuccess } = useToast();
  const [status, setStatus] = useState(null);
  const [aborting, setAborting] = useState(false);

  const notifyPollError = useThrottledError(showError);

  useEffect(() => {
    let mounted = true;
    const poll = async () => {
      try {
        const r = await fetch(`${API_BASE}/fertigation/dose-cycle/status`, { headers });
        if (r.ok && mounted) setStatus(await r.json());
        else if (!r.ok && r.status >= 500) notifyPollError('Could not read dose-cycle status', 'dose-cycle-status');
      } catch (_) {
        // 2 s poll: one toast per minute at most, not one per tick
        notifyPollError('Could not read dose-cycle status', 'dose-cycle-status');
      }
    };
    poll();
    const stopPoll = startPolling(poll, 2000); // paused while hidden, one refresh on resume
    return () => { mounted = false; stopPoll(); };
  }, [headers]);

  if (!status?.running) return null;

  const abort = async () => {
    if (!confirm('Abort the current dose cycle? All injector valves will be closed immediately.')) return;
    setAborting(true);
    try {
      const r = await fetch(`${API_BASE}/fertigation/dose-cycle/abort`, { method: 'POST', headers });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        showError(e.error || 'Failed to abort dose cycle');
      } else {
        showSuccess('Dose cycle aborted — injector valves closed');
      }
    } catch (e) { showError('Failed to abort dose cycle: ' + e.message); }
    finally { setAborting(false); }
  };

  const mmss = (s) => {
    const m = Math.floor(s / 60);
    const ss = String(s % 60).padStart(2, '0');
    return `${m}:${ss}`;
  };

  return (
    <div className="bg-gradient-to-r from-yellow-50 to-amber-50 dark:from-yellow-900/30 dark:to-amber-900/30 border border-yellow-300 dark:border-yellow-700 rounded-lg shadow p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="relative inline-flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-yellow-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-yellow-500" />
            </span>
            <span className="font-semibold text-yellow-900 dark:text-yellow-100">
              Dose cycle running: {status.program?.name || `Program #${status.cycle_log_id}`}
            </span>
            {status.compatibility_strategy === 'time_slice' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                time-slice
              </span>
            )}
          </div>
          <p className="text-xs text-yellow-800 dark:text-yellow-200">
            {status.automation?.name && <>Triggered by <strong>{status.automation.name}</strong> · </>}
            <span className="font-mono">{mmss(status.elapsed_seconds)} / {mmss(status.duration_seconds)}</span>
            {' · '}
            <span className="text-yellow-700 dark:text-yellow-300">{mmss(status.remaining_seconds)} remaining</span>
          </p>
        </div>
        {canEdit && (
          <button onClick={abort} disabled={aborting}
            className="px-3 py-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-sm rounded-md">
            {aborting ? 'Aborting…' : 'Abort cycle'}
          </button>
        )}
      </div>

      {/* Progress bar */}
      <div className="h-2 w-full bg-yellow-100 dark:bg-yellow-900/40 rounded-full overflow-hidden mb-3">
        <div className="h-full bg-yellow-500 transition-all" style={{ width: `${status.progress_pct}%` }} />
      </div>

      {/* Per-tank live state */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        {(status.tanks || []).map(t => {
          const onColor = t.current_state
            ? 'bg-green-500 ring-2 ring-green-300 dark:ring-green-700'
            : 'bg-gray-300 dark:bg-gray-600';
          return (
            <div key={t.tank_id} className="bg-white/60 dark:bg-gray-800/50 rounded px-2 py-1.5">
              <div className="flex items-center gap-1.5">
                <span className={`inline-block h-3 w-3 rounded-full ${onColor}`} />
                <span className="text-xs font-medium text-gray-800 dark:text-gray-100 truncate">
                  {t.tank_name?.replace(/^Tank \d+ — /, '') || `Tank ${t.tank_id}`}
                </span>
              </div>
              <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">
                {t.duty_pct}% duty
                {t.seconds_until_next != null && (
                  <> · next {t.next_toggle_state ? 'open' : 'close'} in {t.seconds_until_next}s</>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Dose Cycle History ───
 *
 * Collapsible table of recent fertigation_dose_cycle_log rows. Refreshes when
 * the user expands; otherwise stays static. Useful for "did yesterday's 12:00
 * cycle actually inject?"
 */
function DoseCycleHistory({ headers, formatDateTime }) {
  const { showError } = useToast();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/fertigation/dose-cycle/history?limit=30`, { headers });
      if (r.ok) setRows(await r.json());
      else showError('Could not load dose-cycle history');
    } catch (err) {
      showError(`Could not load dose-cycle history: ${err.message}`);
    } finally { setLoading(false); }
  }, [headers, showError]);

  useEffect(() => { if (open) load(); }, [open, load]);

  const fmt = (s) => formatDateTime ? formatDateTime(s) : (s ? new Date(s).toLocaleString() : '—');
  const statusColor = (s) =>
    s === 'completed' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
    : s === 'running' ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300'
    : s === 'aborted' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
    : s === 'failed'  ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
    : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300';

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
      <button onClick={() => setOpen(!open)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-700/30">
        <span className="font-semibold text-gray-900 dark:text-white">Dose Cycle History</span>
        <svg className={`w-4 h-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="border-t border-gray-100 dark:border-gray-700">
          {loading ? (
            <div className="p-4 text-sm text-gray-500 dark:text-gray-400">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="p-4 text-sm text-gray-500 dark:text-gray-400 italic">No dose cycles have run yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700 text-sm">
                <thead className="bg-gray-50 dark:bg-gray-900">
                  <tr>
                    <TH>Started</TH>
                    <TH>Program</TH>
                    <TH>Automation</TH>
                    <TH right>Duration</TH>
                    <TH>Status</TH>
                    <TH>Notes</TH>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {rows.map(r => (
                    <tr key={r.id}>
                      <TD nowrap>{fmt(r.cycle_started_at)}</TD>
                      <TD>{r.program_name || <span className="text-gray-400 italic">unknown</span>}</TD>
                      <TD>{r.automation_name || <span className="text-gray-400 italic">manual</span>}</TD>
                      <TD right nowrap>{r.duration_seconds ? `${Math.round(r.duration_seconds / 60)} min` : '—'}</TD>
                      <td className="px-4 py-3 text-sm">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${statusColor(r.status)}`}>
                          {r.status}
                        </span>
                      </td>
                      <TD>{r.notes || <span className="text-gray-400">—</span>}</TD>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TankCard({ tank, expanded, onExpand, canEdit, onRefill, onEdit, headers, formatDateTime }) {
  const [detail, setDetail] = useState(null);
  const [preview, setPreview] = useState(null);
  const [venturi, setVenturi] = useState('');
  const [water, setWater] = useState('');
  const stockPct = tank.capacity_liters
    ? Math.min(100, Math.round(((tank.current_stock_liters || 0) / tank.capacity_liters) * 100))
    : 0;
  const stockColor = stockPct < 20 ? 'bg-red-500' : stockPct < 50 ? 'bg-amber-500' : 'bg-green-500';
  const channelLabel = tank.equipment_id && tank.channel
    ? `${tank.equipment_name || `eq#${tank.equipment_id}`} · Ch ${tank.channel}`
    : 'Unassigned';

  const { showError: showTankError } = useToast();

  const fetchDetail = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/fertigation/tanks/${tank.id}`, { headers });
      if (r.ok) setDetail(await r.json());
      else showTankError(`Could not load details for ${tank.name || 'tank'}`);
    } catch (err) {
      showTankError(`Could not load details for ${tank.name || 'tank'}: ${err.message}`);
    }
  }, [headers, tank.id, tank.name, showTankError]);

  const fetchPreview = useCallback(async (vOverride, wOverride) => {
    try {
      const params = new URLSearchParams();
      const vRaw = vOverride !== undefined ? vOverride : venturi;
      const wRaw = wOverride !== undefined ? wOverride : water;
      if (vRaw !== '' && vRaw != null && !Number.isNaN(parseFloat(vRaw))) params.set('venturi_lpm', vRaw);
      if (wRaw !== '' && wRaw != null && !Number.isNaN(parseFloat(wRaw))) params.set('water_lpm', wRaw);
      const qs = params.toString();
      const r = await fetch(`${API_BASE}/fertigation/tanks/${tank.id}/ppm-preview${qs ? '?' + qs : ''}`, { headers });
      if (r.ok) {
        const p = await r.json();
        setPreview(p);
        // First load: seed the inputs from server-detected values so the user sees them.
        if (vOverride === undefined && (venturi === '' || venturi == null) && p.venturi_lpm) setVenturi(String(p.venturi_lpm));
        if (wOverride === undefined && (water === '' || water == null) && p.water_lpm) setWater(String(p.water_lpm));
      } else {
        showTankError(`Could not compute ppm preview for ${tank.name || 'tank'}`);
      }
    } catch (err) {
      showTankError(`Could not compute ppm preview for ${tank.name || 'tank'}: ${err.message}`);
    }
  }, [headers, tank.id, tank.name, venturi, water, showTankError]);

  useEffect(() => { if (expanded) { fetchDetail(); fetchPreview(); } /* eslint-disable-next-line */ }, [expanded]);

  const elements = preview?.irrigation_ppm
    ? ELEMENT_ORDER.filter(e => preview.irrigation_ppm[e] != null && preview.irrigation_ppm[e] > 0)
    : [];
  const dilutionLabel = preview?.dilution_ratio
    ? `1 : ${(1 / preview.dilution_ratio).toFixed(0)}`
    : '—';

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
      <button onClick={onExpand} className="w-full text-left p-4 hover:bg-gray-50 dark:hover:bg-gray-700/30">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="font-semibold text-gray-900 dark:text-white truncate">{tank.name}</h3>
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${ROLE_COLORS[tank.role] || ROLE_COLORS.other}`}>
                {ROLE_LABELS[tank.role] || tank.role}
              </span>
              {tank.active === 0 && (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300">inactive</span>
              )}
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {channelLabel} · {tank.mixture_name || <em>no recipe</em>}
            </p>
          </div>
          <svg className={`w-4 h-4 text-gray-400 mt-1 transition-transform ${expanded ? 'rotate-180' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>

        <div className="mt-3">
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-gray-500 dark:text-gray-400">Stock</span>
            <span className="text-gray-700 dark:text-gray-200 font-medium tabular-nums">
              {Math.round(tank.current_stock_liters || 0)} / {tank.capacity_liters || '—'} L ({stockPct}%)
            </span>
          </div>
          <div className="h-2 w-full bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
            <div className={`h-full ${stockColor} transition-all`} style={{ width: `${stockPct}%` }} />
          </div>
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t border-gray-100 dark:border-gray-700">
          {tank.pending_mixture_id && (
            <div className="mt-3 p-2 bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 rounded text-xs">
              <p className="font-semibold text-purple-800 dark:text-purple-200">Pending recipe change</p>
              <p className="text-purple-700 dark:text-purple-300 mt-0.5">
                A new recipe is queued for this tank. It will activate the next time you refill — pick "Use pending recipe" in the refill dialog.
              </p>
            </div>
          )}
          {/* Recipe */}
          <div className="mt-3">
            <h4 className="text-xs font-semibold uppercase text-gray-600 dark:text-gray-300 mb-2">Recipe (per {tank.water_base_liters} L water)</h4>
            {tank.items?.length ? (
              <div className="space-y-1">
                {tank.items.map(it => (
                  <div key={it.ingredient_id} className="flex items-center justify-between text-xs bg-gray-50 dark:bg-gray-700/40 rounded px-2 py-1">
                    <span className="text-gray-700 dark:text-gray-200">{it.name}</span>
                    <span className="font-medium tabular-nums">{it.amount ?? '—'} {it.unit || ''}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-500 dark:text-gray-400 italic">No recipe attached. Pick a mixture under Edit.</p>
            )}
          </div>

          {/* Predicted ppm */}
          <div className="mt-4">
            <div className="flex flex-wrap items-end justify-between gap-2 mb-2">
              <h4 className="text-xs font-semibold uppercase text-gray-600 dark:text-gray-300">Predicted ppm in irrigation line</h4>
              <span className="text-[11px] text-gray-500 dark:text-gray-400 font-mono">Dilution {dilutionLabel}</span>
            </div>
            <div className="grid grid-cols-2 gap-2 mb-3">
              <div>
                <label className="block text-[10px] text-gray-500 dark:text-gray-400 mb-0.5">Venturi flow (L/min)</label>
                <input type="number" min="0" step="0.1" value={venturi}
                  onChange={e => setVenturi(e.target.value)}
                  onBlur={() => fetchPreview(venturi, water)}
                  placeholder="from channel"
                  className="w-full px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 dark:text-white" />
              </div>
              <div>
                <label className="block text-[10px] text-gray-500 dark:text-gray-400 mb-0.5">Water pump flow (L/min)</label>
                <input type="number" min="0" step="0.1" value={water}
                  onChange={e => setWater(e.target.value)}
                  onBlur={() => fetchPreview(venturi, water)}
                  placeholder="from water channel avg"
                  className="w-full px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 dark:text-white" />
              </div>
            </div>
            {!preview?.dilution_ratio ? (
              <p className="text-xs text-gray-500 dark:text-gray-400 italic">
                Bind this tank to a channel in <strong>Channel Config</strong>, or enter Venturi/water flow above, to see predicted ppm.
              </p>
            ) : elements.length === 0 ? (
              <p className="text-xs text-gray-500 dark:text-gray-400 italic">No elemental composition on file for this recipe's ingredients.</p>
            ) : (
              <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
                {elements.map(el => (
                  <div key={el} className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded px-2 py-1">
                    <p className="text-[10px] text-yellow-700 dark:text-yellow-300 font-semibold">{el}</p>
                    <p className="text-sm font-bold text-yellow-900 dark:text-yellow-100 tabular-nums">
                      {preview.irrigation_ppm[el].toFixed(2)}
                    </p>
                    <p className="text-[9px] text-yellow-700 dark:text-yellow-400">ppm</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Refill history */}
          {detail?.refills?.length > 0 && (
            <div className="mt-4">
              <h4 className="text-xs font-semibold uppercase text-gray-600 dark:text-gray-300 mb-2">Recent refills</h4>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {detail.refills.slice(0, 8).map(r => (
                  <div key={r.id} className="text-xs flex items-center justify-between bg-gray-50 dark:bg-gray-700/40 rounded px-2 py-1">
                    <span className="text-gray-700 dark:text-gray-200">
                      {formatDateTime ? formatDateTime(r.refilled_at) : new Date(r.refilled_at).toLocaleString()}
                    </span>
                    <span className="text-gray-500 dark:text-gray-400 tabular-nums">
                      +{r.water_liters_added} L → {Math.round(r.total_volume_after || 0)} L
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {canEdit && (
            <div className="mt-4 flex gap-2">
              <button onClick={onRefill}
                className="flex-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-md">
                + Log Refill
              </button>
              <button onClick={onEdit}
                className="px-3 py-1.5 border border-gray-300 dark:border-gray-600 text-sm text-gray-700 dark:text-gray-200 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700">
                Edit
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RefillModal({ tank, mixtures, headers, onClose, onSaved }) {
  const [water, setWater] = useState(tank.capacity_liters || 1000);
  const [mixtureId, setMixtureId] = useState(tank.mixture_id || '');
  const [usePending, setUsePending] = useState(!!tank.pending_mixture_id);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const pendingMixture = tank.pending_mixture_id
    ? mixtures.find(m => m.id === tank.pending_mixture_id)
    : null;

  const save = async () => {
    if (!water || water <= 0) return setErr('Enter water liters added');
    setSaving(true);
    setErr('');
    try {
      const body = {
        water_liters_added: parseFloat(water),
        notes,
      };
      if (usePending && tank.pending_mixture_id) {
        body.use_pending_mixture = true;
      } else if (mixtureId) {
        body.mixture_id = mixtureId;
      }
      const r = await fetch(`${API_BASE}/fertigation/tanks/${tank.id}/refill`, {
        method: 'POST', headers,
        body: JSON.stringify(body),
      });
      if (!r.ok) { setErr((await r.json()).error || 'Save failed'); setSaving(false); return; }
      onSaved();
    } catch (e) { setErr(e.message); setSaving(false); }
  };

  return (
    <Modal onClose={onClose} title={`Refill — ${tank.name}`}>
      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Water added (L)</label>
          <input type="number" min="0" step="0.1" value={water} onChange={e => setWater(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 dark:text-white" />
          <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-1">
            Final stock = current + this. Capped at the tank capacity ({tank.capacity_liters || '—'} L).
          </p>
        </div>
        {pendingMixture && (
          <label className="flex items-start gap-2 p-2 bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 rounded">
            <input type="checkbox" checked={usePending} onChange={e => setUsePending(e.target.checked)} className="mt-0.5" />
            <span className="text-xs text-purple-800 dark:text-purple-200">
              <strong className="block">Use pending recipe</strong>
              <span className="text-purple-700 dark:text-purple-300">
                Adopt "{pendingMixture.name}" as the active recipe. Make sure you actually mixed it this way.
              </span>
            </span>
          </label>
        )}
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Recipe used</label>
          <select value={mixtureId} onChange={e => setMixtureId(e.target.value)}
            disabled={usePending && !!pendingMixture}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 dark:text-white disabled:opacity-50">
            <option value="">— Keep current recipe —</option>
            {mixtures.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Notes</label>
          <input type="text" value={notes} onChange={e => setNotes(e.target.value)}
            placeholder="e.g. used new batch of CaNO3"
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 dark:text-white" />
        </div>
        {err && <p className="text-xs text-red-600 dark:text-red-400">{err}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300">Cancel</button>
          <button onClick={save} disabled={saving}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-md disabled:opacity-60">
            {saving ? 'Saving…' : 'Log Refill'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function TankEditModal({ tank, mixtures, equipment, headers, onClose, onSaved }) {
  const isNew = !tank;
  const [form, setForm] = useState({
    name: tank?.name || '',
    role: tank?.role || 'nutrient',
    equipment_id: tank?.equipment_id || '',
    channel: tank?.channel || '',
    capacity_liters: tank?.capacity_liters ?? 1000,
    water_base_liters: tank?.water_base_liters ?? 1000,
    mixture_id: tank?.mixture_id || '',
    active: tank?.active ?? 1,
    notes: tank?.notes || '',
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  // Limit equipment to fertigation/relay devices that have channels.
  const channelEquipment = equipment.filter(e => /relay|fertigation|waveshare/i.test(e.type || e.device_template_id || ''));

  const update = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    if (!form.name.trim()) return setErr('Name is required');
    setSaving(true); setErr('');
    try {
      const body = {
        name: form.name.trim(),
        role: form.role,
        equipment_id: form.equipment_id ? parseInt(form.equipment_id) : null,
        channel: form.channel ? parseInt(form.channel) : null,
        capacity_liters: parseFloat(form.capacity_liters) || 1000,
        water_base_liters: parseFloat(form.water_base_liters) || 1000,
        mixture_id: form.mixture_id ? parseInt(form.mixture_id) : null,
        active: form.active ? 1 : 0,
        notes: form.notes || null,
      };
      const url = isNew ? `${API_BASE}/fertigation/tanks` : `${API_BASE}/fertigation/tanks/${tank.id}`;
      const r = await fetch(url, { method: isNew ? 'POST' : 'PUT', headers, body: JSON.stringify(body) });
      if (!r.ok) { setErr((await r.json()).error || 'Save failed'); setSaving(false); return; }
      onSaved();
    } catch (e) { setErr(e.message); setSaving(false); }
  };

  const remove = async () => {
    if (!confirm(`Delete "${tank.name}"? Refill history will be removed.`)) return;
    setSaving(true);
    try {
      const r = await fetch(`${API_BASE}/fertigation/tanks/${tank.id}`, { method: 'DELETE', headers });
      if (!r.ok) { setErr((await r.json()).error || 'Delete failed'); setSaving(false); return; }
      onSaved();
    } catch (e) { setErr(e.message); setSaving(false); }
  };

  return (
    <Modal onClose={onClose} title={isNew ? 'New Tank' : `Edit — ${tank.name}`}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <input type="text" value={form.name} onChange={e => update('name', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 dark:text-white" />
          </Field>
          <Field label="Role">
            <select value={form.role} onChange={e => update('role', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 dark:text-white">
              {Object.entries(ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="Pump equipment">
            <select value={form.equipment_id} onChange={e => update('equipment_id', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 dark:text-white">
              <option value="">— None —</option>
              {(channelEquipment.length ? channelEquipment : equipment).map(e =>
                <option key={e.id} value={e.id}>{e.name}</option>
              )}
            </select>
          </Field>
          <Field label="Channel">
            <input type="number" min="1" max="32" value={form.channel} onChange={e => update('channel', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 dark:text-white" />
          </Field>
          <Field label="Capacity (L)">
            <input type="number" min="0" step="1" value={form.capacity_liters} onChange={e => update('capacity_liters', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 dark:text-white" />
          </Field>
          <Field label="Water base for recipe (L)">
            <input type="number" min="0" step="1" value={form.water_base_liters} onChange={e => update('water_base_liters', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 dark:text-white" />
          </Field>
        </div>
        <Field label="Recipe (mixture)">
          <select value={form.mixture_id} onChange={e => update('mixture_id', e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 dark:text-white">
            <option value="">— None —</option>
            {mixtures.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Field>
        <Field label="Notes">
          <textarea rows="2" value={form.notes} onChange={e => update('notes', e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 dark:text-white text-sm" />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!!form.active} onChange={e => update('active', e.target.checked ? 1 : 0)} />
          <span className="text-gray-700 dark:text-gray-200">Active</span>
        </label>
        {err && <p className="text-xs text-red-600 dark:text-red-400">{err}</p>}
        <div className="flex items-center justify-between pt-2">
          {!isNew && (
            <button onClick={remove} disabled={saving}
              className="px-3 py-1.5 text-sm text-red-600 hover:text-red-800 dark:text-red-400">Delete</button>
          )}
          <div className="flex gap-2 ml-auto">
            <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300">Cancel</button>
            <button onClick={save} disabled={saving}
              className="px-3 py-1.5 bg-primary-600 hover:bg-primary-700 text-white text-sm rounded-md disabled:opacity-60">
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{label}</label>
      {children}
    </div>
  );
}

/* ─── Dose Programs Tab ───
 *
 * A dose program is a reusable per-tank duty-cycle recipe. During a fertigation
 * cycle the scheduler opens each tank's injector valve for `duty_pct%` of every
 * `window_seconds`-second slice. The AI planner picks among published programs
 * (drafts are operator's work-in-progress) or proposes new ones in its plan.
 */

const STATUS_BADGE = {
  draft:     'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200',
  published: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  archived:  'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
};

function DoseProgramsTab({ headers, canEdit }) {
  const { showError, showSuccess } = useToast();
  const [programs, setPrograms] = useState([]);
  const [tanks, setTanks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // program object, 'new', or null
  const [expandedId, setExpandedId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, t] = await Promise.all([
        fetch(`${API_BASE}/fertigation/dose-programs`, { headers }).then(r => r.json()),
        fetch(`${API_BASE}/fertigation/tanks`, { headers }).then(r => r.json()),
      ]);
      setPrograms(Array.isArray(p) ? p : []);
      setTanks(Array.isArray(t) ? t : []);
    } catch (err) {
      showError(`Could not load dose programs: ${err.message}`);
    } finally { setLoading(false); }
  }, [headers, showError]);

  useEffect(() => { load(); }, [load]);

  const publish = async (id) => {
    try {
      const r = await fetch(`${API_BASE}/fertigation/dose-programs/${id}/publish`, { method: 'POST', headers });
      if (r.ok) { showSuccess('Dose program published'); load(); }
      else {
        const e = await r.json().catch(() => ({}));
        showError(e.error || 'Failed to publish dose program');
      }
    } catch (e) { showError('Failed to publish dose program: ' + e.message); }
  };

  if (loading) return <Spinner text="Loading dose programs..." />;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Per-tank duty-cycle recipes. Published programs are pickable by the AI planner; drafts are private work-in-progress.
        </p>
        {canEdit && (
          <button onClick={() => setEditing('new')}
            className="px-3 py-1.5 bg-primary-600 hover:bg-primary-700 text-white text-sm rounded-md">
            + New Program
          </button>
        )}
      </div>

      {programs.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 text-center text-sm text-gray-500 dark:text-gray-400">
          No dose programs yet. Defaults are seeded on first boot — if you don't see any, your tanks may not be configured.
        </div>
      ) : (
        <div className="space-y-2">
          {programs.map(p => (
            <DoseProgramCard
              key={p.id}
              program={p}
              tanks={tanks}
              expanded={expandedId === p.id}
              onExpand={() => setExpandedId(expandedId === p.id ? null : p.id)}
              canEdit={canEdit}
              onEdit={() => setEditing(p)}
              onPublish={() => publish(p.id)}
              headers={headers}
            />
          ))}
        </div>
      )}

      {editing && (
        <DoseProgramEditModal
          program={editing === 'new' ? null : editing}
          tanks={tanks}
          headers={headers}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function DoseProgramCard({ program, tanks, expanded, onExpand, canEdit, onEdit, onPublish, headers }) {
  const { showError: showProgramError } = useToast();
  const [preview, setPreview] = useState(null);
  const tanksById = React.useMemo(() => {
    const m = {};
    for (const t of tanks) m[t.id] = t;
    return m;
  }, [tanks]);

  useEffect(() => {
    if (!expanded) return;
    fetch(`${API_BASE}/fertigation/dose-programs/${program.id}/ppm-preview`, { headers })
      .then(r => r.ok ? r.json() : null)
      .then(setPreview)
      .catch(err => showProgramError(`Could not load ppm preview for ${program.name || 'program'}: ${err.message}`));
  }, [expanded, program.id, headers]);

  const elements = preview?.total_irrigation_ppm
    ? ELEMENT_ORDER.filter(e => preview.total_irrigation_ppm[e] != null && preview.total_irrigation_ppm[e] > 0)
    : [];

  // Mini summary: list non-zero tanks
  const activeTanks = (program.tanks || []).filter(t => t.duty_pct > 0);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
      <button onClick={onExpand} className="w-full text-left p-3 hover:bg-gray-50 dark:hover:bg-gray-700/30">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-0.5">
              <h3 className="font-semibold text-gray-900 dark:text-white truncate">{program.name}</h3>
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${STATUS_BADGE[program.status] || STATUS_BADGE.draft}`}>
                {program.status}
              </span>
              {program.origin && program.origin !== 'manual' && (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
                  {program.origin}
                </span>
              )}
              {program.compatibility_strategy === 'time_slice' && (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300">
                  time-slice
                </span>
              )}
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
              {program.description || activeTanks.map(t => `${tanksById[t.tank_id]?.name || `T${t.tank_id}`} ${t.duty_pct}%`).join(' · ') || 'No active tanks'}
            </p>
            <p className="text-[10px] text-gray-400 mt-0.5">
              Window {program.window_seconds}s · {program.target_ec ? `EC ${program.target_ec}` : 'EC —'} · {program.target_ph ? `pH ${program.target_ph}` : 'pH —'}
            </p>
          </div>
          <svg className={`w-4 h-4 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 border-t border-gray-100 dark:border-gray-700">
          <div className="mt-2 space-y-1">
            {(program.tanks || []).sort((a, b) => (a.priority || 0) - (b.priority || 0)).map(pt => {
              const t = tanksById[pt.tank_id];
              const role = t?.role || '';
              return (
                <div key={pt.tank_id} className="flex items-center gap-3 text-xs bg-gray-50 dark:bg-gray-700/40 rounded px-2 py-1">
                  <span className="w-44 truncate text-gray-800 dark:text-gray-200">
                    {t?.name || `Tank ${pt.tank_id}`}
                    {role && <span className="text-[10px] text-gray-400 ml-1">({role})</span>}
                  </span>
                  <div className="flex-1 bg-gray-200 dark:bg-gray-600 h-2 rounded-full overflow-hidden">
                    <div className="bg-yellow-500 h-full" style={{ width: `${pt.duty_pct}%` }} />
                  </div>
                  <span className="w-12 text-right font-medium tabular-nums text-gray-700 dark:text-gray-200">{pt.duty_pct}%</span>
                  {pt.compatibility_slot != null && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                      slot {pt.compatibility_slot}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {preview && elements.length > 0 && (
            <div className="mt-3">
              <p className="text-[10px] uppercase text-gray-500 dark:text-gray-400 mb-1">
                Predicted irrigation ppm at water flow {preview.water_lpm?.toFixed(1)} L/min
              </p>
              <div className="grid grid-cols-4 sm:grid-cols-6 gap-1.5">
                {elements.map(el => (
                  <div key={el} className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded px-1.5 py-0.5">
                    <p className="text-[9px] text-yellow-700 dark:text-yellow-300 font-semibold">{el}</p>
                    <p className="text-xs font-bold text-yellow-900 dark:text-yellow-100 tabular-nums">
                      {preview.total_irrigation_ppm[el].toFixed(1)}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {canEdit && (
            <div className="flex items-center gap-2 mt-3">
              <button onClick={onEdit}
                className="px-3 py-2 border border-gray-300 dark:border-gray-600 text-xs text-gray-700 dark:text-gray-200 rounded hover:bg-gray-50 dark:hover:bg-gray-700">
                Edit
              </button>
              {program.status !== 'published' && (
                <button onClick={onPublish}
                  className="px-3 py-2 bg-green-600 hover:bg-green-700 text-white text-xs rounded">
                  Publish
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DoseProgramEditModal({ program, tanks, headers, onClose, onSaved }) {
  const isNew = !program;
  const initialTanks = React.useMemo(() => {
    const byId = {};
    if (program?.tanks) for (const t of program.tanks) byId[t.tank_id] = t;
    return tanks.map(t => ({
      tank_id: t.id,
      name: t.name,
      role: t.role,
      duty_pct: byId[t.id]?.duty_pct ?? 0,
      priority: byId[t.id]?.priority ?? 0,
      compatibility_slot: byId[t.id]?.compatibility_slot ?? '',
    }));
  }, [program, tanks]);

  const [form, setForm] = useState({
    name: program?.name || '',
    description: program?.description || '',
    window_seconds: program?.window_seconds ?? 60,
    target_ec: program?.target_ec ?? '',
    target_ph: program?.target_ph ?? '',
    compatibility_strategy: program?.compatibility_strategy || 'permissive',
    status: program?.status || 'draft',
    tanks: initialTanks,
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const updateTank = (idx, k, v) => {
    setForm(f => {
      const tanks = [...f.tanks];
      tanks[idx] = { ...tanks[idx], [k]: v };
      return { ...f, tanks };
    });
  };

  const save = async () => {
    if (!form.name.trim()) return setErr('Name is required');
    setSaving(true); setErr('');
    try {
      const body = {
        name: form.name.trim(),
        description: form.description || null,
        window_seconds: parseInt(form.window_seconds) || 60,
        target_ec: form.target_ec === '' ? null : parseFloat(form.target_ec),
        target_ph: form.target_ph === '' ? null : parseFloat(form.target_ph),
        compatibility_strategy: form.compatibility_strategy,
        status: form.status,
        tanks: form.tanks.map(t => ({
          tank_id: t.tank_id,
          duty_pct: Math.max(0, Math.min(100, parseFloat(t.duty_pct) || 0)),
          priority: parseInt(t.priority) || 0,
          compatibility_slot: t.compatibility_slot === '' || t.compatibility_slot == null
            ? null
            : parseInt(t.compatibility_slot),
        })),
      };
      const url = isNew ? `${API_BASE}/fertigation/dose-programs` : `${API_BASE}/fertigation/dose-programs/${program.id}`;
      const r = await fetch(url, { method: isNew ? 'POST' : 'PUT', headers, body: JSON.stringify(body) });
      if (!r.ok) { setErr((await r.json()).error || 'Save failed'); setSaving(false); return; }
      onSaved();
    } catch (e) { setErr(e.message); setSaving(false); }
  };

  return (
    <Modal onClose={onClose} title={isNew ? 'New Dose Program' : `Edit — ${program.name}`}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 dark:text-white" />
          </Field>
          <Field label="Status">
            <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 dark:text-white">
              <option value="draft">Draft (private)</option>
              <option value="published">Published (planner can pick)</option>
              <option value="archived">Archived</option>
            </select>
          </Field>
          <Field label="Window seconds">
            <input type="number" min="5" max="600" value={form.window_seconds}
              onChange={e => setForm(f => ({ ...f, window_seconds: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 dark:text-white" />
          </Field>
          <Field label="Compatibility strategy">
            <select value={form.compatibility_strategy} onChange={e => setForm(f => ({ ...f, compatibility_strategy: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 dark:text-white">
              <option value="permissive">Permissive (all valves can co-open)</option>
              <option value="time_slice">Time-slice (separate by compatibility slot)</option>
            </select>
          </Field>
          <Field label="Target EC">
            <input type="number" step="0.1" value={form.target_ec}
              onChange={e => setForm(f => ({ ...f, target_ec: e.target.value }))}
              placeholder="e.g. 2.5"
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 dark:text-white" />
          </Field>
          <Field label="Target pH">
            <input type="number" step="0.1" value={form.target_ph}
              onChange={e => setForm(f => ({ ...f, target_ph: e.target.value }))}
              placeholder="e.g. 5.8"
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 dark:text-white" />
          </Field>
        </div>
        <Field label="Description">
          <textarea rows="2" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 dark:text-white text-sm" />
        </Field>
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Per-tank duty cycle</label>
          <div className="space-y-2 max-h-72 overflow-y-auto">
            {form.tanks.map((t, idx) => (
              <div key={t.tank_id} className="flex items-center gap-2 bg-gray-50 dark:bg-gray-700/40 rounded px-2 py-1.5">
                <span className="w-40 truncate text-sm text-gray-700 dark:text-gray-200">
                  {t.name} <span className="text-[10px] text-gray-400">({t.role})</span>
                </span>
                <input type="range" min="0" max="100" step="1" value={t.duty_pct}
                  onChange={e => updateTank(idx, 'duty_pct', e.target.value)}
                  className="flex-1" />
                <input type="number" min="0" max="100" step="1" value={t.duty_pct}
                  onChange={e => updateTank(idx, 'duty_pct', e.target.value)}
                  className="w-14 px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 dark:text-white text-sm text-right" />
                <span className="text-[10px] text-gray-500">%</span>
                <input type="number" min="0" max="9" step="1" value={t.compatibility_slot}
                  onChange={e => updateTank(idx, 'compatibility_slot', e.target.value)}
                  placeholder="slot"
                  title="Compatibility slot (only used when strategy = time_slice)"
                  className="w-14 px-1 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 dark:text-white text-xs text-right" />
              </div>
            ))}
          </div>
          <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-1">
            Tip: in time-slice mode, give calcium-group tanks slot 0 and sulfate/phosphate-group tanks slot 1 to avoid co-injection.
          </p>
        </div>
        {err && <p className="text-xs text-red-600 dark:text-red-400">{err}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300">Cancel</button>
          <button onClick={save} disabled={saving}
            className="px-3 py-1.5 bg-primary-600 hover:bg-primary-700 text-white text-sm rounded-md disabled:opacity-60">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ─── Element Targets Tab ───
 *
 * Per-element {hard_min, soft_target, hard_max, priority}. priority=1 wins ties when
 * the planner picks duty cycles. hard_min / hard_max are inviolable bounds.
 *
 * For monoculture: edits the system-wide default row (crop_assignment_id=NULL,
 * growth_stage=NULL). When you add more crops/stages we'll add scope pickers.
 */

const TARGET_ELEMENT_GROUPS = [
  {
    label: 'Elemental (computed from tank composition)',
    description: '% by weight, derived from each ingredient\'s elemental composition. Used by the planner when computing predicted irrigation ppm from dose programs.',
    elements: ['N', 'P', 'K', 'Ca', 'Mg', 'S', 'Fe', 'Mn', 'Zn', 'Cu', 'B', 'Mo'],
  },
  {
    label: 'Ionic (measured by AMIC / lab)',
    description: 'Match the labels AMIC actually emits. The planner compares lab samples against these directly — no unit conversion needed.',
    elements: ['nitrate_NO3', 'ammonium_NH4', 'potassium_K', 'calcium_Ca', 'magnesium_Mg', 'sulfate_SO4', 'phosphate_PO4', 'chloride_Cl', 'sodium_Na'],
  },
];
// Flat array kept for back-compat (everything we render across all groups).
const TARGET_ELEMENTS = TARGET_ELEMENT_GROUPS.flatMap(g => g.elements);

const ELEMENT_LABEL_PRETTY = {
  nitrate_NO3:  'NO₃⁻ (nitrate)',
  ammonium_NH4: 'NH₄⁺ (ammonium)',
  potassium_K:  'K⁺ (potassium)',
  calcium_Ca:   'Ca²⁺ (calcium)',
  magnesium_Mg: 'Mg²⁺ (magnesium)',
  sulfate_SO4:  'SO₄²⁻ (sulfate)',
  phosphate_PO4:'PO₄³⁻ (phosphate)',
  chloride_Cl:  'Cl⁻ (chloride)',
  sodium_Na:    'Na⁺ (sodium)',
};

function ElementTargetsTab({ headers, canEdit }) {
  const { showError } = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingEl, setSavingEl] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/fertigation/element-targets?crop_assignment_id=null`, { headers });
      if (r.ok) setRows(await r.json());
      else showError('Could not load element targets');
    } catch (err) {
      showError(`Could not load element targets: ${err.message}`);
    } finally { setLoading(false); }
  }, [headers, showError]);

  useEffect(() => { load(); }, [load]);

  const byElement = React.useMemo(() => {
    const m = {};
    for (const r of rows) if (r.element) m[r.element] = r;
    return m;
  }, [rows]);

  const save = async (element, patch) => {
    setSavingEl(element);
    try {
      const cur = byElement[element] || {};
      const body = {
        crop_assignment_id: null,
        growth_stage: null,
        element,
        hard_min: patch.hard_min !== undefined ? patch.hard_min : cur.hard_min,
        soft_target: patch.soft_target !== undefined ? patch.soft_target : cur.soft_target,
        hard_max: patch.hard_max !== undefined ? patch.hard_max : cur.hard_max,
        priority: patch.priority !== undefined ? patch.priority : (cur.priority ?? 3),
        notes: patch.notes !== undefined ? patch.notes : cur.notes,
      };
      const r = await fetch(`${API_BASE}/fertigation/element-targets`, {
        method: 'POST', headers, body: JSON.stringify(body),
      });
      if (r.ok) {
        const saved = await r.json();
        setRows(prev => {
          const next = prev.filter(p => p.element !== element);
          next.push(saved);
          return next;
        });
      } else {
        const e = await r.json().catch(() => ({}));
        showError(e.error || `Failed to save target for ${element}`);
      }
    } catch (e) { showError(`Failed to save target for ${element}: ` + e.message); } finally { setSavingEl(null); }
  };

  if (loading) return <Spinner text="Loading element targets..." />;

  return (
    <div className="space-y-3">
      <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded p-3 text-xs text-blue-800 dark:text-blue-200">
        <p className="font-semibold mb-1">How the planner uses these</p>
        <p>
          <strong>Hard min / hard max</strong> are inviolable bounds — the planner will not propose a dose program whose
          predicted irrigation ppm crosses them. <strong>Soft target</strong> is the goal. <strong>Priority</strong> (1=highest, 5=lowest)
          weighs how aggressively the planner minimizes deviation from soft_target. When ingredients are coupled (e.g. Ca-nitrate
          delivers both Ca and N), higher-priority elements override lower-priority ones — at duty=100% Ca might hit 150 ppm while
          N reaches 139 ppm even if N's soft_target is 100 ppm, as long as N stays under its hard_max.
        </p>
      </div>
      {TARGET_ELEMENT_GROUPS.map(group => (
        <div key={group.label} className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
            <h3 className="font-semibold text-gray-900 dark:text-white">{group.label}</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{group.description}</p>
          </div>
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700 text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900">
              <tr>
                <TH>Element / Ion</TH>
                <TH right>Hard min</TH>
                <TH right>Soft target</TH>
                <TH right>Hard max</TH>
                <TH right>Priority (1-5)</TH>
                <TH>Notes</TH>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {group.elements.map(el => {
                const row = byElement[el] || {};
                const label = ELEMENT_LABEL_PRETTY[el] || el;
                return (
                  <tr key={el} className={savingEl === el ? 'opacity-50' : ''}>
                    <TD bold>{label}</TD>
                    <td className="px-4 py-2 text-right">
                      <input type="number" step="0.01" defaultValue={row.hard_min ?? ''} disabled={!canEdit}
                        onBlur={e => {
                          const v = e.target.value === '' ? null : parseFloat(e.target.value);
                          if (v !== (row.hard_min ?? null)) save(el, { hard_min: v });
                        }}
                        className="w-20 px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 dark:text-white text-right text-xs tabular-nums" />
                    </td>
                    <td className="px-4 py-2 text-right">
                      <input type="number" step="0.01" defaultValue={row.soft_target ?? ''} disabled={!canEdit}
                        onBlur={e => {
                          const v = e.target.value === '' ? null : parseFloat(e.target.value);
                          if (v !== (row.soft_target ?? null)) save(el, { soft_target: v });
                        }}
                        className="w-20 px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 dark:text-white text-right text-xs tabular-nums" />
                    </td>
                    <td className="px-4 py-2 text-right">
                      <input type="number" step="0.01" defaultValue={row.hard_max ?? ''} disabled={!canEdit}
                        onBlur={e => {
                          const v = e.target.value === '' ? null : parseFloat(e.target.value);
                          if (v !== (row.hard_max ?? null)) save(el, { hard_max: v });
                        }}
                        className="w-20 px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 dark:text-white text-right text-xs tabular-nums" />
                    </td>
                    <td className="px-4 py-2 text-right">
                      <select defaultValue={row.priority ?? 3} disabled={!canEdit}
                        onChange={e => save(el, { priority: parseInt(e.target.value) })}
                        className="px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 dark:text-white text-xs">
                        {[1,2,3,4,5].map(p => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </td>
                    <td className="px-4 py-2">
                      <input type="text" defaultValue={row.notes ?? ''} disabled={!canEdit}
                        onBlur={e => {
                          if (e.target.value !== (row.notes ?? '')) save(el, { notes: e.target.value || null });
                        }}
                        placeholder="—"
                        className="w-full px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 dark:text-white text-xs" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function IngredientEditModal({ ingredient, headers, onClose, onSaved }) {
  const initialComp = (() => {
    try { return ingredient.composition ? JSON.parse(ingredient.composition) : {}; } catch (_) { return {}; }
  })();
  const [form, setForm] = useState({
    name: ingredient.name,
    form: ingredient.form || 'solid',
    density_kg_per_l: ingredient.density_kg_per_l ?? 1,
    compatibility_group: ingredient.compatibility_group || '',
    notes: ingredient.notes || '',
    composition: { ...initialComp },
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const update = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const updateElement = (el, v) => setForm(f => {
    const c = { ...f.composition };
    if (v === '' || v == null) delete c[el]; else c[el] = parseFloat(v);
    return { ...f, composition: c };
  });

  const save = async () => {
    if (!form.name.trim()) return setErr('Name is required');
    setSaving(true); setErr('');
    try {
      const r = await fetch(`${API_BASE}/fertigation/ingredients/${ingredient.id}`, {
        method: 'PUT', headers,
        body: JSON.stringify({
          name: form.name.trim(),
          form: form.form,
          density_kg_per_l: parseFloat(form.density_kg_per_l) || 1,
          compatibility_group: form.compatibility_group || null,
          composition: form.composition,
          notes: form.notes || null,
        }),
      });
      if (!r.ok) { setErr((await r.json()).error || 'Save failed'); setSaving(false); return; }
      onSaved();
    } catch (e) { setErr(e.message); setSaving(false); }
  };

  return (
    <Modal onClose={onClose} title={`Ingredient — ${ingredient.name}`}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <input type="text" value={form.name} onChange={e => update('name', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 dark:text-white" />
          </Field>
          <Field label="Form">
            <select value={form.form} onChange={e => update('form', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 dark:text-white">
              <option value="solid">Solid (kg)</option>
              <option value="liquid">Liquid (L)</option>
            </select>
          </Field>
          <Field label="Density (kg/L) — for liquids">
            <input type="number" min="0" step="0.01" value={form.density_kg_per_l} onChange={e => update('density_kg_per_l', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 dark:text-white" />
          </Field>
          <Field label="Compatibility group">
            <input type="text" value={form.compatibility_group} onChange={e => update('compatibility_group', e.target.value)}
              placeholder="calcium / sulfate / phosphate / micro / acid / base"
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 dark:text-white" />
          </Field>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">
            Elemental composition (% by weight)
          </label>
          <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
            {ELEMENT_ORDER.map(el => (
              <div key={el}>
                <label className="block text-[10px] text-gray-500 dark:text-gray-400">{el}</label>
                <input type="number" min="0" step="0.1" value={form.composition[el] ?? ''}
                  onChange={e => updateElement(el, e.target.value)}
                  className="w-full px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 dark:text-white text-sm tabular-nums" />
              </div>
            ))}
          </div>
        </div>
        <Field label="Notes">
          <textarea rows="2" value={form.notes} onChange={e => update('notes', e.target.value)}
            placeholder="Supplier label notes, caveats…"
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 dark:text-white text-sm" />
        </Field>
        {err && <p className="text-xs text-red-600 dark:text-red-400">{err}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300">Cancel</button>
          <button onClick={save} disabled={saving}
            className="px-3 py-1.5 bg-primary-600 hover:bg-primary-700 text-white text-sm rounded-md disabled:opacity-60">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-lg" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <h3 className="font-semibold text-gray-900 dark:text-white">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
