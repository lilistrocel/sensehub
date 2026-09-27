/**
 * RelayReadback - read-back confirmation for coil writes.
 *
 * Standard for every relay write: whitelist -> clamp -> write -> READ BACK ->
 * log -> revertable. This module owns the "read back" step: after a coil (or a
 * run of coils) has been written, read it back with FC01 and decide whether the
 * hardware actually took the requested state.
 *
 * The Modbus client is injected so the decision logic is unit-testable with a
 * stub. No database access here; `reportUnconfirmed()` lazily requires the
 * alert helper so the module stays pure for tests.
 */

// priority 'high': the read-back belongs to the write it confirms and goes ahead of queued sensor reads.
const READBACK_OPTIONS = { timeout: 2000, retries: 1, priority: 'high' };

/**
 * Compare a read-back value with the requested one.
 * @returns {boolean|null} true/false, or null when the read-back is unavailable.
 */
function decideConfirmed(readback, requested) {
  if (readback === null || readback === undefined) return null;
  return (readback === true) === (requested === true);
}

/**
 * Read `quantity` coils starting at `start`. Never throws: returns null when
 * the read fails so callers can log "unconfirmed" rather than blow up after a
 * write that already went out.
 */
async function readBackCoils(client, target, start, quantity) {
  try {
    const data = await client.readCoils(target.host, target.port, target.unitId, start, quantity, READBACK_OPTIONS);
    if (!Array.isArray(data)) return null;
    return data.slice(0, quantity).map(v => v === true);
  } catch (err) {
    return null;
  }
}

/**
 * Confirm a write of `values` (boolean[]) starting at coil `start`.
 *
 * @param {object} client   - ModbusTcpClient-like ({ readCoils })
 * @param {object} target   - { host, port, unitId }
 * @param {number} start    - first coil address written
 * @param {boolean[]} values - requested states, one per coil
 * @param {object} [opts]
 * @param {boolean} [opts.writeOnly] - device cannot answer: skip the read-back
 * @param {Function} [opts.retry]    - async fn re-issuing the write; called once when the first read-back disagrees
 * @returns {Promise<{
 *   confirmed: boolean,           // every coil read back as requested
 *   source: 'readback'|'write_only'|'readback_failed',
 *   readback: boolean[]|null,     // final read-back values (null when unavailable)
 *   retried: boolean,
 *   items: Array<{channel:number, requested:boolean, readback:boolean|null, confirmed:boolean}>
 * }>}
 */
async function confirmWrite(client, target, start, values, opts = {}) {
  const requested = (values || []).map(v => v === true);
  const build = (readback, source, retried) => {
    const items = requested.map((req, i) => {
      const rb = readback ? readback[i] : null;
      const decided = decideConfirmed(rb, req);
      return { channel: start + i, requested: req, readback: rb === undefined ? null : rb, confirmed: decided === true };
    });
    return {
      confirmed: items.length > 0 && items.every(i => i.confirmed),
      source,
      readback,
      retried,
      items,
    };
  };

  if (opts.writeOnly) return build(null, 'write_only', false);

  let readback = await readBackCoils(client, target, start, requested.length);
  if (readback === null) return build(null, 'readback_failed', false);

  const mismatch = requested.some((req, i) => readback[i] !== req);
  if (mismatch && typeof opts.retry === 'function') {
    try { await opts.retry(); } catch (err) { /* the second read-back decides */ }
    const again = await readBackCoils(client, target, start, requested.length);
    if (again === null) return build(readback, 'readback', true); // keep the first read
    return build(again, 'readback', true);
  }
  return build(readback, 'readback', false);
}

/** Single-coil convenience wrapper around confirmWrite(). */
async function confirmCoilWrite(client, target, address, value, opts = {}) {
  const result = await confirmWrite(client, target, address, [value === true], opts);
  const item = result.items[0] || { channel: address, requested: value === true, readback: null, confirmed: false };
  return { ...result, readback: item.readback, item };
}

/**
 * Warn + raise a de-duplicated warning alert when a read-back disagrees with
 * the requested state. Only for genuine disagreement (source === 'readback');
 * write-only devices and failed reads are logged by the caller as unconfirmed
 * without an alert.
 */
function reportUnconfirmed(equipment, channel, requested, readback, context = {}) {
  const name = (equipment && equipment.name) || `equipment ${equipment && equipment.id}`;
  const eqId = equipment && equipment.id;
  const msg = `[Relay] write NOT confirmed: ${name} ch ${channel} requested ${requested ? 'ON' : 'OFF'} but reads ${readback === null ? 'unknown' : (readback ? 'ON' : 'OFF')}` +
    (context.source ? ` (source=${context.source})` : '');
  console.warn(msg);
  try {
    const { createAlert } = require('../utils/alertBroadcast');
    const { M } = require('../i18n');
    createAlert({
      severity: 'warning',
      source: 'relay',
      equipment_id: eqId ?? null,
      automation_id: context.automationId ?? null,
      fingerprint: `relay_unconfirmed:${eqId}:${channel}`,
      messageKey: 'relay.unconfirmed',
      messageParams: {
        name: `${name}`, channel: `${channel}`,
        requested: M(requested ? 'relay.state_on' : 'relay.state_off'),
        readback: readback === null ? M('common.unknown') : M(readback ? 'relay.state_on' : 'relay.state_off'),
      },
    });
  } catch (err) {
    console.error('[Relay] failed to raise unconfirmed-write alert:', err.message);
  }
}

module.exports = {
  READBACK_OPTIONS,
  decideConfirmed,
  readBackCoils,
  confirmWrite,
  confirmCoilWrite,
  reportUnconfirmed,
};
