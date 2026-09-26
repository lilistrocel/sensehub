// Soft-switch zone sequencing (operator requirement 2026-09-26): the builder in
// scripts/soft-switch-sequences.js and the save-route validation it must pass.
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { buildSoftSwitchActions, extractZones } = require(path.join(__dirname, '..', 'scripts', 'soft-switch-sequences.js'));
const { validateAutomationActions } = require(path.join(__dirname, '..', 'src', 'services', 'RelayInterlockService.js'));
const { clampActions, resolveRelayLimits, validateHysteresis } = require(path.join(__dirname, '..', 'src', 'services', 'AutomationGuards.js'));

// Live board row (register_mappings as on 2026-09-26) and the current run actions of 95-101.
const EQ1 = {
  id: 1, name: 'Waveshare Irrigation 1', address: '192.168.1.7:502', slave_id: 6,
  register_mappings: JSON.stringify([
    { name: 'Irrigation Pump', register: '1', type: 'coil', dataType: 'bool', access: 'readwrite' },
    { name: 'Mixing Pump', register: '2', type: 'coil', dataType: 'bool', access: 'readwrite' },
    { name: 'Irrigation Zone 1', register: '3', type: 'coil', dataType: 'bool', access: 'readwrite' },
    { name: 'Irrigation Zone 2', register: '4', type: 'coil', dataType: 'bool', access: 'readwrite' },
    { name: 'Irrigation Zone 3', register: '5', type: 'coil', dataType: 'bool', access: 'readwrite' },
    { name: 'Irrigation Zone 4', register: '6', type: 'coil', dataType: 'bool', access: 'readwrite' },
  ]),
};
const lookup = (id) => (Number(id) === 1 ? EQ1 : null);
const NAMES = { equipmentName: EQ1.name, channels: { 1: 'Irrigation Pump', 2: 'Mixing Pump', 3: 'Irrigation Zone 1', 4: 'Irrigation Zone 2', 5: 'Irrigation Zone 3', 6: 'Irrigation Zone 4' } };

function currentRun(D) {
  return [
    { type: 'control', action: 'on', equipment_id: 1, channel: 1, duration_seconds: 4 * D },
    { type: 'control', action: 'on', equipment_id: 1, channel: 2, duration_seconds: 4 * D },
    { type: 'control', action: 'on', equipment_id: 1, channel: 3, delay_seconds: 0, duration_seconds: D },
    { type: 'control', action: 'on', equipment_id: 1, channel: 4, delay_seconds: D, duration_seconds: D },
    { type: 'control', action: 'on', equipment_id: 1, channel: 5, delay_seconds: 2 * D, duration_seconds: D },
    { type: 'control', action: 'on', equipment_id: 1, channel: 6, delay_seconds: 3 * D, duration_seconds: D },
  ];
}
const RUNS = {
  95: { time: '07:30', D: 180, total: 755 },
  96: { time: '09:30', D: 210, total: 875 },
  97: { time: '11:30', D: 270, total: 1115 },
  98: { time: '12:30', D: 210, total: 875 },
  99: { time: '13:45', D: 210, total: 875 },
  100: { time: '15:30', D: 150, total: 635 },
  101: { time: '17:00', D: 120, total: 515 },
};

/** Per-channel ON intervals [start, end) of a control-action list. */
function intervals(actions) {
  const by = new Map();
  for (const a of actions) {
    const s = Number(a.delay_seconds) || 0;
    const e = s + Number(a.duration_seconds);
    if (!by.has(a.channel)) by.set(a.channel, []);
    by.get(a.channel).push([s, e]);
  }
  return by;
}

for (const [id, run] of Object.entries(RUNS)) {
  test(`automation ${id} (${run.time}, ${run.D} s/zone): soft-switch actions pass the save-route validation and never dead-head`, () => {
    const { actions, timeline, totalS } = buildSoftSwitchActions(currentRun(run.D), { names: NAMES });

    // Same checks as PUT /api/automations/:id: interlock, server caps, hysteresis.
    assert.equal(validateAutomationActions(actions, lookup), null);
    const clamped = clampActions(actions, resolveRelayLimits(null));
    assert.deepEqual(clamped.capped, [], 'no duration/delay exceeds the server caps');
    assert.deepEqual(clamped.actions, actions);
    const others = Object.keys(RUNS).map(o => ({ id: Number(o), name: `run ${o}`, enabled: 1, trigger_config: JSON.stringify({ type: 'schedule', schedule_type: 'daily', time: RUNS[o].time }), actions: JSON.stringify(currentRun(RUNS[o].D)) }));
    assert.equal(validateHysteresis({ id: Number(id), name: `run ${id}`, trigger_config: { type: 'schedule', schedule_type: 'daily', time: run.time }, actions, enabled: true }, others, lookup), null);

    // Shape: 4 zones x (valve, pump, mixing pump), control ON with delay + duration, no dependencies.
    assert.equal(actions.length, 12);
    for (const a of actions) {
      assert.equal(a.type, 'control');
      assert.equal(a.action, 'on');
      assert.equal(a.equipment_id, 1);
      assert.ok(Number.isInteger(a.delay_seconds) && a.delay_seconds >= 0);
      assert.ok(a.duration_seconds > 0);
      assert.equal(a.dependencies, undefined);
      assert.equal(a.equipment_name, 'Waveshare Irrigation 1');
      assert.equal(a.channel_name, NAMES.channels[a.channel]);
    }

    const iv = intervals(actions);
    const zones = [3, 4, 5, 6].flatMap(ch => iv.get(ch).map(([s, e]) => ({ ch, s, e }))).sort((a, b) => a.s - b.s);
    assert.equal(zones.length, 4);
    // never two zone valves ON at once (1 s gap between them)
    for (let i = 1; i < zones.length; i++) assert.equal(zones[i].s - zones[i - 1].e, 1, `gap before zone ${i + 1}`);
    // pumps ON only while a zone valve is ON: valve leads by 3 s and lags by 5 s
    for (const pumpCh of [1, 2]) {
      const pw = iv.get(pumpCh);
      assert.equal(pw.length, 4, `ch${pumpCh}: one window per zone`);
      pw.forEach(([s, e], i) => {
        assert.equal(s - zones[i].s, 3, 'pump lead');
        assert.equal(zones[i].e - e, 5, 'valve lag');
        assert.equal(e - s, run.D, 'pumping time = today\'s zone duration');
      });
    }
    // total run length and the dose-cycle span (max delay + duration)
    assert.equal(totalS, run.total);
    assert.equal(Math.max(...actions.map(a => a.delay_seconds + a.duration_seconds)), run.total);
    assert.deepEqual(timeline.map(t => t.channel), [3, 4, 5, 6]);
  });
}

test('builder options: lead/lag/gap change the slot, zones keep their order and durations, bad values are refused', () => {
  const src = currentRun(150);
  const { timeline, totalS } = buildSoftSwitchActions(src, { pumpLeadS: 5, valveLagS: 10, gapS: 2 });
  assert.deepEqual(timeline.map(t => [t.valveOn, t.pumpsOn, t.pumpsOff, t.valveOff]), [
    [0, 5, 155, 165], [167, 172, 322, 332], [334, 339, 489, 499], [501, 506, 656, 666],
  ]);
  assert.equal(totalS, 666);
  assert.throws(() => buildSoftSwitchActions(src, { pumpLeadS: -1 }), /pumpLeadS/);
  assert.throws(() => buildSoftSwitchActions([{ type: 'control', action: 'on', equipment_id: 1, channel: 1, duration_seconds: 60 }]), /no zone actions/);
  // zone order follows the current delays, not the channel number
  const shuffled = src.map(a => (a.channel === 3 ? { ...a, delay_seconds: 999 } : a));
  assert.deepEqual(extractZones(shuffled).map(z => z.channel), [4, 5, 6, 3]);
});

test('builder carries extra fields of the existing action for a channel but never dependencies or old timing', () => {
  const src = currentRun(120).map(a => (a.channel === 3 ? { ...a, channel_name: 'Zone A', note: 'x', dependencies: [{ type: 'sensor' }] } : a));
  const { actions } = buildSoftSwitchActions(src);
  const z1 = actions.find(a => a.channel === 3);
  assert.equal(z1.channel_name, 'Zone A');
  assert.equal(z1.note, 'x');
  assert.equal(z1.dependencies, undefined);
  assert.equal(z1.duration_seconds, 128);
});
