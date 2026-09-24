import React from 'react';

/**
 * Status pill: colour AND shape. The LED is filled when `filled` (active /
 * running / on) and hollow otherwise, so a state is readable without colour.
 *
 * state: 'idle' | 'ok' | 'caution' | 'alarm' | 'lighting' | 'water'
 */
const STYLES = {
  idle: {
    pill: 'border-line text-muted bg-panel',
    led: 'bg-state-idle border-state-idle',
  },
  ok: {
    pill: 'border-ok-300 text-ok-700 bg-ok-50 dark:border-ok-700 dark:text-ok-300 dark:bg-ok-900/40',
    led: 'bg-state-ok border-state-ok',
  },
  caution: {
    pill: 'border-caution-300 text-caution-700 bg-caution-50 dark:border-caution-700 dark:text-caution-300 dark:bg-caution-900/40',
    led: 'bg-state-caution border-state-caution',
  },
  alarm: {
    pill: 'border-alarm-300 text-alarm-700 bg-alarm-50 dark:border-alarm-700 dark:text-alarm-300 dark:bg-alarm-900/40',
    led: 'bg-state-alarm border-state-alarm',
  },
  lighting: {
    pill: 'border-lighting-300 text-lighting-700 bg-lighting-50 dark:border-lighting-700 dark:text-lighting-300 dark:bg-lighting-900/40',
    led: 'bg-state-lighting border-state-lighting',
  },
  water: {
    pill: 'border-water-300 text-water-700 bg-water-50 dark:border-water-700 dark:text-water-300 dark:bg-water-900/40',
    led: 'bg-state-water border-state-water',
  },
};

export default function StatusPill({
  state = 'idle',
  filled = false,
  pulse = false,
  children,
  text,
  className = '',
  ...rest
}) {
  const s = STYLES[state] || STYLES.idle;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${s.pill} ${className}`.trim()}
      data-state={state}
      {...rest}
    >
      <span
        aria-hidden="true"
        className={`inline-block w-2 h-2 rounded-full border-2 ${s.led} ${filled ? '' : '!bg-transparent'} ${pulse ? 'animate-pulse' : ''}`.trim()}
      />
      {text ?? children}
    </span>
  );
}
