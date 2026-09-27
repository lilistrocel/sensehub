import React, { useId } from 'react';

/**
 * One collapsible row of the agronomist settings area. Collapsed by default;
 * the header carries a one-line summary so the closed state still says what
 * the section holds. The parent owns `open` so section state is explicit.
 */
export default function SettingsSection({ id, title, summary, open, onToggle, children }) {
  const bodyId = useId();
  return (
    <div data-testid={`settings-section-${id}`} data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={bodyId}
        className="w-full min-h-touch px-4 py-2 flex items-center gap-3 text-start hover:bg-field focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
      >
        <svg
          aria-hidden="true"
          className={`w-4 h-4 shrink-0 text-muted transition-transform rtl:-scale-x-100 ${open ? 'rotate-90 rtl:-rotate-90' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <span className="text-sm font-semibold text-ink shrink-0">{title}</span>
        {summary && (
          <span className="min-w-0 flex-1 text-xs text-muted font-mono truncate" dir="auto" title={typeof summary === 'string' ? summary : undefined}>
            {summary}
          </span>
        )}
      </button>
      {open && (
        <div id={bodyId} className="px-4 pb-4 pt-1">
          {children}
        </div>
      )}
    </div>
  );
}
