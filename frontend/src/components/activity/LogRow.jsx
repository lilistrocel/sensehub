import React from 'react';
import { useTranslation } from 'react-i18next';
import { StatusMark, markFor, markLabel, ActorChip, DeviceIcon, CategoryTag, timeOfDay, countBadge } from './logFormat';

/**
 * One log entry. Desktop: time · mark · actor · device · summary · category on
 * one line (summary wraps). Phone (<640 px): time + mark + actor on the first
 * line, summary below, category + count last. The whole row is a button that
 * opens the detail drawer.
 */
export default function LogRow({ item, tz, onOpen, selected }) {
  const { t } = useTranslation('logs');
  const mark = markFor(item);
  const badge = countBadge(item, t);
  const failed = item.result === 'error' || item.result === 'denied';
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(item)}
        className={`w-full text-start px-3 py-2.5 sm:py-2 flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-3 border-b border-line last:border-b-0 hover:bg-field focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-inset ${selected ? 'bg-field' : ''}`}
        data-testid="log-row"
        data-source={item.source}
        data-action={item.action}
      >
        <span className="flex items-center gap-2 min-w-0 sm:w-[17rem] sm:shrink-0">
          <span className="font-mono tabular text-xs text-muted w-[4.6rem] shrink-0">{timeOfDay(item.time, tz)}</span>
          <StatusMark mark={mark} />
          <ActorChip item={item} className="min-w-0" />
          <DeviceIcon device={item.device} />
        </span>
        {/* server text: summaries arrive localized from the backend */}
        <span className="min-w-0 flex-1 text-sm text-ink break-words" dir="auto">
          {item.summary}
          {failed && <span className="sr-only"> ({markLabel(mark, t)})</span>}
        </span>
        <span className="flex items-center gap-2 sm:shrink-0 sm:justify-end sm:w-[9.5rem]">
          {badge && <span className="font-mono tabular text-[11px] text-muted whitespace-nowrap">{badge}</span>}
          <CategoryTag category={item.category} />
        </span>
      </button>
    </li>
  );
}
