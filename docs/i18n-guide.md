# SenseHub i18n guide (frontend)

Languages: **English (`en`, default + fallback)**, **Turkish (`tr`)**, **Arabic (`ar`, right-to-left)**.
Phase 1 built the foundation and translated the shell + Dashboard. Phase 2 translates the remaining pages **file by file** using this guide, `docs/i18n-glossary.md` (mandatory terms) and `npm run i18n:check` (work list + gate).

Read `docs/FARM-APP-STANDARDS.md` first — every safety rule there applies to translated text too: a translation must never make a stop, an unknown state or a failure sound safer than the English.

---

## 1. How it works

| Piece | Where |
|---|---|
| i18next + react-i18next, bundled (no CDN) | `src/i18n/index.js` |
| Resources, one JSON per namespace per language | `src/locales/{en,tr,ar}/<ns>.json` |
| Lazy loading: each JSON is its own chunk (`import.meta.glob`) | `src/i18n/index.js` (`lazyBackend`) |
| Language list, direction, Intl locale (`-u-nu-latn`) | `src/i18n/languages.js` |
| Formatters (numbers, dates, durations, units) | `src/i18n/format.js`, hook `src/i18n/useFormat.js` |
| Per-user language (server preference), switcher | `src/context/LanguageContext.jsx`, `src/components/LanguageSwitcher.jsx` |
| `Accept-Language` on every `/api` request | `src/utils/resilientFetch.js` (`withLanguageHeader`) |
| `<html lang dir>`, RTL, fonts, Arabic/Turkish typography | `src/i18n/index.js`, `src/index.css`, `src/i18n/fonts.css`, `tailwind.config.js` |
| Checker | `scripts/i18n-check.mjs` → `npm run i18n:check` |

- **Language choice**: per user, stored as `language` in `GET/PUT /api/users/me/preferences` (backend contract). Before login: this device's last language (`localStorage['sensehub.lang']`), else the browser language if it is tr/ar, else en. After login the account's language wins; a language picked on the login page just before signing in is written to the account. Switching is optimistic; if the PUT fails the choice stays on the device and a warning toast says so.
- **Core namespaces** `common`, `nav`, `shell`, `auth` load before the first paint. Any other namespace loads on first use; the page shows the Suspense fallback (the header stays live) for those few ms.
- **Pollers refresh on a language switch** (`hooks/usePoll.js`), so server texts re-arrive in the new language at once.
- **Dev only**: `?lng=pseudo` renders English accented and padded (`[Šţöþ Åļļ ~~]`): anything still plain English is hard-coded; anything clipped will clip in Turkish. `?lng=tr` / `?lng=ar` force a language in `vite dev`.

## 2. Namespaces

One namespace per area. Existing files (empty ones are waiting for Phase 2):

`common` (buttons, states, severities, roles, toasts, reading, connectivity, language, chart) · `nav` (sidebar, breadcrumb, settings tabs) · `shell` (header, stop controls, banners, footer, clock) · `auth` (login) · `setup` · `dashboard` · `irrigation` (irrigation card, last cycle, run types, Stop irrigation — reused by Fertigation/Reports) · `fertigation` · `equipment` · `automations` · `alerts` · `agronomist` · `reports` · `logs` · `settings` · `zones` · `cameras` · `tasks` · `planner` · `amic` · `lab` · `calibration` · `templates` · `analytics` (Data Export) · `relayEvents`.

Rules:
- A page uses **its own namespace + `common`**: `const { t } = useTranslation('alerts')`, then `t('list.title')`, `t('common:actions.save')`.
- Shared components keep their strings in the namespace of their area (`irrigation` for `components/irrigation/*`, `common` for `ui/*`), never in the page that happens to use them.
- Do not duplicate `common` strings (Save, Cancel, Close, Retry, Refresh, ON/OFF, Armed/Disarmed, severities, roles). Reuse them.
- New namespace = add `src/locales/{en,tr,ar}/<ns>.json`. Nothing else to register.

## 3. Keys

- Nested JSON, **camelCase**, grouped by the screen part: `list.title`, `filters.severity`, `detail.ackButton`, `errors.loadFailed`, `confirm.deleteTitle`.
- A key names the **meaning**, not the English words: `stop.switchOffAtPanel`, not `stop.switchOffAtThePanelDot`.
- Domain codes from the API may be used as keys directly: `runStatus.cut_short`, `trigger.watchdog_rearm`, `climate.temp_shielded`. Always pass `defaultValue` when the code comes from data that can grow: `t(`trigger.${x}`, { defaultValue: x })`.
- Plurals: `key_one`, `key_other` in en; `_one/_other` in tr; **all six** `_zero/_one/_two/_few/_many/_other` in ar (the checker enforces this). Call with `count`: `t('count.channel', { count: n })`. Arabic `one`/`two` forms usually spell the number ("قناة واحدة", "قناتان") — that is correct.
- Interpolation: `{{name}}`. Never concatenate translated fragments into a sentence; pass values in: `t('stop.result.counts', { channels: t('count.channel', { count }), timers: … })`. Word order differs in tr/ar.
- Emphasis inside a sentence: `<Trans i18nKey="shell:estop.menuHelp" components={{ b: <span className="font-semibold" />, alarm: <span className="…" /> }} />` with `"… <b>including ALL fans</b> …"` in JSON. Links: `<link>Create one</link>` + `components={{ link: <Link to="…" /> }}`.
- Do not translate keys in comments, `console.*`, `data-testid`, class names or API paths.

### `t` usage convention

```jsx
import { useTranslation, Trans } from 'react-i18next';
import { useFormat } from '../i18n/useFormat';

export default function Alerts() {
  const { t } = useTranslation('alerts');      // own namespace first
  const fmt = useFormat();                      // numbers / dates / durations
  …
  <h1>{t('title')}</h1>
  <Button>{t('common:actions.refresh')}</Button>
  <p>{t('list.count', { count: alerts.length })}</p>
  <span>{fmt.relative(alert.created_at)}</span>
}
```

- Hooks at the top of the component, **before** any `useCallback` that uses `t` (TDZ rule in `Layout.jsx`), and add `t` to the dependency arrays of callbacks that call it.
- Outside React (plain helpers, constants): return keys, not text, and translate at render. If a helper must produce text (toasts from a context), `import i18n from '../i18n'` and call `i18n.t('ns:key')` **at call time**, never at module load.
- Constant arrays of labels (`PAUSE_DURATIONS`, `TIME_RANGES`, `CLIMATE_TILES`) keep only ids/values; the label comes from `t()` at render. Keep the English `label` in the constant only as the `defaultValue` reference if it helps.
- Pure derivation modules (e.g. `dashboard/irrigationLive.js`) return **`key` + `params`** next to an English `text` (kept for tests/logs); the component renders `t(\`hint.${key}\`, params)`.
- A variable named `t` for time already exists in some files (charts): alias the translator (`const { t: tc } = useTranslation('common')`).

## 4. What is never translated

- **Units and technical abbreviations**: EC, pH, mS/cm, µS/cm, L, L/h, L/min, m³, m³/h, °C, %, kPa, kWh, VPD, RH, ppm, CO₂, Modbus, MQTT, SEKO, AMIC, Priva.
- **Ratios and identifiers**: 1:200, tank letters A–D, relay / channel / zone **numbers**, equipment ids, slave ids, IP addresses, firmware versions.
- **Data**: equipment names, relay labels, zone names from the config, automation names, crop / product / chemical names ("Calcium nitrate", "Fetrilon Combi 2"), user names and e-mails.
- **Server-generated text** (alerts, flow-watch / irrigation messages, dose-controller notes, report summaries, relay-event reasons, API error `message`s): the backend localizes them from `Accept-Language`. The frontend **must not** translate or pattern-match them. Alerts also carry `message_key` + `message_params` for future client-side use — don't build on them yet.
- **Agronomist reports**: the backend returns translated fields for tr/ar with `translation_status` (`ready` | `pending` | `failed` | `original`). Show a small "translated automatically" note + a "Show original (English)" toggle, and a "translation in progress" state for `pending` (Phase 2, agronomist page).
- Brand: `A20Core`, `SenseHub` (mark them `lang="en"`).

Error text technique: keep the raw `err.message` / `HTTP 502` **inside** the translated sentence as a parameter (`t('errors.loadFailed', { error: e.message })`). The toast layer's resume-noise filter (`utils/connectivity.js`) matches those English network fragments; do not translate them.

## 5. Numbers, dates, units — always through the formatters

`const fmt = useFormat();` (language + configured farm timezone) or the plain functions in `src/i18n/format.js` with `{ lng, timeZone }`. `SettingsContext.formatDateTime / formatDate / formatTime / formatClock / formatRelativeTime` delegate to the same code.

| Need | Use | en | tr | ar |
|---|---|---|---|---|
| number, fixed dp | `fmt.number(v, { decimals: 2 })` | 1,234.57 | 1 234.57 | 1,234.57 |
| integer | `fmt.int(v)` | 8,850 | 8 850 | 8,850 |
| value + unit | `fmt.withUnit(v, 'L/h', { decimals: 0 })` | 8,850 L/h | 8 850 L/h | 8,850 L/h (isolated) |
| percent | `fmt.percent(v, { decimals: 1, signed: true })` | +12.5 % | +12.5 % | +12.5 % (isolated) |
| water volume | `fmt.water(l)` | 1.23 m³ / 850 L | same | same |
| date + time | `fmt.dateTime(ts)` | Sep 27, 2026, 02:05:03 PM | 27 Eyl 2026 14:05:03 | 27 سبتمبر 2026، 14:05:03 |
| clock | `fmt.clock(ts)` | 02:05 PM | 14:05 | 14:05 |
| relative | `fmt.relative(ts)` | 5 minutes ago | 5 dakika önce | قبل 5 دقائق |
| stale "since" | `fmt.since(ts)` | 14:02 / Sep 23 14:02 | 14:02 / 23 Eyl 14:02 | … |
| duration | `fmt.duration(372)` | 6 min 12 s | 6 dk 12 sn | 6 د 12 ث |
| countdown | `fmt.countdown(s)` | 04:30 | 04:30 | 04:30 |

Decisions (operator-approved scope):
- **Western digits 0-9 everywhere**, Arabic included (every Intl tag pins `-u-nu-latn`).
- **Decimal mark is `.` in every language**, for every number, so a reading looks exactly like the SEKO / flow meter / Priva panel next to it. Turkish normally writes `5,82`; on a farm display the panel wins. Because `.` is the decimal mark, Turkish **groups thousands with a narrow no-break space** (`8 850`) — `8,850` or `8.850` would read as a decimal to a Turkish operator. English and Arabic group with `,` (native for both with Latin digits).
- Readings (`ui/Reading`) use no grouping when a precision is set (as before).
- **Time zone** = the configured farm zone (`Asia/Dubai`), never the phone's.
- English keeps its existing en-US output (12 h). Turkish and Arabic use 24 h like the device clock and the panels.
- In Arabic, value+unit, percent and signed/negative numbers come back wrapped in a bidi isolate (U+2066…U+2069) so "96.19 m³" and "−2.5" keep their panel order inside Arabic sentences. English and Turkish strings are untouched. Never hand-build `${n} ${unit}` in text; use `fmt.withUnit`.
- Never render absence as a value (standards 4.1): the formatters return `—` for null/NaN.
- Do not use `toLocaleString()`, `toFixed()` for display, `new Date().toLocaleTimeString([])` or `Intl.*('en-US')` directly in pages any more.

## 6. Right-to-left (Arabic)

`<html dir="rtl">` flips the flex/grid flow automatically. Your job is to remove **physical** directions.

- Use Tailwind 3.4 **logical utilities**: `ms-/me-` (not `ml-/mr-`), `ps-/pe-`, `start-/end-` (not `left-/right-`), `text-start/text-end`, `border-s/border-e`, `border-s-state-*`, `rounded-s/rounded-e`, `gap-*` instead of `space-x-*`. When a physical class is intentional, pair it with an `rtl:` variant (`rtl:-translate-x-full`, `rtl:shadow-[inset_-3px_0_0_…]`, `rtl:lg:divide-x-reverse`).
- **The state rail is on the START edge** (right in Arabic): `Card rail=…` and `.rail-*` already do this; pages that hand-write `border-l-[3px] border-l-state-*` must switch to `border-s-[3px] border-s-state-*`.
- **Direction-bearing icons mirror**: chevrons, arrows, "next/prev", breadcrumb separators, disclosure triangles → `rtl:-scale-x-100` (for a rotating disclosure: `rtl:-scale-x-100 group-open:rotate-90 rtl:group-open:-rotate-90`). Do not mirror clocks, checkmarks, play/pause, logos, charts.
- **Stay LTR inside** (`dir="ltr"` on the container): charts and sparklines (time runs left→right — `ui/Chart` already does), the automation SequenceTimeline and Gantt bars, numeric tables with time/tank columns (e.g. the last-cycle table), register maps, hex/Modbus dumps, code, IPs, emails, the `Reading` value+unit, device clock. Mark a file whose physical classes are therefore intentional with `/* i18n-check: physical-ok */`.
- **Data text** (names, server messages) inside a truncating element gets `dir="auto"` so Latin text truncates at its end, not its start.
- Popovers anchored to a header button: `absolute end-0`; drawers: `start-0` + `-translate-x-full rtl:translate-x-full`; toasts slide in from the end.
- Inputs holding LTR data (email, IP, numbers) get `dir="ltr"`.

## 7. Typography

- Arabic: letters join, so **letter-spacing and uppercase are disabled for every element under `lang="ar"`** (`src/index.css`), and the 11 px label is 12 px. Don't add inline `letterSpacing`.
- Turkish: uppercase labels stay; `lang="tr"` makes the browser uppercase `i→İ`, `ı→I` correctly. Data inside an uppercase label that must not get Turkish casing (user names, English identifiers) gets `lang="en"` (see `RunTypeTag`).
- Fonts are bundled: Archivo (Latin + Latin Extended: ş ğ ı İ ç ö ü), JetBrains Mono (tabular digits), **IBM Plex Sans Arabic** (OFL, Arabic subset, 400–700, loaded only when Arabic glyphs are on screen). Archivo stays first in the stack, so digits and units keep the house face inside Arabic UI.

## 8. Checklist per file (Phase 2)

1. `npm run i18n:check -- --file pages/Alerts.jsx` → the list of hard-coded strings with line numbers.
2. Move every user-visible string to the page's namespace (en), then add tr and ar. Use the glossary terms. Safety wording: translate meaning exactly; keep "NOT", "ALL", "may still be energised", "use the panel" strength.
3. Replace ad-hoc number/date formatting with `useFormat()`.
4. Convert physical direction classes (the `rtl-fix` column) to logical ones; mirror directional icons; `dir="ltr"` for charts/timelines/numeric tables; `dir="auto"` on data text.
5. `npm run i18n:check` must pass (exit 0: no missing/extra plural forms, no interpolation mismatches, no unknown keys in code). The page's hard-coded count should be 0 or only data/units.
6. `npm run build` + `npx vitest run`.
7. **Authenticated CDP render** of the page in en / tr / ar at 390 and 1280 px (FARM-APP-STANDARDS 4.4): zero `Runtime.exceptionThrown`, `<html dir>` right, no horizontal overflow, no clipped Arabic. Block every non-GET `/api` call except login.
8. Add new machine translations to `docs/i18n-review.md`.

## 9. `npm run i18n:check`

```
npm run i18n:check                      # summary + coverage table per page / component folder
npm run i18n:check -- --files           # per-file table
npm run i18n:check -- --file pages/Alerts.jsx   # the strings, with line numbers
npm run i18n:check -- --json            # machine-readable
npm run i18n:check -- --no-fail         # never exit 1
```

It reports (1) tr/ar keys missing vs en (plural-aware), empty values, stale extra keys, `{{var}}`/`<tag>` mismatches; (2) `t('…')` / `i18nKey` keys used in code that do not exist in en (dynamic `${}` keys checked by prefix); (3) hard-coded user-visible strings in JSX (text nodes, `title`/`placeholder`/`aria-label`/`alt`/`label`…, literals rendered as children, literals passed to toast helpers), ignoring units/abbreviations; (4) the `rtl-fix` count of physical direction classes. Exit 1 on (1)/(2) problems; hard-coded strings are the backlog, not a failure. It is a heuristic: strings built in variables outside JSX are not seen — read the file too.

## 10. Adding a language

1. Add it to `LANGUAGES` in `src/i18n/languages.js` (`code`, native `name`, `dir`, `intl` tag with `-u-nu-latn`).
2. Copy `src/locales/en` to `src/locales/<code>` and translate; the checker lists every plural category CLDR needs for it.
3. Add its duration unit words (`DURATION_UNITS`), "just now" and "ago" patterns and grouping separator in `src/i18n/format.js`; add tests in `format.test.js`.
4. Non-Latin script: add an OFL font subset in `src/i18n/fonts.css` (woff2, `unicode-range`) and to the font stacks in `tailwind.config.js`; check line height and clipping.
5. Backend: the same code in `Accept-Language` handling and its message catalogues; glossary column in `docs/i18n-glossary.md`.
