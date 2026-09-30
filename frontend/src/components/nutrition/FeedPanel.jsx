import React, { useCallback, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Label, StatusPill, ProvenanceBadge, ProvenanceMark } from '../../ui';
import ReportTabs, { tabPanelProps } from '../agronomist/ReportTabs';
import { StatusMark } from '../agronomist/SectionStatus';
import { useFormat } from '../../i18n/useFormat';
import { usePoll } from '../../hooks/usePoll';
import { Num, Dash, TableWrap, ElementTargetMark } from './parts';
import { ELEMENTS, PERIODS, ppmDecimals, shapeOf, railOf } from './nutritionUtil';

/**
 * "What the plants are getting" — deterministic calculator (no AI): delivered
 * ppm from the tanks' current recipes × MEASURED concentrate / water litres,
 * against the stage targets and the human protocol recipe.
 * Provenance marks (2026-09-30): measured (SEKO, litres), calculated by
 * SenseHub (ppm, EC estimate, ratios), operator (targets, tank recipes, ratios,
 * source water), protocol / calculated from protocol (the 1:150 recipe ppm).
 */

const REASONS = ['partial_day', 'single_run', 'not_measured', 'no_target', 'no_value'];
const ratio = (a, b) => (a != null && b > 0 ? a / b : null);
const RATIO_KEYS = [['N_K', 'N', 'K'], ['K_Ca', 'K', 'Ca'], ['K_Mg', 'K', 'Mg'], ['Ca_Mg', 'Ca', 'Mg']];

function StatusCell({ cmp }) {
  const { t } = useTranslation('nutrition');
  const fmt = useFormat();
  const shape = shapeOf(cmp.status, cmp.severity);
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap" data-status={cmp.status}>
      <StatusMark status={shape} />
      <span className={cmp.status === 'unknown' ? 'text-muted' : ''}>{t(`cmp.${cmp.status}`)}</span>
      {cmp.pct != null && cmp.status !== 'ok' && <span className="font-mono text-xs text-muted">{fmt.percent(cmp.pct, { decimals: 0, signed: true })}</span>}
      {cmp.status === 'unknown' && REASONS.includes(cmp.reason) && <span className="text-xs text-muted">({t(`cmp.reason.${cmp.reason}`)})</span>}
    </span>
  );
}

function Kpi({ label, children, cmp, hint, testId, prov = null }) {
  const shape = cmp ? shapeOf(cmp.status, cmp.severity) : null;
  return (
    <Card rail={shape ? (shape === 'unknown' ? 'idle' : railOf(shape)) : null} padding="sm" data-testid={testId}>
      <Label>{label}</Label>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">{children}{prov && <ProvenanceMark {...prov} />}</div>
      {cmp && <div className="mt-1 text-xs"><StatusCell cmp={cmp} /></div>}
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </Card>
  );
}

export default function FeedPanel({ api, profile }) {
  const { t } = useTranslation('nutrition');
  const fmt = useFormat();
  const idBase = useId().replace(/:/g, '');
  const [period, setPeriod] = useState('today');
  const [data, setData] = useState({});
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get(`/nutrition/feed?period=${period}${profile ? `&profile_id=${profile.id}` : ''}`);
      setData(d => ({ ...d, [period]: r }));
      setError(null);
    } catch (e) { setError(e.message); }
  }, [api, period, profile]);
  usePoll(load, 120000);

  const rep = data[period];
  const tabs = PERIODS.map(p => ({ id: p, label: t(`feed.period.${p}`) }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ReportTabs variant="segmented" tabs={tabs} active={period} onChange={setPeriod} idBase={idBase} label={t('feed.periodLabel')} />
        <span className="flex flex-wrap items-center gap-1.5">
          <ProvenanceBadge kind="measured" />
          <ProvenanceBadge kind="calculated" from="measured" />
        </span>
      </div>
      <div {...tabPanelProps(idBase, period)} className="space-y-4 focus:outline-none">
        {!rep ? (
          <Card padding="md">{error ? <p role="alert" className="text-sm text-state-alarm">{t('errors.loadFailed', { error })}</p> : <p className="text-sm text-muted">{t('common:status.loading')}</p>}</Card>
        ) : <FeedBody rep={rep} profile={profile} fmt={fmt} t={t} />}
      </div>
    </div>
  );
}

export function FeedBody({ rep, profile, fmt, t }) {
  const cmp = rep.comparisons || {};
  const proto = rep.protocol;
  const protoPpm = proto ? proto.ppm_at_design : null;
  const measured = rep.basis === 'measured';
  const plantsSource = rep.plants && rep.plants.source;
  const designRatio = proto ? proto.design_dilution : 150;
  const designSource = proto && proto.dilution_source ? proto.dilution_source : 'sensehub_assumption';
  const elTargets = (profile && rep.stage && rep.stage.effective && profile.element_targets && profile.element_targets[rep.stage.effective]) || [];
  const deliveredProv = measured ? { kind: 'calculated', from: 'measured', detail: t('prov.delivered') } : { kind: 'calculated', detail: t('prov.deliveredConfigured') };
  const protoProv = { kind: 'calculated', from: 'protocol', detail: t(designSource === 'protocol' ? 'prov.protocolRecipeStated' : 'prov.protocolRecipe', { ratio: designRatio }) };
  // a refill inside the period changed a recipe: each run is counted with the recipe its tanks held (operator request 2026-09-30)
  const olderRecipes = rep.recipe_changed_in_period && Array.isArray(rep.recipe_segments) ? rep.recipe_segments.filter(sg => !sg.current) : [];

  return (
    <>
      {/* basis */}
      <Card padding="sm" data-testid="feed-basis">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <StatusPill state={measured ? 'water' : 'caution'} filled={measured} text={measured ? t('feed.basis.measured') : t('feed.basis.configured')} />
          {measured ? (
            <span>{t('feed.runsWater', { count: rep.runs_count, water: fmt.water(rep.water_l) })}</span>
          ) : (
            <span className="text-muted">{t('feed.basis.configuredHint')}</span>
          )}
          {rep.last_run_at && <span className="text-xs text-muted">{t('feed.lastRun', { time: fmt.dateTime(rep.last_run_at) })}</span>}
          {rep.stage && rep.stage.effective && <span className="text-xs text-muted">· {t('feed.stageTargets', { stage: t(`stage.${rep.stage.effective}`) })}</span>}
        </div>
      </Card>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi testId="feed-kpi-ec" label={t('feed.kpi.ec')} cmp={cmp.ec} prov={{ kind: 'measured', detail: t('prov.feedEc') }}
          hint={t('feed.kpi.ecHint', { calc: fmt.number(rep.ec.calc.ec_ms_cm, { decimals: 2 }) })}>
          <Num value={rep.ec.measured_ms_cm} decimals={2} fmt={fmt} className="text-xl" />
          <span className="text-xs text-muted">mS/cm</span>
        </Kpi>
        <Kpi testId="feed-kpi-ph" label={t('feed.kpi.ph')} cmp={cmp.ph} prov={{ kind: 'measured', detail: t('prov.feedPh') }}>
          <Num value={rep.ph_measured} decimals={2} fmt={fmt} className="text-xl" />
        </Kpi>
        <Kpi testId="feed-kpi-water" label={rep.period === 'last_run' ? t('feed.kpi.waterRun') : t('feed.kpi.waterDay')} cmp={cmp.ml_per_plant_day} prov={{ kind: 'calculated', from: 'measured', detail: t('prov.waterPerPlant') }}
          hint={plantsSource ? t(`feed.plantsSource.${plantsSource}`) : t('feed.plantsUnknown')}>
          <Num value={rep.period === 'last_run' ? rep.ml_per_plant_run : rep.ml_per_plant_day} decimals={0} fmt={fmt} className="text-xl" />
          <span className="text-xs text-muted">{t('feed.mlPerPlant')}</span>
        </Kpi>
        <Kpi testId="feed-kpi-drain" label={t('feed.kpi.drain')} cmp={cmp.drain} hint={t('feed.drainNotMeasured')}>
          <span className="text-xl text-muted">—</span>
        </Kpi>
      </div>

      {/* Elements */}
      <Card padding="md" data-testid="feed-elements">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <h2 className="font-display text-base font-semibold text-ink">{t('feed.elements.title')}</h2>
          <span className="text-xs text-muted">ppm = mg/L</span>
        </div>
        <TableWrap label={t('feed.elements.title')}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-label uppercase text-muted">
                <th className="py-1 pe-3 text-start font-semibold">{t('targets.col.element')}</th>
                <th className="py-1 pe-3 text-end font-semibold">{t('feed.elements.delivered')} <ProvenanceMark {...deliveredProv} data-testid="feed-delivered-provenance" /></th>
                <th className="py-1 pe-3 text-start font-semibold">{t('feed.elements.status')} <ProvenanceMark kind="calculated" detail={t('prov.status')} /></th>
                <th className="py-1 pe-3 text-end font-semibold">{t('feed.elements.protocol', { ratio: designRatio })} <ProvenanceMark {...protoProv} /></th>
                <th className="py-1 text-start font-semibold">{t('feed.elements.target')}</th>
              </tr>
            </thead>
            <tbody>
              {ELEMENTS.map(el => {
                const c = (cmp.elements || []).find(e => e.element === el) || { status: 'unknown' };
                const dec = ppmDecimals(el);
                const f = (v) => (v == null ? '—' : fmt.number(v, { decimals: dec }));
                return (
                  <tr key={el} className="border-t border-line" data-element={el}>
                    <td className="py-1.5 pe-3 font-semibold" lang="en">{el}</td>
                    <td className="py-1.5 pe-3 text-end font-mono">{f(rep.ppm[el] ?? 0)}</td>
                    <td className="py-1.5 pe-3"><StatusCell cmp={c} /></td>
                    <td className="py-1.5 pe-3 text-end font-mono text-muted">{protoPpm ? f(protoPpm[el]) : '—'}</td>
                    <td className="py-1.5 text-xs whitespace-nowrap text-muted">
                      <span className="font-mono" dir="ltr">{c.target == null && c.min == null ? '—' : `${f(c.min)} · ${f(c.target)} · ${f(c.max)}`}</span>
                      {(c.target != null || c.min != null) && <ElementTargetMark row={elTargets.find(r => r.element === el)} ratio={designRatio} ratioSource={designSource} fallback className="ms-1" />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
        <p className="text-xs text-muted mt-2">{t('feed.elements.hint')}</p>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Ratios */}
        <Card padding="md" data-testid="feed-ratios">
          <h2 className="font-display text-base font-semibold text-ink mb-2">{t('feed.ratios.title')}</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-label uppercase text-muted">
                <th className="py-1 pe-3 text-start font-semibold">{t('feed.ratios.ratio')}</th>
                <th className="py-1 pe-3 text-end font-semibold">{t('feed.ratios.delivered')} <ProvenanceMark {...deliveredProv} /></th>
                <th className="py-1 text-end font-semibold">{t('feed.ratios.protocol')} <ProvenanceMark {...protoProv} /></th>
              </tr>
            </thead>
            <tbody>
              {RATIO_KEYS.map(([k, a, b]) => (
                <tr key={k} className="border-t border-line">
                  <td className="py-1.5 pe-3 font-mono" dir="ltr" lang="en">{`${a}:${b}`}</td>
                  <td className="py-1.5 pe-3 text-end font-mono">{rep.ratios[k] != null ? fmt.number(rep.ratios[k], { decimals: 2 }) : '—'}</td>
                  <td className="py-1.5 text-end font-mono text-muted">{protoPpm && ratio(protoPpm[a], protoPpm[b]) != null ? fmt.number(ratio(protoPpm[a], protoPpm[b]), { decimals: 2 }) : '—'}</td>
                </tr>
              ))}
              <tr className="border-t border-line">
                <td className="py-1.5 pe-3">{t('feed.ratios.nh4Share')}</td>
                <td className="py-1.5 pe-3 text-end font-mono">{rep.ratios.nh4_share_pct != null ? fmt.percent(rep.ratios.nh4_share_pct, { decimals: 1 }) : '—'}</td>
                <td className="py-1.5 text-end font-mono text-muted">{protoPpm && protoPpm.N ? fmt.percent((protoPpm.NH4_N || 0) / protoPpm.N * 100, { decimals: 1 }) : '—'}</td>
              </tr>
            </tbody>
          </table>
          {rep.ratios.cation_meq_pct && (
            <p className="text-xs text-muted mt-2" dir="ltr">K : Ca : Mg (meq %) = {fmt.number(rep.ratios.cation_meq_pct.K, { decimals: 0 })} : {fmt.number(rep.ratios.cation_meq_pct.Ca, { decimals: 0 })} : {fmt.number(rep.ratios.cation_meq_pct.Mg, { decimals: 0 })}</p>
          )}
        </Card>

        {/* EC */}
        <Card padding="md" data-testid="feed-ec">
          <h2 className="font-display text-base font-semibold text-ink mb-2">{t('feed.ec.title')}</h2>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
            <dt>{t('feed.ec.calc')} <ProvenanceMark kind="calculated" detail={t('prov.ecCalc')} /></dt><dd className="text-end"><Num value={rep.ec.calc.ec_ms_cm} decimals={2} unit="mS/cm" fmt={fmt} /></dd>
            <dt>{t('feed.ec.sourceWater')} <ProvenanceMark kind="operator" detail={t('prov.sourceWater')} /></dt><dd className="text-end">{rep.ec.source_water_ec_ms_cm != null ? <Num value={rep.ec.source_water_ec_ms_cm} decimals={2} unit="mS/cm" fmt={fmt} /> : <span className="text-muted text-xs">{t('feed.ec.notEntered')}</span>}</dd>
            {rep.ec.calc_plus_source_water_ms_cm != null && (<><dt>{t('feed.ec.calcPlusWater')} <ProvenanceMark kind="calculated" /></dt><dd className="text-end"><Num value={rep.ec.calc_plus_source_water_ms_cm} decimals={2} unit="mS/cm" fmt={fmt} /></dd></>)}
            <dt>{t('feed.ec.measured')} <ProvenanceMark kind="measured" detail={t('prov.feedEc')} /></dt><dd className="text-end"><Num value={rep.ec.measured_ms_cm} decimals={2} unit="mS/cm" fmt={fmt} /></dd>
            <dt className="font-semibold">{t('feed.ec.difference')} <ProvenanceMark kind="calculated" /></dt><dd className="text-end font-semibold">{rep.ec.measured_minus_calc_ms_cm != null ? <span className="font-mono">{fmt.withUnit(rep.ec.measured_minus_calc_ms_cm, 'mS/cm', { decimals: 2, signed: true })}</span> : <Dash />}</dd>
          </dl>
          <p className="text-xs text-muted mt-2">{t('feed.ec.hint')}</p>
          <p className="text-xs text-muted mt-1">{t('feed.ec.method', { cations: fmt.number(rep.ec.calc.cations_meq_l, { decimals: 1 }), anions: fmt.number(rep.ec.calc.anions_meq_l, { decimals: 1 }) })}</p>
          <p className="text-xs text-muted mt-1">{t('feed.acid', { seconds: fmt.int(rep.acid_s || 0), liters: fmt.number(rep.acid_est_l || 0, { decimals: 1 }) })}</p>
        </Card>
      </div>

      {/* Tanks */}
      <Card padding="md" data-testid="feed-tanks">
        <h2 className="font-display text-base font-semibold text-ink mb-2">{t('feed.tanks.title')}</h2>
        <TableWrap label={t('feed.tanks.title')}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-label uppercase text-muted">
                <th className="py-1 pe-3 text-start font-semibold">{t('system.col.tank')}</th>
                <th className="py-1 pe-3 text-end font-semibold">{t('feed.tanks.dosed')} <ProvenanceMark kind="measured" detail={t('prov.dosed')} /></th>
                <th className="py-1 pe-3 text-end font-semibold">{t('feed.tanks.achieved')} <ProvenanceMark kind="calculated" from="measured" detail={t('prov.achievedRatio')} /></th>
                <th className="py-1 text-end font-semibold">{t('feed.tanks.configured')} <ProvenanceMark kind="operator" detail={t('prov.configuredRatio')} /></th>
              </tr>
            </thead>
            <tbody>
              {rep.tanks.map(tk => (
                <tr key={tk.tank_id} className="border-t border-line">
                  <td className="py-1.5 pe-3 whitespace-nowrap" dir="auto">{tk.name}</td>
                  <td className="py-1.5 pe-3 text-end"><Num value={tk.dosed_l} decimals={2} unit="L" fmt={fmt} /></td>
                  <td className="py-1.5 pe-3 text-end font-mono">{tk.achieved_ratio ? `1:${tk.achieved_ratio}` : '—'}</td>
                  <td className="py-1.5 text-end font-mono">{tk.configured_ratio ? `1:${tk.configured_ratio}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>

      {/* Tanks vs protocol recipe */}
      {proto && (
        <Card padding="md" data-testid="feed-vs-protocol">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <h2 className="font-display text-base font-semibold text-ink">{t('feed.vsProtocol.title')}</h2>
            <ProvenanceBadge kind="protocol" detail={t('prov.protocolColumn')} />
          </div>
          <p className="text-xs text-muted mb-2">{t('feed.vsProtocol.subtitle', { recipe: t(`recipe.${proto.recipe}`, { defaultValue: proto.recipe }) })}</p>
          <TableWrap label={t('feed.vsProtocol.title')}>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-label uppercase text-muted">
                  <th className="py-1 pe-3 text-start font-semibold">{t('system.col.tank')}</th>
                  <th className="py-1 pe-3 text-start font-semibold">{t('feed.vsProtocol.ingredient')}</th>
                  <th className="py-1 pe-3 text-end font-semibold">{t('feed.vsProtocol.current')} <ProvenanceMark kind="operator" detail={t('prov.tankCurrent')} /></th>
                  <th className="py-1 pe-3 text-end font-semibold">{t('feed.vsProtocol.protocol')} <ProvenanceMark kind="protocol" detail={t('prov.protocolColumn')} /></th>
                  <th className="py-1 text-end font-semibold">{t('feed.vsProtocol.diff')} <ProvenanceMark kind="calculated" detail={t('prov.diff')} /></th>
                </tr>
              </thead>
              <tbody>
                {proto.tanks_vs_protocol.flatMap(tk => tk.lines.map((l, i) => (
                  <tr key={`${tk.letter}-${i}`} className="border-t border-line">
                    <td className="py-1.5 pe-3 font-semibold">{i === 0 ? tk.letter : ''}</td>
                    <td className="py-1.5 pe-3 min-w-[10rem]" dir="auto" lang="en">{l.ingredient}</td>
                    <td className="py-1.5 pe-3 text-end font-mono">{fmt.number(l.current_kg, { decimals: l.current_kg % 1 ? 1 : 0 })}</td>
                    <td className="py-1.5 pe-3 text-end font-mono">{fmt.number(l.protocol_kg, { decimals: l.protocol_kg % 1 ? 1 : 0 })}</td>
                    <td className={`py-1.5 text-end font-mono ${l.diff_kg ? 'font-semibold' : 'text-muted'}`}>{l.diff_kg ? fmt.number(l.diff_kg, { decimals: l.diff_kg % 1 ? 1 : 0, signed: true }) : '0'}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          </TableWrap>
          <p className="text-xs text-muted mt-2">{t('feed.vsProtocol.hint', {
            protoEc: fmt.number(proto.ec_at_design, { decimals: 2 }), ratio: proto.design_dilution,
            protoEcCfg: fmt.number(proto.ec_at_configured_ratio, { decimals: 2 }),
          })}</p>
        </Card>
      )}

      {olderRecipes.length > 0 && (
        <p className="text-xs text-muted" data-testid="feed-recipe-changed">
          {t('feed.recipeChanged', { tanks: [...new Set(olderRecipes.map(sg => sg.letter))].join(', ') })}
        </p>
      )}

      {rep.assumptions && rep.assumptions.length > 0 && (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer select-none">{t('feed.assumptions')}</summary>
          <ul className="mt-1 list-disc ps-5 space-y-0.5" lang="en" dir="ltr">
            {rep.assumptions.map((a, i) => <li key={i}>{a}</li>)}
          </ul>
        </details>
      )}
    </>
  );
}
