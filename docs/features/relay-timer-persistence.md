# Relay timer persistence (DB-backed `RelayTimerService`)

> **Status:** design only. This session shipped the safety watchdog (`RelaySafetyWatchdogService`) which mitigates the *safety* impact of lost timers; this doc covers the deeper *correctness* fix.

## Problem

`backend/src/services/RelayTimerService.js` stores all timers in a single in-memory `Map`. On any backend restart, crash, or container recreate, every pending timer is lost. The result: a fertigation that started 5 minutes before the restart leaves a zone or pump ON forever — until the safety watchdog catches it (now capped at 25 min by default) or an operator hits STOP.

The May 3 incident (CH3 on for 4h21m) and today's two bursts (during my deploys) all trace back to this.

## What the watchdog already gives us

- Hard upper bound on stuck-on duration (configurable, 25 min default).
- Alert + audit-log entry every time it forces a channel off.
- Manual "run now" button to verify nothing is stuck.

That's a safety net, not a correctness fix. A 4-min zone that gets force-OFFed at 25 min has still over-watered for 21 min. Persistence lets the OFF fire on time.

## Approach

Today, `scheduleOff` / `scheduleDelayedStart` / `scheduleDelayedRaw` accept arbitrary callbacks (closures over module state). That's why they can't be serialized.

The fix: introduce **structured task records** that the timer service can persist and rehydrate. Each task is one of:
- `relay_off`: flip a single coil OFF (most common — auto-off after duration)
- `relay_on`: flip a single coil ON (delayed-start)
- `transition`: write multiple coils via FC15 (the existing transition action)

Each task carries enough data (`equipment_id`, `channel(s)`, `value(s)`, `automation_id`) to be rehydrated into a runnable callback after a restart.

### Schema

```sql
CREATE TABLE relay_pending_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,            -- same key the in-memory Map uses
  task_type TEXT NOT NULL,             -- 'relay_off' | 'relay_on' | 'transition'
  payload TEXT NOT NULL,               -- JSON serialization of the task data
  fires_at TEXT NOT NULL,              -- ISO timestamp
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  attempts INTEGER DEFAULT 0,
  last_error TEXT
);
CREATE INDEX idx_relay_pending_tasks_fires_at ON relay_pending_tasks(fires_at);
```

### `RelayTimerService` becomes a thin wrapper

```js
class RelayTimerService {
  scheduleTask({ key, type, payload, delaySeconds }) {
    const firesAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
    db.prepare('INSERT OR REPLACE INTO relay_pending_tasks (key, task_type, payload, fires_at) VALUES (?, ?, ?, ?)')
      .run(key, type, JSON.stringify(payload), firesAt);
    this._armInMemory(key, delaySeconds);  // setTimeout that calls _runTask(key)
  }

  async _runTask(key) {
    const row = db.prepare('SELECT * FROM relay_pending_tasks WHERE key = ?').get(key);
    if (!row) return;  // already cancelled
    try {
      await this._executeByType(row.task_type, JSON.parse(row.payload));
      db.prepare('DELETE FROM relay_pending_tasks WHERE key = ?').run(key);
    } catch (err) {
      db.prepare('UPDATE relay_pending_tasks SET attempts = attempts + 1, last_error = ? WHERE key = ?')
        .run(err.message, key);
      // Retry with exponential backoff up to N attempts, then alert + give up
    }
  }

  cancelTimersByPrefix(prefix) {
    const rows = db.prepare("SELECT key FROM relay_pending_tasks WHERE key LIKE ? || '%'").all(prefix);
    for (const r of rows) {
      this._cancelInMemory(r.key);
      db.prepare('DELETE FROM relay_pending_tasks WHERE key = ?').run(r.key);
    }
    return rows.length;
  }

  /** Boot-time replay: rearm setTimeouts for every persisted task. */
  rehydrate() {
    const rows = db.prepare('SELECT * FROM relay_pending_tasks').all();
    const now = Date.now();
    for (const row of rows) {
      const firesAt = new Date(row.fires_at).getTime();
      const delay = Math.max(0, firesAt - now);
      if (delay === 0) {
        // We missed the deadline while the backend was down. Run immediately.
        // For safety: if it's a relay_off and it's MORE than X minutes overdue,
        // still run it (catches up from a long crash); the safety watchdog
        // would have done the same eventually anyway.
        this._runTask(row.key);
      } else {
        this._armInMemory(row.key, delay / 1000);
      }
    }
    console.log(`[RelayTimer] Rehydrated ${rows.length} pending task(s)`);
  }
}
```

Key invariant: **every armed setTimeout has a matching DB row, and vice versa.** Cancellation goes through both.

### Boot ordering

`RelayTimerService.rehydrate()` must run *after* `db` is open and *before* anything else schedules new tasks. Slot it right after the module is required in `index.js`, before `modbusPollingService.start()` (since polling can trigger automations that schedule new tasks).

### Cleanup

A daily cron prunes rows where `fires_at < now() - 1 day` to prevent table growth from stale entries (e.g. a removed automation whose tasks never fired and never got cancelled).

## What still doesn't survive a restart

Even with persistence, the *exact* moment of the OFF can drift slightly across a restart (we can't fire at the original µs precision). For relay control that's fine — sub-second drift is meaningless. Document this limitation.

Also: the AutomationExecutor's outer logic (the `executedActions` array, the post-run logging) lives in memory. If `executeAutomation` is mid-execution when the backend dies, the not-yet-scheduled tasks are lost. Practically this is rare because each task is scheduled almost immediately after the trigger fires.

## Interaction with the watchdog

Both work together:
- **Persistence** = the OFF fires on time (correctness).
- **Watchdog** = if the OFF fails for *any* reason (Modbus error, retry exhaustion, scheduling bug), the channel still doesn't stay on indefinitely (safety).

Once both are in place, irrigation/fertigation cycles should never visibly overrun outside their tolerance, and even pathological failures get bounded by the watchdog within minutes instead of hours.

## Effort estimate

- Schema + migration: ~30 min
- Refactor `RelayTimerService` to task-based API: ~2 hr
- Update all call sites (`AutomationExecutor`, anywhere that calls scheduleOff/scheduleDelayedStart/scheduleDelayedRaw): ~1 hr
- Rehydration + boot ordering: ~30 min
- Tests (manual: kill backend mid-cycle, verify recovery): ~30 min

Total: ~half-day's work. Not done in this session because the watchdog covers the safety case and rolling out a core scheduler change without quiet-time validation is risky on a live farm.
