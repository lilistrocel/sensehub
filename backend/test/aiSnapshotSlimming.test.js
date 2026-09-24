const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const S = require(path.join(__dirname, '..', 'src', 'services', 'AiSnapshotSlimming.js'));

const NOW = '2026-07-01T20:00:00Z';
const daysAgo = n => new Date(Date.parse(NOW) - n * 86400_000).toISOString().replace('T', ' ').slice(0, 19);

// ---------------------------------------------------------------------------
// operator_tasks filtering / capping
// ---------------------------------------------------------------------------

test('slimOperatorTasks keeps only open/snoozed tasks from the last 7 days, max 10, five fields', () => {
  const tasks = [];
  // 12 open tasks within the window (should cap to 10)
  for (let i = 0; i < 12; i++) {
    tasks.push({ id: i, title: `open ${i}`, priority: i % 2 ? 'high' : 'low', category: 'physical', status: 'open',
      created_at: daysAgo(i % 6), description: 'x'.repeat(500), instructions: 'y'.repeat(2000) });
  }
  tasks.push({ id: 100, title: 'old open', priority: 'critical', category: 'physical', status: 'open', created_at: daysAgo(8) });
  tasks.push({ id: 101, title: 'done recent', priority: 'high', category: 'physical', status: 'done', created_at: daysAgo(1) });
  tasks.push({ id: 102, title: 'declined recent', priority: 'high', category: 'physical', status: 'declined', created_at: daysAgo(1) });
  tasks.push({ id: 103, title: 'archived', priority: 'high', category: 'physical', status: 'archived', created_at: daysAgo(1) });
  tasks.push({ id: 104, title: 'snoozed recent', priority: 'medium', category: 'measurement', status: 'snoozed', created_at: daysAgo(2) });

  const out = S.slimOperatorTasks(tasks, { now: NOW });
  assert.equal(out.length, 10);
  for (const t of out) {
    assert.deepEqual(Object.keys(t).sort(), ['category', 'created_at', 'priority', 'status', 'title']);
    assert.ok(['open', 'snoozed'].includes(t.status));
    assert.ok(Date.parse(t.created_at.replace(' ', 'T') + 'Z') >= Date.parse(NOW) - 7 * 86400_000);
  }
  assert.ok(!out.find(t => t.title === 'old open'), 'task older than 7 days dropped');
  assert.ok(!out.find(t => ['done recent', 'declined recent', 'archived'].includes(t.title)));
  // open ones sort before snoozed; high priority before low
  assert.equal(out[0].status, 'open');
  assert.equal(out[0].priority, 'high');
});

test('slimOperatorTasks handles empty / bad input', () => {
  assert.deepEqual(S.slimOperatorTasks(null), []);
  assert.deepEqual(S.slimOperatorTasks([{ status: 'open', created_at: 'garbage' }], { now: NOW }), []);
});

// ---------------------------------------------------------------------------
// compact automation formatting
// ---------------------------------------------------------------------------

const eqIndex = { 1: { name: 'Waveshare Irrigation 1', channels: { 1: 'Irrigation Pump', 3: 'Irrigation Zone 1', 4: 'Irrigation Zone 2' } } };

test('compactAutomation renders trigger/actions one-liners and dependency count, no raw JSON', () => {
  const a = {
    id: 66, name: 'Fertigation 07:00', enabled: 1, priority: 2, template_id: 20, dose_program_id: 5, last_run: '2026-07-01 03:00:00',
    trigger_config: { type: 'schedule', schedule_type: 'daily', time: '07:00' },
    conditions: [{ x: 1 }],
    actions: [
      { type: 'control', action: 'on', equipment_id: 1, channel: 1, duration_seconds: 480 },
      { type: 'control', action: 'on', equipment_id: 1, channel: 3, delay_seconds: 0, duration_seconds: 240, dependencies: [{ a: 1 }, { b: 2 }] },
      { type: 'control', action: 'on', equipment_id: 1, channel: 4, delay_seconds: 240, duration_seconds: 240, dependencies: [{ c: 3 }] },
    ],
  };
  const c = S.compactAutomation(a, eqIndex);
  assert.equal(c.id, 66);
  assert.equal(c.enabled, true);
  assert.equal(c.trigger, 'schedule daily at 07:00');
  assert.equal(c.actions, 'eq#1 Waveshare Irrigation 1: ch1 Irrigation Pump on 480s, ch3 Irrigation Zone 1 on 240s, ch4 Irrigation Zone 2 on 240s @+240s');
  assert.equal(c.dependencies, 3);
  assert.equal(c.action_count, 3);
  assert.equal(c.conditions, 1);
  assert.equal(c.template_id, 20);
  assert.equal(c.dose_program_id, 5);
  assert.ok(!('trigger_config' in c));
  assert.equal(typeof c.actions, 'string');
  assert.ok(JSON.stringify(c).length < JSON.stringify(a).length);
});

test('triggerOneLiner covers threshold / manual / interval / unknown', () => {
  assert.equal(S.triggerOneLiner({ type: 'threshold', equipment_id: '8', sensor_type: 'Temperature', operator: 'gt', threshold_value: '35', unit: '°C' }),
    'threshold eq#8 Temperature gt 35 °C');
  assert.equal(S.triggerOneLiner({ type: 'manual' }), 'manual');
  assert.equal(S.triggerOneLiner({ type: 'schedule', schedule_type: 'interval', interval_minutes: 90 }), 'schedule every 90 min');
  assert.match(S.triggerOneLiner({ type: 'weird', foo: 'bar' }), /^weird \{"foo":"bar"\}$/);
  assert.equal(S.triggerOneLiner(null), 'unknown');
});

test('actionsOneLiner groups by equipment, uses channel_name fallback, handles off/transition', () => {
  const s = S.actionsOneLiner([
    { type: 'control', action: 'off', equipment_id: 2, channel: 1, channel_name: 'Ingredient 1' },
    { type: 'control', action: 'off', equipment_id: 2, channel: 2 },
    { type: 'transition', equipment_id: 1, delay_seconds: 10, transitions: [{ channel: 3, state: true }, { channel: 4, state: false }] },
  ], eqIndex);
  assert.equal(s, 'eq#2: ch1 Ingredient 1 off, ch2 off | eq#1 Waveshare Irrigation 1: transition [ch3 Irrigation Zone 1 on, ch4 Irrigation Zone 2 off] @+10s');
  assert.equal(S.actionsOneLiner([]), 'none');
});

// ---------------------------------------------------------------------------
// planner dedupe
// ---------------------------------------------------------------------------

test('dedupePlannerContext keeps one copy of operator_tasks (top level) and sensors/lab (today_snapshot)', () => {
  const ctx = {
    today: '2026-06-27',
    operator_tasks: [{ title: 'top' }],
    sensors: [{ dup: true }],
    lab: { dup: true },
    today_snapshot: {
      date: '2026-06-27',
      operator_tasks: [{ title: 'inner' }],
      sensors: [{ inner: true }],
      lab: { inner: true },
    },
  };
  S.dedupePlannerContext(ctx);
  assert.deepEqual(ctx.operator_tasks, [{ title: 'top' }]);
  assert.ok(!('operator_tasks' in ctx.today_snapshot));
  assert.ok(!('sensors' in ctx));
  assert.ok(!('lab' in ctx));
  assert.deepEqual(ctx.today_snapshot.sensors, [{ inner: true }]);
  assert.deepEqual(ctx.today_snapshot.lab, { inner: true });
});

test('dedupePlannerContext promotes inner operator_tasks when no top-level copy exists', () => {
  const ctx = { today_snapshot: { operator_tasks: [{ title: 'inner' }], lab: {} } };
  S.dedupePlannerContext(ctx);
  assert.deepEqual(ctx.operator_tasks, [{ title: 'inner' }]);
  assert.ok(!('operator_tasks' in ctx.today_snapshot));
  assert.equal(S.dedupePlannerContext(null), null);
});

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

test('sectionStats reports chars per top-level key and a total, ignoring snapshot_stats', () => {
  const st = S.sectionStats({ a: [1, 2, 3], b: 'hello', snapshot_stats: { old: 1 } });
  assert.equal(st.a, JSON.stringify([1, 2, 3], null, 2).length);
  assert.equal(st.b, '"hello"'.length);
  assert.ok(!('snapshot_stats' in st));
  assert.equal(st._total, st.a + st.b);
});
