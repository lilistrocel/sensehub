import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, StatusPill } from '../../ui';
import { getEquipmentPresentation, isRelayBoard, formatRelative } from './equipmentStatus';

// Labels come from t(`list.col.${key}`) at render.
const SORTABLE = [
  { key: 'name', cls: '' },
  { key: 'type', cls: 'hidden xl:table-cell w-28' },
  { key: 'status', cls: 'w-40' },
  { key: 'zone', cls: 'hidden lg:table-cell w-28' },
  { key: 'last_seen', cls: 'hidden 2xl:table-cell w-24' },
];

function SortIcon({ active, direction }) {
  if (!active) return null;
  return (
    <svg className={`h-3.5 w-3.5 ${direction === 'desc' ? 'rotate-180' : ''} transition-transform`} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
    </svg>
  );
}

function TypeChip({ type, protocol }) {
  const { t } = useTranslation('equipment');
  if (!type && !protocol) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-line bg-field px-2 py-0.5 text-xs text-muted whitespace-nowrap">
      {type ? <span dir="auto">{type}</span> : t('list.device')}
      {protocol && <span className="uppercase text-[10px] tracking-wider">· {protocol}</span>}
    </span>
  );
}

function ZoneChips({ zones, className = '' }) {
  if (!zones || zones.length === 0) return <span className="text-sm text-muted">—</span>;
  return (
    <div className={`flex flex-wrap gap-1 ${className}`.trim()}>
      {zones.map((zone, idx) => (
        <span key={zone.id || idx} dir="auto" className="inline-flex items-center rounded border border-line bg-field px-1.5 py-0.5 text-xs text-ink">
          {zone.name}
        </span>
      ))}
    </div>
  );
}

/**
 * Equipment list: a table at >= md that reflows (Type/Zone/Last-seen columns
 * collapse under the name/status at narrower widths, row actions wrap), and
 * cards below md. Status is StatusPill (shape + colour) and the row/card rail.
 */
export default function EquipmentList({
  items,
  user,
  now,
  formatSinceFn,
  formatDateTime,
  sortColumn,
  sortDirection,
  onSort,
  onView,
  onEdit,
  onDelete,
  onRelays,
}) {
  const { t } = useTranslation('equipment');
  const isAdmin = user?.role === 'admin';

  const rowActions = (eq, size) => {
    const relay = isRelayBoard(eq);
    return (
      <>
        {relay && (
          <Button variant="secondary" size={size} onClick={(e) => { e.stopPropagation(); onRelays(eq); }} title={t('list.controlRelays')}>{t('list.relays')}</Button>
        )}
        <Button variant="ghost" size={size} onClick={(e) => { e.stopPropagation(); onView(eq); }}>{t('list.view')}</Button>
        <Button variant="ghost" size={size} onClick={(e) => { e.stopPropagation(); onEdit(eq); }}>{t('common:actions.edit')}</Button>
        {isAdmin && (
          <Button variant="danger-ghost" size={size} onClick={(e) => { e.stopPropagation(); onDelete(eq); }} title={t('list.deleteEquipment')}>{t('common:actions.delete')}</Button>
        )}
      </>
    );
  };

  const lastSeen = (eq) => {
    const rel = formatRelative(eq.last_communication, now);
    const title = eq.last_communication && formatDateTime ? formatDateTime(eq.last_communication) : undefined;
    return <span className="font-mono tabular text-xs text-muted whitespace-nowrap" title={title}>{rel}</span>;
  };

  return (
    <>
      {/* >= md: table */}
      <Card padding="none" className="hidden md:block">
        <table className="w-full table-fixed border-collapse" data-testid="equipment-table">
          <thead className="bg-field border-b border-line">
            <tr>
              {SORTABLE.map(col => (
                <th key={col.key} scope="col" className={`px-3 py-2.5 text-start ${col.cls}`}>
                  <button
                    type="button"
                    onClick={() => onSort(col.key)}
                    className="inline-flex items-center gap-1 text-label uppercase text-muted hover:text-ink select-none min-h-[28px]"
                    aria-sort={sortColumn === col.key ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    {t(`list.col.${col.key}`)}
                    <SortIcon active={sortColumn === col.key} direction={sortDirection} />
                  </button>
                </th>
              ))}
              <th scope="col" className="px-3 py-2.5 w-[140px] lg:w-[296px]"><span className="sr-only">{t('list.actions')}</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {items.map((eq) => {
              const p = getEquipmentPresentation(eq, { now, formatSinceFn });
              return (
                <tr
                  key={eq.id}
                  onClick={() => onView(eq)}
                  data-equipment-id={eq.id}
                  data-status={p.key}
                  className={`cursor-pointer hover:bg-field/70 transition-colors border-s-[3px] ${
                    p.rail === 'ok' ? 'border-s-state-ok' : p.rail === 'alarm' ? 'border-s-state-alarm' : p.rail === 'caution' || p.rail === 'stale' ? 'border-s-state-caution' : 'border-s-state-idle'
                  } ${p.dim ? 'opacity-60' : ''}`}
                >
                  <td className="px-3 py-2.5 min-w-0">
                    <div dir="auto" className={`text-sm font-medium truncate ${p.dim ? 'text-muted' : 'text-ink'}`} title={eq.name}>{eq.name}</div>
                    {eq.description && (
                      <div dir="auto" className="text-xs text-muted truncate" title={eq.description}>{eq.description}</div>
                    )}
                    <div className="xl:hidden mt-1"><TypeChip type={eq.type} protocol={eq.protocol} /></div>
                  </td>
                  <td className="px-3 py-2.5 hidden xl:table-cell">
                    <div dir="auto" className={`text-sm truncate ${p.dim ? 'text-muted' : 'text-ink'}`}>{eq.type || '—'}</div>
                    {eq.protocol && <div className="text-[10px] uppercase tracking-wider text-muted">{eq.protocol}</div>}
                  </td>
                  <td className="px-3 py-2.5">
                    <StatusPill state={p.pill} filled={p.filled} text={p.text} className="max-w-full !whitespace-normal" />
                    <div className="2xl:hidden mt-1">{lastSeen(eq)}</div>
                  </td>
                  <td className="px-3 py-2.5 hidden lg:table-cell"><ZoneChips zones={eq.zones} /></td>
                  <td className="px-3 py-2.5 hidden 2xl:table-cell">{lastSeen(eq)}</td>
                  <td className="px-2 py-2">
                    <div className="flex flex-wrap justify-end gap-1">{rowActions(eq, 'sm')}</div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      {/* < md: cards */}
      <ul className="md:hidden space-y-3" data-testid="equipment-cards">
        {items.map((eq) => {
          const p = getEquipmentPresentation(eq, { now, formatSinceFn });
          const relay = isRelayBoard(eq);
          return (
            <Card
              as="li"
              key={eq.id}
              rail={p.rail}
              padding="md"
              className={`${p.dim ? 'opacity-60' : ''}`}
              data-equipment-id={eq.id}
              data-status={p.key}
              onClick={() => onView(eq)}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 dir="auto" className={`font-display text-base font-semibold leading-6 truncate ${p.dim ? 'text-muted' : 'text-ink'}`}>{eq.name}</h3>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <TypeChip type={eq.type} protocol={eq.protocol} />
                  </div>
                </div>
                <StatusPill state={p.pill} filled={p.filled} text={p.text} className="shrink-0 max-w-[55%] !whitespace-normal text-end" />
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                <dt className="text-label uppercase text-muted self-center">{t('list.col.zone')}</dt>
                <dd className="min-w-0"><ZoneChips zones={eq.zones} /></dd>
                <dt className="text-label uppercase text-muted self-center">{t('list.col.last_seen')}</dt>
                <dd>{lastSeen(eq)}</dd>
              </dl>
              <div className="mt-3 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                {relay ? (
                  <Button variant="secondary" className="flex-1" onClick={() => onRelays(eq)}>{t('list.relays')}</Button>
                ) : (
                  <Button variant="secondary" className="flex-1" onClick={() => onView(eq)}>{t('list.view')}</Button>
                )}
                {relay && <Button variant="ghost" onClick={() => onView(eq)}>{t('list.view')}</Button>}
                <Button variant="ghost" onClick={() => onEdit(eq)}>{t('common:actions.edit')}</Button>
                {isAdmin && <Button variant="danger-ghost" onClick={() => onDelete(eq)} aria-label={t('list.deleteNamed', { name: eq.name })}>{t('common:actions.delete')}</Button>}
              </div>
            </Card>
          );
        })}
      </ul>
    </>
  );
}
