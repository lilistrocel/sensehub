#!/usr/bin/env node
/**
 * soft-switch-sequences — rebuild the daily fertigation runs (automations 95-101)
 * as "soft-switch" zone sequences, so zone valves never switch under pressure and
 * the pumps never start or run against a closed line (operator requirement
 * 2026-09-26, after Zone 4's valve stuck when switched on mid-run at 09:40 and
 * 15:37 while the pumps dead-headed for 2-3 min).
 *
 * Per zone i (channels 3..6, in their current order), with D = the zone's current
 * duration:
 *   t0_i            zone valve ON                 (pumps OFF: no pressure)
 *   t0_i + lead     Irrigation Pump ch1 + Mixing Pump ch2 ON for D
 *   t0_i + lead + D pumps OFF (auto-off)
 *   ... + lag       zone valve OFF (auto-off: duration D + lead + lag)
 *   ... + gap       next zone's valve ON:  t0_{i+1} = t0_i + D + lead + lag + gap
 * Defaults: --pump-lead-s 3, --valve-lag-s 5, --gap-s 1.
 *
 * The pumps get one control action per zone (several delayed ON windows for the
 * same channel in one automation) — AutomationExecutor keys delayed starts per
 * action for that. No `dependencies` on these actions.
 *
 * Usage (dry run is the default — prints the new actions JSON + a timeline):
 *   node scripts/soft-switch-sequences.js                     # reads backend/data/sensehub.db (read-only) or $DB_PATH
 *   node scripts/soft-switch-sequences.js --db /path/to.db
 *   node scripts/soft-switch-sequences.js --api               # GET the automations from $SENSEHUB_API instead
 *   node scripts/soft-switch-sequences.js --ids 97            # subset
 *   node scripts/soft-switch-sequences.js --json              # JSON only (one object: {id: actions})
 *   node scripts/soft-switch-sequences.js --apply             # PUT /api/automations/:id (admin login via
 *                                                             #   $SENSEHUB_EMAIL / $SENSEHUB_PASSWORD, $SENSEHUB_API
 *                                                             #   default http://localhost:3003). Writes live config!
 */

'use strict';

const path = require('path');

const DEFAULTS = Object.freeze({ pumpLeadS: 3, valveLagS: 5, gapS: 1 });
const DEFAULT_IDS = [95, 96, 97, 98, 99, 100, 101];
const IRRIGATION_EQ = 1;
const PUMP_CH = 1;
const MIXING_CH = 2;
const ZONE_CHANNELS = [3, 4, 5, 6];

const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

/**
 * Zones of an existing run: the irrigation board's zone-channel ON actions with a
 * positive duration, in start order. Returns [{ channel, delay, duration, action }].
 */
function extractZones(actions, { equipmentId = IRRIGATION_EQ, zoneChannels = ZONE_CHANNELS } = {}) {
  const zones = [];
  (Array.isArray(actions) ? actions : []).forEach((a, index) => {
    if (!a || a.type !== 'control' || (a.action || 'on') !== 'on') return;
    if (num(a.equipment_id) !== equipmentId) return;
    const ch = parseInt(a.channel, 10);
    const dur = num(a.duration_seconds);
    if (!zoneChannels.includes(ch) || !(dur > 0)) return;
    zones.push({ channel: ch, delay: num(a.delay_seconds) > 0 ? num(a.delay_seconds) : 0, duration: dur, action: a, index });
  });
  zones.sort((x, y) => x.delay - y.delay || x.index - y.index);
  return zones;
}

/** Fields of an existing action worth carrying over (names, flags) — never timing, never dependencies. */
function carryFields(a) {
  const out = {};
  if (!a || typeof a !== 'object') return out;
  for (const [k, v] of Object.entries(a)) {
    if (['type', 'action', 'equipment_id', 'channel', 'delay_seconds', 'duration_seconds', 'dependencies',
      'stagger_delay_seconds', 'transitions'].includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Build the soft-switch actions for one automation. Pure.
 *
 * @param {Array} actions   the automation's current actions
 * @param {object} [opts]
 * @param {number} [opts.pumpLeadS] valve ON -> pumps ON
 * @param {number} [opts.valveLagS] pumps OFF -> valve OFF
 * @param {number} [opts.gapS]      valve OFF -> next valve ON
 * @param {object} [opts.names]     { equipmentName, channels: {ch: name} } (optional labels)
 * @returns {{ actions: Array, timeline: Array, totalS: number, zones: Array }}
 */
function buildSoftSwitchActions(actions, opts = {}) {
  const lead = opts.pumpLeadS ?? DEFAULTS.pumpLeadS;
  const lag = opts.valveLagS ?? DEFAULTS.valveLagS;
  const gap = opts.gapS ?? DEFAULTS.gapS;
  for (const [k, v] of Object.entries({ pumpLeadS: lead, valveLagS: lag, gapS: gap })) {
    if (!Number.isFinite(v) || v < 0 || v > 120) throw new Error(`${k} must be 0-120 s (got ${v})`);
  }
  const zones = extractZones(actions);
  if (zones.length === 0) throw new Error('no zone actions (irrigation eq 1, ch 3-6, with a duration) found');
  const names = opts.names || {};
  const byChannel = new Map();
  for (const a of Array.isArray(actions) ? actions : []) {
    if (a && a.type === 'control' && num(a.equipment_id) === IRRIGATION_EQ && a.channel != null) {
      const ch = parseInt(a.channel, 10);
      if (!byChannel.has(ch)) byChannel.set(ch, a);
    }
  }
  const make = (channel, delay, duration) => {
    const src = byChannel.get(channel);
    const action = { type: 'control', action: 'on', equipment_id: IRRIGATION_EQ, channel, ...carryFields(src) };
    if (names.equipmentName && action.equipment_name === undefined) action.equipment_name = names.equipmentName;
    const chName = names.channels && names.channels[channel];
    if (chName && action.channel_name === undefined) action.channel_name = chName;
    action.delay_seconds = delay;
    action.duration_seconds = duration;
    return action;
  };

  const out = [];
  const timeline = [];
  let t0 = 0;
  zones.forEach((z, i) => {
    const D = z.duration;
    const valveOff = t0 + lead + D + lag;
    out.push(make(z.channel, t0, D + lead + lag));
    out.push(make(PUMP_CH, t0 + lead, D));
    out.push(make(MIXING_CH, t0 + lead, D));
    timeline.push({
      zone: i + 1, channel: z.channel, name: (names.channels && names.channels[z.channel]) || `Zone relay ${z.channel}`,
      valveOn: t0, valveOff, pumpsOn: t0 + lead, pumpsOff: t0 + lead + D, pumpingS: D,
    });
    t0 = valveOff + gap;
  });
  const totalS = timeline[timeline.length - 1].valveOff;
  return { actions: out, timeline, totalS, zones: zones.map(z => ({ channel: z.channel, duration: z.duration })) };
}

const pad2 = (n) => String(n).padStart(2, '0');
function mmss(s) {
  const t = Math.round(s);
  return `${Math.floor(t / 60)}:${pad2(t % 60)}`;
}

function formatTimeline(timeline, totalS) {
  const w = Math.max(6, ...timeline.map(r => `${r.zone} ${r.name}`.length)) + 2;
  const lines = [`  ${'zone'.padEnd(w)}${'valve on→off'.padEnd(17)}${'pumps on→off'.padEnd(17)}pumping`];
  for (const r of timeline) {
    lines.push(`  ${`${r.zone} ${r.name}`.padEnd(w)}${`${mmss(r.valveOn)}→${mmss(r.valveOff)}`.padEnd(17)}${`${mmss(r.pumpsOn)}→${mmss(r.pumpsOff)}`.padEnd(17)}${r.pumpingS} s`);
  }
  lines.push(`  total run ${mmss(totalS)} (${totalS} s)`);
  return lines.join('\n');
}

// ─── I/O (not used by tests) ─────────────────────────────────────────────────

function parseArgs(argv) {
  const opt = (name, dflt = null) => { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] ?? true) : dflt; };
  const has = (name) => argv.includes(name);
  const idsArg = opt('--ids');
  return {
    db: opt('--db'),
    api: has('--api'),
    apply: has('--apply'),
    json: has('--json'),
    ids: idsArg ? String(idsArg).split(',').map(s => parseInt(s, 10)).filter(Number.isInteger) : DEFAULT_IDS,
    pumpLeadS: Number(opt('--pump-lead-s', DEFAULTS.pumpLeadS)),
    valveLagS: Number(opt('--valve-lag-s', DEFAULTS.valveLagS)),
    gapS: Number(opt('--gap-s', DEFAULTS.gapS)),
  };
}

function parseMaybe(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch (_) { return fallback; }
}

function namesFromEquipment(eq) {
  if (!eq) return {};
  const channels = {};
  for (const m of parseMaybe(eq.register_mappings, []) || []) {
    const ch = parseInt(m.register ?? m.address, 10);
    if (Number.isInteger(ch) && m.name) channels[ch] = m.name;
  }
  return { equipmentName: eq.name, channels };
}

function loadFromDb(dbPath, ids) {
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const autos = ids.map(id => db.prepare('SELECT id, name, actions FROM automations WHERE id = ?').get(id)).filter(Boolean);
    const eq = db.prepare('SELECT id, name, register_mappings FROM equipment WHERE id = ?').get(IRRIGATION_EQ);
    return { autos, names: namesFromEquipment(eq) };
  } finally {
    db.close();
  }
}

async function login(base) {
  const email = process.env.SENSEHUB_EMAIL;
  const password = process.env.SENSEHUB_PASSWORD;
  if (!email || !password) throw new Error('set SENSEHUB_EMAIL and SENSEHUB_PASSWORD');
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!r.ok) throw new Error(`login failed: HTTP ${r.status}`);
  const body = await r.json();
  if (!body.token) throw new Error('login returned no token');
  return body.token;
}

async function loadFromApi(base, token, ids) {
  const get = async (p) => {
    const r = await fetch(`${base}${p}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`GET ${p}: HTTP ${r.status}`);
    return r.json();
  };
  const autos = [];
  for (const id of ids) autos.push(await get(`/api/automations/${id}`));
  let names = {};
  try { names = namesFromEquipment(await get(`/api/equipment/${IRRIGATION_EQ}`)); } catch (_) { /* labels optional */ }
  return { autos, names };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = (process.env.SENSEHUB_API || 'http://localhost:3003').replace(/\/$/, '');
  let token = null;
  let loaded;
  if (args.api || args.apply) {
    token = await login(base);
    loaded = await loadFromApi(base, token, args.ids);
  } else {
    const dbPath = path.resolve(args.db || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'sensehub.db'));
    loaded = loadFromDb(dbPath, args.ids);
  }
  const results = {};
  for (const a of loaded.autos) {
    const built = buildSoftSwitchActions(parseMaybe(a.actions, []), { ...args, names: loaded.names });
    results[a.id] = built;
    if (!args.json) {
      console.log(`\n#${a.id} ${a.name}`);
      console.log(`  zones: ${built.zones.map(z => `ch${z.channel} ${z.duration} s`).join(', ')}; lead ${args.pumpLeadS} s, lag ${args.valveLagS} s, gap ${args.gapS} s`);
      console.log(formatTimeline(built.timeline, built.totalS));
      console.log('  actions:');
      console.log(JSON.stringify(built.actions, null, 2).replace(/^/gm, '    '));
    }
  }
  if (args.json) console.log(JSON.stringify(Object.fromEntries(Object.entries(results).map(([id, r]) => [id, r.actions])), null, 2));

  if (!args.apply) {
    if (!args.json) console.log('\nDry run — nothing written. Re-run with --apply to PUT these actions (admin login).');
    return;
  }
  for (const [id, r] of Object.entries(results)) {
    const resp = await fetch(`${base}/api/automations/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ actions: r.actions }),
    });
    const text = await resp.text();
    if (!resp.ok) { console.error(`PUT /api/automations/${id}: HTTP ${resp.status} ${text}`); process.exitCode = 1; continue; }
    let capped = [];
    try { capped = JSON.parse(text).capped || []; } catch (_) { /* ignore */ }
    console.log(`PUT /api/automations/${id}: OK${capped.length ? ` (server capped ${capped.length} field(s)!)` : ''}`);
  }
}

module.exports = { buildSoftSwitchActions, extractZones, formatTimeline, mmss, DEFAULTS, DEFAULT_IDS };

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
