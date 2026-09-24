const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const sb = require(path.join(__dirname, '..', 'src', 'services', 'StatusBoardHelpers.js'));

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

function board(overrides = {}) {
  return {
    id: 4, name: 'Fan Board 2', type: 'relay', enabled: 1, write_only: 0, status: 'online',
    polling_interval_ms: 15000, last_communication: iso(3000),
    last_reading: JSON.stringify({ relayStates: { 1: true, 2: false, 3: true, 4: false, 5: false, 6: true } }),
    register_mappings: JSON.stringify([
      { name: '07-09-11 Big Fan', label: '07-09-11 Big Fan', type: 'coil', register: 1, access: 'readwrite' },
      { name: '08-10-12 Big Fan', label: '08-10-12 Big Fan', type: 'coil', register: 2, access: 'readwrite' },
      { name: '03-04 Small Fan', label: '03-04 Small Fan', type: 'coil', register: 3, access: 'readwrite' },
      { name: '05-06-07-08 Circular Fan', label: '05-06-07-08 Circular Fan', type: 'coil', register: 4, access: 'readwrite' },
      { name: 'Open Greenhouse Shades', label: 'Open Greenhouse Shades', type: 'coil', register: 5, access: 'readwrite' },
      { name: 'Close Greenhouse Shades', label: 'Close Greenhouse Shades', type: 'coil', register: 6, access: 'readwrite' },
    ]),
    ...overrides,
  };
}

const groupMap = (groups) => Object.fromEntries(groups.map(g => [g.key, g]));

test('groupKeyForChannel maps labels by regex, irrigation by equipment id, else other', () => {
  assert.equal(sb.groupKeyForChannel('01-03-05 Big Fan', 3), 'big_fans');
  assert.equal(sb.groupKeyForChannel('03-04 Small Fan', 3), 'small_fans');
  assert.equal(sb.groupKeyForChannel('05-06-07-08 Circular Fan', 3), 'circular_fans');
  assert.equal(sb.groupKeyForChannel('02 Chiller Pad Water Pump', 5), 'chiller_pads');
  assert.equal(sb.groupKeyForChannel('Submersible Drain Pump', 5), 'drain_pumps');
  assert.equal(sb.groupKeyForChannel('Open Greenhouse Shades', 4), 'shades_open');
  assert.equal(sb.groupKeyForChannel('Close Greenhouse Shades', 4), 'shades_close');
  assert.equal(sb.groupKeyForChannel('Irrigation Zone 1', 1), 'irrigation');
  assert.equal(sb.groupKeyForChannel('Ingredient 2', 2), 'irrigation');
  assert.equal(sb.groupKeyForChannel('Mystery Relay', 9), 'other');
  // case-insensitive
  assert.equal(sb.groupKeyForChannel('BIG FAN', 3), 'big_fans');
});

test('isMappingSkipped drops enabled:false and "Unused N" placeholders', () => {
  assert.equal(sb.isMappingSkipped({ label: 'Unused 5', register: 5 }), true);
  assert.equal(sb.isMappingSkipped({ label: 'unused', register: 5 }), true);
  assert.equal(sb.isMappingSkipped({ label: '38 Big Fan', enabled: false }), true);
  assert.equal(sb.isMappingSkipped({ label: '38 Big Fan' }), false);
  assert.equal(sb.isMappingSkipped({ name: 'Relay 6' }), false);
});

test('parseTs handles SQLite datetime(now) and ISO strings', () => {
  assert.equal(sb.parseTs('2026-09-24 11:05:36'), Date.parse('2026-09-24T11:05:36Z'));
  assert.equal(sb.parseTs('2026-09-24T11:07:19.775Z'), Date.parse('2026-09-24T11:07:19.775Z'));
  assert.equal(sb.parseTs(null), null);
  assert.equal(sb.parseTs('garbage'), null);
});

test('buildRelayGroups counts on/total and reads cached states for a healthy board', () => {
  const groups = groupMap(sb.buildRelayGroups([board()], () => null, NOW));
  assert.equal(groups.big_fans.total, 2);
  assert.equal(groups.big_fans.on, 1);
  assert.equal(groups.big_fans.unknown, 0);
  assert.deepEqual(groups.big_fans.channels.map(c => c.state), [true, false]);
  assert.equal(groups.small_fans.on, 1);
  assert.equal(groups.shades_open.channels[0].state, false);
  assert.equal(groups.shades_close.channels[0].state, true);
  assert.equal(groups.irrigation.total, 0);
  assert.equal(groups.other.total, 0);
  // every channel reports confirmed when state known and no failed write recorded
  for (const g of Object.values(groups)) for (const c of g.channels) assert.equal(c.confirmed, true);
});

test('buildRelayGroups skips disabled mappings and Unused labels', () => {
  const b = board({
    register_mappings: JSON.stringify([
      { label: '38 Big Fan', type: 'coil', register: 1, access: 'readwrite' },
      { label: 'Unused 5', type: 'coil', register: 5, access: 'readwrite', enabled: false },
      { label: '13 Small Fan', type: 'coil', register: 3, access: 'readwrite', enabled: false },
      { label: 'Unused 6', type: 'coil', register: 6, access: 'readwrite' },
    ]),
  });
  const groups = groupMap(sb.buildRelayGroups([b], () => null, NOW));
  assert.equal(groups.big_fans.total, 1);
  assert.equal(groups.small_fans.total, 0);
  assert.equal(groups.other.total, 0);
});

for (const [label, overrides, reason] of [
  ['disabled equipment', { enabled: 0 }, 'disabled'],
  ['write_only equipment', { write_only: 1 }, 'write_only'],
  ['offline equipment', { status: 'offline' }, 'offline'],
  ['stale last_communication (> 3x poll, 90 s floor)', { last_communication: iso(91000) }, 'stale'],
  ['missing last_communication', { last_communication: null }, 'stale'],
]) {
  test(`unknown state: ${label} -> state null (never false), unknown counted`, () => {
    const groups = groupMap(sb.buildRelayGroups([board(overrides)], () => null, NOW));
    assert.equal(sb.channelUnknownReason(board(overrides), NOW), reason);
    for (const g of Object.values(groups)) {
      for (const c of g.channels) {
        assert.equal(c.state, null, `${g.key} ch ${c.channel} must be null`);
        assert.equal(c.confirmed, false);
        assert.equal(c.unknownReason, reason);
      }
      assert.equal(g.on, 0);
      assert.equal(g.unknown, g.total);
    }
    // cached true values must not leak as "on"
    assert.equal(groups.big_fans.on, 0);
  });
}

test('last_communication within the 90 s floor is still fresh (one missed 15 s poll never flips a tile); SQLite-format timestamps accepted', () => {
  // 3 x 15 s = 45 s, but the floor is 90 s: 31 s (one missed poll) and exactly 90 s are both fresh
  assert.equal(sb.channelUnknownReason(board({ last_communication: iso(31000) }), NOW), null);
  const fresh = board({ last_communication: iso(90000) });
  assert.equal(sb.channelUnknownReason(fresh, NOW), null);
  const sqlite = board({ last_communication: new Date(NOW - 1000).toISOString().replace('T', ' ').slice(0, 19) });
  assert.equal(sb.channelUnknownReason(sqlite, NOW), null);
});

test('buildRelayGroups attaches last event ts/source and flags an unconfirmed last write', () => {
  const lastEventFor = (eqId, ch) => (ch === 1
    ? { state: 1, source: 'automation', created_at: '2026-09-24 11:00:22', confirmed: 0 }
    : ch === 2 ? { state: 0, source: 'manual', created_at: '2026-09-24 10:00:00', confirmed: 1 } : null);
  const groups = groupMap(sb.buildRelayGroups([board()], lastEventFor, NOW));
  const [ch1, ch2] = groups.big_fans.channels;
  assert.equal(ch1.confirmed, false);
  assert.equal(ch1.state, true); // state still comes from the cache
  assert.equal(ch1.lastChangeTs, '2026-09-24T11:00:22.000Z');
  assert.equal(ch1.source, 'automation');
  assert.equal(ch2.confirmed, true);
  assert.equal(ch2.source, 'manual');
  assert.equal(groups.small_fans.channels[0].lastChangeTs, null);
});

test('isStale: 3x poll interval with a 90 s floor, or 5 min when the interval is unknown', () => {
  assert.equal(sb.staleLimitMs(30000), 90000);
  assert.equal(sb.staleLimitMs(15000), 90000);   // floor
  assert.equal(sb.staleLimitMs(60000), 180000);
  assert.equal(sb.staleLimitMs(null), sb.DEFAULT_STALE_MS);
  // one missed 30 s poll (61 s) is NOT stale any more; two missed polls (91 s) is
  assert.equal(sb.isStale(NOW - 61000, 30000, NOW), false);
  assert.equal(sb.isStale(NOW - 89000, 30000, NOW), false);
  assert.equal(sb.isStale(NOW - 91000, 30000, NOW), true);
  assert.equal(sb.isStale(NOW - 4 * 60000, null, NOW), false);
  assert.equal(sb.isStale(NOW - 6 * 60000, null, NOW), true);
  assert.equal(sb.isStale(null, 30000, NOW), true);
});

test('buildClimate reads values, averages substrate temp, excludes disabled equipment, flags stale', () => {
  const rows = [
    { id: 8, enabled: 1, polling_interval_ms: 30000, last_communication: iso(5000),
      last_reading: JSON.stringify({ values: { Temperature: { value: 30.9, unit: '°C' }, Humidity: { value: 83.2, unit: '%' }, 'VPD Leaf': { value: 0.27, unit: 'kPa' } } }) },
    { id: 9, enabled: 0, polling_interval_ms: 30000, last_communication: iso(5000),
      last_reading: JSON.stringify({ values: { Temperature: { value: 99, unit: '°C' } } }) },
    { id: 7, enabled: 1, polling_interval_ms: 30000, last_communication: iso(5000),
      last_reading: JSON.stringify({ values: { 'Substrate Temperature': { value: 30, unit: '°C' }, 'Substrate Moisture': { value: 40.5, unit: '%' }, 'Pore EC': { value: 1536, unit: 'µS/cm' } } }) },
    { id: 12, enabled: 1, polling_interval_ms: 30000, last_communication: iso(100000),
      last_reading: JSON.stringify({ values: { 'Substrate Temperature': { value: 32, unit: '°C' }, 'Substrate Moisture': { value: 44, unit: '%' } } }) },
    { id: 17, enabled: 1, polling_interval_ms: 30000, last_communication: iso(5000),
      last_reading: JSON.stringify({ values: { pH: { value: 5.39, unit: 'pH' }, 'Water EC': { value: 1612.6, unit: 'µS/cm' }, 'Water Temperature': { value: 35.3, unit: '°C' } } }) },
  ];
  const climate = Object.fromEntries(sb.buildClimate(rows, NOW).map(c => [c.key, c]));
  assert.equal(climate.temp_shielded.value, 30.9);
  assert.equal(climate.temp_shielded.stale, false);
  assert.equal(climate.temp_shielded.pollMs, 30000);
  assert.equal(climate.temp_shielded.equipment_id, 8);
  assert.equal(climate.rh.value, 83.2);
  assert.equal(climate.vpd_leaf.value, 0.27);
  // disabled exposed sensor is excluded -> null value, stale
  assert.equal(climate.temp_exposed.value, null);
  assert.equal(climate.temp_exposed.stale, true);
  // substrate temp = mean of 7 and 12; sensor 12 is stale (100 s > 3x30 s) so the tile is stale
  assert.equal(climate.substrate_temp.value, 31);
  assert.deepEqual(climate.substrate_temp.equipment_id, [7, 12]);
  assert.equal(climate.substrate_temp.stale, true);
  assert.equal(climate.substrate_moisture_far.value, 40.5);
  assert.equal(climate.substrate_moisture_near.value, 44);
  assert.equal(climate.substrate_moisture_near.stale, true);
  assert.equal(climate.pore_ec_far.value, 1536);
  assert.equal(climate.pore_ec_near.value, null);
  assert.equal(climate.water_ph.value, 5.39);
  assert.equal(climate.water_ec.value, 1612.6);
  assert.equal(climate.water_temp.value, 35.3);
  assert.equal(sb.buildClimate(rows, NOW).length, sb.CLIMATE_SPEC.length);
});

test('triggerTypeFromLogMessage parses the scheduler prefix', () => {
  assert.equal(sb.triggerTypeFromLogMessage('scheduler trigger executed'), 'scheduler');
  assert.equal(sb.triggerTypeFromLogMessage('watchdog_rearm trigger executed (2 skipped)'), 'watchdog_rearm');
  assert.equal(sb.triggerTypeFromLogMessage('something else'), null);
});
