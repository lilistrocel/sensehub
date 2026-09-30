import React, { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, ProvenanceBadge, ProvenanceMark } from '../../ui';
import ConfirmDialog from '../ConfirmDialog';
import ReportTabs, { tabPanelProps } from '../agronomist/ReportTabs';
import { useFormat } from '../../i18n/useFormat';
import { StatusMark } from '../agronomist/SectionStatus';
import { Section, NumInput, TableWrap, ElementTargetMark } from './parts';
import ScaleToEcDialog from './ScaleToEcDialog';
import { ELEMENTS, ppmDecimals, parseNum, targetStages, ecCorrespondenceState, stageRowProvenance } from './nutritionUtil';

/**
 * Targets per stage, editable (admin / operator), next to the human agronomist's
 * protocol values (read-only). Element targets live in crop_element_targets.
 *
 * Element targets follow the input EC target (2026-09-29): the header says which
 * EC the ppm currently correspond to; saving a changed EC target (or "Scale to
 * EC") opens a confirmation listing every element old → new with the factor.
 *
 * Provenance (operator request 2026-09-30): every value carries the shared
 * marker (src/ui/Provenance.jsx) - stage rows: protocol when equal to the
 * protocol, else operator; element rows: operator when hand-edited, else
 * calculated from the protocol (prefill at the design dilution or scaled to EC);
 * the protocol ppm column is calculated from the protocol.
 */

// [key, [min field, target field, max field] (null = not applicable), unit, decimals, protocol getter]
const STAGE_ROWS = [
  ['inputEc', ['ec_min', 'ec_target', 'ec_max'], 'mS/cm', 2, (p) => p && p.input_ec ? [p.input_ec.min, p.input_ec.target, p.input_ec.max] : null],
  ['inputPh', ['ph_min', null, 'ph_max'], '', 2, (p) => p && p.input_ph ? [p.input_ph.min, null, p.input_ph.max] : null],
  ['drainPct', ['drain_pct_min', 'drain_pct_target', 'drain_pct_max'], '%', 0, (p) => p && p.drain_pct ? [p.drain_pct.min, p.drain_pct.target, p.drain_pct.max] : null],
  ['drainEcDelta', [null, null, 'drain_ec_delta_max'], 'mS/cm', 1, (p) => p && p.drain_ec_delta_max != null ? [null, null, p.drain_ec_delta_max] : null],
  ['drainPh', ['drain_ph_min', null, 'drain_ph_max'], '', 1, (p) => p && p.drain_ph_alarm ? [p.drain_ph_alarm.min, null, p.drain_ph_alarm.max] : null],
  ['mlPerPlant', ['ml_min', 'ml_target', 'ml_max'], 'mL', 0, (p) => p && p.ml_per_plant_day ? [p.ml_per_plant_day.min, p.ml_per_plant_day.target, p.ml_per_plant_day.max] : null],
];

function Triple({ values, decimals, fmt }) {
  const [a, b, c] = values || [null, null, null];
  const f = (v) => (v === null || v === undefined ? '—' : fmt.number(v, { decimals }));
  if (!values) return <span className="text-muted">—</span>;
  return <span className="font-mono whitespace-nowrap" dir="ltr">{f(a)} · <strong className="font-semibold">{f(b)}</strong> · {f(c)}</span>;
}

const TRIPLE_KEYS = ['min', 'targetShort', 'max'];

/** Marker for one stage-target row (protocol value vs changed by the farm team). */
function StageRowMark({ values, proto, t }) {
  const p = stageRowProvenance(values, proto);
  if (!p) return null;
  const detail = p.kind === 'protocol' ? t('prov.stageProtocol')
    : !proto ? t('prov.stageNoProtocol')
    : t('prov.stageEdited', { fields: p.edited.map(i => t(`targets.col.${TRIPLE_KEYS[i]}`)).join(', ') });
  return <ProvenanceMark kind={p.kind} detail={detail} data-testid="stage-row-provenance" />;
}

export default function TargetsPanel({ profile, canEdit, api, onSaved }) {
  const { t } = useTranslation('nutrition');
  const fmt = useFormat();
  const idBase = useId().replace(/:/g, '');
  const stages = useMemo(() => targetStages(profile), [profile]);
  const [stage, setStage] = useState(profile.stage?.effective && stages.includes(profile.stage.effective) ? profile.stage.effective : stages[0]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [scaleOpen, setScaleOpen] = useState(false);

  useEffect(() => { if (!stages.includes(stage)) setStage(stages[0]); }, [stages, stage]);

  const st = (profile.stage_targets || {})[stage] || {};
  const els = (profile.element_targets || {})[stage] || [];
  const protoStage = profile.protocol?.data?.stage_targets?.[stage] || null;
  const protoPpm = profile.protocol_ppm?.by_stage?.[stage] || null;
  const corr = profile.element_targets_ec?.[stage] || null;
  const corrState = ecCorrespondenceState(corr, st.ec_target);
  const ratio = profile.protocol_ppm ? profile.protocol_ppm.design_dilution : 150;

  const begin = () => {
    const d = { stage: {}, el: {} };
    for (const [, fields] of STAGE_ROWS) for (const f of fields) if (f) d.stage[f] = st[f] ?? '';
    for (const el of ELEMENTS) {
      const r = els.find(e => e.element === el) || {};
      d.el[el] = { hard_min: r.hard_min ?? '', soft_target: r.soft_target ?? '', hard_max: r.hard_max ?? '' };
    }
    setDraft(d);
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    const stageBody = { stage };
    for (const [k, v] of Object.entries(draft.stage)) {
      const n = parseNum(v);
      if (Number.isNaN(n)) { setError(t('errors.notANumber', { field: t(`targets.field.${k}`) })); return; }
      stageBody[k] = n;
    }
    const elBody = [];
    for (const el of ELEMENTS) {
      const r = draft.el[el];
      const vals = { hard_min: parseNum(r.hard_min), soft_target: parseNum(r.soft_target), hard_max: parseNum(r.hard_max) };
      if (Object.values(vals).some(Number.isNaN)) { setError(t('errors.notANumber', { field: el })); return; }
      const had = els.find(e => e.element === el);
      if (!had && vals.hard_min === null && vals.soft_target === null && vals.hard_max === null) continue;
      elBody.push({ stage, element: el, ...vals });
    }
    setSaving(true);
    setError(null);
    try {
      const p = await api.send('PUT', `/nutrition/profiles/${profile.id}/targets`, { stage_targets: [stageBody], element_targets: elBody });
      onSaved(p);
      setEditing(false);
      // A changed input EC target: offer to scale the element targets (nothing changes without "Apply").
      const ecChanged = (st.ec_target ?? null) !== (stageBody.ec_target ?? null);
      if (ecChanged && stageBody.ec_target !== null && p.protocol_ppm?.by_stage?.[stage]) setScaleOpen(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    try {
      onSaved(await api.send('POST', `/nutrition/profiles/${profile.id}/targets/reset`));
      setConfirmReset(false);
      setEditing(false);
    } catch (e) {
      setError(e.message);
      setConfirmReset(false);
    } finally {
      setSaving(false);
    }
  };

  if (!stages.length) {
    return (
      <Section title={t('targets.title')} provenance="operator" testId="nutrition-targets">
        <p className="text-sm text-muted">{t('targets.none')}</p>
      </Section>
    );
  }

  const tabs = stages.map(s => ({ id: s, label: t(`stage.${s}`) + (profile.stage?.effective === s ? ` · ${t('targets.current')}` : '') }));
  const cellIn = (value, onChange, label) => <NumInput aria-label={label} value={value} onChange={onChange} className="w-[5.5rem]" />;

  return (
    <Section
      testId="nutrition-targets"
      title={t('targets.title')}
      subtitle={t('targets.subtitle')}
      canEdit={canEdit}
      editing={editing}
      onEdit={begin}
      onCancel={() => { setEditing(false); setError(null); }}
      onSave={save}
      saving={saving}
      actions={canEdit && !editing && profile.protocol ? (
        <>
          {protoPpm && <Button variant="secondary" size="sm" onClick={() => setScaleOpen(true)} data-testid="targets-scale">{t('targets.scale.button')}</Button>}
          <Button variant="ghost" size="sm" onClick={() => setConfirmReset(true)}>{t('targets.reset')}</Button>
        </>
      ) : null}
    >
      <ReportTabs tabs={tabs} active={stage} onChange={(s) => { if (!editing) setStage(s); }} idBase={idBase} label={t('targets.stagesLabel')} />
      <div {...tabPanelProps(idBase, stage)} className="pt-3 focus:outline-none">
        <TableWrap label={t('targets.stageTable')}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-label uppercase text-muted">
                <th className="py-1 pe-3 text-start font-semibold">{t('targets.col.target')}</th>
                <th className="py-1 pe-3 text-start font-semibold">{t('targets.col.profile')}</th>
                <th className="py-1 text-start font-semibold"><ProvenanceBadge kind="protocol" detail={t('prov.protocolColumn')} /></th>
              </tr>
            </thead>
            <tbody>
              {STAGE_ROWS.map(([key, fields, unit, dec, protoGet]) => (
                <tr key={key} className="border-t border-line align-middle">
                  <td className="py-1.5 pe-3">
                    {t(`targets.row.${key}`)}{unit && <span className="text-xs text-muted"> ({unit})</span>}
                  </td>
                  <td className="py-1.5 pe-3">
                    {editing ? (
                      <span className="flex flex-wrap gap-1" dir="ltr">
                        {fields.map((f, i) => (f ? <span key={f}>{cellIn(draft.stage[f], (v) => setDraft(d => ({ ...d, stage: { ...d.stage, [f]: v } })), `${t(`targets.row.${key}`)} ${t(`targets.col.${['min', 'targetShort', 'max'][i]}`)}`)}</span> : null))}
                      </span>
                    ) : (
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        <Triple values={fields.map(f => (f ? st[f] ?? null : null))} decimals={dec} fmt={fmt} />
                        <StageRowMark values={fields.map(f => (f ? st[f] ?? null : null))} proto={protoGet(protoStage)} t={t} />
                      </span>
                    )}
                  </td>
                  <td className="py-1.5"><Triple values={protoGet(protoStage)} decimals={dec} fmt={fmt} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
        <p className="text-xs text-muted mt-1">{t('targets.tripleHint')}</p>

        {corr && (
          <p className="mt-4 flex items-start gap-2 text-sm" data-testid="targets-ec-correspondence" data-state={corrState}>
            <span className="mt-0.5"><StatusMark status={corrState} /></span>
            <span className="min-w-0">
              {corr.source_water_ec !== null && corr.source_water_ec !== undefined
                ? t('targets.ecCorrespond', { fert: fmt.number(corr.fertilizer_ec_ms_cm, { decimals: 2 }), water: fmt.number(corr.source_water_ec, { decimals: 2 }), total: fmt.number(corr.total_ec_ms_cm, { decimals: 2 }) })
                : t('targets.ecCorrespondNoWater', { fert: fmt.number(corr.fertilizer_ec_ms_cm, { decimals: 2 }) })}
              {st.ec_target !== null && st.ec_target !== undefined && (
                <span className={corrState === 'ok' ? 'text-muted' : 'font-semibold'}>
                  {' · '}{corrState === 'ok' ? t('targets.ecMatch', { ec: fmt.number(st.ec_target, { decimals: 2 }) }) : t('targets.ecMismatch', { ec: fmt.number(st.ec_target, { decimals: 2 }) })}
                </span>
              )}
            </span>
          </p>
        )}
        <TableWrap label={t('targets.elementTable')}>
          <table className={`w-full text-sm ${corr ? 'mt-2' : 'mt-4'}`}>
            <thead>
              <tr className="text-label uppercase text-muted">
                <th className="py-1 pe-3 text-start font-semibold">{t('targets.col.element')}</th>
                <th className="py-1 pe-3 text-start font-semibold">{t('targets.col.profilePpm')}</th>
                <th className="py-1 text-end font-semibold">
                  <span className="inline-flex flex-wrap items-center justify-end gap-1">
                    {t('targets.col.protocolPpm', { ratio })}
                    <ProvenanceBadge kind="calculated" from="protocol" detail={t('prov.protocolRecipe', { ratio })} data-testid="protocol-ppm-provenance" />
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {ELEMENTS.map(el => {
                const r = els.find(e => e.element === el);
                const dec = ppmDecimals(el);
                return (
                  <tr key={el} className="border-t border-line">
                    <td className="py-1.5 pe-3 font-semibold" lang="en">{el}</td>
                    <td className="py-1.5 pe-3">
                      {editing ? (
                        <span className="flex flex-wrap gap-1" dir="ltr">
                          {['hard_min', 'soft_target', 'hard_max'].map((f, i) => (
                            <span key={f}>{cellIn(draft.el[el][f], (v) => setDraft(d => ({ ...d, el: { ...d.el, [el]: { ...d.el[el], [f]: v } } })), `${el} ${t(`targets.col.${['min', 'targetShort', 'max'][i]}`)}`)}</span>
                          ))}
                        </span>
                      ) : (
                        <span className="inline-flex flex-wrap items-center gap-1.5">
                          <Triple values={r ? [r.hard_min, r.soft_target, r.hard_max] : null} decimals={dec} fmt={fmt} />
                          <ElementTargetMark row={r} ratio={ratio} />
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 text-end font-mono">{protoPpm && protoPpm.ppm[el] != null ? fmt.number(protoPpm.ppm[el], { decimals: dec }) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
        {els.some(e => e.manual) && <p className="text-xs text-muted mt-1">{t('targets.manualHint')}</p>}
        {protoPpm && (
          <p className="text-xs text-muted mt-1">{t('targets.protocolPpmHint', { recipe: t(`recipe.${protoPpm.recipe}`, { defaultValue: protoPpm.recipe }), ratio: profile.protocol_ppm.design_dilution, ec: fmt.number(protoPpm.ec_ms_cm, { decimals: 2 }) })}</p>
        )}
        {error && <p role="alert" className="mt-2 text-sm text-state-alarm">{t('errors.saveFailed', { error })}</p>}
      </div>
      <ConfirmDialog
        open={confirmReset}
        title={t('targets.resetTitle')}
        body={t('targets.resetBody', { name: profile.protocol ? profile.protocol.name : '' })}
        confirmLabel={t('targets.reset')}
        busy={saving}
        onConfirm={reset}
        onCancel={() => setConfirmReset(false)}
      />
      <ScaleToEcDialog
        open={scaleOpen}
        profile={profile}
        stage={stage}
        api={api}
        onApplied={(p) => { setScaleOpen(false); onSaved(p); }}
        onClose={() => setScaleOpen(false)}
      />
    </Section>
  );
}
