# SenseHub — Farm App Standards

Nearly every rule here exists because something went wrong. The incident is named next to the rule — keep those notes. Dates are 2026-09-20 to 2026-09-24 unless stated.

Adapted from the Sova / GROWSPEC BioCube standards. Where the two apps differ, the SenseHub rule wins here.

---

## 1. The one rule

**Never let the app believe something about the farm that it has not verified.**

Every other rule is a special case: a relay state is what the coil read-back says, not what we commanded; a register map is what the controlled read returned, not what the datasheet said; an alert is a condition that is still true, not a log line; a dashboard card is a measurement with an age, not a decoration.

---

## 2. Data integrity

**2.1 Prefer the controlled read over the datasheet.** Read the map from the device against a physical reference before asserting it.
*Incident "SEKO answers FC04 only":* the documented map said FC03. The Kontrol 800 returned exception 6 (busy) on FC03 and only served measurements on FC04. Same family: Zhed soil meter temp at reg 19 not 5, SHT20 temp/RH swapped. Write the verified map into `SensorDocs/` and the memory note, not just the equipment row.

**2.2 Filter Modbus replies by transaction id AND unit.** The USR gateways (192.168.1.202 fan bus, 192.168.1.7 irrigation bus) echo every serial reply to every TCP client. When scanning, use a fresh socket per slave — the pooled connection in `ModbusTcpClient.js` (keyed by host:port) desyncs under a scan. The "dead" fan bus .202 was a slave-ID mismatch, not a dead bus.

**2.3 Dedupe alerts at creation, by fingerprint.** All new alerts go through `createAlert()` in `backend/src/utils/alertBroadcast.js`. It keys on `sha1(source|automation_id|equipment_id|message)` and updates the open row instead of inserting. Messages that embed a value or timestamp must pass an explicit stable `fingerprint`.
*Incident "alert storm":* 13,864 alerts, 5,479 copies of one message, no dedupe. The Alerts page rendered all of them: 24 MB DOM, 35 s. Fixed with fingerprinting, pagination and acknowledge-all.

```js
const { createAlert } = require('../utils/alertBroadcast');
createAlert({
  severity: 'warning', source: 'watchdog', equipment_id: eq.id,
  fingerprint: `equipment_offline:${eq.id}`,   // stable: no timestamp, no value
  message: `${eq.name} unreachable for ${minutes} min`,
});
```

**2.4 Keep enough history to diagnose.** The 14-day readings retention (`DataRetentionService.js`) is what let us reconstruct the pads loop and the rearm storm afterwards. Retention bounds the disk; it does not erase evidence.

**2.5 Commit safety-critical code the day it works.**
*Incident "3 months uncommitted":* ~1,550 lines — emergency stop, arming — ran in production for three months with no commit. Anything that can energise a coil is committed before the next deploy, with the incident named in the message.

---

## 3. Control and actuation

**3.1 SenseHub IS the controller; direct actuation is justified.** Relay boards are dumb Waveshare 6-ch Modbus coils (v2 firmware, `firmware/waveshare_modbus_slave/`) behind USR gateways. There is no supervisory setpoint layer, so writing coils directly from automations is correct. The failsafe stack is:

1. Firmware v2: all relays latch OFF after 60 s without a Modbus frame.
2. Persisted arming state (`AutomationArmingService.js`): a `system_settings` row, **fails stopped across restarts**, reports disarmed if unreadable.
3. `RelaySafetyWatchdogService.js`: max-on per relay (default 1,500 s) forces OFF anything past a legitimate cycle.

*Exceptions:* the SEKO Kontrol 800 (setpoint registers) and the AMIC analyser do have setpoints. There the Sova supervisory rule applies: write the setpoint, let the device close the loop.

**3.2 The poll is the heartbeat. Never stop it for a coil-bearing device.**
*Incident "pause polling vs fail-safe":* a Pause Polling feature stopped the 15 s coil poll. Any pause of 60 s or more would have dropped every relay while the cache still said ON. Fixed in `ModbusPollingService.js`: `hasCoils` devices keep polling during a pause.

```js
// ModbusPollingService.js — a safety property, not an optimisation
if (this.isPaused && !state.hasCoils) return;   // relay boards are the firmware heartbeat
```

**3.3 The safe failure direction is per channel, not per system.**
*Incident:* firmware fails everything to OFF on comms loss. Right for pumps and shade motors; wrong for 28 greenhouse fans in Dubai summer, where a backend restart drops the fans for about a minute. **Open item:** per-coil policy (hold for fans, OFF for pumps/shades). Until then, a daytime backend restart is a controlled event.

**3.4 Compare desired vs actual before every write.**
*Incident "watchdog rearm storm":* `WatchdogService.js` re-fired ON automations every ~10 min while the relays were already ON — 1,500 writes in 5 h — because it never checked coil state. Fixed with `_desiredRelayStates()` / `_relayStatesMatch()`. Every re-assert path (watchdog, scheduler catch-up, arming restore) reads before it writes.

**3.5 An actuator that changes the variable gating it needs its own OFF rule on that variable.**
*Incident "pads humidity loop":* chiller pads turned on at 74 % RH under a rule whose `RH < 80` condition was checked only at fire time. The pads pushed RH to 87 % and nothing could turn them off. Three facts every automation author must hold:

- The `conditions` column is **UI / dry-run only**; the executor ignores it at runtime.
- Runtime gating is **per-action `dependencies`** (`AutomationExecutor.js`, `evaluateDependencies`).
- Threshold triggers are **rising-edge only**.

```js
// gate at runtime in the action, not in `conditions`
{ equipment_id: 14, transitions: { 3: true },
  dependencies: [{ equipment_id: 22, field: 'humidity', op: '<', value: 80 }] }
// AND a paired OFF automation on the same variable: humidity >= 82 → { 3: false }
```

**3.6 Interlocks are enforced at every ON path, with read-back.** `RelayInterlockService.js` guards shade Open/Close (Fan Boards 2 and 5, ch5/ch6): `guardEnergise()` writes the partner OFF (FC05) and reads it back (FC01) before any ON write; a hardware conflict forces both OFF; `validateAutomationActions()` rejects offending write sets at save time; `POST /:id/relay/all` refuses "all ON" on any board with pairs. New pairs go in the coil mapping (`interlockWith`), never in a route.

**3.7 Never risk a lockout on a guess.**
*Incident "camera lockout":* the greenhouse PTZ had been powered off for three months unnoticed. Probing a Hikvision found at a different IP with repeated passwords tripped its 7-fail/30-min lockout — and it was a different camera. Lessons: alert on unreachable devices (`equipment_offline:<id>`); one credential attempt per unconfirmed device; `curl rtsp:// -X DESCRIBE` proves nothing because curl sends OPTIONS.

---

## 4. Operator interface

**4.1 Never render absence as a value.**
*Incident:* the dashboard showed 44 energy-meter cards from a meter dead since 15 Sept with only a red dot; relay tiles showed OFF when unknown; write-only boards showed commanded state as truth. Being fixed in the current redesign. Rule: a reading older than 3× its poll interval renders **stale** (age shown, value muted); an unknown coil renders **unknown**, never OFF; `write_only` boards render "commanded", never "on".

**4.2 Stale AI output is worse than none.**
*Incident:* the Tasks page showed a CRITICAL crop-termination task from July as current; Planner showed nine consecutive failures as raw JSON. Every agronomist/planner artefact carries its run time and status; anything older than its cadence is labelled and demoted; a failed run renders as a failure, not its payload.

**4.3 Destructive and bulk actions confirm, listing affected channels.** `frontend/src/components/ConfirmDialog.jsx` is the only confirmation surface. Factory reset and user deletion require the password.

**4.4 Verify the authenticated render after any frontend change.** `vite build` passes on runtime crashes — a TDZ bug once blanked the whole app for a day. The plain `--dump-dom` check renders only the login page. Drive CDP with an injected `token` in `localStorage`; confirm the ~450 KB authenticated root and zero `Runtime.exceptionThrown` (memory note *frontend-runtime-verification*).

**4.5 Pages must survive their own data.** Any list that can grow (alerts, relay events, readings) is paginated server-side from day one.

---

## 5. Visual language

Light theme is the default: the app is read on a phone, outdoors, in Dubai sun. Declare tokens in `frontend/src/index.css` and `frontend/tailwind.config.js`; retire the stock `primary`/`secondary` ramps as pages are redesigned.

```css
:root {
  --night: #14100F; --char: #2E2825; --stone: #6A615D;
  --ash:   #C9C2BC; --paper: #F7F4F1;
  --red:   #A3132E; --grow:  #6B2E8A;
  /* state colours — never reused as accents */
  --ok: #5FB07E; --caution: #C9903A; --alarm: var(--red);
  --lighting: #A46BC6; --water: #4E93B8;
}
```

- **Type:** Archivo for UI; JetBrains Mono, tabular numbers, for every measurement and timestamp. Labels: 700 / 11 px / .12 em / uppercase.
- **Cards** carry a 3 px left state rail. The rail is the state; the body stays neutral.
- **Status = shape + colour**, never colour alone: filled dot ok, triangle caution, square alarm, hollow unknown/stale.
- **Destructive = ghost button** in `--red`. Solid red is reserved for alarm state.
- A `--water` accent on a heading is a bug.

---

## 6. Architecture

- **Backend** `backend/src/`: Express, SQLite (better-sqlite3) at `/app/data/sensehub.db`, `network_mode: host`. Routes reach hardware only through `ModbusTcpClient`.
- **Frontend** `frontend/src/`: React + Vite + Tailwind behind nginx; Context state.
- **Hardware truth lives in one place:** coil mappings (labels, `interlockWith`, write-only) on the equipment row; register maps in `SensorDocs/` and the equipment row.
- **Coil writers are enumerable:** `AutomationExecutor`, `RelayTimerService`, `RelaySafetyWatchdogService`, `RelayInterlockService` and the two relay routes in `routes/equipment.js`. All log through `RelayEventLogger` with a `source`. A coil write without a relay event is a bug.
- **Safety state is rows, not variables:** arming, interlock pairs and max-on survive restarts.
- **Deploys need `--build`** (image-baked); backups need free disk ≥ DB size (memory note *disk-retention-and-deploy*).

---

## 7. Checklist for any new actuating feature

1. Which coil-bearing devices does it touch, and does it keep them polling (heartbeat)?
2. What is the failure direction per channel on comms loss, backend restart and disarm — and is it the right one for that load?
3. Does it read actual state before writing desired state?
4. Does it go through `guardEnergise()` / `validateWriteSet()` on every ON path?
5. Does it respect `AutomationArmingService.isDisarmed()`?
6. Is it covered by `RelaySafetyWatchdogService` max-on, or does it need its own?
7. If it changes a variable that gates it, is there a paired OFF rule on that variable?
8. Are its gates in per-action `dependencies`, not `conditions`?
9. Does every relay write log a `RelayEventLogger` event with a `source`?
10. Do its alerts use fingerprinted `createAlert()` with a stable key?
11. Does the UI render unknown/stale/commanded distinctly from ON/OFF, and confirm bulk actions with the channel list?
12. Was the authenticated CDP render verified, not just `vite build`?
13. Is it committed, with the incident or requirement named in the message?

---

## 8. Working notes for agents

- Read the incident before changing the rule it guards. To relax a rule, first write down the incident it will cause.
- Verify before asserting: controlled read first, doc second. A datasheet is a hypothesis.
- One credential attempt on an unconfirmed device.
- Never pause, disable or slow a poll on a device with coils; never lengthen the firmware watchdog to "fix" it.
- After any frontend change: build, authenticated CDP render, then a phone-width look.
- `createAlert()` always; never `INSERT INTO alerts`.
- Keep memory notes in sync with this file; this file is the durable copy.
- Do not commit unless asked; when asked, commit safety code the same day.
