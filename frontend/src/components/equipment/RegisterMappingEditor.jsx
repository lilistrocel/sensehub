import React, { useRef } from 'react';
import { Button, Label } from '../../ui';
import InterlockBadge from '../InterlockBadge';
import { getChannelDisplayName, getInterlockPartner, getInterlockPartnerLabel, applyInterlockChange } from '../../utils/channelUtils';
import { REGISTER_PRESETS, defaultQuantityForType, newMapping, normalizeImportedMappings } from './registerPresets';
import { UnverifiedPill } from './equipmentStatus';

/**
 * The ONE register-mapping editor, used by both the add and the edit
 * equipment forms.
 *
 * Props:
 *   mappings   array of mapping objects (controlled)
 *   onChange   (nextMappings) => void
 *   protocol   'modbus' | ... (editor renders nothing unless modbus)
 *   readOnly   boolean - every control disabled, no add/remove/import
 *   name       optional equipment name, used for the export file name
 *
 * >= md: a table (enabled, name/label, register, FC, data type, scale, offset,
 * unit, access, interlock, unverified). < md: stacked cards with the same
 * fields. Every field the previous inline editors had is kept: quantity
 * (words) and byte order for 32-bit values, the coil `enabled` flag,
 * `interlockWith` kept symmetric via channelUtils, and the new `unverified`
 * flag ("scale/register inferred, not confirmed by test").
 */

const TYPE_OPTIONS = [
  { value: 'holding', label: 'Holding (FC03)' },
  { value: 'input', label: 'Input (FC04)' },
  { value: 'coil', label: 'Coil (FC01)' },
  { value: 'discrete', label: 'Discrete (FC02)' },
];
const DATA_TYPE_OPTIONS = [
  { value: 'uint16', label: 'UInt16' },
  { value: 'int16', label: 'Int16' },
  { value: 'uint32', label: 'UInt32' },
  { value: 'int32', label: 'Int32' },
  { value: 'float32', label: 'Float32' },
  { value: 'bool', label: 'Boolean' },
];
const ACCESS_OPTIONS = [
  { value: 'read', label: 'Read only' },
  { value: 'write', label: 'Write only' },
  { value: 'readwrite', label: 'Read/Write' },
];
const BYTE_ORDER_OPTIONS = ['ABCD', 'CDAB', 'BADC', 'DCBA'];
const BYTE_ORDER_TITLE = 'Byte/word order for 32-bit and float32 values (ignored for 16-bit/bool). ABCD = high word first (big-endian); CDAB = word swap; BADC = byte swap; DCBA = full reverse';
const INTERLOCK_TITLE = 'Hard interlock: the two channels can never be ON at the same time. Energising one first switches the other OFF (verified by read-back).';
const UNVERIFIED_TITLE = 'Unverified: scale/register inferred from a datasheet, not confirmed by a controlled read against a reference.';
const QTY_TITLE = 'Number of 16-bit registers to read (auto-set from data type: 1 for 16-bit/bool, 2 for 32-bit)';

const is32 = (dataType) => dataType === 'uint32' || dataType === 'int32' || dataType === 'float32';

// Compact field classes: the table is dense, so inputs are xs with tight
// padding; the global :where() field styling supplies bg/border/colour.
const CELL_INPUT = 'w-full min-w-0 !px-1.5 !py-1 !text-xs !leading-4 disabled:opacity-60';
const CARD_INPUT = 'w-full min-w-0 !px-2 !py-1.5 !text-sm disabled:opacity-60';

function numOrEmpty(v) {
  return v === '' ? '' : Number(v);
}

export default function RegisterMappingEditor({ mappings = [], onChange, protocol = 'modbus', readOnly = false, name = '' }) {
  const fileInputRef = useRef(null);
  const list = Array.isArray(mappings) ? mappings : [];

  if (protocol && protocol !== 'modbus') return null;

  const emit = (next) => { if (!readOnly && typeof onChange === 'function') onChange(next); };

  const update = (index, field, value) => {
    if (field === 'interlockWith') {
      emit(applyInterlockChange(list, index, value));
      return;
    }
    const next = list.map((m, i) => {
      if (i !== index) return m;
      const row = { ...m, [field]: value };
      if (field === 'dataType') row.quantity = defaultQuantityForType(value);
      if (field === 'unverified' && !value) delete row.unverified;
      return row;
    });
    emit(next);
  };

  const add = () => emit([...list, newMapping()]);
  const remove = (index) => emit(list.filter((_, i) => i !== index));

  const loadPreset = (key) => {
    if (!key || !REGISTER_PRESETS[key]) return;
    emit(REGISTER_PRESETS[key].mappings.map(m => ({ ...m })));
  };

  const exportMappings = () => {
    if (list.length === 0) return;
    const exportData = { version: '1.0', exported_at: new Date().toISOString(), mappings: list };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `register-mappings-${name || 'export'}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const importMappings = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const valid = normalizeImportedMappings(JSON.parse(e.target.result));
        if (valid) emit(valid);
        else console.error('Invalid register mappings format');
      } catch (err) {
        console.error('Failed to parse imported file:', err);
      }
    };
    reader.readAsText(file);
    event.target.value = '';
  };

  const interlockOptions = (index, mapping) => list
    .map((m, i) => ({ m, i }))
    .filter(({ m, i }) => i !== index && m.type === 'coil' && String(m.register ?? '') !== '' && String(m.register) !== String(mapping.register))
    .map(({ m, i }) => (
      <option key={i} value={m.register}>{getChannelDisplayName(m)} (reg {m.register})</option>
    ));

  // ---- field renderers (shared by table + cards) ----
  const F = (index, mapping, inputCls) => ({
    enabled: (
      <input
        type="checkbox"
        checked={mapping.enabled !== false}
        disabled={readOnly}
        onChange={(e) => update(index, 'enabled', e.target.checked)}
        title={mapping.enabled !== false ? 'Reading enabled' : 'Reading disabled (polling skips it)'}
        aria-label="Enabled"
        className="h-4 w-4"
      />
    ),
    name: (
      <input type="text" placeholder="Name (metric key)" value={mapping.name || ''} disabled={readOnly}
        onChange={(e) => update(index, 'name', e.target.value)} className={inputCls} aria-label="Name" />
    ),
    label: (
      <input type="text" placeholder="Label (e.g. Water Pump)" value={mapping.label || ''} disabled={readOnly}
        onChange={(e) => update(index, 'label', e.target.value)} className={inputCls} aria-label="Label" />
    ),
    register: (
      <input type="number" placeholder="Reg #" value={mapping.register ?? ''} disabled={readOnly}
        onChange={(e) => update(index, 'register', e.target.value)} className={`${inputCls} font-mono`} aria-label="Register" />
    ),
    quantity: (
      <input type="number" placeholder="Qty" value={mapping.quantity ?? defaultQuantityForType(mapping.dataType)} disabled={readOnly}
        onChange={(e) => update(index, 'quantity', numOrEmpty(e.target.value))} className={`${inputCls} font-mono`} title={QTY_TITLE} aria-label="Quantity (words)" />
    ),
    type: (
      <select value={mapping.type || 'holding'} disabled={readOnly} onChange={(e) => update(index, 'type', e.target.value)} className={inputCls} aria-label="Register type / function code">
        {TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    ),
    dataType: (
      <select value={mapping.dataType || 'uint16'} disabled={readOnly} onChange={(e) => update(index, 'dataType', e.target.value)} className={inputCls} aria-label="Data type">
        {DATA_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    ),
    byteOrder: (
      <select value={mapping.byteOrder || 'ABCD'} disabled={readOnly} onChange={(e) => update(index, 'byteOrder', e.target.value)} className={inputCls} title={BYTE_ORDER_TITLE} aria-label="Byte order">
        {BYTE_ORDER_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    ),
    scale: (
      <input type="number" step="any" placeholder="×1" value={mapping.scale ?? 1} disabled={readOnly}
        onChange={(e) => update(index, 'scale', numOrEmpty(e.target.value))} className={`${inputCls} font-mono`} title="Multiplier applied to the raw value" aria-label="Scale" />
    ),
    offset: (
      <input type="number" step="any" placeholder="+0" value={mapping.offset ?? 0} disabled={readOnly}
        onChange={(e) => update(index, 'offset', numOrEmpty(e.target.value))} className={`${inputCls} font-mono`} title="Value added after scaling" aria-label="Offset" />
    ),
    unit: (
      <input type="text" placeholder="unit" value={mapping.unit || ''} disabled={readOnly}
        onChange={(e) => update(index, 'unit', e.target.value)} className={inputCls} aria-label="Unit" />
    ),
    access: (
      <select value={mapping.access || 'read'} disabled={readOnly} onChange={(e) => update(index, 'access', e.target.value)} className={inputCls} aria-label="Access">
        {ACCESS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    ),
    interlock: mapping.type === 'coil' ? (
      <div className="flex items-center gap-1 min-w-0" title={INTERLOCK_TITLE}>
        {getInterlockPartner(list, mapping.register) !== null && (
          <InterlockBadge partnerLabel={getInterlockPartnerLabel(list, mapping.register)} />
        )}
        <select
          value={getInterlockPartner(list, mapping.register) ?? ''}
          disabled={readOnly}
          onChange={(e) => update(index, 'interlockWith', e.target.value)}
          className={inputCls}
          aria-label="Interlock with"
        >
          <option value="">None</option>
          {interlockOptions(index, mapping)}
        </select>
      </div>
    ) : (
      <span className="text-xs text-muted" aria-hidden="true">&mdash;</span>
    ),
    unverified: (
      <input
        type="checkbox"
        checked={mapping.unverified === true}
        disabled={readOnly}
        onChange={(e) => update(index, 'unverified', e.target.checked)}
        title={UNVERIFIED_TITLE}
        aria-label="Unverified: scale/register inferred, not confirmed by test"
        className="h-4 w-4 accent-caution-500"
      />
    ),
    remove: !readOnly && (
      <button
        type="button"
        onClick={() => remove(index)}
        aria-label={`Remove mapping ${index + 1}`}
        title="Remove mapping"
        className="inline-flex items-center justify-center h-8 w-8 rounded-md text-muted hover:text-alarm-600 hover:bg-alarm-50 dark:hover:text-alarm-300 dark:hover:bg-alarm-900/30"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
      </button>
    ),
  });

  const rowRail = (mapping) => (mapping.unverified ? 'border-l-[3px] border-l-state-caution' : 'border-l-[3px] border-l-transparent');
  const rowDim = (mapping) => (mapping.enabled === false ? 'opacity-60' : '');

  return (
    <div data-testid="register-mapping-editor">
      {/* Toolbar: preset FIRST, import/export beside it, add on the right */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <Label as="span" className="w-full sm:w-auto sm:mr-1">Register mappings</Label>
        {!readOnly && (
          <>
            <select
              defaultValue=""
              onChange={(e) => { loadPreset(e.target.value); e.target.value = ''; }}
              className="!py-1.5 !text-sm min-h-[36px]"
              aria-label="Load preset"
            >
              <option value="">Load preset…</option>
              {Object.entries(REGISTER_PRESETS).map(([key, preset]) => (
                <option key={key} value={key}>{preset.name}</option>
              ))}
            </select>
            <input type="file" ref={fileInputRef} onChange={importMappings} accept=".json" className="hidden" />
            <Button variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()} title="Import mappings from JSON">Import</Button>
          </>
        )}
        <Button variant="ghost" size="sm" onClick={exportMappings} disabled={list.length === 0} title="Export mappings to JSON">Export</Button>
        {!readOnly && (
          <Button variant="secondary" size="sm" onClick={add} className="ml-auto">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add mapping
          </Button>
        )}
      </div>

      {list.length === 0 ? (
        <p className="text-sm text-muted italic py-2">
          No register mappings defined. {readOnly ? '' : 'Load a preset, import JSON, or add a mapping manually.'}
        </p>
      ) : (
        <>
          {/* >= md: table */}
          <div className="hidden md:block border border-line rounded-card">
            <table className="w-full table-fixed border-collapse text-xs">
              <colgroup>
                <col style={{ width: '30px' }} />
                <col style={{ width: '134px' }} />
                <col style={{ width: '60px' }} />
                <col style={{ width: '96px' }} />
                <col style={{ width: '86px' }} />
                <col style={{ width: '54px' }} />
                <col style={{ width: '54px' }} />
                <col style={{ width: '50px' }} />
                <col style={{ width: '86px' }} />
                <col />
                <col style={{ width: '36px' }} />
                {!readOnly && <col style={{ width: '36px' }} />}
              </colgroup>
              <thead className="bg-field">
                <tr>
                  <th className="px-1 py-2 text-center" title="Enabled">On</th>
                  <th className="px-1 py-2 text-left">Name / Label</th>
                  <th className="px-1 py-2 text-left" title="Register address and quantity (words)">Reg · Qty</th>
                  <th className="px-1 py-2 text-left">FC</th>
                  <th className="px-1 py-2 text-left" title="Data type and byte order (32-bit only)">Data type</th>
                  <th className="px-1 py-2 text-left">Scale</th>
                  <th className="px-1 py-2 text-left">Offset</th>
                  <th className="px-1 py-2 text-left">Unit</th>
                  <th className="px-1 py-2 text-left">Access</th>
                  <th className="px-1 py-2 text-left">Interlock</th>
                  <th className="px-1 py-2 text-center" title={UNVERIFIED_TITLE}>Unv.</th>
                  {!readOnly && <th className="px-1 py-2"><span className="sr-only">Remove</span></th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {list.map((mapping, index) => {
                  const f = F(index, mapping, CELL_INPUT);
                  return (
                    <tr key={index} className={`align-top ${rowDim(mapping)}`} data-unverified={mapping.unverified ? 'true' : undefined}>
                      <td className={`px-1 py-1.5 text-center ${rowRail(mapping)}`}>
                        <div className="flex flex-col items-center gap-1 pt-1">
                          {f.enabled}
                          {mapping.unverified && <UnverifiedPill className="!px-1 !text-[8px]" />}
                        </div>
                      </td>
                      <td className="px-1 py-1.5">
                        <div className="flex flex-col gap-1">{f.name}{f.label}</div>
                      </td>
                      <td className="px-1 py-1.5">
                        <div className="flex flex-col gap-1">{f.register}{f.quantity}</div>
                      </td>
                      <td className="px-1 py-1.5">{f.type}</td>
                      <td className="px-1 py-1.5">
                        <div className="flex flex-col gap-1">
                          {f.dataType}
                          {is32(mapping.dataType) && f.byteOrder}
                        </div>
                      </td>
                      <td className="px-1 py-1.5">{f.scale}</td>
                      <td className="px-1 py-1.5">{f.offset}</td>
                      <td className="px-1 py-1.5">{f.unit}</td>
                      <td className="px-1 py-1.5">{f.access}</td>
                      <td className="px-1 py-1.5">{f.interlock}</td>
                      <td className="px-1 py-1.5 text-center"><div className="pt-1">{f.unverified}</div></td>
                      {!readOnly && <td className="px-0.5 py-1 text-center">{f.remove}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* < md: stacked cards */}
          <div className="md:hidden space-y-3">
            {list.map((mapping, index) => {
              const f = F(index, mapping, CARD_INPUT);
              return (
                <div
                  key={index}
                  className={`bg-field border border-line rounded-card p-3 ${rowRail(mapping)} ${rowDim(mapping)}`}
                  data-unverified={mapping.unverified ? 'true' : undefined}
                >
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <label className="flex items-center gap-2 text-xs text-muted min-h-[32px]">
                      {f.enabled}
                      <span>Mapping #{index + 1}</span>
                      {mapping.unverified && <UnverifiedPill />}
                    </label>
                    {f.remove}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="col-span-2">{f.name}</div>
                    <div className="col-span-2">{f.label}</div>
                    <div>{f.register}</div>
                    <div>{f.type}</div>
                    <div>{f.dataType}</div>
                    <div>{f.quantity}</div>
                    <div>{f.scale}</div>
                    <div>{f.offset}</div>
                    <div>{f.unit}</div>
                    <div>{f.access}</div>
                    {is32(mapping.dataType) && <div className="col-span-2">{f.byteOrder}</div>}
                    {mapping.type === 'coil' && (
                      <div className="col-span-2 flex items-center gap-2">
                        <span className="text-xs text-muted whitespace-nowrap">Interlock with</span>
                        <div className="flex-1 min-w-0">{f.interlock}</div>
                      </div>
                    )}
                    <label className="col-span-2 flex items-center gap-2 text-xs text-muted min-h-[32px]" title={UNVERIFIED_TITLE}>
                      {f.unverified}
                      <span>Unverified — scale/register inferred, not confirmed by test</span>
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
