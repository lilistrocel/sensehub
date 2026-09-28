import React from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Label, Button } from '../../ui';

/**
 * Small building blocks of the Crop & Nutrition page. Strings: `nutrition` namespace.
 */

const SOURCE_STYLE = {
  live: 'border-water-300 text-water-700 dark:border-water-700 dark:text-water-300',
  operator: 'border-line text-muted',
  notMeasured: 'border-caution-300 text-caution-700 dark:border-caution-700 dark:text-caution-300',
  protocol: 'border-brand-300 text-brand-700 dark:border-brand-700 dark:text-brand-300',
  ai: 'border-lighting-300 text-lighting-700 dark:border-lighting-700 dark:text-lighting-300',
};

/** Where a block of data comes from: live system / operator / not measured / human protocol / AI. */
export function SourceBadge({ kind, className = '' }) {
  const { t } = useTranslation('nutrition');
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap ${SOURCE_STYLE[kind] || SOURCE_STYLE.operator} ${className}`} data-source={kind}>
      {kind === 'live' && <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-state-water" />}
      {t(`source.${kind}`)}
    </span>
  );
}

/** A section card: title, optional source badge, optional edit / save / cancel. */
export function Section({ title, subtitle, source, rail = null, editing = false, canEdit = false, onEdit, onSave, onCancel, saving = false, children, testId, actions = null }) {
  const { t } = useTranslation('nutrition');
  return (
    <Card rail={rail} padding="md" data-testid={testId}>
      <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-base font-semibold text-ink">{title}</h2>
            {source && <SourceBadge kind={source} />}
          </div>
          {subtitle && <p className="text-xs text-muted mt-0.5">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {actions}
          {canEdit && !editing && onEdit && (
            <Button variant="secondary" size="sm" onClick={onEdit}>{t('common:actions.edit')}</Button>
          )}
          {editing && (
            <>
              <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>{t('common:actions.cancel')}</Button>
              <Button variant="primary" size="sm" onClick={onSave} disabled={saving}>{saving ? t('common:actions.saving') : t('common:actions.save')}</Button>
            </>
          )}
        </div>
      </div>
      {children}
    </Card>
  );
}

/** Label above a value (read) or an input (edit). */
export function Field({ label, children, hint, className = '' }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <Label>{label}</Label>
      <div className="mt-0.5 text-sm text-ink min-w-0 break-words">{children}</div>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

/** "—" for absence (never a fake value). */
export function Dash() {
  return <span className="text-muted">—</span>;
}

export function TextInput({ value, onChange, id, invalid, className = '', ...rest }) {
  return (
    <input
      id={id}
      type="text"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      aria-invalid={invalid || undefined}
      className={`w-full min-h-[36px] rounded-md border bg-panel px-2 py-1 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500 ${invalid ? 'border-state-alarm' : 'border-line'} ${className}`}
      {...rest}
    />
  );
}

export function NumInput({ value, onChange, id, invalid, unit, className = '', ...rest }) {
  return (
    <span className={`flex items-center gap-1 min-w-0 ${className}`}>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        dir="ltr"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid || undefined}
        className={`w-full min-w-0 min-h-[36px] rounded-md border bg-panel px-2 py-1 text-sm font-mono text-ink text-end focus:outline-none focus:ring-2 focus:ring-brand-500 ${invalid ? 'border-state-alarm' : 'border-line'}`}
        {...rest}
      />
      {unit && <span className="text-xs text-muted shrink-0" dir="ltr">{unit}</span>}
    </span>
  );
}

/** Number + unit in mono, or a dash. */
export function Num({ value, decimals = 1, unit, fmt, className = '' }) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return <Dash />;
  return (
    <span className={`font-mono ${className}`}>
      {unit ? fmt.withUnit(Number(value), unit, { decimals }) : fmt.number(Number(value), { decimals })}
    </span>
  );
}

/** Scroll container for wide tables at 390 px. */
export function TableWrap({ children, dir, label }) {
  return (
    <div className="overflow-x-auto -mx-1 px-1" dir={dir} role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}
