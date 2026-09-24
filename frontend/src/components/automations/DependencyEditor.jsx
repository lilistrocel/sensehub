import React, { useState } from 'react';
import { Button } from '../../ui';
import { parseRegisterMappings, OP_SYM } from './automationSummary';
import { INPUT_SM, FIELD_LABEL, HELP, ICON_BUTTON } from './formStyles';

/**
 * Inline editor for per-action dependencies (runtime gates evaluated by the
 * executor: calibrated sensor / raw sensor / latest lab reading).
 */
export default function DependencyEditor({ action, equipmentList, onChange, onClose }) {
  const deps = Array.isArray(action.dependencies) ? action.dependencies : [];
  const [newDep, setNewDep] = useState({
    type: 'calibrated_sensor',
    equipment_id: '',
    metric: '',
    nutrient: 'EC',
    operator: 'lt',
    value: '',
    max_age_minutes: 30,
    zone_id: '',
  });

  const sensors = equipmentList.filter(e => e.type !== 'relay');
  const selectedEq = sensors.find(e => e.id === parseInt(newDep.equipment_id, 10));
  const availableMetrics = parseRegisterMappings(selectedEq).filter(x => x.type !== 'coil').map(x => x.name);

  const addDep = () => {
    if (newDep.type === 'lab_reading') {
      if (!newDep.nutrient || newDep.value === '') return;
    } else if (!newDep.equipment_id || !newDep.metric || newDep.value === '') {
      return;
    }
    const dep = { ...newDep, value: parseFloat(newDep.value), max_age_minutes: parseInt(newDep.max_age_minutes, 10) || null };
    if (dep.equipment_id) dep.equipment_id = parseInt(dep.equipment_id, 10);
    if (dep.zone_id) dep.zone_id = parseInt(dep.zone_id, 10); else delete dep.zone_id;
    onChange([...deps, dep]);
    setNewDep({ ...newDep, value: '' });
  };

  const removeDep = (i) => onChange(deps.filter((_, idx) => idx !== i));

  return (
    <div className="bg-field/60 border border-line rounded-md p-3 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-ink">Dependencies (runtime gates)</p>
          <p className={HELP}>The action only fires when ALL of these pass at run time. Use "calibrated sensor" for EC.</p>
        </div>
        {onClose && (
          <button type="button" onClick={onClose} className={ICON_BUTTON} aria-label="Close dependency editor">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        )}
      </div>

      {deps.length > 0 && (
        <ul className="space-y-1">
          {deps.map((d, i) => (
            <li key={i} className="flex items-center gap-2 bg-panel px-2 py-1 rounded-md text-xs border border-line">
              <span className="px-1.5 py-0.5 rounded bg-field text-muted font-semibold">{String(d.type || '').replace('_', ' ')}</span>
              <span className="text-ink truncate">
                {d.equipment_id ? `${sensors.find(s => s.id === d.equipment_id)?.name || `#${d.equipment_id}`} / ` : ''}{d.metric || d.nutrient}
              </span>
              <span className="font-mono tabular text-muted">{OP_SYM[d.operator] || d.operator} {d.value}</span>
              {d.max_age_minutes && <span className="text-muted">(≤{d.max_age_minutes} min old)</span>}
              <button type="button" onClick={() => removeDep(i)} className={`${ICON_BUTTON} ml-auto`} aria-label="Remove dependency">
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 items-end">
        <div className="col-span-2 sm:col-span-2">
          <label className={FIELD_LABEL}>Source</label>
          <select value={newDep.type} onChange={e => setNewDep({ ...newDep, type: e.target.value })} className={INPUT_SM}>
            <option value="calibrated_sensor">Calibrated sensor</option>
            <option value="sensor">Raw sensor</option>
            <option value="lab_reading">Latest lab reading</option>
          </select>
        </div>
        {(newDep.type === 'sensor' || newDep.type === 'calibrated_sensor') && (
          <>
            <div className="col-span-2">
              <label className={FIELD_LABEL}>Equipment</label>
              <select value={newDep.equipment_id} onChange={e => setNewDep({ ...newDep, equipment_id: e.target.value, metric: '' })} className={INPUT_SM}>
                <option value="">Select...</option>
                {sensors.map(eq => <option key={eq.id} value={eq.id}>{eq.name}</option>)}
              </select>
            </div>
            <div className="col-span-2">
              <label className={FIELD_LABEL}>Metric</label>
              <select value={newDep.metric} onChange={e => setNewDep({ ...newDep, metric: e.target.value })} className={INPUT_SM}>
                <option value="">Select...</option>
                {availableMetrics.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </>
        )}
        {newDep.type === 'lab_reading' && (
          <div className="col-span-2">
            <label className={FIELD_LABEL}>Nutrient</label>
            <select value={newDep.nutrient} onChange={e => setNewDep({ ...newDep, nutrient: e.target.value })} className={INPUT_SM}>
              <option value="EC">EC</option>
              <option value="pH">pH</option>
              <option value="nitrate_NO3">Nitrate</option>
              <option value="phosphate_PO4">Phosphate</option>
              <option value="potassium_K">Potassium</option>
            </select>
          </div>
        )}
        <div>
          <label className={FIELD_LABEL}>Op</label>
          <select value={newDep.operator} onChange={e => setNewDep({ ...newDep, operator: e.target.value })} className={INPUT_SM}>
            <option value="lt">&lt;</option>
            <option value="lte">≤</option>
            <option value="gt">&gt;</option>
            <option value="gte">≥</option>
            <option value="eq">=</option>
            <option value="neq">≠</option>
          </select>
        </div>
        <div>
          <label className={FIELD_LABEL}>Value</label>
          <input type="number" step="any" inputMode="decimal" value={newDep.value} onChange={e => setNewDep({ ...newDep, value: e.target.value })} placeholder="2500" className={INPUT_SM} />
        </div>
        <div>
          <label className={FIELD_LABEL}>Max age (min)</label>
          <input type="number" min="1" inputMode="numeric" value={newDep.max_age_minutes} onChange={e => setNewDep({ ...newDep, max_age_minutes: e.target.value })} className={INPUT_SM} />
        </div>
        <div>
          <Button type="button" variant="secondary" size="sm" onClick={addDep} className="w-full min-h-[40px]">Add gate</Button>
        </div>
      </div>
    </div>
  );
}
