import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Trans, useTranslation } from 'react-i18next';
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
  formatValueUnit, OP_SYM, buildSequence, actionWord, weekdayName, stripIsolates,
} from './automationSummary';
import { useSummaryLocale } from './useSummaryLocale';
import { DOSE_BOARD } from './AutomationRow';

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
function shortActionLabel(action, equipIndex, loc) {
  const { t } = loc;
  if (!action) return t('builder.short.action');
  if (action.type === 'control') {
    const target = action.channel === null || action.channel === undefined || action.channel === ''
      ? t('builder.short.allChannels')
      : channelLabel(equipIndex, action.equipment_id, action.channel, loc);
    return t('builder.short.control', { action: actionWord(action.action || 'on', loc), equipment: equipmentLabel(equipIndex, action.equipment_id, loc), target });
  }
  if (action.type === 'transition') {
    return t('builder.short.transition', {
      equipment: equipmentLabel(equipIndex, action.equipment_id, loc),
      channels: t('confirm.channelCount', { count: (action.transitions || []).length }),
    });
  }
  if (action.type === 'alert') {
    const sev = action.severity || 'info';
    return t('builder.short.alert', { severity: t(`summary.severity.${sev}`, { defaultValue: sev }), message: action.message || '' });
  }
  if (action.type === 'log') return t('builder.short.log', { message: action.message || '' });
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
  const { t } = useTranslation('automations');
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
      <label className={FIELD_LABEL} htmlFor={id}>{label} ({t(`builder.control.unit.${unit}`)})</label>
      <input
        id={id}
        dir="ltr"
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
  const { t } = useTranslation('automations');
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
          <label className={FIELD_LABEL} htmlFor={`act-eq-${index}`}>{t('builder.control.equipment')}</label>
          <select
            id={`act-eq-${index}`}
            value={action.equipment_id ?? ''}
            onChange={(e) => {
              const id = e.target.value ? parseInt(e.target.value, 10) : null;
              onChange({ equipment_id: id, equipment_name: id ? equipmentLabel(equipIndex, id) : null, channel: null, channel_name: null });
            }}
            className={INPUT}
          >
            <option value="">{t('builder.control.selectEquipment')}</option>
            {relaysFirst.map(eq => <option key={eq.id} value={eq.id}>{eq.name}</option>)}
          </select>
        </div>
        <div className="col-span-2 sm:col-span-5">
          <label className={FIELD_LABEL} htmlFor={`act-ch-${index}`}>{t('builder.control.channel')}</label>
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
            <option value="">{coils.length ? t('builder.control.allChannels', { n: coils.length }) : t('builder.control.noRelayChannels')}</option>
            {coils.map(c => <option key={c.register} value={c.register}>{c.label}</option>)}
          </select>
        </div>
        <div className="order-last sm:order-none sm:col-span-1 flex justify-end">
          <RemoveButton onClick={onRemove} label={t('builder.control.removeAction', { n: index + 1 })} />
        </div>
        <div className="sm:col-span-4">
          <label className={FIELD_LABEL} htmlFor={`act-do-${index}`}>{t('builder.control.switch')}</label>
          <select id={`act-do-${index}`} value={action.action || 'on'} onChange={(e) => onChange({ action: e.target.value, value: e.target.value === 'set' ? (action.value ?? '') : null })} className={INPUT}>
            <option value="on">{t('common:status.on')}</option>
            <option value="off">{t('common:status.off')}</option>
            <option value="toggle">{t('builder.control.toggle')}</option>
            <option value="set">{t('builder.control.setValue')}</option>
          </select>
        </div>
        {action.action === 'set' && (
          <div className="sm:col-span-4">
            <label className={FIELD_LABEL} htmlFor={`act-val-${index}`}>{t('builder.control.value')}</label>
            <input id={`act-val-${index}`} type="text" value={action.value ?? ''} onChange={(e) => onChange({ value: e.target.value })} className={INPUT} placeholder="75" />
          </div>
        )}
        <div className="sm:col-span-4">
          <SecondsField
            id={`act-delay-${index}`}
            label={t('builder.control.startAfter')}
            seconds={action.delay_seconds}
            unit={durUnit}
            onChange={(v) => onChange({ delay_seconds: v })}
            placeholder="0"
            title={t('builder.control.startAfterTitle')}
            showZero
          />
        </div>
        {showDuration && (
          <div className="sm:col-span-4">
            <SecondsField
              id={`act-dur-${index}`}
              label={t('builder.control.for')}
              seconds={action.duration_seconds}
              unit={durUnit}
              onChange={(v) => onChange({ duration_seconds: v })}
              placeholder={t('builder.control.forPlaceholder')}
              title={t('builder.control.forTitle')}
            />
          </div>
        )}
      </div>
      {error && <p className={ERROR_TEXT}>{error}</p>}
    </div>
  );
}

function AlertRow({ action, index, onChange, onRemove, error }) {
  const { t } = useTranslation('automations');
  return (
    <div className={`rounded-md border ${error ? 'border-alarm-300 dark:border-alarm-700' : 'border-line'} bg-panel p-3`}>
      <div className="grid grid-cols-2 sm:grid-cols-12 gap-2 items-end">
        <div className="sm:col-span-3">
          <label className={FIELD_LABEL} htmlFor={`act-sev-${index}`}>{t('builder.alert.severity')}</label>
          <select id={`act-sev-${index}`} value={action.severity || 'info'} onChange={(e) => onChange({ severity: e.target.value })} className={INPUT}>
            <option value="info">{t('common:severity.info')}</option>
            <option value="warning">{t('common:severity.warning')}</option>
            <option value="critical">{t('common:severity.critical')}</option>
          </select>
        </div>
        <div className="col-span-2 sm:col-span-8">
          <label className={FIELD_LABEL} htmlFor={`act-msg-${index}`}>{t('builder.alert.message')}</label>
          <input id={`act-msg-${index}`} type="text" dir="auto" value={action.message || ''} onChange={(e) => onChange({ message: e.target.value })} className={INPUT} placeholder={t('builder.alert.messagePlaceholder')} />
        </div>
        <div className="col-span-2 sm:col-span-1 flex justify-end">
          <RemoveButton onClick={onRemove} label={t('builder.control.removeAction', { n: index + 1 })} />
        </div>
      </div>
      {error && <p className={ERROR_TEXT}>{error}</p>}
    </div>
  );
}

function LogRow({ action, index, onChange, onRemove }) {
  const { t } = useTranslation('automations');
  return (
    <div className="rounded-md border border-line bg-panel p-3">
      <div className="grid grid-cols-2 sm:grid-cols-12 gap-2 items-end">
        <div className="col-span-2 sm:col-span-11">
          <label className={FIELD_LABEL} htmlFor={`act-log-${index}`}>{t('builder.log.entry')}</label>
          <input id={`act-log-${index}`} type="text" dir="auto" value={action.message || ''} onChange={(e) => onChange({ message: e.target.value })} className={INPUT} placeholder={t('builder.log.placeholder')} />
        </div>
        <div className="col-span-2 sm:col-span-1 flex justify-end">
          <RemoveButton onClick={onRemove} label={t('builder.control.removeAction', { n: index + 1 })} />
        </div>
      </div>
    </div>
  );
}

function TransitionRow({ action, index, equipment, equipIndex, durUnit, onChange, onRemove, error }) {
  const { t } = useTranslation('automations');
  const loc = useSummaryLocale();
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
        <span className="text-xs font-semibold uppercase tracking-label text-muted">{t('builder.transitionRow.title')}</span>
        <span className="text-sm text-ink" dir="auto">{action.equipment_id ? equipmentLabel(equipIndex, action.equipment_id, loc) : t('builder.transitionRow.noBoard')}</span>
        <span className="text-xs font-mono tabular text-muted">{t('confirm.channelCount', { count })}</span>
        <div className="ms-auto flex items-center gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(o => !o)} aria-expanded={open}>{open ? t('builder.transitionRow.hideChannels') : t('builder.transitionRow.editChannels')}</Button>
          <RemoveButton onClick={onRemove} label={t('builder.control.removeAction', { n: index + 1 })} />
        </div>
      </div>
      <div className="mt-2 w-full sm:w-40">
        <SecondsField
          id={`act-delay-${index}`}
          label={t('builder.control.startAfter')}
          seconds={action.delay_seconds}
          unit={durUnit}
          onChange={(v) => onChange({ delay_seconds: v })}
          placeholder="0"
          title={t('builder.transitionRow.startAfterTitle')}
          showZero
          className={INPUT_SM}
        />
      </div>
      {!open && count > 0 && (
        <p className="mt-1 text-xs font-mono tabular text-muted truncate" dir="auto" title={(action.transitions || []).map(x => `${x.name || `ch${x.channel}`}=${x.state ? t('common:status.on') : t('common:status.off')}`).join(', ')}>
          {(action.transitions || []).map(x => `${x.name || `ch${x.channel}`}=${x.state ? t('common:status.on') : t('common:status.off')}`).join(', ')}
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
  const { t } = useTranslation('automations');
  const loc = useSummaryLocale();
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
      .catch(err => showError(t('errors.loadDosePrograms', { error: err.message })));
  }, [isOpen, token]);

  // Escape closes (unless saving)
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && !saving) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, saving, onClose]);

  // Suggested name follows the rule until the user edits it.
  const summary = useMemo(() => summarizeForm(formData, equipIndex, loc), [formData.trigger_config, formData.actions, equipIndex, loc]);
  const sequence = useMemo(() => buildSequence(formData.actions, equipIndex, loc), [formData.actions, equipIndex, loc]);
  // The suggested name is saved to the database: no bidi control characters.
  const suggestedName = formData.actions.length ? stripIsolates(summary.text) : '';
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
  const V = (k) => t(`builder.validation.${k}`);
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
    if (!formData.name.trim()) { e.name = V('nameRequired'); e.list.push(V('giveName')); }
    if (formData.actions.length === 0) { e.actionsEmpty = V('addAction'); e.list.push(V('addAction')); }
    if (trigger.type === 'threshold') {
      if (!trigger.equipment_id) { e.thresholdSensor = V('pickSensor'); e.list.push(V('pickSensorLong')); }
      if (!String(trigger.sensor_type || '').trim()) { e.thresholdMetric = V('pickMetric'); e.list.push(V('pickMetricLong')); }
      const v = trigger.threshold_value;
      if (v === '' || v === null || v === undefined || !Number.isFinite(Number(v))) { e.thresholdValue = V('thresholdNumber'); e.list.push(V('thresholdNumber')); }
    }
    if (trigger.type === 'schedule') {
      if (trigger.schedule_type === 'once') {
        if (!trigger.run_at) { e.schedule = V('pickDateTime'); e.list.push(V('pickDateTimeLong')); }
        else if (new Date(trigger.run_at) <= new Date()) { e.schedule = V('inPast'); e.list.push(V('inPastLong')); }
      }
      if (trigger.schedule_type === 'custom' && (!trigger.cron || !parseCron(trigger.cron))) { e.schedule = V('cronInvalid'); e.list.push(V('cronInvalidLong')); }
    }
    formData.actions.forEach((a, i) => {
      if (!a) return;
      if (a.type === 'control') {
        if (!a.equipment_id) e.actions[i] = V('pickEquipment');
        else if (a.duration_seconds !== null && a.duration_seconds !== undefined && a.duration_seconds !== '' && !(Number(a.duration_seconds) > 0)) e.actions[i] = V('durationPositive');
        else if (a.action === 'set' && (a.value === null || a.value === undefined || String(a.value).trim() === '')) e.actions[i] = V('enterValue');
      } else if (a.type === 'alert') {
        if (!String(a.message || '').trim()) e.actions[i] = V('enterAlertMessage');
      } else if (a.type === 'transition') {
        if (!a.equipment_id) e.actions[i] = V('pickRelayBoard');
        else if (!(a.transitions || []).length) e.actions[i] = V('pickChannelState');
      }
      if (e.actions[i]) e.list.push(t('builder.validation.actionItem', { n: i + 1, error: e.actions[i] }));
    });
    return e;
  }, [formData, trigger, t]);
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
          message: data?.message || t('builder.saveFailed', { status: response.status }),
        });
        return;
      }
      const capped = Array.isArray(data?.capped) ? data.capped : [];
      if (capped.length) {
        const detail = capped.map(c => {
          const field = String(c.field).replace(/_seconds$/, '');
          return t('builder.cappedItem', {
            n: c.index + 1,
            field: t(`builder.cappedField.${field}`, { defaultValue: field.replace('_', ' ') }),
            from: formatDuration(c.requested, loc),
            to: formatDuration(c.capped_to, loc),
          });
        }).join('; ');
        showWarning(t('builder.capped', { count: t('builder.cappedValues', { count: capped.length }), detail }), t('builder.cappedTitle'));
      } else {
        showSuccess(t(isNew ? 'builder.created' : 'builder.saved', { name: data?.name || formData.name }));
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
      if (!response.ok) throw new Error(t('builder.testFailed', { status: response.status }));
      setTestResult(await response.json());
    } catch (err) {
      setServerError({ code: null, message: err.message });
    } finally {
      setTesting(false);
    }
  };

  if (!isOpen) return null;

  const advancedHints = [];
  if (formData.conditions.length) advancedHints.push(t('builder.hint.conditions', { count: formData.conditions.length }));
  const gated = formData.actions.filter(a => Array.isArray(a?.dependencies) && a.dependencies.length).length;
  if (gated) advancedHints.push(t('builder.hint.gated', { count: gated }));
  const staggered = formData.actions.filter(a => a && a.stagger_delay_seconds > 0).length;
  if (staggered) advancedHints.push(t('builder.hint.staggered', { count: staggered }));
  if (formData.dose_program_id) advancedHints.push(t('builder.hint.doseProgram'));
  if (formData.priority) advancedHints.push(t('builder.hint.priority', { n: formData.priority }));
  if (!formData.enabled) advancedHints.push(t('builder.hint.disabled'));

  const serverErrorTitle = serverError?.code === 'HYSTERESIS_CROSSED' || serverError?.code === 'INTERLOCK_VIOLATION'
    ? t(`builder.serverError.${serverError.code}`)
    : t('builder.serverError.generic');

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto" role="presentation">
      <div className="fixed inset-0 bg-night/60" onClick={() => { if (!saving) onClose(); }} aria-hidden="true" />
      <div className="relative min-h-full flex items-start justify-center p-4 sm:py-8">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="automation-builder-title"
          className="relative w-full max-w-2xl bg-panel border border-line rounded-card shadow-xl text-start"
        >
          <div className="flex items-start justify-between gap-3 px-4 pt-4 sm:px-6 sm:pt-6">
            <div className="min-w-0">
              <Label>{isNew ? t('builder.newLabel') : t('builder.editLabel')}</Label>
              <h3 id="automation-builder-title" className="font-display text-lg font-semibold text-ink truncate" dir="auto">
                {isNew ? t('builder.newTitle') : (automation?.name || t('builder.untitled'))}
              </h3>
              {!isNew && automation?.id && <p className="text-xs font-mono tabular text-muted">#{automation.id}</p>}
            </div>
            <button type="button" onClick={onClose} className={ICON_BUTTON} aria-label={t('common:actions.close')}>
              <CloseIcon />
            </button>
          </div>

          <form onSubmit={handleSubmit} noValidate className="px-4 pb-4 sm:px-6 sm:pb-6 space-y-6">
            {/* Server / validation feedback at the top of the form */}
            {serverError && (
              <div role="alert" aria-live="assertive" className="mt-4 p-3 rounded-md border border-alarm-200 dark:border-alarm-700 border-s-[3px] border-s-state-alarm bg-alarm-50 dark:bg-alarm-900/30 text-sm text-alarm-700 dark:text-alarm-300">
                <p className="font-semibold">{serverErrorTitle}</p>
                <p className="mt-0.5" dir="auto">{serverError.message}</p>
              </div>
            )}
            {showErrors && errors.list.length > 0 && !serverError && (
              <div role="alert" aria-live="polite" className="mt-4 p-3 rounded-md border border-caution-300 dark:border-caution-700 border-s-[3px] border-s-state-caution bg-caution-50 dark:bg-caution-900/30 text-sm text-caution-700 dark:text-caution-300">
                <p className="font-semibold">{t('builder.fixCount', { count: errors.list.length })}</p>
                <ul className="mt-1 list-disc ps-5 space-y-0.5">{errors.list.map((m, i) => <li key={i}>{m}</li>)}</ul>
              </div>
            )}

            {/* NAME */}
            <div className={serverError || (showErrors && errors.list.length) ? '' : 'mt-4'}>
              <Label as="label" htmlFor="automation-name" className="mb-1.5">{t('builder.name')}</Label>
              <input
                ref={nameRef}
                id="automation-name"
                type="text"
                dir="auto"
                value={formData.name}
                onChange={(e) => { setNameDirty(e.target.value.trim() !== ''); setFormData(prev => ({ ...prev, name: e.target.value })); }}
                className={`${INPUT} ${showErrors && errors.name ? 'border-alarm-400' : ''}`}
                placeholder={suggestedName || t('builder.namePlaceholder')}
                aria-invalid={showErrors && !!errors.name}
              />
              {showErrors && errors.name ? (
                <p className={ERROR_TEXT}>{errors.name}</p>
              ) : (
                <p className={`${HELP} mt-1`}>
                  {isNew && !nameDirty ? t('builder.nameSuggested') : suggestedName && suggestedName !== formData.name ? (
                    <>
                      {t('builder.ruleReads')} <span className="font-mono tabular text-ink">{summary.text}</span>
                      <button type="button" className="ms-2 underline text-brand" onClick={() => { setNameDirty(false); setFormData(prev => ({ ...prev, name: suggestedName })); }}>{t('builder.useAsName')}</button>
                    </>
                  ) : ' '}
                </p>
              )}
            </div>

            {/* WHEN */}
            <section aria-labelledby="when-label" className="space-y-3">
              <div>
                <Label id="when-label">{t('builder.when')}</Label>
                <p className={HELP}>{t('builder.whenHelp')}</p>
              </div>
              <div>
                <label className={FIELD_LABEL} htmlFor="trigger-type">{t('builder.triggerLabel')}</label>
                <select id="trigger-type" value={trigger.type || 'manual'} onChange={(e) => handleTriggerTypeChange(e.target.value)} className={INPUT}>
                  <option value="manual">{t('builder.triggerOption.manual')}</option>
                  <option value="schedule">{t('builder.triggerOption.schedule')}</option>
                  <option value="threshold">{t('builder.triggerOption.threshold')}</option>
                  <option value="event">{t('builder.triggerOption.event')}</option>
                </select>
              </div>

              {trigger.type === 'threshold' && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 sm:grid-cols-12 gap-2 items-end">
                    <div className="col-span-2 sm:col-span-4">
                      <label className={FIELD_LABEL} htmlFor="th-sensor">{t('builder.sensor')}</label>
                      <select
                        id="th-sensor"
                        value={trigger.equipment_id || ''}
                        onChange={(e) => setTrigger({ equipment_id: e.target.value, sensor_type: '', unit: '' })}
                        className={INPUT}
                        aria-invalid={showErrors && !!errors.thresholdSensor}
                      >
                        <option value="">{t('builder.selectSensor')}</option>
                        {sensorOptions.map(eq => <option key={eq.id} value={eq.id}>{eq.name}</option>)}
                      </select>
                      {showErrors && errors.thresholdSensor && <p className={ERROR_TEXT}>{errors.thresholdSensor}</p>}
                    </div>
                    <div className="col-span-2 sm:col-span-3">
                      <label className={FIELD_LABEL} htmlFor="th-metric">{t('builder.metric')}</label>
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
                          <option value="">{t('builder.select')}</option>
                          {triggerMetrics.map(m => <option key={m.name} value={m.name}>{m.label || m.name}</option>)}
                        </select>
                      ) : (
                        <input id="th-metric" type="text" value={trigger.sensor_type || ''} onChange={(e) => setTrigger({ sensor_type: e.target.value })} className={INPUT} placeholder={t('builder.metricPlaceholder')} />
                      )}
                      {showErrors && errors.thresholdMetric && <p className={ERROR_TEXT}>{errors.thresholdMetric}</p>}
                    </div>
                    <div className="sm:col-span-2">
                      <label className={FIELD_LABEL} htmlFor="th-op">{t('builder.is')}</label>
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
                      <label className={FIELD_LABEL} htmlFor="th-value">{t('builder.value')}</label>
                      <div className="flex gap-1" dir="ltr">
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
                          placeholder={t('builder.unitPlaceholder')}
                          aria-label={t('builder.unit')}
                        />
                      </div>
                      {showErrors && errors.thresholdValue && <p className={ERROR_TEXT}>{errors.thresholdValue}</p>}
                    </div>
                  </div>
                  <p className={HELP}>
                    <Trans t={t} i18nKey="builder.risingEdge" values={{ expr: summary.when }} components={{ expr: <span className="font-mono tabular text-ink" /> }} />
                  </p>
                  {hysteresis.length > 0 && (
                    <ul className="space-y-0.5">
                      {hysteresis.map((h, i) => (
                        <li key={i} className={`text-xs ${h.crossed ? 'text-caution-700 dark:text-caution-300' : 'text-muted'}`} data-testid="hysteresis-pair">
                          <Trans
                            t={t}
                            i18nKey={h.crossed ? 'builder.crossesWith' : 'builder.pairsWith'}
                            values={{
                              id: h.partner.id,
                              name: `\u2068${h.partner.name}\u2069`,
                              action: actionWord(h.role === 'off' ? 'off' : 'on', loc),
                              cmp: `${OP_SYM[h.partner.operator] || h.partner.operator} ${formatValueUnit(h.partner.threshold, h.partner.unit)}`,
                              channels: t('confirm.channelCount', { count: h.channels.length }),
                            }}
                            components={{ id: <span className="font-mono tabular" />, cmp: <span className="font-mono tabular" dir="ltr" /> }}
                          />
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
                      <label className={FIELD_LABEL} htmlFor="sch-type">{t('builder.repeat')}</label>
                      <select id="sch-type" value={trigger.schedule_type || 'daily'} onChange={(e) => onScheduleTypeChange(e.target.value)} className={INPUT}>
                        <option value="daily">{t('builder.scheduleType.daily')}</option>
                        <option value="weekly">{t('builder.scheduleType.weekly')}</option>
                        <option value="hourly">{t('builder.scheduleType.hourly')}</option>
                        <option value="once">{t('builder.scheduleType.once')}</option>
                        <option value="custom">{t('builder.scheduleType.custom')}</option>
                      </select>
                    </div>
                    {(trigger.schedule_type === 'daily' || trigger.schedule_type === 'weekly' || !trigger.schedule_type) && (
                      <>
                        {trigger.schedule_type === 'weekly' && (
                          <div className="sm:col-span-4">
                            <label className={FIELD_LABEL} htmlFor="sch-dow">{t('builder.day')}</label>
                            <select id="sch-dow" value={trigger.day_of_week ?? '1'} onChange={(e) => setTrigger({ day_of_week: e.target.value })} className={INPUT}>
                              {[0, 1, 2, 3, 4, 5, 6].map((i) => <option key={i} value={String(i)}>{weekdayName(i, { long: true, loc })}</option>)}
                            </select>
                          </div>
                        )}
                        <div className="sm:col-span-4">
                          <label className={FIELD_LABEL} htmlFor="sch-time">{t('builder.time')}</label>
                          <input id="sch-time" type="time" dir="ltr" value={trigger.time || '08:00'} onChange={(e) => setTrigger({ time: e.target.value })} className={`${INPUT} font-mono tabular`} />
                        </div>
                      </>
                    )}
                    {trigger.schedule_type === 'hourly' && (
                      <div className="sm:col-span-4">
                        <label className={FIELD_LABEL} htmlFor="sch-min">{t('builder.minutesPast')}</label>
                        <input id="sch-min" type="number" dir="ltr" min="0" max="59" inputMode="numeric" value={trigger.minute ?? '0'} onChange={(e) => setTrigger({ minute: e.target.value })} className={`${INPUT} font-mono tabular`} />
                      </div>
                    )}
                    {trigger.schedule_type === 'once' && (
                      <div className="col-span-2 sm:col-span-8">
                        <label className={FIELD_LABEL} htmlFor="sch-once">{t('builder.runAt')}</label>
                        <input id="sch-once" type="datetime-local" dir="ltr" value={trigger.run_at || ''} onChange={(e) => setTrigger({ run_at: e.target.value })} className={`${INPUT} font-mono tabular`} aria-invalid={showErrors && !!errors.schedule} />
                      </div>
                    )}
                    {trigger.schedule_type === 'custom' && (
                      <div className="col-span-2 sm:col-span-8">
                        <label className={FIELD_LABEL} htmlFor="sch-cron">{t('builder.cronExpression')}</label>
                        <input id="sch-cron" type="text" dir="ltr" value={trigger.cron || ''} onChange={(e) => setTrigger({ cron: e.target.value })} className={`${INPUT} font-mono tabular`} placeholder="0 8 * * 1-5" aria-invalid={showErrors && !!errors.schedule} />
                        <p className={`${HELP} mt-1`}>{t('builder.cronFields')}</p>
                      </div>
                    )}
                  </div>
                  {showErrors && errors.schedule && <p className={ERROR_TEXT}>{errors.schedule}</p>}
                  <p className={HELP} data-testid="next-run">
                    {t('builder.nextRun')}{' '}
                    {cronInvalid ? (
                      <span className="text-caution-700 dark:text-caution-300">{t('builder.cronNotUnderstood')}</span>
                    ) : nextRun ? (
                      <span className="font-mono tabular text-ink">{formatNextRun(nextRun, undefined, loc)}</span>
                    ) : (
                      <span>{t('builder.completeSchedule')}</span>
                    )}
                    <span className="ms-1">{t('builder.deviceLocalTime')}</span>
                  </p>
                </div>
              )}

              {trigger.type === 'event' && (
                <p className={HELP}>{t('builder.eventHelp')}</p>
              )}
              {trigger.type === 'manual' && (
                <p className={HELP}>{t('builder.manualHelp')}</p>
              )}
            </section>

            {/* DO */}
            <section aria-labelledby="do-label" className="space-y-3">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <Label id="do-label">{t('builder.do')}</Label>
                  <p className={HELP}>{t('builder.doHelp')}</p>
                </div>
                <div className="inline-flex rounded-md border border-line overflow-hidden shrink-0" role="group" aria-label={t('builder.durationUnit')}>
                  {['min', 's'].map(u => (
                    <button
                      key={u}
                      type="button"
                      onClick={() => setDurUnit(u)}
                      aria-pressed={durUnit === u}
                      className={`min-h-[36px] px-3 text-xs font-semibold ${durUnit === u ? 'bg-ink text-canvas' : 'bg-panel text-muted hover:bg-field'}`}
                    >
                      {u === 'min' ? t('builder.minutes') : t('builder.seconds')}
                    </button>
                  ))}
                </div>
              </div>

              {formData.actions.length === 0 && (
                <p className={`text-sm ${showErrors && errors.actionsEmpty ? 'text-alarm-700 dark:text-alarm-300' : 'text-muted'} border border-dashed border-line rounded-md p-3`}>
                  {t('builder.noActions')}
                </p>
              )}
              <div className="space-y-2">
                {formData.actions.map((a, i) => {
                  const rowProps = { index: i, action: a, onChange: (patch) => updateAction(i, patch), onRemove: () => removeAction(i), error: showErrors ? errors.actions[i] : null };
                  if (a?.type === 'control') return <ControlRow key={i}  {...rowProps} equipment={equipment} equipIndex={equipIndex} durUnit={durUnit} />;
                  if (a?.type === 'alert') return <AlertRow key={i}  {...rowProps} />;
                  if (a?.type === 'log') return <LogRow key={i}  {...rowProps} />;
                  if (a?.type === 'transition') return <TransitionRow key={i}  {...rowProps} equipment={equipment} equipIndex={equipIndex} durUnit={durUnit} />;
                  return (
                    <div key={i} className="rounded-md border border-line bg-panel p-3 flex items-center justify-between gap-2 text-sm text-muted">
                      <span>{t('builder.unknownAction', { type: String(a?.type) })}</span>
                      <RemoveButton onClick={() => removeAction(i)} label={t('builder.control.removeAction', { n: i + 1 })} />
                    </div>
                  );
                })}
              </div>
              {formData.actions.some(a => a?.type === 'control') && (
                <p className={HELP}>{t('builder.timingHelp')}</p>
              )}
              <SequenceTimeline sequence={sequence} />
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="secondary" onClick={() => addAction('control')}>{t('builder.addRelay')}</Button>
                <Button type="button" variant="ghost" onClick={() => addAction('alert')}>{t('builder.addAlert')}</Button>
              </div>
              {formData.actions.length > 0 && (
                <p className={HELP}>{t('builder.readsAs')} <span className="font-mono tabular text-ink">{summary.text}</span></p>
              )}
            </section>

            {/* ADVANCED */}
            <section className="border-t border-line pt-4">
              <button
                type="button"
                onClick={() => setShowAdvanced(o => !o)}
                aria-expanded={showAdvanced}
                aria-controls="automation-advanced"
                className="w-full min-h-touch flex items-center justify-between gap-3 text-start rounded-md hover:bg-field px-2 -mx-2 transition-colors"
              >
                <span>
                  <span className="text-sm font-semibold text-ink">{t('builder.advanced')}</span>
                  <span className="ms-2 text-xs text-muted">{advancedHints.length ? advancedHints.join(' · ') : t('builder.advancedHint')}</span>
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
                        {t('builder.enabled')}
                      </label>
                    </div>
                    <div className="col-span-2 sm:col-span-3">
                      <label className={FIELD_LABEL} htmlFor="priority">{t('builder.priority')}</label>
                      <input id="priority" type="number" dir="ltr" min="0" inputMode="numeric" value={formData.priority} onChange={(e) => setFormData(prev => ({ ...prev, priority: e.target.value }))} className={`${INPUT} font-mono tabular`} />
                      <p className={`${HELP} mt-1`}>{t('builder.priorityHelp')}</p>
                    </div>
                    <div className="col-span-2 sm:col-span-12">
                      <label className={FIELD_LABEL} htmlFor="description">{t('builder.description')}</label>
                      <textarea id="description" rows={2} dir="auto" value={formData.description} onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))} className={`${INPUT} min-h-[64px]`} placeholder={t('builder.descriptionPlaceholder')} />
                    </div>
                  </div>

                  {/* Dose program */}
                  <div>
                    <label className={FIELD_LABEL} htmlFor="dose_program_id">{t('builder.doseProgram')} <span className="font-normal">{t('builder.doseProgramOptional')}</span></label>
                    <select
                      id="dose_program_id"
                      value={formData.dose_program_id || ''}
                      onChange={(e) => setFormData(prev => ({ ...prev, dose_program_id: e.target.value ? parseInt(e.target.value, 10) : null }))}
                      className={INPUT}
                    >
                      <option value="">{t('builder.doseNone')}</option>
                      {dosePrograms.map(p => (
                        <option key={p.id} value={p.id}>
                          {p.name}{p.target_ec ? ` · EC ${p.target_ec}` : ''}{p.compatibility_strategy === 'time_slice' ? ` · ${t('builder.doseTimeSlice')}` : ''}
                        </option>
                      ))}
                      {formData.dose_program_id && !dosePrograms.some(p => p.id === formData.dose_program_id) && (
                        <option value={formData.dose_program_id}>{t('builder.doseNotPublished', { id: formData.dose_program_id })}</option>
                      )}
                    </select>
                    <p className={`${HELP} mt-1`}>{t('builder.doseHelp', { board: DOSE_BOARD })}</p>
                  </div>

                  {/* Timing & gates per action */}
                  <div className="space-y-2">
                    <div>
                      <p className="text-sm font-semibold text-ink">{t('builder.staggerGates')}</p>
                      <p className={HELP}>{t('builder.staggerGatesHelp')}</p>
                    </div>
                    {formData.actions.length === 0 && <p className={HELP}>{t('builder.addActionsFirst')}</p>}
                    {formData.actions.map((a, i) => {
                      if (!a || (a.type !== 'control' && a.type !== 'transition')) return null;
                      const allChannels = a.type === 'control' && (a.channel === null || a.channel === undefined || a.channel === '');
                      const depCount = Array.isArray(a.dependencies) ? a.dependencies.length : 0;
                      return (
                        <div key={i} className="rounded-md border border-line bg-field/40 p-3 space-y-2">
                          <p className="text-xs text-ink truncate"><span className="font-mono tabular text-muted me-2">{i + 1}</span><span dir="auto">{shortActionLabel(a, equipIndex, loc)}</span></p>
                          <div className="grid grid-cols-2 sm:grid-cols-12 gap-2 items-end">
                            {allChannels && (
                              <div className="sm:col-span-3">
                                <label className={FIELD_LABEL} htmlFor={`adv-stagger-${i}`}>{t('builder.stagger')}</label>
                                <input id={`adv-stagger-${i}`} dir="ltr" type="number" min="0" step="0.5" inputMode="decimal" value={a.stagger_delay_seconds ?? ''} onChange={(e) => updateAction(i, { stagger_delay_seconds: e.target.value === '' ? undefined : parseFloat(e.target.value) })} className={`${INPUT_SM} font-mono tabular`} placeholder="0" title={t('builder.staggerTitle')} />
                              </div>
                            )}
                            {a.type === 'transition' && (
                              <div className="sm:col-span-3">
                                <label className={FIELD_LABEL} htmlFor={`adv-revert-${i}`}>{t('builder.autoRevert')}</label>
                                <input id={`adv-revert-${i}`} dir="ltr" type="number" min="0" inputMode="numeric" value={a.duration_seconds ?? ''} onChange={(e) => updateAction(i, { duration_seconds: e.target.value === '' ? null : parseInt(e.target.value, 10) })} className={`${INPUT_SM} font-mono tabular`} placeholder="0" />
                              </div>
                            )}
                            <div className="col-span-2 sm:col-span-3">
                              <Button type="button" variant={depsForAction === i ? 'secondary' : 'ghost'} size="sm" className="w-full min-h-[40px]" onClick={() => setDepsForAction(depsForAction === i ? null : i)} aria-expanded={depsForAction === i}>
                                {t('builder.gates', { n: depCount })}
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
                      <Button type="button" variant="ghost" onClick={() => addAction('transition')}>{t('builder.addTransition')}</Button>
                      <Button type="button" variant="ghost" onClick={() => addAction('log')}>{t('builder.addLog')}</Button>
                    </div>
                  </div>

                  {/* Conditions (dry-run only) */}
                  <div className="space-y-2">
                    <div>
                      <p className="text-sm font-semibold text-ink">{t('builder.conditions')} <span className="font-normal text-muted">{t('builder.dryRunOnly')}</span></p>
                      <p className={HELP}>{t('builder.conditionsHelp')}</p>
                    </div>
                    {formData.conditions.length >= 1 && (
                      <div className="flex flex-wrap items-center gap-4 text-sm text-ink">
                        {['AND', 'OR'].map(l => (
                          <label key={l} className="inline-flex items-center gap-2 min-h-[36px]">
                            <input type="radio" name="condition_logic" value={l} checked={formData.condition_logic === l} onChange={() => setFormData(prev => ({ ...prev, condition_logic: l }))} />
                            <span><strong lang="en">{l}</strong> — {l === 'AND' ? t('builder.logicAnd') : t('builder.logicOr')}</span>
                          </label>
                        ))}
                      </div>
                    )}
                    {formData.conditions.length > 0 && (
                      <ul className="space-y-1">
                        {formData.conditions.map((c, i) => (
                          <li key={i} className="flex items-center gap-2 bg-panel border border-line rounded-md px-2 py-1 text-sm">
                            <span className="text-ink" dir="auto">{c.field}</span>
                            <span className="font-mono tabular text-muted" dir="ltr">{OP_SYM[c.operator] || c.operator} {c.value}</span>
                            <button type="button" onClick={() => removeCondition(i)} className={`${ICON_BUTTON} ms-auto`} aria-label={t('builder.removeCondition', { n: i + 1 })}><CloseIcon /></button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="grid grid-cols-2 sm:grid-cols-12 gap-2 items-end">
                      <div className="col-span-2 sm:col-span-5">
                        <label className={FIELD_LABEL} htmlFor="cond-field">{t('builder.field')}</label>
                        <input id="cond-field" type="text" dir="ltr" value={conditionField} onChange={(e) => setConditionField(e.target.value)} className={INPUT_SM} placeholder={t('builder.fieldPlaceholder')} />
                      </div>
                      <div className="sm:col-span-2">
                        <label className={FIELD_LABEL} htmlFor="cond-op">{t('builder.op')}</label>
                        <select id="cond-op" value={conditionOperator} onChange={(e) => setConditionOperator(e.target.value)} className={`${INPUT_SM} font-mono`}>
                          <option value="eq">=</option><option value="neq">≠</option><option value="gt">&gt;</option><option value="gte">≥</option><option value="lt">&lt;</option><option value="lte">≤</option>
                        </select>
                      </div>
                      <div className="sm:col-span-3">
                        <label className={FIELD_LABEL} htmlFor="cond-val">{t('builder.value')}</label>
                        <input id="cond-val" type="text" dir="ltr" value={conditionValue} onChange={(e) => setConditionValue(e.target.value)} className={`${INPUT_SM} font-mono tabular`} placeholder="30" />
                      </div>
                      <div className="col-span-2 sm:col-span-2">
                        <Button type="button" variant="secondary" size="sm" className="w-full min-h-[40px]" onClick={addCondition}>{t('common:actions.add')}</Button>
                      </div>
                    </div>
                  </div>

                  {/* Skip conditions (read-only: the API does not accept them from the UI) */}
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-ink">{t('builder.skipConditions')} <span className="font-normal text-muted">{t('builder.readOnly')}</span></p>
                    <p className={HELP}>{t('builder.skipHelp')}</p>
                    {formData.skip_conditions.length === 0 ? (
                      <p className="text-sm text-muted">{t('builder.none')}</p>
                    ) : (
                      <ul className="space-y-1">
                        {formData.skip_conditions.map((c, i) => (
                          <li key={i} className="text-sm bg-panel border border-line rounded-md px-2 py-1">
                            <span className="text-ink" dir="auto">{equipmentLabel(equipIndex, c.sensor_equipment_id, loc)} / {c.sensor_metric || t('builder.valueFallback')}</span>{' '}
                            <span className="font-mono tabular text-muted" dir="ltr">{OP_SYM[c.operator] || c.operator} {c.value}</span>
                            {c.reason && <span className="text-muted" dir="auto"> — {c.reason}</span>}
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
                    {testing ? t('builder.testing') : t('builder.test')}
                  </Button>
                )}
              </div>
              <div className="flex flex-col-reverse sm:flex-row gap-2">
                <Button type="button" variant="ghost" onClick={onClose} disabled={saving} className="w-full sm:w-auto">{t('common:actions.cancel')}</Button>
                <Button type="submit" variant="primary" disabled={saving} className="w-full sm:w-auto">
                  {saving ? t('common:actions.saving') : isNew ? t('builder.create') : t('builder.saveChanges')}
                </Button>
              </div>
            </div>
          </form>

          {/* Test results, inline (no nested scroll) */}
          {testResult && (
            <div className="border-t border-line px-4 py-4 sm:px-6 space-y-3" aria-live="polite">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-ink">{t('builder.testResults')}</p>
                  <p className={HELP} dir="auto">{testResult.mode}</p>
                </div>
                <Button type="button" variant="ghost" size="sm" onClick={() => setTestResult(null)}>{t('builder.hide')}</Button>
              </div>
              <div dir="auto" className={`p-3 rounded-md border border-s-[3px] text-sm ${testResult.status === 'success' ? 'border-ok-300 border-s-state-ok bg-ok-50 text-ok-700 dark:bg-ok-900/30 dark:border-ok-700 dark:text-ok-300' : 'border-caution-300 border-s-state-caution bg-caution-50 text-caution-700 dark:bg-caution-900/30 dark:border-caution-700 dark:text-caution-300'}`}>
                {testResult.message}
              </div>
              <div className="grid grid-cols-3 gap-2">
                {[[t('builder.testConditions'), testResult.summary?.conditions_evaluated || 0], [t('builder.testActions'), testResult.summary?.total_actions || 0], [t('builder.wouldExecuteCount'), testResult.summary?.actions_to_execute || 0]].map(([label, v]) => (
                  <div key={label} className="bg-field/60 border border-line rounded-md p-2 text-center">
                    <p className="text-xl font-mono tabular text-ink">{v}</p>
                    <p className={HELP}>{label}</p>
                  </div>
                ))}
              </div>
              {testResult.trigger && (
                <div className="text-sm text-ink bg-field/60 border border-line rounded-md p-3 space-y-0.5">
                  <p><span className="text-muted">{t('builder.testTrigger')}</span> {t(`trigger.${testResult.trigger.type}`, { defaultValue: testResult.trigger.type })} — {t('builder.wouldFire')} <span className="font-mono tabular">{testResult.trigger.would_fire ? t('common:actions.yes') : t('common:actions.no')}</span></p>
                  {testResult.trigger.details && Object.entries(testResult.trigger.details).map(([k, v]) => (
                    <p key={k}><span className="text-muted">{k.replace(/_/g, ' ')}:</span> {String(v)}</p>
                  ))}
                </div>
              )}
              {Array.isArray(testResult.conditions) && testResult.conditions.length > 0 && (
                <ul className="space-y-1">
                  {testResult.conditions.map((c) => (
                    <li key={c.index} className={`text-sm rounded-md border border-s-[3px] p-2 ${c.would_pass ? 'border-ok-300 border-s-state-ok' : c.would_pass === false ? 'border-alarm-300 border-s-state-alarm' : 'border-line border-s-state-idle'}`}>
                      <span className="text-ink">{c.field}</span> <span className="font-mono tabular text-muted">{c.operator} {c.expected_value}</span> <span className="text-muted">({c.test_result})</span>
                    </li>
                  ))}
                </ul>
              )}
              {Array.isArray(testResult.actions) && testResult.actions.length > 0 && (
                <ul className="space-y-1">
                  {testResult.actions.map((a) => (
                    <li key={a.index} className={`text-sm rounded-md border border-s-[3px] p-2 ${a.would_execute ? 'border-line border-s-state-ok' : 'border-line border-s-state-idle'}`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold uppercase tracking-label text-muted">{a.type}</span>
                        <span className={`text-xs ${a.would_execute ? 'text-ok-700 dark:text-ok-300' : 'text-muted'}`}>{a.would_execute ? t('builder.wouldExecute') : t('builder.wouldNotExecute')}</span>
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
