/**
 * One-shot fix for the broken "Fertigation cycle with dose program" template:
 *   1. Disable the seven planner-generated fertigation automations that fire
 *      only the pumps (id 46-51, 57). They flooded the mixing tank because the
 *      zone valves never opened.
 *   2. Rewrite the template to include sequential zone-valve actions alongside
 *      the pumps so future plans emit correct cycles.
 */

const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || '/app/data/sensehub.db';
const db = new Database(dbPath, { timeout: 10000 });
db.pragma('busy_timeout = 10000');

// --- Step 1: disable the seven broken fertigation automations ---
const disabled = db.prepare(`
  UPDATE automations SET enabled = 0, updated_at = CURRENT_TIMESTAMP
  WHERE id IN (46, 47, 48, 49, 50, 51, 57)
`).run();
console.log('Disabled', disabled.changes, 'broken fertigation automations');

// --- Step 2: rewrite the template ---
const newParams = [
  { name: 'irrigation_equipment_id', type: 'integer', required: true,
    description: 'equipment.id of the Waveshare board holding pump + mixer + zone channels (typically equipment id 1)' },
  { name: 'pump_channel', type: 'integer', required: true, min: 1, max: 16,
    description: '1-based channel of the Irrigation Pump on the irrigation board' },
  { name: 'mixing_channel', type: 'integer', required: true, min: 1, max: 16,
    description: '1-based channel of the Mixing Pump (venturi) on the irrigation board' },
  { name: 'zone1_channel', type: 'integer', required: true, min: 1, max: 16,
    description: '1-based channel of Zone 1 valve' },
  { name: 'zone2_channel', type: 'integer', required: true, min: 1, max: 16,
    description: '1-based channel of Zone 2 valve' },
  { name: 'zone3_channel', type: 'integer', required: true, min: 1, max: 16,
    description: '1-based channel of Zone 3 valve' },
  { name: 'zone4_channel', type: 'integer', required: true, min: 1, max: 16,
    description: '1-based channel of Zone 4 valve' },
  { name: 'per_zone_minutes', type: 'integer', required: true, min: 1, max: 30,
    description: 'Minutes each zone valve stays open. Total cycle duration = per_zone_minutes × 4 (pumps run for that full duration).' },
  { name: 'zone_label', type: 'string', required: false, default: '',
    description: 'Free text label for the action message, e.g. "GreenHouse 1"' },
];

// Sequential per-zone: zone N opens at delay (N-1) × per_zone_minutes × 60s,
// runs per_zone_minutes × 60s. Pumps run for the full sum: per_zone_minutes × 60 × 4.
const newActions = [
  { type: 'control', action: 'on', equipment_id: '${irrigation_equipment_id}',
    channel: '${pump_channel}',
    duration_seconds: '${per_zone_minutes * 60 * 4}' },
  { type: 'control', action: 'on', equipment_id: '${irrigation_equipment_id}',
    channel: '${mixing_channel}',
    duration_seconds: '${per_zone_minutes * 60 * 4}' },
  { type: 'control', action: 'on', equipment_id: '${irrigation_equipment_id}',
    channel: '${zone1_channel}',
    delay_seconds: 0,
    duration_seconds: '${per_zone_minutes * 60}' },
  { type: 'control', action: 'on', equipment_id: '${irrigation_equipment_id}',
    channel: '${zone2_channel}',
    delay_seconds: '${per_zone_minutes * 60}',
    duration_seconds: '${per_zone_minutes * 60}' },
  { type: 'control', action: 'on', equipment_id: '${irrigation_equipment_id}',
    channel: '${zone3_channel}',
    delay_seconds: '${per_zone_minutes * 60 * 2}',
    duration_seconds: '${per_zone_minutes * 60}' },
  { type: 'control', action: 'on', equipment_id: '${irrigation_equipment_id}',
    channel: '${zone4_channel}',
    delay_seconds: '${per_zone_minutes * 60 * 3}',
    duration_seconds: '${per_zone_minutes * 60}' },
];

const newDescription = [
  'Run a fertigation cycle with per-tank duty-cycle control.',
  'The Irrigation Pump and Mixing Pump run for the full cycle duration (per_zone_minutes × 4 minutes).',
  'The four zone valves open SEQUENTIALLY (Zone 1 → 2 → 3 → 4) so pump pressure stays high — never open multiple zone valves at once.',
  'The FertigationDoseScheduler modulates injector valves on the fertigation board independently throughout the cycle, based on the automation\'s dose_program_id.',
].join(' ');

const newNotes = [
  'Pick this template for every scheduled nutrient feed.',
  'The four zone valves run sequentially (DO NOT open in parallel — pump pressure will drop and water will pool in the mixing tank).',
  'zone1/2/3/4_channel are the channels on the irrigation board (typically 3, 4, 5, 6).',
  'pump_channel + mixing_channel are typically 1 and 2.',
  'Total cycle duration = per_zone_minutes × 4. For plain water flushes use "Single-channel pump cycle" or a dose program whose tanks are all duty_pct=0.',
  'For different zone layouts (e.g. 2 or 6 zones) request a new template via template_requests[].',
].join(' ');

const r = db.prepare(`
  UPDATE automation_templates
  SET parameters = ?, actions = ?, description = ?, agent_usage_notes = ?, updated_at = datetime('now')
  WHERE name = 'Fertigation cycle with dose program'
`).run(JSON.stringify(newParams), JSON.stringify(newActions), newDescription, newNotes);

console.log('Template rewritten:', r.changes, 'row(s) updated.');

const tpl = db.prepare("SELECT id, name, parameters, actions FROM automation_templates WHERE name = 'Fertigation cycle with dose program'").get();
console.log('  template id =', tpl.id);
console.log('  parameters:', JSON.parse(tpl.parameters).map(p => p.name).join(', '));
console.log('  actions count:', JSON.parse(tpl.actions).length);

db.close();
