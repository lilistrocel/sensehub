import React from 'react';
import { formatSince } from '../utils/freshness';

const SIZE = {
  sm: 'text-base',
  md: 'text-2xl',
  lg: 'text-4xl',
};

function formatValue(value, precision) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return precision === undefined || precision === null
      ? value.toLocaleString(undefined, { maximumFractionDigits: 3 })
      : value.toFixed(precision);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n) && precision !== undefined && precision !== null) return n.toFixed(precision);
    return value;
  }
  return null;
}

/**
 * A numeric reading in JetBrains Mono with tabular figures so values never
 * jitter. NEVER renders a number when `unknown` or `stale`: it renders an em
 * dash instead, with a dashed caution rail and a "not reported since HH:MM"
 * tooltip when stale.
 *
 * @param {object} props
 * @param {number|string|null} props.value
 * @param {string} [props.unit]
 * @param {number} [props.precision]
 * @param {boolean} [props.unknown]   no reading has ever been received
 * @param {boolean} [props.stale]     last reading is too old to trust
 * @param {*} [props.since]           timestamp of the last report (for the tooltip)
 * @param {'sm'|'md'|'lg'} [props.size]
 * @param {(d: Date, sameDay: boolean) => string} [props.formatSinceFn] timezone-aware formatter
 */
export default function Reading({
  value,
  unit,
  precision,
  unknown = false,
  stale = false,
  since,
  size = 'md',
  className = '',
  formatSinceFn,
  ...rest
}) {
  const formatted = unknown ? null : formatValue(value, precision);
  const missing = unknown || stale || formatted === null;

  if (missing) {
    const sinceLabel = since ? formatSince(since, { format: formatSinceFn }) : null;
    const title = stale
      ? `Not reported since ${sinceLabel || 'unknown'}`
      : 'No reading';
    return (
      <span
        className={`inline-flex items-baseline gap-1 font-mono tabular text-muted ${SIZE[size] ?? SIZE.md} ${
          stale ? 'border-l-[3px] border-dashed border-l-state-caution pl-2' : ''
        } ${className}`.trim()}
        title={title}
        aria-label={title}
        data-reading-state={stale ? 'stale' : 'unknown'}
        {...rest}
      >
        <span aria-hidden="true">&mdash;</span>
        {unit && <span className="text-xs font-sans font-medium">{unit}</span>}
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-baseline gap-1 font-mono tabular text-ink ${SIZE[size] ?? SIZE.md} ${className}`.trim()}
      data-reading-state="ok"
      {...rest}
    >
      <span>{formatted}</span>
      {unit && <span className="text-xs font-sans font-medium text-muted">{unit}</span>}
    </span>
  );
}
