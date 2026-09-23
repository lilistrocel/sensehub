export function getChannelDisplayName(mapping) {
  if (!mapping) return 'Unknown Channel';
  return (mapping.label?.trim()) || mapping.name || 'Unknown Channel';
}

// ---------------------------------------------------------------------------
// Relay interlocks — a coil mapping may carry `interlockWith: <register>`.
// The relation is symmetric: A↔B holds if either side declares the other.
// ---------------------------------------------------------------------------

function toRegister(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function coilList(mappings) {
  let list = mappings;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { list = []; }
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter(m => m && m.type === 'coil')
    .map(m => ({ ...m, _reg: toRegister(m.register ?? m.address) }))
    .filter(m => m._reg !== null);
}

/** Register number of the channel interlocked with `channel`, or null. */
export function getInterlockPartner(mappings, channel) {
  const ch = toRegister(channel);
  if (ch === null) return null;
  for (const m of coilList(mappings)) {
    const partner = toRegister(m.interlockWith);
    if (partner === null || partner === m._reg) continue;
    if (m._reg === ch) return partner;
    if (partner === ch) return m._reg;
  }
  return null;
}

/** All [a, b] interlock pairs (a < b) declared on the mapping list. */
export function getInterlockPairs(mappings) {
  const seen = new Set();
  const pairs = [];
  for (const m of coilList(mappings)) {
    const partner = toRegister(m.interlockWith);
    if (partner === null || partner === m._reg) continue;
    const a = Math.min(m._reg, partner), b = Math.max(m._reg, partner);
    const key = `${a}:${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push([a, b]);
  }
  return pairs;
}

export function hasInterlockPair(mappings) {
  return getInterlockPairs(mappings).length > 0;
}

/** Display label of the partner channel of `channel`, or null. */
export function getInterlockPartnerLabel(mappings, channel) {
  const partner = getInterlockPartner(mappings, channel);
  if (partner === null) return null;
  const m = coilList(mappings).find(c => c._reg === partner);
  return m ? getChannelDisplayName(m) : `Channel ${partner}`;
}

/**
 * Set mapping[index].interlockWith = value ('' clears) and keep the relation
 * symmetric across the list: the old partner (if any) is cleared, the new
 * partner points back, and whoever the new partner used to point at is cleared.
 * Returns a new array.
 */
export function applyInterlockChange(mappings, index, value) {
  const list = mappings.map(m => ({ ...m }));
  const me = list[index];
  if (!me) return list;
  const myReg = toRegister(me.register ?? me.address);
  const next = toRegister(value);
  const clear = (m) => { delete m.interlockWith; };

  // Clear whoever currently points at me, and my own link.
  for (const m of list) {
    if (m !== me && toRegister(m.interlockWith) === myReg) clear(m);
  }
  clear(me);

  if (next === null || next === myReg) return list;

  const partner = list.find((m, i) => i !== index && m.type === 'coil' && toRegister(m.register ?? m.address) === next);
  if (partner) {
    const partnersOld = toRegister(partner.interlockWith);
    if (partnersOld !== null && partnersOld !== myReg) {
      for (const m of list) {
        if (m !== partner && m !== me && toRegister(m.register ?? m.address) === partnersOld) clear(m);
      }
    }
    partner.interlockWith = myReg;
  }
  me.interlockWith = next;
  return list;
}
