import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, StatusPill } from '../../ui';
import ConfirmDialog from '../ConfirmDialog';
import InterlockBadge, { ALL_ON_INTERLOCK_TITLE } from '../InterlockBadge';
import { useSettings } from '../../context/SettingsContext';
import { useWebSocket } from '../../context/WebSocketContext';
import { useToast } from '../../context/ToastContext';
import { usePendingRelayCommands, relayKey } from '../../hooks/usePendingRelayCommands';
import { getChannelDisplayName, getInterlockPartnerLabel, hasInterlockPair } from '../../utils/channelUtils';
import ModalShell, { InlineNotice, Spinner } from './ModalShell';
import {
  getCoilChannels, getEquipmentPresentation, parseCachedRelayStates, useNow, RelayLed, UnverifiedPill, isEquipmentDisabled
} from './equipmentStatus';

const UNCONFIRMED_TOAST = 'Written but not confirmed — check the board';
const VIEWER_TITLE = 'Requires operator or admin';

function parseModbusAddress(address) {
  if (!address) return null;
  const match = String(address).match(/^([^:]+):(\d+)$/);
  if (match) return { host: match[1], port: parseInt(match[2], 10) };
  return { host: address, port: 502 };
}

/**
 * Relay control for a Modbus coil board. A relay state is what the coil
 * read-back says, never what we commanded: each channel renders a filled LED
 * (on), hollow LED (off) or dashed LED (unknown) - unknown whenever the board
 * is write-only, disabled, offline, stale, or the read failed. Commands are
 * pending (amber ring) until a confirmed `relay_state_changed` arrives.
 */
export default function RelayControlModal({ isOpen, onClose, equipment, token, user, onUpdate }) {
  const { formatDateTime, formatTime } = useSettings();
  const { subscribe } = useWebSocket();
  const { showWarning, showError } = useToast();
  const { markPending, getPending, clearPending } = usePendingRelayCommands(subscribe);
  const now = useNow(15000);

  const [confirmAll, setConfirmAll] = useState(null); // true | false | null
  const [loading, setLoading] = useState(false);
  // address -> true | false | null (null = unknown)
  const [states, setStates] = useState({});
  // write-only boards: last commanded value per address (never rendered as truth)
  const [commanded, setCommanded] = useState({});
  const [readError, setReadError] = useState(null);
  const [readAt, setReadAt] = useState(null);
  const [message, setMessage] = useState(null);
  const [actionLoading, setActionLoading] = useState({});

  const canControl = user?.role === 'admin' || user?.role === 'operator';
  const channels = useMemo(() => getCoilChannels(equipment), [equipment]);
  const interlockPairPresent = hasInterlockPair(equipment?.register_mappings);
  const writeOnly = !!equipment?.write_only;
  const disabled = isEquipmentDisabled(equipment);
  const presentation = getEquipmentPresentation(equipment, {
    now,
    formatSinceFn: (d, sameDay) => (sameDay ? formatTime(d) : formatDateTime(d)),
  });
  // Whole-board reasons the state cannot be trusted.
  const boardUnknownReason = disabled ? 'Board is disabled'
    : writeOnly ? 'Board is write-only (no read-back)'
    : equipment?.status === 'offline' ? 'Board is offline'
    : presentation.stale ? presentation.text
    : null;
  const boardUnknown = boardUnknownReason !== null;
  const modbusConfig = parseModbusAddress(equipment?.address);

  const applyStates = useCallback((map, { partial = true } = {}) => {
    setStates(prev => {
      const next = partial ? { ...prev } : {};
      channels.forEach(ch => { if (!partial) next[ch.address] = null; });
      Object.entries(map).forEach(([k, v]) => { next[String(k)] = v === null ? null : !!v; });
      return next;
    });
  }, [channels]);

  const setAllUnknown = useCallback(() => {
    const m = {};
    channels.forEach(ch => { m[ch.address] = null; });
    setStates(m);
  }, [channels]);

  // Live read of every coil (admin/operator only - the raw Modbus route is role-gated).
  const fetchLive = useCallback(async () => {
    if (!equipment || channels.length === 0 || !canControl || writeOnly || disabled || !modbusConfig) return;
    setLoading(true);
    setReadError(null);
    try {
      const addrs = channels.map(c => c.address);
      const minAddress = Math.min(...addrs);
      const maxAddress = Math.max(...addrs);
      const response = await fetch('/api/modbus/read/coils', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: modbusConfig.host, port: modbusConfig.port, unitId: equipment.slave_id || 1,
          address: minAddress, quantity: maxAddress - minAddress + 1
        })
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to read coil states');
      }
      const result = await response.json();
      const m = {};
      channels.forEach(ch => {
        const v = result.data?.[ch.address - minAddress];
        m[ch.address] = typeof v === 'boolean' ? v : (v === 1 ? true : v === 0 ? false : null);
      });
      applyStates(m, { partial: false });
      setReadAt(Date.now());
    } catch (err) {
      setReadError(err.message);
      setAllUnknown();
    } finally {
      setLoading(false);
    }
  }, [equipment, channels, canControl, writeOnly, disabled, modbusConfig?.host, modbusConfig?.port, token, applyStates, setAllUnknown]);

  // Initialise from the poll's cached read-back, then refresh live.
  useEffect(() => {
    if (!isOpen || !equipment) return;
    setMessage(null);
    setReadError(null);
    setReadAt(null);
    const cached = parseCachedRelayStates(equipment);
    if (writeOnly) {
      setCommanded(cached);
      setAllUnknown();
    } else if (boardUnknown) {
      setAllUnknown();
    } else {
      const m = {};
      channels.forEach(ch => { m[ch.address] = cached[String(ch.address)] ?? null; });
      setStates(m);
    }
    fetchLive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, equipment?.id]);

  // Device truth arrives over the WebSocket: poll read-backs and confirmed writes.
  useEffect(() => {
    if (!isOpen || !equipment || typeof subscribe !== 'function') return undefined;
    return subscribe('relay_state_changed', (data) => {
      if (!data) return;
      const eqId = data.equipmentId ?? data.equipment_id;
      if (String(eqId) !== String(equipment.id)) return;
      if (data.relayStates && typeof data.relayStates === 'object') {
        if (!writeOnly) { applyStates(data.relayStates); setReadAt(Date.now()); setReadError(null); }
        return;
      }
      if (data.writeOnly || data.confirmed !== true) return;
      if (data.allChannels) {
        const m = {};
        channels.forEach(ch => { m[ch.address] = !!data.state; });
        applyStates(m);
      } else if (data.channel !== undefined && data.channel !== null) {
        applyStates({ [data.channel]: !!data.state });
      }
    });
  }, [isOpen, equipment?.id, subscribe, applyStates, channels, writeOnly]);

  const flash = (type, text) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 2500);
  };

  const controlChannel = async (channel, newState) => {
    if (!canControl || disabled) return;
    setActionLoading(prev => ({ ...prev, [channel.address]: true }));
    setMessage(null);
    try {
      const response = await fetch(`/api/equipment/${equipment.id}/relay/control`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: channel.address, state: newState })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || data.message || 'Failed to write coil');

      const label = getChannelDisplayName(channel);
      if (writeOnly) {
        markPending(equipment.id, channel.address, { writeOnly: true });
        setCommanded(prev => ({ ...prev, [channel.address]: newState }));
        flash('caution', `${label}: ${newState ? 'ON' : 'OFF'} command sent (no read-back)`);
      } else if (data.confirmed === true) {
        const rb = typeof data.readback === 'boolean' ? data.readback : !!data.state;
        applyStates({ [channel.address]: rb });
        clearPending([relayKey(equipment.id, channel.address)]);
        flash('success', `${label} ${rb ? 'ON' : 'OFF'} (confirmed by read-back)`);
      } else {
        markPending(equipment.id, channel.address, { writeOnly: false });
        applyStates({ [channel.address]: null });
        showWarning(UNCONFIRMED_TOAST, label);
      }
      onUpdate?.();
    } catch (err) {
      showError(err.message, getChannelDisplayName(channel));
    } finally {
      setActionLoading(prev => ({ ...prev, [channel.address]: false }));
    }
  };

  const controlAll = async (state) => {
    if (!canControl || disabled || channels.length === 0) return;
    if (state && interlockPairPresent) { showError(ALL_ON_INTERLOCK_TITLE); return; }
    const key = state ? 'allOn' : 'allOff';
    setActionLoading(prev => ({ ...prev, [key]: true }));
    setMessage(null);
    try {
      const response = await fetch(`/api/equipment/${equipment.id}/relay/all`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || data.message || 'Failed to write coils');

      const addrs = channels.map(c => c.address);
      if (writeOnly) {
        markPending(equipment.id, addrs, { writeOnly: true });
        setCommanded(prev => { const n = { ...prev }; addrs.forEach(a => { n[a] = state; }); return n; });
        flash('caution', `All relays ${state ? 'ON' : 'OFF'} command sent (no read-back)`);
      } else {
        const perChannel = Array.isArray(data.channelStates) ? data.channelStates : [];
        const confirmedMap = {};
        const unknownMap = {};
        perChannel.forEach(c => {
          if (c.confirmed) confirmedMap[c.channel] = !!c.state; else unknownMap[c.channel] = null;
        });
        if (data.confirmed === true && perChannel.length === 0) addrs.forEach(a => { confirmedMap[a] = state; });
        const confirmedKeys = Object.keys(confirmedMap);
        const pendingAddrs = addrs.filter(a => !(String(a) in confirmedMap));
        if (pendingAddrs.length) markPending(equipment.id, pendingAddrs, { writeOnly: false });
        applyStates({ ...unknownMap, ...confirmedMap });
        if (confirmedKeys.length) clearPending(confirmedKeys.map(k => relayKey(equipment.id, k)));
        if (data.confirmed === true) flash('success', `All relays ${state ? 'ON' : 'OFF'} (confirmed by read-back)`);
        else showWarning(UNCONFIRMED_TOAST, 'All relays');
      }
      onUpdate?.();
    } catch (err) {
      showError(err.message, `All relays ${state ? 'on' : 'off'}`);
    } finally {
      setActionLoading(prev => ({ ...prev, [key]: false }));
    }
  };

  if (!isOpen) return null;

  const busyAll = !!(actionLoading.allOn || actionLoading.allOff);
  const controlsDisabled = !canControl || disabled;
  const controlTitle = !canControl ? VIEWER_TITLE : disabled ? 'Board is disabled' : undefined;

  return (
    <ModalShell
      open={isOpen}
      onClose={onClose}
      title="Relay control"
      subtitle={equipment?.name || 'Modbus relay device'}
      icon={(
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
      )}
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}
    >
      {/* Board status */}
      <Card rail={presentation.rail} padding="sm" className="mb-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill state={presentation.pill} filled={presentation.filled} text={presentation.text} />
          {writeOnly && <StatusPill state="caution" filled={false} text="Write-only · no read-back" />}
          {!writeOnly && !disabled && canControl && (
            readError
              ? <StatusPill state="alarm" filled={false} text="Read failed" />
              : readAt
                ? <StatusPill state="ok" filled text={`Read ${formatTime(new Date(readAt))}`} />
                : loading ? <StatusPill state="idle" filled={false} text="Reading…" /> : null
          )}
          {canControl && !writeOnly && !disabled && (
            <Button variant="ghost" size="sm" onClick={fetchLive} disabled={loading} className="ml-auto" title="Read all coils now">
              {loading ? <Spinner /> : (
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              )}
              Refresh
            </Button>
          )}
        </div>
        <p className="text-xs text-muted mt-2 font-mono">
          {modbusConfig ? `${modbusConfig.host}:${modbusConfig.port} · unit ${equipment?.slave_id || 1}` : 'no address'}
          {equipment?.last_communication && ` · last comm ${formatDateTime(equipment.last_communication)}`}
        </p>
        {readError && <p className="text-xs text-alarm-600 dark:text-alarm-300 mt-1">{readError}</p>}
      </Card>

      {boardUnknown && (
        <InlineNotice type="caution" className="mb-4">
          {boardUnknownReason}. Relay states are <strong>unknown</strong>, not off
          {writeOnly ? ' — the values below are what was last commanded, not what the board reports.' : '.'}
        </InlineNotice>
      )}
      {!canControl && (
        <InlineNotice type="info" className="mb-4">View only — switching relays requires operator or admin.</InlineNotice>
      )}
      {message && <InlineNotice type={message.type} className="mb-4">{message.text}</InlineNotice>}

      {channels.length === 0 ? (
        <div className="text-center py-8">
          <h4 className="text-sm font-medium text-ink">No relay channels configured</h4>
          <p className="mt-1 text-sm text-muted">This device has no coil mappings with read/write access.</p>
        </div>
      ) : (
        <>
          {/* Bulk actions - always rendered, disabled for viewers */}
          <div className="mb-4">
            <div className="flex gap-2">
              <Button
                variant="secondary"
                className="flex-1"
                onClick={() => setConfirmAll(true)}
                disabled={controlsDisabled || busyAll || interlockPairPresent}
                title={interlockPairPresent ? ALL_ON_INTERLOCK_TITLE : controlTitle}
                data-testid="relay-all-on"
              >
                {actionLoading.allOn ? <Spinner /> : null} All on
              </Button>
              <Button
                variant="secondary"
                className="flex-1"
                onClick={() => setConfirmAll(false)}
                disabled={controlsDisabled || busyAll}
                title={controlTitle}
                data-testid="relay-all-off"
              >
                {actionLoading.allOff ? <Spinner /> : null} All off
              </Button>
            </div>
            {interlockPairPresent && (
              <p className="mt-1.5 text-xs text-muted flex items-center gap-1">
                <InterlockBadge /> All on is disabled: this board has interlocked channels that can never be on together.
              </p>
            )}
          </div>

          <ul className="space-y-2" data-testid="relay-channel-list">
            {channels.map((channel) => {
              const addr = channel.address;
              const state = states[addr] ?? null;
              const pendingEntry = getPending(equipment?.id, addr);
              const isPending = !!pendingEntry && !actionLoading[addr];
              const pendingWriteOnly = isPending && pendingEntry.writeOnly;
              const partnerLabel = getInterlockPartnerLabel(equipment?.register_mappings, addr);
              const mappingDisabled = channel.enabled === false;
              const rowDisabled = controlsDisabled || mappingDisabled || !!actionLoading[addr];
              const rail = (isPending && !pendingWriteOnly) ? 'caution'
                : channel.unverified ? 'caution'
                : state === true ? 'ok' : state === false ? 'idle' : 'stale';
              const stateText = state === true ? 'ON' : state === false ? 'OFF' : '—';
              return (
                <Card
                  as="li"
                  key={addr}
                  rail={rail}
                  padding="sm"
                  className={`flex items-center justify-between gap-3 ${isPending && !pendingWriteOnly ? 'ring-2 ring-caution-400 dark:ring-caution-500' : ''} ${mappingDisabled ? 'opacity-60' : ''}`}
                  data-channel={addr}
                  data-state={state === null ? 'unknown' : state ? 'on' : 'off'}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <RelayLed state={state} pending={isPending && !pendingWriteOnly} />
                    <div className="min-w-0">
                      <div className="font-medium text-ink flex items-center gap-1.5 flex-wrap">
                        <span className="truncate">{getChannelDisplayName(channel)}</span>
                        {partnerLabel && <InterlockBadge partnerLabel={partnerLabel} />}
                        {channel.unverified && <UnverifiedPill />}
                        {mappingDisabled && <StatusPill state="idle" text="disabled" />}
                      </div>
                      <div className="text-xs text-muted font-mono">
                        {channel.label && channel.name && channel.label !== channel.name ? `${channel.name} · ` : ''}reg {addr}
                        {writeOnly && commanded[addr] !== undefined && (
                          <span className="ml-2">commanded {commanded[addr] ? 'ON' : 'OFF'}</span>
                        )}
                        {isPending && (
                          <span className={`ml-2 font-sans ${pendingWriteOnly ? 'text-muted' : 'text-caution-600 dark:text-caution-300'}`}>
                            {pendingWriteOnly ? '(command sent, no read-back)' : '(command sent, awaiting confirmation)'}
                          </span>
                        )}
                        {!isPending && state === null && !writeOnly && <span className="ml-2 font-sans">state unknown</span>}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    <span className="font-mono tabular text-sm text-ink w-8 text-right" aria-label={`state ${stateText}`}>{stateText}</span>
                    {state === null ? (
                      // Unknown state: intent must be explicit, never a blind toggle.
                      <div className="flex gap-1">
                        <Button variant="secondary" size="sm" onClick={() => controlChannel(channel, true)} disabled={rowDisabled} title={controlTitle} className="min-h-touch">On</Button>
                        <Button variant="secondary" size="sm" onClick={() => controlChannel(channel, false)} disabled={rowDisabled} title={controlTitle} className="min-h-touch">Off</Button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        role="switch"
                        aria-checked={state === true}
                        aria-label={`${getChannelDisplayName(channel)} ${state ? 'on' : 'off'}`}
                        onClick={() => controlChannel(channel, !state)}
                        disabled={rowDisabled}
                        title={controlTitle}
                        className={`relative inline-flex items-center h-11 w-[68px] shrink-0 rounded-full p-1 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed ${state ? 'bg-state-ok' : 'bg-gray-300 dark:bg-gray-600'}`}
                      >
                        <span className={`inline-flex items-center justify-center h-9 w-9 rounded-full bg-white shadow transform transition-transform ${state ? 'translate-x-[24px]' : 'translate-x-0'}`}>
                          {actionLoading[addr] && <Spinner className="h-4 w-4 text-muted" />}
                        </span>
                      </button>
                    )}
                  </div>
                </Card>
              );
            })}
          </ul>
        </>
      )}

      <ConfirmDialog
        open={confirmAll !== null}
        title={`Turn all relays ${confirmAll ? 'ON' : 'OFF'}?`}
        body={(
          <>This will switch every relay on <strong>{equipment?.name || 'this device'}</strong> {confirmAll ? 'on' : 'off'} ({channels.length} channels):</>
        )}
        items={channels.map(c => getChannelDisplayName(c))}
        variant={confirmAll ? 'primary' : 'danger'}
        confirmLabel={`Turn all ${confirmAll ? 'on' : 'off'}`}
        busy={busyAll}
        onCancel={() => setConfirmAll(null)}
        onConfirm={() => {
          const s = confirmAll;
          setConfirmAll(null);
          if (s === true || s === false) controlAll(s);
        }}
      />
    </ModalShell>
  );
}
