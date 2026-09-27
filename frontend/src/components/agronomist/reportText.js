/**
 * Language of the AI-generated text of the report on screen.
 *
 * Report text is never translated in the browser: the backend sends it in the
 * UI language when a translation is ready (translation_status 'ready'), else
 * in English. When that differs from the UI language (English original inside
 * the Arabic UI, say), the text elements get `lang` + `dir` so English reads
 * left-to-right and gets English typography, while the chrome stays RTL.
 * ReportView provides the value; ReportMarkdown / ReportActions consume it.
 */
import { createContext, useContext } from 'react';
import { dirOf, normalizeLanguage } from '../../i18n/languages';

export const ReportTextContext = createContext({});

export const useReportTextProps = () => useContext(ReportTextContext);

/** { lang, dir } for the report's text, or {} when it matches the UI language. */
export function reportTextProps(report, uiLanguage) {
  const ui = normalizeLanguage(uiLanguage) || 'en';
  const textLang = report?.translation_status === 'ready'
    ? (normalizeLanguage(report.translation_language) || ui)
    : 'en';
  if (textLang === ui) return {};
  return { lang: textLang, dir: dirOf(textLang) };
}
