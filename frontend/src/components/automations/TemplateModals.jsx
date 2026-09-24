import React, { useState, useEffect } from 'react';
import { useToast } from '../../context/ToastContext';
import { getChannelDisplayName } from '../../utils/channelUtils';
import TransitionEditor from './TransitionEditor';
import DependencyEditor from './DependencyEditor';
import { parseRegisterMappings } from './automationSummary';
import { API_BASE } from './formStyles';

// Template manager (CRUD) and "new from template" picker, moved out of
// pages/Automations.jsx. Behaviour unchanged; buttons lifted to touch size.

// Template Manager Modal - CRUD for automation templates
export function TemplateManagerModal({ isOpen, onClose, token, onTemplateUpdated }) {
  const { showError } = useToast();
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [saving, setSaving] = useState(false);
  const [successMsg, setSuccessMsg] = useState(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formCategory, setFormCategory] = useState('General');
  const [formActions, setFormActions] = useState([]);

  // Action builder state
  const [newActionType, setNewActionType] = useState('alert');
  const [newActionMessage, setNewActionMessage] = useState('');
  const [newActionSeverity, setNewActionSeverity] = useState('info');
  const [newControlAction, setNewControlAction] = useState('on');
  const [newControlEquipmentId, setNewControlEquipmentId] = useState('');
  const [newControlChannel, setNewControlChannel] = useState('');
  const [newControlChannelName, setNewControlChannelName] = useState('');
  const [newControlValue, setNewControlValue] = useState('');
  const [newControlDelay, setNewControlDelay] = useState('');
  const [newControlDuration, setNewControlDuration] = useState('');
  const [newControlStaggerDelay, setNewControlStaggerDelay] = useState('');
  const [editingActionIdx, setEditingActionIdx] = useState(null);
  const [editingDepsIdx, setEditingDepsIdx] = useState(null);

  // Transition action state
  const [newTransitionEquipmentId, setNewTransitionEquipmentId] = useState('');
  const [newTransitionStates, setNewTransitionStates] = useState({});
  const [newTransitionDelay, setNewTransitionDelay] = useState('');
  const [newTransitionDuration, setNewTransitionDuration] = useState('');

  // Equipment list for control actions
  const [equipment, setEquipment] = useState([]);
  const [loadingEquipment, setLoadingEquipment] = useState(false);

  useEffect(() => {
    if (isOpen && token) {
      fetchTemplates();
      fetchEquipmentList();
    }
  }, [isOpen, token]);

  const fetchEquipmentList = async () => {
    try {
      setLoadingEquipment(true);
      const response = await fetch(`${API_BASE}/equipment`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (response.ok) setEquipment(await response.json());
    } catch (err) {
      console.error('Failed to fetch equipment:', err);
    } finally {
      setLoadingEquipment(false);
    }
  };

  const fetchTemplates = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch(`${API_BASE}/automation-templates`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) throw new Error('Failed to fetch templates');
      const data = await response.json();
      setTemplates(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setFormName('');
    setFormDescription('');
    setFormCategory('General');
    setFormActions([]);
    setEditingTemplate(null);
  };

  const startEdit = (template) => {
    setEditingTemplate(template);
    setFormName(template.name);
    setFormDescription(template.description || '');
    setFormCategory(template.category || 'General');
    setFormActions(template.actions || []);
    setSuccessMsg(null);
  };

  const startCreate = () => {
    resetForm();
    setEditingTemplate({ id: 'new' });
    setSuccessMsg(null);
  };

  const resetActionForm = () => {
    setNewActionType('alert');
    setNewActionMessage('');
    setNewActionSeverity('info');
    setNewControlAction('on');
    setNewControlEquipmentId('');
    setNewControlChannel('');
    setNewControlChannelName('');
    setNewControlValue('');
    setNewControlDelay('');
    setNewControlDuration('');
    setNewControlStaggerDelay('');
    setNewTransitionEquipmentId('');
    setNewTransitionStates({});
    setNewTransitionDelay('');
    setNewTransitionDuration('');
    setEditingActionIdx(null);
  };

  const addAction = () => {
    let action;
    if (newActionType === 'alert') {
      action = { type: 'alert', severity: newActionSeverity, message: newActionMessage || 'Alert triggered' };
    } else if (newActionType === 'log') {
      action = { type: 'log', message: newActionMessage || 'Event logged' };
    } else if (newActionType === 'control') {
      if (!newControlEquipmentId) return;
      const selectedEq = equipment.find(eq => eq.id === parseInt(newControlEquipmentId));
      const isAllChannels = !newControlChannel;
      action = {
        type: 'control',
        action: newControlAction,
        equipment_id: parseInt(newControlEquipmentId),
        equipment_name: selectedEq?.name || 'Unknown Equipment',
        value: newControlAction === 'set' ? newControlValue : null,
        channel: newControlChannel ? parseInt(newControlChannel) : null,
        channel_name: newControlChannelName || null,
        delay_seconds: newControlDelay ? parseInt(newControlDelay) : null,
        duration_seconds: newControlDuration ? parseInt(newControlDuration) : null,
        ...(isAllChannels && newControlStaggerDelay ? { stagger_delay_seconds: parseFloat(newControlStaggerDelay) } : {})
      };
    } else if (newActionType === 'transition') {
      if (!newTransitionEquipmentId) return;
      const selectedEq = equipment.find(eq => eq.id === parseInt(newTransitionEquipmentId));
      const transitions = Object.entries(newTransitionStates)
        .filter(([_, v]) => v === true || v === false)
        .map(([ch, v]) => {
          let mapping = null;
          try {
            const mappings = typeof selectedEq?.register_mappings === 'string'
              ? JSON.parse(selectedEq.register_mappings)
              : (selectedEq?.register_mappings || []);
            mapping = mappings.find(m => String(m.register ?? m.address) === ch);
          } catch (err) {
            showError(`Could not read channel mappings for ${selectedEq?.name || 'the selected equipment'}: ${err.message}`);
          }
          return { channel: parseInt(ch), state: v, name: mapping ? getChannelDisplayName(mapping) : `Coil ${ch}` };
        });
      if (transitions.length === 0) return;
      action = {
        type: 'transition',
        equipment_id: parseInt(newTransitionEquipmentId),
        equipment_name: selectedEq?.name || 'Unknown Equipment',
        delay_seconds: newTransitionDelay ? parseInt(newTransitionDelay) : null,
        duration_seconds: newTransitionDuration ? parseInt(newTransitionDuration) : null,
        transitions
      };
    }
    if (!action) return;

    if (editingActionIdx !== null) {
      setFormActions(formActions.map((a, i) => i === editingActionIdx ? action : a));
    } else {
      setFormActions([...formActions, action]);
    }
    resetActionForm();
  };

  const editAction = (idx) => {
    const action = formActions[idx];
    setEditingActionIdx(idx);
    setNewActionType(action.type || 'alert');
    if (action.type === 'control') {
      setNewControlEquipmentId(String(action.equipment_id || ''));
      setNewControlAction(action.action || 'on');
      setNewControlValue(action.value != null ? String(action.value) : '');
      setNewControlChannel(action.channel != null ? String(action.channel) : '');
      setNewControlChannelName(action.channel_name || '');
      setNewControlDelay(action.delay_seconds ? String(action.delay_seconds) : '');
      setNewControlDuration(action.duration_seconds ? String(action.duration_seconds) : '');
      setNewControlStaggerDelay(action.stagger_delay_seconds ? String(action.stagger_delay_seconds) : '');
    } else if (action.type === 'alert') {
      setNewActionMessage(action.message || '');
      setNewActionSeverity(action.severity || 'info');
    } else if (action.type === 'log') {
      setNewActionMessage(action.message || '');
    } else if (action.type === 'transition') {
      setNewTransitionEquipmentId(String(action.equipment_id || ''));
      setNewTransitionDelay(action.delay_seconds ? String(action.delay_seconds) : '');
      setNewTransitionDuration(action.duration_seconds ? String(action.duration_seconds) : '');
      const states = {};
      (action.transitions || []).forEach(t => { states[t.channel] = t.state; });
      setNewTransitionStates(states);
    }
  };

  const removeAction = (idx) => {
    setFormActions(formActions.filter((_, i) => i !== idx));
    if (editingActionIdx === idx) resetActionForm();
  };

  const handleSave = async () => {
    if (!formName.trim()) return;
    if (formActions.length === 0) {
      setError('At least one action is required');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const isNew = editingTemplate.id === 'new';
      const url = isNew ? `${API_BASE}/automation-templates` : `${API_BASE}/automation-templates/${editingTemplate.id}`;
      const response = await fetch(url, {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formName,
          description: formDescription,
          category: formCategory,
          actions: formActions,
          conditions: [],
          condition_logic: 'AND'
        })
      });

      if (!response.ok) {
        let msg = 'Failed to save template';
        try { const data = await response.json(); msg = data.message || data.error || msg; } catch {}
        throw new Error(msg);
      }
      const result = await response.json();

      if (!isNew && result.propagated_to > 0) {
        setSuccessMsg(`Template saved. Updated ${result.propagated_to} linked automation(s).`);
      } else {
        setSuccessMsg(isNew ? 'Template created.' : 'Template saved.');
      }

      await fetchTemplates();
      if (onTemplateUpdated) onTemplateUpdated();
      resetForm();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (templateId) => {
    try {
      const response = await fetch(`${API_BASE}/automation-templates/${templateId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) throw new Error('Failed to delete template');
      const result = await response.json();
      setSuccessMsg(`Template deleted. ${result.unlinked_automations} automation(s) unlinked.`);
      setShowDeleteConfirm(null);
      await fetchTemplates();
      if (onTemplateUpdated) onTemplateUpdated();
    } catch (err) {
      setError(err.message);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0">
        <div className="fixed inset-0 transition-opacity bg-night/60" onClick={onClose}></div>
        <div className="inline-block w-full max-w-4xl p-4 sm:p-6 my-8 mx-4 overflow-hidden text-left align-middle transition-all transform bg-white dark:bg-gray-800 shadow-xl rounded-lg relative">
          <button onClick={onClose} className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">Manage Automation Templates</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            Templates define reusable actions. Automations linked to a template inherit its actions — edit a template to update all linked automations at once.
          </p>

          {successMsg && (
            <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-3 mb-4 text-sm text-green-800 dark:text-green-400 flex items-center">
              <svg className="h-4 w-4 mr-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              {successMsg}
            </div>
          )}

          {error && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 mb-4 text-sm text-red-800 dark:text-red-400">
              {error}
            </div>
          )}

          {/* Edit / Create Form */}
          {editingTemplate && (
            <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4 mb-4 border border-gray-200 dark:border-gray-700">
              <h4 className="text-sm font-medium text-gray-900 dark:text-white mb-3">
                {editingTemplate.id === 'new' ? 'Create New Template' : `Edit: ${editingTemplate.name}`}
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Name</label>
                  <input type="text" value={formName} onChange={(e) => setFormName(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                    placeholder="Template name" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Category</label>
                  <select value={formCategory} onChange={(e) => setFormCategory(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white">
                    {['General', 'Monitoring', 'Control', 'Safety', 'Maintenance', 'Logging', 'Manual'].map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Description</label>
                  <input type="text" value={formDescription} onChange={(e) => setFormDescription(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                    placeholder="What does this template do?" />
                </div>
              </div>

              {/* Actions list */}
              <div className="mb-3">
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Actions ({formActions.length})</label>
                {formActions.length > 0 && (
                  <div className="space-y-1 mb-2">
                    {formActions.map((action, idx) => (
                      <div key={idx} className="flex items-center justify-between bg-white dark:bg-gray-800 rounded px-3 py-1.5 text-sm border border-gray-200 dark:border-gray-600">
                        <span className="truncate">
                          <span className={`font-medium capitalize ${action.type === 'transition' ? 'text-violet-700 dark:text-violet-400' : ''}`}>
                            {action.type === 'transition' ? '⚡ atomic' : action.type}
                          </span>
                          {action.type === 'alert' && <span className="ml-1 text-gray-500">({action.severity}) {action.message}</span>}
                          {action.type === 'log' && <span className="ml-1 text-gray-500">{action.message}</span>}
                          {action.type === 'control' && (
                            <span className="ml-1 text-gray-500">
                              {action.action} {action.equipment_name || `Equipment #${action.equipment_id}`}
                              {action.channel_name ? ` → ${action.channel_name}` : action.channel ? ` → Ch ${action.channel}` : ' → All channels'}
                              {action.delay_seconds ? ` (delay ${action.delay_seconds}s)` : ''}
                              {action.duration_seconds ? ` (auto-off ${action.duration_seconds}s)` : ''}
                              {action.stagger_delay_seconds ? ` (stagger ${action.stagger_delay_seconds}s)` : ''}
                            </span>
                          )}
                          {action.type === 'transition' && (
                            <span className="ml-1 text-gray-500">
                              {action.equipment_name || `Equipment #${action.equipment_id}`}
                              {' '}
                              {(action.transitions || []).map(t => (
                                <span key={t.channel} className={`inline-block px-1 mx-0.5 rounded text-xs ${t.state ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'}`}>
                                  {t.name || `ch${t.channel}`}={t.state ? 'ON' : 'OFF'}
                                </span>
                              ))}
                              {action.delay_seconds ? ` (delay ${action.delay_seconds}s)` : ''}
                              {action.duration_seconds ? ` (auto-revert ${action.duration_seconds}s)` : ''}
                            </span>
                          )}
                          {Array.isArray(action.dependencies) && action.dependencies.length > 0 && (
                            <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400">
                              🔒 {action.dependencies.length} dep{action.dependencies.length > 1 ? 's' : ''}
                            </span>
                          )}
                        </span>
                        <div className="flex items-center gap-1 ml-2 flex-shrink-0">
                          <button onClick={() => setEditingDepsIdx(editingDepsIdx === idx ? null : idx)}
                            className={`px-2 py-0.5 text-xs rounded ${editingDepsIdx === idx ? 'bg-emerald-600 text-white' : 'text-gray-500 hover:text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20'}`}
                            title="Edit dependencies">
                            🔒
                          </button>
                          <button onClick={() => editAction(idx)} className="text-primary-500 hover:text-primary-700">
                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                          </button>
                          <button onClick={() => removeAction(idx)} className="text-red-500 hover:text-red-700">
                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    ))}
                    {editingDepsIdx !== null && formActions[editingDepsIdx] && (
                      <DependencyEditor
                        action={formActions[editingDepsIdx]}
                        equipmentList={equipment}
                        onChange={(newDeps) => {
                          setFormActions(formActions.map((a, i) => i === editingDepsIdx ? { ...a, dependencies: newDeps } : a));
                        }}
                        onClose={() => setEditingDepsIdx(null)}
                      />
                    )}
                  </div>
                )}

                {/* Add/Edit action form */}
                <div className="flex flex-wrap gap-2 items-end bg-white dark:bg-gray-800 p-3 rounded border dark:border-gray-600">
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Type</label>
                    <select value={newActionType} onChange={(e) => { setNewActionType(e.target.value); setEditingActionIdx(null); }}
                      className="px-2 py-1.5 border border-gray-300 rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white">
                      <option value="alert">Send Alert</option>
                      <option value="control">Control Equipment</option>
                      <option value="transition">Atomic Transition (FC15)</option>
                      <option value="log">Log Event</option>
                    </select>
                  </div>
                  {newActionType === 'transition' && (
                    <TransitionEditor
                      equipment={equipment}
                      equipmentId={newTransitionEquipmentId}
                      setEquipmentId={setNewTransitionEquipmentId}
                      states={newTransitionStates}
                      setStates={setNewTransitionStates}
                      delay={newTransitionDelay}
                      setDelay={setNewTransitionDelay}
                      duration={newTransitionDuration}
                      setDuration={setNewTransitionDuration}
                    />
                  )}
                  {newActionType === 'alert' && (
                    <>
                      <div>
                        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Severity</label>
                        <select value={newActionSeverity} onChange={(e) => setNewActionSeverity(e.target.value)}
                          className="px-2 py-1.5 border border-gray-300 rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white">
                          <option value="info">Info</option>
                          <option value="warning">Warning</option>
                          <option value="critical">Critical</option>
                        </select>
                      </div>
                      <div className="flex-1">
                        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Message</label>
                        <input type="text" value={newActionMessage} onChange={(e) => setNewActionMessage(e.target.value)}
                          placeholder="Alert message..." className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
                      </div>
                    </>
                  )}
                  {newActionType === 'control' && (
                    <>
                      <div>
                        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Equipment</label>
                        <select value={newControlEquipmentId}
                          onChange={(e) => { setNewControlEquipmentId(e.target.value); setNewControlChannel(''); setNewControlChannelName(''); }}
                          className="px-2 py-1.5 border border-gray-300 rounded text-sm min-w-[150px] dark:bg-gray-700 dark:border-gray-600 dark:text-white">
                          <option value="">Select equipment...</option>
                          {loadingEquipment ? <option disabled>Loading...</option> : equipment.map(eq => (
                            <option key={eq.id} value={eq.id}>{eq.name}</option>
                          ))}
                        </select>
                      </div>
                      {/* Channel selector */}
                      {(() => {
                        const selectedEq = equipment.find(eq => eq.id === parseInt(newControlEquipmentId));
                        const relayChannels = parseRegisterMappings(selectedEq)
                          .filter(m => m.type === 'coil' && m.access === 'readwrite');
                        if (relayChannels.length === 0) return null;
                        return (
                          <div>
                            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Channel</label>
                            <select value={newControlChannel}
                              onChange={(e) => {
                                const addr = e.target.value;
                                setNewControlChannel(addr);
                                if (addr) {
                                  const ch = relayChannels.find(c => String(c.register ?? c.address) === addr);
                                  setNewControlChannelName(ch ? getChannelDisplayName(ch) : `Coil ${addr}`);
                                } else {
                                  setNewControlChannelName('');
                                }
                              }}
                              className="px-2 py-1.5 border border-gray-300 rounded text-sm min-w-[120px] dark:bg-gray-700 dark:border-gray-600 dark:text-white">
                              <option value="">All channels</option>
                              {relayChannels.map(ch => {
                                const addr = ch.register ?? ch.address;
                                return <option key={addr} value={addr}>{getChannelDisplayName(ch)}</option>;
                              })}
                            </select>
                          </div>
                        );
                      })()}
                      <div>
                        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Action</label>
                        <select value={newControlAction} onChange={(e) => setNewControlAction(e.target.value)}
                          className="px-2 py-1.5 border border-gray-300 rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white">
                          <option value="on">Turn On</option>
                          <option value="off">Turn Off</option>
                          <option value="toggle">Toggle</option>
                          <option value="set">Set Value</option>
                        </select>
                      </div>
                      {newControlAction === 'set' && (
                        <div>
                          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Value</label>
                          <input type="text" value={newControlValue} onChange={(e) => setNewControlValue(e.target.value)}
                            className="w-20 px-2 py-1.5 border border-gray-300 rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" placeholder="e.g., 75" />
                        </div>
                      )}
                      <div>
                        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Delay (sec)</label>
                        <input type="number" min="0" value={newControlDelay} onChange={(e) => setNewControlDelay(e.target.value)}
                          className="w-20 px-2 py-1.5 border border-gray-300 rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" placeholder="0"
                          title="Seconds to wait before executing" />
                      </div>
                      {!newControlChannel && (
                        <div>
                          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Stagger (sec)</label>
                          <input type="number" min="0" step="0.5" value={newControlStaggerDelay} onChange={(e) => setNewControlStaggerDelay(e.target.value)}
                            className="w-20 px-2 py-1.5 border border-gray-300 rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" placeholder="0"
                            title="Seconds between each channel firing" />
                        </div>
                      )}
                      {(newControlAction === 'on' || newControlAction === 'toggle') && (
                        <div>
                          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Auto-off (sec)</label>
                          <input type="number" min="0" value={newControlDuration} onChange={(e) => setNewControlDuration(e.target.value)}
                            className="w-20 px-2 py-1.5 border border-gray-300 rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" placeholder="0"
                            title="Seconds until auto-off. 0 = stay on" />
                        </div>
                      )}
                    </>
                  )}
                  {newActionType === 'log' && (
                    <div className="flex-1">
                      <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Message</label>
                      <input type="text" value={newActionMessage} onChange={(e) => setNewActionMessage(e.target.value)}
                        placeholder="Log message..." className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
                    </div>
                  )}
                  <div className="flex gap-1">
                    <button onClick={addAction}
                      className={`min-h-[40px] px-3 py-1.5 text-white rounded text-sm flex-shrink-0 ${editingActionIdx !== null ? 'bg-green-600 hover:bg-green-700' : 'bg-primary-600 hover:bg-primary-700'}`}>
                      {editingActionIdx !== null ? 'Update' : 'Add'}
                    </button>
                    {editingActionIdx !== null && (
                      <button onClick={resetActionForm} className="min-h-[40px] px-3 py-1.5 bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded text-sm hover:bg-gray-300 dark:hover:bg-gray-600">
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <button onClick={resetForm} className="min-h-[40px] px-3 py-1.5 text-gray-600 dark:text-gray-400 bg-gray-200 dark:bg-gray-700 rounded text-sm hover:bg-gray-300 dark:hover:bg-gray-600">
                  Cancel
                </button>
                <button onClick={handleSave} disabled={saving || !formName.trim() || formActions.length === 0}
                  className="min-h-[40px] px-3 py-1.5 bg-primary-600 text-white rounded text-sm hover:bg-primary-700 disabled:opacity-50">
                  {saving ? 'Saving...' : editingTemplate.id === 'new' ? 'Create Template' : 'Save & Propagate'}
                </button>
              </div>
            </div>
          )}

          {/* Template list */}
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
            </div>
          ) : (
            <>
              {!editingTemplate && (
                <button onClick={startCreate}
                  className="mb-4 min-h-touch px-4 py-2 bg-primary-600 text-white rounded-lg text-sm hover:bg-primary-700 flex items-center">
                  <svg className="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  New Template
                </button>
              )}

              <div className="max-h-[400px] overflow-y-auto space-y-2">
                {templates.map((t) => (
                  <div key={t.id} className="flex items-center justify-between bg-gray-50 dark:bg-gray-900 rounded-lg p-3 border border-gray-200 dark:border-gray-700">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-900 dark:text-white">{t.name}</span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400">{t.category}</span>
                        {t.is_system ? <span className="text-xs text-blue-500">System</span> : null}
                      </div>
                      {t.description && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">{t.description}</p>}
                      <div className="text-xs text-gray-400 mt-1">{t.actions?.length || 0} action(s)</div>
                    </div>
                    <div className="flex items-center gap-2 ml-3">
                      <button onClick={() => startEdit(t)}
                        className="text-primary-600 hover:text-primary-800 text-sm">
                        Edit
                      </button>
                      {!t.is_system && (
                        showDeleteConfirm === t.id ? (
                          <div className="flex items-center gap-1">
                            <button onClick={() => handleDelete(t.id)} className="text-red-600 hover:text-red-800 text-xs font-medium">Confirm</button>
                            <button onClick={() => setShowDeleteConfirm(null)} className="text-gray-500 text-xs">Cancel</button>
                          </div>
                        ) : (
                          <button onClick={() => setShowDeleteConfirm(t.id)}
                            className="text-red-500 hover:text-red-700 text-sm">
                            Delete
                          </button>
                        )
                      )}
                    </div>
                  </div>
                ))}
                {templates.length === 0 && (
                  <p className="text-center text-gray-500 dark:text-gray-400 py-8 text-sm">No templates yet. Create one to get started.</p>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Template Selection Modal
export function TemplatesModal({ isOpen, onClose, token, onSelectTemplate }) {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [creating, setCreating] = useState(false);
  const [customName, setCustomName] = useState('');

  useEffect(() => {
    if (isOpen && token) {
      fetchTemplates();
    }
  }, [isOpen, token]);

  const fetchTemplates = async () => {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch(`${API_BASE}/automations/templates`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error('Failed to fetch templates');
      }

      const data = await response.json();
      setTemplates(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectTemplate = (template) => {
    setSelectedTemplate(template);
    setCustomName(template.name);
  };

  const handleCreateFromTemplate = async () => {
    if (!selectedTemplate) return;

    setCreating(true);
    try {
      const response = await fetch(`${API_BASE}/automations`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: customName || selectedTemplate.name,
          description: selectedTemplate.description,
          trigger_config: { type: 'manual' },
          template_id: selectedTemplate.id,
          priority: 0,
          enabled: false // Start disabled so user can customize trigger
        })
      });

      if (!response.ok) {
        throw new Error('Failed to create automation from template');
      }

      const newAutomation = await response.json();
      onSelectTemplate(newAutomation);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  if (!isOpen) return null;

  // Group templates by category
  const templatesByCategory = templates.reduce((acc, template) => {
    const category = template.category || 'Other';
    if (!acc[category]) acc[category] = [];
    acc[category].push(template);
    return acc;
  }, {});

  const categoryIcons = {
    Monitoring: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
      </svg>
    ),
    Scheduling: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
    Maintenance: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
    Safety: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
      </svg>
    ),
    Manual: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122" />
      </svg>
    ),
    Logging: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    ),
    Other: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
    )
  };

  const categoryColors = {
    Monitoring: 'bg-blue-100 text-blue-700 border-blue-200',
    Scheduling: 'bg-purple-100 text-purple-700 border-purple-200',
    Maintenance: 'bg-orange-100 text-orange-700 border-orange-200',
    Safety: 'bg-red-100 text-red-700 border-red-200',
    Manual: 'bg-gray-100 text-gray-700 border-gray-200',
    Logging: 'bg-green-100 text-green-700 border-green-200',
    Other: 'bg-gray-100 text-gray-700 border-gray-200'
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0">
        {/* Backdrop */}
        <div
          className="fixed inset-0 transition-opacity bg-night/60"
          onClick={onClose}
        ></div>

        {/* Modal */}
        <div className="inline-block w-full max-w-4xl p-4 sm:p-6 my-8 mx-4 overflow-hidden text-left align-middle transition-all transform bg-white dark:bg-gray-800 shadow-xl rounded-lg relative">
          {/* Close button */}
          <button
            onClick={onClose}
            className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
            Choose a Template
          </h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
            Select a template to define the actions. You'll configure the trigger (schedule, threshold, or manual) after creation.
          </p>

          {loading && (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
              <span className="ml-3 text-gray-500 dark:text-gray-400">Loading templates...</span>
            </div>
          )}

          {error && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 mb-4">
              <div className="flex items-center">
                <svg className="h-5 w-5 text-red-400 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-red-800 dark:text-red-400">{error}</span>
              </div>
            </div>
          )}

          {!loading && !error && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-h-[400px] overflow-y-auto pr-2">
              {Object.entries(templatesByCategory).map(([category, categoryTemplates]) => (
                <React.Fragment key={category}>
                  {categoryTemplates.map((template) => (
                    <div
                      key={template.id}
                      onClick={() => handleSelectTemplate(template)}
                      className={`p-4 border-2 rounded-lg cursor-pointer transition-all ${
                        selectedTemplate?.id === template.id
                          ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20 ring-2 ring-primary-200'
                          : 'border-gray-200 dark:border-gray-600 hover:border-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                      }`}
                    >
                      <div className="flex items-start">
                        <div className={`p-2 rounded-lg mr-3 ${categoryColors[category] || categoryColors.Other}`}>
                          {categoryIcons[category] || categoryIcons.Other}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between">
                            <h4 className="text-sm font-medium text-gray-900 dark:text-white truncate">
                              {template.name}
                            </h4>
                            <span className={`text-xs px-2 py-0.5 rounded-full ${categoryColors[category] || categoryColors.Other}`}>
                              {category}
                            </span>
                          </div>
                          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 line-clamp-2">
                            {template.description}
                          </p>
                          <div className="mt-2 flex items-center text-xs text-gray-400 dark:text-gray-500">
                            <span>{template.actions?.length || 0} action(s)</span>
                            {template.is_system ? (
                              <>
                                <span className="mx-2">•</span>
                                <span className="text-blue-500">System</span>
                              </>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </React.Fragment>
              ))}
            </div>
          )}

          {/* Selected Template Preview & Name Customization */}
          {selectedTemplate && (
            <div className="mt-6 pt-6 border-t border-gray-200 dark:border-gray-700">
              <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4">
                <h4 className="text-sm font-medium text-gray-900 dark:text-white mb-3">
                  Customize Your Automation
                </h4>
                <div className="mb-4">
                  <label htmlFor="template-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Automation Name
                  </label>
                  <input
                    type="text"
                    id="template-name"
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white dark:placeholder-gray-400"
                    placeholder="Enter a name for your automation"
                  />
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  <strong>Template:</strong> {selectedTemplate.name} — {selectedTemplate.description}
                </p>
              </div>
            </div>
          )}

          {/* Buttons */}
          <div className="flex justify-end gap-3 pt-6 border-t dark:border-gray-700 mt-6">
            <button
              onClick={onClose}
              className="min-h-touch px-4 py-2 text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
              disabled={creating}
            >
              Cancel
            </button>
            <button
              onClick={handleCreateFromTemplate}
              disabled={!selectedTemplate || creating}
              className="min-h-touch px-4 py-2 text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
            >
              {creating ? (
                <>
                  <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Creating...
                </>
              ) : (
                <>
                  <svg className="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  Create from Template
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

