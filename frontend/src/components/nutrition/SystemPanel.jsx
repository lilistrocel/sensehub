import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Label, StatusPill } from '../../ui';
import { useFormat } from '../../i18n/useFormat';
import { usePoll } from '../../hooks/usePoll';
import { SourceBadge, Num, Dash, TableWrap } from './parts';
import { TankStockCompact } from '../irrigation/TankStock';

/**
 * The fertigation system as SenseHub already knows it — derived live from its
 * own configuration and records, READ-ONLY (operator 2026-09-28). Nothing here
 * can be edited; change the tanks / programs / automations on their own pages.
 */
const EPISODE_KINDS = ['valve_no_flow', 'run_shutdown', 'dosing_without_water', 'flow_above_expected', 'flow_after_pump_off', 'water_without_valve', 'retry_recovered', 'low_flow'];

export default function SystemPanel({ api, profile }) {
  const { t } = useTranslation('nutrition');
  const fmt = useFormat();
  const [sys, setSys] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setSys(await api.get(`/nutrition/system${profile ? `?profile_id=${profile.id}` : ''}`));
      setError(null);
    } catch (e) { setError(e.message); }
  }, [api, profile]);
  usePoll(load, 120000);

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-display text-base font-semibold text-ink">{t('system.title')}</h2>
          <SourceBadge kind="live" />
        </div>
        <p className="text-xs text-muted mt-0.5">{t('system.subtitle')}</p>
      </div>
      {sys && <span className="text-xs text-muted font-mono">{fmt.clock(sys.computed_at)}</span>}
    </div>
  );

  if (!sys) {
    return (
      <Card padding="md" data-testid="nutrition-system">
        {header}
        {error ? <p role="alert" className="text-sm text-state-alarm">{t('errors.loadFailed', { error })}</p> : <p className="text-sm text-muted">{t('common:status.loading')}</p>}
      </Card>
    );
  }

  const nutrientTanks = sys.tanks.filter(tk => tk.role === 'nutrient');
  const ph = sys.ph_line || {};
  const sched = sys.schedule || {};
  const prot = sys.protection || {};
  const trend = (sys.feed_trend || []).slice(-10).reverse();

  return (
    <Card padding="md" data-testid="nutrition-system">
      {header}

      <p className="text-sm mb-3">
        {t('system.injection', { count: nutrientTanks.length })}
        {' · '}
        {profile && profile.buffer_tank_l
          ? t('system.buffer', { volume: fmt.withUnit(profile.buffer_tank_l, 'L', { decimals: 0 }) })
          : <span className="text-muted">{t('system.bufferUnknown')}</span>}
      </p>

      {/* Tanks */}
      <Label>{t('system.tanks')}</Label>
      <TableWrap label={t('system.tanks')}>
        <table className="w-full text-sm mt-1 mb-4">
          <thead>
            <tr className="text-label uppercase text-muted">
              <th className="py-1 pe-3 text-start font-semibold">{t('system.col.tank')}</th>
              <th className="py-1 pe-3 text-start font-semibold">{t('system.col.contents')}</th>
              <th className="py-1 pe-3 text-start font-semibold">{t('system.col.relay')}</th>
              <th className="py-1 pe-3 text-end font-semibold">{t('system.col.ratio')}</th>
              <th className="py-1 pe-3 text-end font-semibold">{t('system.col.draw')}</th>
              <th className="py-1 pe-3 text-start font-semibold">{t('system.col.stock')}</th>
              <th className="py-1 text-start font-semibold">{t('system.col.refill')}</th>
            </tr>
          </thead>
          <tbody>
            {sys.tanks.map(tk => (
              <tr key={tk.tank_id} className="border-t border-line align-top" data-tank={tk.letter}>
                <td className="py-1.5 pe-3 whitespace-nowrap font-semibold" dir="auto">{tk.letter}</td>
                <td className="py-1.5 pe-3 min-w-[12rem]">
                  <span dir="auto" lang="en" className="block">{(tk.items || []).map(i => `${i.name} ${fmt.number(i.amount, { decimals: i.amount % 1 ? 1 : 0 })} ${i.unit}`).join(' + ') || <Dash />}</span>
                  <span className="text-xs text-muted">{t('system.perLiters', { liters: fmt.int(tk.per_liters) })}{tk.role === 'ph_down' ? ` · ${t('system.acidLine')}` : ''}</span>
                </td>
                <td className="py-1.5 pe-3 whitespace-nowrap text-xs">
                  {tk.relay ? <><span dir="auto">{tk.relay.equipment_name}</span> <span className="font-mono">#{tk.relay.channel}</span></> : <Dash />}
                </td>
                <td className="py-1.5 pe-3 text-end font-mono whitespace-nowrap">{tk.target_ratio ? `1:${tk.target_ratio}` : <Dash />}</td>
                <td className="py-1.5 pe-3 text-end whitespace-nowrap">
                  <Num value={tk.measured_draw_lpm} decimals={2} fmt={fmt} />
                  <span className="text-xs text-muted"> / <Num value={tk.configured_draw_lpm} decimals={2} fmt={fmt} /> L/min</span>
                </td>
                <td className="py-1.5 pe-3 whitespace-nowrap" data-testid="nutrition-tank-stock">
                  {tk.stock ? <TankStockCompact stock={tk.stock} tankLabel={tk.letter} /> : <Dash />}
                </td>
                <td className="py-1.5 whitespace-nowrap font-mono text-xs">{tk.last_refill_at ? fmt.date(tk.last_refill_at) : <Dash />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      <p className="text-xs text-muted -mt-3 mb-4">{t('system.drawHint')}</p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        {/* pH line */}
        <div>
          <Label>{t('system.phLine')}</Label>
          <ul className="text-sm mt-1 space-y-0.5">
            <li>{t('system.phSetpoint', { setpoint: fmt.number(ph.setpoint, { decimals: 2 }), deadband: fmt.number(ph.deadband, { decimals: 2 }), floor: fmt.number(ph.floor_ph, { decimals: 1 }) })}</li>
            <li>{t('system.acidCaps', { cycle: ph.max_acid_s_per_cycle ?? '—', day: ph.max_acid_s_per_day ?? '—' })}</li>
            <li className="text-muted">{t('system.acidNotMetered', { lpm: fmt.number(ph.acid_lpm_estimate, { decimals: 1 }) })}</li>
          </ul>
        </div>
        {/* dosing control */}
        <div>
          <Label>{t('system.dosing')}</Label>
          <ul className="text-sm mt-1 space-y-0.5">
            <li className="flex flex-wrap items-center gap-2">
              <StatusPill state={sys.dosing.controller_enabled ? 'ok' : 'idle'} filled={sys.dosing.controller_enabled} text={sys.dosing.controller_enabled ? t('system.controllerOn') : t('system.controllerOff')} />
              <span className="text-muted text-xs">{t(`system.mode.${sys.dosing.mode}`, { defaultValue: sys.dosing.mode || '' })}</span>
            </li>
            <li dir="ltr" className="font-mono text-xs">{sys.dosing.ratio_by_tank.map(r => `${r.letter} 1:${r.ratio ?? '—'}`).join(' · ')}</li>
            <li>{sys.dosing.ec_trim_enabled ? t('system.ecTrimOn') : t('system.ecTrimOff')}</li>
            {sys.dosing.programs.map(p => (
              <li key={p.id} className="text-xs"><span dir="auto" lang="en">{p.name}</span> · {t(`system.controlMode.${p.control_mode}`, { defaultValue: p.control_mode })}</li>
            ))}
          </ul>
        </div>
      </div>

      {/* Sections + schedule */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <Label>{t('system.sections')}</Label>
          <TableWrap label={t('system.sections')}>
            <table className="w-full text-sm mt-1">
              <thead>
                <tr className="text-label uppercase text-muted">
                  <th className="py-1 pe-3 text-start font-semibold">{t('system.col.section')}</th>
                  <th className="py-1 pe-3 text-end font-semibold">{t('system.col.flow')}</th>
                  <th className="py-1 text-end font-semibold">{t('system.col.minPerDay')}</th>
                </tr>
              </thead>
              <tbody>
                {sys.sections.map(s => (
                  <tr key={s.channel} className="border-t border-line">
                    <td className="py-1.5 pe-3 whitespace-nowrap" dir="auto">{s.name}</td>
                    <td className="py-1.5 pe-3 text-end whitespace-nowrap"><Num value={s.measured_flow_lph} decimals={0} unit="L/h" fmt={fmt} /></td>
                    <td className="py-1.5 text-end font-mono">{s.scheduled_minutes_per_day != null ? fmt.number(s.scheduled_minutes_per_day, { decimals: 1 }) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </div>
        <div>
          <Label>{t('system.schedule')}</Label>
          <TableWrap dir="ltr" label={t('system.schedule')}>
            <table className="w-full text-sm mt-1">
              <thead>
                <tr className="text-label uppercase text-muted">
                  <th className="py-1 pe-3 text-start font-semibold">{t('system.col.time')}</th>
                  <th className="py-1 pe-3 text-end font-semibold">{t('system.col.minPerSection')}</th>
                  <th className="py-1 text-end font-semibold">{t('system.col.softSwitch')}</th>
                </tr>
              </thead>
              <tbody>
                {sched.runs.map(r => (
                  <tr key={r.automation_id} className="border-t border-line">
                    <td className="py-1.5 pe-3 font-mono">{r.time || '—'}</td>
                    <td className="py-1.5 pe-3 text-end font-mono">{fmt.number(r.minutes_per_section, { decimals: 1 })}</td>
                    <td className="py-1.5 text-end font-mono text-xs text-muted">{r.zones[0] && r.zones[0].lead_s != null ? `+${r.zones[0].lead_s} s / −${r.zones[0].lag_s} s` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <p className="text-sm mt-2" data-testid="nutrition-schedule-total">
            {t('system.scheduleTotal', { runs: sched.runs_per_day, minutes: fmt.number(sched.minutes_per_section_per_day, { decimals: 1 }) })}
            {sched.ml_per_plant_day_from_dripper != null && (
              <> · {t('system.mlFromDripper', { ml: fmt.int(sched.ml_per_plant_day_from_dripper) })} <span className="text-xs text-muted">{t('system.mlFromDripperHint')}</span></>
            )}
          </p>
          <p className="text-xs text-muted mt-1">{t('system.softSwitchHint')}</p>
        </div>
      </div>

      {/* Protection + feed trend */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
        <div>
          <Label>{t('system.protection')}</Label>
          <p className="text-sm mt-1 flex flex-wrap items-center gap-2">
            <StatusPill state={prot.flow_watch_enabled ? 'ok' : 'caution'} filled text={prot.flow_watch_enabled ? t('system.flowWatchOn') : t('system.flowWatchOff')} />
            <span>{t('system.episodes', { count: prot.episodes_7d || 0 })}</span>
          </p>
          {prot.episodes_by_kind && Object.keys(prot.episodes_by_kind).length > 0 && (
            <ul className="text-xs text-muted mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
              {Object.entries(prot.episodes_by_kind).map(([k, n]) => (
                <li key={k}>{t(`system.episodeKind.${EPISODE_KINDS.includes(k) ? k : 'other'}`)} <span className="font-mono">×{n}</span></li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <Label>{t('system.feedTrend')}</Label>
          {trend.length === 0 ? <p className="text-sm text-muted mt-1">{t('system.noRuns')}</p> : (
            <TableWrap dir="ltr" label={t('system.feedTrend')}>
              <table className="w-full text-xs mt-1 font-mono">
                <thead>
                  <tr className="text-label uppercase text-muted font-sans">
                    <th className="py-1 pe-2 text-start font-semibold">{t('system.col.time')}</th>
                    <th className="py-1 pe-2 text-end font-semibold">L</th>
                    <th className="py-1 pe-2 text-end font-semibold">EC</th>
                    <th className="py-1 pe-2 text-end font-semibold">pH</th>
                    <th className="py-1 text-end font-semibold">{t('system.col.ratioShort')}</th>
                  </tr>
                </thead>
                <tbody>
                  {trend.map((r, i) => (
                    <tr key={i} className="border-t border-line">
                      <td className="py-1 pe-2 whitespace-nowrap">{fmt.dayMonth(r.started_at)} {fmt.clock(r.started_at)}</td>
                      <td className="py-1 pe-2 text-end">{fmt.int(r.water_l)}</td>
                      <td className="py-1 pe-2 text-end">{r.ec_ms != null ? fmt.number(r.ec_ms, { decimals: 2 }) : '—'}</td>
                      <td className="py-1 pe-2 text-end">{r.ph != null ? fmt.number(r.ph, { decimals: 2 }) : '—'}</td>
                      <td className="py-1 text-end">{r.achieved_ratio ? `1:${r.achieved_ratio}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </div>
      </div>
    </Card>
  );
}
