# AMIC: Persistent cycle timer

## Problem

The AMIC analyzer page (`frontend/src/pages/Amic.jsx`) shows an elapsed/remaining timer for the active cycle (Measure ~5min, Calibration ~20min, Conditioning ~120min, etc). The timer is wrong in three scenarios:

1. **Page reload during a cycle** — `cycleStartTime` is React component state. Reload loses it. Next poll detects the cycle is still running and stamps `Date.now()`, restarting the elapsed counter from 00:00.
2. **Cycle started from the AMIC's front panel** — SenseHub didn't issue the command, so it has no timestamp. First poll that sees the state flag stamps "now", undercounting elapsed time by however long the cycle has already been running.
3. **Backend restart during a cycle** — same as (2) once a fresh client session opens.

## Root cause (current code)

`Amic.jsx:51-68` and `Amic.jsx:100-115`:

```jsx
// Poll-based detection: stamps Date.now() the first time we see a flag set
if (isRunning && !cycleStartTime) setCycleStartTime(Date.now());
else if (!isRunning && cycleStartTime) setCycleStartTime(null);

// Action-based detection (in runAction):
setCycleStartTime(Date.now());
```

Cycle expected durations are also hardcoded twice (in `currentCycle` mapping at `Amic.jsx:163-172` and inside the `runAction` confirm prompts).

## Proposed fix

Track cycle start time persistently on the **backend** and surface it in the `/api/amic/status` response. The frontend becomes a pure consumer of that timestamp.

### Backend changes

#### 1. New `system_settings` key: `amic_current_cycle`

Stores the currently active cycle (or absent if idle):

```json
{
  "state": "conditioning",
  "started_at": "2026-05-02T13:42:11.000Z",
  "expected_duration_min": 120,
  "source": "sensehub"
}
```

`source` values:
- `"sensehub"` — stamped at the moment a SenseHub trigger endpoint was called (most accurate)
- `"panel"` — detected from a 0→1 transition during a status poll while no SenseHub trigger preceded it (cycle was started from the AMIC's front panel)
- `"unknown"` — set on backend startup if a cycle is observed but no prior row exists (use this to suppress the "remaining" estimate in the UI)

#### 2. `AmicService.js` — write the entry on trigger

In `triggerMeasure`, `triggerCalibrate`, `triggerCondition`, `triggerDrain`, `triggerEmptySystem`, **before** the coil-write call returns, persist:

```js
this._setCurrentCycle({
  state: <name>,        // 'measuring', 'calibrating', etc
  started_at: new Date().toISOString(),
  expected_duration_min: EXPECTED_DURATIONS[<name>],
  source: 'sensehub'
});
```

`EXPECTED_DURATIONS` constant (single source of truth):

```js
const EXPECTED_DURATIONS = {
  measuring:    5,
  calibrating:  20,
  draining:     1,
  empty_system: 5,
  conditioning: 120,
};
```

#### 3. `AmicService.getStatus()` — detect transitions during polls

After reading discrete inputs, compute the active state name (or null if idle) and reconcile against the stored `amic_current_cycle`:

- **No prior row, device idle** → no-op
- **No prior row, device running cycle X** → write `{ state: X, started_at: now(), source: 'panel' }`
- **Prior row matches device state** → no-op
- **Prior row differs from device state** → overwrite with the new state, source `'panel'` (rare: e.g. one cycle ended and another began between polls)
- **Prior row exists, device idle** → clear the row (cycle complete)

This handles AMIC-panel-initiated cycles within one poll interval.

#### 4. `getStatus()` returns `current_cycle` to the API

Append to the existing return shape:

```js
return {
  connected: true,
  host: ...,
  state: { ... },
  // ... existing fields ...
  current_cycle: this._getCurrentCycle()  // null if idle, else the persisted object
};
```

#### 5. Backend boot — graceful recovery

On `AmicService` constructor or first `getStatus()` after boot, if a cycle is observed but no row exists in `system_settings`, write `{ state, started_at: now(), source: 'unknown', expected_duration_min }`. The frontend will treat `source: 'unknown'` as "elapsed/remaining are estimates from the moment SenseHub started watching" and de-emphasize the countdown.

### Frontend changes (`Amic.jsx`)

1. **Delete `cycleStartTime` state** and the related setters at lines 61–62 and 108.

2. **Compute elapsed/remaining from `status.current_cycle`:**

```jsx
const cc = status?.current_cycle;
const startedAt = cc?.started_at ? new Date(cc.started_at) : null;
const elapsedSec = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
const expectedSec = (cc?.expected_duration_min ?? 0) * 60;
const remainingSec = Math.max(0, expectedSec - elapsedSec);
```

3. **`currentCycle` derives from `status.current_cycle`** instead of state flags. Keep the color/label mapping but read `name` and `expected_duration_min` from the API response. Remove the duplicated expected-duration constants.

4. **UI: progress bar + countdown:**
   - Show `MM:SS` elapsed (large, monospace, as today)
   - Add a thin progress bar showing `elapsedSec / expectedSec` (clamped to 100%)
   - Add a "~X min remaining" label
   - If `source === 'unknown'`, hide the remaining label, keep the progress bar at indeterminate (or just show "elapsed since SenseHub detected cycle")
   - If elapsed exceeds expected by >50%, show an amber "running longer than expected" hint instead of the remaining label

5. **`runAction` still optimistically refreshes status after 2s**, but the timer no longer depends on a local timestamp — the next status response carries the authoritative `current_cycle`.

## Out of scope

- Persisting full cycle history (start time, end time, success/error) — that's a separate feature for long-term monitoring/charts.
- Notifying users when a cycle finishes — separate feature, can build on top of the transition-detection logic added here.
- Auto-recovering from a wedged cycle (state stuck at 1 indefinitely) — separate concern.

## Test plan

- [ ] Start Measure from SenseHub → reload page mid-cycle → elapsed continues from the right value, not from 00:00
- [ ] Start Conditioning from the AMIC's panel → SenseHub detects within ≤15s and shows a roughly-accurate elapsed time labelled with `source: panel`
- [ ] Restart the backend mid-cycle → frontend shows `source: unknown` until cycle ends; elapsed reads from the recovery stamp
- [ ] Cycle completes naturally → `amic_current_cycle` row is cleared, frontend banner returns to "Idle / Ready"
- [ ] Two browser tabs open during the same cycle → both show identical elapsed/remaining (within polling jitter)
- [ ] Trigger Measure twice in quick succession → second trigger overwrites the row with a fresh `started_at`

## Files touched

- `backend/src/services/AmicService.js` — add `EXPECTED_DURATIONS`, `_getCurrentCycle()`, `_setCurrentCycle()`, `_clearCurrentCycle()`, transition detection in `getStatus()`, stamp on each trigger method
- `backend/src/utils/database.js` — no schema change (uses existing `system_settings` table)
- `frontend/src/pages/Amic.jsx` — delete `cycleStartTime` state, drive timer from `status.current_cycle`, add progress bar
