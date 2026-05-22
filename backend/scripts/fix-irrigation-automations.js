/**
 * Fix four legacy irrigation/fertigation automations to use sequential
 * zone-valve actions instead of parallel (preventing pump pressure loss),
 * rename them to match what they actually do, and wire up the emergency
 * STOP EVERYTHING button + disable the redundant legacy fertigation cycle.
 */

const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || '/app/data/sensehub.db', { timeout: 10000 });
db.pragma('busy_timeout = 10000');

// Total cycle duration per pair = 8 min (matches the legacy 480s). Each zone gets 4 min.
const TOTAL_S = 480;
const PER_ZONE_S = 240;

const seqPair = (zoneA, zoneB, withFertilizer) => {
  const actions = [
    // Pumps run for the full duration
    { type: 'control', action: 'on', equipment_id: 1, channel: 1, duration_seconds: TOTAL_S },
    { type: 'control', action: 'on', equipment_id: 1, channel: 2, duration_seconds: TOTAL_S },
    // Zones run sequentially
    { type: 'control', action: 'on', equipment_id: 1, channel: zoneA, delay_seconds: 0,           duration_seconds: PER_ZONE_S },
    { type: 'control', action: 'on', equipment_id: 1, channel: zoneB, delay_seconds: PER_ZONE_S, duration_seconds: PER_ZONE_S },
  ];
  // Note: when withFertilizer=true the operator expects the FertigationDoseScheduler to
  // modulate the Waveshare-2 injector valves via the automation's dose_program_id. We
  // leave that wiring to the operator (they can set dose_program_id manually in the UI
  // or via the planner's proposed_automations[].dose_program_id field).
  return actions;
};

const fixes = [
  { id: 23, new_name: 'Zones 1&2 Manual',            actions: seqPair(3, 4, true)  },
  { id: 30, new_name: 'Zones 1&2 Manual WATER ONLY', actions: seqPair(3, 4, false) },
  { id: 31, new_name: 'Zones 3&4 Manual',            actions: seqPair(5, 6, true)  },
  { id: 32, new_name: 'Zones 3&4 Manual WATER ONLY', actions: seqPair(5, 6, false) },
];

const update = db.prepare('UPDATE automations SET name = ?, actions = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
for (const f of fixes) {
  const r = update.run(f.new_name, JSON.stringify(f.actions), f.id);
  console.log(`id=${f.id} → "${f.new_name}":`, r.changes, 'row(s)');
}

// Emergency stop — id=25. OFF every coil on Waveshare Irrigation 1 (eq=1, ch 1-6)
// AND every coil on Waveshare Irrigation 2 (eq=2, ch 1-6). 12 atomic OFF actions.
const stopActions = [];
for (const eqId of [1, 2]) {
  for (let ch = 1; ch <= 6; ch++) {
    stopActions.push({ type: 'control', action: 'off', equipment_id: eqId, channel: ch });
  }
}
const r25 = db.prepare('UPDATE automations SET actions = ?, enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE id = 25').run(JSON.stringify(stopActions));
console.log('id=25 STOP EVERYTHING actions wired:', r25.changes, 'row(s) — 12 OFF actions');

// Disable id=54 ALL ZONE Fertigation — legacy structure that bypasses the dose
// program scheduler. Operator can re-enable manually if needed as a fallback.
const r54 = db.prepare('UPDATE automations SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = 54').run();
console.log('id=54 ALL ZONE Fertigation disabled:', r54.changes, 'row(s)');

console.log('\n=== Verification ===');
const rows = db.prepare(`
  SELECT id, name, enabled FROM automations
  WHERE id IN (23, 25, 30, 31, 32, 54, 62, 46, 47, 48, 49, 50, 51, 57)
  ORDER BY id
`).all();
console.table(rows);

db.close();
