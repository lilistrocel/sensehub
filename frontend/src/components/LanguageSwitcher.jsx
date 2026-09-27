import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLanguage } from '../context/LanguageContext';

/**
 * Language switcher. Each language is always shown in its own language and
 * script ("English / Türkçe / العربية") with its own `lang` and `dir`, so a
 * user who landed in the wrong language can still find theirs.
 *
 *   variant="menu"    header: globe + code button, popover list (compact at 390 px)
 *   variant="inline"  login page: a row of three buttons
 *   variant="list"    settings/profile: radio list
 */
function GlobeIcon({ className = 'w-5 h-5' }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" strokeWidth="2" />
      <path strokeWidth="2" strokeLinecap="round" d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
    </svg>
  );
}

function Check() {
  return (
    <svg className="w-4 h-4 shrink-0" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MenuSwitcher({ className }) {
  const { t } = useTranslation('common');
  const { language, languages, setLanguage } = useLanguage();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = languages.find((l) => l.code === language);
  const label = t('language.current', { name: current ? current.name : language });

  return (
    <div className={`relative ${className}`.trim()} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 min-h-[40px] px-2 rounded-md text-muted hover:text-ink hover:bg-field border border-transparent transition-colors"
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="language-switcher"
      >
        <GlobeIcon />
        <span className="font-mono text-xs font-semibold uppercase" lang="en">{current ? current.code : language}</span>
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t('language.choose')}
          className="absolute end-0 mt-2 w-44 z-50 bg-panel border border-line rounded-card shadow-lg py-1"
        >
          {languages.map((l) => {
            const active = l.code === language;
            return (
              <button
                key={l.code}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                lang={l.code}
                dir={l.dir}
                onClick={() => { setOpen(false); setLanguage(l.code); }}
                className={`w-full flex items-center justify-between gap-2 px-3 min-h-[44px] text-sm text-start transition-colors hover:bg-field ${active ? 'text-brand-700 dark:text-brand-200 font-semibold' : 'text-ink'}`}
                data-testid={`language-option-${l.code}`}
              >
                <span>{l.name}</span>
                {active && <Check />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function InlineSwitcher({ className }) {
  const { t } = useTranslation('common');
  const { language, languages, setLanguage } = useLanguage();
  return (
    <div className={`flex flex-wrap items-center justify-center gap-1 ${className}`.trim()} role="group" aria-label={t('language.choose')}>
      <GlobeIcon className="w-4 h-4 text-muted me-1" />
      {languages.map((l) => {
        const active = l.code === language;
        return (
          <button
            key={l.code}
            type="button"
            lang={l.code}
            dir={l.dir}
            aria-pressed={active}
            onClick={() => setLanguage(l.code)}
            className={`min-h-[40px] px-3 rounded-md text-sm transition-colors ${active ? 'bg-field text-ink font-semibold border border-line' : 'text-muted hover:text-ink hover:bg-field border border-transparent'}`}
            data-testid={`language-option-${l.code}`}
          >
            {l.name}
          </button>
        );
      })}
    </div>
  );
}

function ListSwitcher({ className }) {
  const { t } = useTranslation('common');
  const { language, languages, setLanguage } = useLanguage();
  return (
    <fieldset className={className}>
      <legend className="sr-only">{t('language.choose')}</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {languages.map((l) => {
          const active = l.code === language;
          return (
            <label
              key={l.code}
              className={`flex items-center gap-3 min-h-touch px-3 rounded-md border cursor-pointer transition-colors ${active ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/40' : 'border-line hover:bg-field'}`}
            >
              <input
                type="radio"
                name="ui-language"
                value={l.code}
                checked={active}
                onChange={() => setLanguage(l.code)}
              />
              <span lang={l.code} dir={l.dir} className="text-sm text-ink">{l.name}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export default function LanguageSwitcher({ variant = 'menu', className = '' }) {
  if (variant === 'inline') return <InlineSwitcher className={className} />;
  if (variant === 'list') return <ListSwitcher className={className} />;
  return <MenuSwitcher className={className} />;
}
