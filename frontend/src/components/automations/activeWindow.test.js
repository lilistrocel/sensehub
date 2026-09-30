import { describe, it, expect } from 'vitest';
import { describeSchedule, nextScheduleRun } from './automationSummary';

// Dated activation (operator request 2026-09-30: new irrigation program from 2026-10-01,
// today's runs untouched): shown in the schedule text; the next run honours the window.
describe('schedule active window', () => {
  const newRun = { type: 'schedule', schedule_type: 'daily', time: '08:45', active_from: '2026-10-01' };
  const oldRun = { type: 'schedule', schedule_type: 'daily', time: '13:45', active_until: '2026-09-30' };
  it('describes from / until', () => {
    expect(describeSchedule(newRun)).toMatch(/08:45.*from 1 Oct/);
    expect(describeSchedule(oldRun)).toMatch(/13:45.*until 30 Sep/);
    expect(describeSchedule({ type: 'schedule', schedule_type: 'daily', time: '07:30' })).not.toMatch(/from|until/);
  });
  it('next run: not before active_from, none after active_until', () => {
    const now = new Date(2026, 8, 30, 14, 0);
    const n = nextScheduleRun(newRun, now);
    expect([n.getFullYear(), n.getMonth(), n.getDate(), n.getHours(), n.getMinutes()]).toEqual([2026, 9, 1, 8, 45]);
    expect(nextScheduleRun(oldRun, new Date(2026, 8, 30, 13, 0)).getHours()).toBe(13);
    expect(nextScheduleRun(oldRun, now)).toBeNull();
    const later = nextScheduleRun(newRun, new Date(2026, 9, 5, 9, 0));
    expect(later.getDate()).toBe(6);
  });
});
