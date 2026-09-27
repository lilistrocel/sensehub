# i18n native-review checklist

Every Turkish and Arabic string in `frontend/src/locales/{tr,ar}` was **machine-produced** (Phase 1, 2026-09-27) and must be reviewed by a native speaker who knows the farm. Tick a box only after reading the string **in the running app** (context matters: button, tooltip, toast, dialog). Safety texts first.

How to review: sign in, switch language from the globe menu in the header (or Settings → Profile → Language), walk the screens below. Dev build: `?lng=tr` / `?lng=ar` in the URL. Fix a string in the JSON file named in brackets and run `npm run i18n:check`.

## 1. Safety wording (highest priority)

| | Area | tr | ar |
|---|---|---|---|
| ☐ | Header **Stop All** button, tooltip, result toasts (`shell.json: stopAll.*, stop.*`) | ☐ | ☐ |
| ☐ | Header **Emergency stop** button, tooltip, popover help, durations, result toasts (`shell.json: estop.*`) | ☐ | ☐ |
| ☐ | Automations **disarmed** banner, re-arm button and toasts (`shell.json: disarmedBanner.*, rearm.*`) — check "askıda" / "موقوفة" are understood as *automations suspended*, distinct from "disabled" | ☐ | ☐ |
| ☐ | **Stop irrigation** button, help line, confirmation dialog + the 11 channel names, per-channel result, toasts (`irrigation.json: stop.*`) | ☐ | ☐ |
| ☐ | "may still be energised — switch off at the panel" phrasing everywhere (`stop.error.failed`, `stop.result.*`, `stop.switchOffAtPanel`) | ☐ | ☐ |
| ☐ | Sensor-polling pause menu + banner: the heartbeat / fail-safe sentence (`shell.json: polling.menuHelp, pollingBanner.body`) | ☐ | ☐ |
| ☐ | Irrigation card mismatch hints (`irrigation.json: hint.*`) — "dosing with no water flow" must read as an alarm | ☐ | ☐ |
| ☐ | Relay chips: "unknown", "commanded … awaiting confirmation", "read-back failed", bulk All on / All off confirmation (`dashboard.json: running.*`) | ☐ | ☐ |

## 2. Terms to decide

- ☐ ar **relay**: "مرحّل" (standard) vs "ريليه" (what technicians say). Used in ~30 strings.
- ☐ ar **ON / OFF** state words: "يعمل" / "مطفأ". Alternative: keep Latin "ON/OFF" as on the boards.
- ☐ ar **dosing** "الحقن" (aligned with the backend) vs "الجرعات".
- ☐ ar **armed / disarmed** "في الخدمة" / "موقوفة", re-arm "استئناف".
- ☐ tr **disarmed** "askıda" vs "devre dışı" (kept for *disabled*).
- ☐ tr **dosing** "dozlama" (aligned with the backend) vs "dozaj".
- ☐ tr thousands separator: narrow space `8 850` with `.` decimals (see `docs/i18n-guide.md` §5) — confirm operators read it naturally.
- ☐ Duration abbreviations: tr `sn / dk / sa`, ar `ث / د / س` (e.g. "6 د 12 ث"). Full words instead?
- ☐ ar numbers with nouns (plural forms zero/one/two/few/many/other) in `shell.json count.*`, `dashboard.json attention.*`, `irrigation.json *_zero…_other`.
- ☐ tr **online** "çevrim içi" (TDK) — the backend catalogue writes "çevrimiçi"; pick one.

## 3. Screens (Phase 1 scope)

| | Screen | tr | ar |
|---|---|---|---|
| ☐ | Login page + language buttons (`auth.json`) | ☐ | ☐ |
| ☐ | Sidebar sections + items, breadcrumb (`nav.json`) | ☐ | ☐ |
| ☐ | Header: language menu, theme, alert badge, timers popover, cloud status, clock, role (`shell.json`, `common.json`) | ☐ | ☐ |
| ☐ | Connectivity pill: reconnecting / offline / server unreachable (`common.json: connectivity.*`) | ☐ | ☐ |
| ☐ | Error boundary, confirmation dialog buttons, toasts titles (`common.json`) | ☐ | ☐ |
| ☐ | Footer system / DB status (`shell.json: footer.*`) | ☐ | ☐ |
| ☐ | Dashboard: Now tiles (`dashboard.json: climate.*`), Attention row, What's running, Automations panel, Trends charts, Cloud crop record | ☐ | ☐ |
| ☐ | Irrigation card: flow, zones, dosing table, today, last run, last cycle per zone table + legend, today's runs, run type tags (`irrigation.json`) | ☐ | ☐ |
| ☐ | Settings → Profile → Language block (`common.json: language.*`) | ☐ | ☐ |
| ☐ | Relative times / dates / durations as rendered (Intl + `src/i18n/format.js`) | ☐ | ☐ |

## 4. Backend catalogues (server-generated texts)

Owned by the backend (`backend/src/i18n/{en,tr,ar}/*.json`, the agronomist translation prompt). They reach the UI already localized via `Accept-Language`, so review them in the app too:

| | Area | tr | ar |
|---|---|---|---|
| ☐ | Alerts (flow-watch, watchdog, equipment offline, dose controller) as shown on the Dashboard Attention row and the Alerts page | ☐ | ☐ |
| ☐ | Stop / emergency-stop / Stop irrigation server errors and per-board results | ☐ | ☐ |
| ☐ | Status-board group labels (Big fans, Irrigation …) and irrigation-run notes | ☐ | ☐ |
| ☐ | Telegram notifications | ☐ | ☐ |
| ☐ | Agronomist report translations (`translation_status`) | ☐ | ☐ |

## 5. Phase 2

Each Phase 2 page adds its own rows here (namespace file + screen), same format.
