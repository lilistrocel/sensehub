import React, { useEffect, useRef } from 'react';

const SIZE = {
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
};

/**
 * Modal frame shared by the equipment modals: backdrop, panel-on-line card,
 * title row with close button. The OVERLAY scrolls, never an inner box, so a
 * long form or a wide register table scrolls once with the page.
 *
 * Props: open, onClose, title, subtitle, icon (ReactNode), size 'md'|'lg'|'xl',
 * footer (ReactNode), children, closeDisabled, className.
 */
export default function ModalShell({
  open,
  onClose,
  title,
  subtitle,
  icon,
  size = 'md',
  footer,
  children,
  closeDisabled = false,
  className = '',
  bodyClassName = '',
}) {
  const titleId = useRef(`modal-title-${Math.random().toString(36).slice(2, 9)}`).current;

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' && !closeDisabled) onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose, closeDisabled]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto" role="presentation">
      <div className="fixed inset-0 transition-opacity" style={{ backgroundColor: 'rgba(20,16,15,0.6)' }} onClick={() => { if (!closeDisabled) onClose?.(); }} aria-hidden="true" />
      <div className="relative min-h-full flex items-start sm:items-center justify-center p-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className={`relative w-full ${SIZE[size] || SIZE.md} bg-panel border border-line rounded-card shadow-xl text-left my-2 sm:my-6 ${className}`.trim()}
        >
          <div className="flex items-start gap-3 px-4 pt-4 sm:px-6 sm:pt-5">
            {icon && <div className="shrink-0 h-10 w-10 rounded-md bg-field text-muted flex items-center justify-center">{icon}</div>}
            <div className="flex-1 min-w-0">
              <h3 id={titleId} className="font-display text-lg font-semibold leading-6 text-ink truncate">{title}</h3>
              {subtitle && <p className="text-sm text-muted mt-0.5 truncate">{subtitle}</p>}
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={closeDisabled}
              aria-label="Close"
              className="shrink-0 -mr-2 -mt-1 min-h-touch min-w-[44px] inline-flex items-center justify-center rounded-md text-muted hover:text-ink hover:bg-field disabled:opacity-50"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className={`px-4 py-4 sm:px-6 ${bodyClassName}`.trim()}>{children}</div>
          {footer && (
            <div className="px-4 pb-4 sm:px-6 sm:pb-5 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Inline status banner used inside modals (success / error / caution). */
export function InlineNotice({ type = 'info', children, className = '' }) {
  const styles = {
    success: 'border-ok-300 bg-ok-50 text-ok-700 dark:border-ok-700 dark:bg-ok-900/30 dark:text-ok-300',
    error: 'border-alarm-300 bg-alarm-50 text-alarm-700 dark:border-alarm-700 dark:bg-alarm-900/30 dark:text-alarm-300',
    caution: 'border-caution-300 bg-caution-50 text-caution-700 dark:border-caution-700 dark:bg-caution-900/30 dark:text-caution-300',
    info: 'border-line bg-field text-ink',
  };
  return (
    <div role={type === 'error' ? 'alert' : 'status'} className={`rounded-md border px-3 py-2 text-sm ${styles[type] || styles.info} ${className}`.trim()}>
      {children}
    </div>
  );
}

/** Spinner glyph for busy buttons. */
export function Spinner({ className = 'h-4 w-4' }) {
  return (
    <svg className={`animate-spin ${className}`} fill="none" viewBox="0 0 24 24" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  );
}
