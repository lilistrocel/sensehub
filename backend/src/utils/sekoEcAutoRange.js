/**
 * One-time register-map fix for the SEKO Kontrol 800 feed-water EC (incident
 * 2026-09-26 "EC 10x too low"): register 1005 (FC04) auto-ranges — raw = µS x 10
 * below ~2000 µS, raw = µS x 1 (mS x 1000) at/above — and the range registers
 * (1175/1176) answer exception 2, so the fixed scale 0.1 showed 340 µS/cm while
 * the panel read 3156 µS. This adds `autoRange` to that mapping (decoded by
 * ModbusPollingService.decodeAutoRange) and drops "scale unverified" from its
 * label. Historical readings are NOT rewritten here (stored before the fix =
 * raw x 0.1).
 *
 * Idempotent: only touches a SEKO Kontrol 800 row whose register-1005 FC04
 * mapping has no autoRange yet.
 */
const EC_AUTO_RANGE = Object.freeze({ lowScale: 0.1, highScale: 1, switchAt: 2000 });
const EC_NOTE = 'SEKO auto-ranges at ~2000 µS: raw = µS x10 below, µS x1 (mS x1000) above; range inferred (range registers 1175/1176 unreadable). Readings before 2026-09-26 stored at a fixed x0.1 (values above 2000 µS appear 10x too low).';

function patchMappings(mappings) {
  if (!Array.isArray(mappings)) return { changed: false, mappings };
  let changed = false;
  const out = mappings.map(m => {
    if (!m || m.autoRange) return m;
    const reg = parseInt(m.register ?? m.address, 10);
    const fc = parseInt(m.functionCode, 10);
    if (reg !== 1005 || (fc !== 4 && m.type !== 'input')) return m;
    changed = true;
    return {
      ...m,
      label: String(m.label || m.name || 'Water EC').replace(/\s*\(scale unverified\)\s*/i, '').trim() || 'Water EC',
      autoRange: { ...EC_AUTO_RANGE },
      note: EC_NOTE,
    };
  });
  return { changed, mappings: out };
}

function ensureSekoEcAutoRange(db) {
  const rows = db.prepare("SELECT id, name, register_mappings FROM equipment WHERE name LIKE '%SEKO%Kontrol%800%' AND register_mappings IS NOT NULL").all();
  let n = 0;
  for (const row of rows) {
    let mappings;
    try { mappings = JSON.parse(row.register_mappings); } catch (_) { continue; }
    const { changed, mappings: next } = patchMappings(mappings);
    if (!changed) continue;
    db.prepare("UPDATE equipment SET register_mappings = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(next), row.id);
    console.log(`SEKO EC auto-range enabled on equipment ${row.id} (${row.name})`);
    n++;
  }
  return n;
}

module.exports = { ensureSekoEcAutoRange, patchMappings, EC_AUTO_RANGE };
