/**
 * ModbusBlockReads - group a device's register mappings into contiguous
 * block reads, issue one request per block, and slice each mapping's words
 * back out of the block.
 *
 * Why: some controllers (SEKO Kontrol 800) drop back-to-back requests, so
 * eight single-register reads per cycle meant timeouts, retries and backoff.
 * One block read per function code is one request on the wire.
 *
 * Pure with respect to the database: everything here takes plain mappings
 * and a Modbus client object, so it is unit-testable with a stub client.
 */

const DEFAULT_LIMITS = Object.freeze({
  maxHole: 2,          // read through gaps of up to this many registers/coils
  maxRegisters: 100,   // FC03/FC04 cap per block
  maxCoils: 2000,      // FC01/FC02 cap per block (protocol max)
});

/**
 * Errors that mean the whole device (not one register) is unreachable.
 * Shared with ModbusPollingService so both bail out of a cycle the same way.
 */
const CONNECTION_ERROR_RE = /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ECONNTIMEOUT|Port Not Open|Connection not found|Max reconnect/i;

const TYPE_TO_FC = {
  coil: 1,
  discrete: 2,
  discreteInput: 2,
  holding: 3,
  holdingRegister: 3,
  input: 4,
  inputRegister: 4,
};

/**
 * Modbus function code for a mapping. Explicit functionCode wins, then the
 * template-style `type`, default holding registers (FC03).
 */
function getFunctionCode(mapping) {
  if (!mapping) return 3;
  if (mapping.functionCode !== undefined && mapping.functionCode !== null && mapping.functionCode !== '') {
    const fc = parseInt(mapping.functionCode, 10);
    if (!Number.isNaN(fc)) return fc;
  }
  if (mapping.type && TYPE_TO_FC[mapping.type]) return TYPE_TO_FC[mapping.type];
  return 3;
}

function isBitFunction(fc) {
  return fc === 1 || fc === 2;
}

function isReadFunction(fc) {
  return fc === 1 || fc === 2 || fc === 3 || fc === 4;
}

/** Device said "no" (exception response) rather than not answering. */
function isModbusException(err) {
  if (!err) return false;
  if (err.modbusCode !== undefined && err.modbusCode !== null) return true;
  return /Modbus exception|Illegal (data )?(address|function|value)/i.test(err.message || '');
}

function isConnectionError(err) {
  return CONNECTION_ERROR_RE.test((err && err.message) || '');
}

/** Stable key for "this block on this device" used by the per-mapping memory. */
function runKey(run) {
  return `${run.fc}:${run.address}:${run.quantity}`;
}

/**
 * Normalise a mapping into a read item. Returns null for disabled mappings
 * and mappings with no usable address.
 */
function toItem(mapping, index) {
  if (!mapping || mapping.enabled === false) return null;
  const address = parseInt(mapping.address ?? mapping.register, 10);
  if (!Number.isFinite(address) || address < 0) return null;
  // Same span rule as the historical per-mapping read: quantity or 1. We do
  // NOT infer 2 from a 32-bit dataType, so a mapping that today reads one
  // register keeps reading one register (and decodes as 16-bit) after this.
  const quantity = parseInt(mapping.quantity, 10) || 1;
  const fc = getFunctionCode(mapping);
  return { mapping, index, fc, address, quantity, end: address + quantity - 1 };
}

/**
 * Group mappings into contiguous runs per function code.
 *
 * @returns {{ runs: Array<{fc, address, quantity, items}>, unsupported: Array<item> }}
 *   runs are ordered by function code then address; items inside a run are
 *   ordered by address. `unsupported` holds items whose function code is not
 *   a read (the caller logs and skips them, as the per-mapping path did).
 */
function buildRuns(mappings, limits = {}) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const byFc = new Map();
  const unsupported = [];

  (Array.isArray(mappings) ? mappings : []).forEach((mapping, index) => {
    const item = toItem(mapping, index);
    if (!item) return;
    if (!isReadFunction(item.fc)) { unsupported.push(item); return; }
    if (!byFc.has(item.fc)) byFc.set(item.fc, []);
    byFc.get(item.fc).push(item);
  });

  const runs = [];
  for (const fc of [...byFc.keys()].sort((a, b) => a - b)) {
    const items = byFc.get(fc).sort((a, b) => a.address - b.address || a.end - b.end);
    const cap = isBitFunction(fc) ? lim.maxCoils : lim.maxRegisters;
    let run = null;
    for (const item of items) {
      const fits = run
        && item.address <= run.end + 1 + lim.maxHole
        && (Math.max(run.end, item.end) - run.address + 1) <= cap;
      if (fits) {
        run.end = Math.max(run.end, item.end);
        run.items.push(item);
      } else {
        run = { fc, address: item.address, end: item.end, items: [item] };
        runs.push(run);
      }
    }
  }

  for (const run of runs) {
    run.quantity = run.end - run.address + 1;
    delete run.end;
  }
  return { runs, unsupported };
}

/**
 * Split a run into strictly contiguous sub-runs (no holes at all). A run
 * with no holes yields a single sub-run equal to itself. Used as the middle
 * fallback level when a device will not answer a read that spans an
 * unimplemented register (Circutor CEM-C31: exception 3 on one meter,
 * silent drop on the other).
 */
function splitOnHoles(run) {
  const subs = [];
  let cur = null;
  for (const item of run.items) {
    if (cur && item.address <= cur.end + 1) {
      cur.end = Math.max(cur.end, item.end);
      cur.items.push(item);
    } else {
      cur = { fc: run.fc, address: item.address, end: item.end, items: [item] };
      subs.push(cur);
    }
  }
  for (const sub of subs) {
    sub.quantity = sub.end - sub.address + 1;
    delete sub.end;
  }
  return subs;
}

/** The words/bits that belong to `item` inside the block read for `run`. */
function sliceRun(data, run, item) {
  const start = item.address - run.address;
  return Array.isArray(data) ? data.slice(start, start + item.quantity) : [];
}

/**
 * Decode one item's words into its value, exactly as the per-mapping path
 * did: bits -> 1/0 from the first bit, registers -> interpret(words, mapping).
 */
function decodeItem(words, item, interpret) {
  if (!words || words.length === 0) return null;
  if (isBitFunction(item.fc)) return words[0] ? 1 : 0;
  return interpret(words, item.mapping);
}

/** Issue the raw read for a function code. */
function readBlock(client, target, fc, address, quantity, options) {
  const { host, port, unitId } = target;
  switch (fc) {
    case 1: return client.readCoils(host, port, unitId, address, quantity, options);
    case 2: return client.readDiscreteInputs(host, port, unitId, address, quantity, options);
    case 3: return client.readHoldingRegisters(host, port, unitId, address, quantity, options);
    case 4: return client.readInputRegisters(host, port, unitId, address, quantity, options);
    default: return Promise.reject(new Error(`Unsupported function code: ${fc}`));
  }
}

const defaultSleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** Read modes per run, from fewest requests to most. */
const MODE_BLOCK = 'block';    // one read for the whole run (through holes <= maxHole)
const MODE_SPLIT = 'split';    // one read per hole-free sub-run
const MODE_SINGLE = 'single';  // one read per mapping (the historical behaviour)

/**
 * Read every enabled mapping of a device using block reads.
 *
 * Semantics (unchanged from the per-mapping loop this replaces):
 *   - readings are returned for every mapping that could be read, in the
 *     original mapping order;
 *   - `attempted` / `failed` count mappings, so the caller's "N/M failed"
 *     line and its "device error only when nothing was read" rule still hold;
 *   - a connection-level error stops the cycle immediately (connectionError).
 *
 * Fallback ladder, per run, remembered in `runModes` (the caller owns that
 * map and resets it on config reload):
 *   block -> split (hole-free sub-runs) -> single (per mapping)
 *   - a Modbus exception on a read descends one level right away and is
 *     remembered (the device will keep refusing that span);
 *   - a timeout on a hole-spanning block also tries the hole-free sub-runs
 *     in the same cycle, but only remembers 'split' if at least one of them
 *     succeeded (evidence that the hole, not a flaky bus, was the problem);
 *   - a timeout on a hole-free read is simply a failed read for its
 *     mappings (per-mapping reads would not fare better on a flaky bus).
 *
 * @param {object} client  - ModbusTcpClient-like object
 * @param {{host, port, unitId}} target
 * @param {Array} mappings - raw register mappings
 * @param {object} opts
 * @param {(words:number[], mapping:object)=>any} opts.interpret - register decoder
 * @param {Map<string,string>} [opts.runModes] - memory of fallback modes per run key
 * @param {number} [opts.gapMs] - pause between consecutive requests to this device
 * @param {(ms:number)=>Promise} [opts.sleep]
 * @param {(msg:string)=>void} [opts.log]
 * @param {object} [opts.limits] - buildRuns limits override
 * @param {object} [opts.requestOptions] - passed to the client (timeout/retries)
 */
async function readMappings(client, target, mappings, opts = {}) {
  const {
    interpret = (words) => words[0],
    runModes = new Map(),
    gapMs = 0,
    sleep = defaultSleep,
    log = () => {},
    limits,
    requestOptions,
  } = opts;

  const { runs, unsupported } = buildRuns(mappings, limits);
  for (const u of unsupported) {
    log(`Unsupported function code ${u.fc} for "${u.mapping.name || u.address}" - skipped`);
  }

  const collected = [];
  const done = new Set();   // items whose read succeeded (value may still decode to null)
  let attempted = 0;
  let requests = 0;
  let lastError = null;
  let connectionError = null;

  const request = async (fc, address, quantity) => {
    if (requests > 0 && gapMs > 0) await sleep(gapMs);
    requests++;
    return readBlock(client, target, fc, address, quantity, requestOptions);
  };

  const describe = (g) => `FC${g.fc} ${g.address}x${g.quantity}`;

  // One read covering `group` (a run, a sub-run or a single item wrapped as
  // a group). Collects every item on success. Returns the outcome class.
  const readGroup = async (group) => {
    try {
      const data = await request(group.fc, group.address, group.quantity);
      for (const item of group.items) {
        const value = decodeItem(sliceRun(data, group, item), item, interpret);
        done.add(item);
        if (value !== null && value !== undefined) collected.push({ item, value });
      }
      return 'ok';
    } catch (err) {
      lastError = err;
      if (isConnectionError(err)) { connectionError = err; return 'connection'; }
      if (isModbusException(err)) return 'exception';
      return 'failed';
    }
  };

  const asGroup = (item) => ({ fc: item.fc, address: item.address, quantity: item.quantity, items: [item] });

  const remember = (key, run, mode, why) => {
    runModes.set(key, mode);
    log(`${describe(run)} ${why}; reading it ${mode === MODE_SPLIT ? 'as hole-free sub-blocks' : 'one register at a time'} until config reload`);
  };

  runLoop:
  for (const run of runs) {
    attempted += run.items.length;
    const key = runKey(run);
    const subRuns = splitOnHoles(run);
    let mode = run.items.length === 1 ? MODE_SINGLE : (runModes.get(key) || MODE_BLOCK);
    let outcome = null;

    if (mode === MODE_BLOCK) {
      outcome = await readGroup(run);
      if (outcome === 'ok') continue;
      if (outcome === 'connection') break;
      if (outcome === 'exception') {
        mode = subRuns.length > 1 ? MODE_SPLIT : MODE_SINGLE;
        remember(key, run, mode, `rejected (${lastError.message})`);
      } else if (subRuns.length > 1) {
        // Timed out while spanning a hole: try without the hole, decide after.
        mode = MODE_SPLIT;
      } else {
        // Hole-free block timed out: a failed read, nothing smarter to try.
        continue;
      }
    }

    if (mode === MODE_SPLIT) {
      let okCount = 0;
      let exception = false;
      for (const sub of subRuns) {
        if (sub.items.every(i => done.has(i))) continue;
        outcome = await readGroup(sub);
        if (outcome === 'ok') { okCount++; continue; }
        if (outcome === 'connection') break runLoop;
        if (outcome === 'exception') { exception = true; break; }
      }
      if (exception) {
        mode = MODE_SINGLE;
        remember(key, run, mode, `sub-block rejected (${lastError.message})`);
      } else {
        if (okCount > 0 && runModes.get(key) !== MODE_SPLIT) {
          remember(key, run, MODE_SPLIT, 'fails as one block but answers hole-free sub-blocks');
        }
        continue;
      }
    }

    // MODE_SINGLE: one read per mapping not yet collected
    for (const item of run.items) {
      if (done.has(item)) continue;
      outcome = await readGroup(asGroup(item));
      if (outcome === 'connection') break runLoop;
    }
  }

  // Every attempted mapping that did not get a successful read failed
  // (including the rest of the run in flight when the connection died).
  const failed = attempted - done.size;

  collected.sort((a, b) => a.item.index - b.item.index);
  return {
    readings: collected.map(({ item, value }) => ({
      mapping: item.mapping,
      value,
      address: item.address,
      functionCode: item.fc,
    })),
    attempted,
    failed,
    requests,
    runs: runs.length,
    lastError,
    connectionError,
  };
}

module.exports = {
  DEFAULT_LIMITS,
  CONNECTION_ERROR_RE,
  getFunctionCode,
  isModbusException,
  isConnectionError,
  runKey,
  buildRuns,
  splitOnHoles,
  sliceRun,
  decodeItem,
  readBlock,
  readMappings,
  MODE_BLOCK,
  MODE_SPLIT,
  MODE_SINGLE,
};
