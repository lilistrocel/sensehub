import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useSettings } from '../context/SettingsContext';

const API_BASE = '/api';

export default function LabAnalysis() {
  const { token, user } = useAuth();
  const { formatDateTime } = useSettings();
  const canEdit = user?.role === 'admin' || user?.role === 'operator';

  const [nutrients, setNutrients] = useState([]);
  const [zones, setZones] = useState([]);
  const [readings, setReadings] = useState([]);
  const [stats, setStats] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Filters
  const [filterNutrient, setFilterNutrient] = useState('');
  const [filterZone, setFilterZone] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');
  const [page, setPage] = useState(0);
  const pageSize = 25;

  // Add form
  const [showAddForm, setShowAddForm] = useState(false);
  const [entries, setEntries] = useState([{ nutrient: '', value: '', unit: '', zone_id: '', notes: '' }]);
  const [sampleDate, setSampleDate] = useState(new Date().toISOString().split('T')[0]);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState(null);

  // Edit
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({});

  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Fetch nutrients list
  useEffect(() => {
    fetch(`${API_BASE}/lab-readings/nutrients`, { headers })
      .then(r => r.json())
      .then(setNutrients)
      .catch(() => {});
    fetch(`${API_BASE}/zones`, { headers })
      .then(r => r.json())
      .then(setZones)
      .catch(() => {});
  }, []);

  // Fetch readings
  const fetchReadings = () => {
    setLoading(true);
    const params = new URLSearchParams({ limit: pageSize, offset: page * pageSize });
    if (filterNutrient) params.set('nutrient', filterNutrient);
    if (filterZone) params.set('zone_id', filterZone);
    if (filterFrom) params.set('from', filterFrom);
    if (filterTo) params.set('to', filterTo);

    Promise.all([
      fetch(`${API_BASE}/lab-readings?${params}`, { headers }).then(r => r.json()),
      fetch(`${API_BASE}/lab-readings/stats?${new URLSearchParams({
        ...(filterZone && { zone_id: filterZone }),
        ...(filterFrom && { from: filterFrom }),
        ...(filterTo && { to: filterTo }),
      })}`, { headers }).then(r => r.json()),
    ]).then(([data, statsData]) => {
      setReadings(data.readings);
      setTotal(data.total);
      setStats(statsData);
      setError(null);
    }).catch(err => {
      setError(err.message);
    }).finally(() => setLoading(false));
  };

  useEffect(() => { fetchReadings(); }, [page, filterNutrient, filterZone, filterFrom, filterTo]);

  // Get nutrient display name
  const getNutrientName = (id) => {
    const n = nutrients.find(n => n.id === id);
    return n ? n.name : id;
  };

  // Get default unit for nutrient
  const getDefaultUnit = (nutrientId) => {
    const n = nutrients.find(n => n.id === nutrientId);
    return n ? n.defaultUnit : '';
  };

  // Add entry row
  const addEntryRow = () => {
    setEntries([...entries, { nutrient: '', value: '', unit: '', zone_id: '', notes: '' }]);
  };

  const removeEntryRow = (idx) => {
    if (entries.length > 1) {
      setEntries(entries.filter((_, i) => i !== idx));
    }
  };

  const updateEntry = (idx, field, value) => {
    const updated = [...entries];
    updated[idx] = { ...updated[idx], [field]: value };
    // Auto-fill unit when nutrient changes
    if (field === 'nutrient' && value) {
      updated[idx].unit = getDefaultUnit(value);
    }
    setEntries(updated);
  };

  // Submit new readings
  const handleSubmit = async (e) => {
    e.preventDefault();
    const valid = entries.filter(e => e.nutrient && e.value !== '');
    if (valid.length === 0) return;

    setSaving(true);
    setSaveMessage(null);
    try {
      const res = await fetch(`${API_BASE}/lab-readings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          entries: valid.map(e => ({
            sample_date: sampleDate,
            nutrient: e.nutrient,
            value: parseFloat(e.value),
            unit: e.unit,
            zone_id: e.zone_id || null,
            notes: e.notes || null,
          }))
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Failed to save');
      setSaveMessage({ type: 'success', text: `${data.count} reading(s) saved successfully` });
      setEntries([{ nutrient: '', value: '', unit: '', zone_id: '', notes: '' }]);
      setShowAddForm(false);
      setPage(0);
      fetchReadings();
    } catch (err) {
      setSaveMessage({ type: 'error', text: err.message });
    } finally {
      setSaving(false);
    }
  };

  // Delete reading
  const handleDelete = async (id) => {
    if (!confirm('Delete this lab reading?')) return;
    try {
      await fetch(`${API_BASE}/lab-readings/${id}`, { method: 'DELETE', headers });
      fetchReadings();
    } catch (err) {
      setError(err.message);
    }
  };

  // Edit reading
  const startEdit = (reading) => {
    setEditingId(reading.id);
    setEditForm({
      sample_date: reading.sample_date,
      nutrient: reading.nutrient,
      value: reading.value,
      unit: reading.unit,
      zone_id: reading.zone_id || '',
      notes: reading.notes || '',
    });
  };

  const saveEdit = async () => {
    try {
      const res = await fetch(`${API_BASE}/lab-readings/${editingId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(editForm)
      });
      if (!res.ok) throw new Error('Failed to update');
      setEditingId(null);
      fetchReadings();
    } catch (err) {
      setError(err.message);
    }
  };

  // Group nutrients by category for the dropdown
  const nutrientsByCategory = {};
  nutrients.forEach(n => {
    if (!nutrientsByCategory[n.category]) nutrientsByCategory[n.category] = [];
    nutrientsByCategory[n.category].push(n);
  });

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="p-4 md:p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Lab Analysis</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Manual nutrient measurements and lab results</p>
        </div>
        {canEdit && (
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="inline-flex items-center px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors text-sm font-medium"
          >
            <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
            {showAddForm ? 'Cancel' : 'Add Lab Reading'}
          </button>
        )}
      </div>

      {/* Success/Error Messages */}
      {saveMessage && (
        <div className={`p-3 rounded-lg text-sm ${saveMessage.type === 'success' ? 'bg-green-50 text-green-800 dark:bg-green-900/30 dark:text-green-400' : 'bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-400'}`}>
          {saveMessage.text}
        </div>
      )}

      {/* Add Form */}
      {showAddForm && canEdit && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">New Lab Analysis Entry</h2>
          <form onSubmit={handleSubmit}>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Sample Date</label>
              <input
                type="date"
                value={sampleDate}
                onChange={(e) => setSampleDate(e.target.value)}
                className="w-full sm:w-64 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
              />
            </div>

            <div className="space-y-3">
              {entries.map((entry, idx) => (
                <div key={idx} className="flex flex-wrap items-end gap-3 p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
                  <div className="flex-1 min-w-[180px]">
                    <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Nutrient</label>
                    <select
                      value={entry.nutrient}
                      onChange={(e) => updateEntry(idx, 'nutrient', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                      required
                    >
                      <option value="">Select nutrient...</option>
                      {Object.entries(nutrientsByCategory).map(([cat, items]) => (
                        <optgroup key={cat} label={cat}>
                          {items.map(n => (
                            <option key={n.id} value={n.id}>{n.name}</option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </div>
                  <div className="w-28">
                    <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Value</label>
                    <input
                      type="number"
                      step="any"
                      value={entry.value}
                      onChange={(e) => updateEntry(idx, 'value', e.target.value)}
                      placeholder="0.00"
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                      required
                    />
                  </div>
                  <div className="w-24">
                    <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Unit</label>
                    <input
                      type="text"
                      value={entry.unit}
                      onChange={(e) => updateEntry(idx, 'unit', e.target.value)}
                      placeholder="ppm"
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                    />
                  </div>
                  <div className="w-40">
                    <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Zone (optional)</label>
                    <select
                      value={entry.zone_id}
                      onChange={(e) => updateEntry(idx, 'zone_id', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                    >
                      <option value="">No zone</option>
                      {zones.map(z => (
                        <option key={z.id} value={z.id}>{z.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex-1 min-w-[120px]">
                    <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Notes</label>
                    <input
                      type="text"
                      value={entry.notes}
                      onChange={(e) => updateEntry(idx, 'notes', e.target.value)}
                      placeholder="Optional notes"
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => removeEntryRow(idx)}
                    className="p-2 text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                    title="Remove row"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={addEntryRow}
                className="text-sm text-primary-600 dark:text-primary-400 hover:text-primary-700 dark:hover:text-primary-300 font-medium"
              >
                + Add another nutrient
              </button>
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => setShowAddForm(false)}
                className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 text-sm text-white bg-primary-600 rounded-lg hover:bg-primary-700 disabled:opacity-50"
              >
                {saving ? 'Saving...' : `Save ${entries.filter(e => e.nutrient && e.value !== '').length} Reading(s)`}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Stats Summary */}
      {stats.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Nutrient Summary</h2>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4 p-4">
            {stats.map((s, i) => (
              <div key={i} className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3 text-center">
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 truncate" title={getNutrientName(s.nutrient)}>
                  {getNutrientName(s.nutrient)}
                </p>
                <p className="text-lg font-bold text-gray-900 dark:text-white mt-1">
                  {typeof s.avg === 'number' ? s.avg.toFixed(2) : s.avg}
                  <span className="text-xs font-normal text-gray-500 dark:text-gray-400 ml-1">{s.unit}</span>
                </p>
                <p className="text-xs text-gray-400 dark:text-gray-500">
                  {typeof s.min === 'number' ? s.min.toFixed(1) : s.min} - {typeof s.max === 'number' ? s.max.toFixed(1) : s.max}
                </p>
                <p className="text-xs text-gray-400 dark:text-gray-500">{s.count} reading{s.count !== 1 ? 's' : ''}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Nutrient</label>
            <select
              value={filterNutrient}
              onChange={(e) => { setFilterNutrient(e.target.value); setPage(0); }}
              className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
            >
              <option value="">All Nutrients</option>
              {Object.entries(nutrientsByCategory).map(([cat, items]) => (
                <optgroup key={cat} label={cat}>
                  {items.map(n => (
                    <option key={n.id} value={n.id}>{n.name}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Zone</label>
            <select
              value={filterZone}
              onChange={(e) => { setFilterZone(e.target.value); setPage(0); }}
              className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
            >
              <option value="">All Zones</option>
              {zones.map(z => (
                <option key={z.id} value={z.id}>{z.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">From</label>
            <input
              type="date"
              value={filterFrom}
              onChange={(e) => { setFilterFrom(e.target.value); setPage(0); }}
              className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">To</label>
            <input
              type="date"
              value={filterTo}
              onChange={(e) => { setFilterTo(e.target.value); setPage(0); }}
              className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
            />
          </div>
          {(filterNutrient || filterZone || filterFrom || filterTo) && (
            <button
              onClick={() => { setFilterNutrient(''); setFilterZone(''); setFilterFrom(''); setFilterTo(''); setPage(0); }}
              className="px-3 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* Readings Table */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            History
            <span className="text-sm font-normal text-gray-500 dark:text-gray-400 ml-2">({total} total)</span>
          </h2>
        </div>

        {loading ? (
          <div className="p-8 text-center text-gray-500 dark:text-gray-400">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto mb-2"></div>
            Loading...
          </div>
        ) : error ? (
          <div className="p-8 text-center text-red-500">{error}</div>
        ) : readings.length === 0 ? (
          <div className="p-8 text-center text-gray-500 dark:text-gray-400">
            No lab readings found. Click "Add Lab Reading" to enter your first analysis.
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-700/50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Date</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Nutrient</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Value</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Unit</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Zone</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Notes</th>
                    {canEdit && (
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Actions</th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {readings.map((r) => (
                    <tr key={r.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                      {editingId === r.id ? (
                        <>
                          <td className="px-4 py-2">
                            <input type="date" value={editForm.sample_date} onChange={(e) => setEditForm({...editForm, sample_date: e.target.value})}
                              className="w-full px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm" />
                          </td>
                          <td className="px-4 py-2">
                            <select value={editForm.nutrient} onChange={(e) => setEditForm({...editForm, nutrient: e.target.value})}
                              className="w-full px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm">
                              {Object.entries(nutrientsByCategory).map(([cat, items]) => (
                                <optgroup key={cat} label={cat}>
                                  {items.map(n => (<option key={n.id} value={n.id}>{n.name}</option>))}
                                </optgroup>
                              ))}
                            </select>
                          </td>
                          <td className="px-4 py-2">
                            <input type="number" step="any" value={editForm.value} onChange={(e) => setEditForm({...editForm, value: e.target.value})}
                              className="w-20 px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm text-right" />
                          </td>
                          <td className="px-4 py-2">
                            <input type="text" value={editForm.unit} onChange={(e) => setEditForm({...editForm, unit: e.target.value})}
                              className="w-16 px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm" />
                          </td>
                          <td className="px-4 py-2">
                            <select value={editForm.zone_id} onChange={(e) => setEditForm({...editForm, zone_id: e.target.value})}
                              className="w-full px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm">
                              <option value="">None</option>
                              {zones.map(z => (<option key={z.id} value={z.id}>{z.name}</option>))}
                            </select>
                          </td>
                          <td className="px-4 py-2">
                            <input type="text" value={editForm.notes} onChange={(e) => setEditForm({...editForm, notes: e.target.value})}
                              className="w-full px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm" />
                          </td>
                          <td className="px-4 py-2 text-right space-x-1">
                            <button onClick={saveEdit} className="text-green-600 hover:text-green-800 dark:text-green-400 text-xs font-medium">Save</button>
                            <button onClick={() => setEditingId(null)} className="text-gray-500 hover:text-gray-700 dark:text-gray-400 text-xs font-medium">Cancel</button>
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="px-4 py-3 text-gray-900 dark:text-white whitespace-nowrap">{r.sample_date}</td>
                          <td className="px-4 py-3 text-gray-900 dark:text-white font-medium">{getNutrientName(r.nutrient)}</td>
                          <td className="px-4 py-3 text-gray-900 dark:text-white text-right font-mono">{typeof r.value === 'number' ? r.value.toFixed(2) : r.value}</td>
                          <td className="px-4 py-3 text-gray-500 dark:text-gray-400">{r.unit}</td>
                          <td className="px-4 py-3 text-gray-500 dark:text-gray-400">{r.zone_name || '-'}</td>
                          <td className="px-4 py-3 text-gray-500 dark:text-gray-400 max-w-xs truncate">{r.notes || '-'}</td>
                          {canEdit && (
                            <td className="px-4 py-3 text-right space-x-2">
                              <button onClick={() => startEdit(r)} className="text-primary-600 hover:text-primary-800 dark:text-primary-400 text-xs font-medium">Edit</button>
                              <button onClick={() => handleDelete(r.id)} className="text-red-600 hover:text-red-800 dark:text-red-400 text-xs font-medium">Delete</button>
                            </td>
                          )}
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="px-6 py-3 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between">
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Showing {page * pageSize + 1}-{Math.min((page + 1) * pageSize, total)} of {total}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setPage(p => Math.max(0, p - 1))}
                    disabled={page === 0}
                    className="px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded disabled:opacity-50 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                  >
                    Previous
                  </button>
                  <button
                    onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                    disabled={page >= totalPages - 1}
                    className="px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded disabled:opacity-50 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
