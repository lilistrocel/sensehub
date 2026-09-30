import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Label, Button, StatusPill, ProvenanceBadge, ProvenanceMark } from '../../ui';
import ConfirmDialog from '../ConfirmDialog';
import { useFormat } from '../../i18n/useFormat';
import { Section, Field, Dash, TextInput, NumInput, Num, TableWrap } from './parts';
import SystemPanel from './SystemPanel';
import TargetsPanel from './TargetsPanel';
import ControllerLinkPanel from './ControllerLinkPanel';
import { STAGES, diffFields, invalidField, stageDate, plantsProvenance } from './nutritionUtil';

/**
 * Crop profile: crop (editable), what SenseHub cannot measure (editable, short),
 * the fertigation system (LIVE, read-only), stage & timeline (auto + override),
 * targets per stage, crop-cycle history. Viewing: every role; editing: admin / operator.
 */

const CROP_TEXT = ['crop', 'variety', 'breeder', 'planting_type'];
const CROP_NUM = ['plants_per_m2'];
const NM_TEXT = ['substrate_type', 'substrate_notes'];
const NM_NUM = ['plants_per_section', 'area_m2', 'dripper_flow_lph', 'drippers_per_plant', 'buffer_tank_l', 'substrate_volume_l', 'source_water_ec', 'source_water_ph'];
const NM_UNITS = { plants_per_section: null, area_m2: 'm²', dripper_flow_lph: 'L/h', drippers_per_plant: null, buffer_tank_l: 'L', substrate_volume_l: 'L', source_water_ec: 'mS/cm', source_water_ph: 'pH' };
const NM_DECIMALS = { plants_per_section: 0, area_m2: 0, dripper_flow_lph: 1, drippers_per_plant: 0, buffer_tank_l: 0, substrate_volume_l: 1, source_water_ec: 2, source_water_ph: 1 };

const pick = (obj, keys) => Object.fromEntries(keys.map(k => [k, obj?.[k] ?? '']));

export default function ProfilePanel({ profile, canEdit, save, onSaved, api }) {
  const { t } = useTranslation('nutrition');
  const fmt = useFormat();
  const [edit, setEdit] = useState(null); // 'crop' | 'nm' | 'stage'
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const begin = (section) => {
    setError(null);
    setEdit(section);
    if (section === 'crop') setDraft({ ...pick(profile, [...CROP_TEXT, ...CROP_NUM]), transplant_date: profile.transplant_date || '' });
    if (section === 'nm') setDraft(pick(profile, [...NM_TEXT, ...NM_NUM]));
    if (section === 'stage') {
      setDraft({
        stage_override: profile.stage_override || '',
        stage_override_note: profile.stage_override_note || '',
        stage_timeline: (profile.stage_timeline || []).map(e => ({ stage: e.stage, from_day: String(e.from_day), note: e.note || '' })),
      });
    }
  };
  const cancel = () => { setEdit(null); setError(null); };
  const set = (k) => (v) => setDraft(d => ({ ...d, [k]: v }));

  const submit = async () => {
    const numeric = edit === 'crop' ? CROP_NUM : edit === 'nm' ? NM_NUM : [];
    const bad = invalidField(draft, numeric);
    if (bad) { setError(t('errors.notANumber', { field: t(`fields.${bad}`) })); return; }
    let body;
    if (edit === 'stage') {
      const tl = draft.stage_timeline.map(e => ({ stage: e.stage, from_day: Number(e.from_day), note: e.note || null }));
      if (tl.some(e => !Number.isInteger(e.from_day) || e.from_day < 0)) { setError(t('errors.timelineDay')); return; }
      body = { stage_override: draft.stage_override || null, stage_override_note: draft.stage_override ? (draft.stage_override_note || null) : null, stage_timeline: tl };
    } else {
      body = diffFields(profile, draft, numeric);
      if (edit === 'crop' && !String(draft.crop || '').trim()) { setError(t('errors.cropRequired')); return; }
    }
    if (!Object.keys(body).length) { setEdit(null); return; }
    setSaving(true);
    setError(null);
    try {
      const updated = await save(body);
      onSaved(updated);
      setEdit(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const stage = profile.stage || {};
  const plants = profile.plants || {};
  const errorBox = error ? <p role="alert" className="mt-2 text-sm text-state-alarm">{t('errors.saveFailed', { error })}</p> : null;

  return (
    <div className="space-y-4">
      {/* ---- Crop ---- */}
      <Section
        testId="nutrition-crop"
        title={t('profile.crop.title')}
        provenance="operator"
        canEdit={canEdit}
        editing={edit === 'crop'}
        onEdit={() => begin('crop')}
        onCancel={cancel}
        onSave={submit}
        saving={saving}
      >
        {edit === 'crop' ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {CROP_TEXT.map(k => (
              <Field key={k} label={<label htmlFor={`f-${k}`}>{t(`fields.${k}`)}</label>}>
                <TextInput id={`f-${k}`} value={draft[k]} onChange={set(k)} dir="auto" />
              </Field>
            ))}
            <Field label={<label htmlFor="f-transplant">{t('fields.transplant_date')}</label>}>
              <input id="f-transplant" type="date" dir="ltr" value={draft.transplant_date || ''} onChange={(e) => set('transplant_date')(e.target.value)}
                className="w-full min-h-[36px] rounded-md border border-line bg-panel px-2 py-1 text-sm text-ink" />
            </Field>
            <Field label={<label htmlFor="f-density">{t('fields.plants_per_m2')}</label>}>
              <NumInput id="f-density" value={draft.plants_per_m2} onChange={set('plants_per_m2')} unit="/m²" />
            </Field>
          </div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            {CROP_TEXT.map(k => (
              <Field key={k} label={t(`fields.${k}`)}>{profile[k] ? <span dir="auto">{k === 'planting_type' ? t(`plantingType.${profile[k]}`, { defaultValue: profile[k] }) : profile[k]}</span> : <Dash />}</Field>
            ))}
            <Field label={t('fields.transplant_date')}>{profile.transplant_date ? <span className="font-mono">{fmt.date(`${profile.transplant_date}T12:00:00Z`)}</span> : <Dash />}</Field>
            <Field label={t('fields.plants_per_m2')}><Num value={profile.plants_per_m2} decimals={1} fmt={fmt} /></Field>
          </div>
        )}
        {edit === 'crop' && errorBox}
      </Section>

      {/* ---- Not measured by SenseHub ---- */}
      <Section
        testId="nutrition-not-measured"
        title={t('profile.notMeasured.title')}
        subtitle={t('profile.notMeasured.subtitle')}
        provenance={{ kind: 'operator', detail: t('prov.notMeasured') }}
        canEdit={canEdit}
        editing={edit === 'nm'}
        onEdit={() => begin('nm')}
        onCancel={cancel}
        onSave={submit}
        saving={saving}
      >
        {edit === 'nm' ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <Field label={<label htmlFor="f-substrate">{t('fields.substrate_type')}</label>}>
              <TextInput id="f-substrate" value={draft.substrate_type} onChange={set('substrate_type')} dir="auto" />
            </Field>
            {NM_NUM.map(k => (
              <Field key={k} label={<label htmlFor={`f-${k}`}>{t(`fields.${k}`)}</label>}>
                <NumInput id={`f-${k}`} value={draft[k]} onChange={set(k)} unit={NM_UNITS[k] && NM_UNITS[k] !== 'pH' ? NM_UNITS[k] : null} />
              </Field>
            ))}
            <Field className="sm:col-span-2 lg:col-span-3" label={<label htmlFor="f-substrate-notes">{t('fields.substrate_notes')}</label>}>
              <TextInput id="f-substrate-notes" value={draft.substrate_notes} onChange={set('substrate_notes')} dir="auto" />
            </Field>
          </div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            <Field label={t('fields.substrate_type')}>{profile.substrate_type ? <span dir="auto">{profile.substrate_type}</span> : <Dash />}</Field>
            {NM_NUM.map(k => (
              <Field key={k} label={t(`fields.${k}`)}>
                <Num value={profile[k]} decimals={NM_DECIMALS[k]} unit={NM_UNITS[k] && NM_UNITS[k] !== 'pH' ? NM_UNITS[k] : null} fmt={fmt} />
              </Field>
            ))}
            {profile.substrate_notes && <Field className="col-span-2 lg:col-span-3" label={t('fields.substrate_notes')}><span dir="auto">{profile.substrate_notes}</span></Field>}
          </div>
        )}
        {edit === 'nm' && errorBox}
        <div className="mt-3 pt-3 border-t border-line flex flex-wrap items-center gap-x-4 gap-y-1 text-sm" data-testid="nutrition-plants">
          <Label className="shrink-0">{t('profile.plants.title')}</Label>
          {plants.total ? (
            <>
              <span className="inline-flex items-center gap-1.5">
                <span className="font-mono">{t('profile.plants.total', { total: fmt.int(plants.total), perSection: fmt.int(plants.per_section), sections: plants.sections })}</span>
                {plantsProvenance(plants.source) && <ProvenanceMark kind={plantsProvenance(plants.source)} from={plants.source === 'estimated_from_flow' ? 'measured' : null} data-testid="plants-provenance" />}
              </span>
              <span className="text-xs text-muted">{t(`profile.plants.source.${plants.source}`, {
                flow: plants.basis ? fmt.withUnit(plants.basis.zone_flow_lph, 'L/h', { decimals: 0 }) : '',
                dripper: plants.basis ? fmt.withUnit(plants.basis.dripper_flow_lph, 'L/h', { decimals: 1 }) : '',
              })}</span>
            </>
          ) : (
            <span className="text-muted">{t('profile.plants.unknown')}</span>
          )}
        </div>
      </Section>

      {/* ---- Fertigation system (live) ---- */}
      <SystemPanel api={api} profile={profile} />

      {/* ---- Stage & timeline ---- */}
      <Section
        testId="nutrition-stage"
        title={t('profile.stage.title')}
        provenance="operator"
        canEdit={canEdit}
        editing={edit === 'stage'}
        onEdit={() => begin('stage')}
        onCancel={cancel}
        onSave={submit}
        saving={saving}
      >
        <div className="flex flex-wrap items-center gap-2 mb-3">
          {stage.effective ? (
            <StatusPill state="ok" filled text={t(`stage.${stage.effective}`)} data-testid="nutrition-stage-pill" />
          ) : (
            <StatusPill state="idle" text={t('stage.none')} className="!border-dashed" />
          )}
          <span className="text-sm text-muted">
            {stage.days_after_transplant !== null && stage.days_after_transplant !== undefined
              ? (stage.days_after_transplant >= 0 ? t('profile.stage.day', { count: stage.days_after_transplant }) : t('profile.stage.beforeTransplant'))
              : t('profile.stage.noTransplant')}
          </span>
          {(stage.source === 'override' || stage.source === 'auto') && (
            <ProvenanceMark kind={stage.source === 'override' ? 'operator' : 'calculated'} detail={stage.source === 'override' ? t('prov.stageOverride') : t('prov.stageAuto')} data-testid="stage-provenance" />
          )}
          <span className="text-xs text-muted">· {stage.source === 'override' ? t('profile.stage.sourceOverride') : stage.source === 'auto' ? t('profile.stage.sourceAuto') : ''}</span>
        </div>
        {stage.override && stage.override.note && edit !== 'stage' && (
          <p className="text-sm text-muted mb-2" dir="auto">{t('profile.stage.overrideNote', { note: stage.override.note })}</p>
        )}
        {stage.next && edit !== 'stage' && (
          <p className="text-sm mb-3" data-testid="nutrition-next-stage">
            {t('profile.stage.next', { stage: t(`stage.${stage.next.stage}`), date: fmt.date(`${stage.next.date}T12:00:00Z`), count: stage.next.in_days })}
          </p>
        )}
        {edit === 'stage' ? (
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label={<label htmlFor="f-override">{t('profile.stage.override')}</label>}>
                <select id="f-override" value={draft.stage_override} onChange={(e) => set('stage_override')(e.target.value)}
                  className="w-full min-h-[36px] rounded-md border border-line bg-panel px-2 py-1 text-sm text-ink">
                  <option value="">{t('profile.stage.overrideAuto')}</option>
                  {STAGES.map(s => <option key={s} value={s}>{t(`stage.${s}`)}</option>)}
                </select>
              </Field>
              {draft.stage_override && (
                <Field label={<label htmlFor="f-override-note">{t('profile.stage.overrideNoteLabel')}</label>}>
                  <TextInput id="f-override-note" value={draft.stage_override_note} onChange={set('stage_override_note')} dir="auto" />
                </Field>
              )}
            </div>
            <Label>{t('profile.stage.timeline')}</Label>
            {draft.stage_timeline.map((e, i) => (
              <div key={i} className="grid grid-cols-[1fr_5.5rem_auto] sm:grid-cols-[10rem_6rem_1fr_auto] gap-2 items-center">
                <select aria-label={t('profile.stage.stageCol')} value={e.stage}
                  onChange={(ev) => setDraft(d => ({ ...d, stage_timeline: d.stage_timeline.map((x, j) => (j === i ? { ...x, stage: ev.target.value } : x)) }))}
                  className="min-h-[36px] rounded-md border border-line bg-panel px-2 py-1 text-sm text-ink">
                  {STAGES.map(s => <option key={s} value={s}>{t(`stage.${s}`)}</option>)}
                </select>
                <NumInput aria-label={t('profile.stage.fromDay')} value={e.from_day}
                  onChange={(v) => setDraft(d => ({ ...d, stage_timeline: d.stage_timeline.map((x, j) => (j === i ? { ...x, from_day: v } : x)) }))} />
                <TextInput aria-label={t('profile.stage.note')} className="hidden sm:block" value={e.note} dir="auto"
                  onChange={(v) => setDraft(d => ({ ...d, stage_timeline: d.stage_timeline.map((x, j) => (j === i ? { ...x, note: v } : x)) }))} />
                <Button variant="danger-ghost" size="sm" aria-label={t('profile.stage.removeRow')}
                  onClick={() => setDraft(d => ({ ...d, stage_timeline: d.stage_timeline.filter((_, j) => j !== i) }))}>×</Button>
              </div>
            ))}
            <Button variant="secondary" size="sm" onClick={() => setDraft(d => ({ ...d, stage_timeline: [...d.stage_timeline, { stage: 'fruiting', from_day: '', note: '' }] }))}>
              {t('profile.stage.addRow')}
            </Button>
            {errorBox}
          </div>
        ) : (
          <TableWrap label={t('profile.stage.timeline')}>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-start text-label uppercase text-muted">
                  <th className="py-1 pe-3 text-start font-semibold">{t('profile.stage.stageCol')}</th>
                  <th className="py-1 pe-3 text-end font-semibold">{t('profile.stage.fromDay')}</th>
                  <th className="py-1 pe-3 text-start font-semibold">{t('profile.stage.dateCol')}</th>
                  <th className="py-1 text-start font-semibold">{t('profile.stage.note')}</th>
                </tr>
              </thead>
              <tbody>
                {(profile.stage_timeline || []).map((e, i) => (
                  <tr key={i} className={`border-t border-line ${stage.current_entry && stage.current_entry.from_day === e.from_day ? 'bg-field' : ''}`}>
                    <td className="py-1.5 pe-3 whitespace-nowrap">{t(`stage.${e.stage}`)}</td>
                    <td className="py-1.5 pe-3 text-end font-mono">{e.from_day}</td>
                    <td className="py-1.5 pe-3 font-mono whitespace-nowrap">{stageDate(profile.transplant_date, e.from_day) ? fmt.date(`${stageDate(profile.transplant_date, e.from_day)}T12:00:00Z`) : '—'}</td>
                    <td className="py-1.5 text-muted min-w-[12rem]" dir="auto">{e.note || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Section>

      {/* ---- Targets per stage ---- */}
      <TargetsPanel profile={profile} canEdit={canEdit} api={api} onSaved={onSaved} />

      {/* ---- Dose controller link: follow the crop targets through approved proposals ---- */}
      {profile.active && <ControllerLinkPanel api={api} canEdit={canEdit} profileId={profile.id} refreshKey={profile.updated_at} />}

      {/* ---- Human protocol baseline ---- */}
      {profile.protocol && <ProtocolCard protocol={profile.protocol} />}

      {/* ---- Crop cycles ---- */}
      <HistoryCard api={api} profile={profile} canEdit={canEdit} onCreated={onSaved} />
    </div>
  );
}

/** The human agronomist's protocol as a read-only reference (authoritative). */
function ProtocolCard({ protocol }) {
  const { t } = useTranslation('nutrition');
  const fmt = useFormat();
  const d = protocol.data || {};
  const prog = d.daily_program;
  const cl = d.climate;
  return (
    <Card padding="md" data-testid="nutrition-protocol">
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <h2 className="font-display text-base font-semibold text-ink">{t('protocol.title')}</h2>
        <ProvenanceBadge kind="protocol" detail={t('prov.protocolColumn')} />
        <span className="text-xs text-muted">{t('protocol.readOnly')}</span>
      </div>
      <p className="text-sm text-muted" dir="auto">{protocol.name}</p>
      <p className="text-xs text-muted mt-0.5">{t('protocol.authoritative')}</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
        {prog && (
          <div>
            <Label>{t('protocol.dailyProgram')}</Label>
            <TableWrap dir="ltr" label={t('protocol.dailyProgram')}>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {prog.runs.map(r => (
                  <span key={r.time} className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-xs ${r.new_in_table ? 'border-brand-300 text-brand-700 dark:text-brand-300' : 'border-line text-ink'}`}>
                    {r.time} · {fmt.number(r.minutes, { decimals: r.minutes % 1 ? 1 : 0 })}′
                  </span>
                ))}
              </div>
            </TableWrap>
            <p className="text-xs text-muted mt-1">{t('protocol.programTotal', { minutes: prog.minutes_per_section, ml: fmt.int(prog.ml_per_plant_day) })}</p>
            {prog.effective_from && <p className="text-xs text-muted mt-0.5">{t('protocol.programFrom', { date: fmt.date(`${prog.effective_from}T12:00:00Z`) })}</p>}
          </div>
        )}
        {cl && (
          <div>
            <Label>{t('protocol.climate')}</Label>
            <ul className="text-sm mt-1 space-y-0.5">
              <li>{t('protocol.climateDay', { min: cl.day_c.min, max: cl.day_c.max, alarm: cl.day_alarm_above_c })}</li>
              <li>{t('protocol.climateNight', { min: cl.night_c.min, max: cl.night_c.max, alarm: cl.night_alarm_below_c })}</li>
              <li>{t('protocol.climateRh', { min: cl.rh_pct.min, max: cl.rh_pct.max, low: cl.rh_alarm_below_pct, high: cl.rh_alarm_above_pct })}</li>
            </ul>
          </div>
        )}
      </div>
      {Array.isArray(d.timeline) && (
        <div className="mt-3">
          <Label>{t('protocol.timeline')}</Label>
          <ul className="text-sm mt-1 space-y-0.5">
            {d.timeline.map((e, i) => (
              <li key={i}><span className="font-mono text-muted me-2" dir="ltr">{e.to_day ? `${e.from_day}-${e.to_day}` : `${e.from_day}+`}</span><span dir="auto" lang="en">{e.text}</span></li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

/** Previous crop cycles + "new crop cycle". */
function HistoryCard({ api, profile, canEdit, onCreated }) {
  const { t } = useTranslation('nutrition');
  const fmt = useFormat();
  const [list, setList] = useState(null);
  const [form, setForm] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    api.get('/nutrition/profiles?include_inactive=1').then(r => { if (alive) setList(r); }).catch(() => { if (alive) setList([]); });
    return () => { alive = false; };
  }, [api, profile.id, profile.updated_at]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const p = await api.send('POST', '/nutrition/profiles', {
        crop: form.crop, variety: form.variety || null, transplant_date: form.transplant_date || null,
        zone_id: profile.zone_id, protocol_id: form.useProtocol ? profile.protocol_id : undefined,
      });
      setForm(null);
      setConfirm(false);
      onCreated(p);
    } catch (e) {
      setError(e.message);
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  };

  const past = (list || []).filter(p => !p.active);
  return (
    <Card padding="md" data-testid="nutrition-history">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <h2 className="font-display text-base font-semibold text-ink">{t('history.title')}</h2>
        {canEdit && !form && (
          <Button variant="secondary" size="sm" onClick={() => setForm({ crop: profile.crop || '', variety: '', transplant_date: '', useProtocol: !!profile.protocol_id })}>
            {t('history.newCycle')}
          </Button>
        )}
      </div>
      {form && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
          <Field label={<label htmlFor="n-crop">{t('fields.crop')}</label>}><TextInput id="n-crop" value={form.crop} onChange={(v) => setForm(f => ({ ...f, crop: v }))} dir="auto" /></Field>
          <Field label={<label htmlFor="n-variety">{t('fields.variety')}</label>}><TextInput id="n-variety" value={form.variety} onChange={(v) => setForm(f => ({ ...f, variety: v }))} dir="auto" /></Field>
          <Field label={<label htmlFor="n-date">{t('fields.transplant_date')}</label>}>
            <input id="n-date" type="date" dir="ltr" value={form.transplant_date} onChange={(e) => setForm(f => ({ ...f, transplant_date: e.target.value }))}
              className="w-full min-h-[36px] rounded-md border border-line bg-panel px-2 py-1 text-sm text-ink" />
          </Field>
          {profile.protocol_id && (
            <label className="sm:col-span-3 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.useProtocol} onChange={(e) => setForm(f => ({ ...f, useProtocol: e.target.checked }))} />
              {t('history.useProtocol', { name: profile.protocol ? profile.protocol.name : '' })}
            </label>
          )}
          <div className="sm:col-span-3 flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setForm(null); setError(null); }}>{t('common:actions.cancel')}</Button>
            <Button variant="primary" size="sm" disabled={!form.crop.trim() || busy} onClick={() => setConfirm(true)}>{t('history.create')}</Button>
          </div>
          {error && <p role="alert" className="sm:col-span-3 text-sm text-state-alarm">{t('errors.saveFailed', { error })}</p>}
        </div>
      )}
      {list === null ? (
        <p className="text-sm text-muted">{t('common:status.loading')}</p>
      ) : past.length === 0 ? (
        <p className="text-sm text-muted">{t('history.none')}</p>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {past.map(p => (
            <li key={p.id} className="py-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
              <span className="font-semibold" dir="auto">{p.crop}{p.variety ? ` · ${p.variety}` : ''}</span>
              <span className="text-muted font-mono">{p.transplant_date ? fmt.date(`${p.transplant_date}T12:00:00Z`) : '—'}</span>
              <span className="text-muted">{p.ended_at ? t('history.ended', { date: fmt.date(p.ended_at) }) : ''}</span>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={confirm}
        title={t('history.confirmTitle')}
        body={t('history.confirmBody', { crop: profile.crop })}
        confirmLabel={t('history.create')}
        busy={busy}
        onConfirm={create}
        onCancel={() => setConfirm(false)}
      />
    </Card>
  );
}
