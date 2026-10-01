import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Label, Button, StatusPill, ProvenanceBadge, ProvenanceMark } from '../../ui';
import ConfirmDialog from '../ConfirmDialog';
import { StatusMark } from '../agronomist/SectionStatus';
import { useFormat } from '../../i18n/useFormat';
import { usePoll } from '../../hooks/usePoll';
import { TableWrap, NumInput, TextInput } from './parts';
import { ppmDecimals } from './nutritionUtil';
import {
  FIELD_KEY, BLOCK_REASONS, DIFF_REASONS, TRIGGERS, PROPOSAL_STATUSES,
  originProvenance, ratioOrigin, fieldText, matchState, proposalShape, deviationPct, bestFitShape,
} from './controllerLinkUtil';

/**
 * "Follow crop targets" — the link between the crop stage targets and the
 * fertigation dose controller (operator decision 2026-09-30). Shown on Crop &
 * Nutrition (under Targets per stage) and on Fertigation (under the dose
 * controller card).
 *
 *  - link mode: Manual (nothing changes) / Follow crop targets (confirm dialog)
 *  - Controller block: current controller values (with where each comes from)
 *    next to the values the crop targets imply, match / mismatch per row
 *  - pending proposal: diff current -> proposed with the reason, Approve / Reject
 *    (admin / operator; applies at the START of the next dose cycle, never mid-cycle)
 *  - source-water discrepancy, EC fine-tuning (separate, verified control),
 *    proposal history, element best fit (ADVISORY ONLY, never applied)
 * Strings: nutrition:link.*. Every number is marked with the shared provenance kinds.
 */

const API_BASE = '/api';
const LINKED = 'follow_crop_targets';

function useApi(apiProp, headersIn) {
  // key on the auth header, not the object: callers rebuild `headers` on every render
  const auth = headersIn ? headersIn.Authorization || headersIn.authorization || '' : '';
  return useMemo(() => {
    if (apiProp) return apiProp;
    const headers = auth ? { Authorization: auth } : {};
    const parse = async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { const e = new Error(data.error || data.message || `HTTP ${res.status}`); e.code = data.code; e.body = data; throw e; }
      return data;
    };
    return {
      get: (p) => fetch(`${API_BASE}${p}`, { headers }).then(parse),
      send: (method, p, body) => fetch(`${API_BASE}${p}`, { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(parse),
    };
  }, [apiProp, auth]);
}

/** Origin mark of a controller value. */
function OriginMark({ origin, t, fmt }) {
  const p = originProvenance(origin && origin.origin);
  if (!p) return null;
  const detail = t(`link.prov.${origin.mixed ? 'mixed' : p.detailKey}`, {
    id: origin.proposal_id ?? '—',
    who: origin.user_email || '—',
    at: origin.at ? fmt.dateTime(origin.at) : '—',
  });
  return <ProvenanceMark kind={p.kind} from={p.from} detail={detail} data-testid="link-origin" data-origin={origin.origin} />;
}

function Mono({ children, className = '' }) {
  return <span className={`font-mono tabular whitespace-nowrap ${className}`} dir="ltr">{children}</span>;
}

/** Reason text of a diff row (numbers formatted with Western digits). */
function reasonText(reason, t, fmt) {
  if (!reason || !DIFF_REASONS.includes(reason.code)) return '';
  const p = reason.params || {};
  const n = (v, d = 2) => (v === null || v === undefined ? '—' : fmt.number(Number(v), { decimals: d }));
  return t(`link.reason.${reason.code}`, {
    min: n(p.min), max: n(p.max), target: n(p.target), offset: n(p.offset, 1), floorMin: n(p.floor_min, 1),
    ec: n(p.ec), water: n(p.water), fert: n(p.fert), protocolEc: n(p.protocol_ec), design: p.design ?? '—',
    factor: n(p.factor, 3), ratio: p.ratio ?? '—',
  });
}

function blockedText(b, t, fmt) {
  const reason = BLOCK_REASONS.includes(b.reason) ? b.reason : 'no_stage_targets';
  return t(`link.blocked.${reason}`, {
    part: t(`link.part.${b.part === 'ph' ? 'ph' : 'ec'}`),
    ratio: b.ratio ?? '—',
    min: b.bounds ? b.bounds.min : 100,
    max: b.bounds ? b.bounds.max : 250,
  });
}

function DiffTable({ diff, letters, t, fmt }) {
  return (
    <TableWrap label={t('link.proposal.diffTable')}>
      <table className="w-full text-sm" data-testid="link-diff">
        <thead>
          <tr className="text-label uppercase text-muted">
            <th className="py-1 pe-3 text-start font-semibold">{t('link.col.setting')}</th>
            <th className="py-1 pe-3 text-start font-semibold">{t('link.col.current')}</th>
            <th className="py-1 pe-3 text-start font-semibold">{t('link.col.proposed')}</th>
            <th className="py-1 text-start font-semibold">{t('link.col.reason')}</th>
          </tr>
        </thead>
        <tbody>
          {diff.map(d => (
            <tr key={d.field} className="border-t border-line align-top" data-field={d.field}>
              <td className="py-1.5 pe-3 whitespace-nowrap">{t(`link.field.${FIELD_KEY[d.field] || 'other'}`)}</td>
              <td className="py-1.5 pe-3"><Mono className="text-muted">{fieldText(d.field, d.current, fmt, letters)}</Mono></td>
              <td className="py-1.5 pe-3">
                <span className="inline-flex items-center gap-1.5">
                  <Mono className="font-semibold text-ink">{fieldText(d.field, d.proposed, fmt, letters)}</Mono>
                  <ProvenanceMark kind="calculated" from="operator" detail={t('link.prov.fromTargets')} />
                </span>
              </td>
              <td className="py-1.5 text-xs text-muted min-w-[14rem]">{reasonText(d.reason, t, fmt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

function ProposalCard({ p, letters, canEdit, onApprove, onReject, busy, t, fmt }) {
  const approved = p.status === 'approved';
  return (
    <div className="mt-3 rounded-card border border-line p-3" data-testid={approved ? 'link-approved' : 'link-pending'} data-proposal={p.id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <StatusMark status={proposalShape(p.status)} />
          <span className="font-semibold text-ink">{t(approved ? 'link.proposal.approvedTitle' : 'link.proposal.pendingTitle', { id: p.id })}</span>
          <span className="text-xs text-muted">
            {t(`link.trigger.${TRIGGERS.includes(p.trigger) ? p.trigger : 'targets_changed'}`)} · {fmt.dateTime(p.created_at)}
          </span>
        </div>
        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => onReject(p)} disabled={busy} data-testid="link-reject">{t('link.proposal.reject')}</Button>
            {!approved && <Button variant="primary" size="sm" onClick={() => onApprove(p)} disabled={busy} data-testid="link-approve">{t('link.proposal.approve')}</Button>}
          </div>
        )}
      </div>
      <p className="mt-1 text-xs text-muted">
        {approved
          ? t('link.proposal.approvedBy', { who: p.decided_by_email || '—', at: p.decided_at ? fmt.dateTime(p.decided_at) : '—' })
          : t('link.proposal.nextCycle')}
      </p>
      {p.diff && p.diff.length > 0 && <div className="mt-2"><DiffTable diff={p.diff} letters={letters} t={t} fmt={fmt} /></div>}
      {(p.blocked || []).map(b => (
        <p key={b.part} className="mt-2 flex items-start gap-2 text-xs" data-testid="link-blocked" data-part={b.part} data-reason={b.reason}>
          <span className="mt-0.5"><StatusMark status="caution" /></span><span className="min-w-0">{blockedText(b, t, fmt)}</span>
        </p>
      ))}
      {!canEdit && !approved && <p className="mt-2 text-xs text-muted">{t('link.proposal.viewerNote')}</p>}
    </div>
  );
}

/**
 * Equal draw (operator requirement 2026-10-01): its setting, what it achieved in recent runs
 * (measured: water / litres of the slowest, venturi-limited tank) and a caution when the
 * controller's or the proposed ratio is richer than that — the venturis cannot deliver it.
 */
function EqualDrawNote({ eq, t }) {
  const warn = eq.warning_proposed || eq.warning_current;
  const which = eq.warning_proposed ? 'warnProposed' : 'warnCurrent';
  return (
    <div className="mt-3" data-testid="link-equal-draw" data-enabled={eq.enabled ? 'true' : 'false'}>
      {eq.enabled && warn && (
        <div className="rounded-card border border-line border-s-[3px] border-s-state-caution p-2.5 text-sm" role="note" data-testid="link-equal-draw-warning">
          <p className="flex items-start gap-2">
            <span className="mt-0.5"><StatusMark status="caution" /></span>
            <span className="min-w-0">{t(`link.equalDraw.${which}`, { ratio: warn.ratio, achieved: warn.achievable_ratio })}</span>
          </p>
        </div>
      )}
      <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <span className="font-semibold text-ink">{t('link.equalDraw.title')}</span>
        <span>{eq.enabled ? t('link.equalDraw.on', { tol: eq.tolerance_l, pct: eq.tolerance_pct, policy: t(`link.equalDraw.policy.${eq.on_tank_failure === 'exclude_failed' ? 'exclude_failed' : 'hold_all'}`) }) : t('link.equalDraw.off')}</span>
        {eq.achievable_ratio
          ? <span className="inline-flex items-center gap-1" data-testid="link-equal-draw-achieved">{t('link.equalDraw.achieved', { ratio: eq.achievable_ratio, count: eq.n_limited })}<ProvenanceMark kind="measured" detail={t('link.equalDraw.basis')} /></span>
          : <span>{t('link.equalDraw.unknown')}</span>}
      </p>
    </div>
  );
}

/** The whole link view (pure: data in, callbacks out) — also used by the tests. */
export function ControllerLinkView({ view, canEdit = false, busy = false, onToggleMode, onApprove, onReject, onTrim }) {
  const { t } = useTranslation('nutrition');
  const fmt = useFormat();
  if (!view) return null;
  const linked = view.mode === LINKED;
  const c = view.controller || {};
  const prov = c.provenance || {};
  const tankIds = (view.tanks || []).map(x => x.tank_id);
  const letters = Object.fromEntries((view.tanks || []).map(x => [x.tank_id, x.letter || String(x.tank_id)]));
  const cmp = Object.fromEntries((view.comparison || []).map(r => [r.field, r]));
  const crop = view.crop || {};
  const st = crop.stage_target || null;
  const sw = view.source_water || {};
  const n2 = (v) => (v === null || v === undefined ? '—' : fmt.number(Number(v), { decimals: 2 }));

  const rows = [
    ['ph.setpoint', c.ph ? c.ph.setpoint : null, prov['ph.setpoint']],
    ['ph.floor_ph', c.ph ? c.ph.floor_ph : null, prov['ph.floor_ph']],
    ['nutrients.ratio', c.ratio, ratioOrigin(prov, tankIds)],
    ['nutrients.ec_trim.target_us', c.ec_trim ? c.ec_trim.target_us : null, prov['nutrients.ec_trim.target_us']],
    ['nutrients.ec_trim.water_us', c.ec_trim ? c.ec_trim.water_us : null, prov['nutrients.ec_trim.water_us']],
  ];
  const blockedOf = (field) => {
    const part = field.startsWith('ph.') ? 'ph' : 'ec';
    return (view.now && view.now.blocked || []).find(b => b.part === part) || null;
  };

  return (
    <div data-testid="controller-link" data-mode={view.mode}>
      {/* mode */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill state={linked ? 'ok' : 'idle'} filled={linked} text={t(linked ? 'link.mode.follow' : 'link.mode.manual')} data-testid="link-mode" />
          <span className="text-xs text-muted">{t(linked ? 'link.mode.followHint' : 'link.mode.manualHint')}</span>
        </div>
        {canEdit && (
          <Button variant="secondary" size="sm" onClick={onToggleMode} disabled={busy} data-testid="link-toggle">
            {t(linked ? 'link.mode.switchManual' : 'link.mode.switchFollow')}
          </Button>
        )}
      </div>

      {/* source water: one source of truth */}
      {sw.discrepancy && sw.discrepancy !== 'ok' && (
        <div className="mt-3 rounded-card border border-line border-s-[3px] border-s-state-caution p-2.5 text-sm" role="note" data-testid="link-water-warning" data-state={sw.discrepancy}>
          <p className="flex items-start gap-2">
            <span className="mt-0.5"><StatusMark status="caution" /></span>
            <span className="min-w-0">
              {sw.discrepancy === 'profile_missing'
                ? t(sw.trim_water_origin === 'default' ? 'link.water.missingDefault' : 'link.water.missing', { water: n2(sw.trim_water_us != null ? sw.trim_water_us / 1000 : null) })
                : t('link.water.mismatch', { profile: n2(sw.profile_ec), trim: n2(sw.trim_water_us != null ? sw.trim_water_us / 1000 : null), raw: sw.raw_water_ec_us != null ? n2(sw.raw_water_ec_us / 1000) : '—' })}
              {sw.discrepancy === 'mismatch' && sw.trim_water_origin === 'default' && <> {t('link.water.defaultNote', { water: n2(sw.trim_water_us != null ? sw.trim_water_us / 1000 : null) })}</>}
            </span>
          </p>
        </div>
      )}

      {/* equal draw vs the ratio (operator requirement 2026-10-01) */}
      {view.equal_draw && <EqualDrawNote eq={view.equal_draw} t={t} />}

      {/* controller vs crop targets */}
      <div className="mt-3">
        <div className="flex flex-wrap items-center gap-2">
          <Label>{t('link.controller.title')}</Label>
          {c.running_cycle && <span className="text-xs text-muted" data-testid="link-running">{t('link.controller.running')}</span>}
        </div>
        <TableWrap label={t('link.controller.table')}>
          <table className="mt-1 w-full text-sm" data-testid="link-controller">
            <thead>
              <tr className="text-label uppercase text-muted">
                <th className="py-1 pe-3 text-start font-semibold">{t('link.col.setting')}</th>
                <th className="py-1 pe-3 text-start font-semibold">{t('link.col.controller')}</th>
                <th className="py-1 pe-3 text-start font-semibold">{t('link.col.fromTargets')}</th>
                <th className="py-1 text-start font-semibold">{t('link.col.match')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([field, value, origin]) => {
                const r = cmp[field];
                const state = matchState(r);
                const blk = r && !r.available ? blockedOf(field) : null;
                return (
                  <tr key={field} className="border-t border-line align-top" data-field={field} data-match={state}>
                    <td className="py-1.5 pe-3 whitespace-nowrap">{t(`link.field.${FIELD_KEY[field]}`)}</td>
                    <td className="py-1.5 pe-3">
                      <span className="inline-flex items-center gap-1.5">
                        <Mono className="text-ink">{fieldText(field, value, fmt, letters)}</Mono>
                        <OriginMark origin={origin} t={t} fmt={fmt} />
                      </span>
                    </td>
                    <td className="py-1.5 pe-3">
                      {r && r.available ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Mono>{fieldText(field, r.wanted, fmt, letters)}</Mono>
                          <ProvenanceMark kind="calculated" from="operator" detail={t('link.prov.fromTargets')} />
                        </span>
                      ) : <span className="text-xs text-muted">{blk ? t(`link.blockedShort.${BLOCK_REASONS.includes(blk.reason) ? blk.reason : 'no_stage_targets'}`) : '—'}</span>}
                    </td>
                    <td className="py-1.5">
                      <span className="inline-flex items-center gap-1 text-xs">
                        <StatusMark status={state} />
                        {t(`link.match.${state}`)}
                      </span>
                    </td>
                  </tr>
                );
              })}
              <tr className="border-t border-line" data-field="nutrients.ec_trim.enabled">
                <td className="py-1.5 pe-3 whitespace-nowrap">{t('link.field.trimEnabled')}</td>
                <td className="py-1.5 pe-3" colSpan={3}>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="font-semibold">{t(view.ec_trim && view.ec_trim.enabled ? 'link.trim.on' : 'link.trim.off')}</span>
                    <OriginMark origin={prov['nutrients.ec_trim.enabled']} t={t} fmt={fmt} />
                    <span className="text-xs text-muted">{t('link.trim.notProposed')}</span>
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </TableWrap>
        {/* the crop targets these come from */}
        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted" data-testid="link-crop-basis">
          <span>{t('link.crop.stage', { stage: t(`stage.${crop.stage || 'none'}`) })}</span>
          {st && <span className="inline-flex items-center gap-1">{t('link.crop.ec', { ec: n2(st.ec_target) })} · {t('link.crop.ph', { min: n2(st.ph_min), max: n2(st.ph_max) })}<ProvenanceMark kind={st.source === 'protocol' ? 'protocol' : 'operator'} detail={t('link.prov.stageTargets')} /></span>}
          {crop.protocol_ph && <span className="inline-flex items-center gap-1">{t('link.crop.protocolPh', { min: n2(crop.protocol_ph.min), max: n2(crop.protocol_ph.max) })}<ProvenanceMark kind="protocol" /></span>}
          <span className="inline-flex items-center gap-1">{t('link.crop.water', { water: crop.source_water_ec != null ? n2(crop.source_water_ec) : '—' })}{crop.source_water_ec != null && <ProvenanceMark kind="operator" detail={t('prov.sourceWater')} />}</span>
          {crop.stock_ec_at_ratio && <span className="inline-flex items-center gap-1">{t('link.crop.stockEc', { ratio: crop.stock_ec_at_ratio.ratio, ec: n2(crop.stock_ec_at_ratio.fertilizer_ec_ms_cm) })}<ProvenanceMark kind="calculated" detail={t('link.prov.stockEc')} /></span>}
        </p>
      </div>

      {/* proposals */}
      {view.approved && <ProposalCard p={view.approved} letters={letters} canEdit={canEdit} onApprove={onApprove} onReject={onReject} busy={busy} t={t} fmt={fmt} />}
      {view.pending && <ProposalCard p={view.pending} letters={letters} canEdit={canEdit} onApprove={onApprove} onReject={onReject} busy={busy} t={t} fmt={fmt} />}
      {linked && !view.pending && !view.approved && (
        <p className="mt-3 text-sm text-muted" data-testid="link-no-proposal">
          {(view.comparison || []).every(r => r.match !== false) ? t('link.proposal.none') : t('link.proposal.noneDecided')}
        </p>
      )}
      {!linked && (view.now && view.now.diff && view.now.diff.length > 0) && (
        <p className="mt-3 text-xs text-muted" data-testid="link-manual-preview">{t('link.proposal.manualPreview', { n: view.now.diff.length })}</p>
      )}

      {/* EC fine-tuning */}
      <div className="mt-4 pt-3 border-t border-line" data-testid="link-trim" data-enabled={view.ec_trim && view.ec_trim.enabled ? 'true' : 'false'}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <Label>{t('link.trim.title')}</Label>
            <p className="text-xs text-muted mt-0.5">{t('link.trim.explain', { max: view.ec_trim ? view.ec_trim.max_deviation_pct : 10 })}</p>
          </div>
          {canEdit && (view.ec_trim && view.ec_trim.enabled
            ? <Button variant="danger-ghost" size="sm" onClick={() => onTrim(false)} disabled={busy} data-testid="link-trim-off">{t('link.trim.disable')}</Button>
            : <Button variant="secondary" size="sm" onClick={() => onTrim(true)} disabled={busy || !linked} data-testid="link-trim-on">{t('link.trim.enable')}</Button>)}
        </div>
        {(view.ec_trim && view.ec_trim.checks || []).length > 0 && (
          <ul className="mt-1 text-xs text-muted space-y-0.5">
            {view.ec_trim.checks.slice(0, 3).map(ch => (
              <li key={ch.id} data-action={ch.action}>
                {t(`link.trim.check.${['enable', 'disable', 'refused'].includes(ch.action) ? ch.action : 'enable'}`, {
                  who: ch.user_email || '—', at: fmt.dateTime(ch.created_at),
                  handheld: n2(ch.handheld_ec_ms), seko: n2(ch.seko_ec_ms), dev: ch.deviation_pct != null ? fmt.number(ch.deviation_pct, { decimals: 1 }) : '—',
                })}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* history */}
      {view.history && view.history.items && view.history.items.length > 0 && (
        <details className="mt-4 pt-3 border-t border-line" data-testid="link-history">
          <summary className="cursor-pointer select-none text-sm font-semibold text-ink">{t('link.history.title', { n: view.history.total })}</summary>
          <ul className="mt-2 space-y-1.5 text-xs">
            {view.history.items.map(h => (
              <li key={h.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5" data-status={h.status}>
                <StatusMark status={proposalShape(h.status)} />
                <span className="font-semibold">#{h.id}</span>
                <span>{t(`link.status.${PROPOSAL_STATUSES.includes(h.status) ? h.status : 'pending'}`)}</span>
                <span className="text-muted">{fmt.dateTime(h.created_at)}</span>
                {h.decided_by_email && <span className="text-muted">{t('link.history.by', { who: h.decided_by_email })}</span>}
                {h.applied_at && <span className="text-muted">{t('link.history.applied', { at: fmt.dateTime(h.applied_at), run: h.applied_run_id ?? '—' })}</span>}
                {h.failure && h.status === 'failed' && <span className="text-caution-700 dark:text-caution-300" dir="ltr">{h.failure}</span>}
                <span className="text-muted">{(h.diff || []).map(d => `${t(`link.field.${FIELD_KEY[d.field] || 'other'}`)} ${fieldText(d.field, d.current, fmt, letters)} → ${fieldText(d.field, d.proposed, fmt, letters)}`).join(' · ')}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <BestFit fit={view.best_fit} letters={letters} ratios={c.ratio} t={t} fmt={fmt} />
    </div>
  );
}

/** Element best fit with the current stock (ADVISORY ONLY — never applied). */
function BestFit({ fit, letters, ratios, t, fmt }) {
  if (!fit) return null;
  return (
    <div className="mt-4 pt-3 border-t border-line" data-testid="link-bestfit">
      <div className="flex flex-wrap items-center gap-2">
        <Label>{t('link.fit.title')}</Label>
        <ProvenanceBadge kind="calculated" detail={t('link.fit.method')} />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted border border-dashed border-line rounded px-1.5" data-testid="link-bestfit-advisory">{t('link.fit.advisory')}</span>
      </div>
      {!fit.ok ? (
        <p className="mt-1 text-sm text-muted">{t(`link.fit.none.${['no_tanks', 'no_element_targets'].includes(fit.reason) ? fit.reason : 'other'}`)}</p>
      ) : (
        <>
          <p className="mt-1 text-xs text-muted">{t('link.fit.explain', { min: fit.bounds.min, max: fit.bounds.max })}</p>
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm">
            {Object.entries(fit.ratios).map(([id, r]) => (
              <span key={id} data-tank={id}>
                <span className="font-semibold">{letters[id] || id}</span>{' '}
                <Mono>1:{fmt.int(r)}</Mono>
                {ratios && ratios[id] != null && <span className="text-xs text-muted"> ({t('link.fit.now', { ratio: fmt.int(ratios[id]) })})</span>}
              </span>
            ))}
            <span className="text-xs text-muted">{t('link.fit.ec', { ec: fmt.number(fit.ec_ms_cm, { decimals: 2 }) })}</span>
          </p>
          <TableWrap label={t('link.fit.table')}>
            <table className="mt-2 w-full text-sm">
              <thead>
                <tr className="text-label uppercase text-muted">
                  <th className="py-1 pe-3 text-start font-semibold">{t('targets.col.element')}</th>
                  <th className="py-1 pe-3 text-end font-semibold">{t('link.fit.col.target')}</th>
                  <th className="py-1 pe-3 text-end font-semibold">{t('link.fit.col.now')}</th>
                  <th className="py-1 pe-3 text-end font-semibold">{t('link.fit.col.fit')}</th>
                  <th className="py-1 text-start font-semibold">{t('link.col.match')}</th>
                </tr>
              </thead>
              <tbody>
                {fit.elements.map(e => {
                  const d = ppmDecimals(e.element);
                  const shape = bestFitShape(e);
                  return (
                    <tr key={e.element} className="border-t border-line" data-element={e.element} data-state={shape}>
                      <td className="py-1.5 pe-3 font-semibold" lang="en">{e.element}</td>
                      <td className="py-1.5 pe-3 text-end"><Mono>{fmt.number(e.target, { decimals: d })}</Mono></td>
                      <td className="py-1.5 pe-3 text-end"><Mono className="text-muted">{e.current != null ? fmt.number(e.current, { decimals: d }) : '—'}</Mono></td>
                      <td className="py-1.5 pe-3 text-end"><Mono className="text-ink">{fmt.number(e.achieved, { decimals: d })}</Mono></td>
                      <td className="py-1.5">
                        <span className="inline-flex items-center gap-1 text-xs">
                          <StatusMark status={shape} />
                          {e.unreachable ? <strong>{t('link.fit.stockChange', { max: fmt.number(e.reachable_max, { decimals: d }), min: fmt.number(e.reachable_min, { decimals: d }) })}</strong>
                            : t(`link.fit.status.${e.status}`, { pct: e.pct != null ? fmt.number(e.pct, { decimals: 0 }) : '—' })}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
          {fit.unreachable && fit.unreachable.length > 0 && (
            <p className="mt-1 text-xs font-semibold" data-testid="link-bestfit-unreachable">{t('link.fit.unreachable', { elements: fit.unreachable.join(', ') })}</p>
          )}
          {fit.compromised && fit.compromised.length > 0 && (
            <p className="mt-1 text-xs text-muted" data-testid="link-bestfit-compromised">{t('link.fit.compromised', { elements: fit.compromised.join(', ') })}</p>
          )}
        </>
      )}
    </div>
  );
}

function nowLocalInput() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function ControllerLinkPanel({ api: apiProp = null, headers = null, canEdit = false, profileId = null, refreshKey = null, title = true }) {
  const { t } = useTranslation('nutrition');
  const fmt = useFormat();
  const api = useApi(apiProp, headers);
  const [view, setView] = useState(undefined);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [trimForm, setTrimForm] = useState({ handheld: '', seko: '', at: '', note: '' });
  const [actionError, setActionError] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get(`/nutrition/controller-link${profileId ? `?profile_id=${profileId}` : ''}`);
      setView(r.view || null);
      setError(null);
    } catch (e) { setError(e.message); }
  }, [api, profileId]);
  usePoll(load, 60000);
  useEffect(() => { if (refreshKey !== null) load(); }, [refreshKey, load]);

  const run = async (fn) => {
    setBusy(true);
    setActionError(null);
    try {
      const r = await fn();
      if (r && r.view) setView(r.view);
      setDialog(null);
    } catch (e) {
      setActionError(e.message);
      if (e.code === 'PROPOSAL_STALE') { setDialog(null); load(); }
    } finally { setBusy(false); }
  };

  if (view === undefined && !error) return null;
  const letters = view ? Object.fromEntries((view.tanks || []).map(x => [x.tank_id, x.letter || String(x.tank_id)])) : {};
  const linked = view && view.mode === LINKED;
  const diffItems = (p) => (p.diff || []).map(d => `${t(`link.field.${FIELD_KEY[d.field] || 'other'}`)}: ${fieldText(d.field, d.current, fmt, letters)} → ${fieldText(d.field, d.proposed, fmt, letters)}`);
  const dev = deviationPct(trimForm.handheld, trimForm.seko);

  let dlg = null;
  if (dialog && view) {
    if (dialog.type === 'mode') {
      dlg = {
        title: t(linked ? 'link.dialog.manualTitle' : 'link.dialog.followTitle'),
        body: t(linked ? 'link.dialog.manualBody' : 'link.dialog.followBody'),
        items: linked ? null : ['phSetpoint', 'phFloor', 'ratio', 'trimTarget', 'trimWater', 'rawWater'].map(k => t(`link.field.${k}`)),
        confirmLabel: t(linked ? 'link.mode.switchManual' : 'link.mode.switchFollow'),
        onConfirm: () => run(() => api.send('PUT', `/nutrition/profiles/${view.profile.id}/controller-link`, { mode: linked ? 'manual' : LINKED })),
      };
    } else if (dialog.type === 'approve') {
      dlg = {
        title: t('link.dialog.approveTitle', { id: dialog.p.id }),
        body: t('link.dialog.approveBody'),
        items: diffItems(dialog.p),
        confirmLabel: t('link.proposal.approve'),
        onConfirm: () => run(() => api.send('POST', `/nutrition/controller-link/proposals/${dialog.p.id}/approve`, {})),
      };
    } else if (dialog.type === 'reject') {
      dlg = {
        title: t('link.dialog.rejectTitle', { id: dialog.p.id }),
        body: t('link.dialog.rejectBody'),
        items: diffItems(dialog.p),
        variant: 'destructive',
        confirmLabel: t('link.proposal.reject'),
        onConfirm: () => run(() => api.send('POST', `/nutrition/controller-link/proposals/${dialog.p.id}/reject`, {})),
      };
    } else if (dialog.type === 'trimOff') {
      dlg = {
        title: t('link.dialog.trimOffTitle'),
        body: t('link.dialog.trimOffBody'),
        variant: 'destructive',
        confirmLabel: t('link.trim.disable'),
        onConfirm: () => run(() => api.send('POST', `/nutrition/profiles/${view.profile.id}/controller-link/ec-trim`, { enable: false, confirm: true })),
      };
    } else if (dialog.type === 'trimOn') {
      const f = trimForm;
      const ready = f.handheld !== '' && f.seko !== '' && f.at !== '';
      dlg = {
        title: t('link.dialog.trimOnTitle'),
        body: (
          <div className="space-y-2" data-testid="link-trim-form">
            <p>{t('link.dialog.trimOnBody', { max: view.ec_trim ? view.ec_trim.max_deviation_pct : 10 })}</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <label className="block text-xs">{t('link.dialog.handheld')}<NumInput value={f.handheld} onChange={(v) => setTrimForm(x => ({ ...x, handheld: v }))} unit="mS/cm" /></label>
              <label className="block text-xs">{t('link.dialog.seko')}<NumInput value={f.seko} onChange={(v) => setTrimForm(x => ({ ...x, seko: v }))} unit="mS/cm" /></label>
              <label className="block text-xs">{t('link.dialog.measuredAt')}
                <input type="datetime-local" dir="ltr" value={f.at} onChange={(e) => setTrimForm(x => ({ ...x, at: e.target.value }))}
                  className="w-full min-h-[36px] rounded-md border border-line bg-panel px-2 py-1 text-sm text-ink" />
              </label>
              <label className="block text-xs">{t('link.dialog.note')}<TextInput value={f.note} onChange={(v) => setTrimForm(x => ({ ...x, note: v }))} dir="auto" /></label>
            </div>
            {dev !== null && <p className={`text-xs ${dev > (view.ec_trim ? view.ec_trim.max_deviation_pct : 10) ? 'text-state-alarm font-semibold' : 'text-muted'}`}>{t('link.dialog.deviation', { dev: fmt.number(dev, { decimals: 1 }) })}</p>}
          </div>
        ),
        confirmLabel: t('link.trim.enable'),
        confirmDisabled: !ready,
        onConfirm: () => run(() => api.send('POST', `/nutrition/profiles/${view.profile.id}/controller-link/ec-trim`, {
          enable: true, confirm: true,
          handheld_ec_ms: Number(String(f.handheld).replace(',', '.')), seko_ec_ms: Number(String(f.seko).replace(',', '.')),
          measured_at: new Date(f.at).toISOString(), note: f.note || null,
        })),
      };
    }
  }

  return (
    <Card padding="md" data-testid="controller-link-panel">
      {title && (
        <div className="mb-3 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-base font-semibold text-ink">{t('link.title')}</h2>
          </div>
          <p className="text-xs text-muted mt-0.5">{t('link.subtitle')}</p>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-state-alarm">{t('errors.loadFailed', { error })}</p>}
      {view === null && !error && <p className="text-sm text-muted">{t('link.noProfile')}</p>}
      {view && (
        <ControllerLinkView
          view={view}
          canEdit={canEdit}
          busy={busy}
          onToggleMode={() => { setActionError(null); setDialog({ type: 'mode' }); }}
          onApprove={(p) => { setActionError(null); setDialog({ type: 'approve', p }); }}
          onReject={(p) => { setActionError(null); setDialog({ type: 'reject', p }); }}
          onTrim={(on) => { setActionError(null); if (on) setTrimForm({ handheld: '', seko: '', at: nowLocalInput(), note: '' }); setDialog({ type: on ? 'trimOn' : 'trimOff' }); }}
        />
      )}
      {actionError && !dialog && <p role="alert" className="mt-2 text-sm text-state-alarm">{t('errors.saveFailed', { error: actionError })}</p>}
      <ConfirmDialog
        open={!!dlg}
        title={dlg ? dlg.title : ''}
        body={dlg ? (<>{dlg.body}{actionError && <p role="alert" className="mt-2 text-state-alarm">{t('errors.saveFailed', { error: actionError })}</p>}</>) : null}
        items={dlg ? dlg.items : null}
        variant={dlg && dlg.variant ? dlg.variant : 'primary'}
        confirmLabel={dlg ? dlg.confirmLabel : undefined}
        confirmDisabled={dlg ? !!dlg.confirmDisabled : false}
        busy={busy}
        onConfirm={dlg ? dlg.onConfirm : () => {}}
        onCancel={() => { setDialog(null); setActionError(null); }}
      />
    </Card>
  );
}
