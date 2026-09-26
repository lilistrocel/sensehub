import { describe, it, expect } from 'vitest';
import {
  deriveIrrigationView,
  mergeFlowPoints,
  noFlowForS,
  splitTankName,
  configFlowLph,
  formatDuration,
} from './irrigationLive';

const NOW = Date.parse('2026-09-26T09:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

function board({ zones = [false, false, false, false], pumps = [false, false], tanks = [false, false, false, false, false], zoneChange = 5 * 60000 } = {}) {
  const ch = (equipment_id, channel, label, state, ago) => ({ equipment_id, channel, label, state, confirmed: state !== null, lastChangeTs: ago == null ? null : iso(ago) });
  return {
    relayGroups: [{
      key: 'irrigation',
      channels: [
        ch(1, 1, 'Irrigation Pump', pumps[0]),
        ch(1, 2, 'Mixing Pump', pumps[1]),
        ...zones.map((s, i) => ch(1, 3 + i, `Irrigation Zone ${i + 1}`, s, zoneChange)),
        ch(2, 1, 'pH Down (Tank 5)', tanks[4]),
        ...tanks.slice(0, 4).map((s, i) => ch(2, 2 + i, `Tank ${'ABCD'[i]}`, s)),
      ],
    }],
  };
}

const channelConfig = [
  ...[3, 4, 5, 6].map((c) => ({ equipment_id: 1, channel: c, flow_rate: 146.99, flow_unit: 'L/min' })),
  { equipment_id: 2, channel: 1, tank_id: 5, flow_rate: 1, flow_unit: 'L/min' },
  ...[1, 2, 3, 4].map((t) => ({ equipment_id: 2, channel: t + 1, tank_id: t, flow_rate: 1, flow_unit: 'L/min' })),
];

function monitor({ flow = 8850, active = true, rates = [70, 90, 70, 60, null], ageMs = 1000, signal = 88, flags = 0 } = {}) {
  return {
    farm_id: '1021', equipment_id: 19, enabled: true, status: 'online',
    last_seen: iso(ageMs), age_s: 0, broker_state: 'online',
    irrigation: { active, since: iso(6 * 60000) },
    flowmeter: { flow_lph: flow, net_total_m3: 77.19, signal_quality: signal, error_flags: flags, ts: iso(ageMs), received_at: iso(ageMs) },
    dosing: { tanks: rates.map((r, i) => ({ id: i + 1, consumed_l: 10, rate_lph: r })), ts: iso(ageMs), received_at: iso(ageMs) },
    last_cycle: null,
  };
}

const bufferConst = (v, fromAgoMs = 9 * 60000) => [{ t: NOW - fromAgoMs, v }, { t: NOW - 1000, v }];

describe('irrigationLive helpers', () => {
  it('parses tank names and flow units', () => {
    expect(splitTankName('Tank A — Calcium nitrate', 1)).toEqual({ letter: 'A', desc: 'Calcium nitrate' });
    expect(splitTankName('Tank 5 — pH Down', 5)).toEqual({ letter: '5', desc: 'pH Down' });
    expect(configFlowLph({ flow_rate: 146.99, flow_unit: 'L/min' })).toBeCloseTo(8819.4, 1);
    expect(configFlowLph({ flow_rate: 0 })).toBeNull();
    expect(formatDuration(372)).toBe('6 min 12 s');
  });

  it('keeps the ring buffer to the window (plus one leading point)', () => {
    const b = mergeFlowPoints([], [{ t: NOW - 20 * 60000, v: 1 }, { t: NOW - 12 * 60000, v: 2 }, { t: NOW - 60000, v: 3 }], NOW);
    expect(b.map((p) => p.v)).toEqual([2, 3]);
  });

  it('measures how long flow has been below the threshold', () => {
    const b = [{ t: NOW - 120000, v: 8800 }, { t: NOW - 40000, v: 0 }, { t: NOW - 1000, v: 0 }];
    expect(noFlowForS(b, NOW)).toBeCloseTo(40, 0);
    expect(noFlowForS([{ t: NOW - 1000, v: 9000 }], NOW)).toBe(0);
  });

  it('irrigating normally: water rail, expected flow, no hints', () => {
    const v = deriveIrrigationView({ monitor: monitor(), board: board({ zones: [true, false, false, false], pumps: [true, true], tanks: [true, true, true, true, false] }), channelConfig, report: null, flowBuffer: bufferConst(8850), serverNowMs: NOW });
    expect(v.headline.text).toBe('Irrigating');
    expect(v.rail).toBe('water');
    expect(v.openZones.map((z) => z.label)).toEqual(['Zone 1']);
    expect(Math.round(v.flow.expectedLph)).toBe(8819);
    expect(v.hints).toEqual([]);
    expect(v.tanks.find((t) => t.monitorTank === 5).metered).toBe(false);
  });

  it('zone ON, flow 0, tanks dosing: caution + alarm hints, alarm rail', () => {
    const buf = [{ t: NOW - 5 * 60000, v: 8800 }, { t: NOW - 60000, v: 0 }, { t: NOW - 1000, v: 0 }];
    const v = deriveIrrigationView({ monitor: monitor({ flow: 0 }), board: board({ zones: [true, false, false, false], pumps: [true, true], tanks: [true, true, true, true, false] }), channelConfig, report: null, flowBuffer: buf, serverNowMs: NOW });
    const keys = v.hints.map((h) => h.key);
    expect(keys).toContain('zone-no-flow');
    expect(keys[0]).toBe('dosing-no-flow');
    expect(v.rail).toBe('alarm');
    expect(v.tanks.filter((t) => t.alarm).map((t) => t.letter)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('does not flag no-flow inside the grace period', () => {
    const buf = [{ t: NOW - 5 * 60000, v: 8800 }, { t: NOW - 8000, v: 0 }];
    const v = deriveIrrigationView({ monitor: monitor({ flow: 0, rates: [0, 0, 0, 0, null] }), board: board({ zones: [true, false, false, false] }), channelConfig, report: null, flowBuffer: buf, serverNowMs: NOW });
    expect(v.hints).toEqual([]);
  });

  it('flow with no zone open -> caution; unknown valves -> no claim', () => {
    const v = deriveIrrigationView({ monitor: monitor({ active: false }), board: board({ zoneChange: 60000 }), channelConfig, report: null, flowBuffer: bufferConst(8850), serverNowMs: NOW });
    expect(v.hints.map((h) => h.key)).toContain('flow-no-zone');
    const u = deriveIrrigationView({ monitor: monitor({ active: false }), board: board({ zones: [null, null, null, null] }), channelConfig, report: null, flowBuffer: bufferConst(8850), serverNowMs: NOW });
    expect(u.hints).toEqual([]);
  });

  it('stale monitor renders unknown, never irrigating or a number', () => {
    const v = deriveIrrigationView({ monitor: monitor({ ageMs: 5 * 60000 }), board: board({ zones: [true, false, false, false] }), channelConfig, report: null, flowBuffer: [], serverNowMs: NOW });
    expect(v.headline.text).toBe('Monitor stale');
    expect(v.headline.unknown).toBe(true);
    expect(v.rail).toBe('stale');
    expect(v.flow.lph).toBeNull();
    expect(v.tanks[0].rateLph).toBeNull();
    expect(v.tanks[0].rateStale).toBe(true);
  });

  it('meter fault on error flags or weak signal', () => {
    expect(deriveIrrigationView({ monitor: monitor({ flags: 4 }), board: null, channelConfig, report: null, flowBuffer: [], serverNowMs: NOW }).meterFault).toBe(true);
    expect(deriveIrrigationView({ monitor: monitor({ signal: 45 }), board: null, channelConfig, report: null, flowBuffer: [], serverNowMs: NOW }).faultReasons).toEqual(['signal 45 %']);
  });
});
