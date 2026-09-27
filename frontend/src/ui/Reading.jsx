import React from 'react';
import { useTranslation } from 'react-i18next';
import { formatSince } from '../utils/freshness';
import { formatNumber } from '../i18n/format';
import { useFormat } from '../i18n/useFormat';

const SIZE = {
  sm: 'text-base',
  md: 'text-2xl',
  lg: 'text-4xl',
};

// '.' decimal and Western digits in every language (src/i18n/format.js):
// a reading must look exactly like the panel it comes from.
function formatValue(value, precision, lng) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return precision === undefined || precision === null
      ? formatNumber(value, { maxDecimals: 3, lng })
      : formatNumber(value, { decimals: precision, grouping: false, lng });
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n) && precision !== undefined && precision !== null) return formatNumber(n, { decimals: precision, grouping: false, lng });
    return value;
  }
  return null;
}

/**
 * A numeric reading in JetBrains Mono with tabular figures so values never
 * jitter. NEVER renders a number when `unknown` or `stale`: it renders an em
 * dash instead, with a dashed caution rail and a "not reported since HH:MM"
 * tooltip when stale. Value and unit render left-to-right in every language
 * ("12.5 °C" also inside Arabic UI), like the equipment panels.
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
  const { t } = useTranslation('common');
  const fmt = useFormat();
  const formatted = unknown ? null : formatValue(value, precision, fmt.lng);
  const missing = unknown || stale || formatted === null;

  if (missing) {
    const sinceLabel = since
      ? (formatSinceFn ? formatSince(since, { format: formatSinceFn }) : fmt.since(since))
      : null;
    const title = stale
      ? t('reading.notReportedSince', { time: sinceLabel || t('reading.unknownTime') })
      : t('reading.noReading');
    return (
      <span
        className={`inline-flex items-baseline gap-1 font-mono tabular text-muted ${SIZE[size] ?? SIZE.md} ${
          stale ? 'border-s-[3px] border-dashed border-s-state-caution ps-2' : ''
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
      dir="ltr"
      className={`inline-flex items-baseline gap-1 font-mono tabular text-ink ${SIZE[size] ?? SIZE.md} ${className}`.trim()}
      data-reading-state="ok"
      {...rest}
    >
      <span>{formatted}</span>
      {unit && <span className="text-xs font-sans font-medium text-muted">{unit}</span>}
    </span>
  );
}
