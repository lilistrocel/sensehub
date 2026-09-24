const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const g = require(path.join(__dirname, '..', 'src', 'services', 'AutomationGuards.js'));

// ---------------------------------------------------------------------------
// Duration / delay clamp
// ---------------------------------------------------------------------------

test('resolveRelayLimits merges stored JSON with defaults and ignores junk', () => {
  assert.deepEqual(g.resolveRelayLimits(null), { max_duration_seconds: 21600, max_delay_seconds: 3600 });
  assert.deepEqual(g.resolveRelayLimits('{"max_duration_seconds": 600}'), { max_duration_seconds: 600, max_delay_seconds: 3600 });
  assert.deepEqual(g.resolveRelayLimits({ max_delay_seconds: -5, max_duration_seconds: 'abc' }), { max_duration_seconds: 21600, max_delay_seconds: 3600 });
  assert.deepEqual(g.resolveRelayLimits('not json'), g.DEFAULT_RELAY_LIMITS);
});

test('clampSeconds caps above max, passes through below/empty', () => {
  assert.deepEqual(g.clampSeconds(99999, 21600), { value: 21600, capped: true });
  assert.deepEqual(g.clampSeconds(21600, 21600), { value: 21600, capped: false });
  assert.deepEqual(g.clampSeconds('120', 21600), { value: 120, capped: false });
  assert.deepEqual(g.clampSeconds(null, 21600), { value: null, capped: false });
  assert.deepEqual(g.clampSeconds(0, 21600), { value: 0, capped: false });
});

test('clampActions caps duration/delay on control and transition actions and lists what was capped', () => {
  const actions = [
    { type: 'control', action: 'on', equipment_id: 3, channel: 1, duration_seconds: 100000, delay_seconds: 5000 },
    { type: 'control', action: 'on', equipment_id: 3, channel: 2, duration_seconds: 900, delay_seconds: 10 },
    { type: 'transition', equipment_id: 1, duration_seconds: 50000, delay_seconds: 180, transitions: [{ channel: 3, state: true }] },
    { type: 'control', action: 'on', equipment_id: 3, channel: null, stagger_delay_seconds: 7200 },
    { type: 'alert', severity: 'info', message: 'hi' },
  ];
  const { actions: out, capped } = g.clampActions(actions);
  assert.equal(out[0].duration_seconds, 21600);
  assert.equal(out[0].delay_seconds, 3600);
  assert.equal(out[1].duration_seconds, 900);
  assert.equal(out[1].delay_seconds, 10);
  assert.equal(out[2].duration_seconds, 21600);
  assert.equal(out[2].delay_seconds, 180);
  assert.equal(out[3].stagger_delay_seconds, 3600);
  assert.deepEqual(out[4], actions[4]);
  assert.deepEqual(capped, [
    { index: 0, field: 'duration_seconds', requested: 100000, capped_to: 21600 },
    { index: 0, field: 'delay_seconds', requested: 5000, capped_to: 3600 },
    { index: 2, field: 'duration_seconds', requested: 50000, capped_to: 21600 },
    { index: 3, field: 'stagger_delay_seconds', requested: 7200, capped_to: 3600 },
  ]);
  // input untouched
  assert.equal(actions[0].duration_seconds, 100000);
});

test('clampActions honours custom limits and leaves non-arrays alone', () => {
  const { actions, capped } = g.clampActions([{ type: 'control', duration_seconds: 700 }], { max_duration_seconds: 600 });
  assert.equal(actions[0].duration_seconds, 600);
  assert.equal(capped.length, 1);
  assert.deepEqual(g.clampActions(null), { actions: null, capped: [] });
});

// ---------------------------------------------------------------------------
// Hysteresis validator
// ---------------------------------------------------------------------------

const FANS = [3, 4, 5, 6, 11, 15, 16];
const control = (eqIds, channel, action) => eqIds.map(id => ({ type: 'control', action, equipment_id: id, channel }));
const rule = (id, name, { metric = 'Temperature', op, value, actions, enabled = 1, equipment = '8' }) => ({
  id, name, enabled,
  trigger_config: JSON.stringify({ type: 'threshold', equipment_id: equipment, sensor_type: metric, operator: op, threshold_value: String(value), unit: '' }),
  actions: JSON.stringify(actions),
});

test('crossed thresholds on the same metric + channels are rejected (ON > 28 vs OFF < 29)', () => {
  const on = rule(1, 'Circular Fans ON', { op: 'gt', value: 28, actions: control(FANS, 4, 'on') });
  const off = rule(2, 'Circular Fans OFF', { op: 'lt', value: 29, actions: control(FANS, 4, 'off') });
  const v = g.validateHysteresis(on, [off]);
  assert.ok(v, 'expected a violation');
  assert.equal(v.code, 'HYSTERESIS_CROSSED');
  assert.equal(v.on.id, 1);
  assert.equal(v.off.id, 2);
  assert.match(v.message, /#1 "Circular Fans ON" \(> 28/);
  assert.match(v.message, /#2 "Circular Fans OFF" \(< 29/);
  // symmetric: validating the OFF rule against the ON rule also rejects
  const v2 = g.validateHysteresis(off, [on]);
  assert.ok(v2);
  assert.equal(v2.on.id, 1);
  assert.equal(v2.off.id, 2);
});

test('equal thresholds are rejected (must be strictly beyond), gte/lte included', () => {
  const on = rule(1, 'ON', { op: 'gte', value: 28, actions: control([3], 4, 'on') });
  const off = rule(2, 'OFF', { op: 'lte', value: 28, actions: control([3], 4, 'off') });
  assert.ok(g.validateHysteresis(on, [off]));
});

test('correct hysteresis passes (ON > 28 vs OFF < 26)', () => {
  const on = rule(1, 'ON', { op: 'gt', value: 28, actions: control(FANS, 4, 'on') });
  const off = rule(2, 'OFF', { op: 'lt', value: 26, actions: control(FANS, 4, 'off') });
  assert.equal(g.validateHysteresis(on, [off]), null);
  assert.equal(g.validateHysteresis(off, [on]), null);
});

test('reverse direction (heater ON < 18 vs OFF > 20) passes; crossed reverse (ON < 21) rejects', () => {
  const on = rule(1, 'Heater ON', { op: 'lt', value: 18, actions: control([3], 1, 'on') });
  const off = rule(2, 'Heater OFF', { op: 'gt', value: 20, actions: control([3], 1, 'off') });
  assert.equal(g.validateHysteresis(on, [off]), null);
  const crossed = rule(1, 'Heater ON', { op: 'lt', value: 21, actions: control([3], 1, 'on') });
  assert.ok(g.validateHysteresis(crossed, [off]));
});

test('rules gating on different metrics are never compared (pads OFF on humidity vs pads ON on temperature)', () => {
  const padsOn = rule(92, 'Pads ON', { metric: 'Temperature', op: 'gt', value: 30, actions: control([5, 15], 5, 'on') });
  const padsOffRh = rule(93, 'Pads OFF (RH)', { metric: 'Humidity', op: 'gt', value: 80, actions: control([5, 15], 5, 'off') });
  assert.equal(g.validateHysteresis(padsOn, [padsOffRh]), null);
  assert.equal(g.validateHysteresis(padsOffRh, [padsOn]), null);
  // same metric name on a different sensor is a different metric too
  const otherSensor = rule(94, 'Pads OFF (other sensor)', { metric: 'Temperature', op: 'lt', value: 31, actions: control([5, 15], 5, 'off'), equipment: '9' });
  assert.equal(g.validateHysteresis(padsOn, [otherSensor]), null);
});

test('rules that do not share a channel, same-action rules, and disabled rules are ignored', () => {
  const on = rule(1, 'Circ ON', { op: 'gt', value: 28, actions: control(FANS, 4, 'on') });
  const offOtherCh = rule(2, 'Small OFF', { op: 'lt', value: 29, actions: control(FANS, 3, 'off') });
  assert.equal(g.validateHysteresis(on, [offOtherCh]), null);
  const alsoOn = rule(3, 'Circ ON 2', { op: 'gt', value: 25, actions: control(FANS, 4, 'on') });
  assert.equal(g.validateHysteresis(on, [alsoOn]), null);
  const disabledOff = rule(4, 'Circ OFF (disabled)', { op: 'lt', value: 29, actions: control(FANS, 4, 'off'), enabled: 0 });
  assert.equal(g.validateHysteresis(on, [disabledOff]), null);
  // the candidate itself is skipped on update
  const self = rule(1, 'Circ OFF self', { op: 'lt', value: 29, actions: control(FANS, 4, 'off') });
  assert.equal(g.validateHysteresis(on, [self]), null);
});

test('candidate that is not a threshold rule, or is explicitly disabled by the caller, passes', () => {
  const sched = { id: 5, name: 'Schedule', trigger_config: JSON.stringify({ type: 'schedule' }), actions: JSON.stringify(control(FANS, 4, 'on')) };
  const off = rule(2, 'OFF', { op: 'lt', value: 40, actions: control(FANS, 4, 'off') });
  assert.equal(g.validateHysteresis(sched, [off]), null);
});

test('"all channels" control actions expand via getEquipment and overlap per channel', () => {
  const getEquipment = (id) => (id === 3 ? { id: 3, register_mappings: JSON.stringify([
    { type: 'coil', register: 1, access: 'readwrite' }, { type: 'coil', register: 2, access: 'readwrite' }]) } : null);
  const onAll = rule(1, 'All ON', { op: 'gt', value: 28, actions: [{ type: 'control', action: 'on', equipment_id: 3, channel: null }] });
  const off = rule(2, 'Ch2 OFF', { op: 'lt', value: 29, actions: control([3], 2, 'off') });
  assert.ok(g.validateHysteresis(onAll, [off], getEquipment));
  // without a lookup the wildcard still overlaps
  assert.ok(g.validateHysteresis(onAll, [off]));
});

test('transition actions participate (state true/false = on/off)', () => {
  const on = { id: 1, name: 'T ON', trigger_config: JSON.stringify({ type: 'threshold', equipment_id: 8, sensor_type: 'Temperature', operator: 'gt', threshold_value: 28 }),
    actions: JSON.stringify([{ type: 'transition', equipment_id: 4, transitions: [{ channel: 5, state: true }] }]) };
  const off = rule(2, 'T OFF', { op: 'lt', value: 30, actions: control([4], 5, 'off') });
  assert.ok(g.validateHysteresis(on, [off]));
});

test('live climate rule set (84-94 shape) passes', () => {
  const rules = [
    rule(84, 'Circular Fans ON', { op: 'gt', value: 28, actions: control(FANS, 4, 'on') }),
    rule(85, 'Small Fans ON', { op: 'gt', value: 30, actions: control(FANS, 3, 'on') }),
    rule(86, 'Big Fans ON', { op: 'gt', value: 30, actions: [...control(FANS, 1, 'on'), ...control(FANS, 2, 'on')] }),
    rule(87, 'Humidity Fans ON', { metric: 'Humidity', op: 'gt', value: 72, actions: [...control(FANS, 1, 'on'), ...control(FANS, 2, 'on'), ...control(FANS, 3, 'on'), ...control(FANS, 4, 'on')] }),
    rule(88, 'EMERGENCY', { op: 'gt', value: 35, actions: [...control(FANS, 1, 'on'), ...control(FANS, 2, 'on'), ...control(FANS, 3, 'on'), ...control(FANS, 4, 'on'), ...control([5, 15], 5, 'on')] }),
    rule(89, 'Circular Fans OFF', { op: 'lt', value: 26, actions: control(FANS, 4, 'off') }),
    rule(90, 'Small Fans OFF', { op: 'lt', value: 28, actions: control(FANS, 3, 'off') }),
    rule(91, 'Big Fans OFF', { op: 'lt', value: 27, actions: [...control(FANS, 1, 'off'), ...control(FANS, 2, 'off')] }),
    rule(92, 'Pads ON', { op: 'gt', value: 30, actions: control([5, 15], 5, 'on') }),
    rule(93, 'Pads OFF (RH)', { metric: 'Humidity', op: 'gt', value: 80, actions: control([5, 15], 5, 'off') }),
    rule(94, 'Pads OFF (temp)', { op: 'lt', value: 27, actions: control([5, 15], 5, 'off') }),
  ];
  for (const r of rules) assert.equal(g.validateHysteresis(r, rules), null, `rule ${r.id} should pass`);
});
