import React from 'react';

/**
 * Buttons spend fill and colour by role:
 *   primary      - brand purple fill, the one filled button per view
 *   secondary    - panel with a line border
 *   ghost        - no border, no fill until hover
 *   danger-ghost - quiet; only turns alarm red on hover. Never a peer of primary.
 *
 * `md` buttons are at least 44px tall for touch; `sm` is 36px.
 */
const VARIANT = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800 border border-transparent shadow-sm',
  secondary: 'bg-panel text-ink border border-line hover:bg-field active:bg-gray-200 dark:active:bg-gray-700',
  ghost: 'bg-transparent text-ink border border-transparent hover:bg-field',
  'danger-ghost': 'bg-transparent text-muted border border-transparent hover:text-alarm-600 hover:bg-alarm-50 dark:hover:text-alarm-300 dark:hover:bg-alarm-900/30',
};

const SIZE = {
  sm: 'min-h-[36px] px-3 py-1.5 text-sm',
  md: 'min-h-touch px-4 py-2 text-sm',
};

export default function Button({
  variant = 'secondary',
  size = 'md',
  as: Tag = 'button',
  type,
  className = '',
  children,
  ...rest
}) {
  const props = { ...rest };
  if (Tag === 'button') props.type = type || 'button';
  return (
    <Tag
      className={`inline-flex items-center justify-center gap-2 rounded-md font-semibold transition-colors select-none disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas ${VARIANT[variant] || VARIANT.secondary} ${SIZE[size] || SIZE.md} ${className}`.trim()}
      {...props}
    >
      {children}
    </Tag>
  );
}
