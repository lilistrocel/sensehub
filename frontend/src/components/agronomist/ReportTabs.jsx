import React, { useEffect, useRef } from 'react';

/**
 * Accessible tab strip (WAI-ARIA tabs, automatic activation): roving
 * tabindex, Left/Right/Home/End move and select, the active tab scrolls into
 * view. The strip scrolls sideways on a phone instead of wrapping or widening
 * the page. Pair each panel with `tabPanelProps(idBase, id)`.
 *
 * tabs: [{ id, label, badge? }]
 * variant: 'underline' (report sections) | 'segmented' (page-level switch)
 */
export default function ReportTabs({ tabs, active, onChange, idBase, label, variant = 'underline', className = '' }) {
  const listRef = useRef(null);

  // Keep the selected tab visible inside the horizontally scrolling strip.
  useEffect(() => {
    const list = listRef.current;
    const el = list?.querySelector('[aria-selected="true"]');
    if (!list || !el || list.scrollWidth <= list.clientWidth) return;
    const lr = list.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    if (er.left < lr.left) list.scrollLeft -= lr.left - er.left + 16;
    else if (er.right > lr.right) list.scrollLeft += er.right - lr.right + 16;
  }, [active, tabs.length]);

  const onKeyDown = (e) => {
    const i = tabs.findIndex(t => t.id === active);
    let next = null;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next === null) return;
    e.preventDefault();
    onChange(tabs[next].id);
    listRef.current?.querySelector(`#${CSS.escape(`${idBase}-tab-${tabs[next].id}`)}`)?.focus();
  };

  const segmented = variant === 'segmented';
  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={segmented
        ? `inline-flex max-w-full overflow-x-auto p-0.5 gap-0.5 rounded-md border border-line bg-field ${className}`
        : `flex max-w-full overflow-x-auto gap-1 border-b border-line ${className}`}
    >
      {tabs.map(t => {
        const selected = t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${idBase}-tab-${t.id}`}
            aria-controls={`${idBase}-panel-${t.id}`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.id)}
            data-tab={t.id}
            className={segmented
              ? `shrink-0 min-h-[36px] px-4 rounded text-sm font-semibold whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${
                selected ? 'bg-panel text-ink shadow-sm' : 'text-muted hover:text-ink'}`
              : `shrink-0 min-h-touch px-3 -mb-px border-b-2 text-sm font-semibold whitespace-nowrap inline-flex items-center gap-1.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${
                selected ? 'border-brand-600 text-brand' : 'border-transparent text-muted hover:text-ink hover:border-line'}`}
          >
            {t.label}
            {t.badge != null && t.badge !== 0 && (
              <span
                className={`font-mono text-[11px] leading-4 min-w-[1.25rem] px-1 rounded-full text-center ${selected ? 'bg-brand-600 text-white' : 'bg-field text-muted border border-line'}`}
                aria-label={t.badgeLabel || `${t.badge}`}
              >
                {t.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function tabPanelProps(idBase, id) {
  return {
    role: 'tabpanel',
    id: `${idBase}-panel-${id}`,
    'aria-labelledby': `${idBase}-tab-${id}`,
    tabIndex: 0,
  };
}
