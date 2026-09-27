import React from 'react';

/**
 * Panel-on-line card, 8px radius, with an optional 3px state rail on the
 * START edge (left in LTR, right in Arabic RTL). Status is shape + colour: the rail is always paired with a pill or
 * LED elsewhere in the card, never the only signal.
 *
 * rail: 'idle' | 'ok' | 'caution' | 'alarm' | 'lighting' | 'water' | 'stale' | null
 */
const RAIL = {
  idle: 'border-s-[3px] border-s-state-idle',
  ok: 'border-s-[3px] border-s-state-ok',
  caution: 'border-s-[3px] border-s-state-caution',
  alarm: 'border-s-[3px] border-s-state-alarm',
  lighting: 'border-s-[3px] border-s-state-lighting',
  water: 'border-s-[3px] border-s-state-water',
  stale: 'border-s-[3px] border-s-state-caution border-dashed',
};

const PADDING = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-6',
};

export default function Card({
  rail = null,
  padding = 'md',
  as: Tag = 'div',
  className = '',
  children,
  ...rest
}) {
  const railClass = rail ? RAIL[rail] || '' : '';
  return (
    <Tag
      className={`bg-panel border border-line rounded-card ${railClass} ${PADDING[padding] ?? PADDING.md} ${className}`.trim()}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export { RAIL as RAIL_CLASSES };
