/**
 * Audit route map: method + route pattern -> action, category, target resolver,
 * BEFORE-snapshot loader, summary. Used by middleware/auditLog.js.
 *
 * Every mutating route under backend/src/routes/* is listed here. A request
 * that matches nothing still gets a generic audit row (action "<method>.request",
 * category from the mount prefix) — see genericDef().
 *
 * Contract of a def:
 *   method, pattern          '/api/automations/:id'
 *   action                   string | (ctx) => string
 *   category                 string | (ctx) => string        (primary domain)
 *   tags                     string[] | (ctx) => string[]      (extra categories)
 *   target(ctx)              -> { type, id, name } | null
 *   before(ctx)              -> snapshot | null   (runs BEFORE the handler)
 *   after(ctx) | after:true  -> snapshot | null   (true = re-run `before` after the response)
 *   summary(ctx)             -> one human sentence (attempt wording; the result is appended)
 *   severity                 'info' | 'warning' | 'critical' (for a successful call)
 *   skip                     true -> never logged (pure noise, e.g. PTZ stop)
 *   coalesceSeconds          repeated identical calls inside the window bump repeat_count
 *   actorFromBody            login: actor email comes from the request body
 *   preResolveActor          logout / change-password: resolve the session before the handler deletes it
 *
 * ctx: { params, body, query, status, ok, resBody, before, after, user, diff, changes }
 * All loaders are wrapped in try/catch by the middleware; returning null is fine.
 */

const { db } = require('../utils/database');
const { parseMaybeJson, fmtSeconds } = require('./AuditDiff');

// ---------------------------------------------------------------------------
// Small DB helpers (read-only)
// ---------------------------------------------------------------------------

function q1(sql, ...params) {
  try { return db.prepare(sql).get(...params) || null; } catch (_) { return null; }
}
function qa(sql, ...params) {
  try { return db.prepare(sql).all(...params); } catch (_) { return []; }
}

function parseFields(row, jsonFields = [], omit = []) {
  if (!row) return null;
  const out = { ...row };
  for (const f of omit) delete out[f];
  for (const f of jsonFields) if (f in out) out[f] = parseMaybeJson(out[f]);
  return out;
}

const idOf = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

// ---------------------------------------------------------------------------
// Names + domains
// ---------------------------------------------------------------------------

function equipmentRow(id) {
  return q1('SELECT id, name, type, address, slave_id, register_mappings FROM equipment WHERE id = ?', idOf(id));
}

function coilMappings(eq) {
  const maps = parseMaybeJson(eq && eq.register_mappings);
  return Array.isArray(maps) ? maps : [];
}

function channelLabel(eq, channel) {
  if (!eq) return `ch ${channel}`;
  const ch = Number(channel);
  const m = coilMappings(eq).find(x => (x.type === 'coil' || x.functionCode === 1 || x.type === undefined) && Number(x.register) === ch);
  return (m && (m.label || m.name)) || `ch ${channel}`;
}

function equipmentChannelName(eqOrId, channel) {
  const eq = typeof eqOrId === 'object' ? eqOrId : equipmentRow(eqOrId);
  if (!eq) return `equipment ${eqOrId} ch ${channel}`;
  return `${eq.name} › ${channelLabel(eq, channel)}`;
}

/** irrigation | dosing | climate | null from free text (channel label first, then board name). */
function classifyChannelText(s) {
  const t = String(s || '').toLowerCase();
  if (!t) return null;
  if (/\btank\b|ph[\s-]?down|ph[\s-]?up|\bdos(e|ing)\b|nutrient|acid|venturi|injector/.test(t)) return 'dosing';
  if (/\bfan|\bpad|shade|fog|mist|cool|vent|climate|heater|chiller|curtain/.test(t)) return 'climate';
  if (/irrigat|zone|pump|valve|water|flush|drip|sprinkl/.test(t)) return 'irrigation';
  return null;
}

function classifyAutomationText(s) {
  const t = String(s || '').toLowerCase();
  if (!t) return null;
  if (/irrigat|zone|fertig|water|pump|flush|leach|drip/.test(t)) return 'irrigation';
  if (/climate|\bfan|\bpad|temp|humid|cool|shade|fog|vpd/.test(t)) return 'climate';
  if (/\bdos(e|ing)\b|tank|ph\b|\bec\b|nutrient/.test(t)) return 'dosing';
  return null;
}

function equipmentDomain(eqOrId, channel) {
  const eq = typeof eqOrId === 'object' ? eqOrId : equipmentRow(eqOrId);
  if (!eq) return 'equipment';
  if (channel !== undefined && channel !== null) {
    const byChannel = classifyChannelText(channelLabel(eq, channel));
    if (byChannel) return byChannel;
  }
  // Board-level: majority of its coil labels, else its name.
  const counts = {};
  for (const m of coilMappings(eq)) {
    const d = classifyChannelText(m.label || m.name);
    if (d) counts[d] = (counts[d] || 0) + 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (best) return best[0];
  return classifyChannelText(eq.name) || 'equipment';
}

function automationRow(id) {
  return q1('SELECT * FROM automations WHERE id = ?', idOf(id));
}

function automationDomain(row) {
  if (!row) return 'automations';
  const byName = classifyAutomationText(row.name);
  if (byName) return byName;
  const actions = parseMaybeJson(row.actions);
  if (Array.isArray(actions)) {
    const counts = {};
    for (const a of actions) {
      if (a && a.equipment_id != null) {
        const d = equipmentDomain(a.equipment_id, a.channel);
        if (d !== 'equipment') counts[d] = (counts[d] || 0) + 1;
      }
    }
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (best) return best[0];
  }
  return 'automations';
}

const nameOf = (table, col, id) => {
  const r = q1(`SELECT ${col} AS n FROM ${table} WHERE id = ?`, idOf(id));
  return r ? r.n : null;
};

// ---------------------------------------------------------------------------
// Snapshot loaders
// ---------------------------------------------------------------------------

const snap = {
  automation: (id) => parseFields(automationRow(id), ['trigger_config', 'conditions', 'actions', 'skip_conditions']),
  equipment: (id) => parseFields(
    q1('SELECT id, name, description, type, protocol, address, enabled, slave_id, polling_interval_ms, request_gap_ms, calibration_offset, calibration_scale, register_mappings, write_only FROM equipment WHERE id = ?', idOf(id))
      || q1('SELECT id, name, description, type, protocol, address, enabled, slave_id, polling_interval_ms, request_gap_ms, calibration_offset, calibration_scale, register_mappings FROM equipment WHERE id = ?', idOf(id)),
    ['register_mappings'],
  ),
  user: (id) => q1('SELECT id, email, name, role FROM users WHERE id = ?', idOf(id)),
  userByEmail: (email) => q1('SELECT id, email, name, role FROM users WHERE email = ?', String(email || '')),
  zone: (id) => {
    const z = q1('SELECT * FROM zones WHERE id = ?', idOf(id));
    if (!z) return null;
    z.equipment_ids = qa('SELECT equipment_id FROM equipment_zones WHERE zone_id = ? ORDER BY equipment_id', idOf(id)).map(r => r.equipment_id);
    return z;
  },
  camera: (id) => parseFields(q1('SELECT * FROM cameras WHERE id = ?', idOf(id)), [], ['password', 'password_enc', 'rtsp_password']),
  tank: (id) => q1('SELECT * FROM fertigation_tanks WHERE id = ?', idOf(id)),
  doseProgram: (id) => {
    const p = q1('SELECT * FROM fertigation_dose_programs WHERE id = ?', idOf(id));
    if (!p) return null;
    p.tanks = qa('SELECT * FROM fertigation_dose_program_tanks WHERE program_id = ? ORDER BY id', idOf(id)).map(t => {
      const { program_id, ...rest } = t; return rest;
    });
    return p;
  },
  mixture: (id) => {
    const m = q1('SELECT * FROM fertigation_mixtures WHERE id = ?', idOf(id));
    if (!m) return null;
    m.items = qa('SELECT * FROM fertigation_mixture_items WHERE mixture_id = ? ORDER BY id', idOf(id)).map(i => {
      const { mixture_id, ...rest } = i; return rest;
    });
    return m;
  },
  row: (table, id, json = []) => parseFields(q1(`SELECT * FROM ${table} WHERE id = ?`, idOf(id)), json),
  channelConfig: (eqId, ch) => q1('SELECT * FROM relay_channel_config WHERE equipment_id = ? AND channel = ?', idOf(eqId), idOf(ch)),
  calibration: (eqId, metric) => q1('SELECT * FROM sensor_calibrations WHERE equipment_id = ? AND metric = ?', idOf(eqId), String(metric)),
  settings: (keys) => {
    const out = {};
    for (const k of keys) {
      const r = q1('SELECT value FROM system_settings WHERE key = ?', k);
      out[k] = r ? parseMaybeJson(r.value) : null;
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Def builders
// ---------------------------------------------------------------------------

const quote = (s) => (s ? `'${s}'` : '');
const snapName = (ctx) => (ctx.after && ctx.after.name) || (ctx.before && ctx.before.name) || null;

function editSummary(noun, nameFn) {
  return (ctx) => {
    const name = nameFn ? nameFn(ctx) : snapName(ctx);
    const head = `Edited ${noun}${name ? ` ${quote(name)}` : ''}`;
    if (ctx.changes && ctx.changes.length) return `${head}: ${ctx.changesText}`;
    if (ctx.ok && ctx.diff && ctx.diff.length === 0) return `${head} (no field changed)`;
    return head;
  };
}

/** A row CRUD group for `/api/<base>` + `/api/<base>/:id`. */
function crud(base, { noun, table, category, tags, snapFn, idFromRes, nameCol = 'name', json = [], actionPrefix, create = true, update = true, remove = true, updateMethod = 'PUT' }) {
  const loader = snapFn || ((id) => snap.row(table, id, json));
  const prefix = actionPrefix || noun.replace(/\s+/g, '_');
  const target = (id, ctx) => ({ type: prefix, id, name: (ctx.after && ctx.after[nameCol]) || (ctx.before && ctx.before[nameCol]) || null });
  const defs = [];
  if (create) {
    defs.push({
      method: 'POST', pattern: `/api/${base}`, action: `${prefix}.create`, category, tags,
      after: (ctx) => {
        const id = idFromRes ? idFromRes(ctx.resBody) : (ctx.resBody && (ctx.resBody.id ?? (ctx.resBody[prefix] && ctx.resBody[prefix].id) ?? ctx.resBody.lastInsertRowid));
        return id != null ? loader(id) : null;
      },
      target: (ctx) => target(ctx.after && ctx.after.id != null ? ctx.after.id : null, ctx),
      summary: (ctx) => `Created ${noun} ${quote((ctx.after && ctx.after[nameCol]) || (ctx.body && ctx.body[nameCol]) || '')}`.trim(),
    });
  }
  if (update) {
    defs.push({
      method: updateMethod, pattern: `/api/${base}/:id`, action: `${prefix}.update`, category, tags,
      before: (ctx) => loader(ctx.params.id), after: true,
      target: (ctx) => target(ctx.params.id, ctx),
      summary: editSummary(noun, (ctx) => (ctx.after && ctx.after[nameCol]) || (ctx.before && ctx.before[nameCol])),
    });
  }
  if (remove) {
    defs.push({
      method: 'DELETE', pattern: `/api/${base}/:id`, action: `${prefix}.delete`, category, tags,
      before: (ctx) => loader(ctx.params.id),
      target: (ctx) => target(ctx.params.id, ctx),
      summary: (ctx) => `Deleted ${noun} ${quote(ctx.before && ctx.before[nameCol]) || `#${ctx.params.id}`}`,
      severity: 'warning',
    });
  }
  return defs;
}

function settingsDef(method, pattern, action, category, keys, noun, extra = {}) {
  return {
    method, pattern, action, category, tags: ['settings'],
    before: () => snap.settings(keys), after: true,
    target: () => ({ type: 'setting', id: keys.join(','), name: noun }),
    summary: (ctx) => (ctx.changes && ctx.changes.length ? `Changed ${noun}: ${ctx.changesText}` : `Saved ${noun}${ctx.ok && ctx.diff && !ctx.diff.length ? ' (no value changed)' : ''}`),
    ...extra,
  };
}

function simple(method, pattern, action, category, summary, extra = {}) {
  return { method, pattern, action, category, summary: typeof summary === 'function' ? summary : () => summary, ...extra };
}

// ---------------------------------------------------------------------------
// Automation helpers
// ---------------------------------------------------------------------------

const automationTarget = (ctx) => {
  const id = ctx.params.id;
  const name = snapName(ctx) || nameOf('automations', 'name', id);
  return { type: 'automation', id, name };
};
const automationCategory = (ctx) => automationDomain(ctx.after || ctx.before || automationRow(ctx.params.id));

function stopSummary(label) {
  return (ctx) => {
    const b = ctx.resBody || {};
    const bits = [];
    if (b.attempted != null) bits.push(`${b.succeeded ?? 0}/${b.attempted} channels OFF`);
    if (b.timersCancelled != null) bits.push(`${b.timersCancelled} timer(s) cancelled`);
    const failed = Array.isArray(b.failed) ? b.failed.length : 0;
    if (failed) bits.push(`${failed} failure(s)`);
    if (b.inProgress) bits.push('still in progress');
    return `Pressed ${label}${bits.length ? ` — ${bits.join(', ')}` : ''}`;
  };
}

// ---------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------

const ROUTES = [
  // ----- auth -------------------------------------------------------------
  {
    method: 'POST', pattern: '/api/auth/login', actorFromBody: true,
    action: (ctx) => (ctx.ok ? 'auth.login' : 'auth.login_failed'), category: 'auth',
    target: (ctx) => ({ type: 'user', id: ctx.actorUserId || null, name: ctx.body && ctx.body.email ? String(ctx.body.email) : null }),
    summary: (ctx) => {
      const email = ctx.body && ctx.body.email ? String(ctx.body.email) : 'unknown email';
      if (ctx.ok) return `Logged in as ${email}`;
      if (ctx.status === 401) return `Failed login for ${email} (wrong email or password)`;
      return `Failed login for ${email}`;
    },
    severityFn: (ctx) => (ctx.ok ? 'info' : 'warning'),
    noResultSuffix: true,
  },
  { method: 'POST', pattern: '/api/auth/logout', preResolveActor: true, action: 'auth.logout', category: 'auth', summary: (ctx) => `Logged out${ctx.actorEmail ? ` ${ctx.actorEmail}` : ''}` },
  { method: 'POST', pattern: '/api/auth/change-password', preResolveActor: true, action: 'auth.password_change', category: 'auth', tags: ['users'], summary: () => 'Changed own password', severity: 'warning' },
  simple('POST', '/api/auth/setup/network', 'system.setup_network', 'system', 'Setup wizard: saved network settings', { tags: ['settings'] }),
  simple('POST', '/api/auth/setup/timezone', 'system.setup_timezone', 'system', (ctx) => `Setup wizard: timezone ${ctx.body && ctx.body.timezone ? ctx.body.timezone : ''}`.trim(), { tags: ['settings'] }),
  simple('POST', '/api/auth/setup/quick', 'system.setup', 'system', (ctx) => `Setup wizard: created admin ${ctx.body && ctx.body.email ? ctx.body.email : ''}`.trim(), { tags: ['users'] }),
  simple('POST', '/api/auth/setup', 'system.setup', 'system', (ctx) => `Setup wizard: created admin ${ctx.body && ctx.body.email ? ctx.body.email : ''}`.trim(), { tags: ['users'] }),

  // ----- users ------------------------------------------------------------
  {
    method: 'PUT', pattern: '/api/users/me/preferences', action: 'user.preferences', category: 'users',
    target: (ctx) => ({ type: 'user', id: ctx.user && ctx.user.id, name: ctx.user && ctx.user.email }),
    summary: () => 'Changed own display preferences',
  },
  {
    method: 'POST', pattern: '/api/users', action: 'user.create', category: 'users', severity: 'warning',
    after: (ctx) => (ctx.body && ctx.body.email ? snap.userByEmail(ctx.body.email) : null),
    target: (ctx) => ({ type: 'user', id: ctx.after && ctx.after.id, name: (ctx.after && ctx.after.email) || (ctx.body && ctx.body.email) }),
    summary: (ctx) => `Created user ${(ctx.body && ctx.body.email) || ''} (${(ctx.after && ctx.after.role) || (ctx.body && ctx.body.role) || 'viewer'})`,
  },
  {
    method: 'PUT', pattern: '/api/users/:id', action: 'user.update', category: 'users', severity: 'warning',
    before: (ctx) => snap.user(ctx.params.id), after: true,
    target: (ctx) => ({ type: 'user', id: ctx.params.id, name: (ctx.after && ctx.after.email) || (ctx.before && ctx.before.email) }),
    summary: (ctx) => {
      const who = (ctx.after && ctx.after.email) || (ctx.before && ctx.before.email) || `#${ctx.params.id}`;
      const parts = [];
      if (ctx.changes && ctx.changes.length) parts.push(ctx.changesText);
      if (ctx.body && ctx.body.password) parts.push('password reset');
      return `Edited user ${who}${parts.length ? `: ${parts.join('; ')}` : ''}`;
    },
  },
  {
    method: 'DELETE', pattern: '/api/users/:id', action: 'user.delete', category: 'users', severity: 'warning',
    before: (ctx) => snap.user(ctx.params.id),
    target: (ctx) => ({ type: 'user', id: ctx.params.id, name: ctx.before && ctx.before.email }),
    summary: (ctx) => `Deleted user ${(ctx.before && ctx.before.email) || `#${ctx.params.id}`}`,
  },

  // ----- automations ------------------------------------------------------
  { method: 'POST', pattern: '/api/automations/stop-all', action: 'stop_all', category: 'system', tags: ['irrigation', 'climate', 'dosing'], severity: 'warning', target: () => ({ type: 'system', id: 'all_relays', name: 'All relay channels' }), summary: stopSummary('Stop All') },
  {
    method: 'POST', pattern: '/api/automations/emergency-stop', action: 'emergency_stop', category: 'system', tags: ['irrigation', 'climate', 'dosing', 'automations'], severity: 'warning',
    target: () => ({ type: 'system', id: 'all_relays', name: 'All relay channels + automations' }),
    summary: (ctx) => {
      const base = stopSummary('EMERGENCY STOP')(ctx);
      const st = (ctx.resBody && ctx.resBody.armedState) || null;
      const until = st && st.autoReArmAt ? `disarmed until ${st.autoReArmAt}` : 'automations disarmed until re-armed';
      const reason = ctx.body && ctx.body.reason ? ` (reason: ${String(ctx.body.reason).slice(0, 80)})` : '';
      return `${base}; ${until}${reason}`;
    },
  },
  { method: 'POST', pattern: '/api/automations/re-arm', action: 'rearm', category: 'system', tags: ['automations'], severity: 'warning', target: () => ({ type: 'system', id: 'automations', name: 'Automation arming' }), summary: () => 'Re-armed automations after an emergency stop' },
  {
    method: 'POST', pattern: '/api/automations', action: 'automation.create', tags: ['automations'],
    category: (ctx) => automationDomain(ctx.after),
    after: (ctx) => (ctx.resBody && ctx.resBody.id != null ? snap.automation(ctx.resBody.id) : null),
    target: (ctx) => ({ type: 'automation', id: ctx.after && ctx.after.id, name: (ctx.after && ctx.after.name) || (ctx.body && ctx.body.name) }),
    summary: (ctx) => `Created automation ${quote((ctx.after && ctx.after.name) || (ctx.body && ctx.body.name))}${ctx.after && !ctx.after.enabled ? ' (disabled)' : ''}`,
  },
  {
    method: 'PUT', pattern: '/api/automations/:id', action: 'automation.update', category: automationCategory, tags: ['automations'],
    before: (ctx) => snap.automation(ctx.params.id), after: true, target: automationTarget,
    summary: editSummary('automation'),
  },
  {
    method: 'DELETE', pattern: '/api/automations/:id', action: 'automation.delete', category: automationCategory, tags: ['automations'], severity: 'warning',
    before: (ctx) => snap.automation(ctx.params.id), target: automationTarget,
    summary: (ctx) => `Deleted automation ${quote(snapName(ctx)) || `#${ctx.params.id}`}`,
  },
  { method: 'POST', pattern: '/api/automations/:id/test', action: 'automation.test', category: automationCategory, tags: ['automations'], before: (ctx) => snap.automation(ctx.params.id), keepSnapshots: false, target: automationTarget, summary: (ctx) => `Dry-run tested automation ${quote(snapName(ctx))}` },
  {
    method: 'POST', pattern: '/api/automations/:id/toggle', action: 'automation.toggle', category: automationCategory, tags: ['automations'],
    before: (ctx) => snap.automation(ctx.params.id), after: true, target: automationTarget,
    summary: (ctx) => {
      const en = ctx.after ? ctx.after.enabled : (ctx.before ? !ctx.before.enabled : null);
      return `${en ? 'Enabled' : 'Disabled'} automation ${quote(snapName(ctx))}`;
    },
  },
  {
    method: 'POST', pattern: '/api/automations/:id/duplicate', action: 'automation.duplicate', category: automationCategory, tags: ['automations'],
    before: (ctx) => snap.automation(ctx.params.id), keepSnapshots: false, target: automationTarget,
    summary: (ctx) => `Duplicated automation ${quote(snapName(ctx))}${ctx.resBody && ctx.resBody.automation ? ` as ${quote(ctx.resBody.automation.name)} (disabled)` : ''}`,
  },
  {
    method: 'POST', pattern: '/api/automations/:id/trigger', action: 'automation.trigger', category: automationCategory, tags: ['automations'],
    before: (ctx) => snap.automation(ctx.params.id), keepSnapshots: false, target: automationTarget,
    summary: (ctx) => {
      const n = ctx.resBody && Array.isArray(ctx.resBody.executed_actions) ? ctx.resBody.executed_actions.length : null;
      return `Ran automation ${quote(snapName(ctx))} by hand${n != null ? ` (${n} action${n === 1 ? '' : 's'})` : ''}`;
    },
  },

  // ----- automation templates --------------------------------------------
  ...crud('automation-templates', { noun: 'automation template', table: 'automation_templates', category: 'automations', actionPrefix: 'automation_template', json: ['conditions', 'actions', 'parameters', 'instantiation_trigger', 'target_effects'] }),

  // ----- equipment --------------------------------------------------------
  simple('POST', '/api/equipment/scan-slaves/create-bulk', 'equipment.create_bulk', 'equipment', (ctx) => `Added ${Array.isArray(ctx.body && ctx.body.devices) ? ctx.body.devices.length : 'several'} scanned device(s)`),
  simple('POST', '/api/equipment/scan-slaves', 'equipment.scan_slaves', 'equipment', (ctx) => `Scanned Modbus slaves on ${(ctx.body && ctx.body.host) || 'a gateway'}${ctx.body && ctx.body.startSlaveId != null ? ` (ids ${ctx.body.startSlaveId}-${ctx.body.endSlaveId})` : ''}`),
  simple('POST', '/api/equipment/scan', 'equipment.scan', 'equipment', 'Scanned the network for equipment'),
  {
    method: 'POST', pattern: '/api/equipment/:id/relay/control', action: 'relay.control', tags: ['equipment'],
    category: (ctx) => equipmentDomain(ctx.params.id, ctx.body && ctx.body.channel),
    target: (ctx) => ({ type: 'equipment', id: ctx.params.id, name: equipmentChannelName(ctx.params.id, ctx.body && ctx.body.channel), channel: ctx.body && ctx.body.channel }),
    summary: (ctx) => {
      const on = !!(ctx.body && ctx.body.state);
      const name = equipmentChannelName(ctx.params.id, ctx.body && ctx.body.channel);
      let rb = '';
      if (ctx.ok && ctx.resBody) {
        if (ctx.resBody.confirmed === true) rb = ' (read-back confirmed)';
        else if (ctx.resBody.confirmed === false) rb = ' (read-back did NOT confirm)';
        else rb = ' (no read-back)';
        if (ctx.resBody.duration_seconds) rb += `, auto-off after ${fmtSeconds(ctx.resBody.duration_seconds)}`;
      }
      return `Switched ${on ? 'ON' : 'OFF'} ${name}${rb}`;
    },
    severityFn: (ctx) => (ctx.ok && ctx.resBody && ctx.resBody.confirmed === false ? 'warning' : 'info'),
  },
  {
    method: 'POST', pattern: '/api/equipment/:id/relay/all', action: 'relay.all', tags: ['equipment'],
    category: (ctx) => equipmentDomain(ctx.params.id), severity: 'warning',
    target: (ctx) => ({ type: 'equipment', id: ctx.params.id, name: (equipmentRow(ctx.params.id) || {}).name || `equipment ${ctx.params.id}` }),
    summary: (ctx) => {
      const on = !!(ctx.body && ctx.body.state);
      const eq = equipmentRow(ctx.params.id);
      const n = ctx.resBody && ctx.resBody.channels;
      return `Switched ALL${n ? ` ${n}` : ''} channels ${on ? 'ON' : 'OFF'} on ${(eq && eq.name) || `equipment ${ctx.params.id}`}${ctx.ok && ctx.resBody && ctx.resBody.confirmed === false ? ' (read-back did NOT confirm)' : ''}`;
    },
  },
  {
    method: 'PATCH', pattern: '/api/equipment/:id/channels/labels', action: 'equipment.labels', category: 'equipment',
    before: (ctx) => snap.equipment(ctx.params.id), after: true,
    target: (ctx) => ({ type: 'equipment', id: ctx.params.id, name: snapName(ctx) }),
    summary: editSummary('channel labels of', snapName),
  },
  {
    method: 'PATCH', pattern: '/api/equipment/:id/channels/toggle', action: 'equipment.channels_toggle', category: 'equipment',
    before: (ctx) => snap.equipment(ctx.params.id), after: true,
    target: (ctx) => ({ type: 'equipment', id: ctx.params.id, name: snapName(ctx) }),
    summary: editSummary('enabled readings of', snapName),
  },
  {
    method: 'PUT', pattern: '/api/equipment/:id/errors/:errorId/resolve', action: 'equipment.error_resolve', category: 'equipment',
    target: (ctx) => ({ type: 'equipment', id: ctx.params.id, name: nameOf('equipment', 'name', ctx.params.id) }),
    summary: (ctx) => `Resolved error #${ctx.params.errorId} on ${nameOf('equipment', 'name', ctx.params.id) || `equipment ${ctx.params.id}`}`,
  },
  {
    method: 'POST', pattern: '/api/equipment/:id/errors', action: 'equipment.error_add', category: 'equipment',
    target: (ctx) => ({ type: 'equipment', id: ctx.params.id, name: nameOf('equipment', 'name', ctx.params.id) }),
    summary: (ctx) => `Logged an error on ${nameOf('equipment', 'name', ctx.params.id) || `equipment ${ctx.params.id}`}`,
  },
  {
    method: 'POST', pattern: '/api/equipment/:id/readings', action: 'equipment.reading_add', category: 'equipment',
    target: (ctx) => ({ type: 'equipment', id: ctx.params.id, name: nameOf('equipment', 'name', ctx.params.id) }),
    summary: (ctx) => `Added a reading to ${nameOf('equipment', 'name', ctx.params.id) || `equipment ${ctx.params.id}`}`,
  },
  {
    method: 'POST', pattern: '/api/equipment/:id/test-connection', action: 'equipment.test_connection', category: 'equipment',
    target: (ctx) => ({ type: 'equipment', id: ctx.params.id, name: nameOf('equipment', 'name', ctx.params.id) }),
    summary: (ctx) => `Tested connection to ${nameOf('equipment', 'name', ctx.params.id) || `equipment ${ctx.params.id}`}`,
  },
  {
    method: 'POST', pattern: '/api/equipment/:id/calibrate', action: 'equipment.calibrate', category: 'equipment',
    before: (ctx) => snap.equipment(ctx.params.id), after: true,
    target: (ctx) => ({ type: 'equipment', id: ctx.params.id, name: snapName(ctx) }),
    summary: editSummary('calibration of', snapName),
  },
  {
    method: 'POST', pattern: '/api/equipment/:id/control', action: 'equipment.control', category: (ctx) => equipmentDomain(ctx.params.id), tags: ['equipment'],
    target: (ctx) => ({ type: 'equipment', id: ctx.params.id, name: nameOf('equipment', 'name', ctx.params.id) }),
    summary: (ctx) => `Sent control '${(ctx.body && ctx.body.action) || '?'}' to ${nameOf('equipment', 'name', ctx.params.id) || `equipment ${ctx.params.id}`}`,
  },
  ...crud('equipment', { noun: 'equipment', table: 'equipment', category: 'equipment', actionPrefix: 'equipment', snapFn: snap.equipment }),

  // ----- zones ------------------------------------------------------------
  {
    method: 'POST', pattern: '/api/zones/:id/equipment', action: 'zone.equipment_add', category: 'equipment',
    before: (ctx) => snap.zone(ctx.params.id), after: true,
    target: (ctx) => ({ type: 'zone', id: ctx.params.id, name: snapName(ctx) }),
    summary: (ctx) => `Assigned ${nameOf('equipment', 'name', ctx.body && ctx.body.equipment_id) || 'equipment'} to zone ${quote(snapName(ctx))}`,
  },
  {
    method: 'DELETE', pattern: '/api/zones/:id/equipment/:equipmentId', action: 'zone.equipment_remove', category: 'equipment',
    before: (ctx) => snap.zone(ctx.params.id), after: true,
    target: (ctx) => ({ type: 'zone', id: ctx.params.id, name: snapName(ctx) }),
    summary: (ctx) => `Removed ${nameOf('equipment', 'name', ctx.params.equipmentId) || `equipment ${ctx.params.equipmentId}`} from zone ${quote(snapName(ctx))}`,
  },
  ...crud('zones', { noun: 'zone', table: 'zones', category: 'equipment', actionPrefix: 'zone', snapFn: snap.zone }),

  // ----- device templates -------------------------------------------------
  ...crud('templates', { noun: 'device template', table: 'device_templates', category: 'equipment', actionPrefix: 'device_template', update: false, json: ['register_mappings'] }),

  // ----- alerts -----------------------------------------------------------
  {
    method: 'POST', pattern: '/api/alerts/acknowledge-all', action: 'alert.acknowledge_all', category: 'alerts',
    target: () => ({ type: 'alert', id: 'all', name: 'All open alerts' }),
    summary: (ctx) => {
      const n = ctx.resBody && (ctx.resBody.count ?? ctx.resBody.acknowledged ?? ctx.resBody.changes);
      return `Acknowledged all open alerts${n != null ? ` (${n})` : ''}`;
    },
  },
  {
    method: 'POST', pattern: '/api/alerts/:id/acknowledge', action: 'alert.acknowledge', category: 'alerts',
    before: (ctx) => q1('SELECT id, severity, message, source, equipment_id, automation_id, acknowledged FROM alerts WHERE id = ?', idOf(ctx.params.id)),
    keepSnapshots: false,
    target: (ctx) => ({ type: 'alert', id: ctx.params.id, name: ctx.before && ctx.before.message ? String(ctx.before.message).slice(0, 140) : null }),
    summary: (ctx) => `Acknowledged ${ctx.before ? `${ctx.before.severity} ` : ''}alert${ctx.before && ctx.before.message ? `: ${String(ctx.before.message).slice(0, 120)}` : ` #${ctx.params.id}`}`,
  },

  // ----- settings / system ------------------------------------------------
  {
    method: 'PUT', pattern: '/api/settings', action: 'settings.update', category: 'settings',
    before: (ctx) => snap.settings(Object.keys(ctx.body || {}).slice(0, 50)), after: true,
    target: (ctx) => ({ type: 'setting', id: Object.keys(ctx.body || {}).slice(0, 10).join(','), name: Object.keys(ctx.body || {}).slice(0, 6).join(', ') }),
    summary: (ctx) => {
      const keys = Object.keys(ctx.body || {});
      if (ctx.changes && ctx.changes.length) return `Changed settings: ${ctx.changesText}`;
      return `Saved settings ${keys.slice(0, 6).join(', ')}${keys.length > 6 ? ` (+${keys.length - 6})` : ''}${ctx.ok && ctx.diff && !ctx.diff.length ? ' (no value changed)' : ''}`;
    },
  },
  simple('POST', '/api/settings/restore', 'system.restore', 'system', (ctx) => `Restored the database from an uploaded backup${ctx.contentLength ? ` (${Math.round(ctx.contentLength / 1048576)} MB)` : ''}`, { severity: 'warning', tags: ['settings'] }),
  simple('POST', '/api/settings/factory-reset', 'system.factory_reset', 'system', 'Requested a FACTORY RESET', { severity: 'warning', tags: ['settings'] }),
  simple('DELETE', '/api/system/clear/:target', 'system.clear_data', 'system', (ctx) => `Cleared stored data: ${ctx.params.target}${ctx.query && ctx.query.before ? ` older than ${ctx.query.before}` : ''}`, { severity: 'warning', target: (ctx) => ({ type: 'data', id: ctx.params.target, name: ctx.params.target }) }),
  settingsDef('PUT', '/api/retention/config', 'settings.retention', 'system', ['data_retention_config'], 'data retention'),
  simple('POST', '/api/retention/dry-run', 'system.retention_dry_run', 'system', 'Ran a data-retention dry run'),
  simple('POST', '/api/retention/run-now', 'system.retention_run', 'system', 'Ran data retention now (deletes old rows)', { severity: 'warning' }),
  settingsDef('PUT', '/api/notifications/telegram', 'settings.telegram', 'settings', ['telegram_bot_token', 'telegram_chat_id', 'telegram_enabled'], 'Telegram notifications'),
  simple('POST', '/api/notifications/telegram/test', 'notification.test', 'settings', 'Sent a Telegram test message'),
  settingsDef('PUT', '/api/relay-events/safety-config', 'settings.relay_safety', 'equipment', ['relay_safety_config'], 'relay safety limits'),
  simple('POST', '/api/relay-events/safety-check', 'relay.safety_check', 'equipment', 'Ran the relay safety check now'),

  // ----- cloud ------------------------------------------------------------
  simple('POST', '/api/cloud/test', 'cloud.test', 'system', 'Tested the cloud connection'),
  settingsDef('POST', '/api/cloud/connect', 'cloud.connect', 'system', ['cloud_config'], 'cloud connection'),
  settingsDef('POST', '/api/cloud/disconnect', 'cloud.disconnect', 'system', ['cloud_config'], 'cloud connection (disconnect)'),
  simple('POST', '/api/cloud/sync', 'cloud.sync', 'system', 'Started a cloud sync'),
  simple('POST', '/api/cloud/suggested-programs/simulate', 'cloud.program_simulate', 'automations', 'Simulated a cloud-suggested program'),
  simple('POST', '/api/cloud/suggested-programs/:id/approve', 'cloud.program_approve', 'automations', (ctx) => `Approved cloud-suggested program #${ctx.params.id}`, { severity: 'warning' }),
  simple('POST', '/api/cloud/suggested-programs/:id/reject', 'cloud.program_reject', 'automations', (ctx) => `Rejected cloud-suggested program #${ctx.params.id}`),

  // ----- modbus (direct bus access) --------------------------------------
  simple('POST', '/api/modbus/read/:kind', 'modbus.read', 'equipment', (ctx) => `Read Modbus ${ctx.params.kind} @${(ctx.body && ctx.body.host) || '?'} unit ${(ctx.body && (ctx.body.unitId ?? ctx.body.slaveId)) ?? '?'} addr ${(ctx.body && ctx.body.address) ?? '?'}`),
  simple('POST', '/api/modbus/write/:kind', 'modbus.write', 'equipment', (ctx) => `Wrote Modbus ${ctx.params.kind} @${(ctx.body && ctx.body.host) || '?'} unit ${(ctx.body && (ctx.body.unitId ?? ctx.body.slaveId)) ?? '?'} addr ${(ctx.body && ctx.body.address) ?? '?'} = ${JSON.stringify(ctx.body && (ctx.body.value ?? ctx.body.values))}`, { severity: 'warning' }),
  simple('POST', '/api/modbus/connection/disconnect', 'modbus.disconnect', 'system', 'Disconnected the Modbus client'),
  simple('POST', '/api/modbus/polling/device/:id/poll', 'modbus.poll_device', 'equipment', (ctx) => `Polled ${nameOf('equipment', 'name', ctx.params.id) || `equipment ${ctx.params.id}`} now`),
  simple('POST', '/api/modbus/polling/:cmd', 'modbus.polling', 'system', (ctx) => `Modbus polling: ${ctx.params.cmd}`, { severityFn: (ctx) => (['stop', 'pause'].includes(ctx.params.cmd) ? 'warning' : 'info') }),

  // ----- cameras ----------------------------------------------------------
  { method: 'POST', pattern: '/api/cameras/:id/ptz/stop', skip: true },
  simple('POST', '/api/cameras/:id/ptz/move', 'camera.ptz_move', 'cameras', (ctx) => `Moved camera ${quote(nameOf('cameras', 'name', ctx.params.id)) || `#${ctx.params.id}`} (PTZ)`, { coalesceSeconds: 120, target: (ctx) => ({ type: 'camera', id: ctx.params.id, name: nameOf('cameras', 'name', ctx.params.id) }) }),
  simple('POST', '/api/cameras/:id/ptz/presets/:pid/goto', 'camera.ptz_preset_goto', 'cameras', (ctx) => `Sent camera ${quote(nameOf('cameras', 'name', ctx.params.id))} to preset ${ctx.params.pid}`, { target: (ctx) => ({ type: 'camera', id: ctx.params.id, name: nameOf('cameras', 'name', ctx.params.id) }) }),
  simple('PUT', '/api/cameras/:id/ptz/presets/:pid', 'camera.ptz_preset_save', 'cameras', (ctx) => `Saved PTZ preset ${ctx.params.pid} on camera ${quote(nameOf('cameras', 'name', ctx.params.id))}`, { target: (ctx) => ({ type: 'camera', id: ctx.params.id, name: nameOf('cameras', 'name', ctx.params.id) }) }),
  simple('DELETE', '/api/cameras/:id/ptz/presets/:pid', 'camera.ptz_preset_delete', 'cameras', (ctx) => `Deleted PTZ preset ${ctx.params.pid} on camera ${quote(nameOf('cameras', 'name', ctx.params.id))}`, { target: (ctx) => ({ type: 'camera', id: ctx.params.id, name: nameOf('cameras', 'name', ctx.params.id) }) }),
  simple('POST', '/api/cameras/:id/test', 'camera.test', 'cameras', (ctx) => `Tested camera ${quote(nameOf('cameras', 'name', ctx.params.id)) || `#${ctx.params.id}`}`, { target: (ctx) => ({ type: 'camera', id: ctx.params.id, name: nameOf('cameras', 'name', ctx.params.id) }) }),
  simple('POST', '/api/cameras/:id/capture', 'camera.capture', 'cameras', (ctx) => `Captured a snapshot from camera ${quote(nameOf('cameras', 'name', ctx.params.id)) || `#${ctx.params.id}`}`, { target: (ctx) => ({ type: 'camera', id: ctx.params.id, name: nameOf('cameras', 'name', ctx.params.id) }) }),
  ...crud('cameras', { noun: 'camera', table: 'cameras', category: 'cameras', actionPrefix: 'camera', snapFn: snap.camera }),

  // ----- lab / AMIC / calibration ----------------------------------------
  ...crud('lab-readings', { noun: 'lab reading', table: 'lab_readings', category: 'lab', actionPrefix: 'lab_reading', nameCol: 'sample_date' }),
  settingsDef('PUT', '/api/amic/channels', 'amic.channels', 'lab', ['amic_channels'], 'AMIC channel labels'),
  settingsDef('PUT', '/api/amic/schedule', 'amic.schedule', 'lab', ['amic_schedule'], 'AMIC calibration schedule'),
  simple('PUT', '/api/amic/pump-times', 'amic.pump_times', 'lab', (ctx) => `Set AMIC pump times${ctx.body && ctx.body.input_seconds != null ? ` in ${ctx.body.input_seconds}s` : ''}${ctx.body && ctx.body.output_seconds != null ? ` out ${ctx.body.output_seconds}s` : ''}`),
  simple('POST', '/api/amic/ph-buffers', 'amic.ph_buffers', 'lab', 'Saved AMIC pH buffer values'),
  simple('POST', '/api/amic/capture-ph/:point', 'amic.capture_ph', 'lab', (ctx) => `Captured AMIC pH calibration point ${ctx.params.point}`),
  simple('POST', '/api/amic/save-to-lab', 'amic.save_to_lab', 'lab', 'Saved an AMIC result as a lab reading'),
  simple('POST', '/api/amic/:cmd', 'amic.command', 'lab', (ctx) => `AMIC analyzer: ${String(ctx.params.cmd).replace(/-/g, ' ')}`),
  {
    method: 'PUT', pattern: '/api/calibration/:equipment_id/:metric/linear', action: 'calibration.update', category: 'equipment', tags: ['lab'],
    before: (ctx) => snap.calibration(ctx.params.equipment_id, ctx.params.metric), after: true,
    target: (ctx) => ({ type: 'equipment', id: ctx.params.equipment_id, name: `${nameOf('equipment', 'name', ctx.params.equipment_id) || `equipment ${ctx.params.equipment_id}`} › ${ctx.params.metric}` }),
    summary: editSummary('calibration of', (ctx) => `${nameOf('equipment', 'name', ctx.params.equipment_id) || ctx.params.equipment_id} ${ctx.params.metric}`),
  },
  simple('POST', '/api/calibration/:equipment_id/:metric/recompute', 'calibration.recompute', 'equipment', (ctx) => `Recomputed calibration of ${nameOf('equipment', 'name', ctx.params.equipment_id) || ctx.params.equipment_id} ${ctx.params.metric}`, { target: (ctx) => ({ type: 'equipment', id: ctx.params.equipment_id, name: nameOf('equipment', 'name', ctx.params.equipment_id) }) }),
  {
    method: 'POST', pattern: '/api/baselines/equipment/:equipmentId', action: 'baseline.create', category: 'equipment',
    target: (ctx) => ({ type: 'equipment', id: ctx.params.equipmentId, name: nameOf('equipment', 'name', ctx.params.equipmentId) }),
    summary: (ctx) => `Recorded a consumption baseline for ${nameOf('equipment', 'name', ctx.params.equipmentId) || `equipment ${ctx.params.equipmentId}`}`,
  },
  simple('DELETE', '/api/baselines/:id', 'baseline.delete', 'equipment', (ctx) => `Deleted consumption baseline #${ctx.params.id}`),

  // ----- fertigation / dosing --------------------------------------------
  ...crud('fertigation/ingredients', { noun: 'fertigation ingredient', table: 'fertigation_ingredients', category: 'dosing', actionPrefix: 'ingredient' }),
  ...crud('fertigation/mixtures', { noun: 'fertigation mixture', table: 'fertigation_mixtures', category: 'dosing', actionPrefix: 'mixture', snapFn: snap.mixture }),
  {
    method: 'PUT', pattern: '/api/fertigation/channels/:equipmentId/:channel', action: 'dosing.channel_config', category: (ctx) => equipmentDomain(ctx.params.equipmentId, ctx.params.channel), tags: ['dosing'],
    before: (ctx) => snap.channelConfig(ctx.params.equipmentId, ctx.params.channel), after: true,
    target: (ctx) => ({ type: 'equipment', id: ctx.params.equipmentId, name: equipmentChannelName(ctx.params.equipmentId, ctx.params.channel), channel: ctx.params.channel }),
    summary: editSummary('channel setup of', (ctx) => equipmentChannelName(ctx.params.equipmentId, ctx.params.channel)),
  },
  {
    method: 'DELETE', pattern: '/api/fertigation/channels/:equipmentId/:channel', action: 'dosing.channel_config_delete', category: 'dosing',
    before: (ctx) => snap.channelConfig(ctx.params.equipmentId, ctx.params.channel),
    target: (ctx) => ({ type: 'equipment', id: ctx.params.equipmentId, name: equipmentChannelName(ctx.params.equipmentId, ctx.params.channel), channel: ctx.params.channel }),
    summary: (ctx) => `Cleared channel setup of ${equipmentChannelName(ctx.params.equipmentId, ctx.params.channel)}`,
  },
  {
    method: 'POST', pattern: '/api/fertigation/tanks/:id/refill', action: 'tank.refill', category: 'dosing',
    before: (ctx) => snap.tank(ctx.params.id), after: true,
    target: (ctx) => ({ type: 'tank', id: ctx.params.id, name: snapName(ctx) }),
    summary: (ctx) => `Refilled tank ${quote(snapName(ctx)) || `#${ctx.params.id}`}${ctx.body && ctx.body.water_liters_added ? ` with ${ctx.body.water_liters_added} L water` : ''}${ctx.body && ctx.body.use_pending_mixture ? ' (adopted pending recipe)' : ''}`,
  },
  {
    method: 'POST', pattern: '/api/fertigation/tanks/:id/apply-pending-mixture', action: 'tank.apply_mixture', category: 'dosing',
    before: (ctx) => snap.tank(ctx.params.id), after: true,
    target: (ctx) => ({ type: 'tank', id: ctx.params.id, name: snapName(ctx) }),
    summary: (ctx) => `Applied the pending recipe to tank ${quote(snapName(ctx)) || `#${ctx.params.id}`}`,
  },
  ...crud('fertigation/tanks', { noun: 'tank', table: 'fertigation_tanks', category: 'dosing', actionPrefix: 'tank', snapFn: snap.tank }),
  {
    method: 'POST', pattern: '/api/fertigation/dose-programs/:id/publish', action: 'dose_program.publish', category: 'dosing', severity: 'warning',
    before: (ctx) => snap.doseProgram(ctx.params.id), after: true,
    target: (ctx) => ({ type: 'dose_program', id: ctx.params.id, name: snapName(ctx) }),
    summary: (ctx) => `Published dose program ${quote(snapName(ctx)) || `#${ctx.params.id}`}`,
  },
  ...crud('fertigation/dose-programs', { noun: 'dose program', table: 'fertigation_dose_programs', category: 'dosing', actionPrefix: 'dose_program', snapFn: snap.doseProgram }),
  ...crud('fertigation/element-targets', { noun: 'element target', table: 'crop_element_targets', category: 'dosing', actionPrefix: 'element_target', update: false, nameCol: 'element' }),
  simple('POST', '/api/fertigation/dose-cycle/preview', 'dose_cycle.preview', 'dosing', 'Previewed a dose cycle'),
  simple('POST', '/api/fertigation/dose-cycle/start', 'dose_cycle.start', 'dosing', (ctx) => `Started a dose cycle by hand${ctx.body && ctx.body.program_id ? ` (program ${quote(nameOf('fertigation_dose_programs', 'name', ctx.body.program_id)) || `#${ctx.body.program_id}`})` : ''}`, { severity: 'warning' }),
  simple('POST', '/api/fertigation/dose-cycle/abort', 'dose_cycle.abort', 'dosing', 'Aborted the running dose cycle', { severity: 'warning' }),
  settingsDef('PUT', '/api/dose-controller/config', 'dose_controller.config', 'dosing', ['dose_controller'], 'dose controller settings'),
  {
    method: 'PUT', pattern: '/api/dose-controller/programs/:id/mode', action: 'dose_program.mode', category: 'dosing',
    before: (ctx) => snap.doseProgram(ctx.params.id), after: true,
    target: (ctx) => ({ type: 'dose_program', id: ctx.params.id, name: snapName(ctx) }),
    summary: (ctx) => `Set dose program ${quote(snapName(ctx)) || `#${ctx.params.id}`} to ${(ctx.body && ctx.body.control_mode) || '?'}`,
  },

  // ----- irrigation -------------------------------------------------------
  settingsDef('PUT', '/api/flow-watch/config', 'flow_watch.config', 'irrigation', ['irrigation_flow_watch'], 'flow watch settings'),
  {
    method: 'POST', pattern: '/api/irrigation/stop', action: 'irrigation.stop', category: 'irrigation', tags: ['dosing'], severity: 'warning',
    target: () => ({ type: 'system', id: 'irrigation', name: 'Irrigation (pumps, zones, dosing)' }),
    summary: (ctx) => {
      const b = ctx.resBody || {};
      const bits = [];
      if (Array.isArray(b.channels)) bits.push(`${b.channels.filter(c => c && c.confirmed).length}/${b.channels.length} channels OFF confirmed`);
      else if (b.attempted != null) bits.push(`${b.succeeded ?? 0}/${b.attempted} channels OFF`);
      if (b.timersCancelled != null) bits.push(`${b.timersCancelled} timer(s) cancelled`);
      if (b.doseAborted || b.dose_aborted) bits.push('dose cycle aborted');
      if (b.inProgress) bits.push('still switching off');
      if (b.ok === false && !b.inProgress) bits.push('NOT all OFF confirmed');
      return `Pressed Stop Irrigation${bits.length ? ` — ${bits.join(', ')}` : ''}`;
    },
    severityFn: (ctx) => (ctx.resBody && ctx.resBody.ok === false ? 'critical' : 'warning'),
  },

  // ----- crops ------------------------------------------------------------
  simple('POST', '/api/crops/configure-block-mapping', 'crop.block_mapping', 'crops', 'Configured the crop block mapping'),
  simple('POST', '/api/crops/set-primary-zone', 'crop.primary_zone', 'crops', 'Set the primary crop zone'),
  {
    method: 'PUT', pattern: '/api/crops/:id/stage', action: 'crop.stage', category: 'crops',
    before: (ctx) => snap.row('crop_assignments', ctx.params.id), after: true,
    target: (ctx) => ({ type: 'crop', id: ctx.params.id, name: (ctx.after && (ctx.after.crop_name || ctx.after.name)) || null }),
    summary: editSummary('crop stage of', (ctx) => (ctx.after && (ctx.after.crop_name || ctx.after.name)) || `crop #${ctx.params.id}`),
  },
  simple('POST', '/api/crops/:id/complete', 'crop.complete', 'crops', (ctx) => `Completed crop #${ctx.params.id}`, { target: (ctx) => ({ type: 'crop', id: ctx.params.id, name: null }) }),
  ...crud('crops', { noun: 'crop', table: 'crop_assignments', category: 'crops', actionPrefix: 'crop', remove: false, nameCol: 'crop_name' }),

  // ----- AI: agronomist / planner / data sources ------------------------
  simple('POST', '/api/agronomist/capture-now', 'agronomist.capture', 'ai', 'Captured canopy images for the agronomist now'),
  simple('POST', '/api/agronomist/retry-now', 'agronomist.retry', 'ai', 'Retried the agronomist report now'),
  settingsDef('PUT', '/api/agronomist/config', 'agronomist.config', 'ai', ['agronomist_config'], 'agronomist settings'),
  simple('POST', '/api/agronomist/generate', 'agronomist.generate', 'ai', 'Generated an agronomist report'),
  simple('POST', '/api/agronomist/weekly-rollup', 'agronomist.weekly_rollup', 'ai', 'Generated the agronomist weekly rollup'),
  simple('DELETE', '/api/agronomist/reports/:id', 'agronomist.report_delete', 'ai', (ctx) => `Deleted agronomist report #${ctx.params.id}`),
  simple('POST', '/api/agronomist/reports/:id/clarifications', 'agronomist.clarification', 'ai', (ctx) => `Answered agronomist clarifications on report #${ctx.params.id}`),
  settingsDef('PUT', '/api/planner/config', 'planner.config', 'ai', ['operational_planner_config'], 'planner settings'),
  simple('POST', '/api/planner/generate', 'planner.generate', 'ai', 'Generated an operational plan'),
  simple('POST', '/api/planner/plans/:id/clarifications/regenerate', 'planner.regenerate', 'ai', (ctx) => `Regenerated plan #${ctx.params.id} with clarifications`),
  simple('POST', '/api/planner/plans/:id/clarifications', 'planner.clarification', 'ai', (ctx) => `Answered planner clarifications on plan #${ctx.params.id}`),
  simple('POST', '/api/planner/plans/:id/confirm', 'planner.confirm', 'ai', (ctx) => `Confirmed operational plan #${ctx.params.id}`, { severity: 'warning', tags: ['automations'] }),
  simple('POST', '/api/planner/plans/:id/reject', 'planner.reject', 'ai', (ctx) => `Rejected operational plan #${ctx.params.id}`),
  simple('DELETE', '/api/planner/plans/:id', 'planner.delete', 'ai', (ctx) => `Deleted operational plan #${ctx.params.id}`),
  settingsDef('PUT', '/api/ai/data-sources', 'ai.data_sources', 'ai', ['ai_data_sources'], 'AI data sources'),

  // ----- operator tasks ---------------------------------------------------
  simple('POST', '/api/operator-tasks/:id/:verb', 'task.update', 'tasks', (ctx) => `${String(ctx.params.verb).replace(/^./, c => c.toUpperCase())} task ${quote(nameOf('operator_tasks', 'title', ctx.params.id)) || `#${ctx.params.id}`}`, { actionFn: (ctx) => `task.${ctx.params.verb}`, target: (ctx) => ({ type: 'task', id: ctx.params.id, name: nameOf('operator_tasks', 'title', ctx.params.id) }) }),
  ...crud('operator-tasks', { noun: 'task', table: 'operator_tasks', category: 'tasks', actionPrefix: 'task', update: false, nameCol: 'title' }),
];

// Mount prefix -> category for requests no def matches.
const PREFIX_CATEGORY = [
  ['/api/auth', 'auth'], ['/api/users', 'users'], ['/api/equipment', 'equipment'], ['/api/zones', 'equipment'],
  ['/api/automation-templates', 'automations'], ['/api/automations', 'automations'], ['/api/alerts', 'alerts'],
  ['/api/cloud', 'system'], ['/api/settings', 'settings'], ['/api/system', 'system'], ['/api/modbus', 'equipment'],
  ['/api/templates', 'equipment'], ['/api/notifications', 'settings'], ['/api/cameras', 'cameras'],
  ['/api/lab-readings', 'lab'], ['/api/fertigation', 'dosing'], ['/api/calibration', 'equipment'],
  ['/api/retention', 'system'], ['/api/crops', 'crops'], ['/api/amic', 'lab'], ['/api/agronomist', 'ai'],
  ['/api/planner', 'ai'], ['/api/ai', 'ai'], ['/api/operator-tasks', 'tasks'], ['/api/baselines', 'equipment'],
  ['/api/relay-events', 'equipment'], ['/api/mqtt', 'irrigation'], ['/api/flow-watch', 'irrigation'],
  ['/api/dose-controller', 'dosing'], ['/api/irrigation', 'irrigation'], ['/api/logs', 'system'],
];

function categoryForPath(path) {
  const hit = PREFIX_CATEGORY.find(([p]) => path === p || path.startsWith(`${p}/`));
  return hit ? hit[1] : 'system';
}

function genericDef(method, path) {
  const cat = categoryForPath(path);
  const verb = { POST: 'Called', PUT: 'Updated', PATCH: 'Updated', DELETE: 'Deleted' }[method] || 'Called';
  return {
    method, pattern: path, generic: true,
    action: `${method.toLowerCase()}.request`, category: cat,
    summary: () => `${verb} ${path}`,
  };
}

// ---------------------------------------------------------------------------
// Matcher
// ---------------------------------------------------------------------------

function compile(pattern) {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/[.+*?^${}()|[\]\\]/g, '\\$&').replace(/\/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; })}/?$`);
  return { re, keys };
}

const COMPILED = ROUTES.map(def => ({ def, ...compile(def.pattern) }));

/** First def (in list order) whose method + pattern match; null when none. */
function matchRoute(method, path) {
  for (const c of COMPILED) {
    if (c.def.method !== method) continue;
    const m = c.re.exec(path);
    if (!m) continue;
    const params = {};
    c.keys.forEach((k, i) => { try { params[k] = decodeURIComponent(m[i + 1]); } catch (_) { params[k] = m[i + 1]; } });
    return { def: c.def, params };
  }
  return null;
}

/**
 * Legacy request_log rows only carry the router-relative path ("/32/trigger").
 * Returns the defs that could have produced it (for the pre-audit history view).
 */
function matchLegacyPath(method, relPath) {
  const out = [];
  for (const c of COMPILED) {
    if (c.def.method !== method || c.def.skip) continue;
    // Strip the mount prefix ("/api/automations") from the pattern and test the rest.
    const mount = PREFIX_CATEGORY.map(([p]) => p).filter(p => c.def.pattern === p || c.def.pattern.startsWith(`${p}/`)).sort((a, b) => b.length - a.length)[0];
    if (!mount) continue;
    const rest = c.def.pattern.slice(mount.length) || '/';
    const { re, keys } = compile(rest);
    const m = re.exec(relPath);
    if (!m) continue;
    const params = {};
    keys.forEach((k, i) => { params[k] = m[i + 1]; });
    const staticSegs = rest.split('/').filter(seg => seg && !seg.startsWith(':')).length;
    out.push({ def: c.def, params, mount, staticSegs });
  }
  // Most specific wins: '/stop-all' beats '/:cmd', '/32/trigger' beats '/:id/:verb'.
  const best = out.reduce((m, x) => Math.max(m, x.staticSegs), 0);
  return out.filter(x => x.staticSegs === best);
}

module.exports = {
  ROUTES,
  matchRoute,
  matchLegacyPath,
  genericDef,
  categoryForPath,
  equipmentRow,
  channelLabel,
  equipmentChannelName,
  equipmentDomain,
  automationDomain,
  classifyChannelText,
  classifyAutomationText,
  snap,
};
