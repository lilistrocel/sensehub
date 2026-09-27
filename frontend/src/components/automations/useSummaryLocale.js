import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * `{ t, lng }` for the pure helpers in automationSummary.js (summary sentence,
 * durations, schedule texts). Stable between renders until the language changes.
 */
export function useSummaryLocale() {
  const { t, i18n } = useTranslation('automations');
  const lng = i18n.language;
  return useMemo(() => ({ t, lng }), [t, lng]);
}

export default useSummaryLocale;
