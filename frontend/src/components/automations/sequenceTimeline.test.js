import { describe, it, expect } from 'vitest';
import { buildSequence, buildEquipmentIndex } from './automationSummary';

const EQ = [{
  id: 1, name: 'Waveshare Irrigation 1',
  register_mappings: JSON.stringify(['Irrigation Pump', 'Mixing Pump', 'Irrigation Zone 1', 'Irrigation Zone 2', 'Irrigation Zone 3', 'Irrigation Zone 4']
    .map((name, i) => ({ name, register: String(i + 1), type: 'coil', access: 'readwrite' }))),
}];

// Soft-switch automation 97 (4.5 min zones, lead 3 s, lag 5 s, gap 1 s) as built by
// backend/scripts/soft-switch-sequences.js
function softSwitch(D = 270, lead = 3, lag = 5, gap = 1) {
  const out = [];
  let t0 = 0;
  for (const ch of [3, 4, 5, 6]) {
    out.push({ type: 'control', action: 'on', equipment_id: 1, channel: ch, delay_seconds: t0, duration_seconds: D + lead + lag });
    out.push({ type: 'control', action: 'on', equipment_id: 1, channel: 1, delay_seconds: t0 + lead, duration_seconds: D });
    out.push({ type: 'control', action: 'on', equipment_id: 1, channel: 2, delay_seconds: t0 + lead, duration_seconds: D });
    t0 += D + lead + lag + gap;
  }
  return out;
}

describe('buildSequence with soft-switch runs', () => {
  const idx = buildEquipmentIndex(EQ);

  it('pumps only run while a zone is open: no dead-heading warning, no zone overlap', () => {
    const seq = buildSequence(softSwitch(), idx);
    expect(seq.show).toBe(true);
    expect(seq.gaps).toEqual([]);
    expect(seq.overlaps).toEqual([]);
    expect(seq.pumpCovered).toBe(true);
    expect(seq.total).toBe(1115);
  });

  it('groups the 12 actions into one row per channel (pumps with four windows)', () => {
    const seq = buildSequence(softSwitch(), idx);
    expect(seq.items).toHaveLength(12);
    expect(seq.rows.map(r => r.label)).toEqual(['Irrigation Zone 1', 'Irrigation Pump', 'Mixing Pump', 'Irrigation Zone 2', 'Irrigation Zone 3', 'Irrigation Zone 4']);
    const pump = seq.rows.find(r => r.label === 'Irrigation Pump');
    expect(pump.segments.map(s => [s.start, s.end])).toEqual([[3, 273], [282, 552], [561, 831], [840, 1110]]);
    expect(pump.start).toBe(3);
    expect(pump.end).toBe(1110);
  });

  it('the old structure (pump for the whole run) still groups one row per action and stays green', () => {
    const old = [
      { type: 'control', action: 'on', equipment_id: 1, channel: 1, duration_seconds: 600 },
      ...[3, 4, 5, 6].map((ch, i) => ({ type: 'control', action: 'on', equipment_id: 1, channel: ch, delay_seconds: i * 150, duration_seconds: 150 })),
    ];
    const seq = buildSequence(old, idx);
    expect(seq.rows).toHaveLength(5);
    expect(seq.pumpCovered).toBe(true);
  });

  it('a pump window with no zone open is still flagged', () => {
    const acts = softSwitch();
    acts.push({ type: 'control', action: 'on', equipment_id: 1, channel: 1, delay_seconds: 1200, duration_seconds: 60 });
    const seq = buildSequence(acts, idx);
    expect(seq.gaps).toHaveLength(1);
    expect(seq.gaps[0].start).toBe(1200);
  });
});

describe('summary of a soft-switch run', () => {
  it('says the pumps run once per zone, not once', async () => {
    const { describeWhat } = await import('./automationSummary');
    const text = describeWhat(softSwitch(), buildEquipmentIndex(EQ));
    expect(text).toContain('irrigation zones 1→4 ON 4 min 38 s each, in sequence');
    expect(text).toContain('Irrigation Pump ON 4 min 30 s × 4, first after 3 s');
    expect(text).toContain('Mixing Pump ON 4 min 30 s × 4, first after 3 s');
  });
});
