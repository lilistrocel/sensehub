import React from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Label, Button, ProvenanceBadge, ProvenanceMark } from '../../ui';
import { useFormat } from '../../i18n/useFormat';
import { elementTargetProvenance } from './nutritionUtil';

/**
 * Small building blocks of the Crop & Nutrition page. Strings: `nutrition` namespace.
 */

/**
 * Provenance badges of a section (shared kinds, src/ui/Provenance.jsx): a kind
 * string, one {kind, from, detail} object or an array of them.
 */
export function ProvenanceBadges({ items }) {
  const list = (Array.isArray(items) ? items : [items]).filter(Boolean).map(x => (typeof x === 'string' ? { kind: x } : x));
  return list.map((p, i) => <ProvenanceBadge key={`${p.kind}-${i}`} {...p} />);
}

/**
 * Where one element ppm target comes from: hand-edited by the farm team, or
 * calculated by SenseHub from the protocol (prefill at the 1:ratio design
 * dilution, or scaled to the input EC target). `fallback` = no row known.
 */
export function ElementTargetMark({ row, ratio, ratioSource = 'sensehub_assumption', fallback = false, className = '' }) {
  const { t } = useTranslation('nutrition');
  const fmt = useFormat();
  const p = elementTargetProvenance(row);
  if (!p) return fallback ? <ProvenanceMark kind="operator" detail={t('prov.targets')} className={className} /> : null;
  const detail = p.basis === 'manual' ? t('prov.elementManual')
    : p.basis === 'scaled' ? t('prov.elementScaled', { ec: p.ec != null ? fmt.number(p.ec, { decimals: 2 }) : '—', factor: p.factor != null ? fmt.number(p.factor, { decimals: 2 }) : '—' })
    : t(ratioSource === 'protocol' ? 'prov.elementProtocolStated' : 'prov.elementProtocol', { ratio });
  return <ProvenanceMark kind={p.kind} from={p.from} detail={detail} className={className} data-testid="element-target-provenance" />;
}

/** A section card: title, optional provenance badge(s), optional edit / save / cancel. */
export function Section({ title, subtitle, provenance = null, rail = null, editing = false, canEdit = false, onEdit, onSave, onCancel, saving = false, children, testId, actions = null }) {
  const { t } = useTranslation('nutrition');
  return (
    <Card rail={rail} padding="md" data-testid={testId}>
      <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-base font-semibold text-ink">{title}</h2>
            {provenance && <ProvenanceBadges items={provenance} />}
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

/**
 * Scroll container for wide tables at 390 px. `relative`: absolutely positioned
 * screen-reader labels (sr-only) inside the table are clipped by this scroller
 * instead of widening the whole page.
 */
export function TableWrap({ children, dir, label }) {
  return (
    <div className="relative overflow-x-auto -mx-1 px-1" dir={dir} role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}
