import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

const API_BASE = '/api';

// Status badge for enabled/disabled
function EnabledBadge({ enabled }) {
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
      enabled
        ? 'bg-green-100 text-green-800 border border-green-200'
        : 'bg-gray-100 text-gray-600 border border-gray-200'
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
    schedule: 'bg-blue-100 text-blue-800 border-blue-200',
    threshold: 'bg-amber-100 text-amber-800 border-amber-200',
    event: 'bg-purple-100 text-purple-800 border-purple-200',
    manual: 'bg-gray-100 text-gray-800 border-gray-200'
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
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    enabled: true,
    priority: 0,
    trigger_config: { type: 'manual' },
    conditions: [],
    condition_logic: 'AND', // AND or OR logic for conditions
    actions: []
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);
  const [activeTab, setActiveTab] = useState('trigger');

  // Equipment list for threshold triggers
  const [equipment, setEquipment] = useState([]);
  const [loadingEquipment, setLoadingEquipment] = useState(false);

  // Condition editing
  const [conditionField, setConditionField] = useState('');
  const [conditionOperator, setConditionOperator] = useState('eq');
  const [conditionValue, setConditionValue] = useState('');

  // Action editing
  const [actionType, setActionType] = useState('alert');
  const [actionMessage, setActionMessage] = useState('');
  const [actionSeverity, setActionSeverity] = useState('info');
  const [controlEquipmentId, setControlEquipmentId] = useState('');
  const [controlAction, setControlAction] = useState('on');
  const [controlValue, setControlValue] = useState('');

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
          actions: actions
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
          actions: []
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
    setFormData(prev => ({
      ...prev,
      trigger_config: { ...prev.trigger_config, [key]: value }
    }));
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
      newAction = {
        type: 'control',
        action: controlAction,
        equipment_id: parseInt(controlEquipmentId),
        equipment_name: selectedEq?.name || 'Unknown Equipment',
        value: controlAction === 'set' ? controlValue : null
      };
    } else if (actionType === 'log') {
      newAction = {
        type: 'log',
        message: actionMessage || 'Event logged'
      };
    }

    setFormData(prev => ({
      ...prev,
      actions: [...prev.actions, newAction]
    }));

    // Reset
    setActionMessage('');
    setActionSeverity('info');
    setControlEquipmentId('');
    setControlAction('on');
    setControlValue('');
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
          actions: formData.actions
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
        <div className="inline-block w-full max-w-3xl p-6 my-8 overflow-hidden text-left align-middle transition-all transform bg-white shadow-xl rounded-lg relative">
          {/* Close button */}
          <button
            onClick={onClose}
            className="absolute top-4 right-4 text-gray-400 hover:text-gray-600"
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            {isNew ? 'Create New Automation' : `Edit: ${automation?.name || 'Automation'}`}
          </h3>

          {/* Success Message */}
          {successMessage && (
            <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg">
              <div className="flex items-center">
                <svg className="h-5 w-5 text-green-500 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <span className="text-green-800 text-sm">{successMessage}</span>
              </div>
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
              <div className="flex items-center">
                <svg className="h-5 w-5 text-red-500 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-red-800 text-sm">{error}</span>
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit}>
            {/* Basic Info Section */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
              <div>
                <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">
                  Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  id="name"
                  name="name"
                  value={formData.name}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
                  placeholder="e.g., Temperature Alert"
                  required
                />
              </div>
              <div className="flex items-center gap-4">
                <div className="flex-1">
                  <label htmlFor="priority" className="block text-sm font-medium text-gray-700 mb-1">
                    Priority
                  </label>
                  <input
                    type="number"
                    id="priority"
                    name="priority"
                    value={formData.priority}
                    onChange={handleChange}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
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
                    className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                  />
                  <label htmlFor="enabled" className="ml-2 block text-sm text-gray-700">
                    Enabled
                  </label>
                </div>
              </div>
            </div>

            <div className="mb-6">
              <label htmlFor="description" className="block text-sm font-medium text-gray-700 mb-1">
                Description
              </label>
              <textarea
                id="description"
                name="description"
                value={formData.description}
                onChange={handleChange}
                rows={2}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
                placeholder="Describe what this automation does..."
              />
            </div>

            {/* Tab Navigation */}
            <div className="border-b border-gray-200 mb-4">
              <nav className="-mb-px flex space-x-8">
                <button
                  type="button"
                  onClick={() => setActiveTab('trigger')}
                  className={`pb-3 px-1 border-b-2 font-medium text-sm ${
                    activeTab === 'trigger'
                      ? 'border-primary-500 text-primary-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
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
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
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
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  Actions ({formData.actions.length})
                </button>
              </nav>
            </div>

            {/* Tab Content */}
            <div className="min-h-[200px] bg-gray-50 rounded-lg p-4">
              {/* Trigger Tab */}
              {activeTab === 'trigger' && (
                <div className="space-y-4">
                  <h4 className="font-medium text-gray-900">Trigger Configuration</h4>
                  <p className="text-sm text-gray-500">Define when this automation should run.</p>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className={formData.trigger_config?.type === 'schedule' ? '' : ''}>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Trigger Type
                      </label>
                      <select
                        value={formData.trigger_config?.type || 'manual'}
                        onChange={handleTriggerTypeChange}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
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
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Schedule Type
                          </label>
                          <select
                            value={formData.trigger_config?.schedule_type || 'daily'}
                            onChange={(e) => handleTriggerConfigChange('schedule_type', e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
                          >
                            <option value="daily">Daily</option>
                            <option value="weekly">Weekly</option>
                            <option value="hourly">Hourly</option>
                            <option value="custom">Custom (Cron)</option>
                          </select>
                        </div>

                        {formData.trigger_config?.schedule_type === 'daily' && (
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              Time
                            </label>
                            <input
                              type="time"
                              value={formData.trigger_config?.time || '08:00'}
                              onChange={(e) => handleTriggerConfigChange('time', e.target.value)}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
                            />
                          </div>
                        )}

                        {formData.trigger_config?.schedule_type === 'weekly' && (
                          <>
                            <div>
                              <label className="block text-sm font-medium text-gray-700 mb-1">
                                Day of Week
                              </label>
                              <select
                                value={formData.trigger_config?.day_of_week || '1'}
                                onChange={(e) => handleTriggerConfigChange('day_of_week', e.target.value)}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
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
                              <label className="block text-sm font-medium text-gray-700 mb-1">
                                Time
                              </label>
                              <input
                                type="time"
                                value={formData.trigger_config?.time || '08:00'}
                                onChange={(e) => handleTriggerConfigChange('time', e.target.value)}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
                              />
                            </div>
                          </>
                        )}

                        {formData.trigger_config?.schedule_type === 'hourly' && (
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              Minutes past the hour
                            </label>
                            <input
                              type="number"
                              min="0"
                              max="59"
                              value={formData.trigger_config?.minute || '0'}
                              onChange={(e) => handleTriggerConfigChange('minute', e.target.value)}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
                              placeholder="0"
                            />
                          </div>
                        )}

                        {formData.trigger_config?.schedule_type === 'custom' && (
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              Cron Expression
                            </label>
                            <input
                              type="text"
                              value={formData.trigger_config?.cron || ''}
                              onChange={(e) => handleTriggerConfigChange('cron', e.target.value)}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
                              placeholder="0 8 * * * (daily at 8am)"
                            />
                            <p className="mt-1 text-xs text-gray-500">
                              Format: minute hour day month weekday
                            </p>
                          </div>
                        )}

                        {/* Schedule Summary */}
                        <div className="md:col-span-2 mt-2">
                          <div className="bg-blue-50 border border-blue-100 rounded-lg p-3">
                            <p className="text-sm text-blue-800">
                              <span className="font-medium">Schedule: </span>
                              {(() => {
                                const tc = formData.trigger_config;
                                const schedType = tc?.schedule_type || 'daily';
                                const time = tc?.time || '08:00';
                                const [hours, mins] = time.split(':');
                                const hour12 = parseInt(hours) % 12 || 12;
                                const ampm = parseInt(hours) >= 12 ? 'PM' : 'AM';
                                const timeStr = `${hour12}:${mins} ${ampm}`;

                                if (schedType === 'daily') {
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
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Equipment/Sensor
                          </label>
                          <select
                            value={formData.trigger_config?.equipment_id || ''}
                            onChange={(e) => handleTriggerConfigChange('equipment_id', e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
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
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Sensor Type
                          </label>
                          <select
                            value={formData.trigger_config?.sensor_type || 'temperature'}
                            onChange={(e) => handleTriggerConfigChange('sensor_type', e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
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
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Condition
                          </label>
                          <select
                            value={formData.trigger_config?.operator || 'gt'}
                            onChange={(e) => handleTriggerConfigChange('operator', e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
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
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Threshold Value
                          </label>
                          <input
                            type="number"
                            step="0.1"
                            value={formData.trigger_config?.threshold_value || ''}
                            onChange={(e) => handleTriggerConfigChange('threshold_value', e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
                            placeholder="e.g., 25"
                          />
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Unit
                          </label>
                          <input
                            type="text"
                            value={formData.trigger_config?.unit || ''}
                            onChange={(e) => handleTriggerConfigChange('unit', e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
                            placeholder="e.g., °C, %, PSI"
                          />
                        </div>

                        {/* Threshold Summary */}
                        <div className="md:col-span-2 mt-2">
                          <div className="bg-amber-50 border border-amber-100 rounded-lg p-3">
                            <p className="text-sm text-amber-800">
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
                  <h4 className="font-medium text-gray-900">Conditions</h4>
                  <p className="text-sm text-gray-500">Define conditions that must be met for actions to execute.</p>

                  {/* Condition Logic Selector */}
                  {formData.conditions.length >= 1 && (
                    <div className="bg-white p-3 rounded border">
                      <label className="block text-sm font-medium text-gray-700 mb-2">
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
                          <span className="ml-2 text-sm text-gray-700">
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
                          <span className="ml-2 text-sm text-gray-700">
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
                                  ? 'bg-blue-100 text-blue-800'
                                  : 'bg-purple-100 text-purple-800'
                              }`}>
                                {formData.condition_logic}
                              </span>
                            </div>
                          )}
                          <div className="flex items-center gap-2 bg-white p-2 rounded border">
                            <span className="text-sm font-medium">{cond.field}</span>
                            <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded">
                              {cond.operator === 'eq' ? '=' :
                               cond.operator === 'neq' ? '!=' :
                               cond.operator === 'gt' ? '>' :
                               cond.operator === 'gte' ? '>=' :
                               cond.operator === 'lt' ? '<' :
                               cond.operator === 'lte' ? '<=' : cond.operator}
                            </span>
                            <span className="text-sm">{cond.value}</span>
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
                  <div className="flex flex-wrap gap-2 items-end bg-white p-3 rounded border">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Field</label>
                      <input
                        type="text"
                        value={conditionField}
                        onChange={(e) => setConditionField(e.target.value)}
                        className="w-32 px-2 py-1 text-sm border border-gray-300 rounded"
                        placeholder="value"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Operator</label>
                      <select
                        value={conditionOperator}
                        onChange={(e) => setConditionOperator(e.target.value)}
                        className="px-2 py-1 text-sm border border-gray-300 rounded"
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
                      <label className="block text-xs text-gray-500 mb-1">Value</label>
                      <input
                        type="text"
                        value={conditionValue}
                        onChange={(e) => setConditionValue(e.target.value)}
                        className="w-24 px-2 py-1 text-sm border border-gray-300 rounded"
                        placeholder="30"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={addCondition}
                      className="px-3 py-1 text-sm bg-primary-600 text-white rounded hover:bg-primary-700"
                    >
                      Add
                    </button>
                  </div>
                </div>
              )}

              {/* Actions Tab */}
              {activeTab === 'actions' && (
                <div className="space-y-4">
                  <h4 className="font-medium text-gray-900">Actions</h4>
                  <p className="text-sm text-gray-500">Define what happens when conditions are met.</p>

                  {/* Existing Actions */}
                  {formData.actions.length > 0 && (
                    <div className="space-y-2">
                      {formData.actions.map((action, idx) => (
                        <div key={idx} className="flex items-center gap-2 bg-white p-2 rounded border">
                          <span className={`text-xs px-2 py-0.5 rounded ${
                            action.type === 'alert' ? 'bg-amber-100 text-amber-800' :
                            action.type === 'control' ? 'bg-blue-100 text-blue-800' :
                            'bg-gray-100 text-gray-800'
                          }`}>
                            {action.type}
                          </span>
                          {action.type === 'control' ? (
                            <span className="text-sm">
                              <span className="font-medium">
                                {action.action === 'on' ? 'Turn On' :
                                 action.action === 'off' ? 'Turn Off' :
                                 action.action === 'toggle' ? 'Toggle' :
                                 action.action === 'set' ? `Set to ${action.value}` : action.action}
                              </span>
                              {' → '}
                              <span className="text-gray-600">
                                {action.equipment_name || `Equipment #${action.equipment_id}` || 'Unknown'}
                              </span>
                            </span>
                          ) : (
                            <span className="text-sm">{action.message || '-'}</span>
                          )}
                          {action.severity && (
                            <span className="text-xs text-gray-500">({action.severity})</span>
                          )}
                          <button
                            type="button"
                            onClick={() => removeAction(idx)}
                            className="ml-auto text-red-500 hover:text-red-700"
                          >
                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Add Action Form */}
                  <div className="flex flex-wrap gap-2 items-end bg-white p-3 rounded border">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Type</label>
                      <select
                        value={actionType}
                        onChange={(e) => setActionType(e.target.value)}
                        className="px-2 py-1 text-sm border border-gray-300 rounded"
                      >
                        <option value="alert">Send Alert</option>
                        <option value="control">Control Equipment</option>
                        <option value="log">Log Event</option>
                      </select>
                    </div>
                    {actionType === 'alert' && (
                      <>
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">Severity</label>
                          <select
                            value={actionSeverity}
                            onChange={(e) => setActionSeverity(e.target.value)}
                            className="px-2 py-1 text-sm border border-gray-300 rounded"
                          >
                            <option value="info">Info</option>
                            <option value="warning">Warning</option>
                            <option value="critical">Critical</option>
                          </select>
                        </div>
                        <div className="flex-1">
                          <label className="block text-xs text-gray-500 mb-1">Message</label>
                          <input
                            type="text"
                            value={actionMessage}
                            onChange={(e) => setActionMessage(e.target.value)}
                            className="w-full px-2 py-1 text-sm border border-gray-300 rounded"
                            placeholder="Alert message..."
                          />
                        </div>
                      </>
                    )}
                    {actionType === 'control' && (
                      <>
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">Equipment</label>
                          <select
                            value={controlEquipmentId}
                            onChange={(e) => setControlEquipmentId(e.target.value)}
                            className="px-2 py-1 text-sm border border-gray-300 rounded min-w-[150px]"
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
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">Action</label>
                          <select
                            value={controlAction}
                            onChange={(e) => setControlAction(e.target.value)}
                            className="px-2 py-1 text-sm border border-gray-300 rounded"
                          >
                            <option value="on">Turn On</option>
                            <option value="off">Turn Off</option>
                            <option value="toggle">Toggle</option>
                            <option value="set">Set Value</option>
                          </select>
                        </div>
                        {controlAction === 'set' && (
                          <div>
                            <label className="block text-xs text-gray-500 mb-1">Value</label>
                            <input
                              type="text"
                              value={controlValue}
                              onChange={(e) => setControlValue(e.target.value)}
                              className="w-20 px-2 py-1 text-sm border border-gray-300 rounded"
                              placeholder="e.g., 75"
                            />
                          </div>
                        )}
                      </>
                    )}
                    {actionType === 'log' && (
                      <div className="flex-1">
                        <label className="block text-xs text-gray-500 mb-1">Message</label>
                        <input
                          type="text"
                          value={actionMessage}
                          onChange={(e) => setActionMessage(e.target.value)}
                          className="w-full px-2 py-1 text-sm border border-gray-300 rounded"
                          placeholder="Log message..."
                        />
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={addAction}
                      className="px-3 py-1 text-sm bg-primary-600 text-white rounded hover:bg-primary-700"
                    >
                      Add
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Buttons */}
            <div className="flex justify-end gap-3 pt-6 border-t mt-6">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
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
          </form>
        </div>
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

  if (schedType === 'daily') {
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

// Automation Detail Modal
function AutomationDetailModal({ isOpen, onClose, automation, onEdit }) {
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

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0">
        <div
          className="fixed inset-0 transition-opacity bg-gray-500 bg-opacity-75"
          onClick={onClose}
        ></div>

        <div className="inline-block w-full max-w-lg p-6 my-8 overflow-hidden text-left align-middle transition-all transform bg-white shadow-xl rounded-lg relative">
          <button
            onClick={onClose}
            className="absolute top-4 right-4 text-gray-400 hover:text-gray-600"
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          <div className="flex items-start mb-6">
            <div className="flex-shrink-0 h-12 w-12 bg-primary-100 rounded-lg flex items-center justify-center mr-4">
              <svg className="h-7 w-7 text-primary-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-lg font-semibold text-gray-900 truncate">
                {automation.name}
              </h3>
              {automation.description && (
                <p className="text-sm text-gray-500 mt-1">{automation.description}</p>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between py-3 border-b border-gray-100">
              <span className="text-sm font-medium text-gray-500">Status</span>
              <EnabledBadge enabled={automation.enabled === 1 || automation.enabled === true} />
            </div>

            <div className="flex items-center justify-between py-3 border-b border-gray-100">
              <span className="text-sm font-medium text-gray-500">Trigger</span>
              <div className="flex flex-col items-end">
                <TriggerBadge triggerConfig={triggerConfig} />
                {scheduleDesc && (
                  <span className="text-xs text-gray-500 mt-1">{scheduleDesc}</span>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between py-3 border-b border-gray-100">
              <span className="text-sm font-medium text-gray-500">Priority</span>
              <span className="text-sm text-gray-900">{automation.priority || 0}</span>
            </div>

            <div className="flex items-center justify-between py-3 border-b border-gray-100">
              <span className="text-sm font-medium text-gray-500">Run Count</span>
              <span className="text-sm text-gray-900">{automation.run_count || 0}</span>
            </div>

            <div className="flex items-center justify-between py-3 border-b border-gray-100">
              <span className="text-sm font-medium text-gray-500">Conditions</span>
              <span className="text-sm text-gray-900">{conditions.length} condition(s)</span>
            </div>

            <div className="flex items-center justify-between py-3 border-b border-gray-100">
              <span className="text-sm font-medium text-gray-500">Actions</span>
              <span className="text-sm text-gray-900">{actions.length} action(s)</span>
            </div>

            {automation.last_run && (
              <div className="flex items-center justify-between py-3 border-b border-gray-100">
                <span className="text-sm font-medium text-gray-500">Last Run</span>
                <span className="text-sm text-gray-900">
                  {new Date(automation.last_run).toLocaleString()}
                </span>
              </div>
            )}

            <div className="flex items-center justify-between py-3">
              <span className="text-sm font-medium text-gray-500">Created</span>
              <span className="text-sm text-gray-900">
                {automation.created_at ? new Date(automation.created_at).toLocaleString() : '-'}
              </span>
            </div>
          </div>

          <div className="mt-6 flex justify-end gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
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
  const [automations, setAutomations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const [showBuilderModal, setShowBuilderModal] = useState(false);
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [selectedAutomation, setSelectedAutomation] = useState(null);
  const [isNewAutomation, setIsNewAutomation] = useState(false);

  const canEdit = user?.role === 'admin' || user?.role === 'operator';

  useEffect(() => {
    fetchAutomations();
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

  const [triggerLoading, setTriggerLoading] = useState(null);
  const [triggerResult, setTriggerResult] = useState(null);

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
        <span className="ml-3 text-gray-500">Loading automations...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <div className="flex items-center">
          <svg className="h-5 w-5 text-red-400 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-red-800">{error}</span>
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
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Automations</h1>
        {canEdit && (
          <button
            onClick={handleNewAutomation}
            className="bg-primary-600 text-white px-4 py-2 rounded-lg hover:bg-primary-700 transition-colors flex items-center"
          >
            <svg className="h-5 w-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New Automation
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg shadow mb-6 p-4">
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
                className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
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
              className="block w-full py-2 px-3 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
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
      <div className="bg-white rounded-lg shadow overflow-hidden">
        {filteredAutomations.length === 0 ? (
          <div className="text-center py-12">
            <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <h3 className="mt-2 text-sm font-medium text-gray-900">No automations</h3>
            <p className="mt-1 text-sm text-gray-500">
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
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Name
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Last Run
                </th>
                <th scope="col" className="relative px-6 py-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {filteredAutomations.map((auto) => {
                const triggerConfig = typeof auto.trigger_config === 'string'
                  ? JSON.parse(auto.trigger_config || '{}')
                  : auto.trigger_config || {};

                return (
                  <tr
                    key={auto.id}
                    className="hover:bg-gray-50 transition-colors cursor-pointer"
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
                          <div className="text-sm font-medium text-gray-900">{auto.name}</div>
                          {auto.description && (
                            <div className="text-sm text-gray-500 truncate max-w-xs">{auto.description}</div>
                          )}
                          <div className="mt-1">
                            <TriggerBadge triggerConfig={triggerConfig} />
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <EnabledBadge enabled={auto.enabled === 1 || auto.enabled === true} />
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm text-gray-900">
                        {auto.last_run ? new Date(auto.last_run).toLocaleString() : 'Never'}
                      </div>
                      {auto.run_count > 0 && (
                        <div className="text-xs text-gray-500">
                          {auto.run_count} run{auto.run_count !== 1 ? 's' : ''}
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      {canEdit && (
                        <>
                          {/* Run/Trigger button for manual automations */}
                          {triggerConfig?.type === 'manual' && (auto.enabled === 1 || auto.enabled === true) && (
                            <button
                              onClick={(e) => handleTriggerAutomation(auto, e)}
                              disabled={triggerLoading === auto.id}
                              className={`mr-3 inline-flex items-center px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                                triggerLoading === auto.id
                                  ? 'bg-gray-100 text-gray-400 cursor-wait'
                                  : triggerResult?.id === auto.id && triggerResult?.success
                                  ? 'bg-green-100 text-green-800'
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
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                  </svg>
                                  Run
                                </>
                              )}
                            </button>
                          )}
                          <button
                            onClick={(e) => handleToggleEnabled(auto, e)}
                            className="text-gray-600 hover:text-gray-900 mr-3"
                          >
                            {auto.enabled ? 'Disable' : 'Enable'}
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleEditAutomation(auto);
                            }}
                            className="text-primary-600 hover:text-primary-900"
                          >
                            Edit
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
        )}
      </div>

      {/* Automation count */}
      {automations.length > 0 && (
        <div className="mt-4 text-sm text-gray-500">
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
      />
    </div>
  );
}
