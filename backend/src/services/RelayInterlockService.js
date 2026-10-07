/**
 * RelayInterlockService — hard mutual-exclusion for relay channel pairs.
 *
 * A coil mapping may declare `interlockWith: <register>`. The relation is
 * treated as symmetric even when only one side declares it. Two interlocked
 * channels must NEVER be energised at the same time (e.g. motor OPEN / CLOSE
 * windings on a shade or vent actuator).
 *
 * Enforcement layers (all of them use this module):
 *   1. validateWriteSet()   — reject any write set that would leave both ON
 *   2. prepareEnergise()    — before energising a channel, drive its partner
 *                             OFF (FC05) and READ IT BACK (FC01); refuse to
 *                             energise unless the partner reads OFF
 *   3. checkHardwareConflict() / resolveHardwareConflict()
 *                           — polled relay states are checked every cycle; if
 *                             both members of a pair are ON in hardware both
 *                             are forced OFF and a critical alert is raised
 *   4. validateAutomationActions()
 *                           — automation save-time validation
 *
 * DB / alert dependencies are required lazily so the pure helpers can be unit
 * tested without opening the SQLite database.
 */

class InterlockViolation extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'InterlockViolation';
    this.code = 'INTERLOCK_VIOLATION';
    this.status = 409;
    this.details = details;
  }
}

const PARTNER_WRITE_OPTIONS = { timeout: 2000, retries: 1 };
const PARTNER_READ_OPTIONS = { timeout: 2000, retries: 1, priority: 'high' }; // part of an ON write: ahead of sensor reads

function parseMappings(row) {
  if (!row) return [];
  const raw = row.register_mappings;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }
  return [];
}

function toRegister(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/** Writable coil mappings with a numeric `register` (all of them, enabled or not). */
function getCoilMappings(row) {
  return parseMappings(row)
    .filter(m => m && m.type === 'coil' && m.access === 'readwrite')
    .map(m => ({ ...m, register: toRegister(m.register ?? m.address) }))
    .filter(m => m.register !== null);
}

function labelFor(row, channel) {
  const m = getCoilMappings(row).find(c => c.register === channel);
  return (m && (m.label || m.name)) || `Coil ${channel}`;
}

/**
 * All interlock pairs on an equipment row as [a, b] with a < b, de-duplicated.
 * A pair is included if EITHER side declares the other.
 */
function getInterlockPairs(row) {
  const coils = getCoilMappings(row);
  const seen = new Set();
  const pairs = [];
  for (const c of coils) {
    const partner = toRegister(c.interlockWith);
    if (partner === null || partner === c.register) continue;
    const a = Math.min(c.register, partner);
    const b = Math.max(c.register, partner);
    const key = `${a}:${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push([a, b]);
  }
  return pairs;
}

function hasInterlockPairs(row) {
  return getInterlockPairs(row).length > 0;
}

/**
 * Partner register of `channel`, or null. Symmetric lookup.
 */
function getPartner(row, channel) {
  const ch = toRegister(channel);
  if (ch === null) return null;
  for (const [a, b] of getInterlockPairs(row)) {
    if (a === ch) return b;
    if (b === ch) return a;
  }
  return null;
}

function normaliseWriteSet(writes) {
  const out = new Map();
  if (Array.isArray(writes)) {
    for (const w of writes) {
      if (!w) continue;
      const ch = toRegister(w.channel ?? w.address ?? w.register);
      if (ch === null) continue;
      out.set(ch, !!w.state);
    }
  } else if (writes && typeof writes === 'object') {
    for (const [k, v] of Object.entries(writes)) {
      const ch = toRegister(k);
      if (ch === null) continue;
      out.set(ch, !!v);
    }
  }
  return out;
}

/**
 * Throws InterlockViolation if the write set would turn ON both members of a
 * pair. `writes` is `{channel: state}` or `[{channel, state}]`.
 * Returns the normalised Map(channel -> state).
 */
function validateWriteSet(row, writes) {
  const set = normaliseWriteSet(writes);
  for (const [a, b] of getInterlockPairs(row)) {
    if (set.get(a) === true && set.get(b) === true) {
      const name = (row && row.name) || `equipment ${row && row.id}`;
      throw new InterlockViolation(
        `Interlock: "${labelFor(row, a)}" (ch ${a}) and "${labelFor(row, b)}" (ch ${b}) on ${name} can never be ON at the same time`,
        { equipment_id: row && row.id, channels: [a, b] }
      );
    }
  }
  return set;
}

function parseHostPort(address) {
  const parts = String(address || '').trim().split(':');
  if (parts.length !== 2) return null;
  const host = parts[0].trim();
  const port = parseInt(parts[1], 10);
  if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

/**
 * Prepare to energise `channel`: if it has an interlock partner, write the
 * partner OFF (FC05) and read it back (FC01). Resolves `{ partner, partnerWasOn }`
 * (partner === null when the channel is not interlocked). Throws
 * InterlockViolation — and the caller MUST NOT energise — when the partner
 * cannot be confirmed OFF.
 */
async function prepareEnergise(row, channel, modbusClient) {
  const ch = toRegister(channel);
  const partner = getPartner(row, ch);
  if (partner === null) return { partner: null, partnerWasOn: null };

  const hostPort = parseHostPort(row.address);
  if (!hostPort) {
    throw new InterlockViolation(`Interlock: cannot verify partner ch ${partner} — invalid address "${row.address}"`, { equipment_id: row.id, channels: [ch, partner] });
  }
  const { host, port } = hostPort;
  const unitId = row.slave_id || 1;
  const name = row.name || `equipment ${row.id}`;

  let partnerWasOn = null;
  try {
    const before = await modbusClient.readCoils(host, port, unitId, partner, 1, PARTNER_READ_OPTIONS);
    partnerWasOn = Array.isArray(before) ? before[0] === true : null;
  } catch (e) {
    partnerWasOn = null; // best effort; the write + read-back below decide
  }

  try {
    require('./RelayCommandLedger').record(row.id, partner, false, { source: 'interlock' });
    await modbusClient.writeSingleCoil(host, port, unitId, partner, false, PARTNER_WRITE_OPTIONS);
  } catch (err) {
    throw new InterlockViolation(
      `Interlock: refusing to energise "${labelFor(row, ch)}" (ch ${ch}) on ${name} — could not switch partner "${labelFor(row, partner)}" (ch ${partner}) OFF: ${err.message}`,
      { equipment_id: row.id, channels: [ch, partner], cause: err.message }
    );
  }

  let readBack;
  try {
    readBack = await modbusClient.readCoils(host, port, unitId, partner, 1, PARTNER_READ_OPTIONS);
  } catch (err) {
    throw new InterlockViolation(
      `Interlock: refusing to energise "${labelFor(row, ch)}" (ch ${ch}) on ${name} — partner "${labelFor(row, partner)}" (ch ${partner}) read-back failed: ${err.message}`,
      { equipment_id: row.id, channels: [ch, partner], cause: err.message }
    );
  }
  if (!Array.isArray(readBack) || readBack[0] !== false) {
    throw new InterlockViolation(
      `Interlock: refusing to energise "${labelFor(row, ch)}" (ch ${ch}) on ${name} — partner "${labelFor(row, partner)}" (ch ${partner}) still reads ON after OFF command`,
      { equipment_id: row.id, channels: [ch, partner], readBack }
    );
  }
  if (partnerWasOn) {
    console.warn(`[Interlock] ${name}: partner ch ${partner} was ON — switched OFF and verified before energising ch ${ch}`);
  }
  return { partner, partnerWasOn };
}

/**
 * Guard for a single-coil ON write. Validates the {channel: true} write set
 * (always OK on its own) and runs prepareEnergise. Returns the prepareEnergise
 * result. On failure logs `[Interlock]`, raises a critical alert and rethrows.
 */
async function guardEnergise(row, channel, modbusClient, context = {}) {
  try {
    validateWriteSet(row, { [channel]: true });
    return await prepareEnergise(row, channel, modbusClient);
  } catch (err) {
    if (err instanceof InterlockViolation) reportViolation(row, channel, err, context);
    throw err;
  }
}

/**
 * Guard for a multi-coil frame (FC15 / transition). Validates the whole frame
 * and, for every channel being energised that has a partner, drives the partner
 * OFF with read-back BEFORE the frame goes out. Returns the list of partner
 * channels that were switched OFF (so the caller can update its cache).
 */
async function guardWriteSet(row, writes, modbusClient, context = {}) {
  let set;
  try {
    set = validateWriteSet(row, writes);
  } catch (err) {
    if (err instanceof InterlockViolation) reportViolation(row, err.details.channels && err.details.channels[0], err, context);
    throw err;
  }
  const partnersOff = [];
  for (const [ch, state] of set.entries()) {
    if (!state) continue;
    const partner = getPartner(row, ch);
    if (partner === null) continue;
    try {
      await prepareEnergise(row, ch, modbusClient);
      partnersOff.push(partner);
    } catch (err) {
      if (err instanceof InterlockViolation) reportViolation(row, ch, err, context);
      throw err;
    }
  }
  return partnersOff;
}

/**
 * Pairs where BOTH members read ON. `relayStates` is `{ "1": bool, ... }`.
 */
function checkHardwareConflict(row, relayStates) {
  const states = relayStates || {};
  const conflicts = [];
  for (const [a, b] of getInterlockPairs(row)) {
    if (states[a] === true && states[b] === true) {
      conflicts.push({ channels: [a, b], labels: [labelFor(row, a), labelFor(row, b)] });
    }
  }
  return conflicts;
}

/**
 * Log + alert an interlock violation. Never throws.
 */
function reportViolation(row, channel, err, context = {}) {
  const eqId = row && row.id;
  const name = (row && row.name) || `equipment ${eqId}`;
  const src = context.source ? ` [${context.source}]` : '';
  console.error(`[Interlock] VIOLATION on ${name} ch ${channel}${src}: ${err.message}`);
  try {
    const { createAlert } = require('../utils/alertBroadcast');
    createAlert({
      severity: 'critical',
      source: 'interlock',
      equipment_id: eqId ?? null,
      automation_id: context.automationId ?? null,
      fingerprint: `interlock:${eqId}:${channel}`,
      // src = ' [<source>]' or ''; the guard's error text is passed through as-is (English)
      messageKey: 'relay.interlock_violation',
      messageParams: { name: `${name}`, channel: `${channel}`, src, error: `${err.message}` },
    });
  } catch (e) {
    console.error('[Interlock] failed to create alert:', e.message);
  }
}

/**
 * Both members of every conflicting pair are driven OFF (FC05 each) and read
 * back. Cache + relay_events + broadcast are updated for verified channels and
 * a critical alert is raised per pair. Returns `{ conflicts, turnedOff }`.
 * Never throws (individual failures are logged).
 */
async function resolveHardwareConflict(row, relayStates, modbusClient, context = {}) {
  const conflicts = checkHardwareConflict(row, relayStates);
  const turnedOff = [];
  if (conflicts.length === 0) return { conflicts, turnedOff };

  const name = row.name || `equipment ${row.id}`;
  const hostPort = parseHostPort(row.address);
  const unitId = row.slave_id || 1;

  for (const conflict of conflicts) {
    const [a, b] = conflict.channels;
    console.error(`[Interlock] HARDWARE CONFLICT on ${name}: ch ${a} "${conflict.labels[0]}" and ch ${b} "${conflict.labels[1]}" both ON — forcing both OFF`);
    const verified = [];
    if (hostPort) {
      for (const ch of [a, b]) {
        try {
          require('./RelayCommandLedger').record(row.id, ch, false, { source: 'interlock' });
          await modbusClient.writeSingleCoil(hostPort.host, hostPort.port, unitId, ch, false, PARTNER_WRITE_OPTIONS);
          let ok = false;
          try {
            const rb = await modbusClient.readCoils(hostPort.host, hostPort.port, unitId, ch, 1, PARTNER_READ_OPTIONS);
            ok = Array.isArray(rb) && rb[0] === false;
          } catch (e) {
            ok = false;
          }
          if (!ok) {
            // one retry
            await modbusClient.writeSingleCoil(hostPort.host, hostPort.port, unitId, ch, false, PARTNER_WRITE_OPTIONS);
            try {
              const rb2 = await modbusClient.readCoils(hostPort.host, hostPort.port, unitId, ch, 1, PARTNER_READ_OPTIONS);
              ok = Array.isArray(rb2) && rb2[0] === false;
            } catch (e) { ok = false; }
          }
          if (ok) verified.push(ch);
          else console.error(`[Interlock] ${name} ch ${ch} STILL ON after conflict force-OFF`);
        } catch (err) {
          console.error(`[Interlock] ${name} ch ${ch} conflict force-OFF failed: ${err.message}`);
        }
      }
    } else {
      console.error(`[Interlock] ${name}: cannot force OFF — invalid address "${row.address}"`);
    }
    turnedOff.push(...verified);

    try {
      const { createAlert } = require('../utils/alertBroadcast');
      const { M } = require('../i18n');
      const conflictParams = { name: `${name}`, label_a: `${conflict.labels[0]}`, a: `${a}`, label_b: `${conflict.labels[1]}`, b: `${b}` };
      createAlert({
        severity: 'critical',
        source: 'interlock',
        equipment_id: row.id,
        fingerprint: `interlock_conflict:${row.id}:${a}`,
        ...(verified.length === 2
          ? { messageKey: 'relay.interlock_conflict_verified', messageParams: conflictParams }
          : { messageKey: 'relay.interlock_conflict_unverified', messageParams: { ...conflictParams, verified: verified.length ? verified.join(',') : M('common.none') } }),
      });
    } catch (e) {
      console.error('[Interlock] failed to create conflict alert:', e.message);
    }
  }

  if (turnedOff.length > 0) {
    try {
      const { db } = require('../utils/database');
      const { logRelayEvent } = require('./RelayEventLogger');
      let reading = {};
      try {
        const fresh = db.prepare('SELECT last_reading FROM equipment WHERE id = ?').get(row.id);
        if (fresh && fresh.last_reading) reading = JSON.parse(fresh.last_reading);
      } catch (e) {}
      if (!reading || typeof reading !== 'object') reading = {};
      if (!reading.relayStates) reading.relayStates = {};
      for (const ch of turnedOff) reading.relayStates[ch] = false;
      db.prepare("UPDATE equipment SET last_reading = ?, last_communication = datetime('now'), updated_at = datetime('now') WHERE id = ?")
        .run(JSON.stringify(reading), row.id);
      for (const ch of turnedOff) {
        logRelayEvent(row.id, ch, false, 'interlock_conflict', null);
        if (global.broadcast) {
          global.broadcast('relay_state_changed', { equipmentId: row.id, channel: ch, state: false, source: 'interlock_conflict', automationId: null });
        }
      }
    } catch (e) {
      console.error('[Interlock] conflict bookkeeping failed:', e.message);
    }
  }
  return { conflicts, turnedOff };
}

/**
 * Automation save-time validation.
 *
 * Rejects (returns an error message string, or null when OK):
 *   - a transition frame that turns ON both partners of a pair
 *   - a `control` "on" with all_channels (channel == null) on an equipment
 *     that has an interlock pair
 *   - two `control` "on" actions in the same automation that between them
 *     energise both partners of a pair
 *
 * @param {Array} actions
 * @param {(id:number)=>object|null} getEquipment  lookup by id
 */
function validateAutomationActions(actions, getEquipment) {
  if (!Array.isArray(actions)) return null;
  const controlOn = new Map(); // equipment_id -> Set(channel)

  for (const action of actions) {
    if (!action || typeof action !== 'object') continue;
    const eqId = toRegister(action.equipment_id);
    if (eqId === null) continue;

    if (action.type === 'transition' && Array.isArray(action.transitions)) {
      const row = getEquipment(eqId);
      if (!row) continue;
      try {
        validateWriteSet(row, action.transitions);
      } catch (err) {
        if (err instanceof InterlockViolation) return `${err.message} (atomic transition action)`;
        throw err;
      }
    } else if (action.type === 'control' && action.action === 'on') {
      const row = getEquipment(eqId);
      if (!row) continue;
      const pairs = getInterlockPairs(row);
      if (pairs.length === 0) continue;
      const name = row.name || `equipment ${eqId}`;
      if (action.channel == null) {
        const [a, b] = pairs[0];
        return `Interlock: "All channels ON" is not allowed on ${name} — "${labelFor(row, a)}" (ch ${a}) and "${labelFor(row, b)}" (ch ${b}) can never be ON at the same time`;
      }
      const ch = toRegister(action.channel);
      if (ch === null) continue;
      if (!controlOn.has(eqId)) controlOn.set(eqId, new Set());
      const set = controlOn.get(eqId);
      const partner = getPartner(row, ch);
      if (partner !== null && set.has(partner)) {
        return `Interlock: this automation turns ON both "${labelFor(row, ch)}" (ch ${ch}) and "${labelFor(row, partner)}" (ch ${partner}) on ${name} — they can never be ON at the same time`;
      }
      set.add(ch);
    }
  }
  return null;
}

/**
 * Find the equipment row that owns a raw Modbus target (host:port + unit id).
 * Used by the raw /api/modbus write routes.
 */
function findEquipmentByModbusTarget(host, port, unitId) {
  try {
    const { db } = require('../utils/database');
    const address = `${host}:${port}`;
    const rows = db.prepare('SELECT * FROM equipment WHERE address = ?').all(address);
    return rows.find(r => (r.slave_id || 1) === (parseInt(unitId, 10) || 1)) || null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  InterlockViolation,
  getCoilMappings,
  getInterlockPairs,
  hasInterlockPairs,
  getPartner,
  labelFor,
  validateWriteSet,
  prepareEnergise,
  guardEnergise,
  guardWriteSet,
  checkHardwareConflict,
  resolveHardwareConflict,
  reportViolation,
  validateAutomationActions,
  findEquipmentByModbusTarget,
  parseHostPort,
};
