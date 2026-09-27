import React from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Small lock glyph shown next to a relay channel that is interlocked with
 * another channel on the same board.
 */
export default function InterlockBadge({ partnerLabel, className = '' }) {
  const { t } = useTranslation('common');
  const title = partnerLabel
    ? t('interlock.withPartner', { partner: partnerLabel })
    : t('interlock.generic');
  return (
    <span
      title={title}
      aria-label={title}
      data-testid="interlock-badge"
      className={`inline-flex items-center text-amber-600 dark:text-amber-400 flex-shrink-0 ${className}`}
    >
      <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path fillRule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clipRule="evenodd" />
      </svg>
    </span>
  );
}

export const ALL_ON_INTERLOCK_TITLE = 'All On is disabled: this board has interlocked channels that can never be ON together';
