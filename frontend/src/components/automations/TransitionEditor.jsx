import React from 'react';
import { getChannelDisplayName, getInterlockPairs, getInterlockPartnerLabel } from '../../utils/channelUtils';
import InterlockBadge from '../InterlockBadge';
import { parseRegisterMappings } from './automationSummary';
import { INPUT_SM, FIELD_LABEL, HELP } from './formStyles';

/**
 * Inline editor for atomic transition actions (FC15 - Write Multiple Coils).
 * `states` is { [coilAddress]: true | false } (absent = leave alone).
 * `showTiming` renders the delay / auto-revert inputs (the automation builder
 * keeps those under its Advanced section and passes false).
 */
export default function TransitionEditor({
  equipment, equipmentId, setEquipmentId, states, setStates,
  delay, setDelay, duration, setDuration, showTiming = true,
}) {
  const relays = equipment.filter(e => parseRegisterMappings(e).some(x => x.type === 'coil' && x.access === 'readwrite'));
  const selectedEq = relays.find(eq => eq.id === parseInt(equipmentId, 10));
  const coils = parseRegisterMappings(selectedEq)
    .filter(m => m.type === 'coil' && m.access === 'readwrite')
    .sort((a, b) => (a.register ?? a.address) - (b.register ?? b.address));

  const setCoil = (addr, val) => setStates({ ...states, [addr]: val });
  const clearCoil = (addr) => {
    const next = { ...states };
    delete next[addr];
    setStates(next);
  };

  // Interlocked pairs where this frame would energise both: the backend
  // rejects such a save (400); warn inline before the user gets that far.
  const findCoil = (reg) => coils.find(c => (c.register ?? c.address) == reg) || {};
  const interlockConflicts = getInterlockPairs(selectedEq?.register_mappings)
    .filter(([a, b]) => states[a] === true && states[b] === true)
    .map(([a, b]) => `${getChannelDisplayName(findCoil(a))} (ch ${a}) and ${getChannelDisplayName(findCoil(b))} (ch ${b})`);

  const segBtn = (active, tone) => `flex-1 min-h-[40px] px-2 text-xs font-semibold rounded-md border transition-colors ${
    active
      ? tone === 'on'
        ? 'bg-ok-100 text-ok-700 border-ok-300 dark:bg-ok-900/40 dark:text-ok-300 dark:border-ok-700'
        : tone === 'off'
          ? 'bg-ink text-canvas border-ink'
          : 'bg-field text-ink border-line'
      : 'bg-panel text-muted border-line hover:bg-field'
  }`;

  return (
    <div className="w-full bg-field/60 border border-line rounded-md p-3 space-y-3">
      <p className={HELP}>All selected coils flip in a single Modbus frame, so there is no timing drift between channels.</p>

      <div className={`grid grid-cols-1 ${showTiming ? 'sm:grid-cols-3' : ''} gap-3`}>
        <div>
          <label className={FIELD_LABEL}>Relay board</label>
          <select value={equipmentId} onChange={e => { setEquipmentId(e.target.value); setStates({}); }} className={INPUT_SM}>
            <option value="">Select relay equipment...</option>
            {relays.map(eq => <option key={eq.id} value={eq.id}>{eq.name}</option>)}
          </select>
        </div>
        {showTiming && (
          <>
            <div>
              <label className={FIELD_LABEL}>Delay (s, optional)</label>
              <input type="number" min="0" inputMode="numeric" value={delay} onChange={e => setDelay(e.target.value)} placeholder="0" className={INPUT_SM} />
            </div>
            <div>
              <label className={FIELD_LABEL}>Auto-revert OFF (s, optional)</label>
              <input type="number" min="0" inputMode="numeric" value={duration} onChange={e => setDuration(e.target.value)} placeholder="0" className={INPUT_SM} />
            </div>
          </>
        )}
      </div>

      {interlockConflicts.length > 0 && (
        <div role="alert" className="p-2 rounded-md border border-alarm-300 border-l-[3px] border-l-state-alarm bg-alarm-50 text-alarm-700 dark:bg-alarm-900/30 dark:border-alarm-700 dark:text-alarm-300 text-xs">
          Interlock: {interlockConflicts.join('; ')} can never be ON at the same time. This transition will be rejected.
        </div>
      )}

      {coils.length > 0 && (
        <div>
          <p className={`${FIELD_LABEL} mb-2`}>Channels: pick the target state for each (— = leave alone)</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {coils.map(c => {
              const addr = c.register ?? c.address;
              const current = states[addr];
              const partner = getInterlockPartnerLabel(selectedEq?.register_mappings, addr);
              return (
                <div key={addr} className="bg-panel border border-line rounded-md p-2">
                  <p className="text-xs font-semibold text-ink truncate flex items-center gap-1" title={getChannelDisplayName(c)}>
                    <span className="truncate">{getChannelDisplayName(c)}</span>
                    {partner && <InterlockBadge partnerLabel={partner} />}
                  </p>
                  <p className="text-[10px] font-mono tabular text-muted">ch {addr}</p>
                  <div className="flex gap-1 mt-1">
                    <button type="button" onClick={() => setCoil(addr, true)} className={segBtn(current === true, 'on')} aria-pressed={current === true}>ON</button>
                    <button type="button" onClick={() => setCoil(addr, false)} className={segBtn(current === false, 'off')} aria-pressed={current === false}>OFF</button>
                    <button type="button" onClick={() => clearCoil(addr)} className={segBtn(current === undefined, 'skip')} aria-pressed={current === undefined} aria-label="Leave alone">—</button>
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
