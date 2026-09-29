import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ConfirmDialog from '../ConfirmDialog';
import { useFormat } from '../../i18n/useFormat';
import { ppmDecimals } from './nutritionUtil';

/**
 * "Scale element targets to EC x?" (operator request 2026-09-29). Asks the backend
 * for a preview (nothing written), lists every element old → new with the factor
 * and the EC math, keeps hand-edited rows unless the operator ticks them, and
 * applies only on "Apply". "Keep current" writes nothing.
 */

const REASONS = ['no_ec_target', 'no_protocol', 'no_protocol_recipe', 'protocol_ec_unknown', 'source_water_exceeds_target', 'factor_out_of_range'];

function Ppm({ row, el, fmt }) {
  if (!row || row.soft_target === null || row.soft_target === undefined) return <span className="text-muted">—</span>;
  const d = ppmDecimals(el);
  return (
    <span className="font-mono whitespace-nowrap" dir="ltr">
      <strong className="font-semibold">{fmt.number(row.soft_target, { decimals: d })}</strong>
      <span className="block text-[11px] text-muted">{row.hard_min != null ? fmt.number(row.hard_min, { decimals: d }) : '—'} – {row.hard_max != null ? fmt.number(row.hard_max, { decimals: d }) : '—'}</span>
    </span>
  );
}

export default function ScaleToEcDialog({ open, profile, stage, api, onApplied, onClose }) {
  const { t } = useTranslation('nutrition');
  const fmt = useFormat();
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [include, setInclude] = useState([]);

  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    setPreview(null); setError(null); setInclude([]);
    api.send('POST', `/nutrition/profiles/${profile.id}/targets/scale-to-ec`, { stage, preview: true })
      .then((p) => { if (alive) setPreview(p); })
      .catch((e) => { if (alive) setError({ kind: 'load', message: e.message }); });
    return () => { alive = false; };
  }, [open, profile.id, stage, api]);

  if (!open) return null;

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.send('POST', `/nutrition/profiles/${profile.id}/targets/scale-to-ec`, { stage, preview: false, include });
      onApplied(r.profile);
    } catch (e) {
      setError({ kind: 'save', message: e.message });
    } finally {
      setBusy(false);
    }
  };

  const m = preview?.math;
  const ok = !!(preview && preview.ok);
  const n2 = (v) => (v === null || v === undefined ? '—' : fmt.number(v, { decimals: 2 }));
  const toggle = (el) => setInclude(list => (list.includes(el) ? list.filter(x => x !== el) : [...list, el]));
  const changes = ok ? preview.rows.filter(r => r.action === 'update' || r.action === 'insert' || (r.action === 'kept_manual' && include.includes(r.element))).length : 0;

  let body;
  const errorLine = error ? <p role="alert" className="text-state-alarm">{t(error.kind === 'load' ? 'errors.loadFailed' : 'errors.saveFailed', { error: error.message })}</p> : null;
  if (error && !preview) {
    body = errorLine;
  } else if (!preview) {
    body = <p>{t('common:status.loading')}</p>;
  } else if (!ok) {
    const reason = REASONS.includes(preview.reason) ? preview.reason : 'no_protocol';
    body = (
      <p data-testid="scale-not-possible" data-reason={reason}>
        {t(`targets.scale.reason.${reason}`, {
          stage: t(`stage.${stage}`),
          factor: m && m.factor != null ? fmt.number(m.factor, { decimals: 2 }) : '—',
          min: fmt.number(m ? m.limits.min : 0.3, { decimals: 1 }),
          max: fmt.number(m ? m.limits.max : 3, { decimals: 1 }),
          ec: n2(m && m.ec_target),
          water: n2(m && m.source_water_ec),
        })}
      </p>
    );
  } else {
    body = (
      <div className="space-y-2" data-testid="scale-preview">
        <p className="font-semibold text-ink dark:text-white">
          {t('targets.scale.factorLine', { factor: fmt.number(m.factor, { decimals: 2 }), recipe: t(`recipe.${m.recipe}`, { defaultValue: m.recipe }), design: m.design_dilution, equiv: m.equivalent_dilution })}
        </p>
        <p className="text-xs">
          {m.source_water_known
            ? t('targets.scale.mathLine', { fert: n2(m.fertilizer_ec_target), ec: n2(m.ec_target), water: n2(m.source_water_ec), protocol: n2(m.protocol_fertilizer_ec), design: m.design_dilution })
            : t('targets.scale.mathLineNoWater', { fert: n2(m.fertilizer_ec_target), ec: n2(m.ec_target), protocol: n2(m.protocol_fertilizer_ec), design: m.design_dilution })}
        </p>
        <div className="max-h-[45vh] overflow-y-auto rounded-md border border-line" role="region" aria-label={t('targets.scale.tableLabel')} tabIndex={0}>
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-panel">
              <tr className="text-label uppercase text-muted">
                <th className="py-1 px-2 text-start font-semibold">{t('targets.col.element')}</th>
                <th className="py-1 px-2 text-end font-semibold">{t('targets.scale.colNow')}</th>
                <th className="py-1 px-2 text-end font-semibold">{t('targets.scale.colNew')}</th>
              </tr>
            </thead>
            <tbody>
              {preview.rows.map(r => {
                const kept = r.action === 'kept_manual' && !include.includes(r.element);
                return (
                  <tr key={r.element} className="border-t border-line align-top" data-element={r.element} data-action={r.action}>
                    <td className="py-1 px-2">
                      <span className="font-semibold" lang="en">{r.element}</span>
                      {r.manual && (
                        <label className="mt-0.5 flex items-center gap-1 text-[11px] text-caution-700 dark:text-caution-300">
                          <input type="checkbox" checked={include.includes(r.element)} onChange={() => toggle(r.element)} aria-label={t('targets.scale.overwriteAria', { el: r.element })} />
                          {t('targets.scale.overwrite')}
                        </label>
                      )}
                    </td>
                    <td className="py-1 px-2 text-end"><Ppm row={r.old} el={r.element} fmt={fmt} /></td>
                    <td className="py-1 px-2 text-end">
                      <span className={kept ? 'inline-block opacity-50 line-through' : 'inline-block'}><Ppm row={r.new} el={r.element} fmt={fmt} /></span>
                      {kept && <span className="block text-[11px] text-caution-700 dark:text-caution-300">{t('targets.scale.keptManual')}</span>}
                      {r.action === 'unchanged' && <span className="block text-[11px] text-muted">{t('targets.scale.unchanged')}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {preview.kept_manual.length > 0 && <p className="text-xs">{t('targets.scale.manualHelp', { elements: preview.kept_manual.join(', ') })}</p>}
        <p className="text-xs text-muted">{t('targets.scale.ratiosNote')}</p>
        {errorLine}
      </div>
    );
  }

  return (
    <ConfirmDialog
      open={open}
      title={preview && !ok ? t('targets.scale.notPossibleTitle') : t('targets.scale.title', { ec: n2(m ? m.ec_target : (profile.stage_targets?.[stage]?.ec_target ?? null)) })}
      body={body}
      confirmLabel={t('targets.scale.apply')}
      cancelLabel={t('targets.scale.keep')}
      busy={busy}
      confirmDisabled={!ok || changes === 0}
      onConfirm={apply}
      onCancel={onClose}
    />
  );
}
