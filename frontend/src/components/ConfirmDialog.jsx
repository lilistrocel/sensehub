import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Accessible confirmation modal.
 *
 * - role="dialog" + aria-modal, labelled by the title
 * - Escape closes (calls onCancel)
 * - Focus is moved into the dialog on open, trapped with Tab/Shift+Tab, and
 *   restored to the previously focused element on close
 * - Works at 390 px: full-width sheet with 16 px gutters, buttons stack on xs
 *
 * Props:
 *   open           boolean
 *   title          string
 *   body           ReactNode (optional intro text)
 *   items          string[] (optional list of affected things, e.g. relay channel names)
 *   variant        'danger' | 'destructive' | 'primary' (default 'primary')
 *                  destructive = ghost button in alarm red (FARM-APP-STANDARDS 5:
 *                  solid red is reserved for alarm state)
 *   confirmLabel   string (default common:actions.confirm)
 *   cancelLabel    string (default common:actions.cancel)
 *   busy           boolean - disables buttons while the action runs
 *   onConfirm      () => void
 *   onCancel       () => void
 */
export default function ConfirmDialog({
  open,
  title,
  body,
  items,
  variant = 'primary',
  confirmLabel,
  cancelLabel,
  busy = false,
  onConfirm,
  onCancel,
}) {
  const { t } = useTranslation('common');
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  const previouslyFocused = useRef(null);
  const titleId = useRef(`confirm-title-${Math.random().toString(36).slice(2, 9)}`).current;

  // Focus management + Escape + Tab trap
  useEffect(() => {
    if (!open) return undefined;

    previouslyFocused.current = document.activeElement;
    // Default focus on Cancel so an accidental Enter never confirms.
    const focusTimer = setTimeout(() => cancelRef.current?.focus(), 0);

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (!busy) onCancel?.();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown, true);
      const prev = previouslyFocused.current;
      if (prev && typeof prev.focus === 'function') {
        try { prev.focus(); } catch { /* element may be gone */ }
      }
    };
  }, [open, busy, onCancel]);

  if (!open) return null;

  const confirmClasses = variant === 'danger'
    ? 'bg-red-600 hover:bg-red-700 focus:ring-red-500 text-white'
    : variant === 'destructive'
      ? 'bg-transparent border-2 border-alarm-600 text-alarm-700 hover:bg-alarm-50 dark:border-alarm-400 dark:text-alarm-300 dark:hover:bg-alarm-900/30 focus:ring-alarm-500 font-semibold'
      : 'bg-primary-600 hover:bg-primary-700 focus:ring-primary-500 text-white';
  const alarmTone = variant === 'danger' || variant === 'destructive';

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-4" role="presentation">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-gray-900/60 transition-opacity"
        onClick={() => { if (!busy) onCancel?.(); }}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative w-full max-w-md bg-white dark:bg-gray-800 rounded-lg shadow-xl p-4 sm:p-6 text-start"
      >
        <div className="flex items-start gap-3">
          <div className={`flex-shrink-0 h-10 w-10 rounded-full flex items-center justify-center ${
            alarmTone ? 'bg-red-100 dark:bg-red-900/30 text-red-600' : 'bg-primary-100 dark:bg-primary-900/30 text-primary-600'
          }`}>
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <h3 id={titleId} className="text-lg font-semibold text-gray-900 dark:text-white">
              {title}
            </h3>
            {body && (
              <div className="mt-1 text-sm text-gray-600 dark:text-gray-300">{body}</div>
            )}
            {Array.isArray(items) && items.length > 0 && (
              <ul className="mt-3 max-h-48 overflow-y-auto rounded-md border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700 text-sm">
                {items.map((item, i) => (
                  <li key={`${item}-${i}`} className="px-3 py-1.5 text-gray-800 dark:text-gray-200 truncate" title={String(item)}>
                    {item}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="mt-5 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="w-full sm:w-auto px-4 py-2.5 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-400 disabled:opacity-50"
          >
            {cancelLabel ?? t('actions.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`w-full sm:w-auto px-4 py-2.5 text-sm font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 ${confirmClasses}`}
          >
            {busy ? t('actions.working') : (confirmLabel ?? t('actions.confirm'))}
          </button>
        </div>
      </div>
    </div>
  );
}
