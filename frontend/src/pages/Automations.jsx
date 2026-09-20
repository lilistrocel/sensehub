import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { getChannelDisplayName } from '../utils/channelUtils';
import { useSettings } from '../context/SettingsContext';
import { useToast } from '../context/ToastContext';

const API_BASE = '/api';

/**
 * Parse an equipment row's register_mappings (JSON string or array) into an
 * array. Used during render, where a toast cannot be raised; a malformed value
 * is logged once per call and treated as "no mappings".
 */
const parseRegisterMappings = (eq) => {
  if (!eq || !eq.register_mappings) return [];
  try {
    const m = typeof eq.register_mappings === 'string' ? JSON.parse(eq.register_mappings) : eq.register_mappings;
    return Array.isArray(m) ? m : [];
  } catch (err) {
    console.warn(`Malformed register_mappings on equipment ${eq.id ?? '?'}:`, err.message);
    return [];
  }
};

// Status badge for enabled/disabled
function EnabledBadge({ enabled }) {
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
      enabled
        ? 'bg-green-100 text-green-800 border border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800'
        : 'bg-gray-100 text-gray-600 border border-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:border-gray-600'
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full mr-1.5 ${
        enabled ? 'bg-green-500' : 'bg-gray-400'
      }`}></span>
      {enabled ? 'Enabled' : 'Disabled'}
    </span>
  );
}

// Trigger type badge
function TriggerBadge({ triggerConfig }) {
  const triggerType = triggerConfig?.type || 'manual';
  const triggerStyles = {
    schedule: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800',
    threshold: 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800',
    event: 'bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/30 dark:text-purple-400 dark:border-purple-800',
    manual: 'bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:border-gray-600'
  };

  const triggerLabels = {
    schedule: 'Schedule',
    threshold: 'Threshold',
    event: 'Event',
    manual: 'Manual'
  };

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${
      triggerStyles[triggerType] || triggerStyles.manual
    }`}>
      {triggerLabels[triggerType] || triggerType}
    </span>
  );
}

// Automation Builder Modal
function AutomationBuilderModal({ isOpen, onClose, automation, token, onSave, isNew = false }) {
  const { showError } = useToast();
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    enabled: true,
    priority: 0,
    trigger_config: { type: 'manual' },
    conditions: [],
    condition_logic: 'AND', // AND or OR logic for conditions
    actions: [],
    dose_program_id: null, // optional: links to a published fertigation_dose_program
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);
  const [activeTab, setActiveTab] = useState('trigger');

  // Test/Simulation state
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [showTestResults, setShowTestResults] = useState(false);

  // Equipment list for threshold triggers
  const [equipment, setEquipment] = useState([]);
  const [loadingEquipment, setLoadingEquipment] = useState(false);

  // Published fertigation dose programs — for the optional dose_program_id selector.
  const [dosePrograms, setDosePrograms] = useState([]);

  // Condition editing
  const [conditionField, setConditionField] = useState('');
  const [conditionOperator, setConditionOperator] = useState('eq');
  const [conditionValue, setConditionValue] = useState('');

  // Action editing
  const [editingDepsForAction, setEditingDepsForAction] = useState(null); // index of action whose deps are being edited
  const [actionType, setActionType] = useState('alert');
  const [actionMessage, setActionMessage] = useState('');
  const [actionSeverity, setActionSeverity] = useState('info');
  const [controlEquipmentId, setControlEquipmentId] = useState('');
  const [controlAction, setControlAction] = useState('on');
  const [controlValue, setControlValue] = useState('');
  const [controlChannel, setControlChannel] = useState('');
  const [controlChannelName, setControlChannelName] = useState('');
  const [controlDuration, setControlDuration] = useState('');
  const [controlDelay, setControlDelay] = useState('');
  const [controlStaggerDelay, setControlStaggerDelay] = useState('');
  const [editingActionIndex, setEditingActionIndex] = useState(null);

  // Transition action state (atomic FC15 multi-coil)
  const [transitionEquipmentId, setTransitionEquipmentId] = useState('');
  const [transitionStates, setTransitionStates] = useState({}); // { channelAddress: true/false/null (skip) }
  const [transitionDelay, setTransitionDelay] = useState('');
  const [transitionDuration, setTransitionDuration] = useState('');

  useEffect(() => {
    if (isOpen) {
      if (automation && !isNew) {
        // Parse JSON fields if they're strings
        const triggerConfig = typeof automation.trigger_config === 'string'
          ? JSON.parse(automation.trigger_config || '{}')
          : automation.trigger_config || { type: 'manual' };
        const conditions = typeof automation.conditions === 'string'
          ? JSON.parse(automation.conditions || '[]')
          : automation.conditions || [];
        const actions = typeof automation.actions === 'string'
          ? JSON.parse(automation.actions || '[]')
          : automation.actions || [];

        setFormData({
          name: automation.name || '',
          description: automation.description || '',
          enabled: automation.enabled === 1 || automation.enabled === true,
          priority: automation.priority || 0,
          trigger_config: triggerConfig,
          conditions: conditions,
          condition_logic: automation.condition_logic || 'AND',
          actions: actions,
          dose_program_id: automation.dose_program_id || null,
        });
      } else {
        // Reset form for new automation
        setFormData({
          name: '',
          description: '',
          enabled: true,
          priority: 0,
          trigger_config: { type: 'manual' },
          conditions: [],
          condition_logic: 'AND',
          actions: [],
          dose_program_id: null,
        });
      }
      setActiveTab('trigger');
      setError(null);
      setSuccessMessage(null);
    }
  }, [isOpen, automation, isNew]);

  // Fetch equipment list when modal opens
  useEffect(() => {
    if (isOpen && token) {
      fetchEquipment();
      // Dose programs are tiny and rarely change — fetch alongside equipment.
      fetch(`${API_BASE}/fertigation/dose-programs?status=published`, {
        headers: { 'Authorization': `Bearer ${token}` },
      }).then(r => r.ok ? r.json() : []).then(list => {
        setDosePrograms(Array.isArray(list) ? list : []);
      }).catch((err) => showError(`Could not load dose programs: ${err.message}`));
    }
  }, [isOpen, token]);

  const fetchEquipment = async () => {
    try {
      setLoadingEquipment(true);
      const response = await fetch(`${API_BASE}/equipment`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      if (response.ok) {
        const data = await response.json();
        setEquipment(data);
      }
    } catch (err) {
      console.error('Failed to fetch equipment:', err);
    } finally {
      setLoadingEquipment(false);
    }
  };

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value
    }));
  };

  const handleTriggerTypeChange = (e) => {
    const newType = e.target.value;
    let newConfig = { type: newType };

    // Set defaults based on trigger type
    if (newType === 'schedule') {
      newConfig = {
        type: 'schedule',
        schedule_type: 'daily',
        time: '08:00'
      };
    } else if (newType === 'threshold') {
      newConfig = {
        type: 'threshold',
        equipment_id: '',
        sensor_type: 'temperature',
        operator: 'gt',
        threshold_value: '',
        unit: '°C'
      };
    }

    setFormData(prev => ({
      ...prev,
      trigger_config: newConfig
    }));
  };

  const handleTriggerConfigChange = (key, value) => {
    setFormData(prev => {
      const newConfig = { ...prev.trigger_config, [key]: value };

      // When switching to 'once' schedule type, set a sensible default date/time
      // Default to 1 hour from now, rounded to the nearest 15 minutes
      if (key === 'schedule_type' && value === 'once' && !prev.trigger_config?.run_at) {
        const now = new Date();
        now.setHours(now.getHours() + 1);
        // Round to nearest 15 minutes
        const minutes = Math.ceil(now.getMinutes() / 15) * 15;
        now.setMinutes(minutes === 60 ? 0 : minutes);
        if (minutes === 60) now.setHours(now.getHours() + 1);
        now.setSeconds(0);
        now.setMilliseconds(0);
        // Format as datetime-local value (YYYY-MM-DDTHH:MM)
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const mins = String(now.getMinutes()).padStart(2, '0');
        newConfig.run_at = `${year}-${month}-${day}T${hours}:${mins}`;
      }

      return {
        ...prev,
        trigger_config: newConfig
      };
    });
  };

  const addCondition = () => {
    if (!conditionField || !conditionValue) return;

    const newCondition = {
      field: conditionField,
      operator: conditionOperator,
      value: conditionValue
    };

    setFormData(prev => ({
      ...prev,
      conditions: [...prev.conditions, newCondition]
    }));

    // Reset inputs
    setConditionField('');
    setConditionOperator('eq');
    setConditionValue('');
  };

  const removeCondition = (index) => {
    setFormData(prev => ({
      ...prev,
      conditions: prev.conditions.filter((_, i) => i !== index)
    }));
  };

  const addAction = () => {
    let newAction;
    if (actionType === 'alert') {
      if (!actionMessage) return;
      newAction = {
        type: 'alert',
        severity: actionSeverity,
        message: actionMessage
      };
    } else if (actionType === 'control') {
      if (!controlEquipmentId) return;
      const selectedEq = equipment.find(eq => eq.id === parseInt(controlEquipmentId));
      const isAllChannels = !controlChannel;
      newAction = {
        type: 'control',
        action: controlAction,
        equipment_id: parseInt(controlEquipmentId),
        equipment_name: selectedEq?.name || 'Unknown Equipment',
        value: controlAction === 'set' ? controlValue : null,
        channel: controlChannel ? parseInt(controlChannel) : null,
        channel_name: controlChannelName || null,
        delay_seconds: controlDelay ? parseInt(controlDelay) : null,
        duration_seconds: controlDuration ? parseInt(controlDuration) : null,
        ...(isAllChannels && controlStaggerDelay ? { stagger_delay_seconds: parseFloat(controlStaggerDelay) } : {})
      };
    } else if (actionType === 'log') {
      newAction = {
        type: 'log',
        message: actionMessage || 'Event logged'
      };
    } else if (actionType === 'transition') {
      if (!transitionEquipmentId) return;
      const selectedEq = equipment.find(eq => eq.id === parseInt(transitionEquipmentId));
      const transitions = Object.entries(transitionStates)
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
      newAction = {
        type: 'transition',
        equipment_id: parseInt(transitionEquipmentId),
        equipment_name: selectedEq?.name || 'Unknown Equipment',
        delay_seconds: transitionDelay ? parseInt(transitionDelay) : null,
        duration_seconds: transitionDuration ? parseInt(transitionDuration) : null,
        transitions
      };
    }

    if (editingActionIndex !== null) {
      // Replace the action being edited
      setFormData(prev => ({
        ...prev,
        actions: prev.actions.map((a, i) => i === editingActionIndex ? newAction : a)
      }));
      setEditingActionIndex(null);
    } else {
      setFormData(prev => ({
        ...prev,
        actions: [...prev.actions, newAction]
      }));
    }

    // Reset
    setActionMessage('');
    setActionSeverity('info');
    setControlEquipmentId('');
    setControlAction('on');
    setControlValue('');
    setControlChannel('');
    setControlChannelName('');
    setControlDuration('');
    setControlDelay('');
    setControlStaggerDelay('');
    setTransitionEquipmentId('');
    setTransitionStates({});
    setTransitionDelay('');
    setTransitionDuration('');
  };

  const editAction = (index) => {
    const action = formData.actions[index];
    setEditingActionIndex(index);
    setActionType(action.type || 'alert');
    if (action.type === 'control') {
      setControlEquipmentId(String(action.equipment_id || ''));
      setControlAction(action.action || 'on');
      setControlValue(action.value != null ? String(action.value) : '');
      setControlChannel(action.channel != null ? String(action.channel) : '');
      setControlChannelName(action.channel_name || '');
      setControlDuration(action.duration_seconds ? String(action.duration_seconds) : '');
      setControlDelay(action.delay_seconds ? String(action.delay_seconds) : '');
      setControlStaggerDelay(action.stagger_delay_seconds ? String(action.stagger_delay_seconds) : '');
      setActionMessage('');
      setActionSeverity('info');
    } else if (action.type === 'alert') {
      setActionMessage(action.message || '');
      setActionSeverity(action.severity || 'info');
      setControlEquipmentId('');
    } else if (action.type === 'log') {
      setActionMessage(action.message || '');
      setControlEquipmentId('');
    } else if (action.type === 'transition') {
      setTransitionEquipmentId(String(action.equipment_id || ''));
      setTransitionDelay(action.delay_seconds ? String(action.delay_seconds) : '');
      setTransitionDuration(action.duration_seconds ? String(action.duration_seconds) : '');
      const states = {};
      (action.transitions || []).forEach(t => { states[t.channel] = t.state; });
      setTransitionStates(states);
    }
  };

  const cancelEditAction = () => {
    setEditingActionIndex(null);
    setActionMessage('');
    setActionSeverity('info');
    setControlEquipmentId('');
    setControlAction('on');
    setControlValue('');
    setControlChannel('');
    setControlChannelName('');
    setControlDuration('');
    setControlDelay('');
    setControlStaggerDelay('');
    setTransitionEquipmentId('');
    setTransitionStates({});
    setTransitionDelay('');
    setTransitionDuration('');
  };

  const removeAction = (index) => {
    setFormData(prev => ({
      ...prev,
      actions: prev.actions.filter((_, i) => i !== index)
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSuccessMessage(null);

    if (!formData.name.trim()) {
      setError('Name is required');
      return;
    }

    setSaving(true);

    try {
      const url = isNew
        ? `${API_BASE}/automations`
        : `${API_BASE}/automations/${automation.id}`;

      const method = isNew ? 'POST' : 'PUT';

      const response = await fetch(url, {
        method,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: formData.name.trim(),
          description: formData.description.trim(),
          enabled: formData.enabled,
          priority: parseInt(formData.priority) || 0,
          trigger_config: formData.trigger_config,
          conditions: formData.conditions,
          condition_logic: formData.condition_logic,
          actions: formData.actions,
          dose_program_id: formData.dose_program_id || null,
        })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || `Failed to ${isNew ? 'create' : 'update'} automation`);
      }

      const savedAutomation = await response.json();
      setSuccessMessage(`Automation "${savedAutomation.name}" ${isNew ? 'created' : 'updated'} successfully!`);

      setTimeout(() => {
        onSave(savedAutomation);
        onClose();
      }, 1500);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleTestAutomation = async () => {
    if (isNew || !automation?.id) {
      setError('Please save the automation before testing');
      return;
    }

    setTesting(true);
    setTestResult(null);
    setError(null);

    try {
      const response = await fetch(`${API_BASE}/automations/${automation.id}/test`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error('Failed to test automation');
      }

      const result = await response.json();
      setTestResult(result);
      setShowTestResults(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setTesting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0">
        {/* Backdrop */}
        <div
          className="fixed inset-0 transition-opacity bg-gray-500 bg-opacity-75"
          onClick={onClose}
        ></div>

        {/* Modal */}
        <div className="inline-block w-full max-w-3xl p-4 sm:p-6 my-8 mx-4 overflow-hidden text-left align-middle transition-all transform bg-white dark:bg-gray-800 shadow-xl rounded-lg relative">
          {/* Close button */}
          <button
            onClick={onClose}
            className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            {isNew ? 'Create New Automation' : `Edit: ${automation?.name || 'Automation'}`}
          </h3>

          {/* Success Message */}
          {successMessage && (
            <div className="mb-4 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
              <div className="flex items-center">
                <svg className="h-5 w-5 text-green-500 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <span className="text-green-800 dark:text-green-400 text-sm">{successMessage}</span>
              </div>
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <div className="flex items-center">
                <svg className="h-5 w-5 text-red-500 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-red-800 dark:text-red-400 text-sm">{error}</span>
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit}>
            {/* Basic Info Section */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
              <div>
                <label htmlFor="name" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  id="name"
                  name="name"
                  value={formData.name}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white dark:placeholder-gray-400"
                  placeholder="e.g., Temperature Alert"
                  required
                />
              </div>
              <div className="flex items-center gap-4">
                <div className="flex-1">
                  <label htmlFor="priority" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Priority
                  </label>
                  <input
                    type="number"
                    id="priority"
                    name="priority"
                    value={formData.priority}
                    onChange={handleChange}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white dark:placeholder-gray-400"
                    min="0"
                  />
                </div>
                <div className="flex items-center pt-6">
                  <input
                    type="checkbox"
                    id="enabled"
                    name="enabled"
                    checked={formData.enabled}
                    onChange={handleChange}
                    className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 dark:border-gray-600 rounded"
                  />
                  <label htmlFor="enabled" className="ml-2 block text-sm text-gray-700 dark:text-gray-300">
                    Enabled
                  </label>
                </div>
              </div>
            </div>

            <div className="mb-6">
              <label htmlFor="description" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Description
              </label>
              <textarea
                id="description"
                name="description"
                value={formData.description}
                onChange={handleChange}
                rows={2}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white dark:placeholder-gray-400"
                placeholder="Describe what this automation does..."
              />
            </div>

            {/* Optional fertigation dose program — drives Waveshare Irrigation 2 injector valves
                in parallel with this automation's actions. Only relevant for irrigation/fertigation
                cycles; leave at "None" for other automation types. */}
            <div className="mb-6">
              <label htmlFor="dose_program_id" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Fertigation dose program
                <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">(optional — for irrigation/fertigation cycles)</span>
              </label>
              <select
                id="dose_program_id"
                value={formData.dose_program_id || ''}
                onChange={(e) => setFormData(prev => ({
                  ...prev,
                  dose_program_id: e.target.value ? parseInt(e.target.value) : null,
                }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              >
                <option value="">— None (no fertilizer injection) —</option>
                {dosePrograms.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.target_ec ? ` · EC ${p.target_ec}` : ''}
                    {p.compatibility_strategy === 'time_slice' ? ' · time-slice' : ''}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                When set, the FertigationDoseScheduler opens injector valves on Waveshare Irrigation 2
                according to this program's per-tank duty cycles for the duration of this automation's
                longest control action. Only published programs are listable; manage programs under
                Fertigation → Dose Programs.
              </p>
            </div>

            {/* Tab Navigation */}
            <div className="border-b border-gray-200 dark:border-gray-700 mb-4">
              <nav className="-mb-px flex space-x-8">
                <button
                  type="button"
                  onClick={() => setActiveTab('trigger')}
                  className={`pb-3 px-1 border-b-2 font-medium text-sm ${
                    activeTab === 'trigger'
                      ? 'border-primary-500 text-primary-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300'
                  }`}
                >
                  Trigger
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('conditions')}
                  className={`pb-3 px-1 border-b-2 font-medium text-sm ${
                    activeTab === 'conditions'
                      ? 'border-primary-500 text-primary-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300'
                  }`}
                >
                  Conditions ({formData.conditions.length})
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('actions')}
                  className={`pb-3 px-1 border-b-2 font-medium text-sm ${
                    activeTab === 'actions'
                      ? 'border-primary-500 text-primary-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300'
                  }`}
                >
                  Actions ({formData.actions.length})
                </button>
              </nav>
            </div>

            {/* Tab Content */}
            <div className="min-h-[200px] bg-gray-50 dark:bg-gray-900 rounded-lg p-4">
              {/* Trigger Tab */}
              {activeTab === 'trigger' && (
                <div className="space-y-4">
                  <h4 className="font-medium text-gray-900 dark:text-white">Trigger Configuration</h4>
                  <p className="text-sm text-gray-500 dark:text-gray-400">Define when this automation should run.</p>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className={formData.trigger_config?.type === 'schedule' ? '' : ''}>
                      <label htmlFor="trigger-type" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                        Trigger Type
                      </label>
                      <select
                        id="trigger-type"
                        value={formData.trigger_config?.type || 'manual'}
                        onChange={handleTriggerTypeChange}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                      >
                        <option value="manual">Manual</option>
                        <option value="schedule">Schedule (Timer)</option>
                        <option value="threshold">Sensor Threshold</option>
                        <option value="event">Equipment Event</option>
                      </select>
                    </div>

                    {formData.trigger_config?.type === 'schedule' && (
                      <>
                        <div>
                          <label htmlFor="schedule-type" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                            Schedule Type
                          </label>
                          <select
                            id="schedule-type"
                            value={formData.trigger_config?.schedule_type || 'daily'}
                            onChange={(e) => handleTriggerConfigChange('schedule_type', e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                          >
                            <option value="once">One-time</option>
                            <option value="daily">Daily</option>
                            <option value="weekly">Weekly</option>
                            <option value="hourly">Hourly</option>
                            <option value="custom">Custom (Cron)</option>
                          </select>
                        </div>

                        {formData.trigger_config?.schedule_type === 'once' && (
                          <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                              Run At (Date & Time)
                            </label>
                            <input
                              type="datetime-local"
                              value={formData.trigger_config?.run_at || ''}
                              min={new Date().toISOString().slice(0, 16)}
                              onChange={(e) => {
                                const selectedDate = new Date(e.target.value);
                                const now = new Date();
                                if (selectedDate < now) {
                                  // Don't allow past dates - show error but don't update
                                  return;
                                }
                                handleTriggerConfigChange('run_at', e.target.value);
                              }}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white dark:placeholder-gray-400"
                            />
                            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                              Select a future date and time for this automation to run once.
                            </p>
                            {formData.trigger_config?.run_at && new Date(formData.trigger_config.run_at) < new Date() && (
                              <p className="mt-1 text-xs text-red-500">
                                ⚠️ Selected date is in the past. Please select a future date.
                              </p>
                            )}
                          </div>
                        )}

                        {formData.trigger_config?.schedule_type === 'daily' && (
                          <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                              Time
                            </label>
                            <input
                              type="time"
                              value={formData.trigger_config?.time || '08:00'}
                              onChange={(e) => handleTriggerConfigChange('time', e.target.value)}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                            />
                          </div>
                        )}

                        {formData.trigger_config?.schedule_type === 'weekly' && (
                          <>
                            <div>
                              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                Day of Week
                              </label>
                              <select
                                value={formData.trigger_config?.day_of_week || '1'}
                                onChange={(e) => handleTriggerConfigChange('day_of_week', e.target.value)}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                              >
                                <option value="0">Sunday</option>
                                <option value="1">Monday</option>
                                <option value="2">Tuesday</option>
                                <option value="3">Wednesday</option>
                                <option value="4">Thursday</option>
                                <option value="5">Friday</option>
                                <option value="6">Saturday</option>
                              </select>
                            </div>
                            <div>
                              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                Time
                              </label>
                              <input
                                type="time"
                                value={formData.trigger_config?.time || '08:00'}
                                onChange={(e) => handleTriggerConfigChange('time', e.target.value)}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                              />
                            </div>
                          </>
                        )}

                        {formData.trigger_config?.schedule_type === 'hourly' && (
                          <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                              Minutes past the hour
                            </label>
                            <input
                              type="number"
                              min="0"
                              max="59"
                              value={formData.trigger_config?.minute || '0'}
                              onChange={(e) => handleTriggerConfigChange('minute', e.target.value)}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white dark:placeholder-gray-400"
                              placeholder="0"
                            />
                          </div>
                        )}

                        {formData.trigger_config?.schedule_type === 'custom' && (
                          <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                              Cron Expression
                            </label>
                            <input
                              type="text"
                              value={formData.trigger_config?.cron || ''}
                              onChange={(e) => handleTriggerConfigChange('cron', e.target.value)}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white dark:placeholder-gray-400"
                              placeholder="0 8 * * * (daily at 8am)"
                            />
                            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                              Format: minute hour day month weekday
                            </p>
                          </div>
                        )}

                        {/* Schedule Summary */}
                        <div className="md:col-span-2 mt-2">
                          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800 rounded-lg p-3">
                            <p className="text-sm text-blue-800 dark:text-blue-400">
                              <span className="font-medium">Schedule: </span>
                              {(() => {
                                const tc = formData.trigger_config;
                                const schedType = tc?.schedule_type || 'daily';
                                const time = tc?.time || '08:00';
                                const [hours, mins] = time.split(':');
                                const hour12 = parseInt(hours) % 12 || 12;
                                const ampm = parseInt(hours) >= 12 ? 'PM' : 'AM';
                                const timeStr = `${hour12}:${mins} ${ampm}`;

                                if (schedType === 'once') {
                                  if (tc?.run_at) {
                                    const runDate = new Date(tc.run_at);
                                    return `Runs once on ${runDate.toLocaleDateString()} at ${runDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
                                  }
                                  return 'Select a date and time';
                                } else if (schedType === 'daily') {
                                  return `Runs daily at ${timeStr}`;
                                } else if (schedType === 'weekly') {
                                  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
                                  const dayName = days[parseInt(tc?.day_of_week || 1)];
                                  return `Runs every ${dayName} at ${timeStr}`;
                                } else if (schedType === 'hourly') {
                                  const minute = tc?.minute || '0';
                                  return `Runs every hour at ${minute} minutes past`;
                                } else if (schedType === 'custom') {
                                  return tc?.cron ? `Custom: ${tc.cron}` : 'Enter a cron expression';
                                }
                                return 'Configure schedule above';
                              })()}
                            </p>
                          </div>
                        </div>
                      </>
                    )}

                    {formData.trigger_config?.type === 'threshold' && (
                      <>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                            Equipment/Sensor
                          </label>
                          <select
                            value={formData.trigger_config?.equipment_id || ''}
                            onChange={(e) => handleTriggerConfigChange('equipment_id', e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                          >
                            <option value="">Select equipment...</option>
                            {loadingEquipment ? (
                              <option disabled>Loading equipment...</option>
                            ) : (
                              equipment.map(eq => (
                                <option key={eq.id} value={eq.id}>
                                  {eq.name} ({eq.type || 'Unknown Type'})
                                </option>
                              ))
                            )}
                          </select>
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                            Sensor Type
                          </label>
                          <select
                            value={formData.trigger_config?.sensor_type || 'temperature'}
                            onChange={(e) => handleTriggerConfigChange('sensor_type', e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                          >
                            <option value="temperature">Temperature</option>
                            <option value="humidity">Humidity</option>
                            <option value="pressure">Pressure</option>
                            <option value="level">Level</option>
                            <option value="flow">Flow Rate</option>
                            <option value="voltage">Voltage</option>
                            <option value="current">Current</option>
                            <option value="power">Power</option>
                            <option value="custom">Custom</option>
                          </select>
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                            Condition
                          </label>
                          <select
                            value={formData.trigger_config?.operator || 'gt'}
                            onChange={(e) => handleTriggerConfigChange('operator', e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                          >
                            <option value="gt">Greater than (&gt;)</option>
                            <option value="gte">Greater than or equal (&gt;=)</option>
                            <option value="lt">Less than (&lt;)</option>
                            <option value="lte">Less than or equal (&lt;=)</option>
                            <option value="eq">Equal to (=)</option>
                            <option value="neq">Not equal to (≠)</option>
                          </select>
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                            Threshold Value
                          </label>
                          <input
                            type="number"
                            step="0.1"
                            value={formData.trigger_config?.threshold_value || ''}
                            onChange={(e) => handleTriggerConfigChange('threshold_value', e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white dark:placeholder-gray-400"
                            placeholder="e.g., 25"
                          />
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                            Unit
                          </label>
                          <input
                            type="text"
                            value={formData.trigger_config?.unit || ''}
                            onChange={(e) => handleTriggerConfigChange('unit', e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white dark:placeholder-gray-400"
                            placeholder="e.g., °C, %, PSI"
                          />
                        </div>

                        {/* Threshold Summary */}
                        <div className="md:col-span-2 mt-2">
                          <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-100 dark:border-amber-800 rounded-lg p-3">
                            <p className="text-sm text-amber-800 dark:text-amber-400">
                              <span className="font-medium">Trigger: </span>
                              {(() => {
                                const tc = formData.trigger_config;
                                const sensorType = tc?.sensor_type || 'temperature';
                                const selectedEquipment = equipment.find(eq => eq.id === parseInt(tc?.equipment_id));
                                const equipmentName = selectedEquipment?.name || 'Any equipment';
                                const sensorLabels = {
                                  temperature: 'Temperature',
                                  humidity: 'Humidity',
                                  pressure: 'Pressure',
                                  level: 'Level',
                                  flow: 'Flow Rate',
                                  voltage: 'Voltage',
                                  current: 'Current',
                                  power: 'Power',
                                  custom: 'Custom Sensor'
                                };
                                const operatorLabels = {
                                  gt: '>',
                                  gte: '≥',
                                  lt: '<',
                                  lte: '≤',
                                  eq: '=',
                                  neq: '≠'
                                };
                                const op = operatorLabels[tc?.operator || 'gt'];
                                const value = tc?.threshold_value || '?';
                                const unit = tc?.unit || '';
                                return `When ${equipmentName} ${sensorLabels[sensorType]} ${op} ${value}${unit ? ' ' + unit : ''}`;
                              })()}
                            </p>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* Conditions Tab */}
              {activeTab === 'conditions' && (
                <div className="space-y-4">
                  <h4 className="font-medium text-gray-900 dark:text-white">Conditions</h4>
                  <p className="text-sm text-gray-500 dark:text-gray-400">Define conditions that must be met for actions to execute.</p>

                  {/* Condition Logic Selector */}
                  {formData.conditions.length >= 1 && (
                    <div className="bg-white dark:bg-gray-800 p-3 rounded border dark:border-gray-600">
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                        Condition Logic
                      </label>
                      <div className="flex items-center gap-4">
                        <label className="inline-flex items-center">
                          <input
                            type="radio"
                            name="condition_logic"
                            value="AND"
                            checked={formData.condition_logic === 'AND'}
                            onChange={(e) => setFormData(prev => ({ ...prev, condition_logic: e.target.value }))}
                            className="form-radio h-4 w-4 text-primary-600"
                          />
                          <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                            <strong>AND</strong> - All conditions must be true
                          </span>
                        </label>
                        <label className="inline-flex items-center">
                          <input
                            type="radio"
                            name="condition_logic"
                            value="OR"
                            checked={formData.condition_logic === 'OR'}
                            onChange={(e) => setFormData(prev => ({ ...prev, condition_logic: e.target.value }))}
                            className="form-radio h-4 w-4 text-primary-600"
                          />
                          <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                            <strong>OR</strong> - Any condition can be true
                          </span>
                        </label>
                      </div>
                    </div>
                  )}

                  {/* Existing Conditions */}
                  {formData.conditions.length > 0 && (
                    <div className="space-y-2">
                      {formData.conditions.map((cond, idx) => (
                        <React.Fragment key={idx}>
                          {/* Show logic operator between conditions */}
                          {idx > 0 && (
                            <div className="flex justify-center">
                              <span className={`px-3 py-1 rounded-full text-xs font-bold ${
                                formData.condition_logic === 'AND'
                                  ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400'
                                  : 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400'
                              }`}>
                                {formData.condition_logic}
                              </span>
                            </div>
                          )}
                          <div className="flex items-center gap-2 bg-white dark:bg-gray-800 p-2 rounded border dark:border-gray-600">
                            <span className="text-sm font-medium dark:text-white">{cond.field}</span>
                            <span className="text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded">
                              {cond.operator === 'eq' ? '=' :
                               cond.operator === 'neq' ? '!=' :
                               cond.operator === 'gt' ? '>' :
                               cond.operator === 'gte' ? '>=' :
                               cond.operator === 'lt' ? '<' :
                               cond.operator === 'lte' ? '<=' : cond.operator}
                            </span>
                            <span className="text-sm dark:text-gray-300">{cond.value}</span>
                            <button
                              type="button"
                              onClick={() => removeCondition(idx)}
                              className="ml-auto text-red-500 hover:text-red-700"
                            >
                              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          </div>
                        </React.Fragment>
                      ))}
                    </div>
                  )}

                  {/* Add Condition Form */}
                  <div className="flex flex-wrap gap-2 items-end bg-white dark:bg-gray-800 p-3 rounded border dark:border-gray-600">
                    <div>
                      <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Field</label>
                      <input
                        type="text"
                        value={conditionField}
                        onChange={(e) => setConditionField(e.target.value)}
                        className="w-32 px-2 py-1 text-sm border border-gray-300 rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white dark:placeholder-gray-400"
                        placeholder="value"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Operator</label>
                      <select
                        value={conditionOperator}
                        onChange={(e) => setConditionOperator(e.target.value)}
                        className="px-2 py-1 text-sm border border-gray-300 rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                      >
                        <option value="eq">=</option>
                        <option value="neq">!=</option>
                        <option value="gt">&gt;</option>
                        <option value="gte">&gt;=</option>
                        <option value="lt">&lt;</option>
                        <option value="lte">&lt;=</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Value</label>
                      <input
                        type="text"
                        value={conditionValue}
                        onChange={(e) => setConditionValue(e.target.value)}
                        className="w-24 px-2 py-1 text-sm border border-gray-300 rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white dark:placeholder-gray-400"
                        placeholder="30"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={addCondition}
                      className="px-3 py-2 text-sm bg-primary-600 text-white rounded hover:bg-primary-700"
                    >
                      Add
                    </button>
                  </div>
                </div>
              )}

              {/* Actions Tab */}
              {activeTab === 'actions' && (
                <div className="space-y-4">
                  <h4 className="font-medium text-gray-900 dark:text-white">Actions</h4>
                  <p className="text-sm text-gray-500 dark:text-gray-400">Define what happens when conditions are met.</p>

                  {/* Existing Actions */}
                  {formData.actions.length > 0 && (
                    <div className="space-y-2">
                      {formData.actions.map((action, idx) => (
                        <div key={idx} className="flex items-center gap-2 bg-white dark:bg-gray-800 p-2 rounded border dark:border-gray-600">
                          <span className={`text-xs px-2 py-0.5 rounded ${
                            action.type === 'alert' ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400' :
                            action.type === 'control' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400' :
                            action.type === 'transition' ? 'bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-400' :
                            'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
                          }`}>
                            {action.type === 'transition' ? '⚡ atomic' : action.type}
                          </span>
                          {action.type === 'transition' ? (
                            <span className="text-sm flex items-center gap-1 flex-wrap dark:text-gray-300">
                              <span className="text-gray-600 dark:text-gray-400">{action.equipment_name || `Equipment #${action.equipment_id}`}</span>
                              <span className="font-mono text-xs">
                                {(action.transitions || []).map(t => (
                                  <span key={t.channel} className={`inline-block px-1 mx-0.5 rounded ${t.state ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'}`}>
                                    {t.name || `ch${t.channel}`}={t.state ? 'ON' : 'OFF'}
                                  </span>
                                ))}
                              </span>
                              {action.delay_seconds > 0 && (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400">
                                  {action.delay_seconds}s delay
                                </span>
                              )}
                              {action.duration_seconds > 0 && (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
                                  {action.duration_seconds}s auto-revert
                                </span>
                              )}
                              {Array.isArray(action.dependencies) && action.dependencies.length > 0 && (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400">
                                  🔒 {action.dependencies.length} dep{action.dependencies.length > 1 ? 's' : ''}
                                </span>
                              )}
                            </span>
                          ) : action.type === 'control' ? (
                            <span className="text-sm flex items-center gap-1 flex-wrap dark:text-gray-300">
                              <span className="font-medium dark:text-white">
                                {action.action === 'on' ? 'Turn On' :
                                 action.action === 'off' ? 'Turn Off' :
                                 action.action === 'toggle' ? 'Toggle' :
                                 action.action === 'set' ? `Set to ${action.value}` : action.action}
                              </span>
                              {' → '}
                              <span className="text-gray-600 dark:text-gray-400">
                                {action.equipment_name || `Equipment #${action.equipment_id}` || 'Unknown'}
                              </span>
                              {action.channel_name ? (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">
                                  {action.channel_name}
                                </span>
                              ) : action.type === 'control' && action.channel == null && (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300">
                                  All channels
                                </span>
                              )}
                              {action.stagger_delay_seconds > 0 && (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-400">
                                  {action.stagger_delay_seconds}s stagger
                                </span>
                              )}
                              {action.delay_seconds > 0 && (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400">
                                  {action.delay_seconds}s delay
                                </span>
                              )}
                              {action.duration_seconds > 0 && (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
                                  {action.duration_seconds}s auto-off
                                </span>
                              )}
                              {Array.isArray(action.dependencies) && action.dependencies.length > 0 && (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400"
                                  title={action.dependencies.map(d => `${d.type}: ${d.metric || d.nutrient || ''} ${d.operator} ${d.value}`).join('\n')}>
                                  🔒 {action.dependencies.length} dep{action.dependencies.length > 1 ? 's' : ''}
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="text-sm dark:text-gray-300">{action.message || '-'}</span>
                          )}
                          {action.severity && (
                            <span className="text-xs text-gray-500 dark:text-gray-400">({action.severity})</span>
                          )}
                          <div className="ml-auto flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => setEditingDepsForAction(editingDepsForAction === idx ? null : idx)}
                              className={`px-2 py-2 text-xs rounded ${editingDepsForAction === idx ? 'bg-emerald-600 text-white' : 'text-gray-500 hover:text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20'}`}
                              title="Edit dependencies"
                            >
                              🔒 Deps
                            </button>
                            <button
                              type="button"
                              onClick={() => editAction(idx)}
                              className={`p-1 rounded ${editingActionIndex === idx ? 'text-blue-600 bg-blue-100 dark:bg-blue-900/30 dark:text-blue-400' : 'text-gray-400 hover:text-blue-600 dark:hover:text-blue-400'}`}
                              title="Edit action"
                            >
                              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                              </svg>
                            </button>
                            <button
                              type="button"
                              onClick={() => removeAction(idx)}
                              className="p-1 text-red-500 hover:text-red-700"
                              title="Remove action"
                            >
                              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          </div>
                        </div>
                      ))}

                      {/* Dependency editor for selected action */}
                      {editingDepsForAction !== null && formData.actions[editingDepsForAction] && (
                        <DependencyEditor
                          action={formData.actions[editingDepsForAction]}
                          equipmentList={equipment}
                          onChange={(newDeps) => {
                            setFormData(prev => ({
                              ...prev,
                              actions: prev.actions.map((a, i) => i === editingDepsForAction ? { ...a, dependencies: newDeps } : a)
                            }));
                          }}
                          onClose={() => setEditingDepsForAction(null)}
                        />
                      )}
                    </div>
                  )}

                  {/* Add Action Form */}
                  <div className="flex flex-wrap gap-2 items-end bg-white dark:bg-gray-800 p-3 rounded border dark:border-gray-600">
                    <div>
                      <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Type</label>
                      <select
                        value={actionType}
                        onChange={(e) => setActionType(e.target.value)}
                        className="px-2 py-1 text-sm border border-gray-300 rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                      >
                        <option value="alert">Send Alert</option>
                        <option value="control">Control Equipment</option>
                        <option value="transition">Atomic Transition (FC15)</option>
                        <option value="log">Log Event</option>
                      </select>
                    </div>
                    {actionType === 'transition' && (
                      <TransitionEditor
                        equipment={equipment}
                        equipmentId={transitionEquipmentId}
                        setEquipmentId={setTransitionEquipmentId}
                        states={transitionStates}
                        setStates={setTransitionStates}
                        delay={transitionDelay}
                        setDelay={setTransitionDelay}
                        duration={transitionDuration}
                        setDuration={setTransitionDuration}
                      />
                    )}
                    {actionType === 'alert' && (
                      <>
                        <div>
                          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Severity</label>
                          <select
                            value={actionSeverity}
                            onChange={(e) => setActionSeverity(e.target.value)}
                            className="px-2 py-1 text-sm border border-gray-300 rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                          >
                            <option value="info">Info</option>
                            <option value="warning">Warning</option>
                            <option value="critical">Critical</option>
                          </select>
                        </div>
                        <div className="flex-1">
                          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Message</label>
                          <input
                            type="text"
                            value={actionMessage}
                            onChange={(e) => setActionMessage(e.target.value)}
                            className="w-full px-2 py-1 text-sm border border-gray-300 rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white dark:placeholder-gray-400"
                            placeholder="Alert message..."
                          />
                        </div>
                      </>
                    )}
                    {actionType === 'control' && (
                      <>
                        <div>
                          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Equipment</label>
                          <select
                            value={controlEquipmentId}
                            onChange={(e) => {
                              setControlEquipmentId(e.target.value);
                              setControlChannel('');
                              setControlChannelName('');
                            }}
                            className="px-2 py-1 text-sm border border-gray-300 rounded min-w-[150px] dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                          >
                            <option value="">Select equipment...</option>
                            {loadingEquipment ? (
                              <option disabled>Loading...</option>
                            ) : (
                              equipment.map(eq => (
                                <option key={eq.id} value={eq.id}>
                                  {eq.name}
                                </option>
                              ))
                            )}
                          </select>
                        </div>
                        {/* Channel selector - shown when selected equipment has coil register mappings */}
                        {(() => {
                          const selectedEq = equipment.find(eq => eq.id === parseInt(controlEquipmentId));
                          const relayChannels = parseRegisterMappings(selectedEq)
                            .filter(m => m.type === 'coil' && m.access === 'readwrite');
                          if (relayChannels.length === 0) return null;
                          return (
                            <div>
                              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Channel</label>
                              <select
                                value={controlChannel}
                                onChange={(e) => {
                                  const addr = e.target.value;
                                  setControlChannel(addr);
                                  if (addr) {
                                    const ch = relayChannels.find(c => String(c.register ?? c.address) === addr);
                                    setControlChannelName(ch ? getChannelDisplayName(ch) : `Coil ${addr}`);
                                  } else {
                                    setControlChannelName('');
                                  }
                                }}
                                className="px-2 py-1 text-sm border border-gray-300 rounded min-w-[120px] dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                              >
                                <option value="">All channels</option>
                                {relayChannels.map(ch => {
                                  const addr = ch.register ?? ch.address;
                                  return (
                                  <option key={addr} value={addr}>
                                    {getChannelDisplayName(ch)}
                                  </option>
                                  );
                                })}
                              </select>
                            </div>
                          );
                        })()}
                        <div>
                          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Action</label>
                          <select
                            value={controlAction}
                            onChange={(e) => setControlAction(e.target.value)}
                            className="px-2 py-1 text-sm border border-gray-300 rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                          >
                            <option value="on">Turn On</option>
                            <option value="off">Turn Off</option>
                            <option value="toggle">Toggle</option>
                            <option value="set">Set Value</option>
                          </select>
                        </div>
                        {controlAction === 'set' && (
                          <div>
                            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Value</label>
                            <input
                              type="text"
                              value={controlValue}
                              onChange={(e) => setControlValue(e.target.value)}
                              className="w-20 px-2 py-1 text-sm border border-gray-300 rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white dark:placeholder-gray-400"
                              placeholder="e.g., 75"
                            />
                          </div>
                        )}
                        <div>
                          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Delay (sec)</label>
                          <input
                            type="number"
                            min="0"
                            value={controlDelay}
                            onChange={(e) => setControlDelay(e.target.value)}
                            className="w-20 px-2 py-1 text-sm border border-gray-300 rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white dark:placeholder-gray-400"
                            placeholder="0"
                            title="Seconds to wait before executing. 0 or empty = immediate."
                          />
                        </div>
                        {!controlChannel && (
                          <div>
                            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Stagger (sec)</label>
                            <input
                              type="number"
                              min="0"
                              step="0.5"
                              value={controlStaggerDelay}
                              onChange={(e) => setControlStaggerDelay(e.target.value)}
                              className="w-20 px-2 py-1 text-sm border border-gray-300 rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white dark:placeholder-gray-400"
                              placeholder="0"
                              title="Seconds between each channel firing. 0 or empty = all at once."
                            />
                          </div>
                        )}
                        {(controlAction === 'on' || controlAction === 'toggle') && (
                          <div>
                            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Auto-off (sec)</label>
                            <input
                              type="number"
                              min="0"
                              value={controlDuration}
                              onChange={(e) => setControlDuration(e.target.value)}
                              className="w-20 px-2 py-1 text-sm border border-gray-300 rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white dark:placeholder-gray-400"
                              placeholder="0"
                              title="Seconds until auto-off. 0 or empty = stay on permanently."
                            />
                          </div>
                        )}
                      </>
                    )}
                    {actionType === 'log' && (
                      <div className="flex-1">
                        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Message</label>
                        <input
                          type="text"
                          value={actionMessage}
                          onChange={(e) => setActionMessage(e.target.value)}
                          className="w-full px-2 py-1 text-sm border border-gray-300 rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white dark:placeholder-gray-400"
                          placeholder="Log message..."
                        />
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={addAction}
                      className={`px-3 py-2 text-sm text-white rounded ${editingActionIndex !== null ? 'bg-green-600 hover:bg-green-700' : 'bg-primary-600 hover:bg-primary-700'}`}
                    >
                      {editingActionIndex !== null ? 'Save' : 'Add'}
                    </button>
                    {editingActionIndex !== null && (
                      <button
                        type="button"
                        onClick={cancelEditAction}
                        className="px-3 py-2 text-sm text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded hover:bg-gray-200 dark:hover:bg-gray-600"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Buttons */}
            <div className="flex justify-between gap-3 pt-6 border-t dark:border-gray-700 mt-6">
              <div>
                {/* Test Button - only show for existing automations */}
                {!isNew && automation?.id && (
                  <button
                    type="button"
                    onClick={handleTestAutomation}
                    disabled={testing || saving}
                    className="px-4 py-2 text-amber-700 bg-amber-100 border border-amber-300 rounded-lg hover:bg-amber-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                  >
                    {testing ? (
                      <>
                        <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-amber-700" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        Testing...
                      </>
                    ) : (
                      <>
                        <svg className="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                        </svg>
                        Test / Simulate
                      </>
                    )}
                  </button>
                )}
              </div>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                  disabled={saving}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                  disabled={saving}
                >
                  {saving ? (
                    <>
                      <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      Saving...
                    </>
                  ) : (
                    isNew ? 'Create Automation' : 'Save Changes'
                  )}
                </button>
              </div>
            </div>
          </form>

          {/* Test Results Modal */}
          {showTestResults && testResult && (
            <div className="fixed inset-0 z-60 overflow-y-auto">
              <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0">
                <div className="fixed inset-0 bg-gray-500 bg-opacity-75" onClick={() => setShowTestResults(false)}></div>
                <div className="inline-block w-full max-w-2xl p-4 sm:p-6 my-8 mx-4 overflow-hidden text-left align-middle transition-all transform bg-white dark:bg-gray-800 shadow-xl rounded-lg relative">
                  <button
                    onClick={() => setShowTestResults(false)}
                    className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                  >
                    <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>

                  {/* Test Results Header */}
                  <div className="flex items-center mb-4">
                    <div className={`p-3 rounded-full mr-4 ${testResult.status === 'success' ? 'bg-green-100 dark:bg-green-900/30' : 'bg-amber-100 dark:bg-amber-900/30'}`}>
                      <svg className={`h-6 w-6 ${testResult.status === 'success' ? 'text-green-600' : 'text-amber-600'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                      </svg>
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Test Results</h3>
                      <p className="text-sm text-gray-500 dark:text-gray-400">{testResult.mode}</p>
                    </div>
                  </div>

                  {/* Test Summary */}
                  <div className={`mb-4 p-4 rounded-lg ${testResult.status === 'success' ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800' : 'bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800'}`}>
                    <p className={`text-sm font-medium ${testResult.status === 'success' ? 'text-green-800 dark:text-green-400' : 'text-amber-800 dark:text-amber-400'}`}>
                      {testResult.message}
                    </p>
                  </div>

                  {/* Summary Stats */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
                    <div className="bg-gray-50 dark:bg-gray-900 p-3 rounded-lg text-center">
                      <p className="text-2xl font-bold text-gray-900 dark:text-white">{testResult.summary?.conditions_evaluated || 0}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">Conditions</p>
                    </div>
                    <div className="bg-gray-50 dark:bg-gray-900 p-3 rounded-lg text-center">
                      <p className="text-2xl font-bold text-gray-900 dark:text-white">{testResult.summary?.total_actions || 0}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">Total Actions</p>
                    </div>
                    <div className="bg-gray-50 dark:bg-gray-900 p-3 rounded-lg text-center">
                      <p className="text-2xl font-bold text-green-600">{testResult.summary?.actions_to_execute || 0}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">Would Execute</p>
                    </div>
                  </div>

                  {/* Trigger Details */}
                  {testResult.trigger && (
                    <div className="mb-4">
                      <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Trigger Evaluation</h4>
                      <div className="bg-gray-50 dark:bg-gray-900 p-3 rounded-lg text-sm dark:text-gray-300">
                        <p><span className="font-medium">Type:</span> {testResult.trigger.type}</p>
                        <p><span className="font-medium">Would Fire:</span> {testResult.trigger.would_fire ? 'Yes' : 'No'}</p>
                        {testResult.trigger.details && Object.entries(testResult.trigger.details).map(([key, value]) => (
                          <p key={key}><span className="font-medium">{key.replace(/_/g, ' ')}:</span> {String(value)}</p>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Conditions */}
                  {testResult.conditions && testResult.conditions.length > 0 && (
                    <div className="mb-4">
                      <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Conditions ({testResult.summary?.conditions_logic || 'AND'})</h4>
                      <div className="space-y-2">
                        {testResult.conditions.map((cond) => (
                          <div key={cond.index} className={`p-2 rounded text-sm ${cond.would_pass ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800' : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800'}`}>
                            <span className="font-medium">{cond.field}</span> {cond.operator} <span className="font-mono">{cond.expected_value}</span>
                            <span className={`ml-2 text-xs ${cond.would_pass ? 'text-green-600' : 'text-red-600'}`}>({cond.test_result})</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Actions */}
                  {testResult.actions && testResult.actions.length > 0 && (
                    <div className="mb-4">
                      <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Actions (Simulated)</h4>
                      <div className="space-y-2">
                        {testResult.actions.map((action) => (
                          <div key={action.index} className={`p-3 rounded text-sm ${action.would_execute ? 'bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800' : 'bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600'}`}>
                            <div className="flex items-center justify-between mb-1">
                              <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                                action.type === 'alert' ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400' :
                                action.type === 'control' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400' :
                                'bg-gray-200 text-gray-800 dark:bg-gray-600 dark:text-gray-300'
                              }`}>
                                {action.type}
                              </span>
                              <span className={`text-xs ${action.would_execute ? 'text-green-600' : 'text-gray-500'}`}>
                                {action.would_execute ? '✓ Would Execute' : '✗ Would NOT Execute'}
                              </span>
                            </div>
                            {action.details && (
                              <div className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                                {Object.entries(action.details).map(([key, value]) => (
                                  key !== 'simulation_note' && <p key={key}><span className="font-medium">{key}:</span> {String(value)}</p>
                                ))}
                                {action.details.simulation_note && (
                                  <p className="text-amber-600 italic mt-1">{action.details.simulation_note}</p>
                                )}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="flex justify-end pt-4 border-t dark:border-gray-700">
                    <button
                      onClick={() => setShowTestResults(false)}
                      className="px-4 py-2 text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition-colors"
                    >
                      Close Results
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Inline editor for atomic transition actions (FC15 - Write Multiple Coils)
function TransitionEditor({ equipment, equipmentId, setEquipmentId, states, setStates, delay, setDelay, duration, setDuration }) {
  const sensors = equipment.filter(e => {
    try {
      const m = typeof e.register_mappings === 'string' ? JSON.parse(e.register_mappings) : (e.register_mappings || []);
      return m.some(x => x.type === 'coil' && x.access === 'readwrite');
    } catch { return false; }
  });

  const selectedEq = sensors.find(eq => eq.id === parseInt(equipmentId));
  const coils = parseRegisterMappings(selectedEq)
    .filter(m => m.type === 'coil' && m.access === 'readwrite')
    .sort((a, b) => (a.register ?? a.address) - (b.register ?? b.address));

  const setCoil = (addr, val) => {
    setStates({ ...states, [addr]: val });
  };
  const clearCoil = (addr) => {
    const next = { ...states };
    delete next[addr];
    setStates(next);
  };

  return (
    <div className="w-full bg-violet-50 dark:bg-violet-900/20 border border-violet-200 dark:border-violet-800 rounded p-3 mt-2">
      <div className="mb-2">
        <h5 className="text-sm font-semibold text-violet-900 dark:text-violet-300">⚡ Atomic Transition (FC15)</h5>
        <p className="text-xs text-violet-700 dark:text-violet-400">All selected coils flip in a single Modbus frame — no timing drift between channels.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
        <div>
          <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Equipment</label>
          <select value={equipmentId} onChange={e => { setEquipmentId(e.target.value); setStates({}); }}
            className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded dark:bg-gray-700 dark:text-white">
            <option value="">Select relay equipment...</option>
            {sensors.map(eq => <option key={eq.id} value={eq.id}>{eq.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Delay (sec, optional)</label>
          <input type="number" min="0" value={delay} onChange={e => setDelay(e.target.value)}
            placeholder="0" className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded dark:bg-gray-700 dark:text-white" />
        </div>
        <div>
          <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Auto-revert OFF (sec, optional)</label>
          <input type="number" min="0" value={duration} onChange={e => setDuration(e.target.value)}
            placeholder="0" className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded dark:bg-gray-700 dark:text-white" />
        </div>
      </div>

      {coils.length > 0 && (
        <div>
          <p className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-2">Channels — pick the target state for each (skip = leave alone)</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {coils.map(c => {
              const addr = c.register ?? c.address;
              const current = states[addr];
              return (
                <div key={addr} className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded p-2">
                  <p className="text-xs font-medium text-gray-900 dark:text-white truncate" title={getChannelDisplayName(c)}>
                    {getChannelDisplayName(c)}
                  </p>
                  <p className="text-[10px] text-gray-400">addr {addr}</p>
                  <div className="flex gap-1 mt-1">
                    <button type="button" onClick={() => setCoil(addr, true)}
                      className={`flex-1 px-2 py-2 text-xs rounded ${current === true ? 'bg-green-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-green-100 dark:hover:bg-green-900/30'}`}>
                      ON
                    </button>
                    <button type="button" onClick={() => setCoil(addr, false)}
                      className={`flex-1 px-2 py-2 text-xs rounded ${current === false ? 'bg-red-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-red-100 dark:hover:bg-red-900/30'}`}>
                      OFF
                    </button>
                    <button type="button" onClick={() => clearCoil(addr)}
                      className={`flex-1 px-2 py-2 text-xs rounded ${current === undefined ? 'bg-gray-300 dark:bg-gray-600 text-gray-700 dark:text-gray-300' : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-600'}`}>
                      —
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// Inline editor for action dependencies (calibrated sensor / lab reading conditions)
function DependencyEditor({ action, equipmentList, onChange, onClose }) {
  const deps = Array.isArray(action.dependencies) ? action.dependencies : [];
  const [newDep, setNewDep] = useState({
    type: 'calibrated_sensor',
    equipment_id: '',
    metric: '',
    nutrient: 'EC',
    operator: 'lt',
    value: '',
    max_age_minutes: 30,
    zone_id: ''
  });

  const sensors = equipmentList.filter(e => e.type !== 'relay');
  const selectedEq = sensors.find(e => e.id === parseInt(newDep.equipment_id));
  const availableMetrics = parseRegisterMappings(selectedEq)
    .filter(x => x.type !== 'coil')
    .map(x => x.name);

  const addDep = () => {
    if (newDep.type === 'lab_reading') {
      if (!newDep.nutrient || newDep.value === '') return;
    } else {
      if (!newDep.equipment_id || !newDep.metric || newDep.value === '') return;
    }
    const dep = { ...newDep, value: parseFloat(newDep.value), max_age_minutes: parseInt(newDep.max_age_minutes) || null };
    if (dep.equipment_id) dep.equipment_id = parseInt(dep.equipment_id);
    if (dep.zone_id) dep.zone_id = parseInt(dep.zone_id); else delete dep.zone_id;
    onChange([...deps, dep]);
    setNewDep({ ...newDep, value: '' });
  };

  const removeDep = (i) => onChange(deps.filter((_, idx) => idx !== i));

  return (
    <div className="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded p-3 mt-2">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h5 className="text-sm font-semibold text-emerald-900 dark:text-emerald-300">Action Dependencies</h5>
          <p className="text-xs text-emerald-700 dark:text-emerald-400">Action only fires when ALL conditions pass. Use "calibrated sensor" for EC.</p>
        </div>
        <button type="button" onClick={onClose} className="text-emerald-600 hover:text-emerald-800">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Existing deps */}
      {deps.length > 0 && (
        <div className="space-y-1 mb-3">
          {deps.map((d, i) => (
            <div key={i} className="flex items-center gap-2 bg-white dark:bg-gray-800 px-2 py-1 rounded text-xs border border-emerald-200 dark:border-emerald-700">
              <span className="px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 font-medium">{d.type.replace('_', ' ')}</span>
              <span className="text-gray-700 dark:text-gray-300">
                {d.equipment_id ? sensors.find(s => s.id === d.equipment_id)?.name + ' / ' : ''}{d.metric || d.nutrient}
              </span>
              <span className="font-mono text-gray-600 dark:text-gray-400">{{gt:'>',gte:'≥',lt:'<',lte:'≤',eq:'=',neq:'≠'}[d.operator]} {d.value}</span>
              {d.max_age_minutes && <span className="text-gray-400">(≤{d.max_age_minutes}min old)</span>}
              <button type="button" onClick={() => removeDep(i)} className="ml-auto text-red-500 hover:text-red-700">
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add new dep form */}
      <div className="flex flex-wrap items-end gap-2 bg-white dark:bg-gray-800 p-2 rounded border border-emerald-200 dark:border-emerald-700">
        <div>
          <label className="block text-[10px] text-gray-500 dark:text-gray-400 mb-0.5">Source</label>
          <select value={newDep.type} onChange={e => setNewDep({ ...newDep, type: e.target.value })}
            className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded dark:bg-gray-700 dark:text-white">
            <option value="calibrated_sensor">Calibrated sensor</option>
            <option value="sensor">Raw sensor</option>
            <option value="lab_reading">Latest lab reading</option>
          </select>
        </div>
        {(newDep.type === 'sensor' || newDep.type === 'calibrated_sensor') && (
          <>
            <div>
              <label className="block text-[10px] text-gray-500 dark:text-gray-400 mb-0.5">Equipment</label>
              <select value={newDep.equipment_id} onChange={e => setNewDep({ ...newDep, equipment_id: e.target.value, metric: '' })}
                className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded dark:bg-gray-700 dark:text-white min-w-[140px]">
                <option value="">Select...</option>
                {sensors.map(eq => <option key={eq.id} value={eq.id}>{eq.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[10px] text-gray-500 dark:text-gray-400 mb-0.5">Metric</label>
              <select value={newDep.metric} onChange={e => setNewDep({ ...newDep, metric: e.target.value })}
                className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded dark:bg-gray-700 dark:text-white min-w-[140px]">
                <option value="">Select...</option>
                {availableMetrics.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </>
        )}
        {newDep.type === 'lab_reading' && (
          <div>
            <label className="block text-[10px] text-gray-500 dark:text-gray-400 mb-0.5">Nutrient</label>
            <select value={newDep.nutrient} onChange={e => setNewDep({ ...newDep, nutrient: e.target.value })}
              className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded dark:bg-gray-700 dark:text-white">
              <option value="EC">EC</option>
              <option value="pH">pH</option>
              <option value="nitrate_NO3">Nitrate</option>
              <option value="phosphate_PO4">Phosphate</option>
              <option value="potassium_K">Potassium</option>
            </select>
          </div>
        )}
        <div>
          <label className="block text-[10px] text-gray-500 dark:text-gray-400 mb-0.5">Op</label>
          <select value={newDep.operator} onChange={e => setNewDep({ ...newDep, operator: e.target.value })}
            className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded dark:bg-gray-700 dark:text-white">
            <option value="lt">&lt;</option>
            <option value="lte">≤</option>
            <option value="gt">&gt;</option>
            <option value="gte">≥</option>
            <option value="eq">=</option>
            <option value="neq">≠</option>
          </select>
        </div>
        <div>
          <label className="block text-[10px] text-gray-500 dark:text-gray-400 mb-0.5">Value</label>
          <input type="number" step="any" value={newDep.value} onChange={e => setNewDep({ ...newDep, value: e.target.value })}
            placeholder="2500" className="w-20 px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded dark:bg-gray-700 dark:text-white" />
        </div>
        <div>
          <label className="block text-[10px] text-gray-500 dark:text-gray-400 mb-0.5">Max age (min)</label>
          <input type="number" min="1" value={newDep.max_age_minutes} onChange={e => setNewDep({ ...newDep, max_age_minutes: e.target.value })}
            className="w-16 px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded dark:bg-gray-700 dark:text-white" />
        </div>
        <button type="button" onClick={addDep}
          className="px-3 py-2 text-xs bg-emerald-600 text-white rounded hover:bg-emerald-700">
          Add
        </button>
      </div>
    </div>
  );
}

// Helper to format schedule description
function getScheduleDescription(tc) {
  if (!tc || tc.type !== 'schedule') return null;

  const schedType = tc.schedule_type || 'daily';
  const time = tc.time || '08:00';
  const [hours, mins] = time.split(':');
  const hour12 = parseInt(hours) % 12 || 12;
  const ampm = parseInt(hours) >= 12 ? 'PM' : 'AM';
  const timeStr = `${hour12}:${mins} ${ampm}`;

  if (schedType === 'once') {
    if (tc.run_at) {
      const runDate = new Date(tc.run_at);
      return `Once on ${runDate.toLocaleDateString()} at ${runDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
    return 'One-time (date not set)';
  } else if (schedType === 'daily') {
    return `Daily at ${timeStr}`;
  } else if (schedType === 'weekly') {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayName = days[parseInt(tc.day_of_week || 1)];
    return `Every ${dayName} at ${timeStr}`;
  } else if (schedType === 'hourly') {
    const minute = tc.minute || '0';
    return `Every hour at ${minute} minutes past`;
  } else if (schedType === 'custom' && tc.cron) {
    return `Cron: ${tc.cron}`;
  }
  return 'Schedule configured';
}

// Template Manager Modal - CRUD for automation templates
function TemplateManagerModal({ isOpen, onClose, token, onTemplateUpdated }) {
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

      if (!response.ok) throw new Error('Failed to save template');
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
        <div className="fixed inset-0 transition-opacity bg-gray-500 bg-opacity-75" onClick={onClose}></div>
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
                      className={`px-3 py-1.5 text-white rounded text-sm flex-shrink-0 ${editingActionIdx !== null ? 'bg-green-600 hover:bg-green-700' : 'bg-primary-600 hover:bg-primary-700'}`}>
                      {editingActionIdx !== null ? 'Update' : 'Add'}
                    </button>
                    {editingActionIdx !== null && (
                      <button onClick={resetActionForm} className="px-3 py-1.5 bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded text-sm hover:bg-gray-300 dark:hover:bg-gray-600">
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <button onClick={resetForm} className="px-3 py-1.5 text-gray-600 dark:text-gray-400 bg-gray-200 dark:bg-gray-700 rounded text-sm hover:bg-gray-300 dark:hover:bg-gray-600">
                  Cancel
                </button>
                <button onClick={handleSave} disabled={saving || !formName.trim() || formActions.length === 0}
                  className="px-3 py-1.5 bg-primary-600 text-white rounded text-sm hover:bg-primary-700 disabled:opacity-50">
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
                  className="mb-4 px-4 py-2 bg-primary-600 text-white rounded-lg text-sm hover:bg-primary-700 flex items-center">
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
function TemplatesModal({ isOpen, onClose, token, onSelectTemplate }) {
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
          className="fixed inset-0 transition-opacity bg-gray-500 bg-opacity-75"
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
              className="px-4 py-2 text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
              disabled={creating}
            >
              Cancel
            </button>
            <button
              onClick={handleCreateFromTemplate}
              disabled={!selectedTemplate || creating}
              className="px-4 py-2 text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
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

// Automation Detail Modal
function AutomationDetailModal({ isOpen, onClose, automation, onEdit, token }) {
  const { formatDateTime } = useSettings();
  const [activeTab, setActiveTab] = useState('details');
  const [logs, setLogs] = useState([]);
  const [loadingLogs, setLoadingLogs] = useState(false);

  // Reset to details tab when modal opens with a new automation
  useEffect(() => {
    if (isOpen && automation) {
      setActiveTab('details');
      setLogs([]);
    }
  }, [isOpen, automation?.id]);

  // Fetch logs when switching to history tab
  useEffect(() => {
    if (isOpen && automation && activeTab === 'history') {
      fetchLogs();
    }
  }, [isOpen, automation, activeTab]);

  const fetchLogs = async () => {
    if (!automation?.id) return;
    try {
      setLoadingLogs(true);
      const response = await fetch(`${API_BASE}/automations/${automation.id}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      if (response.ok) {
        const data = await response.json();
        setLogs(data.logs || []);
      }
    } catch (err) {
      console.error('Error fetching logs:', err);
    } finally {
      setLoadingLogs(false);
    }
  };

  if (!isOpen || !automation) return null;

  // Parse JSON fields
  const triggerConfig = typeof automation.trigger_config === 'string'
    ? JSON.parse(automation.trigger_config || '{}')
    : automation.trigger_config || {};
  const conditions = typeof automation.conditions === 'string'
    ? JSON.parse(automation.conditions || '[]')
    : automation.conditions || [];
  const actions = typeof automation.actions === 'string'
    ? JSON.parse(automation.actions || '[]')
    : automation.actions || [];

  const scheduleDesc = getScheduleDescription(triggerConfig);

  // Status badge for logs
  const LogStatusBadge = ({ status }) => {
    const styles = {
      success: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800',
      error: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800',
      warning: 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800',
      pending: 'bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:border-gray-600'
    };
    return (
      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${styles[status] || styles.pending}`}>
        {status === 'success' && (
          <svg className="w-3 h-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        )}
        {status === 'error' && (
          <svg className="w-3 h-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        )}
        {status.charAt(0).toUpperCase() + status.slice(1)}
      </span>
    );
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0">
        <div
          className="fixed inset-0 transition-opacity bg-gray-500 bg-opacity-75"
          onClick={onClose}
        ></div>

        <div className="inline-block w-full max-w-2xl p-6 my-8 overflow-hidden text-left align-middle transition-all transform bg-white dark:bg-gray-800 shadow-xl rounded-lg relative">
          <button
            onClick={onClose}
            className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          <div className="flex items-start mb-4">
            <div className="flex-shrink-0 h-12 w-12 bg-primary-100 rounded-lg flex items-center justify-center mr-4">
              <svg className="h-7 w-7 text-primary-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white truncate">
                {automation.name}
              </h3>
              {automation.description && (
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{automation.description}</p>
              )}
            </div>
          </div>

          {/* Tabs */}
          <div className="border-b border-gray-200 dark:border-gray-700 mb-4">
            <nav className="-mb-px flex space-x-8">
              <button
                onClick={() => setActiveTab('details')}
                className={`py-2 px-1 border-b-2 font-medium text-sm ${
                  activeTab === 'details'
                    ? 'border-primary-500 text-primary-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300'
                }`}
              >
                Details
              </button>
              <button
                onClick={() => setActiveTab('history')}
                className={`py-2 px-1 border-b-2 font-medium text-sm flex items-center ${
                  activeTab === 'history'
                    ? 'border-primary-500 text-primary-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300'
                }`}
              >
                <svg className="w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Run History
                {automation.run_count > 0 && (
                  <span className="ml-2 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 text-xs px-2 py-0.5 rounded-full">
                    {automation.run_count}
                  </span>
                )}
              </button>
            </nav>
          </div>

          {/* Details Tab */}
          {activeTab === 'details' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-gray-700">
                <span className="text-sm font-medium text-gray-500 dark:text-gray-400">Status</span>
                <EnabledBadge enabled={automation.enabled === 1 || automation.enabled === true} />
              </div>

              <div className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-gray-700">
                <span className="text-sm font-medium text-gray-500 dark:text-gray-400">Trigger</span>
                <div className="flex flex-col items-end">
                  <TriggerBadge triggerConfig={triggerConfig} />
                  {scheduleDesc && (
                    <span className="text-xs text-gray-500 dark:text-gray-400 mt-1">{scheduleDesc}</span>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-gray-700">
                <span className="text-sm font-medium text-gray-500 dark:text-gray-400">Priority</span>
                <span className="text-sm text-gray-900 dark:text-white">{automation.priority || 0}</span>
              </div>

              <div className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-gray-700">
                <span className="text-sm font-medium text-gray-500 dark:text-gray-400">Run Count</span>
                <span className="text-sm text-gray-900 dark:text-white">{automation.run_count || 0}</span>
              </div>

              <div className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-gray-700">
                <span className="text-sm font-medium text-gray-500 dark:text-gray-400">Conditions</span>
                <span className="text-sm text-gray-900 dark:text-white">{conditions.length} condition(s)</span>
              </div>

              <div className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-gray-700">
                <span className="text-sm font-medium text-gray-500 dark:text-gray-400">Actions</span>
                <span className="text-sm text-gray-900 dark:text-white">{actions.length} action(s)</span>
              </div>

              {automation.last_run && (
                <div className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-gray-700">
                  <span className="text-sm font-medium text-gray-500 dark:text-gray-400">Last Run</span>
                  <span className="text-sm text-gray-900 dark:text-white">
                    {formatDateTime(automation.last_run)}
                  </span>
                </div>
              )}

              <div className="flex items-center justify-between py-3">
                <span className="text-sm font-medium text-gray-500 dark:text-gray-400">Created</span>
                <span className="text-sm text-gray-900 dark:text-white">
                  {automation.created_at ? formatDateTime(automation.created_at) : '-'}
                </span>
              </div>
            </div>
          )}

          {/* History Tab */}
          {activeTab === 'history' && (
            <div className="min-h-[300px]">
              {loadingLogs ? (
                <div className="flex items-center justify-center py-12">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
                </div>
              ) : logs.length === 0 ? (
                <div className="text-center py-12">
                  <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-white">No run history</h3>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    This automation hasn't been executed yet.
                  </p>
                </div>
              ) : (
                <div className="space-y-3 max-h-[400px] overflow-y-auto">
                  {logs.map((log, index) => (
                    <div
                      key={log.id || index}
                      className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4 border border-gray-200 dark:border-gray-700"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-2">
                            <LogStatusBadge status={log.status} />
                            <span className="text-xs text-gray-500 dark:text-gray-400">
                              {log.triggered_at ? formatDateTime(log.triggered_at) : '-'}
                            </span>
                          </div>
                          <p className="text-sm text-gray-700 dark:text-gray-300">{log.message || 'No message'}</p>
                          {log.completed_at && log.triggered_at && (
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                              Duration: {Math.round((new Date(log.completed_at) - new Date(log.triggered_at)) / 1000)}s
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="mt-6 flex justify-end gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
            >
              Close
            </button>
            <button
              onClick={() => {
                onClose();
                onEdit(automation);
              }}
              className="px-4 py-2 text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition-colors"
            >
              Edit Automation
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Automations() {
  const { token, user } = useAuth();
  const { formatDateTime } = useSettings();
  const { showError } = useToast();
  const [automations, setAutomations] = useState([]);
  const [doseProgramsById, setDoseProgramsById] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const [showBuilderModal, setShowBuilderModal] = useState(false);
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [showTemplatesModal, setShowTemplatesModal] = useState(false);
  const [showTemplateManager, setShowTemplateManager] = useState(false);
  const [selectedAutomation, setSelectedAutomation] = useState(null);
  const [isNewAutomation, setIsNewAutomation] = useState(false);

  const canEdit = user?.role === 'admin' || user?.role === 'operator';

  useEffect(() => {
    fetchAutomations();
    // Load dose programs once for the row badge lookup (small list, rarely changes).
    fetch(`${API_BASE}/fertigation/dose-programs`, {
      headers: { 'Authorization': `Bearer ${token}` },
    }).then(r => r.ok ? r.json() : []).then(list => {
      const m = {};
      for (const p of (Array.isArray(list) ? list : [])) m[p.id] = p;
      setDoseProgramsById(m);
    }).catch((err) => showError(`Could not load dose programs: ${err.message}`));
  }, [token]);

  const fetchAutomations = async () => {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch(`${API_BASE}/automations`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error('Failed to fetch automations');
      }

      const data = await response.json();
      setAutomations(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleEnabled = async (automation, e) => {
    e.stopPropagation();

    try {
      const response = await fetch(`${API_BASE}/automations/${automation.id}/toggle`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error('Failed to toggle automation');
      }

      // Refresh list
      await fetchAutomations();
    } catch (err) {
      console.error('Toggle error:', err);
      showError(`Could not toggle "${automation.name}": ${err.message}`);
    }
  };

  const handleNewAutomation = () => {
    setSelectedAutomation(null);
    setIsNewAutomation(true);
    setShowBuilderModal(true);
  };

  const handleEditAutomation = (automation) => {
    setSelectedAutomation(automation);
    setIsNewAutomation(false);
    setShowBuilderModal(true);
  };

  const handleViewAutomation = (automation) => {
    setSelectedAutomation(automation);
    setShowDetailModal(true);
  };

  const handleSaveAutomation = () => {
    fetchAutomations();
  };

  const handleTemplateCreated = (newAutomation) => {
    // Refresh list and open the builder to let user customize
    fetchAutomations();
    setSelectedAutomation(newAutomation);
    setIsNewAutomation(false);
    setShowBuilderModal(true);
  };

  const [triggerLoading, setTriggerLoading] = useState(null);
  const [triggerResult, setTriggerResult] = useState(null);

  // Delete confirmation state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [automationToDelete, setAutomationToDelete] = useState(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const openDeleteConfirmation = (automation, e) => {
    if (e) e.stopPropagation();
    setAutomationToDelete(automation);
    setShowDeleteConfirm(true);
  };

  const closeDeleteConfirmation = () => {
    setShowDeleteConfirm(false);
    setAutomationToDelete(null);
  };

  const handleDeleteAutomation = async () => {
    if (!automationToDelete) return;

    try {
      setDeleteLoading(true);

      const response = await fetch(`${API_BASE}/automations/${automationToDelete.id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error('Failed to delete automation');
      }

      // Refresh list
      await fetchAutomations();

      // Close modal
      closeDeleteConfirmation();
    } catch (err) {
      console.error('Delete error:', err);
    } finally {
      setDeleteLoading(false);
    }
  };

  // Duplicate state
  const [duplicateLoading, setDuplicateLoading] = useState(null);
  const [duplicateResult, setDuplicateResult] = useState(null);

  const handleDuplicateAutomation = async (automation, e) => {
    if (e) e.stopPropagation();

    try {
      setDuplicateLoading(automation.id);
      setDuplicateResult(null);

      const response = await fetch(`${API_BASE}/automations/${automation.id}/duplicate`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error('Failed to duplicate automation');
      }

      const result = await response.json();
      setDuplicateResult({ id: automation.id, success: true, message: result.message, newAutomation: result.automation });

      // Refresh list to show the new duplicated automation
      await fetchAutomations();

      // Clear success message after 3 seconds
      setTimeout(() => {
        setDuplicateResult(null);
      }, 3000);
    } catch (err) {
      console.error('Duplicate error:', err);
      setDuplicateResult({ id: automation.id, success: false, message: err.message });
    } finally {
      setDuplicateLoading(null);
    }
  };

  const handleTriggerAutomation = async (automation, e) => {
    if (e) e.stopPropagation();

    try {
      setTriggerLoading(automation.id);
      setTriggerResult(null);

      const response = await fetch(`${API_BASE}/automations/${automation.id}/trigger`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error('Failed to trigger automation');
      }

      const result = await response.json();
      setTriggerResult({ id: automation.id, success: true, message: result.message });

      // Refresh list to update run count and last_run
      await fetchAutomations();

      // Clear success message after 3 seconds
      setTimeout(() => {
        setTriggerResult(null);
      }, 3000);
    } catch (err) {
      console.error('Trigger error:', err);
      setTriggerResult({ id: automation.id, success: false, message: err.message });
    } finally {
      setTriggerLoading(null);
    }
  };

  // Filter automations
  const filteredAutomations = automations.filter(auto => {
    const matchesSearch = !searchTerm ||
      auto.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      auto.description?.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesStatus = !statusFilter ||
      (statusFilter === 'enabled' && (auto.enabled === 1 || auto.enabled === true)) ||
      (statusFilter === 'disabled' && (auto.enabled === 0 || auto.enabled === false));

    return matchesSearch && matchesStatus;
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
        <span className="ml-3 text-gray-500 dark:text-gray-400">Loading automations...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
        <div className="flex items-center">
          <svg className="h-5 w-5 text-red-400 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-red-800 dark:text-red-400">{error}</span>
        </div>
        <button
          onClick={fetchAutomations}
          className="mt-2 text-sm text-red-600 hover:text-red-800 underline"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Automations</h1>
        {canEdit && (
          <div className="flex gap-2 sm:gap-3 w-full sm:w-auto">
            <button
              onClick={() => setShowTemplateManager(true)}
              className="text-gray-600 dark:text-gray-400 border border-gray-300 dark:border-gray-600 px-3 py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors flex items-center text-sm flex-shrink-0"
              title="Manage Templates"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              <span className="hidden sm:inline ml-1">Templates</span>
            </button>
            <button
              onClick={() => setShowTemplatesModal(true)}
              className="bg-white dark:bg-gray-800 text-primary-600 border border-primary-600 px-3 sm:px-4 py-2 rounded-lg hover:bg-primary-50 dark:hover:bg-gray-700 transition-colors flex items-center text-sm sm:text-base flex-1 sm:flex-initial justify-center"
            >
              <svg className="h-5 w-5 mr-1 sm:mr-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              <span className="hidden sm:inline">New from Template</span>
              <span className="sm:hidden">Template</span>
            </button>
            <button
              onClick={handleNewAutomation}
              className="bg-primary-600 text-white px-3 sm:px-4 py-2 rounded-lg hover:bg-primary-700 transition-colors flex items-center text-sm sm:text-base flex-1 sm:flex-initial justify-center"
            >
              <svg className="h-5 w-5 mr-1 sm:mr-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              New
            </button>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow mb-6 p-4">
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
            <label htmlFor="search" className="sr-only">Search automations</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <input
                type="text"
                id="search"
                className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white dark:placeholder-gray-400"
                placeholder="Search by name or description..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
          </div>
          <div className="sm:w-48">
            <label htmlFor="status-filter" className="sr-only">Filter by status</label>
            <select
              id="status-filter"
              className="block w-full py-2 px-3 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">All Statuses</option>
              <option value="enabled">Enabled</option>
              <option value="disabled">Disabled</option>
            </select>
          </div>
        </div>
      </div>

      {/* Automations Table */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
        {filteredAutomations.length === 0 ? (
          <div className="text-center py-12">
            <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-white">No automations</h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {automations.length === 0
                ? 'Get started by creating your first automation program.'
                : 'No automations match your current filters.'}
            </p>
            {automations.length === 0 && canEdit && (
              <div className="mt-6">
                <button
                  onClick={handleNewAutomation}
                  className="bg-primary-600 text-white px-4 py-2 rounded-lg hover:bg-primary-700 transition-colors inline-flex items-center"
                >
                  <svg className="h-5 w-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  New Automation
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-900">
              <tr>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Name
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Status
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Last Run
                </th>
                <th scope="col" className="relative px-6 py-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
              {filteredAutomations.map((auto) => {
                const triggerConfig = typeof auto.trigger_config === 'string'
                  ? JSON.parse(auto.trigger_config || '{}')
                  : auto.trigger_config || {};

                return (
                  <tr
                    key={auto.id}
                    className="hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors cursor-pointer"
                    onClick={() => handleViewAutomation(auto)}
                  >
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <div className="flex-shrink-0 h-10 w-10 bg-primary-100 rounded-lg flex items-center justify-center">
                          <svg className="h-6 w-6 text-primary-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
                          </svg>
                        </div>
                        <div className="ml-4">
                          <div className="text-sm font-medium text-gray-900 dark:text-white">{auto.name}</div>
                          {auto.description && (
                            <div className="text-sm text-gray-500 dark:text-gray-400 truncate max-w-xs">{auto.description}</div>
                          )}
                          <div className="mt-1 flex items-center gap-2">
                            <TriggerBadge triggerConfig={triggerConfig} />
                            {auto.template_id && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-indigo-100 text-indigo-800 border border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-400 dark:border-indigo-800" title="Linked to a template - actions managed by template">
                                <svg className="h-3 w-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                                </svg>
                                Template
                              </span>
                            )}
                            {auto.dose_program_id && doseProgramsById[auto.dose_program_id] && (
                              <span
                                className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-800 border border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-300 dark:border-yellow-800"
                                title={`Dose program drives Waveshare Irrigation 2 injector valves while this automation runs. Strategy: ${doseProgramsById[auto.dose_program_id].compatibility_strategy || 'permissive'}`}
                              >
                                <svg className="h-3 w-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
                                </svg>
                                Dose: {doseProgramsById[auto.dose_program_id].name}
                              </span>
                            )}
                            {auto.dose_program_id && !doseProgramsById[auto.dose_program_id] && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"
                                title="Automation references a dose program that no longer exists">
                                Dose: missing (#{auto.dose_program_id})
                              </span>
                            )}
                            {canEdit && triggerConfig?.type === 'manual' && (auto.enabled === 1 || auto.enabled === true) && (
                              <button
                                onClick={(e) => handleTriggerAutomation(auto, e)}
                                disabled={triggerLoading === auto.id}
                                className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs font-medium transition-colors ${
                                  triggerLoading === auto.id
                                    ? 'bg-gray-100 text-gray-400 cursor-wait dark:bg-gray-700 dark:text-gray-500'
                                    : triggerResult?.id === auto.id && triggerResult?.success
                                    ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                                    : 'bg-green-600 text-white hover:bg-green-700'
                                }`}
                                title="Run this automation now"
                              >
                                {triggerLoading === auto.id ? (
                                  <>
                                    <svg className="animate-spin -ml-0.5 mr-1 h-3 w-3" fill="none" viewBox="0 0 24 24">
                                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                    </svg>
                                    Running...
                                  </>
                                ) : triggerResult?.id === auto.id && triggerResult?.success ? (
                                  <>
                                    <svg className="-ml-0.5 mr-1 h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                    </svg>
                                    Done
                                  </>
                                ) : (
                                  <>
                                    <svg className="-ml-0.5 mr-1 h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                                    </svg>
                                    Run
                                  </>
                                )}
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <EnabledBadge enabled={auto.enabled === 1 || auto.enabled === true} />
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm text-gray-900 dark:text-white">
                        {auto.last_run ? formatDateTime(auto.last_run) : 'Never'}
                      </div>
                      {auto.run_count > 0 && (
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {auto.run_count} run{auto.run_count !== 1 ? 's' : ''}
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      {canEdit && (
                        <>
                          <button
                            onClick={(e) => handleToggleEnabled(auto, e)}
                            className="text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white mr-3"
                          >
                            {auto.enabled ? 'Disable' : 'Enable'}
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleEditAutomation(auto);
                            }}
                            className="text-primary-600 hover:text-primary-900 mr-3"
                          >
                            Edit
                          </button>
                          <button
                            onClick={(e) => handleDuplicateAutomation(auto, e)}
                            disabled={duplicateLoading === auto.id}
                            className={`mr-3 ${
                              duplicateLoading === auto.id
                                ? 'text-gray-400 cursor-wait'
                                : duplicateResult?.id === auto.id && duplicateResult?.success
                                ? 'text-green-600'
                                : 'text-purple-600 hover:text-purple-900'
                            }`}
                            title="Duplicate this automation"
                          >
                            {duplicateLoading === auto.id ? 'Duplicating...' :
                             duplicateResult?.id === auto.id && duplicateResult?.success ? 'Duplicated!' :
                             'Duplicate'}
                          </button>
                          <button
                            onClick={(e) => openDeleteConfirmation(auto, e)}
                            className="text-red-600 hover:text-red-900"
                          >
                            Delete
                          </button>
                        </>
                      )}
                      {!canEdit && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleViewAutomation(auto);
                          }}
                          className="text-primary-600 hover:text-primary-900"
                        >
                          View
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {/* Automation count */}
      {automations.length > 0 && (
        <div className="mt-4 text-sm text-gray-500 dark:text-gray-400">
          Showing {filteredAutomations.length} of {automations.length} automation{automations.length !== 1 ? 's' : ''}
        </div>
      )}

      {/* Automation Builder Modal */}
      <AutomationBuilderModal
        isOpen={showBuilderModal}
        onClose={() => {
          setShowBuilderModal(false);
          setSelectedAutomation(null);
        }}
        automation={selectedAutomation}
        token={token}
        onSave={handleSaveAutomation}
        isNew={isNewAutomation}
      />

      {/* Automation Detail Modal */}
      <AutomationDetailModal
        isOpen={showDetailModal}
        onClose={() => {
          setShowDetailModal(false);
          setSelectedAutomation(null);
        }}
        automation={selectedAutomation}
        onEdit={handleEditAutomation}
        token={token}
      />

      {/* Templates Modal */}
      <TemplatesModal
        isOpen={showTemplatesModal}
        onClose={() => setShowTemplatesModal(false)}
        token={token}
        onSelectTemplate={handleTemplateCreated}
      />

      {/* Template Manager Modal */}
      <TemplateManagerModal
        isOpen={showTemplateManager}
        onClose={() => setShowTemplateManager(false)}
        token={token}
        onTemplateUpdated={fetchAutomations}
      />

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && automationToDelete && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0">
            {/* Backdrop */}
            <div
              className="fixed inset-0 transition-opacity bg-gray-500 bg-opacity-75"
              onClick={closeDeleteConfirmation}
            ></div>

            {/* Modal */}
            <div className="inline-block w-full max-w-md p-4 sm:p-6 my-8 mx-4 overflow-hidden text-left align-middle transition-all transform bg-white dark:bg-gray-800 shadow-xl rounded-lg relative">
              {/* Warning Icon */}
              <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-red-100 dark:bg-red-900/30 mb-4">
                <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>

              <h3 className="text-lg font-semibold text-gray-900 dark:text-white text-center mb-2">
                Delete Automation
              </h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 text-center mb-6">
                Are you sure you want to delete <span className="font-medium text-gray-900 dark:text-white">"{automationToDelete.name}"</span>? This action cannot be undone.
              </p>

              <div className="flex justify-center gap-3">
                <button
                  onClick={closeDeleteConfirmation}
                  className="px-4 py-2 text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                  disabled={deleteLoading}
                >
                  Cancel
                </button>
                <button
                  onClick={handleDeleteAutomation}
                  className="px-4 py-2 text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50 flex items-center"
                  disabled={deleteLoading}
                >
                  {deleteLoading ? (
                    <>
                      <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      Deleting...
                    </>
                  ) : (
                    'Delete'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
