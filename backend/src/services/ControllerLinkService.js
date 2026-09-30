/**
 * ControllerLinkService — "Follow crop targets": the operator-editable crop stage
 * targets drive the fertigation dose controller through APPROVED proposals
 * (operator decision 2026-09-30).
 *
 * Link mode per crop profile (crop_profiles.controller_link_mode):
 *   manual               (default) nothing changes, ever.
 *   follow_crop_targets  a change of the stage targets, the source water EC or the
 *                        stage (auto from the transplant date, or an override) creates a
 *                        PENDING proposal: a diff current -> proposed per controller field,
 *                        with the reason and provenance; an info alert (fingerprint
 *                        crop_link_proposal:<profile>) + Telegram. The controller keeps its
 *                        values until an admin / operator approves (viewer cannot).
 *
 * Lifecycle: pending -> approved -> applied (or rejected / superseded / cancelled /
 * failed). Approval and rejection record who / when / the diff (the proposal row +
 * the audit log). An APPROVED proposal is applied by DoseController.beginCycle through
 * applyApprovedForCycle() — at the START of the next dose cycle, before that cycle reads
 * its config, never mid-cycle (a running cycle also keeps its pH targets frozen, see
 * DoseController._cycleConfig). It is validated again at that moment
 * (validateConfigUpdate + crossCheck + hard bounds) and fails closed (config untouched,
 * alert) when it no longer fits.
 *
 * What is proposed (controllerLinkMath): pH setpoint + floor; the uniform A-D base ratio
 * from the stage EC target and the source water EC (the crop profile field is the ONE
 * source of truth; without it the EC part is blocked); EC-trim target / water and
 * ec_check.raw_water_ec_us from the same numbers. ec_trim.enabled is never proposed: EC
 * fine-tuning has its own control (setEcTrim) that requires a recorded SEKO vs handheld
 * meter verification. The element best fit is advisory only and never applied.
 *
 * ACTUATION: none. This service writes controller SETPOINTS (system_settings
 * 'dose_controller') through DoseController.saveConfig only; it never writes a coil.
 */

const crypto = require('crypto');
const L = require('./controllerLinkMath');
const ScaleMath = require('./elementTargetScaling');
const FC = require('./FeedCalculator');
const i18n = require('../i18n');

const { M } = i18n;
const MODES = ['manual', 'follow_crop_targets'];
const OPEN_STATUSES = ['pending', 'approved'];
const TICK_MS = 60000;
const MAX_TRIM_DEVIATION_PCT = 10; // SEKO vs handheld meter: more than this and EC fine-tuning is refused

class HttpError extends Error {
  constructor(status, message, code = null, extra = {}) { super(message); this.status = status; this.code = code; Object.assign(this, extra); }
}

const parse = (s, d) => { if (s === null || s === undefined || s === '') return d; try { return JSON.parse(s); } catch (_) { return d; } };
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const sha1 = (x) => crypto.createHash('sha1').update(x).digest('hex');

class ControllerLinkService {
  /**
   * @param deps.db
   * @param deps.now            () => epoch ms
   * @param deps.doseController DoseController (default: the singleton)
   * @param deps.profiles       CropProfileService (default: one on deps.db)
   * @param deps.createAlert / deps.updateOpenAlert
   * @param deps.notify         (titleEn, bodyEn, severity, specs) — tests; default TelegramService
   * @param deps.log
   */
  constructor(deps = {}) {
    this._db = deps.db || null;
    this.now = deps.now || (() => Date.now());
    this._ctl = deps.doseController || null;
    this._profiles = deps.profiles || null;
    this._createAlert = deps.createAlert || null;
    this._updateOpenAlert = deps.updateOpenAlert || null;
    this._notifyFn = deps.notify || null;
    this.log = deps.log || console;
    this.timer = null;
    this.startTimer = null;
  }

  get db() { return this._db || require('../utils/database').db; }

  ctl() { return this._ctl || require('./DoseController').getDoseController(); }

  profiles() {
    if (!this._profiles) {
      const { CropProfileService } = require('./CropProfileService');
      this._profiles = new CropProfileService({ db: this.db, now: this.now });
    }
    return this._profiles;
  }

  _alert(opts) {
    const fn = this._createAlert || require('../utils/alertBroadcast').createAlert;
    try { return fn({ source: 'crop_link', ...opts }); } catch (e) { this.log.error(`[ControllerLink] alert failed: ${e.message}`); return null; }
  }

  _updateAlert(fingerprint, changes) {
    const fn = this._updateOpenAlert || require('../utils/alertBroadcast').updateOpenAlert;
    try { return fn(fingerprint, changes); } catch (e) { this.log.error(`[ControllerLink] alert update failed: ${e.message}`); return null; }
  }

  _notify(title, body, severity = 'info') {
    const clean = (s) => String(s).replace(/[_*`[\]]/g, ' ');
    if (this._notifyFn) {
      try { this._notifyFn(clean(i18n.render('en', title)), clean(i18n.render('en', body)), severity, { titleSpec: title, bodySpec: body }); } catch (e) { this.log.error(`[ControllerLink] notify failed: ${e.message}`); }
      return;
    }
    Promise.resolve().then(async () => {
      const { telegramService } = require('./TelegramService');
      if (!telegramService.isConfigured()) return;
      const lang = typeof telegramService.getLanguage === 'function' ? telegramService.getLanguage() : 'en';
      await telegramService.sendAlert(clean(i18n.render(lang, title)), clean(i18n.render(lang, body)), severity);
    }).catch(e => this.log.error(`[ControllerLink] Telegram failed: ${e.message}`));
  }

  // ─── lifecycle (timer) ─────────────────────────────────────────────────────

  /** Stage transitions (transplant date) are caught by a 60 s check of linked profiles. */
  start() {
    if (this.timer || this.startTimer) return;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      this.tick();
      this.timer = setInterval(() => this.tick(), TICK_MS);
      if (this.timer.unref) this.timer.unref();
    }, 45000);
    if (this.startTimer.unref) this.startTimer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.startTimer) clearTimeout(this.startTimer);
    this.timer = null; this.startTimer = null;
  }

  /** Evaluate every active linked profile. Returns the proposals created. */
  tick() {
    const out = [];
    let rows = [];
    try { rows = this.db.prepare("SELECT id FROM crop_profiles WHERE active = 1 AND controller_link_mode = 'follow_crop_targets'").all(); } catch (_) { rows = []; }
    for (const r of rows) {
      try { const p = this.evaluate(r.id); if (p) out.push(p); } catch (e) { this.log.error(`[ControllerLink] evaluate #${r.id} failed: ${e.message}`); }
    }
    return out;
  }

  // ─── compute ───────────────────────────────────────────────────────────────

  _profileRow(id) {
    const row = id ? this.db.prepare('SELECT * FROM crop_profiles WHERE id = ?').get(id) : null;
    if (!row) throw new HttpError(404, 'Crop profile not found', 'NO_PROFILE');
    return row;
  }

  _roles() {
    const roles = {};
    try { for (const r of this.db.prepare('SELECT id, role FROM fertigation_tanks').all()) roles[r.id] = r.role || 'nutrient'; } catch (_) { /* none */ }
    return roles;
  }

  /** Feed EC (fertilizers, mS/cm) of the CURRENT stock mixtures at a uniform ratio (+ water). */
  _stockEcAt(ratio, tankIds, waterEc) {
    try {
      const tanks = FC.loadCurrentTanks(this.db).filter(t => tankIds.includes(t.tank_id));
      if (!tanks.length || !(ratio > 0)) return null;
      const { ppm } = FC.mixPpm(tanks.map(t => ({ tank: t, fraction: 1 / ratio })));
      const fert = FC.cationEc(ppm);
      return { ratio, fertilizer_ec_ms_cm: Math.round(fert * 100) / 100, total_ec_ms_cm: waterEc !== null ? Math.round((fert + waterEc) * 100) / 100 : null };
    } catch (_) { return null; }
  }

  /**
   * Everything the link needs for one profile, from live data (no writes).
   * @returns {{ row, profile, stage, stageTarget, protoStage, cfg, tankIds, proposal, comparison, inputs, hash }}
   */
  compute(profileId) {
    const row = this._profileRow(profileId);
    const profile = this.profiles().resolve(row);
    const stage = profile.stage ? profile.stage.effective : null;
    const stageTarget = stage ? (profile.stage_targets || {})[stage] || null : null;
    const protocol = profile.protocol;
    const protoStage = protocol && protocol.data && protocol.data.stage_targets ? protocol.data.stage_targets[stage] || null : null;
    const stagePpm = protocol && stage ? ScaleMath.protocolStagePpm(protocol.data, stage, this.profiles()._library()) : null;
    const ctl = this.ctl();
    const { crossCheck, mergeConfig } = require('./DoseController');
    const cfg = ctl.getConfig(true);
    const tankIds = L.ratioTankIds(cfg, this._roles());
    const sw = num(row.source_water_ec);
    const proposal = stageTarget
      ? L.buildProposal({ stage, stageTarget, sourceWaterEc: sw, stagePpm, cfg, tankIds, hasProtocol: !!protocol, crossCheck, mergeConfig })
      : { update: {}, diff: [], parts: { ph: { ok: false, reason: 'no_stage_targets', math: {} }, ec: { ok: false, reason: 'no_stage_targets', math: { bounds: L.ratioBounds(cfg) } } }, blocked: [{ part: 'ph', reason: 'no_stage_targets' }, { part: 'ec', reason: 'no_stage_targets' }] };
    const comparison = L.comparison({ cfg, parts: proposal.parts, tankIds });
    const ec = proposal.parts.ec;
    const inputs = {
      stage,
      stage_source: profile.stage ? profile.stage.source : null,
      days_after_transplant: profile.stage ? profile.stage.days_after_transplant : null,
      stage_target: stageTarget ? { ec_min: stageTarget.ec_min, ec_target: stageTarget.ec_target, ec_max: stageTarget.ec_max, ph_min: stageTarget.ph_min, ph_max: stageTarget.ph_max, ph_target: stageTarget.ph_target ?? null, source: stageTarget.source || 'operator', updated_at: stageTarget.updated_at || null } : null,
      protocol_ph: protoStage && protoStage.input_ph ? { min: protoStage.input_ph.min ?? null, max: protoStage.input_ph.max ?? null } : null,
      protocol_ec: protoStage && protoStage.input_ec ? protoStage.input_ec.target ?? null : null,
      protocol_id: protocol ? protocol.id : null,
      protocol_name: protocol ? protocol.name : null,
      source_water_ec: sw,
      design_dilution: stagePpm ? stagePpm.design_dilution : null,
      protocol_fertilizer_ec: stagePpm ? Math.round(stagePpm.fertilizer_ec_ms_cm * 1000) / 1000 : null,
      bounds: L.ratioBounds(cfg),
      tank_ids: tankIds,
      stock_ec_at_ratio: ec.ok ? this._stockEcAt(ec.ratio, tankIds, sw) : null,
    };
    const hash = sha1(JSON.stringify({ stage, update: proposal.update }));
    return { row, profile, stage, stageTarget, protoStage, stagePpm, cfg, tankIds, proposal, comparison, inputs, hash };
  }

  /** Why a new proposal: compared with the inputs of the latest proposal of the profile. */
  _trigger(prevInputs, inputs) {
    if (!prevInputs) return 'targets_changed';
    if (prevInputs.stage !== inputs.stage) return 'stage_changed';
    const pick = (i) => JSON.stringify(i && i.stage_target ? [i.stage_target.ec_min, i.stage_target.ec_target, i.stage_target.ec_max, i.stage_target.ph_min, i.stage_target.ph_max, i.stage_target.ph_target] : null);
    if (pick(prevInputs) !== pick(inputs)) return 'targets_changed';
    if ((prevInputs.source_water_ec ?? null) !== (inputs.source_water_ec ?? null)) return 'source_water_changed';
    if ((prevInputs.protocol_id ?? null) !== (inputs.protocol_id ?? null)) return 'protocol_changed';
    return 'controller_changed';
  }

  // ─── proposals ─────────────────────────────────────────────────────────────

  _format(r) {
    if (!r) return null;
    return {
      id: r.id, profile_id: r.profile_id, stage: r.stage, status: r.status, trigger: r.trigger,
      inputs: parse(r.inputs_json, null), update: parse(r.update_json, {}), diff: parse(r.diff_json, []), blocked: parse(r.blocked_json, []),
      created_at: r.created_at, decided_at: r.decided_at, decided_by: r.decided_by, decided_by_email: r.decided_by_email, decided_role: r.decided_role,
      decision_note: r.decision_note, applied_at: r.applied_at, applied_run_id: r.applied_run_id, applied_config_version_id: r.applied_config_version_id,
      failure: r.failure, superseded_by: r.superseded_by,
    };
  }

  getProposal(id) {
    return this._format(this.db.prepare('SELECT * FROM controller_link_proposals WHERE id = ?').get(id));
  }

  listProposals(profileId, { limit = 20, offset = 0 } = {}) {
    const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const off = Math.max(parseInt(offset, 10) || 0, 0);
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM controller_link_proposals WHERE profile_id = ?').get(profileId).n;
    const items = this.db.prepare('SELECT * FROM controller_link_proposals WHERE profile_id = ? ORDER BY id DESC LIMIT ? OFFSET ?').all(profileId, lim, off).map(r => this._format(r));
    return { total, limit: lim, offset: off, items };
  }

  _latest(profileId, statuses = null) {
    const where = statuses ? `AND status IN (${statuses.map(() => '?').join(',')})` : '';
    return this.db.prepare(`SELECT * FROM controller_link_proposals WHERE profile_id = ? ${where} ORDER BY id DESC LIMIT 1`).get(profileId, ...(statuses || [])) || null;
  }

  /**
   * Re-evaluate a linked profile. Creates a PENDING proposal when the crop targets imply
   * controller values that differ from the live config and no identical proposal is
   * already pending / approved / rejected. Returns the new proposal or null.
   */
  evaluate(profileId, { trigger = null } = {}) {
    const row = this._profileRow(profileId);
    if (row.active !== 1 || row.controller_link_mode !== 'follow_crop_targets') return null;
    const c = this.compute(profileId);
    const nowIso = new Date(this.now()).toISOString();
    const hasChange = c.proposal.diff.length > 0;
    const open = this.db.prepare(`SELECT * FROM controller_link_proposals WHERE profile_id = ? AND status IN ('pending', 'approved') ORDER BY id DESC`).all(profileId);
    if (!hasChange) {
      // The controller already matches the crop targets: open proposals are moot.
      if (open.length) {
        this.db.prepare(`UPDATE controller_link_proposals SET status = 'superseded', failure = 'controller already matches the crop targets', decided_at = COALESCE(decided_at, ?) WHERE profile_id = ? AND status IN ('pending', 'approved')`).run(nowIso, profileId);
        this._updateAlert(`crop_link_proposal:${profileId}`, { messageKey: 'crop_link.alert.matches', messageParams: { crop: row.crop } });
      }
      return null;
    }
    const latest = this._latest(profileId);
    const sameAs = this.db.prepare(`SELECT id, status FROM controller_link_proposals WHERE profile_id = ? AND hash = ? ORDER BY id DESC LIMIT 1`).get(profileId, c.hash);
    // an identical proposal still open or rejected is never raised again (a failed one may be: re-approval needed anyway)
    if (sameAs && latest && sameAs.id === latest.id && ['pending', 'approved', 'rejected'].includes(sameAs.status)) return null;
    if (sameAs && open.some(o => o.id === sameAs.id)) return null;
    const why = trigger || this._trigger(latest ? parse(latest.inputs_json, null) : null, c.inputs);
    let id = null;
    this.db.transaction(() => {
      id = Number(this.db.prepare(`
        INSERT INTO controller_link_proposals (profile_id, stage, status, trigger, hash, inputs_json, update_json, diff_json, blocked_json, created_at)
        VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
      `).run(profileId, c.stage, why, c.hash, JSON.stringify(c.inputs), JSON.stringify(c.proposal.update), JSON.stringify(c.proposal.diff), JSON.stringify(c.proposal.blocked), nowIso).lastInsertRowid);
      if (open.length) {
        this.db.prepare(`UPDATE controller_link_proposals SET status = 'superseded', superseded_by = ?, decided_at = COALESCE(decided_at, ?) WHERE profile_id = ? AND status IN ('pending', 'approved') AND id <> ?`).run(id, nowIso, profileId, id);
      }
    })();
    const params = { crop: row.crop, stage: { $k: `crop_link.stage.${c.stage || 'none'}` }, count: c.proposal.diff.length, id };
    this._alert({ severity: 'info', fingerprint: `crop_link_proposal:${profileId}`, messageKey: 'crop_link.alert.pending', messageParams: params, zone_id: row.zone_id || null });
    this._notify(M('crop_link.telegram.pending', { crop: row.crop }), M('crop_link.alert.pending', params), 'info');
    this.log.log(`[ControllerLink] proposal #${id} (${why}) for profile #${profileId}: ${c.proposal.diff.map(d => d.field).join(', ')}`);
    return this.getProposal(id);
  }

  _decisionGuard(pid, user, allowed) {
    const r = this.db.prepare('SELECT * FROM controller_link_proposals WHERE id = ?').get(pid);
    if (!r) throw new HttpError(404, 'Proposal not found', 'NO_PROPOSAL');
    if (!allowed.includes(r.status)) throw new HttpError(409, `Proposal is ${r.status}`, 'PROPOSAL_NOT_OPEN', { status_now: r.status });
    if (!user || !['admin', 'operator'].includes(user.role)) throw new HttpError(403, 'Only an admin or operator can decide a proposal', 'FORBIDDEN');
    return r;
  }

  /**
   * Validate a proposal's update against a config: schema, cross-checks, hard bounds.
   * Returns an error string or null.
   */
  _applyCheck(update, cfg) {
    const { validateConfigUpdate, mergeConfig, crossCheck } = require('./DoseController');
    const v = validateConfigUpdate(update);
    if (v.error) return v.error;
    const merged = mergeConfig(cfg, v.value);
    const bad = crossCheck(merged);
    if (bad) return bad;
    const ratio = (update.nutrients && update.nutrients.ratio) || {};
    for (const [id, val] of Object.entries(ratio)) {
      if (!(val >= L.RATIO_HARD_BOUNDS.min && val <= L.RATIO_HARD_BOUNDS.max)) return `ratio of tank ${id} (1:${val}) outside the hard bounds 1:${L.RATIO_HARD_BOUNDS.min}..1:${L.RATIO_HARD_BOUNDS.max}`;
    }
    if (update.nutrients && update.nutrients.ec_trim && 'enabled' in update.nutrients.ec_trim) return 'a crop-target proposal never switches EC fine-tuning';
    if (update.enabled !== undefined || (update.ph && 'enabled' in update.ph)) return 'a crop-target proposal never switches the controller or the pH loop';
    return null;
  }

  approve(pid, user, note = null) {
    const r = this._decisionGuard(pid, user, ['pending']);
    const row = this._profileRow(r.profile_id);
    if (row.active !== 1 || row.controller_link_mode !== 'follow_crop_targets') throw new HttpError(409, 'The crop profile is not linked to the controller', 'NOT_LINKED');
    // Stale check: the proposal must still be what the crop targets imply now.
    const c = this.compute(r.profile_id);
    if (c.hash !== r.hash) {
      const fresh = this.evaluate(r.profile_id);
      throw new HttpError(409, 'The crop targets or the controller changed since this proposal was made — review the newer proposal', 'PROPOSAL_STALE', { newer_id: fresh ? fresh.id : null });
    }
    const bad = this._applyCheck(parse(r.update_json, {}), c.cfg);
    if (bad) {
      this.db.prepare("UPDATE controller_link_proposals SET status = 'failed', failure = ?, decided_at = ?, decided_by = ?, decided_by_email = ?, decided_role = ? WHERE id = ?")
        .run(bad, new Date(this.now()).toISOString(), user.id ?? null, user.email ?? null, user.role, pid);
      throw new HttpError(409, `Proposal fails the controller checks: ${bad}`, 'PROPOSAL_INVALID');
    }
    const nowIso = new Date(this.now()).toISOString();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE controller_link_proposals SET status = 'approved', decided_at = ?, decided_by = ?, decided_by_email = ?, decided_role = ?, decision_note = ? WHERE id = ?`)
        .run(nowIso, user.id ?? null, user.email ?? null, user.role, note ? String(note).slice(0, 500) : null, pid);
      this.db.prepare(`UPDATE controller_link_proposals SET status = 'superseded', superseded_by = ? WHERE profile_id = ? AND status = 'approved' AND id <> ?`).run(pid, r.profile_id, pid);
    })();
    this._updateAlert(`crop_link_proposal:${r.profile_id}`, { messageKey: 'crop_link.alert.approved', messageParams: { id: pid, crop: row.crop, by: user.email || '' } });
    return this.getProposal(pid);
  }

  reject(pid, user, note = null) {
    const r = this._decisionGuard(pid, user, OPEN_STATUSES);
    const row = this._profileRow(r.profile_id);
    this.db.prepare(`UPDATE controller_link_proposals SET status = 'rejected', decided_at = ?, decided_by = ?, decided_by_email = ?, decided_role = ?, decision_note = ? WHERE id = ?`)
      .run(new Date(this.now()).toISOString(), user.id ?? null, user.email ?? null, user.role, note ? String(note).slice(0, 500) : null, pid);
    this._updateAlert(`crop_link_proposal:${r.profile_id}`, { messageKey: 'crop_link.alert.rejected', messageParams: { id: pid, crop: row.crop, by: user.email || '' } });
    return this.getProposal(pid);
  }

  /**
   * DoseController.beginCycle hook — the ONLY place a proposal reaches the controller.
   * Applies the latest APPROVED proposal (re-validated against the config of this
   * moment) before the cycle reads its config. Fails closed: on any problem the config
   * is untouched, the proposal is marked failed and a warning alert is raised.
   * @returns {{ proposal_id, config_version_id } | null}
   */
  applyApprovedForCycle(ctl) {
    let r = null;
    try { r = this.db.prepare("SELECT * FROM controller_link_proposals WHERE status = 'approved' ORDER BY id DESC LIMIT 1").get(); } catch (_) { return null; }
    if (!r) return null;
    const nowIso = new Date(this.now()).toISOString();
    const fail = (why, cancelled = false) => {
      this.db.prepare(`UPDATE controller_link_proposals SET status = ?, failure = ? WHERE id = ?`).run(cancelled ? 'cancelled' : 'failed', why, r.id);
      if (!cancelled) {
        this._alert({ severity: 'warning', fingerprint: `crop_link_apply_failed:${r.profile_id}`, messageKey: 'crop_link.alert.apply_failed', messageParams: { id: r.id, reason: why } });
      }
      this.log.warn(`[ControllerLink] proposal #${r.id} not applied: ${why}`);
      return null;
    };
    let row = null;
    try { row = this.db.prepare('SELECT * FROM crop_profiles WHERE id = ?').get(r.profile_id); } catch (_) { row = null; }
    if (!row || row.active !== 1) return fail('crop profile no longer active', true);
    if (row.controller_link_mode !== 'follow_crop_targets') return fail('link switched to manual', true);
    const update = parse(r.update_json, null);
    if (!update || !Object.keys(update).length) return fail('empty proposal');
    const bad = this._applyCheck(update, ctl.getConfig(true));
    if (bad) return fail(bad);
    try {
      ctl.saveConfig(update, { source: 'crop_link', proposalId: r.id, user: { id: r.decided_by, email: r.decided_by_email } });
    } catch (e) {
      return fail(e.message);
    }
    const versionId = ctl._lastVersionId ?? null;
    this.db.prepare(`UPDATE controller_link_proposals SET status = 'applied', applied_at = ?, applied_config_version_id = ? WHERE id = ?`).run(nowIso, versionId, r.id);
    this._updateAlert(`crop_link_proposal:${r.profile_id}`, { messageKey: 'crop_link.alert.applied', messageParams: { id: r.id, crop: row.crop } });
    this.log.log(`[ControllerLink] proposal #${r.id} applied at the start of a dose cycle (config v${versionId})`);
    return { proposal_id: r.id, config_version_id: versionId };
  }

  // ─── link mode + EC fine-tuning ────────────────────────────────────────────

  setMode(profileId, mode, user) {
    if (!MODES.includes(mode)) throw new HttpError(400, `mode must be one of ${MODES.join(', ')}`, 'BAD_MODE');
    if (!user || !['admin', 'operator'].includes(user.role)) throw new HttpError(403, 'Only an admin or operator can change the link', 'FORBIDDEN');
    const row = this._profileRow(profileId);
    if (row.active !== 1) throw new HttpError(409, 'Only the active crop profile can be linked', 'NOT_ACTIVE');
    const nowIso = new Date(this.now()).toISOString();
    if (mode === 'follow_crop_targets') {
      // one linked profile drives the controller
      const other = this.db.prepare("SELECT id FROM crop_profiles WHERE controller_link_mode = 'follow_crop_targets' AND id <> ? AND active = 1").get(profileId);
      if (other) throw new HttpError(409, `Crop profile #${other.id} already follows the crop targets`, 'OTHER_LINKED');
    }
    this.db.prepare("UPDATE crop_profiles SET controller_link_mode = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?").run(mode, user.id ?? null, profileId);
    let proposal = null;
    if (mode === 'manual') {
      const n = this.db.prepare(`UPDATE controller_link_proposals SET status = 'cancelled', failure = 'link switched to manual', decided_at = ?, decided_by = ?, decided_by_email = ?, decided_role = ? WHERE profile_id = ? AND status IN ('pending', 'approved')`)
        .run(nowIso, user.id ?? null, user.email ?? null, user.role, profileId).changes;
      if (n) this._updateAlert(`crop_link_proposal:${profileId}`, { messageKey: 'crop_link.alert.cancelled', messageParams: { crop: row.crop } });
    } else if (row.controller_link_mode !== mode) {
      proposal = this.evaluate(profileId, { trigger: 'link_enabled' });
    }
    return { mode, proposal };
  }

  /**
   * EC fine-tuning (the ec_trim outer loop on the SEKO feed EC). Enabling requires:
   * the profile linked, the controller's EC part in sync with the crop targets, and a
   * recorded verification of the SEKO EC against a handheld meter (within 10 %).
   * Disabling is always allowed (safe direction). The trim is computed at the start of
   * each cycle, so either change takes effect from the next cycle.
   * body: { enable: boolean, confirm: true, handheld_ec_ms, seko_ec_ms, measured_at, note }
   */
  setEcTrim(profileId, body, user) {
    if (!user || !['admin', 'operator'].includes(user.role)) throw new HttpError(403, 'Only an admin or operator can change EC fine-tuning', 'FORBIDDEN');
    const b = body || {};
    if (typeof b.enable !== 'boolean') throw new HttpError(400, 'enable must be true or false', 'BAD_BODY');
    if (b.confirm !== true) throw new HttpError(400, 'confirm must be true (separately confirmed control)', 'NOT_CONFIRMED');
    const row = this._profileRow(profileId);
    const ctl = this.ctl();
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const note = b.note ? String(b.note).slice(0, 300) : null;
    const record = (action, extra = {}) => Number(this.db.prepare(`
      INSERT INTO dose_controller_ec_trim_checks (profile_id, action, handheld_ec_ms, seko_ec_ms, deviation_pct, measured_at, note, user_id, user_email, user_role, config_version_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(profileId, action, extra.handheld ?? null, extra.seko ?? null, extra.dev ?? null, extra.measuredAt ?? null, note, user.id ?? null, user.email ?? null, user.role, extra.versionId ?? null, nowIso).lastInsertRowid);
    if (!b.enable) {
      ctl.saveConfig({ nutrients: { ec_trim: { enabled: false } } }, { source: 'ec_trim_check', user: { id: user.id, email: user.email } });
      record('disable', { versionId: ctl._lastVersionId ?? null });
      return this.view(profileId);
    }
    if (row.active !== 1 || row.controller_link_mode !== 'follow_crop_targets') throw new HttpError(409, 'Link the crop profile to the controller first', 'NOT_LINKED');
    const c = this.compute(profileId);
    if (!c.proposal.parts.ec.ok) throw new HttpError(409, `The EC part of the crop targets is not available (${c.proposal.parts.ec.reason})`, 'EC_NOT_AVAILABLE', { reason: c.proposal.parts.ec.reason });
    const out = c.comparison.filter(x => ['nutrients.ratio', 'nutrients.ec_trim.target_us', 'nutrients.ec_trim.water_us'].includes(x.field) && x.match !== true);
    if (out.length) throw new HttpError(409, 'Approve the EC proposal first: the controller ratio / EC target / water EC do not follow the crop targets yet', 'EC_NOT_IN_SYNC', { fields: out.map(x => x.field) });
    const handheld = num(b.handheld_ec_ms);
    const seko = num(b.seko_ec_ms);
    if (handheld === null || handheld < 0.1 || handheld > 10) throw new HttpError(400, 'handheld_ec_ms must be the handheld meter reading in mS/cm (0.1-10)', 'BAD_HANDHELD');
    if (seko === null || seko < 0.1 || seko > 10) throw new HttpError(400, 'seko_ec_ms must be the SEKO reading in mS/cm (0.1-10)', 'BAD_SEKO');
    const mt = Date.parse(String(b.measured_at || ''));
    if (!Number.isFinite(mt) || mt > nowMs + 5 * 60000 || mt < nowMs - 7 * 86400000) throw new HttpError(400, 'measured_at must be when both readings were taken (within the last 7 days)', 'BAD_MEASURED_AT');
    const dev = Math.round((Math.abs(seko - handheld) / handheld) * 1000) / 10;
    if (dev > MAX_TRIM_DEVIATION_PCT) {
      record('refused', { handheld, seko, dev, measuredAt: new Date(mt).toISOString() });
      throw new HttpError(409, `SEKO (${seko} mS/cm) and the handheld meter (${handheld} mS/cm) differ by ${dev} % (> ${MAX_TRIM_DEVIATION_PCT} %): check the SEKO EC calibration first`, 'SEKO_DISAGREES', { deviation_pct: dev });
    }
    ctl.saveConfig({ nutrients: { ec_trim: { enabled: true } } }, { source: 'ec_trim_check', user: { id: user.id, email: user.email } });
    record('enable', { handheld, seko, dev, measuredAt: new Date(mt).toISOString(), versionId: ctl._lastVersionId ?? null });
    return this.view(profileId);
  }

  // ─── view ──────────────────────────────────────────────────────────────────

  /** Provenance of each tracked controller value: recorded origin, else default / operator. */
  _fieldProvenance(cfg, tankIds) {
    const { DEFAULT_CONFIG, fieldValue } = require('./DoseController');
    const rec = typeof this.ctl().getFieldProvenance === 'function' ? this.ctl().getFieldProvenance() : {};
    const fields = ['ph.setpoint', 'ph.floor_ph', 'ph.deadband', 'nutrients.ec_trim.enabled', 'nutrients.ec_trim.target_us', 'nutrients.ec_trim.water_us', 'ec_check.raw_water_ec_us', ...tankIds.map(id => `nutrients.ratio.${id}`)];
    const out = {};
    for (const f of fields) {
      const r = rec[f];
      if (r && r.kind) { out[f] = { origin: r.kind, proposal_id: r.proposal_id ?? null, user_email: r.user_email ?? null, at: r.at ?? null }; continue; }
      const dv = fieldValue(DEFAULT_CONFIG, f);
      const v = fieldValue(cfg, f);
      out[f] = { origin: JSON.stringify(dv ?? null) === JSON.stringify(v ?? null) ? 'default' : 'operator_unrecorded', proposal_id: null, user_email: null, at: null };
    }
    return out;
  }

  _bestFit(c) {
    try {
      const stage = c.stage;
      const targets = stage ? (c.profile.element_targets || {})[stage] || [] : [];
      const tanks = FC.loadCurrentTanks(this.db).filter(t => c.tankIds.includes(t.tank_id)).map(t => ({ tank_id: t.tank_id, letter: t.letter, name: t.name, mixture_name: t.mixture_name, stock: FC.tankStock(t).mg }));
      return { ...L.bestFit({ tanks, targets, bounds: L.ratioBounds(c.cfg), currentRatios: c.cfg.nutrients.ratio }), tanks: tanks.map(t => ({ tank_id: t.tank_id, letter: t.letter, name: t.name, mixture_name: t.mixture_name })), stage, advisory: true };
    } catch (e) {
      return { ok: false, reason: 'error', detail: e.message, advisory: true };
    }
  }

  _lastRun() {
    try {
      const r = this.db.prepare('SELECT id, started_at, status, config_version_id, link_proposal_id FROM dose_controller_runs ORDER BY started_at DESC, id DESC LIMIT 1').get();
      return r || null;
    } catch (_) { return null; }
  }

  /** Active profile id (primary crop zone first). */
  activeProfileId() {
    const r = this.profiles().activeRow();
    return r ? r.id : null;
  }

  /** Everything the UI shows (read-only). */
  view(profileId) {
    const c = this.compute(profileId);
    const cfg = c.cfg;
    const ctl = this.ctl();
    const prov = this._fieldProvenance(cfg, c.tankIds);
    const sw = c.inputs.source_water_ec;
    const trimWater = cfg.nutrients.ec_trim.water_us;
    const raw = cfg.ec_check.raw_water_ec_us;
    let discrepancy = 'ok';
    if (sw === null) discrepancy = 'profile_missing';
    else if (Math.round(sw * 1000) !== Math.round(trimWater) || (raw !== null && Math.round(sw * 1000) !== Math.round(raw))) discrepancy = 'mismatch';
    const checks = this.db.prepare('SELECT * FROM dose_controller_ec_trim_checks ORDER BY id DESC LIMIT 5').all();
    const running = !!(ctl.cycle && !ctl.cycle.ended);
    return {
      profile: { id: c.row.id, crop: c.row.crop, variety: c.row.variety, active: c.row.active === 1, stage: c.profile.stage },
      mode: c.row.controller_link_mode || 'manual',
      controller: {
        enabled: cfg.enabled,
        ph: { setpoint: cfg.ph.setpoint, floor_ph: cfg.ph.floor_ph, deadband: cfg.ph.deadband, enabled: cfg.ph.enabled },
        ratio: Object.fromEntries(c.tankIds.map(id => [id, cfg.nutrients.ratio[id] ?? null])),
        uniform_ratio: L.uniformRatio(cfg.nutrients.ratio, c.tankIds),
        ec_trim: { ...cfg.nutrients.ec_trim },
        raw_water_ec_us: raw,
        provenance: prov,
        running_cycle: running,
        running_cycle_setpoint: running && ctl.cycle.cfgAtStart ? ctl.cycle.cfgAtStart.ph.setpoint : null,
        last_run: this._lastRun(),
      },
      tanks: c.tankIds.map(id => {
        const t = this.db.prepare('SELECT id, name FROM fertigation_tanks WHERE id = ?').get(id);
        return { tank_id: id, name: t ? t.name : null, letter: FC.tankLetter(t ? t.name : null, id) };
      }),
      crop: c.inputs,
      comparison: c.comparison,
      now: { update: c.proposal.update, diff: c.proposal.diff, blocked: c.proposal.blocked, ph: c.proposal.parts.ph, ec: c.proposal.parts.ec },
      pending: this._format(this._latest(c.row.id, ['pending'])),
      approved: this._format(this._latest(c.row.id, ['approved'])),
      history: this.listProposals(c.row.id, { limit: 10 }),
      source_water: {
        profile_ec: sw,
        trim_water_us: trimWater,
        trim_water_origin: prov['nutrients.ec_trim.water_us'] ? prov['nutrients.ec_trim.water_us'].origin : null,
        raw_water_ec_us: raw,
        discrepancy,
      },
      ec_trim: {
        enabled: cfg.nutrients.ec_trim.enabled === true,
        max_deviation_pct: MAX_TRIM_DEVIATION_PCT,
        checks: checks.map(x => ({ id: x.id, action: x.action, handheld_ec_ms: x.handheld_ec_ms, seko_ec_ms: x.seko_ec_ms, deviation_pct: x.deviation_pct, measured_at: x.measured_at, note: x.note, user_email: x.user_email, created_at: x.created_at })),
      },
      best_fit: this._bestFit(c),
    };
  }
}

const byDb = new WeakMap();
let singleton = null;

/** The service bound to a database handle (DoseController hook: same db as the controller). */
function controllerLinkServiceFor(db) {
  const { db: defaultDb } = require('../utils/database');
  if (!db || db === defaultDb) return getControllerLinkService();
  if (!byDb.has(db)) byDb.set(db, new ControllerLinkService({ db }));
  return byDb.get(db);
}

function getControllerLinkService() {
  if (!singleton) singleton = new ControllerLinkService();
  return singleton;
}

module.exports = { ControllerLinkService, getControllerLinkService, controllerLinkServiceFor, HttpError, MODES, MAX_TRIM_DEVIATION_PCT };
