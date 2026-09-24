import React from 'react';
import Card from './Card';
import Label from './Label';
import Reading from './Reading';

/**
 * KPI tile: Label above a Reading, on a Card whose rail carries state.
 * All Reading props (value, unit, precision, unknown, stale, since) pass through.
 */
export default function Kpi({
  label,
  rail = null,
  hint,
  size = 'md',
  className = '',
  padding = 'md',
  ...readingProps
}) {
  return (
    <Card rail={rail} padding={padding} className={className}>
      <Label>{label}</Label>
      <div className="mt-1">
        <Reading size={size} {...readingProps} />
      </div>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </Card>
  );
}
