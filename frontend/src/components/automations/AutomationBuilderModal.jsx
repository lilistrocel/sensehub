import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useToast } from '../../context/ToastContext';
import { Button, Label } from '../../ui';
import { getChannelDisplayName } from '../../utils/channelUtils';
import TransitionEditor from './TransitionEditor';
import DependencyEditor from './DependencyEditor';
import SequenceTimeline from './SequenceTimeline';
import { INPUT, INPUT_BARE, INPUT_SM, FIELD_LABEL, HELP, ERROR_TEXT, ICON_BUTTON, API_BASE } from './formStyles';
import {
  buildEquipmentIndex, parseAutomation, parseRegisterMappings, writableCoils, equipmentLabel, channelLabel,
  summarizeForm, findHysteresisPartners, nextScheduleRun, formatNextRun, parseCron, formatDuration,
  formatValueUnit, OP_SYM, buildSequence,
} from './automationSummary';

const emptyForm = () => ({
  name: '',
  description: '',
  enabled: true,
  priority: 0,
  trigger_config: { type: 'manual' },
  conditions: [],
  condition_logic: 'AND',
  actions: [],
  dose_program_id: null,
  skip_conditions: [],
});

function loadForm(automation) {
  const { trigger, conditions, actions, skipConditions } = parseAutomation(automation);
  return {
    name: automation.name || '',
    description: automation.description || '',
    enabled: automation.enabled === 1 || automation.enabled === true,
    priority: automation.priority || 0,
    trigger_config: trigger && trigger.type ? trigger : { type: 'manual' },
    conditions,
    condition_logic: automation.condition_logic || 'AND',
    actions,
    dose_program_id: automation.dose_program_id || null,
    skip_conditions: skipConditions,
  };
}

const CloseIcon = () => (
  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
  </svg>
);

/** Short one-line label for an action (used in Advanced → timing & gates). */
function shortActionLabel(action, equipIndex) {
  if (!action) return 'action';
  if (action.type === 'control') {
    const target = action.channel === null || action.channel === undefined || action.channel === ''
      ? 'all channels'
      : channelLabel(equipIndex, action.equipment_id, action.channel);
    return `${String(action.action || 'on').toUpperCase()} ${equipmentLabel(equipIndex, action.equipment_id)} · ${target}`;
  }
  if (action.type === 'transition') return `Atomic transition · ${equipmentLabel(equipIndex, action.equipment_id)} · ${(action.transitions || []).length} channel(s)`;
  if (action.type === 'alert') return `Alert (${action.severity || 'info'}): ${action.message || ''}`;
  if (action.type === 'log') return `Log: ${action.message || ''}`;
  return action.type;
}

// ---------------------------------------------------------------------------
// Action rows
// ---------------------------------------------------------------------------

function RemoveButton({ onClick, label }) {
  return (
    <button type="button" onClick={onClick} className={`${ICON_BUTTON} shrink-0`} aria-label={label} title={label}>
      <CloseIcon />
    </button>
  );
}

/** Seconds shown in the builder's unit: 270 -> 4.5 (min) or 270 (s). */
const toUnit = (seconds, unit) => (unit === 'min' ? Math.round((seconds / 60) * 100) / 100 : seconds);

/**
 * Number input that stores whole seconds but reads in the DO unit toggle.
 * Empty -> null. `showZero` keeps an explicit 0 visible (Start after) where
 * For hides it behind its placeholder.
 */
function SecondsField({ id, label, seconds, unit, onChange, placeholder, title, showZero = false, className = INPUT }) {
  const n = Number(seconds);
  const has = seconds !== null && seconds !== undefined && seconds !== '' && Number.isFinite(n);
  const value = has && (n > 0 || (showZero && n === 0)) ? toUnit(n, unit) : '';
  const onInput = (raw) => {
    if (raw === '') { onChange(null); return; }
    const v = parseFloat(raw);
    if (!Number.isFinite(v)) return;
    onChange(unit === 'min' ? Math.round(v * 60) : Math.round(v));
  };
  return (
    <>
      <label className={FIELD_LABEL} htmlFor={id}>{label} ({unit})</label>
      <input
        id={id}
        type="number"
        min="0"
        step={unit === 'min' ? '0.5' : '1'}
        inputMode="decimal"
        value={value}
        onChange={(e) => onInput(e.target.value)}
        className={`${className} font-mono tabular`}
        placeholder={placeholder}
        title={title}
      />
    </>
  );
}

function ControlRow({ action, index, equipment, equipIndex, durUnit, onChange, onRemove, error }) {
  const relaysFirst = useMemo(() => {
    const list = [...equipment];
    list.sort((a, b) => (a.type === 'relay' ? 0 : 1) - (b.type === 'relay' ? 0 : 1) || String(a.name).localeCompare(String(b.name)));
    return list;
  }, [equipment]);
  const coils = writableCoils(equipIndex, action.equipment_id);
  const showDuration = action.action === 'on' || action.action === 'toggle';

  return (
    <div className={`rounded-md border ${error ? 'border-alarm-300 dark:border-alarm-700' : 'border-line'} bg-panel p-3`}>
      <div className="grid grid-cols-2 sm:grid-cols-12 gap-2 items-end">
        <div className="col-span-2 sm:col-span-6">
          <label className={FIELD_LABEL} htmlFor={`act-eq-${index}`}>Equipment</label>
          <select
            id={`act-eq-${index}`}
            value={action.equipment_id ?? ''}
            onChange={(e) => {
              const id = e.target.value ? parseInt(e.target.value, 10) : null;
              onChange({ equipment_id: id, equipment_name: id ? equipmentLabel(equipIndex, id) : null, channel: null, channel_name: null });
            }}
            className={INPUT}
          >
            <option value="">Select equipment...</option>
            {relaysFirst.map(eq => <option key={eq.id} value={eq.id}>{eq.name}</option>)}
          </select>
        </div>
        <div className="col-span-2 sm:col-span-5">
          <label className={FIELD_LABEL} htmlFor={`act-ch-${index}`}>Channel</label>
          <select
            id={`act-ch-${index}`}
            value={action.channel ?? ''}
            disabled={!action.equipment_id || coils.length === 0}
            onChange={(e) => {
              const v = e.target.value;
              const ch = v === '' ? null : parseInt(v, 10);
              onChange({ channel: ch, channel_name: ch === null ? null : channelLabel(equipIndex, action.equipment_id, ch) });
            }}
            className={INPUT}
          >
            <option value="">{coils.length ? `All channels (${coils.length})` : 'No relay channels'}</option>
            {coils.map(c => <option key={c.register} value={c.register}>{c.label}</option>)}
          </select>
        </div>
        <div className="order-last sm:order-none sm:col-span-1 flex justify-end">
          <RemoveButton onClick={onRemove} label={`Remove action ${index + 1}`} />
        </div>
        <div className="sm:col-span-4">
          <label className={FIELD_LABEL} htmlFor={`act-do-${index}`}>Switch</label>
          <select id={`act-do-${index}`} value={action.action || 'on'} onChange={(e) => onChange({ action: e.target.value, value: e.target.value === 'set' ? (action.value ?? '') : null })} className={INPUT}>
            <option value="on">ON</option>
            <option value="off">OFF</option>
            <option value="toggle">Toggle</option>
            <option value="set">Set value</option>
          </select>
        </div>
        {action.action === 'set' && (
          <div className="sm:col-span-4">
            <label className={FIELD_LABEL} htmlFor={`act-val-${index}`}>Value</label>
            <input id={`act-val-${index}`} type="text" value={action.value ?? ''} onChange={(e) => onChange({ value: e.target.value })} className={INPUT} placeholder="75" />
          </div>
        )}
        <div className="sm:col-span-4">
          <SecondsField
            id={`act-delay-${index}`}
            label="Start after"
            seconds={action.delay_seconds}
            unit={durUnit}
            onChange={(v) => onChange({ delay_seconds: v })}
            placeholder="0"
            title="Time after the trigger before this action runs. Empty = immediately."
            showZero
          />
        </div>
        {showDuration && (
          <div className="sm:col-span-4">
            <SecondsField
              id={`act-dur-${index}`}
              label="For"
              seconds={action.duration_seconds}
              unit={durUnit}
              onChange={(v) => onChange({ duration_seconds: v })}
              placeholder="stays on"
              title="Leave empty to stay on until another rule switches it off"
            />
          </div>
        )}
      </div>
      {error && <p className={ERROR_TEXT}>{error}</p>}
    </div>
  );
}

function AlertRow({ action, index, onChange, onRemove, error }) {
  return (
    <div className={`rounded-md border ${error ? 'border-alarm-300 dark:border-alarm-700' : 'border-line'} bg-panel p-3`}>
      <div className="grid grid-cols-2 sm:grid-cols-12 gap-2 items-end">
        <div className="sm:col-span-3">
          <label className={FIELD_LABEL} htmlFor={`act-sev-${index}`}>Alert severity</label>
          <select id={`act-sev-${index}`} value={action.severity || 'info'} onChange={(e) => onChange({ severity: e.target.value })} className={INPUT}>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
        </div>
        <div className="col-span-2 sm:col-span-8">
          <label className={FIELD_LABEL} htmlFor={`act-msg-${index}`}>Message</label>
          <input id={`act-msg-${index}`} type="text" value={action.message || ''} onChange={(e) => onChange({ message: e.target.value })} className={INPUT} placeholder="What should the operator know?" />
        </div>
        <div className="col-span-2 sm:col-span-1 flex justify-end">
          <RemoveButton onClick={onRemove} label={`Remove action ${index + 1}`} />
        </div>
      </div>
      {error && <p className={ERROR_TEXT}>{error}</p>}
    </div>
  );
}

function LogRow({ action, index, onChange, onRemove }) {
  return (
    <div className="rounded-md border border-line bg-panel p-3">
      <div className="grid grid-cols-2 sm:grid-cols-12 gap-2 items-end">
        <div className="col-span-2 sm:col-span-11">
          <label className={FIELD_LABEL} htmlFor={`act-log-${index}`}>Log entry</label>
          <input id={`act-log-${index}`} type="text" value={action.message || ''} onChange={(e) => onChange({ message: e.target.value })} className={INPUT} placeholder="Event logged" />
        </div>
        <div className="col-span-2 sm:col-span-1 flex justify-end">
          <RemoveButton onClick={onRemove} label={`Remove action ${index + 1}`} />
        </div>
      </div>
    </div>
  );
}

function TransitionRow({ action, index, equipment, equipIndex, durUnit, onChange, onRemove, error }) {
  const [open, setOpen] = useState(!action.equipment_id);
  const states = useMemo(() => {
    const s = {};
    for (const t of action.transitions || []) s[t.channel] = t.state;
    return s;
  }, [action.transitions]);

  const setStates = (next) => {
    const eq = equipment.find(e => e.id === parseInt(action.equipment_id, 10));
    const mappings = parseRegisterMappings(eq);
    const transitions = Object.entries(next)
      .filter(([, v]) => v === true || v === false)
      .map(([ch, v]) => {
        const mapping = mappings.find(m => String(m.register ?? m.address) === ch);
        return { channel: parseInt(ch, 10), state: v, name: mapping ? getChannelDisplayName(mapping) : `Coil ${ch}` };
      });
    onChange({ transitions });
  };

  const count = (action.transitions || []).length;
  return (
    <div className={`rounded-md border ${error ? 'border-alarm-300 dark:border-alarm-700' : 'border-line'} bg-panel p-3`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-label text-muted">Atomic transition</span>
        <span className="text-sm text-ink">{action.equipment_id ? equipmentLabel(equipIndex, action.equipment_id) : 'no board selected'}</span>
        <span className="text-xs font-mono tabular text-muted">{count} channel{count === 1 ? '' : 's'}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(o => !o)} aria-expanded={open}>{open ? 'Hide channels' : 'Edit channels'}</Button>
          <RemoveButton onClick={onRemove} label={`Remove action ${index + 1}`} />
        </div>
      </div>
      <div className="mt-2 w-full sm:w-40">
        <SecondsField
          id={`act-delay-${index}`}
          label="Start after"
          seconds={action.delay_seconds}
          unit={durUnit}
          onChange={(v) => onChange({ delay_seconds: v })}
          placeholder="0"
          title="Time after the trigger before this transition runs. Empty = immediately."
          showZero
          className={INPUT_SM}
        />
      </div>
      {!open && count > 0 && (
        <p className="mt-1 text-xs font-mono tabular text-muted truncate" title={(action.transitions || []).map(t => `${t.name || `ch${t.channel}`}=${t.state ? 'ON' : 'OFF'}`).join(', ')}>
          {(action.transitions || []).map(t => `${t.name || `ch${t.channel}`}=${t.state ? 'ON' : 'OFF'}`).join(', ')}
        </p>
      )}
      {open && (
        <div className="mt-3">
          <TransitionEditor
            equipment={equipment}
            equipmentId={action.equipment_id ? String(action.equipment_id) : ''}
            setEquipmentId={(id) => onChange({ equipment_id: id ? parseInt(id, 10) : null, equipment_name: id ? equipmentLabel(equipIndex, id) : null, transitions: [] })}
            states={states}
            setStates={setStates}
            showTiming={false}
          />
        </div>
      )}
      {error && <p className={ERROR_TEXT}>{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export default function AutomationBuilderModal({
  isOpen, onClose, automation, token, onSave, isNew = false, equipment = [], automations = [],
}) {
  const { showError, showSuccess, showWarning } = useToast();
  const [formData, setFormData] = useState(emptyForm);
  const [nameDirty, setNameDirty] = useState(false);
  const [durUnit, setDurUnit] = useState('min');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState(null); // { code, message }
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [dosePrograms, setDosePrograms] = useState([]);
  const [depsForAction, setDepsForAction] = useState(null);

  // Conditions (UI / dry-run only)
  const [conditionField, setConditionField] = useState('');
  const [conditionOperator, setConditionOperator] = useState('eq');
  const [conditionValue, setConditionValue] = useState('');

  // Test / simulate
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const nameRef = useRef(null);
  const equipIndex = useMemo(() => buildEquipmentIndex(equipment), [equipment]);
  const getEquipment = useCallback((id) => equipment.find(e => Number(e.id) === Number(id)) || null, [equipment]);

  useEffect(() => {
    if (!isOpen) return;
    if (automation && !isNew) {
      const loaded = loadForm(automation);
      setFormData(loaded);
      setNameDirty(true);
      // Durations that are not whole minutes are easier to read in seconds.
      const odd = (v) => Number(v) > 0 && Number(v) % 60 !== 0;
      const oddDuration = loaded.actions.some(a => a && a.type === 'control' && (odd(a.duration_seconds) || odd(a.delay_seconds)));
      setDurUnit(oddDuration ? 's' : 'min');
    } else {
      setFormData(emptyForm());
      setNameDirty(false);
      setDurUnit('min');
    }
    setShowAdvanced(false);
    setServerError(null);
    setSubmitAttempted(false);
    setTestResult(null);
    setDepsForAction(null);
    setTimeout(() => nameRef.current?.focus(), 0);
  }, [isOpen, automation, isNew]);

  useEffect(() => {
    if (!isOpen || !token) return;
    fetch(`${API_BASE}/fertigation/dose-programs?status=published`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : []))
      .then(list => setDosePrograms(Array.isArray(list) ? list : []))
      .catch(err => showError(`Could not load dose programs: ${err.message}`));
  }, [isOpen, token]);

  // Escape closes (unless saving)
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && !saving) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, saving, onClose]);

  // Suggested name follows the rule until the user edits it.
  const summary = useMemo(() => summarizeForm(formData, equipIndex), [formData.trigger_config, formData.actions, equipIndex]);
  const sequence = useMemo(() => buildSequence(formData.actions, equipIndex), [formData.actions, equipIndex]);
  const suggestedName = formData.actions.length ? summary.text : '';
  useEffect(() => {
    // Empty suggestion also covers the first render after opening in edit
    // mode, where this effect still sees the previous (reset) state.
    if (!isOpen || nameDirty || !suggestedName) return;
    setFormData(prev => (prev.name === suggestedName ? prev : { ...prev, name: suggestedName }));
  }, [suggestedName, nameDirty, isOpen]);

  const trigger = formData.trigger_config || { type: 'manual' };
  const setTrigger = (patch) => setFormData(prev => ({ ...prev, trigger_config: { ...prev.trigger_config, ...patch } }));

  const handleTriggerTypeChange = (type) => {
    let next = { type };
    if (type === 'schedule') next = { type, schedule_type: 'daily', time: '08:00' };
    else if (type === 'threshold') next = { type, equipment_id: '', sensor_type: '', operator: 'gt', threshold_value: '', unit: '' };
    setFormData(prev => ({ ...prev, trigger_config: next }));
  };

  const onScheduleTypeChange = (value) => {
    const patch = { schedule_type: value };
    if (value === 'once' && !trigger.run_at) {
      const now = new Date();
      now.setHours(now.getHours() + 1);
      const minutes = Math.ceil(now.getMinutes() / 15) * 15;
      now.setMinutes(minutes === 60 ? 0 : minutes);
      if (minutes === 60) now.setHours(now.getHours() + 1);
      now.setSeconds(0, 0);
      const p = (n) => String(n).padStart(2, '0');
      patch.run_at = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}:${p(now.getMinutes())}`;
    }
    setTrigger(patch);
  };

  // Sensors: equipment that reports metrics (non-coil mappings), others after.
  const sensorOptions = useMemo(() => {
    const list = [...equipment];
    list.sort((a, b) => {
      const am = equipIndex.get(Number(a.id))?.metrics.length ? 0 : 1;
      const bm = equipIndex.get(Number(b.id))?.metrics.length ? 0 : 1;
      return am - bm || String(a.name).localeCompare(String(b.name));
    });
    return list;
  }, [equipment, equipIndex]);
  const triggerMetrics = equipIndex.get(parseInt(trigger.equipment_id, 10))?.metrics || [];

  const hysteresis = useMemo(() => {
    if (trigger.type !== 'threshold') return [];
    return findHysteresisPartners(
      { id: !isNew && automation ? automation.id : null, name: formData.name, trigger_config: trigger, actions: formData.actions, enabled: true },
      automations,
      getEquipment,
    );
  }, [trigger, formData.actions, formData.name, automations, getEquipment, isNew, automation]);

  const nextRun = useMemo(() => (trigger.type === 'schedule' ? nextScheduleRun(trigger) : null), [trigger]);
  const cronInvalid = trigger.type === 'schedule' && trigger.schedule_type === 'custom' && trigger.cron && !parseCron(trigger.cron);

  // ----- actions -----
  const updateAction = (i, patch) => setFormData(prev => ({ ...prev, actions: prev.actions.map((a, idx) => (idx === i ? { ...a, ...patch } : a)) }));
  const removeAction = (i) => {
    setFormData(prev => ({ ...prev, actions: prev.actions.filter((_, idx) => idx !== i) }));
    setDepsForAction(null);
  };
  const addAction = (type) => {
    let a;
    if (type === 'control') a = { type: 'control', action: 'on', equipment_id: null, equipment_name: null, value: null, channel: null, channel_name: null, delay_seconds: null, duration_seconds: null };
    else if (type === 'alert') a = { type: 'alert', severity: 'warning', message: '' };
    else if (type === 'log') a = { type: 'log', message: '' };
    else a = { type: 'transition', equipment_id: null, equipment_name: null, delay_seconds: null, duration_seconds: null, transitions: [] };
    setFormData(prev => ({ ...prev, actions: [...prev.actions, a] }));
  };

  // ----- conditions (dry-run only) -----
  const addCondition = () => {
    if (!conditionField || !conditionValue) return;
    setFormData(prev => ({ ...prev, conditions: [...prev.conditions, { field: conditionField, operator: conditionOperator, value: conditionValue }] }));
    setConditionField(''); setConditionOperator('eq'); setConditionValue('');
  };
  const removeCondition = (i) => setFormData(prev => ({ ...prev, conditions: prev.conditions.filter((_, idx) => idx !== i) }));

  // ----- validation -----
  const errors = useMemo(() => {
    const e = { list: [], actions: {} };
    if (!formData.name.trim()) { e.name = 'Name is required'; e.list.push('Give the automation a name'); }
    if (formData.actions.length === 0) { e.actionsEmpty = 'Add at least one action'; e.list.push('Add at least one action'); }
    if (trigger.type === 'threshold') {
      if (!trigger.equipment_id) { e.thresholdSensor = 'Pick the sensor'; e.list.push('Pick the sensor for the threshold'); }
      if (!String(trigger.sensor_type || '').trim()) { e.thresholdMetric = 'Pick the metric'; e.list.push('Pick the metric for the threshold'); }
      const v = trigger.threshold_value;
      if (v === '' || v === null || v === undefined || !Number.isFinite(Number(v))) { e.thresholdValue = 'Threshold must be a number'; e.list.push('Threshold must be a number'); }
    }
    if (trigger.type === 'schedule') {
      if (trigger.schedule_type === 'once') {
        if (!trigger.run_at) { e.schedule = 'Pick a date and time'; e.list.push('Pick a date and time for the one-time run'); }
        else if (new Date(trigger.run_at) <= new Date()) { e.schedule = 'That time is in the past'; e.list.push('The one-time run is in the past'); }
      }
      if (trigger.schedule_type === 'custom' && (!trigger.cron || !parseCron(trigger.cron))) { e.schedule = 'Enter a valid 5-field cron expression'; e.list.push('Enter a valid cron expression'); }
    }
    formData.actions.forEach((a, i) => {
      if (!a) return;
      if (a.type === 'control') {
        if (!a.equipment_id) e.actions[i] = 'Pick the equipment';
        else if (a.duration_seconds !== null && a.duration_seconds !== undefined && a.duration_seconds !== '' && !(Number(a.duration_seconds) > 0)) e.actions[i] = 'Duration must be greater than 0';
        else if (a.action === 'set' && (a.value === null || a.value === undefined || String(a.value).trim() === '')) e.actions[i] = 'Enter the value to set';
      } else if (a.type === 'alert') {
        if (!String(a.message || '').trim()) e.actions[i] = 'Enter the alert message';
      } else if (a.type === 'transition') {
        if (!a.equipment_id) e.actions[i] = 'Pick the relay board';
        else if (!(a.transitions || []).length) e.actions[i] = 'Pick at least one channel state';
      }
      if (e.actions[i]) e.list.push(`Action ${i + 1}: ${e.actions[i]}`);
    });
    return e;
  }, [formData, trigger]);
  const showErrors = submitAttempted;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setServerError(null);
    setSubmitAttempted(true);
    if (errors.list.length) return;

    setSaving(true);
    try {
      const url = isNew ? `${API_BASE}/automations` : `${API_BASE}/automations/${automation.id}`;
      const response = await fetch(url, {
        method: isNew ? 'POST' : 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.name.trim(),
          description: formData.description.trim(),
          enabled: formData.enabled,
          priority: parseInt(formData.priority, 10) || 0,
          trigger_config: formData.trigger_config,
          conditions: formData.conditions,
          condition_logic: formData.condition_logic,
          actions: formData.actions,
          dose_program_id: formData.dose_program_id || null,
        }),
      });
      let data = null;
      try { data = await response.json(); } catch { data = null; }
      if (!response.ok) {
        setServerError({
          code: data?.code || null,
          message: data?.message || `Failed to ${isNew ? 'create' : 'update'} automation (HTTP ${response.status})`,
        });
        return;
      }
      const capped = Array.isArray(data?.capped) ? data.capped : [];
      if (capped.length) {
        const detail = capped.map(c => `action ${c.index + 1} ${String(c.field).replace(/_seconds$/, '').replace('_', ' ')} ${formatDuration(c.requested)} → ${formatDuration(c.capped_to)}`).join('; ');
        showWarning(`Saved, but the server capped ${capped.length} value${capped.length > 1 ? 's' : ''}: ${detail}`, 'Durations capped');
      } else {
        showSuccess(`"${data?.name || formData.name}" ${isNew ? 'created' : 'saved'}`);
      }
      onSave?.(data);
      onClose();
    } catch (err) {
      setServerError({ code: null, message: err.message });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (isNew || !automation?.id) return;
    setTesting(true);
    setTestResult(null);
    setServerError(null);
    try {
      const response = await fetch(`${API_BASE}/automations/${automation.id}/test`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      if (!response.ok) throw new Error(`Test failed (HTTP ${response.status})`);
      setTestResult(await response.json());
    } catch (err) {
      setServerError({ code: null, message: err.message });
    } finally {
      setTesting(false);
    }
  };

  if (!isOpen) return null;

  const advancedHints = [];
  if (formData.conditions.length) advancedHints.push(`${formData.conditions.length} condition${formData.conditions.length > 1 ? 's' : ''}`);
  const gated = formData.actions.filter(a => Array.isArray(a?.dependencies) && a.dependencies.length).length;
  if (gated) advancedHints.push(`${gated} gated action${gated > 1 ? 's' : ''}`);
  const staggered = formData.actions.filter(a => a && a.stagger_delay_seconds > 0).length;
  if (staggered) advancedHints.push(`${staggered} staggered`);
  if (formData.dose_program_id) advancedHints.push('dose program');
  if (formData.priority) advancedHints.push(`priority ${formData.priority}`);
  if (!formData.enabled) advancedHints.push('disabled');

  const serverErrorTitle = serverError?.code === 'HYSTERESIS_CROSSED'
    ? 'Hysteresis crossed'
    : serverError?.code === 'INTERLOCK_VIOLATION'
      ? 'Interlock violation'
      : 'Could not save';

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto" role="presentation">
      <div className="fixed inset-0 bg-night/60" onClick={() => { if (!saving) onClose(); }} aria-hidden="true" />
      <div className="relative min-h-full flex items-start justify-center p-4 sm:py-8">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="automation-builder-title"
          className="relative w-full max-w-2xl bg-panel border border-line rounded-card shadow-xl text-left"
        >
          <div className="flex items-start justify-between gap-3 px-4 pt-4 sm:px-6 sm:pt-6">
            <div className="min-w-0">
              <Label>{isNew ? 'New automation' : 'Edit automation'}</Label>
              <h3 id="automation-builder-title" className="font-display text-lg font-semibold text-ink truncate">
                {isNew ? 'What should happen, and when?' : (automation?.name || 'Automation')}
              </h3>
              {!isNew && automation?.id && <p className="text-xs font-mono tabular text-muted">#{automation.id}</p>}
            </div>
            <button type="button" onClick={onClose} className={ICON_BUTTON} aria-label="Close">
              <CloseIcon />
            </button>
          </div>

          <form onSubmit={handleSubmit} noValidate className="px-4 pb-4 sm:px-6 sm:pb-6 space-y-6">
            {/* Server / validation feedback at the top of the form */}
            {serverError && (
              <div role="alert" aria-live="assertive" className="mt-4 p-3 rounded-md border border-alarm-200 dark:border-alarm-700 border-l-[3px] border-l-state-alarm bg-alarm-50 dark:bg-alarm-900/30 text-sm text-alarm-700 dark:text-alarm-300">
                <p className="font-semibold">{serverErrorTitle}</p>
                <p className="mt-0.5">{serverError.message}</p>
              </div>
            )}
            {showErrors && errors.list.length > 0 && !serverError && (
              <div role="alert" aria-live="polite" className="mt-4 p-3 rounded-md border border-caution-300 dark:border-caution-700 border-l-[3px] border-l-state-caution bg-caution-50 dark:bg-caution-900/30 text-sm text-caution-700 dark:text-caution-300">
                <p className="font-semibold">Fix {errors.list.length} thing{errors.list.length > 1 ? 's' : ''} before saving</p>
                <ul className="mt-1 list-disc pl-5 space-y-0.5">{errors.list.map((m, i) => <li key={i}>{m}</li>)}</ul>
              </div>
            )}

            {/* NAME */}
            <div className={serverError || (showErrors && errors.list.length) ? '' : 'mt-4'}>
              <Label as="label" htmlFor="automation-name" className="mb-1.5">Name</Label>
              <input
                ref={nameRef}
                id="automation-name"
                type="text"
                value={formData.name}
                onChange={(e) => { setNameDirty(e.target.value.trim() !== ''); setFormData(prev => ({ ...prev, name: e.target.value })); }}
                className={`${INPUT} ${showErrors && errors.name ? 'border-alarm-400' : ''}`}
                placeholder={suggestedName || 'e.g. Temp > 30 °C → 14 big fans ON'}
                aria-invalid={showErrors && !!errors.name}
              />
              {showErrors && errors.name ? (
                <p className={ERROR_TEXT}>{errors.name}</p>
              ) : (
                <p className={`${HELP} mt-1`}>
                  {isNew && !nameDirty ? 'Suggested from the rule below; type to override.' : suggestedName && suggestedName !== formData.name ? (
                    <>
                      Rule reads: <span className="font-mono tabular text-ink">{suggestedName}</span>
                      <button type="button" className="ml-2 underline text-brand" onClick={() => { setNameDirty(false); setFormData(prev => ({ ...prev, name: suggestedName })); }}>use as name</button>
                    </>
                  ) : ' '}
                </p>
              )}
            </div>

            {/* WHEN */}
            <section aria-labelledby="when-label" className="space-y-3">
              <div>
                <Label id="when-label">When</Label>
                <p className={HELP}>What starts this rule.</p>
              </div>
              <div>
                <label className={FIELD_LABEL} htmlFor="trigger-type">Trigger</label>
                <select id="trigger-type" value={trigger.type || 'manual'} onChange={(e) => handleTriggerTypeChange(e.target.value)} className={INPUT}>
                  <option value="manual">Manual (Run button only)</option>
                  <option value="schedule">Schedule</option>
                  <option value="threshold">Sensor threshold</option>
                  <option value="event">Equipment event</option>
                </select>
              </div>

              {trigger.type === 'threshold' && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 sm:grid-cols-12 gap-2 items-end">
                    <div className="col-span-2 sm:col-span-4">
                      <label className={FIELD_LABEL} htmlFor="th-sensor">Sensor</label>
                      <select
                        id="th-sensor"
                        value={trigger.equipment_id || ''}
                        onChange={(e) => setTrigger({ equipment_id: e.target.value, sensor_type: '', unit: '' })}
                        className={INPUT}
                        aria-invalid={showErrors && !!errors.thresholdSensor}
                      >
                        <option value="">Select sensor...</option>
                        {sensorOptions.map(eq => <option key={eq.id} value={eq.id}>{eq.name}</option>)}
                      </select>
                      {showErrors && errors.thresholdSensor && <p className={ERROR_TEXT}>{errors.thresholdSensor}</p>}
                    </div>
                    <div className="col-span-2 sm:col-span-3">
                      <label className={FIELD_LABEL} htmlFor="th-metric">Metric</label>
                      {triggerMetrics.length ? (
                        <select
                          id="th-metric"
                          value={trigger.sensor_type || ''}
                          onChange={(e) => {
                            const m = triggerMetrics.find(x => x.name === e.target.value);
                            setTrigger({ sensor_type: e.target.value, unit: m?.unit || trigger.unit || '' });
                          }}
                          className={INPUT}
                          aria-invalid={showErrors && !!errors.thresholdMetric}
                        >
                          <option value="">Select...</option>
                          {triggerMetrics.map(m => <option key={m.name} value={m.name}>{m.label || m.name}</option>)}
                        </select>
                      ) : (
                        <input id="th-metric" type="text" value={trigger.sensor_type || ''} onChange={(e) => setTrigger({ sensor_type: e.target.value })} className={INPUT} placeholder="Temperature" />
                      )}
                      {showErrors && errors.thresholdMetric && <p className={ERROR_TEXT}>{errors.thresholdMetric}</p>}
                    </div>
                    <div className="sm:col-span-2">
                      <label className={FIELD_LABEL} htmlFor="th-op">Is</label>
                      <select id="th-op" value={trigger.operator || 'gt'} onChange={(e) => setTrigger({ operator: e.target.value })} className={`${INPUT} font-mono`}>
                        <option value="gt">&gt;</option>
                        <option value="gte">≥</option>
                        <option value="lt">&lt;</option>
                        <option value="lte">≤</option>
                        <option value="eq">=</option>
                        <option value="neq">≠</option>
                      </select>
                    </div>
                    <div className="sm:col-span-3">
                      <label className={FIELD_LABEL} htmlFor="th-value">Value</label>
                      <div className="flex gap-1">
                        <input
                          id="th-value"
                          type="number"
                          step="any"
                          inputMode="decimal"
                          value={trigger.threshold_value ?? ''}
                          onChange={(e) => setTrigger({ threshold_value: e.target.value })}
                          className={`${INPUT} font-mono tabular`}
                          placeholder="30"
                          aria-invalid={showErrors && !!errors.thresholdValue}
                        />
                        <input
                          type="text"
                          value={trigger.unit || ''}
                          onChange={(e) => setTrigger({ unit: e.target.value })}
                          className={`${INPUT_BARE} w-16 shrink-0 text-center`}
                          placeholder="unit"
                          aria-label="Unit"
                        />
                      </div>
                      {showErrors && errors.thresholdValue && <p className={ERROR_TEXT}>{errors.thresholdValue}</p>}
                    </div>
                  </div>
                  <p className={HELP}>
                    Fires on the rising edge: once, when <span className="font-mono tabular text-ink">{summary.when}</span> first becomes true. Pair it with an opposite rule on the same channels.
                  </p>
                  {hysteresis.length > 0 && (
                    <ul className="space-y-0.5">
                      {hysteresis.map((h, i) => (
                        <li key={i} className={`text-xs ${h.crossed ? 'text-caution-700 dark:text-caution-300' : 'text-muted'}`} data-testid="hysteresis-pair">
                          {h.crossed ? 'Thresholds cross with ' : 'Pairs with '}
                          <span className="font-mono tabular">#{h.partner.id}</span> {h.partner.name} ({h.role === 'off' ? 'OFF' : 'ON'} at <span className="font-mono tabular">{OP_SYM[h.partner.operator] || h.partner.operator} {formatValueUnit(h.partner.threshold, h.partner.unit)}</span>, {h.channels.length} channel{h.channels.length > 1 ? 's' : ''})
                          {h.crossed && ' — the ON threshold must sit strictly beyond the OFF threshold or the save will be refused.'}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {trigger.type === 'schedule' && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 sm:grid-cols-12 gap-2 items-end">
                    <div className="col-span-2 sm:col-span-4">
                      <label className={FIELD_LABEL} htmlFor="sch-type">Repeat</label>
                      <select id="sch-type" value={trigger.schedule_type || 'daily'} onChange={(e) => onScheduleTypeChange(e.target.value)} className={INPUT}>
                        <option value="daily">Daily</option>
                        <option value="weekly">Weekly</option>
                        <option value="hourly">Hourly</option>
                        <option value="once">Once</option>
                        <option value="custom">Cron</option>
                      </select>
                    </div>
                    {(trigger.schedule_type === 'daily' || trigger.schedule_type === 'weekly' || !trigger.schedule_type) && (
                      <>
                        {trigger.schedule_type === 'weekly' && (
                          <div className="sm:col-span-4">
                            <label className={FIELD_LABEL} htmlFor="sch-dow">Day</label>
                            <select id="sch-dow" value={trigger.day_of_week ?? '1'} onChange={(e) => setTrigger({ day_of_week: e.target.value })} className={INPUT}>
                              {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => <option key={d} value={String(i)}>{d}</option>)}
                            </select>
                          </div>
                        )}
                        <div className="sm:col-span-4">
                          <label className={FIELD_LABEL} htmlFor="sch-time">Time</label>
                          <input id="sch-time" type="time" value={trigger.time || '08:00'} onChange={(e) => setTrigger({ time: e.target.value })} className={`${INPUT} font-mono tabular`} />
                        </div>
                      </>
                    )}
                    {trigger.schedule_type === 'hourly' && (
                      <div className="sm:col-span-4">
                        <label className={FIELD_LABEL} htmlFor="sch-min">Minutes past the hour</label>
                        <input id="sch-min" type="number" min="0" max="59" inputMode="numeric" value={trigger.minute ?? '0'} onChange={(e) => setTrigger({ minute: e.target.value })} className={`${INPUT} font-mono tabular`} />
                      </div>
                    )}
                    {trigger.schedule_type === 'once' && (
                      <div className="col-span-2 sm:col-span-8">
                        <label className={FIELD_LABEL} htmlFor="sch-once">Run at</label>
                        <input id="sch-once" type="datetime-local" value={trigger.run_at || ''} onChange={(e) => setTrigger({ run_at: e.target.value })} className={`${INPUT} font-mono tabular`} aria-invalid={showErrors && !!errors.schedule} />
                      </div>
                    )}
                    {trigger.schedule_type === 'custom' && (
                      <div className="col-span-2 sm:col-span-8">
                        <label className={FIELD_LABEL} htmlFor="sch-cron">Cron expression</label>
                        <input id="sch-cron" type="text" value={trigger.cron || ''} onChange={(e) => setTrigger({ cron: e.target.value })} className={`${INPUT} font-mono tabular`} placeholder="0 8 * * 1-5" aria-invalid={showErrors && !!errors.schedule} />
                        <p className={`${HELP} mt-1`}>minute hour day month weekday</p>
                      </div>
                    )}
                  </div>
                  {showErrors && errors.schedule && <p className={ERROR_TEXT}>{errors.schedule}</p>}
                  <p className={HELP} data-testid="next-run">
                    Next run:{' '}
                    {cronInvalid ? (
                      <span className="text-caution-700 dark:text-caution-300">cron expression not understood</span>
                    ) : nextRun ? (
                      <span className="font-mono tabular text-ink">{formatNextRun(nextRun)}</span>
                    ) : (
                      <span>complete the schedule above</span>
                    )}
                    <span className="ml-1">(device local time)</span>
                  </p>
                </div>
              )}

              {trigger.type === 'event' && (
                <p className={HELP}>Fires on equipment events reported by the backend. No further settings.</p>
              )}
              {trigger.type === 'manual' && (
                <p className={HELP}>Runs only when an operator presses Run.</p>
              )}
            </section>

            {/* DO */}
            <section aria-labelledby="do-label" className="space-y-3">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <Label id="do-label">Do</Label>
                  <p className={HELP}>Which channels switch, when, and for how long.</p>
                </div>
                <div className="inline-flex rounded-md border border-line overflow-hidden shrink-0" role="group" aria-label="Duration unit">
                  {['min', 's'].map(u => (
                    <button
                      key={u}
                      type="button"
                      onClick={() => setDurUnit(u)}
                      aria-pressed={durUnit === u}
                      className={`min-h-[36px] px-3 text-xs font-semibold ${durUnit === u ? 'bg-ink text-canvas' : 'bg-panel text-muted hover:bg-field'}`}
                    >
                      {u === 'min' ? 'minutes' : 'seconds'}
                    </button>
                  ))}
                </div>
              </div>

              {formData.actions.length === 0 && (
                <p className={`text-sm ${showErrors && errors.actionsEmpty ? 'text-alarm-700 dark:text-alarm-300' : 'text-muted'} border border-dashed border-line rounded-md p-3`}>
                  No actions yet. Add a relay action or an alert.
                </p>
              )}
              <div className="space-y-2">
                {formData.actions.map((a, i) => {
                  const common = { index: i, action: a, onChange: (patch) => updateAction(i, patch), onRemove: () => removeAction(i), error: showErrors ? errors.actions[i] : null };
                  if (a?.type === 'control') return <ControlRow key={i} {...common} equipment={equipment} equipIndex={equipIndex} durUnit={durUnit} />;
                  if (a?.type === 'alert') return <AlertRow key={i} {...common} />;
                  if (a?.type === 'log') return <LogRow key={i} {...common} />;
                  if (a?.type === 'transition') return <TransitionRow key={i} {...common} equipment={equipment} equipIndex={equipIndex} durUnit={durUnit} />;
                  return (
                    <div key={i} className="rounded-md border border-line bg-panel p-3 flex items-center justify-between gap-2 text-sm text-muted">
                      <span>Unknown action type "{String(a?.type)}"</span>
                      <RemoveButton onClick={() => removeAction(i)} label={`Remove action ${i + 1}`} />
                    </div>
                  );
                })}
              </div>
              {formData.actions.some(a => a?.type === 'control') && (
                <p className={HELP}>Start after counts from the trigger (empty = immediately). An empty For means the channel stays on until another rule switches it off.</p>
              )}
              <SequenceTimeline sequence={sequence} />
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="secondary" onClick={() => addAction('control')}>+ Relay action</Button>
                <Button type="button" variant="ghost" onClick={() => addAction('alert')}>+ Alert</Button>
              </div>
              {formData.actions.length > 0 && (
                <p className={HELP}>Reads as: <span className="font-mono tabular text-ink">{summary.text}</span></p>
              )}
            </section>

            {/* ADVANCED */}
            <section className="border-t border-line pt-4">
              <button
                type="button"
                onClick={() => setShowAdvanced(o => !o)}
                aria-expanded={showAdvanced}
                aria-controls="automation-advanced"
                className="w-full min-h-touch flex items-center justify-between gap-3 text-left rounded-md hover:bg-field px-2 -mx-2 transition-colors"
              >
                <span>
                  <span className="text-sm font-semibold text-ink">Advanced</span>
                  <span className="ml-2 text-xs text-muted">{advancedHints.length ? advancedHints.join(' · ') : 'priority, description, dose program, gates, conditions, stagger, atomic transitions'}</span>
                </span>
                <svg className={`h-4 w-4 text-muted transition-transform ${showAdvanced ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {showAdvanced && (
                <div id="automation-advanced" className="mt-4 space-y-6">
                  {/* Status, priority, description */}
                  <div className="grid grid-cols-2 sm:grid-cols-12 gap-3 items-end">
                    <div className="col-span-2 sm:col-span-4">
                      <label className="inline-flex items-center gap-2 min-h-touch text-sm text-ink">
                        <input type="checkbox" className="h-4 w-4" checked={formData.enabled} onChange={(e) => setFormData(prev => ({ ...prev, enabled: e.target.checked }))} />
                        Enabled
                      </label>
                    </div>
                    <div className="col-span-2 sm:col-span-3">
                      <label className={FIELD_LABEL} htmlFor="priority">Priority</label>
                      <input id="priority" type="number" min="0" inputMode="numeric" value={formData.priority} onChange={(e) => setFormData(prev => ({ ...prev, priority: e.target.value }))} className={`${INPUT} font-mono tabular`} />
                      <p className={`${HELP} mt-1`}>Higher wins when rules conflict.</p>
                    </div>
                    <div className="col-span-2 sm:col-span-12">
                      <label className={FIELD_LABEL} htmlFor="description">Description</label>
                      <textarea id="description" rows={2} value={formData.description} onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))} className={`${INPUT} min-h-[64px]`} placeholder="Why this rule exists, and any incident it guards against." />
                    </div>
                  </div>

                  {/* Dose program */}
                  <div>
                    <label className={FIELD_LABEL} htmlFor="dose_program_id">Fertigation dose program <span className="font-normal">(optional, irrigation cycles only)</span></label>
                    <select
                      id="dose_program_id"
                      value={formData.dose_program_id || ''}
                      onChange={(e) => setFormData(prev => ({ ...prev, dose_program_id: e.target.value ? parseInt(e.target.value, 10) : null }))}
                      className={INPUT}
                    >
                      <option value="">— None (no fertilizer injection) —</option>
                      {dosePrograms.map(p => (
                        <option key={p.id} value={p.id}>
                          {p.name}{p.target_ec ? ` · EC ${p.target_ec}` : ''}{p.compatibility_strategy === 'time_slice' ? ' · time-slice' : ''}
                        </option>
                      ))}
                      {formData.dose_program_id && !dosePrograms.some(p => p.id === formData.dose_program_id) && (
                        <option value={formData.dose_program_id}>Program #{formData.dose_program_id} (not published)</option>
                      )}
                    </select>
                    <p className={`${HELP} mt-1`}>
                      When set, the FertigationDoseScheduler opens injector valves on Waveshare Irrigation 2 according to this
                      program's per-tank duty cycles for the duration of this automation's longest control action. Only
                      published programs are listable; manage programs under Fertigation → Dose Programs.
                    </p>
                  </div>

                  {/* Timing & gates per action */}
                  <div className="space-y-2">
                    <div>
                      <p className="text-sm font-semibold text-ink">Stagger and gates per action</p>
                      <p className={HELP}>Start delays are set on each action under Do (Start after). Gates (dependencies) are checked at run time by the executor; they are the real runtime guard.</p>
                    </div>
                    {formData.actions.length === 0 && <p className={HELP}>Add actions above first.</p>}
                    {formData.actions.map((a, i) => {
                      if (!a || (a.type !== 'control' && a.type !== 'transition')) return null;
                      const allChannels = a.type === 'control' && (a.channel === null || a.channel === undefined || a.channel === '');
                      const depCount = Array.isArray(a.dependencies) ? a.dependencies.length : 0;
                      return (
                        <div key={i} className="rounded-md border border-line bg-field/40 p-3 space-y-2">
                          <p className="text-xs text-ink truncate"><span className="font-mono tabular text-muted mr-2">{i + 1}</span>{shortActionLabel(a, equipIndex)}</p>
                          <div className="grid grid-cols-2 sm:grid-cols-12 gap-2 items-end">
                            {allChannels && (
                              <div className="sm:col-span-3">
                                <label className={FIELD_LABEL} htmlFor={`adv-stagger-${i}`}>Stagger (s)</label>
                                <input id={`adv-stagger-${i}`} type="number" min="0" step="0.5" inputMode="decimal" value={a.stagger_delay_seconds ?? ''} onChange={(e) => updateAction(i, { stagger_delay_seconds: e.target.value === '' ? undefined : parseFloat(e.target.value) })} className={`${INPUT_SM} font-mono tabular`} placeholder="0" title="Seconds between each channel firing" />
                              </div>
                            )}
                            {a.type === 'transition' && (
                              <div className="sm:col-span-3">
                                <label className={FIELD_LABEL} htmlFor={`adv-revert-${i}`}>Auto-revert OFF (s)</label>
                                <input id={`adv-revert-${i}`} type="number" min="0" inputMode="numeric" value={a.duration_seconds ?? ''} onChange={(e) => updateAction(i, { duration_seconds: e.target.value === '' ? null : parseInt(e.target.value, 10) })} className={`${INPUT_SM} font-mono tabular`} placeholder="0" />
                              </div>
                            )}
                            <div className="col-span-2 sm:col-span-3">
                              <Button type="button" variant={depsForAction === i ? 'secondary' : 'ghost'} size="sm" className="w-full min-h-[40px]" onClick={() => setDepsForAction(depsForAction === i ? null : i)} aria-expanded={depsForAction === i}>
                                Gates ({depCount})
                              </Button>
                            </div>
                          </div>
                          {depsForAction === i && (
                            <DependencyEditor
                              action={a}
                              equipmentList={equipment}
                              onChange={(deps) => updateAction(i, { dependencies: deps })}
                              onClose={() => setDepsForAction(null)}
                            />
                          )}
                        </div>
                      );
                    })}
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" variant="ghost" onClick={() => addAction('transition')}>+ Atomic transition (FC15)</Button>
                      <Button type="button" variant="ghost" onClick={() => addAction('log')}>+ Log entry</Button>
                    </div>
                  </div>

                  {/* Conditions (dry-run only) */}
                  <div className="space-y-2">
                    <div>
                      <p className="text-sm font-semibold text-ink">Conditions <span className="font-normal text-muted">(dry-run only)</span></p>
                      <p className={HELP}>Evaluated by Test / Simulate only. The executor ignores these at run time; use per-action gates above for real guarding.</p>
                    </div>
                    {formData.conditions.length >= 1 && (
                      <div className="flex flex-wrap items-center gap-4 text-sm text-ink">
                        {['AND', 'OR'].map(l => (
                          <label key={l} className="inline-flex items-center gap-2 min-h-[36px]">
                            <input type="radio" name="condition_logic" value={l} checked={formData.condition_logic === l} onChange={() => setFormData(prev => ({ ...prev, condition_logic: l }))} />
                            <span><strong>{l}</strong> — {l === 'AND' ? 'all must be true' : 'any can be true'}</span>
                          </label>
                        ))}
                      </div>
                    )}
                    {formData.conditions.length > 0 && (
                      <ul className="space-y-1">
                        {formData.conditions.map((c, i) => (
                          <li key={i} className="flex items-center gap-2 bg-panel border border-line rounded-md px-2 py-1 text-sm">
                            <span className="text-ink">{c.field}</span>
                            <span className="font-mono tabular text-muted">{OP_SYM[c.operator] || c.operator} {c.value}</span>
                            <button type="button" onClick={() => removeCondition(i)} className={`${ICON_BUTTON} ml-auto`} aria-label={`Remove condition ${i + 1}`}><CloseIcon /></button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="grid grid-cols-2 sm:grid-cols-12 gap-2 items-end">
                      <div className="col-span-2 sm:col-span-5">
                        <label className={FIELD_LABEL} htmlFor="cond-field">Field</label>
                        <input id="cond-field" type="text" value={conditionField} onChange={(e) => setConditionField(e.target.value)} className={INPUT_SM} placeholder="value" />
                      </div>
                      <div className="sm:col-span-2">
                        <label className={FIELD_LABEL} htmlFor="cond-op">Op</label>
                        <select id="cond-op" value={conditionOperator} onChange={(e) => setConditionOperator(e.target.value)} className={`${INPUT_SM} font-mono`}>
                          <option value="eq">=</option><option value="neq">≠</option><option value="gt">&gt;</option><option value="gte">≥</option><option value="lt">&lt;</option><option value="lte">≤</option>
                        </select>
                      </div>
                      <div className="sm:col-span-3">
                        <label className={FIELD_LABEL} htmlFor="cond-val">Value</label>
                        <input id="cond-val" type="text" value={conditionValue} onChange={(e) => setConditionValue(e.target.value)} className={`${INPUT_SM} font-mono tabular`} placeholder="30" />
                      </div>
                      <div className="col-span-2 sm:col-span-2">
                        <Button type="button" variant="secondary" size="sm" className="w-full min-h-[40px]" onClick={addCondition}>Add</Button>
                      </div>
                    </div>
                  </div>

                  {/* Skip conditions (read-only: the API does not accept them from the UI) */}
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-ink">Skip conditions <span className="font-normal text-muted">(read-only)</span></p>
                    <p className={HELP}>Set by the planner / agent tooling; the scheduler skips the run when one is true. Not editable here.</p>
                    {formData.skip_conditions.length === 0 ? (
                      <p className="text-sm text-muted">None.</p>
                    ) : (
                      <ul className="space-y-1">
                        {formData.skip_conditions.map((c, i) => (
                          <li key={i} className="text-sm bg-panel border border-line rounded-md px-2 py-1">
                            <span className="text-ink">{equipmentLabel(equipIndex, c.sensor_equipment_id)} / {c.sensor_metric || 'value'}</span>{' '}
                            <span className="font-mono tabular text-muted">{OP_SYM[c.operator] || c.operator} {c.value}</span>
                            {c.reason && <span className="text-muted"> — {c.reason}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </section>

            {/* Footer */}
            <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2 border-t border-line pt-4">
              <div>
                {!isNew && automation?.id && (
                  <Button type="button" variant="secondary" onClick={handleTest} disabled={testing || saving} className="w-full sm:w-auto">
                    {testing ? 'Testing…' : 'Test / simulate'}
                  </Button>
                )}
              </div>
              <div className="flex flex-col-reverse sm:flex-row gap-2">
                <Button type="button" variant="ghost" onClick={onClose} disabled={saving} className="w-full sm:w-auto">Cancel</Button>
                <Button type="submit" variant="primary" disabled={saving} className="w-full sm:w-auto">
                  {saving ? 'Saving…' : isNew ? 'Create automation' : 'Save changes'}
                </Button>
              </div>
            </div>
          </form>

          {/* Test results, inline (no nested scroll) */}
          {testResult && (
            <div className="border-t border-line px-4 py-4 sm:px-6 space-y-3" aria-live="polite">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-ink">Test results</p>
                  <p className={HELP}>{testResult.mode}</p>
                </div>
                <Button type="button" variant="ghost" size="sm" onClick={() => setTestResult(null)}>Hide</Button>
              </div>
              <div className={`p-3 rounded-md border border-l-[3px] text-sm ${testResult.status === 'success' ? 'border-ok-300 border-l-state-ok bg-ok-50 text-ok-700 dark:bg-ok-900/30 dark:border-ok-700 dark:text-ok-300' : 'border-caution-300 border-l-state-caution bg-caution-50 text-caution-700 dark:bg-caution-900/30 dark:border-caution-700 dark:text-caution-300'}`}>
                {testResult.message}
              </div>
              <div className="grid grid-cols-3 gap-2">
                {[['Conditions', testResult.summary?.conditions_evaluated || 0], ['Actions', testResult.summary?.total_actions || 0], ['Would execute', testResult.summary?.actions_to_execute || 0]].map(([label, v]) => (
                  <div key={label} className="bg-field/60 border border-line rounded-md p-2 text-center">
                    <p className="text-xl font-mono tabular text-ink">{v}</p>
                    <p className={HELP}>{label}</p>
                  </div>
                ))}
              </div>
              {testResult.trigger && (
                <div className="text-sm text-ink bg-field/60 border border-line rounded-md p-3 space-y-0.5">
                  <p><span className="text-muted">Trigger:</span> {testResult.trigger.type} — would fire: <span className="font-mono tabular">{testResult.trigger.would_fire ? 'yes' : 'no'}</span></p>
                  {testResult.trigger.details && Object.entries(testResult.trigger.details).map(([k, v]) => (
                    <p key={k}><span className="text-muted">{k.replace(/_/g, ' ')}:</span> {String(v)}</p>
                  ))}
                </div>
              )}
              {Array.isArray(testResult.conditions) && testResult.conditions.length > 0 && (
                <ul className="space-y-1">
                  {testResult.conditions.map((c) => (
                    <li key={c.index} className={`text-sm rounded-md border border-l-[3px] p-2 ${c.would_pass ? 'border-ok-300 border-l-state-ok' : c.would_pass === false ? 'border-alarm-300 border-l-state-alarm' : 'border-line border-l-state-idle'}`}>
                      <span className="text-ink">{c.field}</span> <span className="font-mono tabular text-muted">{c.operator} {c.expected_value}</span> <span className="text-muted">({c.test_result})</span>
                    </li>
                  ))}
                </ul>
              )}
              {Array.isArray(testResult.actions) && testResult.actions.length > 0 && (
                <ul className="space-y-1">
                  {testResult.actions.map((a) => (
                    <li key={a.index} className={`text-sm rounded-md border border-l-[3px] p-2 ${a.would_execute ? 'border-line border-l-state-ok' : 'border-line border-l-state-idle'}`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold uppercase tracking-label text-muted">{a.type}</span>
                        <span className={`text-xs ${a.would_execute ? 'text-ok-700 dark:text-ok-300' : 'text-muted'}`}>{a.would_execute ? 'would execute' : 'would NOT execute'}</span>
                      </div>
                      {a.details && (
                        <div className="mt-1 text-xs text-muted space-y-0.5">
                          {Object.entries(a.details).map(([k, v]) => k !== 'simulation_note' && <p key={k}><span className="font-semibold">{k}:</span> {String(v)}</p>)}
                          {a.details.simulation_note && <p className="italic">{a.details.simulation_note}</p>}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
