# SenseHub — Comprehensive Code, UX & Functionality Review

_Generated 2026-06-17. Read-only audit across backend, frontend, integration, and repo hygiene._

## Executive summary

The **core control plane is genuinely built and working** — Modbus I/O, automations, watchdogs, the AI
planner, agronomist, fertigation dosing, calibration, cameras, and reporting all run on real logic against
real devices and a real SQLite database. There are **no `// TODO`/`FIXME` markers, no mock chart data, and no
"coming soon" stubs** in the app source. That's a strong baseline.

The unfinished work is concentrated in four areas: **(1) the cloud/management plane is faked** (cloud sync,
backup/restore, storage stats, firmware), **(2) real-time alerting is silently broken**, **(3) a cluster of
genuine correctness bugs** in the Modbus and UI layers, and **(4) repo hygiene problems including a live secret
in git history.**

---

## 🔴 Critical — fix before relying on these

| # | Issue | Evidence |
|---|---|---|
| 1 | **Cloudflare tunnel token committed in plaintext** (live credential, in git history — must be rotated, not just deleted) | `docker-compose.yml` ~line 86; commit `202d223` |
| 2 | **Cloud sync is entirely simulated** — `/test` & `/sync` return `Math.random()` latency/counts; nothing transmits to a cloud server. The outbound `sync_queue` is only fed by equipment mutations and never drained. The spec's headline "bi-directional sync" does not exist. | `routes/cloud.js:36-51,91-108`; producers only in `equipment.js` |
| 3 | **Real-time alerts don't work.** 5 services `INSERT INTO alerts` without ever broadcasting; the frontend listens for a `new_alert` WS event the backend never sends. Alert sounds/toasts never fire — UI only sees alerts on poll/refresh. | listener `AlertSoundContext.jsx:97`; no matching `global.broadcast` anywhere |
| 4 | **Backup & Restore are faked no-ops.** Backend returns hardcoded `{size:'2.5 MB', status:'completed'}`; the Settings UI picks a `.zip`, shows "Restore Initiated", and uploads nothing. (Factory-reset, by contrast, is real.) | `routes/settings.js:243-265`; `Settings.jsx:2319-2355` |
| 5 | **Modbus register writes omit `setID(unitId)`** — FC06/FC16 can write to the **wrong slave** on a shared RS485 gateway (every other method sets the ID). Latent wrong-device/data-corruption bug. | `ModbusTcpClient.js:514,551` |

---

## 🟠 High — real bugs & spec violations

- **User deletion has no password confirmation** — direct spec violation. `settings/Users.jsx:632-697`
- **32-bit Modbus value handling is fragile/wrong** — returns high-word-only unless `quantity:2` is explicitly set, and uint32 can come back negative. Matches the known "equipment form drops 32-bit fields" issue. `ModbusPollingService.interpretRegisterValue:499-519`
- **Calibration is functionally EC-only** despite offering pH/NO3/PO4/K — add form, unit conversion, estimate labels hardcoded for conductivity. `Calibration.jsx:142-147,289,318`
- **Cameras form loses input focus on every keystroke** — `FormFields`/`Modal` declared inside render, remount per keystroke. `Cameras.jsx:247,320`
- **Reports goes fully blank on fetch error** — empty `catch{}` + no empty state. `Reports.jsx:39`
- **Amic status banner has no color** — dynamic `bg-${color}-50` strings purged by Tailwind JIT. `Amic.jsx:230-267`
- **`Debug.jsx` (`/debug`) ships to production**, reachable by any authenticated user incl. `viewer` — no gate. `App.jsx:289`
- **Automation "test condition" always returns `PASS (simulated)`** regardless of real values. `routes/automations.js:235-243`
- **No session-expiry handling** — no client idle-logout, no global 401 handler; expired session = silent failures until reload. `AuthContext.jsx`
- **`modbusScanner` only ever scans one /24** regardless of actual subnet — discovery misses devices on larger nets. `modbusScanner.js:77-87`
- **Storage stats fabricated** (fake 32 GB/8 GB capacity). `settings.js:171-199`
- **Firmware/update management entirely missing** (version hardcoded `1.0.0`). `system.js:27-30`
- **Setup skip-flow shows default admin password `admin123`** in plaintext. `Setup.jsx:472-476`

---

## 🟡 Medium — UX consistency & wiring

- **Silently swallowed fetch errors are pervasive** (`catch(_){}`, `.catch(()=>{})`). On the target Pi with flaky LAN this is the highest-impact UX issue — failures look identical to empty states. **Planner, Alerts, Tasks do it right** (toasts) and are the template.
- **Shared `Toast`/`ToastContext` and `ErrorMessage` primitives exist but are unused** — pages hand-roll red/green divs. `ErrorMessage`'s Dismiss button is dead (no `onClick`).
- **Confirmation UX is inconsistent** — native `prompt()`/`confirm()`/`alert()` coexist with styled modals. Modals lack `role="dialog"`, focus trap, Esc-to-close.
- **Layout footer "System OK / DB Connected" is hardcoded/fake**; Dashboard renders a stray literal `0`. `Layout.jsx:176-183`, `Dashboard.jsx:1636`
- **Incomplete dark-mode coverage** — Users, Profile, Toast, ErrorMessage, Breadcrumb, Setup, many Settings pills are light-only.
- **Fertigation dose-cycle can be monitored/aborted but not *started* from the UI** — `POST /dose-cycle/start` & `/preview` have no frontend caller. `FertigationDoseScheduler` is manual-only, not auto-wired to the automation engine.
- **`preview_only` planner flag is dead** — written, never read; `applyPlan` mutates live automations; file comment is stale. `OperationalPlannerService.js:511`
- **14 backend WS events the frontend ignores** (`equipment_error`, `connectivity_change`, `crop_*`, `camera_*`…) — panels poll where push data already exists.
- **Orphaned/unwired backend APIs**: legacy `/api/templates` router (superseded by `/api/automation-templates`), most crop-lifecycle endpoints, planner scorecard/versions, low-level modbus routes, system diagnostics.

---

## 🟢 Low — hygiene & tooling

- **~43 committed throwaway scripts** (`reset-admin*.js` ×9, `fix-*.js`, `check-*.js`, `seed.js`, `debug-login.js`…), many duplicated root vs `backend/`, several embedding plaintext credentials. None gitignored.
- **Two tracked `database.sqlite` files** (0-byte) slip past `.gitignore` (rule is `*.db` not `*.sqlite`).
- **`claude-progress.txt` (~108 KB)** and **2.3 MB of SensorDocs PDFs** tracked — clone bloat.
- **No `.dockerignore`** anywhere — build context copies `node_modules`, DBs, scripts, screenshots.
- **Dead tooling**: `lint` scripts but no ESLint config; `jest`/`vitest` scripts but zero unit tests; only one Playwright responsiveness spec, no CI.
- **180 `console.log` in backend** in production; no logging abstraction.
- **God-components**: `Equipment.jsx` 236 KB, `Automations.jsx` 196 KB, `Settings.jsx` 176 KB; backend `OperationalPlannerService.js` 152 KB.
- **Vite dev proxy points at port 3000** while backend runs on 3003 — dev-only mismatch.
- Reassuring: `.env` and the screenshot **are** correctly gitignored; DB migrations are sound (45 idempotent, column-guarded ALTERs).

---

## What's genuinely solid (don't touch)

Modbus polling + automation execution (verify/retry/drift logging), both watchdog services, the AI planner and
agronomist (real streaming Claude calls, throw-if-no-key, scorecards, guardrails), fertigation dosing logic,
calibration regression math, go2rtc camera integration, network-usage from `/proc/net/dev`, reports/analytics
aggregation, data-retention compaction, factory-reset (real bcrypt + transactional wipe), and the WebSocket
fan-out for equipment/sensor events. **Planner, Alerts, and Tasks** are the best-built pages and the right UX
template for the rest.

---

## Suggested order of attack

1. Rotate the Cloudflare token.
2. Wire `new_alert` broadcasts so real-time alerting works.
3. Fix the `setID` register-write bug.
4. Add the missing password confirm on user delete + un-fake backup/restore (or clearly label as not-implemented).
5. Work through the swallowed-error / toast-consistency cleanup using Planner/Alerts/Tasks as the pattern.

---

# Focused Deep-Dive: Add & Register a Sensor

## Verdict

- **Does it work?** Partially. Only the narrow happy path works: a 16-bit FC03/FC04 register or a coil,
  entered by hand, followed by a manual polling refresh. It is **broken** for any 32-bit value, for
  per-register scale/offset, and for non-default byte/word order.
- **Is it practical?** No, not for a non-expert. The operator must already know register address (and 0- vs
  1-based), function code, data type + width, byte order, and scale factor. The scanners don't reduce this —
  they find that *something* answers, not *what* it is.

## Flow: discovery → form → save → polling

1. **Two scanners, neither yields a register map.**
   - Network scan (`modbusScanner.js:111`) probes ports 502/503 with FC43 device-ID — RTU gateways rarely
     answer; returns ip/port only.
   - Slave-ID scan (`equipment.js:1057`) probes **FC03 reg 0 only** → misses FC04-only sensors (SHT20) and any
     map not starting at 0. Reports responding IDs + 3 raw words, no decoding.
   - Both "create" paths insert equipment with **no register_mappings** (`equipment.js:1157`,
     `Equipment.jsx:4234`) → device pings FC03 reg 0, shows online, produces zero readings.

2. **Form (`AddEquipmentModal`, `Equipment.jsx:2618`).** Per-register editor exposes only
   name/register/label/type/dataType/access. **No input for `quantity`, `scale`, `offset`, unit, or byte order.**

3. **Save (`POST /api/equipment`, `equipment.js:73`).** Validates name + slave/poll ranges only; stores mappings
   as a JSON blob. **Does not start polling** — only broadcasts `equipment_created`, which the poller ignores.

4. **Polling pickup.** `refreshDevices()` is called only from `start()` and `POST /api/modbus/polling/refresh`
   (`ModbusPollingService.js:208`). A freshly added sensor is **not read** until manual refresh or restart.

## Footguns (most damaging first)

1. **UI _and_ JSON import silently drop `quantity`/`scale`/`offset`** (`Equipment.jsx:2657`, `:2733-2739`) →
   32-bit devices read a wrong single-register value with no error (`ModbusPollingService.js:456,500-517`).
   This is the documented "register via curl" workaround root-cause.
2. **Newly added equipment isn't polled** until manual `/polling/refresh` — no feedback.
3. **Slave scan is FC03-only** → SHT20-class FC04 sensors report "not responding".
4. **Discovery/bulk-create produce register-less equipment** that show online with no readings.
5. **Generic presets have wrong maps** for the actual hardware (SHT20 temp/humidity reg+FC mismatch); no presets
   for verified sensors (Zhed 7-in-1, SHT20, Circutor CEM-C31).
6. **`device_templates` table is dead code** — backend seeds 9 templates and serves `GET /api/templates`, but no
   frontend fetches it; the form's `REGISTER_PRESETS` is a hardcoded duplicate. User-created device templates
   can never be applied.
7. **No live read-back/preview** before saving; misconfig only discoverable later.
8. **No 0- vs 1-based hint, no `host:port` validation** — typos yield a silent offline device.
9. **Float32/int32 word+byte order hardcoded** big-endian high-word-first (`ModbusPollingService.js:512`).

## Better ways (prioritized)

**P0 — correctness (small, high impact):**
1. Expose `quantity`/`scale`/`offset`/`unit` in the register-row editor (`Equipment.jsx:3115-3170`, seed in
   `:2657`); auto-derive `quantity` from dataType (16-bit→1, 32-bit→2).
2. Stop the import whitelist from stripping fields (`handleImportMappings:2733`).
3. Call `modbusPollingService.refreshDevices()` from create/update/delete in `equipment.js`.

**P1 — usable for non-experts:**
4. Wire the real `device_templates` library into the Add form (replace hardcoded presets; add "Save as
   template"); seed accurate maps for Zhed 7-in-1, SHT20, Circutor CEM-C31, Waveshare 6CH.
5. Add a per-row **"Test Read"** button (uses existing `/api/modbus/read/*`) to confirm a mapping before save —
   the single biggest practicality win.
6. Make the slave scan probe FC03 + FC04 + coils, report which answered + sample values, and pre-fill a
   registration (optionally fingerprint samples against the template library).

**P2 — polish:**
7. Byte/word-order dropdown (ABCD/CDAB/BADC/DCBA) honored in `interpretRegisterValue`, with "try orders" auto-detect.
8. CSV register-map import for vendor datasheets.
9. Validate `host:port`; add a 0-/1-based register-base toggle with inline hint.
10. A guided "Add Sensor" wizard: pick template → confirm slave ID (offer scan) → Test Read each metric → save.
