import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useSettings } from '../context/SettingsContext';

const API_BASE = '/api';

const TABS = [
  { key: 'consumption', label: 'Consumption' },
  { key: 'mixtures', label: 'Mixtures' },
  { key: 'channels', label: 'Channel Config' },
  { key: 'events', label: 'Event Log' },
];

export default function Fertigation() {
  const { token, user } = useAuth();
  const { formatDateTime } = useSettings();
  const canEdit = user?.role === 'admin' || user?.role === 'operator';
  const [activeTab, setActiveTab] = useState('consumption');
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

      {activeTab === 'consumption' && <ConsumptionTab headers={headers} formatDateTime={formatDateTime} />}
      {activeTab === 'mixtures' && <MixturesTab headers={headers} canEdit={canEdit} />}
      {activeTab === 'channels' && <ChannelConfigTab headers={headers} canEdit={canEdit} />}
      {activeTab === 'events' && <EventLogTab headers={headers} formatDateTime={formatDateTime} />}
    </div>
  );
}

/* ─── Consumption Tab ─── */
function ConsumptionTab({ headers, formatDateTime }) {
  const today = new Date().toISOString().split('T')[0];
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
  const [from, setFrom] = useState(weekAgo);
  const [to, setTo] = useState(today);
  const [data, setData] = useState(null);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchSummary = useCallback(() => {
    fetch(`${API_BASE}/fertigation/consumption/summary`, { headers })
      .then(r => r.json()).then(setSummary).catch(() => {});
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
      items: mixture?.items?.map(i => ({ ingredient_id: i.ingredient_id, parts: i.parts })) || [{ ingredient_id: '', parts: 1 }]
    });
  };

  const saveMixture = async () => {
    if (!form.name.trim()) { setMessage({ type: 'error', text: 'Name is required' }); return; }
    const validItems = form.items.filter(i => i.ingredient_id && i.parts > 0);
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
      items[idx] = { ...items[idx], [field]: field === 'parts' ? parseFloat(value) || 0 : value };
      return { ...prev, items };
    });
  };

  const addFormItem = () => setForm(prev => ({ ...prev, items: [...prev.items, { ingredient_id: '', parts: 1 }] }));
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
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Ingredients &amp; Parts Ratio</label>
            <div className="space-y-2">
              {form.items.map((item, idx) => {
                const proportion = totalParts > 0 ? ((item.parts || 0) / totalParts * 100).toFixed(1) : '0.0';
                return (
                  <div key={idx} className="flex items-center gap-2">
                    <select value={item.ingredient_id} onChange={e => updateFormItem(idx, 'ingredient_id', parseInt(e.target.value) || '')}
                      className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm">
                      <option value="">Select ingredient...</option>
                      {ingredients.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
                    </select>
                    <input type="number" min="0.01" step="0.1" value={item.parts || ''} onChange={e => updateFormItem(idx, 'parts', e.target.value)}
                      placeholder="Parts"
                      className="w-24 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm text-right" />
                    <span className="w-14 text-xs text-gray-400 dark:text-gray-500 text-right">{proportion}%</span>
                    {form.items.length > 1 && (
                      <button onClick={() => removeFormItem(idx)} className="p-1 text-red-500 hover:text-red-700">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                      </button>
                    )}
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
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Ingredients</h3>
        <div className="flex flex-wrap gap-2 items-center">
          {ingredients.map(ing => (
            <span key={ing.id} className="inline-flex items-center gap-1 px-3 py-1 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-full text-sm">
              {ing.name}
              {canEdit && (
                <button onClick={() => deleteIngredient(ing.id)} className="text-gray-400 hover:text-red-500 ml-1">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              )}
            </span>
          ))}
          {canEdit && (
            <form onSubmit={e => { e.preventDefault(); addIngredient(); }} className="inline-flex gap-1">
              <input value={newIngredient} onChange={e => setNewIngredient(e.target.value)}
                placeholder="New ingredient..."
                className="px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm w-36" />
              <button type="submit" className="px-2 py-1 bg-primary-600 text-white text-xs rounded hover:bg-primary-700">Add</button>
            </form>
          )}
        </div>
      </div>

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
                        <button onClick={() => startEdit(mix)} className="px-2 py-1 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded">Edit</button>
                        <button onClick={() => deleteMixture(mix.id)} className="px-2 py-1 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded">Delete</button>
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
  const [loading, setLoading] = useState(true);
  const [editKey, setEditKey] = useState(null);
  const [form, setForm] = useState({ mode: 'mixture', ingredient_name: '', mixture_id: '', flow_rate: '', flow_unit: 'L/min' });
  const [message, setMessage] = useState(null);

  const fetchAll = () => {
    setLoading(true);
    Promise.all([
      fetch(`${API_BASE}/fertigation/channels`, { headers }).then(r => r.json()),
      fetch(`${API_BASE}/equipment`, { headers }).then(r => r.json()),
      fetch(`${API_BASE}/fertigation/mixtures`, { headers }).then(r => r.json()),
      fetch(`${API_BASE}/fertigation/ingredients`, { headers }).then(r => r.json()),
    ]).then(([ch, eq, mix, ing]) => {
      setChannels(ch);
      setEquipment(eq.filter(e => {
        const m = Array.isArray(e.register_mappings) ? e.register_mappings : [];
        return m.some(m => m.type === 'coil' && m.access === 'readwrite');
      }));
      setMixtures(mix);
      setIngredients(ing);
      setLoading(false);
    }).catch(() => setLoading(false));
  };

  useEffect(fetchAll, []);

  const handleSave = async (equipmentId, channel) => {
    if (!form.flow_rate) { setMessage({ type: 'error', text: 'Flow rate is required' }); return; }
    const body = { flow_rate: form.flow_rate, flow_unit: form.flow_unit };
    if (form.mode === 'mixture') {
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
    setForm({
      mode: existing?.mixture_id ? 'mixture' : (existing?.ingredient_name ? 'single' : 'mixture'),
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
                          <div className="flex gap-2">
                            <label className="inline-flex items-center text-xs">
                              <input type="radio" checked={form.mode === 'mixture'} onChange={() => setForm(prev => ({ ...prev, mode: 'mixture' }))} className="mr-1" />
                              Mixture
                            </label>
                            <label className="inline-flex items-center text-xs">
                              <input type="radio" checked={form.mode === 'single'} onChange={() => setForm(prev => ({ ...prev, mode: 'single' }))} className="mr-1" />
                              Single Ingredient
                            </label>
                          </div>
                          {form.mode === 'mixture' ? (
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
                        <span className={displayName ? 'text-gray-900 dark:text-white' : 'text-gray-400 dark:text-gray-500 italic'}>
                          {displayName || 'Not configured'}
                          {ch.config?.mixture_name && <span className="ml-1 text-xs text-gray-400">(mix)</span>}
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
                            <button onClick={() => handleSave(ch.equipment_id, ch.channel)} className="px-3 py-1 bg-primary-600 text-white text-xs rounded hover:bg-primary-700">Save</button>
                            <button onClick={() => setEditKey(null)} className="px-3 py-1 bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 text-xs rounded hover:bg-gray-300 dark:hover:bg-gray-500">Cancel</button>
                          </div>
                        ) : (
                          <div className="flex justify-end gap-2">
                            <button onClick={() => startEdit(ch.equipment_id, ch.channel, ch.config)}
                              className="px-3 py-1 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-xs rounded hover:bg-gray-200 dark:hover:bg-gray-600">
                              {ch.config ? 'Edit' : 'Configure'}
                            </button>
                            {ch.config && (
                              <button onClick={() => handleDelete(ch.equipment_id, ch.channel)}
                                className="px-3 py-1 text-red-600 dark:text-red-400 text-xs hover:bg-red-50 dark:hover:bg-red-900/20 rounded">Remove</button>
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
  const [events, setEvents] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [filterEquipment, setFilterEquipment] = useState('');
  const [filterSource, setFilterSource] = useState('');
  const [equipment, setEquipment] = useState([]);
  const pageSize = 50;

  useEffect(() => {
    fetch(`${API_BASE}/equipment`, { headers }).then(r => r.json()).then(setEquipment).catch(() => {});
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
                  className="px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-lg disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300">Previous</button>
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
