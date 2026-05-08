# ESP32 (Waveshare) autonomous-program execution — design

> **Status:** design proposal, no code yet. Decide which option to greenlight before any firmware changes.

## The problem

SenseHub runs every irrigation/fertigation cycle from the Pi. When the Pi crashes, restarts, or loses Modbus comms with a relay board:

- In-memory `RelayTimerService` timers vanish → pending OFFs never fire (we mitigated this in this session with `RelaySafetyWatchdogService`, but it only kicks in once the Pi is healthy *and* talking to the board).
- A scheduled fertigation that started 5 minutes before the crash will leave a zone or pump stranded ON until either the Pi recovers, an operator hits STOP, or the watchdog kicks in (currently capped at 25 min default).
- During Modbus blackouts (network blip, gateway power cycle, RS485 cable jiggle), no new commands reach the board even when the Pi is fine.

Goal: **the relay board can finish the program it was given even when SenseHub is unreachable.** SenseHub stays the boss when present; the board only follows its stored program autonomously.

## Hardware constraints (current)

| | Value |
|---|---|
| Relay board | Waveshare ESP32-S3-Relay-6CH |
| Firmware | Custom Modbus RTU slave (see `firmware/waveshare_modbus_slave/`) |
| Bus | RS485 daisy-chain via USR-DR134 gateway at `192.168.1.7:502` |
| Coil count | 6 (one per channel) |
| Free flash on ESP32-S3 | ~3 MB usable for program storage (assuming 8 MB flash, 4 MB partitions) |
| RTC | Internal RTC; **no battery backup on the Waveshare board** — clock resets on power loss |

The clock-reset issue is the single biggest constraint. Any program execution that depends on absolute time will lose its anchor on power loss. That forces us toward **relative-time programs** (durations and offsets, not wall-clock schedules).

## Two design options

### Option A — "Push-on-arm": SenseHub uploads a single program, board executes once, commits

**Flow:**
1. SenseHub builds a program (e.g. "ON CH1+CH2+CH3 now → wait 180s → CH3 off, CH4 on → wait 180s → CH4 off, CH5 on → … → all OFF") and serializes it to a compact byte buffer.
2. SenseHub writes the buffer to ESP32 via FC15 (Write Multiple Registers) into a "program" register block.
3. SenseHub writes a single coil "arm" — board records `program_start_ms = millis()` and starts running it.
4. Each transition fires from the board's local timer, regardless of SenseHub state.
5. SenseHub keeps polling the board's "current step" register so the UI shows progress, but the board doesn't need SenseHub.
6. When the program completes, board clears its program registers; SenseHub-side timer service records the run as complete (whatever fired first wins).

**Coil semantics under SenseHub control:**
- SenseHub-issued direct writes (`writeSingleCoil`) **always win** — they immediately reset the program-running flag and kill the program.
- This is consistent with current behavior: the STOP automation already uses `writeSingleCoil(false)` per channel; it would also clear the program.

**Pros:**
- Smallest firmware footprint. ~50 lines of state machine code.
- Atomic: either the program runs to completion or SenseHub overrides — never half-and-half.
- Easy to reason about: the board has *exactly one* active program at a time.

**Cons:**
- One program per board at a time. Can't queue.
- No persistence across power cycles (program is lost on reboot, by design).

### Option B — "Pull-task": SenseHub uploads a small calendar; board runs scheduled tasks autonomously

**Flow:**
1. SenseHub uploads a list of up to N tasks (e.g. 16 slots × 24 bytes each = 384 bytes), each with: `start_offset_seconds_from_arm`, `duration_seconds`, `channel_bitmap`.
2. SenseHub also pushes its current wall-clock time so the board can resync its RTC.
3. Board runs the calendar from a local timer with the same coil-write semantics.

**Pros:**
- Multiple chained programs without re-arming.
- Survives short Modbus blackouts mid-program (board keeps running its calendar).

**Cons:**
- Bigger firmware (priority queue, calendar data structure).
- Calendar doesn't survive power loss without persistent storage in NVS — adds complexity.
- More register space consumed (program data + per-task status).
- Conflict resolution gets harder when SenseHub *also* tries to schedule new things.

**Recommendation: start with Option A.** It maps 1:1 to how our existing automations are already structured (one program per trigger), is simpler to debug, and doesn't introduce a divergent state machine on the board side.

## Modbus register design (Option A)

Reserve a contiguous holding-register block on the ESP32 firmware. Suggested layout (each row is 16-bit words):

| Reg | Name | RW | Purpose |
|-----|------|-----|---------|
| 0x100 | `program_version` | RO | Firmware bumps this on layout changes; SenseHub refuses to upload if it doesn't recognize the version |
| 0x101 | `program_armed` | RW (coil-like) | 0 = idle, 1 = running. SenseHub sets to 1 to start, 0 to abort. |
| 0x102 | `program_step_count` | RW | Number of valid steps in the program (max 16) |
| 0x103 | `program_current_step` | RO | Index of the currently-active step |
| 0x104 | `program_started_ms_lo` | RO | Lower 16 bits of `millis()` when arm fired |
| 0x105 | `program_started_ms_hi` | RO | Upper 16 bits |
| 0x106 | `program_now_ms_lo` | RO | Heartbeat — updated every step transition |
| 0x107 | `program_now_ms_hi` | RO |  |
| 0x108 | `last_error` | RO | 0 = ok, 1 = bad checksum, 2 = step overflow, 3 = invalid channel, etc. |
| 0x109 | `crc16_of_program` | RW | SenseHub computes CRC over steps 0..N; firmware verifies before arming |
| 0x110 + 4×i | step[i].offset_seconds | RW | When this step fires (relative to arm) |
| 0x111 + 4×i | step[i].channel_bitmap | RW | Which coils to set ON (bit 0 = CH1, bit 1 = CH2, …) |
| 0x112 + 4×i | step[i].channel_mask | RW | Which coils to write (the rest are left alone) |
| 0x113 + 4×i | step[i].flags | RW | Reserved (e.g. "hard-stop on Modbus blackout > N seconds") |

A full 16-step program is 16 × 4 = 64 registers + 16 header registers = **80 registers ≈ 160 bytes**. Trivially fits in a single FC15 burst (max 123 registers per Modbus FC15, but we'll batch in two writes for safety).

Each step says "at offset T from arm, set coils with mask M to bitmap V". This mirrors the structure of our existing transition actions exactly.

## Conflict semantics: who wins?

The hard part. The board has its own timeline; SenseHub has its own. We need a deterministic rule.

**Proposed rule: SenseHub direct writes always supersede the program.**

- SenseHub `writeSingleCoil` or `writeMultipleCoils` → physically flips the coil immediately AND sets `program_armed = 0` on the board (the firmware does this automatically when it detects an external coil write).
- The board's program loop reads `program_armed` every 100 ms; if 0, it stops scheduling further steps but does NOT issue an OFF for whatever is currently ON. (SenseHub's write took care of that.)
- SenseHub UI never goes into a "concurrent program running" state — it either sees `armed=0` (board idle) or `armed=1` (board running its own program).

This makes the rule operator-intuitive: **manual STOP always works.** The fertigation/irrigation programs can run autonomously, but the moment a human or a higher-priority automation issues a direct relay command, the program ends.

For the SenseHub-side automation engine, it means:
1. Before arming a program, fire `cancelTimersByPrefix(...)` to wipe local timer state for that equipment.
2. After arming, log the program ID and rely on the board to execute. Don't keep redundant local timers.
3. If the user then manually toggles a relay or hits STOP, the existing direct-write path naturally wins.

## Clock sync

ESP32 has no battery-backed RTC. Two implications:

1. The board's `millis()` resets to 0 on every power cycle.
2. We can't trust the board to know wall-clock time on its own.

Mitigation: programs use **relative offsets only** (delta seconds from arm), never absolute timestamps. This is already how our current automations work, so it's a natural fit.

If we ever need wall-clock-anchored programs (e.g. "run at 06:00 every day"), the Pi must either (a) push a "wake at offset Δ from now" command at the right moment, or (b) the board needs a persistent RTC source (Wi-Fi NTP, RTC module).

## Failover decisions

When does the board decide to keep running on its own vs wait?

**Proposal: programs run autonomously by default once armed.** No failover decision needed — the board doesn't track Modbus connection state during program execution. It just runs its timer.

The Pi's job is:
- Decide which programs to upload (= existing automation engine).
- Detect when the board is unreachable and *not* try to issue conflicting commands during that window.
- Re-sync UI state once the board is reachable again.

If you want a "kill the program if SenseHub is silent for X seconds" safety, that's a flag in `step.flags`. The board polls for any external write or "still alive" coil write within X seconds and aborts the program if it goes silent. **Do not enable this by default** — it negates the whole point of autonomous execution. Use it only for high-risk channels (e.g. acid dosing).

## Storage capacity

Per board:

- 80 registers × 2 bytes = 160 bytes per program
- ESP32-S3 has plenty of RAM for this. No need for flash storage *unless* we want programs to survive power cycles.

If we want power-cycle-surviving programs (Option A++): persist to NVS (~few µs write). Adds firmware complexity but avoids the "program lost on power blip" edge case. **Recommend not doing this initially** — survival across power cycles can introduce dangerous "ghost programs" if the Pi was about to send STOP when power dropped. Better: program is intentionally erased on boot, the Pi re-uploads if needed.

## SenseHub-side changes (when we do this)

1. **`AutomationExecutor.executeAutomation`** — for any automation whose actions are pure transitions on a single relay board, *bundle them as one program* and arm the board instead of scheduling local setTimeouts. Mixed automations (multi-board, with `control` actions, or with `alert`/`log` actions) keep the existing local-timer path.

2. **`ModbusTcpClient`** — add `armProgram(host, port, unitId, steps[])` that writes the program registers, computes CRC, and writes `program_armed = 1` atomically.

3. **`RelayTimerService`** — keep for cases that don't fit the program model (delays + non-transition actions, mixed equipment).

4. **`Equipment` schema** — add a column `supports_autonomous_program INTEGER DEFAULT 0` (set by the equipment registration flow once the firmware is upgraded). The executor checks this flag before deciding to arm vs. local-timer.

5. **UI** — surface "Running autonomously on board" vs "Running via Pi timer" on the relevant pages. The status pollers can read `program_armed` and `program_current_step` to render progress.

6. **Watchdog interaction** — the safety watchdog from this session is unchanged. It still acts on "channel ON longer than max", regardless of whether the on-event came from a program or a local timer.

## Migration path

1. **Phase 1 (firmware)**: implement the program-state-machine in `waveshare_modbus_slave` firmware. Bench-test on a single board with a fixed program written by hand via `modpoll`. Verify (a) program runs to completion, (b) external coil write aborts the program, (c) `last_error` register reports correctly on bad CRC.

2. **Phase 2 (firmware deploy)**: flash one Waveshare board with the new firmware. Mark its `supports_autonomous_program = 1` in the equipment table. The other 5 boards stay on the old firmware and continue using the existing timer path. **Both modes coexist.**

3. **Phase 3 (SenseHub)**: implement the `armProgram` path in `AutomationExecutor`. Gate on `equipment.supports_autonomous_program`. Run a real fertigation cycle through the new path on the upgraded board.

4. **Phase 4 (rollout)**: upgrade firmware on the remaining boards one at a time, after we've seen the new path work for a week without surprise behavior.

5. **Phase 5 (cleanup)**: once all boards are on the new firmware, simplify `RelayTimerService` to only handle non-transition cases. Don't delete the local-timer path — it remains the fallback for any automation that touches multiple boards or has non-relay actions.

## Risks

- **Program-state desync**: SenseHub thinks the board is idle, but the board is mid-program. Mitigation: SenseHub polls `program_armed` whenever it's about to arm a new program; if it sees `armed=1`, it overwrites with `armed=0` first (effectively cancels), then arms the new program.
- **CRC drift across firmware versions**: the `program_version` register lets SenseHub refuse to upload if the version doesn't match, falling back to local timers.
- **Bricking risk**: a bad program could leave a zone ON forever if the board's program loop has a bug. The Pi-side `RelaySafetyWatchdogService` still catches this because it just reads relay state and forces-OFF after threshold — independent of how the relay got ON.

## Out of scope

- Multi-board atomic transitions (one program flipping coils on two different boards in the same instant). Modbus RTU on a daisy-chain bus can't physically do this — keep multi-board transitions on the Pi side.
- Sensor-conditional steps (e.g. "if temperature > 30°C, skip this step"). Adds firmware complexity that isn't justified yet — those automations already need the Pi for the sensor read.
- Encrypted program upload. RS485 is local; not a real threat surface for v1.
