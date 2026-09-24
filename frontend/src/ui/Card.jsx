import React from 'react';

/**
 * Panel-on-line card, 8px radius, with an optional 3px LEFT RAIL that carries
 * state. Status is shape + colour: the rail is always paired with a pill or
 * LED elsewhere in the card, never the only signal.
 *
 * rail: 'idle' | 'ok' | 'caution' | 'alarm' | 'lighting' | 'water' | 'stale' | null
 */
const RAIL = {
  idle: 'border-l-[3px] border-l-state-idle',
  ok: 'border-l-[3px] border-l-state-ok',
  caution: 'border-l-[3px] border-l-state-caution',
  alarm: 'border-l-[3px] border-l-state-alarm',
  lighting: 'border-l-[3px] border-l-state-lighting',
  water: 'border-l-[3px] border-l-state-water',
  stale: 'border-l-[3px] border-l-state-caution border-dashed',
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
