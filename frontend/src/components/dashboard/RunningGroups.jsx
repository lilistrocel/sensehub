import React, { useCallback, useMemo, useState } from 'react';
import { Button, Card } from '../../ui';
import ConfirmDialog from '../ConfirmDialog';
import InterlockBadge from '../InterlockBadge';
import { getInterlockPartnerLabel } from '../../utils/channelUtils';
import { API_BASE } from './constants';

const VIEWER_TITLE = 'Viewer role: read-only. Ask an operator to switch this.';
const UNKNOWN_TITLE = 'State unknown: the board has not reported. Control it from the Equipment page once it is back.';

const chipKey = (c) => `${c.equipment_id}:${c.channel}`;

/** Segment classes: filled ok = on, hollow = off, dashed grey = unknown, amber = awaiting confirmation. */
function segmentClass(c, pending) {
  if (pending) return 'bg-caution-200 dark:bg-caution-900/40 border border-state-caution';
  if (c.state === true) return 'bg-state-ok border border-state-ok';
  if (c.state === false) return 'bg-transparent border border-line';
  return 'bg-transparent border border-dashed border-state-idle';
}

function Chip({ channel, pending, commandedState, canControl, interlockLabel, onToggle, formatTime }) {
  const unknown = channel.state === null || channel.state === undefined;
  const on = channel.state === true;
  const disabled = !canControl || unknown;
  let title;
  if (!canControl) title = VIEWER_TITLE;
  else if (unknown) title = UNKNOWN_TITLE;
  else if (pending) title = `Commanded ${commandedState ? 'ON' : 'OFF'}, awaiting confirmation from the board`;
  else if (channel.confirmed === false) title = 'Last write failed its read-back check';
  else title = `${channel.equipment_name} · tap to turn ${on ? 'OFF' : 'ON'}${channel.lastChangeTs && formatTime ? ` · changed ${formatTime(channel.lastChangeTs)}` : ''}`;

  const rail = unknown
    ? 'border-l-[3px] border-l-state-idle border-dashed'
    : on ? 'border-l-[3px] border-l-state-ok' : 'border-l-[3px] border-l-state-idle';

  return (
    <span title={title} className="block min-w-0">
    <button
      type="button"
      disabled={disabled}
      aria-disabled={disabled}
      title={title}
      onClick={() => { if (!disabled) onToggle(channel, !on); }}
      data-testid="relay-chip"
      data-state={unknown ? 'unknown' : on ? 'on' : 'off'}
      data-pending={pending ? 'true' : undefined}
      className={`flex items-center justify-between gap-2 min-h-touch w-full rounded-md border border-line bg-panel px-2.5 py-1.5 text-left text-sm transition-colors ${rail} ${
        pending ? 'ring-2 ring-state-caution ring-offset-1 ring-offset-panel' : ''
      } ${disabled ? 'cursor-not-allowed opacity-70' : 'hover:bg-field'}`}
    >
      <span className="min-w-0 flex items-center gap-1.5">
        <span className="truncate text-ink">{channel.label}</span>
        {interlockLabel && <InterlockBadge partnerLabel={interlockLabel} />}
      </span>
      <span className={`shrink-0 font-mono tabular text-xs ${pending ? 'text-caution-700 dark:text-caution-300' : on ? 'text-ok-700 dark:text-ok-300' : 'text-muted'}`}>
        {pending ? `→ ${commandedState ? 'ON' : 'OFF'}` : unknown ? '' : channel.confirmed === false ? `${on ? 'ON' : 'OFF'}?` : on ? 'ON' : 'OFF'}
      </span>
    </button>
    </span>
  );
}

function GroupRow({ group, expanded, onToggleExpand, canControl, isPending, commandedFor, interlockFor, onChipToggle, onBulk, formatTime }) {
  const hasInterlock = group.channels.some((c) => !!interlockFor(c));
  const bulkAllowed = canControl && !hasInterlock && group.unknown === 0 && group.total > 0;
  let bulkTitle;
  if (!canControl) bulkTitle = VIEWER_TITLE;
  else if (hasInterlock) bulkTitle = 'Bulk control is disabled: this group has interlocked channels';
  else if (group.unknown > 0) bulkTitle = 'Bulk control is disabled while a channel state is unknown';

  return (
    <li className="py-2" data-testid={`relay-group-${group.key}`}>
      <button
        type="button"
        onClick={onToggleExpand}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 min-h-touch rounded-md px-1 text-left hover:bg-field"
      >
        <span className="w-28 sm:w-32 shrink-0 truncate text-sm font-semibold text-ink">{group.label}</span>
        <span className="shrink-0 font-mono tabular text-sm text-ink" data-testid="group-count">
          {group.on}/{group.total}
        </span>
        <span className="flex flex-1 gap-0.5 h-2.5 min-w-0" aria-hidden="true">
          {group.channels.map((c) => (
            <span key={chipKey(c)} className={`flex-1 rounded-sm ${segmentClass(c, isPending(c))}`} />
          ))}
        </span>
        {group.unknown > 0 && <span className="shrink-0 font-mono tabular text-xs text-muted">{group.unknown} unknown</span>}
        <svg className={`h-4 w-4 shrink-0 text-muted transition-transform ${expanded ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
        </svg>
      </button>

      {expanded && (
        <div className="mt-2 space-y-2 pl-1">
          {group.total === 0 ? (
            <p className="text-sm text-muted">No channels in this group.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-2 gap-2" data-testid="chip-grid">
              {group.channels.map((c) => (
                <Chip
                  key={chipKey(c)}
                  channel={c}
                  pending={isPending(c)}
                  commandedState={commandedFor(c)}
                  canControl={canControl}
                  interlockLabel={interlockFor(c)}
                  onToggle={onChipToggle}
                  formatTime={formatTime}
                />
              ))}
            </div>
          )}
          {group.total > 0 && (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="secondary" disabled={!bulkAllowed} title={bulkTitle} onClick={() => onBulk(group, true)}>All on</Button>
              <Button size="sm" variant="danger-ghost" disabled={!bulkAllowed} title={bulkTitle} onClick={() => onBulk(group, false)}>All off</Button>
              {bulkTitle && <span className="text-xs text-muted">{bulkTitle}</span>}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * "What's running": one row per relay group with a segmented state bar;
 * expand for per-channel chips. Bulk actions confirm with the channel list
 * (rule 4.3) and are refused for interlocked or unknown channels (rule 3.6).
 */
export default function RunningGroups({
  groups = [],
  equipmentById = {},
  canControl,
  token,
  markPending,
  getPending,
  showError,
  showSuccess,
  formatTime,
}) {
  const [expanded, setExpanded] = useState(() => new Set());
  const [commanded, setCommanded] = useState({}); // key -> target state
  const [confirm, setConfirm] = useState(null);   // { group, state }
  const [busy, setBusy] = useState(false);

  const visible = useMemo(() => groups.filter((g) => g.total > 0 || g.key !== 'other'), [groups]);

  const isPending = useCallback((c) => !!getPending?.(c.equipment_id, c.channel), [getPending]);
  const commandedFor = useCallback((c) => commanded[chipKey(c)], [commanded]);
  const interlockFor = useCallback((c) => {
    const eq = equipmentById[c.equipment_id];
    if (!eq) return null;
    return getInterlockPartnerLabel(eq.mappings, c.channel);
  }, [equipmentById]);

  const sendCommand = useCallback(async (channel, state) => {
    const r = await fetch(`${API_BASE}/equipment/${channel.equipment_id}/relay/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel: channel.channel, state }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || err.message || `HTTP ${r.status}`);
    }
    const eq = equipmentById[channel.equipment_id];
    markPending?.(channel.equipment_id, channel.channel, { writeOnly: !!eq?.write_only });
    setCommanded((prev) => ({ ...prev, [chipKey(channel)]: state }));
  }, [token, equipmentById, markPending]);

  const onChipToggle = useCallback(async (channel, state) => {
    if (!canControl) return;
    try {
      await sendCommand(channel, state);
    } catch (e) {
      showError?.(`${channel.label}: ${e.message}`);
    }
  }, [canControl, sendCommand, showError]);

  const runBulk = useCallback(async () => {
    if (!confirm) return;
    const { group, state } = confirm;
    setBusy(true);
    const failed = [];
    for (const c of group.channels) {
      try { await sendCommand(c, state); } catch (e) { failed.push(`${c.label}: ${e.message}`); }
    }
    setBusy(false);
    setConfirm(null);
    if (failed.length) showError?.(`${failed.length} of ${group.channels.length} commands failed. ${failed[0]}`);
    else showSuccess?.(`${group.label}: all ${group.channels.length} commanded ${state ? 'ON' : 'OFF'}, awaiting confirmation`);
  }, [confirm, sendCommand, showError, showSuccess]);

  const toggleExpand = (key) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  return (
    <Card padding="sm">
      <ul className="divide-y divide-line" data-testid="relay-groups">
        {visible.map((g) => (
          <GroupRow
            key={g.key}
            group={g}
            expanded={expanded.has(g.key)}
            onToggleExpand={() => toggleExpand(g.key)}
            canControl={canControl}
            isPending={isPending}
            commandedFor={commandedFor}
            interlockFor={interlockFor}
            onChipToggle={onChipToggle}
            onBulk={(group, state) => setConfirm({ group, state })}
            formatTime={formatTime}
          />
        ))}
        {visible.length === 0 && <li className="py-3 text-sm text-muted">No relay boards reported.</li>}
      </ul>

      <ConfirmDialog
        open={!!confirm}
        title={confirm ? `${confirm.group.label}: all ${confirm.state ? 'ON' : 'OFF'}` : ''}
        body={confirm ? `This commands every channel below ${confirm.state ? 'ON' : 'OFF'}. Each stays amber until the board confirms.` : null}
        items={confirm ? confirm.group.channels.map((c) => `${c.label} — ${c.equipment_name}`) : []}
        variant={confirm && !confirm.state ? 'danger' : 'primary'}
        confirmLabel={confirm ? `Turn all ${confirm.state ? 'ON' : 'OFF'}` : 'Confirm'}
        busy={busy}
        onConfirm={runBulk}
        onCancel={() => { if (!busy) setConfirm(null); }}
      />
    </Card>
  );
}
