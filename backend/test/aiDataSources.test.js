// In-memory DB for everything that touches utils/database (AgronomistService import).
process.env.DB_PATH = ':memory:';
process.env.ANTHROPIC_API_KEY = '';
process.env.TZ = 'Asia/Dubai';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');

const A = require(path.join(__dirname, '..', 'src', 'services', 'AiDataSources.js'));

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

test('validateConfig rejects unknown top-level keys, unknown sources and unknown fields', () => {
  assert.throws(() => A.validateConfig({ bogus: 1 }), /unknown key "bogus"/);
  assert.throws(() => A.validateConfig({ sources: { seko: { enabled: false } } }), /unknown source "seko"/);
  assert.throws(() => A.validateConfig({ sources: { amic: { enabled: false, note: 'x' } } }), /unknown field "note"/);
  assert.throws(() => A.validateConfig({ sources: { amic: { enabled: 'no' } } }), /enabled must be boolean/);
  assert.throws(() => A.validateConfig({ sources: { amic: { enabled: false, until: 'next week' } } }), /until must be an ISO date/);
  assert.throws(() => A.validateConfig({ sources: { amic: { enabled: false, until: '2026-13-45' } } }), /until must be an ISO date/);
  assert.throws(() => A.validateConfig({ excluded_equipment_ids: 'all' }), /must be an array/);
  assert.throws(() => A.validateConfig({ excluded_equipment_ids: [1, 'x'] }), /bad equipment id/);
  assert.throws(() => A.validateConfig(null), /must be an object/);
});

test('validateConfig normalises: trims reason, dedupes + sorts equipment ids, ignores read-only echo fields', () => {
  const out = A.validateConfig({
    sources: { amic: { enabled: false, reason: '  Down for the foreseeable future  ', until: '', effective_enabled: true, label: 'x' } },
    excluded_equipment_ids: [14, '13', 14],
  });
  assert.deepEqual(out, {
    sources: { amic: { enabled: false, reason: 'Down for the foreseeable future', until: null } },
    excluded_equipment_ids: [13, 14],
  });
});

test('defaults: every catalogued source enabled, nothing excluded', () => {
  const d = A.defaultConfig();
  assert.deepEqual(Object.keys(d.sources).sort(), [...A.SOURCE_KEYS].sort());
  for (const k of A.SOURCE_KEYS) assert.deepEqual(d.sources[k], { enabled: true, reason: null, until: null });
  assert.deepEqual(d.excluded_equipment_ids, []);
  const eff = A.effectiveConfig(d);
  assert.deepEqual(eff.disabled, []);
  assert.equal(A.outOfServiceNote(eff), null);
});

test('mergeConfig: re-enabling a source clears its stale reason/until', () => {
  const base = A.mergeConfig(A.defaultConfig(), { sources: { amic: { enabled: false, reason: 'broken', until: '2026-10-01' } } });
  assert.equal(base.sources.amic.reason, 'broken');
  const on = A.mergeConfig(base, { sources: { amic: { enabled: true } } });
  assert.deepEqual(on.sources.amic, { enabled: true, reason: null, until: null });
});

// ---------------------------------------------------------------------------
// `until` expiry
// ---------------------------------------------------------------------------

test('effectiveConfig: until in the past re-enables the source; today or future keeps it out', () => {
  const cfg = A.mergeConfig(A.defaultConfig(), {
    sources: {
      amic: { enabled: false, reason: 'pump', until: '2026-09-20' },
      energy: { enabled: false, reason: 'meter swap', until: '2026-09-24' },
      lab: { enabled: false, reason: 'no courier', until: '2026-10-01' },
      canopy_capture: { enabled: false, reason: 'lens', until: null },
    },
  });
  const eff = A.effectiveConfig(cfg, new Date('2026-09-24T09:00:00'));
  assert.equal(eff.sources.amic.effective_enabled, true, 'past until -> back in service');
  assert.equal(eff.sources.amic.expired, true);
  assert.equal(eff.sources.energy.effective_enabled, false, 'until == today still out');
  assert.equal(eff.sources.lab.effective_enabled, false);
  assert.equal(eff.sources.canopy_capture.effective_enabled, false, 'no until -> indefinitely out');
  assert.deepEqual(eff.disabled, ['lab', 'canopy_capture', 'energy'], 'catalogue order');
  assert.deepEqual(eff.expired, ['amic']);
  assert.equal(eff.isEnabled('amic'), true);
  assert.equal(eff.isEnabled('lab'), false);
});

// ---------------------------------------------------------------------------
// Note rendering
// ---------------------------------------------------------------------------

test('outOfServiceNote lists each disabled source with reason / until, plus excluded equipment; planner audience adds the plan-step rule', () => {
  const eff = A.effectiveConfig(A.mergeConfig(A.defaultConfig(), {
    sources: {
      amic: { enabled: false, reason: 'Down for the foreseeable future', until: null },
      water_controller: { enabled: false, reason: null, until: '2026-12-01' },
    },
    excluded_equipment_ids: [9],
  }), new Date('2026-09-24T09:00:00'));
  const note = A.outOfServiceNote(eff, { equipmentNames: { 9: 'SHT20 Temp/Humidity EXPOSED' } });
  assert.match(note, /^OUT OF SERVICE — the following systems are unavailable and MUST be ignored: /);
  assert.match(note, /AMIC nutrient analyser \(reason: Down for the foreseeable future\)/);
  assert.match(note, /SEKO Kontrol 800 water controller \(expected back on 2026-12-01\)/);
  assert.match(note, /equipment #9 SHT20 Temp\/Humidity EXPOSED/);
  assert.match(note, /do not recommend calibrating, sampling or repairing them unless the operator asks, and do not create tasks that depend on them/);
  assert.doesNotMatch(note, /plan steps/);
  const planner = A.outOfServiceNote(eff, { audience: 'planner' });
  assert.match(planner, /Do not propose plan steps, targets or automations that read from or actuate these systems/);
});

// ---------------------------------------------------------------------------
// Equipment classification + lab row split
// ---------------------------------------------------------------------------

test('classifyEquipment maps the real fleet onto sources', () => {
  assert.equal(A.classifyEquipment({ name: 'SEKO Kontrol 800 (Fertigation Water)', type: 'sensor' }), 'water_controller');
  assert.equal(A.classifyEquipment({ name: 'Circutor CEM-C31 Zone 1', type: 'meter' }), 'energy');
  assert.equal(A.classifyEquipment({ name: 'Seeed Substrate Sensor 1 (Far Side)', type: 'sensor' }), 'substrate_sensors');
  assert.equal(A.classifyEquipment({ name: 'SHT20 Temp/Humidity SHIELDED', type: 'sensor' }), 'climate_sensors');
  assert.equal(A.classifyEquipment({ name: 'Waveshare Irrigation 1', type: 'relay' }), null);
});

test('filterLabRows: AMIC rows (notes "AMIC CHn ...") follow amic, everything else follows lab', () => {
  const rows = [
    { nutrient: 'calcium_Ca', notes: 'AMIC CH1 (Ca²⁺)' },
    { nutrient: 'calcium_Ca', notes: 'External lab, Dubai' },
    { nutrient: 'sodium_Na', notes: null },
  ];
  const amicOff = A.effectiveConfig(A.mergeConfig(A.defaultConfig(), { sources: { amic: { enabled: false } } }));
  assert.deepEqual(A.filterLabRows(rows, amicOff).map(r => r.notes), ['External lab, Dubai', null]);
  const labOff = A.effectiveConfig(A.mergeConfig(A.defaultConfig(), { sources: { lab: { enabled: false } } }));
  assert.deepEqual(A.filterLabRows(rows, labOff).map(r => r.notes), ['AMIC CH1 (Ca²⁺)']);
});

// ---------------------------------------------------------------------------
// Agronomist snapshot filtering (pure)
// ---------------------------------------------------------------------------

function fakeSnapshot() {
  return {
    date: '2026-09-24', timezone: 'Asia/Dubai',
    crops: [{ id: 1, crop_name: 'Capsicum' }],
    dispensing: [{ equipment_id: 1, equipment_name: 'Waveshare Irrigation 1', total_minutes: 32, channels: [] }],
    reference_sensors: {
      temperature: { configured: true, equipment_id: 8, equipment_name: 'SHT20 SHIELDED', today: [] },
      humidity: { configured: true, equipment_id: 8, equipment_name: 'SHT20 SHIELDED', today: [] },
      soil: { configured: true, equipment_id: 7, equipment_name: 'Seeed 1', today: [] },
    },
    sensors: [
      { equipment_id: 7, equipment_name: 'Seeed Substrate Sensor 1 (Far Side)', type: 'sensor', metric: 'Substrate Moisture', avg: 44 },
      { equipment_id: 8, equipment_name: 'SHT20 Temp/Humidity SHIELDED', type: 'sensor', metric: 'Temperature', avg: 31 },
      { equipment_id: 9, equipment_name: 'SHT20 Temp/Humidity EXPOSED', type: 'sensor', metric: 'Temperature', avg: 36 },
      { equipment_id: 13, equipment_name: 'Circutor CEM-C31 Zone 1', type: 'meter', metric: 'Active Power Total', avg: 1200 },
      { equipment_id: 17, equipment_name: 'SEKO Kontrol 800 (Fertigation Water)', type: 'sensor', metric: 'pH', avg: 6.1 },
    ],
    substrate_diagnostics: [
      { zone_id: 1, zone_name: 'GH1', sensor_count: 2, classification: 'healthy', sensors: [{ equipment_id: 7 }, { equipment_id: 12 }] },
      { zone_id: null, zone_name: 'Unassigned sensors', sensor_count: 1, classification: 'unknown', sensors: [{ equipment_id: 12 }] },
    ],
    operator_tasks: [{ title: 'Refill tank 1', status: 'open' }],
    lab: { irrigation: { today: [], latest_per_nutrient: {} }, drain: { today: [], latest_per_nutrient: {} }, other: { today: [], latest_per_nutrient: {} } },
    alerts: [
      { severity: 'warning', message: 'SEKO unreachable', equipment: 'SEKO', equipment_id: 17 },
      { severity: 'info', message: 'Fans on', equipment: 'Fan Board 1', equipment_id: 3 },
    ],
    automations: { total_runs: 40, failures: 1, successes: 39, drift_events: 0 },
  };
}

test('applyToAgronomistSnapshot omits disabled sections entirely (no null placeholders) and is idempotent', () => {
  const eff = A.effectiveConfig(A.mergeConfig(A.defaultConfig(), {
    sources: {
      water_controller: { enabled: false, reason: 'probe' },
      energy: { enabled: false },
      alerts: { enabled: false },
      operator_tasks: { enabled: false },
      automations_state: { enabled: false },
      substrate_sensors: { enabled: false },
      fertigation: { enabled: false },
    },
  }));
  const out = A.applyToAgronomistSnapshot(fakeSnapshot(), eff);
  for (const k of ['alerts', 'operator_tasks', 'automations', 'substrate_diagnostics', 'dispensing']) {
    assert.equal(k in out, false, `${k} must be omitted, not null`);
  }
  assert.deepEqual(out.sensors.map(s => s.equipment_id), [8, 9], 'SEKO, meter and substrate rows dropped');
  assert.deepEqual(Object.keys(out.reference_sensors).sort(), ['humidity', 'temperature'], 'soil reference block dropped');
  assert.ok('lab' in out, 'lab stays when only one of amic/lab is off');
  assert.ok('crops' in out);
  assert.deepEqual(A.applyToAgronomistSnapshot(out, eff), out);
});

test('applyToAgronomistSnapshot: lab is omitted only when BOTH amic and lab are off; climate off drops temp/humidity refs and the whole reference_sensors key when empty', () => {
  const eff = A.effectiveConfig(A.mergeConfig(A.defaultConfig(), {
    sources: { amic: { enabled: false }, lab: { enabled: false }, climate_sensors: { enabled: false }, substrate_sensors: { enabled: false } },
  }));
  const out = A.applyToAgronomistSnapshot(fakeSnapshot(), eff);
  assert.equal('lab' in out, false);
  assert.equal('reference_sensors' in out, false);
  assert.deepEqual(out.sensors.map(s => s.equipment_id), [13, 17]);
});

test('excluded_equipment_ids drop that device everywhere: sensors, reference block, diagnostics rows, dispensing, alerts', () => {
  const eff = A.effectiveConfig(A.mergeConfig(A.defaultConfig(), { excluded_equipment_ids: [7, 17, 1] }));
  const out = A.applyToAgronomistSnapshot(fakeSnapshot(), eff);
  assert.deepEqual(out.sensors.map(s => s.equipment_id), [8, 9, 13]);
  assert.deepEqual(Object.keys(out.reference_sensors).sort(), ['humidity', 'temperature']);
  assert.equal(out.substrate_diagnostics.length, 2);
  assert.deepEqual(out.substrate_diagnostics[0].sensors.map(s => s.equipment_id), [12]);
  assert.equal(out.substrate_diagnostics[0].sensor_count, 1);
  assert.deepEqual(out.dispensing, []);
  assert.deepEqual(out.alerts.map(a => a.equipment_id), [3]);
  // a zone whose every sensor is excluded disappears
  const eff2 = A.effectiveConfig(A.mergeConfig(A.defaultConfig(), { excluded_equipment_ids: [12] }));
  const out2 = A.applyToAgronomistSnapshot(fakeSnapshot(), eff2);
  assert.deepEqual(out2.substrate_diagnostics.map(z => z.zone_id), [1]);
});

// ---------------------------------------------------------------------------
// Planner context filtering (pure)
// ---------------------------------------------------------------------------

function fakePlannerContext() {
  return {
    today: '2026-09-24', tomorrow: '2026-09-25', timezone: 'Asia/Dubai',
    today_snapshot: fakeSnapshot(),
    agronomist_today: null,
    current_automations: [{ id: 66, name: 'Fertigation 07:00', enabled: true }],
    equipment: [{ id: 1, name: 'Waveshare Irrigation 1', channels: [] }, { id: 3, name: 'Fan Board 1', channels: [] }],
    zones: [], active_crops: [],
    templates: [
      { id: 20, name: 'Fertigation cycle with dose program', description: 'Runs pumps and opens zones', agent_usage_notes: 'Use for every fertigation cycle' },
      { id: 18, name: 'Threshold alert', description: 'Alert only', agent_usage_notes: 'Compare the AMIC value against the target before alerting' },
      { id: 16, name: 'Threshold ON (single channel)', description: 'Fans on above temperature', agent_usage_notes: null },
    ],
    fertigation_tanks: [{ id: 1, name: 'Tank 1', equipment_id: 2, channel: 1 }, { id: 2, name: 'Tank 2', equipment_id: 1, channel: 2 }],
    water_pump_lpm: 257.5, ionic_equivalence: {}, guardrails: [], daily_delivery_estimate: {},
    operator_tasks: [{ title: 'x', status: 'open' }],
    dose_programs: [{ id: 5 }], element_targets: [{ element: 'calcium_Ca' }], ingredients_library: [{ name: 'Calcium Nitrate' }],
    recent_plans: [], yesterday_plan: null, yesterday_full_scorecard: null, today_plan: null, today_partial_scorecard: null, previous_rejection: null,
  };
}

test('applyToPlannerContext: fertigation off removes tanks/programs/targets/library/estimate; tasks off removes operator_tasks; today_snapshot filtered too', () => {
  const eff = A.effectiveConfig(A.mergeConfig(A.defaultConfig(), {
    sources: { fertigation: { enabled: false }, operator_tasks: { enabled: false }, alerts: { enabled: false } },
  }));
  const ctx = A.applyToPlannerContext(fakePlannerContext(), eff);
  for (const k of ['fertigation_tanks', 'dose_programs', 'element_targets', 'ingredients_library', 'daily_delivery_estimate', 'water_pump_lpm', 'operator_tasks']) {
    assert.equal(k in ctx, false, `${k} omitted`);
  }
  assert.equal('dispensing' in ctx.today_snapshot, false);
  assert.equal('alerts' in ctx.today_snapshot, false);
  assert.ok(Array.isArray(ctx.current_automations), 'automation list always kept (apply manifest)');
  assert.ok(Array.isArray(ctx.equipment));
});

test('applyToPlannerContext: excluded equipment leaves the inventory and the tank bindings', () => {
  const eff = A.effectiveConfig(A.mergeConfig(A.defaultConfig(), { excluded_equipment_ids: [1] }));
  const ctx = A.applyToPlannerContext(fakePlannerContext(), eff);
  assert.deepEqual(ctx.equipment.map(e => e.id), [3]);
  assert.deepEqual(ctx.fertigation_tanks.map(t => t.id), [1]);
});

test('templatesReferencingDisabled flags templates whose text mentions a disabled source', () => {
  const eff = A.effectiveConfig(A.mergeConfig(A.defaultConfig(), { sources: { amic: { enabled: false }, fertigation: { enabled: false } } }));
  const hits = A.templatesReferencingDisabled(fakePlannerContext().templates, eff);
  assert.deepEqual(hits.map(h => [h.template_id, h.source]).sort(), [[18, 'amic'], [20, 'fertigation']]);
  const none = A.templatesReferencingDisabled(fakePlannerContext().templates, A.effectiveConfig(A.defaultConfig()));
  assert.deepEqual(none, []);
});

// ---------------------------------------------------------------------------
// Service round-trip on an in-memory DB (system_settings) + expiry logged once
// ---------------------------------------------------------------------------

test('AiDataSources.setConfig/getConfig round-trip; effective() logs an expiry once', () => {
  const mem = new Database(':memory:');
  mem.exec('CREATE TABLE system_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)');
  mem.exec("CREATE TABLE equipment (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO equipment VALUES (9, 'SHT20 EXPOSED')");
  const svc = new A.AiDataSources(mem);
  assert.deepEqual(svc.getConfig(), A.defaultConfig());

  svc.setConfig({ sources: { amic: { enabled: false, reason: 'Down for the foreseeable future' } }, excluded_equipment_ids: [9] });
  const stored = JSON.parse(mem.prepare("SELECT value FROM system_settings WHERE key = 'ai_data_sources'").get().value);
  assert.equal(stored.sources.amic.enabled, false);
  assert.equal(stored.sources.amic.reason, 'Down for the foreseeable future');
  assert.equal(stored.sources.lab.enabled, true);
  assert.deepEqual(stored.excluded_equipment_ids, [9]);
  assert.throws(() => svc.setConfig({ sources: { nope: { enabled: false } } }), /unknown source/);
  assert.equal(svc.isEnabled('amic'), false);
  assert.equal(svc.isEnabled('lab'), true);
  assert.throws(() => svc.isEnabled('nope'), /unknown source/);
  assert.match(svc.outOfServiceNote(), /AMIC nutrient analyser \(reason: Down for the foreseeable future\); equipment #9 SHT20 EXPOSED/);

  // Expiry: logged once per key
  svc.setConfig({ sources: { amic: { enabled: false, reason: 'x', until: '2000-01-01' } } });
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    assert.equal(svc.effective().isEnabled('amic'), true);
    svc.effective(); svc.effective();
  } finally { console.log = orig; }
  assert.equal(logs.filter(l => /"amic" was out of service until 2000-01-01/.test(l)).length, 1);
});

// ---------------------------------------------------------------------------
// End-to-end through the real builders on the in-memory schema
// ---------------------------------------------------------------------------

test('AgronomistService.aggregateDailyData + buildDailyRequest: AMIC rows gone, section omitted, note present, stats record the policy', () => {
  const { db } = require(path.join(__dirname, '..', 'src', 'utils', 'database.js'));
  const { agronomistService } = require(path.join(__dirname, '..', 'src', 'services', 'AgronomistService.js'));
  const date = '2026-09-24';
  db.exec(`
    INSERT INTO zones (id, name) VALUES (1, 'Irrigation feed'), (2, 'Drain');
    INSERT INTO equipment (id, name, type, protocol, address) VALUES
      (8, 'SHT20 Temp/Humidity SHIELDED', 'sensor', 'modbus', 'x'),
      (17, 'SEKO Kontrol 800 (Fertigation Water)', 'sensor', 'modbus', 'x');
    INSERT INTO readings (equipment_id, name, value, unit, timestamp) VALUES
      (8, 'Temperature', 31.2, '°C', '${date}T08:00:00Z'),
      (17, 'pH', 6.1, 'pH', '${date}T08:00:00Z');
    INSERT INTO lab_readings (sample_date, nutrient, value, unit, zone_id, notes) VALUES
      ('${date} 07:00:00', 'calcium_Ca', 120, 'mg/L', 1, 'AMIC CH1 (Ca²⁺)'),
      ('${date} 07:00:00', 'sodium_Na', 80, 'mg/L', 1, 'AMIC CH4 (Na⁺)'),
      ('${date} 06:00:00', 'chloride_Cl', 150, 'mg/L', 1, 'External lab');
  `);

  const on = agronomistService.aggregateDailyData(date, { dataSources: A.effectiveConfig(A.defaultConfig()) });
  assert.deepEqual(Object.keys(on.lab.irrigation.latest_per_nutrient).sort(), ['calcium_Ca', 'chloride_Cl', 'sodium_Na']);
  assert.deepEqual(on.sensors.map(s => s.equipment_id).sort((a, b) => a - b), [8, 17]);

  const eff = A.effectiveConfig(A.mergeConfig(A.defaultConfig(), {
    sources: { amic: { enabled: false, reason: 'Down for the foreseeable future' }, water_controller: { enabled: false }, alerts: { enabled: false }, canopy_capture: { enabled: false } },
  }));
  const off = agronomistService.aggregateDailyData(date, { dataSources: eff });
  assert.deepEqual(Object.keys(off.lab.irrigation.latest_per_nutrient), ['chloride_Cl'], 'AMIC rows filtered before aggregation');
  assert.deepEqual(off.lab.irrigation.today.map(r => r.nutrient), ['chloride_Cl'], 'manual row kept, AMIC rows gone from today');
  assert.deepEqual(off.sensors.map(s => s.equipment_id), [8]);
  assert.equal('alerts' in off, false);

  const { requestBody, stats } = agronomistService.buildDailyRequest({ date, snapshot: off, capture: null, clarifications: [], historyBlock: 'history', dataSources: eff });
  const text = requestBody.messages[0].content.find(c => c.type === 'text').text;
  const jsonPart = /```json\n([\s\S]*?)\n```/.exec(text)[1];
  assert.doesNotMatch(jsonPart, /AMIC/);
  assert.doesNotMatch(jsonPart, /"alerts"/);
  assert.ok(text.indexOf('OUT OF SERVICE —') > text.lastIndexOf('```'), 'note paragraph comes after the JSON block');
  assert.match(text, /AMIC nutrient analyser \(reason: Down for the foreseeable future\)/);
  assert.match(text, /canopy camera is out of service/);
  assert.match(requestBody.system[0].text, /Out-of-service systems: the operator may take farm systems out of service/);
  assert.deepEqual(stats.data_sources.disabled.map(d => d.key), ['amic', 'water_controller', 'canopy_capture', 'alerts']);
  assert.equal(stats.image_present, false);

  // The listReports() projection surfaces the excluded keys via json_extract.
  db.prepare(`INSERT INTO agronomist_reports (report_date, model, input_snapshot, summary, full_markdown, status)
              VALUES (?, 'm', ?, '', '', 'success')`).run(date, JSON.stringify({ ...off, snapshot_stats: stats }));
  const listed = agronomistService.listReports(5, 0).find(r => r.report_date === date);
  assert.deepEqual(listed.excluded_sources, ['amic', 'water_controller', 'canopy_capture', 'alerts']);
});

test('OperationalPlannerService.buildPlanningContext/buildPlanRequest honour the policy; consistency warnings flag disabled-source templates', () => {
  const { db } = require(path.join(__dirname, '..', 'src', 'utils', 'database.js'));
  const { operationalPlannerService } = require(path.join(__dirname, '..', 'src', 'services', 'OperationalPlannerService.js'));
  const date = '2026-09-24';
  const eff = A.effectiveConfig(A.mergeConfig(A.defaultConfig(), {
    sources: { amic: { enabled: false, reason: 'Down for the foreseeable future' }, fertigation: { enabled: false } },
    excluded_equipment_ids: [17],
  }));
  const ctx = operationalPlannerService.buildPlanningContext(date, { dataSources: eff });
  for (const k of ['fertigation_tanks', 'dose_programs', 'element_targets', 'ingredients_library', 'daily_delivery_estimate']) assert.equal(k in ctx, false, `${k} omitted`);
  assert.equal('dispensing' in ctx.today_snapshot, false);
  assert.ok(Array.isArray(ctx.current_automations));
  assert.equal(ctx.equipment.some(e => e.id === 17), false);

  const { requestBody, userMessage, stats } = operationalPlannerService.buildPlanRequest({ today: date, context: ctx, dataSources: eff });
  assert.match(userMessage, /OUT OF SERVICE — .*AMIC nutrient analyser \(reason: Down for the foreseeable future\); Fertigation system; equipment #17/);
  assert.match(userMessage, /Do not propose plan steps, targets or automations/);
  assert.ok(userMessage.indexOf('OUT OF SERVICE') > userMessage.lastIndexOf('```'), 'note after the JSON block');
  assert.match(requestBody.system[0].text, /Out-of-service systems:/);
  assert.deepEqual(stats.data_sources.disabled.map(d => d.key), ['amic', 'fertigation']);
  assert.deepEqual(stats.data_sources.excluded_equipment_ids, [17]);

  const templates = db.prepare('SELECT id, name, description, agent_usage_notes FROM automation_templates').all();
  const fert = templates.find(t => /fertigation/i.test(t.name));
  assert.ok(fert, 'seeded fertigation template present');
  const parsed = {
    proposed_automations: [
      { name: 'Morning fertigation', template_id: fert.id, template_parameters: '{}', actions_json: '[]', trigger_config: { type: 'schedule', sensor_equipment_id: 0 } },
      { name: 'pH watch', template_id: 0, template_parameters: '{}', actions_json: '[{"type":"alert","equipment_id":17,"channel":0}]', trigger_config: { type: 'threshold', sensor_equipment_id: 17 } },
    ],
    changes_from_today: [], targets: [], risks: [], headline: '', summary: '',
  };
  const warnings = operationalPlannerService._findConsistencyWarnings(parsed, [], { dataSources: eff, templates });
  const kinds = warnings.map(w => w.kind);
  assert.ok(kinds.includes('template_references_disabled_source'), JSON.stringify(warnings));
  assert.equal(warnings.find(w => w.kind === 'template_references_disabled_source').source, 'fertigation');
  assert.ok(kinds.includes('targets_excluded_equipment'));
  assert.equal(warnings.find(w => w.kind === 'targets_excluded_equipment').id, 17);
});
