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

### Phase 2 · Settings, Setup wizard, Users, Profile (agent A)

| | Screen | tr | ar |
|---|---|---|---|
| ☐ | Settings tabs + page title (`settings.json: title, tabs.*`) | ☐ | ☐ |
| ☐ | Settings → Profile: account, change password, sound alerts (`settings.json: profile.*`) | ☐ | ☐ |
| ☐ | Settings → Users: list, add/edit, reset password, delete with password (`users.json`) | ☐ | ☐ |
| ☐ | Settings → System: timezone (tr/ar zone names come from Intl + IANA id), system locale, data retention, network, firmware, storage, system logs (`settings.json: system.*`) | ☐ | ☐ |
| ☐ | Settings → Cloud: status, test/sync, pending queue, sync history, suggested programs, connect dialog (`settings.json: cloud.*`) | ☐ | ☐ |
| ☐ | Settings → Notifications: Telegram (token, chat ID, **message language** selector), watchdog alert settings (`settings.json: notifications.*`) | ☐ | ☐ |
| ☐ | Settings → Backup: create / restore / **factory reset** — "cannot be undone" strength, "ALL" capitals (`settings.json: backup.*`) | ☐ | ☐ |
| ☐ | Settings → Watchdog, Network usage, Request log, Data management (purge confirmations) (`settings.json: watchdog.*, networkUsage.*, requestLog.*, data.*`) | ☐ | ☐ |
| ☐ | Setup wizard, 6 steps incl. temporary-password sentence (`setup.json`) | ☐ | ☐ |

Terms coined here (add to the glossary once confirmed):

| English | Türkçe | العربية |
|---|---|---|
| password / reset password | parola / parolayı sıfırla | كلمة المرور / إعادة تعيين كلمة المرور |
| user management / last login | kullanıcı yönetimi / son giriş | إدارة المستخدمين / آخر تسجيل دخول |
| role | rol | الدور |
| setup wizard / skip setup | kurulum sihirbazı / kurulumu atla | معالج الإعداد / تخطي الإعداد |
| administrator account | yönetici hesabı | حساب المسؤول |
| timezone | saat dilimi | المنطقة الزمنية |
| system locale | sistem yerel ayarı | الإعداد الإقليمي للنظام |
| gateway / netmask | ağ geçidi / alt ağ maskesi | البوابة / قناع الشبكة |
| cloud connection / cloud sync | bulut bağlantısı / bulut eşitlemesi | الاتصال السحابي / المزامنة السحابية |
| sync queue / sync history | eşitleme kuyruğu / eşitleme geçmişi | قائمة انتظار المزامنة / سجل المزامنة |
| offline mode | çevrim dışı mod | وضع عدم الاتصال |
| suggested program (from the cloud) | önerilen program | برنامج مقترح |
| data retention | veri saklama | الاحتفاظ بالبيانات |
| firmware / version | yazılım / sürüm | البرنامج الثابت / الإصدار |
| uptime | çalışma süresi | مدة التشغيل |
| edge computing | uç bilişim | الحوسبة الطرفية |
| backup / restore / safety backup | yedek / geri yükleme / güvenlik yedeği | نسخة احتياطية / استعادة / نسخة احتياطية أمان |
| factory reset | fabrika ayarlarına sıfırlama | إعادة ضبط المصنع |
| outage / downtime | kesinti / kesinti süresi | انقطاع / مدة الانقطاع |
| chat ID / bot token (Telegram) | sohbet kimliği (Chat ID) / Bot Token | معرّف المحادثة / رمز البوت (Token) |
| message language (Telegram) | mesaj dili | لغة الرسائل |
| endpoint | uç nokta | نقطة النهاية |

To decide:
- ☐ tr **sync** "eşitleme" (used throughout Settings and Setup) vs "senkronizasyon".
- ☐ tr **password**: "parola" (used here) vs "şifre" (what most users say).
- ☐ ar "Telegram" written "تيليجرام" in running text, Latin in the brand spot.

### Phase 2 · Automations, Templates (agent B)

| | Screen | tr | ar |
|---|---|---|---|
| ☐ | **Rule summary sentence** on every row, detail, builder "Reads as", delete dialog — built from whole templates per language (`automations.json: summary.*`): tr keeps "Irrigation Pump AÇIK 18 dk" order, ar is verb-first "تشغيل Irrigation Pump لمدة 18 د" with ← instead of → | ☐ | ☐ |
| ☐ | Run / Delete confirmations with the channel list: "switches N channels on …", "cannot be undone" strength (`automations.json: confirm.*`) | ☐ | ☐ |
| ☐ | Automations list: header counts, filters, group labels (`page.*, category.*, trigger.*`), row pills (offline, duplicate name, dose program), row buttons (`row.*`) | ☐ | ☐ |
| ☐ | Builder: When / Do / Advanced, validation list, hysteresis "pairs with / thresholds cross" warning, interlock / hysteresis server-error titles (`builder.*`) | ☐ | ☐ |
| ☐ | **Dependencies ("gates")**: "only fires when ALL of these pass at run time" (`deps.*`), conditions "dry-run only — the executor ignores these" (`builder.conditionsHelp`) — must not read as a real guard | ☐ | ☐ |
| ☐ | Atomic transition editor: interlock rejection sentence "can never be ON at the same time" (`transition.*`) | ☐ | ☐ |
| ☐ | Sequence timeline: "Pump on with no zone open", "open together", "until off" (`sequence.*`) | ☐ | ☐ |
| ☐ | Detail modal: tabs, run history, log statuses (`detail.*, logStatus.*`) | ☐ | ☐ |
| ☐ | Template manager + "From template" picker (`templates.json: manager.*, picker.*`) | ☐ | ☐ |
| ☐ | Templates page + editor: AI-planner notes, parameters, target effects (`templates.json: page.*, editor.*`) | ☐ | ☐ |

Terms coined here (add to the glossary once confirmed):

| English | Türkçe | العربية |
|---|---|---|
| trigger (of a rule) | tetikleyici | المُشغِّل |
| threshold (sensor) | eşik | عتبة |
| gate / dependency (runtime check per action) | ön koşul | شرط مسبق |
| condition (dry-run only) | koşul (deneme) | شرط (تجريبي) |
| skip condition | atlama koşulu | شرط التخطي |
| dry run / simulate | deneme / benzetim | تشغيل تجريبي / محاكاة |
| rising edge | yükselen kenar | الحافة الصاعدة |
| hysteresis | histerezis | التخلّف (Hysteresis) |
| atomic transition | atomik geçiş | انتقال ذرّي |
| stagger / staggered | kademe / kademeli | التدرّج / متدرّج |
| auto-revert OFF | otomatik KAPALI'ya dönüş | إرجاع تلقائي إلى الإطفاء |
| template / blueprint | şablon / taslak | قالب / مخطط |
| propagate (template to linked rules) | yay(ma) | تعميم |
| AI planner / agent usage notes | yapay zekâ planlayıcı / ajan kullanım notları | مخطِّط الذكاء الاصطناعي / ملاحظات استخدام الوكيل |
| target effects / skip evaluator | hedef etkiler / atlama değerlendiricisi | التأثيرات المستهدفة / مقيِّم التخطي |
| coil (Modbus) | bobin | ملف (Coil) |
| summary action words ON / OFF / TOGGLE / SET | AÇIK / KAPALI / DEĞİŞTİR / AYARLA | تشغيل / إطفاء / تبديل / ضبط (verbs: the summary says what the rule *does*) |

To decide:
- ☐ ar summary uses the **verbs** تشغيل / إطفاء ("switch on / off") because the sentence describes an action, while relay chips use the **state** words يعمل / مطفأ (glossary). Confirm this split reads naturally.
- ☐ tr/ar summaries keep channel names as written (user data) and group them as "Irrigation Zone 1→4" (tr) / "Irrigation Zone من 1 إلى 4" (ar); English still pluralises ("irrigation zones 1→4"). Controlled by `summary.kindStyle`.
- ☐ ar "coil" left as "ملف" in the transition help; technicians may prefer "Coil".
- ☐ Suggested automation names follow the user's language (they are saved as the rule name, without bidi control characters).

### Phase 2 · Fertigation, Flow watch, Dose controller, AMIC, Lab analysis (agent D)

| | Screen | tr | ar |
|---|---|---|---|
| ☐ | **Flow watch card** (Fertigation → Tanks): state words, "Relay state unknown — …", "Pump ON, no zone open", episode kinds + outcome (`fertigation.json: flowWatch.*`) — unknown must never read as OK | ☐ | ☐ |
| ☐ | **Dose controller card**: modes ("Held closed — automations disarmed"), pH sample states, "pH fell below … — pH Down locked out for this cycle", valve title "commanded … ; board reads …", "can't reach target", last run (`fertigation.json: doseController.*`) | ☐ | ☐ |
| ☐ | **Live dose cycle banner**: abort confirmation "All injector valves will be closed immediately", aborted toast (`fertigation.json: liveCycle.*`) | ☐ | ☐ |
| ☐ | Tanks tab: tank cards, stock, pending recipe, predicted ppm, refill + tank edit dialogs (`tanks.*, refill.*, tankEdit.*`) | ☐ | ☐ |
| ☐ | Dose programs tab + edit dialog (duty cycle, compatibility slot, time-slice) (`programs.*, programEdit.*`) | ☐ | ☐ |
| ☐ | Element targets tab: planner explanation, hard min / soft target / hard max, ion names (`targets.*`) | ☐ | ☐ |
| ☐ | Consumption, Mixtures + ingredients, Channel config, Event log tabs (`consumption.*, mixtures.*, ingredients.*, channels.*, events.*`) | ☐ | ☐ |
| ☐ | AMIC page: status, operations (measure / calibrate / drain / empty / conditioning) + confirmations, measurements, pH calibration, schedule, pump times, cycle history (`amic.json`) | ☐ | ☐ |
| ☐ | Lab analysis page: add reading, per-zone stats, history table, edit/delete (`lab.json`) | ☐ | ☐ |

Terms coined here (add to the glossary once confirmed):

| English | Türkçe | العربية |
|---|---|---|
| duty cycle / duty | görev oranı | نسبة التشغيل |
| injector valve(s) | dozlama vanası (-ları) | صمام(ات) الحقن |
| mixture | karışım | خلطة |
| ingredient | bileşen | مكوّن |
| parts (proportion) | pay | حصة / حصص |
| refill (a stock tank) | dolum | تعبئة |
| pending recipe | bekleyen reçete | وصفة معلّقة |
| dilution | seyreltme | التخفيف |
| closed loop / fallback (dose controller mode) | kapalı döngü / yedek mod | حلقة مغلقة / الوضع الاحتياطي |
| pH floor | pH alt sınırı | حد pH الأدنى |
| feed pH | besin pH'ı | pH التغذية |
| time-slice (compatibility strategy) / compatibility slot | zaman dilimli / uyumluluk dilimi | تقسيم زمني / فترة التوافق |
| hard min / soft target / hard max | sert alt sınır / yumuşak hedef / sert üst sınır | الحد الأدنى الصارم / الهدف المرن / الحد الأقصى الصارم |
| element targets | element hedefleri | أهداف العناصر |
| (dose program) draft / published / archived | taslak / yayımlandı / arşivlendi | مسودة / منشور / مؤرشف |
| episode (flow-watch) | olay | حادثة |
| settling (flow) | oturuyor | يستقر |
| coil (fallback channel label) | bobin | ملف |
| calibration / measurement | kalibrasyon / ölçüm | المعايرة / القياس |
| buffer solution | tampon çözelti | محلول منظِّم |
| probe / electrode | prob / elektrot | مجس / قطب |
| Drain (AMIC cell action) / Empty system / Conditioning | Boşalt / Sistemi boşalt / Şartlandırma | تصريف / تفريغ النظام / التهيئة |
| mV swing / display offset | mV salınımı / görüntüleme ofseti | تأرجح mV / إزاحة العرض |
| schedule slot | zaman dilimi | فترة |
| sample (lab / AMIC) / sample date | numune / numune tarihi | عيّنة / تاريخ العينة |
| lab analysis / lab reading | laboratuvar analizi / laboratuvar okuması | التحليل المخبري / قراءة مخبرية |
| nutrient (lab) | besin elementi | العنصر الغذائي |
| raw values | ham değerler | القيم الخام |
| cycle history | döngü geçmişi | سجل الدورات |

To decide:
- ☐ tr "görev oranı" for *duty cycle* (literal) vs "çalışma oranı"; ar "نسبة التشغيل".
- ☐ tr "dozlama denetleyicisi" / ar "وحدة التحكم في الحقن" for the *dose controller* card title.
- ☐ ar "حادثة" for a flow-watch *episode* (may read too alarming for a recovered one); alternative "واقعة".
- ☐ Ingredient *compatibility group* placeholder stays English in every language (`calcium / sulfate / phosphate / …`): the planner matches these codes, so users must type them in English.
- ☐ tr keeps the noun singular after numbers in lab / event counts ("{{count}} okuma", "Toplam {{count}} olay").

### Phase 2 — Equipment, Zones, Calibration, Relay events (agent C)

Namespaces: `equipment.json`, `zones.json`, `calibration.json`, `relayEvents.json`. Control logic on these pages is unchanged; only labels were translated.

| | Screen | tr | ar |
|---|---|---|---|
| ☐ | **Relay control modal** (Equipment → Relays): unknown-state notice "Relay states are **unknown**, not off" + write-only variant, pending "(command sent, awaiting confirmation)", "commanded ON/OFF", "Written but not confirmed — check the board", read-back toasts (`equipment.json: relay.*`) | ☐ | ☐ |
| ☐ | **All on / All off confirmation** with the channel list: "This will switch every relay on **Fan Board 1** OFF (6 channels):" + interlock "All on is disabled … can never be on together" (`relay.confirm*`, `relay.allOnInterlocked*`) | ☐ | ☐ |
| ☐ | Relay LED aria labels and status pills: pending / on / off / state unknown, write-only, read failed (`led.*`, `relay.*Pill`) | ☐ | ☐ |
| ☐ | Equipment list: columns, status pills (Online / Offline / Warning / Error / Disabled / "Not reported since …" / Never reported), relative "last seen", filters, pagination, live-updates pill, delete confirmation (`list.*, presentation.*, page.*`) | ☐ | ☐ |
| ☐ | Equipment detail modal: details rows, zones, calibration, channels + labels, Turn on / Turn off, connection test, History tab (time ranges, stats, table), Error logs tab, "View activity" (`detail.*`) | ☐ | ☐ |
| ☐ | Add / edit form + **register mapping editor** (register types, access, byte order and interlock tooltips, presets) (`form.*, mapping.*`); the desktop register table stays left-to-right | ☐ | ☐ |
| ☐ | Slave-ID scanner and discovered Modbus TCP devices (`scan.*`) | ☐ | ☐ |
| ☐ | Zones page: list, add / edit / delete dialogs, detail, assign equipment (`zones.json`) | ☐ | ☐ |
| ☐ | Calibration page: linear scale/offset, regression stats, latest estimate (ar uses ← instead of →), manual measurement, chart legend, pairs table (`calibration.json`) | ☐ | ☐ |
| ☐ | Relay events: stats cards, runs/raw tables, source labels (manual / automation / automation auto-off / watchdog force-off / all channels), **safety watchdog** help text "force-OFF … expected duration + grace period" (`relayEvents.json`) | ☐ | ☐ |

Terms coined here (add to the glossary once confirmed):

| English | Türkçe | العربية |
|---|---|---|
| register (Modbus) | register | سجل |
| register mapping | register eşlemesi | ربط السجلات |
| slave ID / unit ID | slave ID / birim ID | معرّف Slave / معرّف الوحدة |
| polling interval | sorgulama aralığı | فاصل الاستطلاع |
| request gap | istek aralığı | الفاصل بين الطلبات |
| scale / offset (calibration) | ölçek / ofset | المعامل / الإزاحة |
| unverified (scale/register) | doğrulanmamış | غير مُتحقَّق |
| write-only (board) | yalnızca yazma | للكتابة فقط |
| force-OFF (watchdog) | zorla kapatma | إطفاء قسري |
| grace period | tolerans süresi | مهلة السماح |
| overrun | süre aşımı | تجاوز المدة |
| stuck channel | takılı kalan kanal | قناة عالقة |
| lab reading / lab nutrient | laboratuvar okuması / laboratuvar besini | قراءة المختبر / عنصر المختبر |
| slope / intercept / fit | eğim / kesişim / uyum | الميل / نقطة التقاطع / المطابقة |
| parent zone / child zones | üst bölge / alt bölgeler | المنطقة الأم / المناطق الفرعية |

To decide:
- ☐ tr "coil" = "bobin" (aligned with the automations agent) in relay-modal errors; Modbus type names in the mapping editor stay "Holding / Input / Coil / Discrete (FC0x)" in every language, as in the device manuals.
- ☐ "CH1…CH6" channel prefix kept Latin in tr/ar (matches the labels printed on the boards).
- ☐ ar relay-modal ON/OFF column shows the state words "يعمل / مطفأ"; the unknown-state buttons use the verbs "تشغيل / إطفاء".
- ☐ Relay-event times are now shown in the farm time zone via `fmt.dateTime` (the API sends UTC SQLite timestamps; they used to be printed raw, i.e. in UTC).

### Phase 2 — Agronomist, Planner, Tasks (agent E)

| | Screen | tr | ar |
|---|---|---|---|
| ☐ | Agronomist header, status line, provider-failure banner (`agronomist.json: actions.*, status.*, health.*`) | ☐ | ☐ |
| ☐ | Report header: date list markers, older/newer arrows, failed / regenerate-failed / N days old / sources excluded pills (`header.*`) | ☐ | ☐ |
| ☐ | **Report translation states**: "Translated automatically from English", "Show original (English)" / "Show translation", "Translation in progress", "Translation failed — showing English", "only available in English", admin Translate + confirm ("one paid call") (`translation.*`) | ☐ | ☐ |
| ☐ | Report tabs + section titles (Crop / Irrigation / Nutrients / Climate / Risks, from section keys — never from report text), status at a glance, key-number "not current" (`section.*, tabs.*, overview.*, keyNumber.*`) | ☐ | ☐ |
| ☐ | Actions tab: priority groups, operator tasks from report, agronomist's notes (`actions.*, priority.*`) | ☐ | ☐ |
| ☐ | Discussion (clarifications) incl. the regenerate confirmation (`discussion.*`) | ☐ | ☐ |
| ☐ | Settings: schedule & model, thinking effort, reference sensors, zone roles, memory panel (`settings.*, reference.*, memory.*`) | ☐ | ☐ |
| ☐ | Data sources: in use / out of service, reason, back-on date, excluded equipment (`sources.*`) | ☐ | ☐ |
| ☐ | Canopy capture panel + frame strip (`capture.*`) | ☐ | ☐ |
| ☐ | Planner: header, scheduler line, plan list, failure banner (`planner.json: header.*, scheduler.*, list.*, failure.*`) | ☐ | ☐ |
| ☐ | Planner plan view: targets, yesterday's review, verdicts, risks, apply manifest, proposed automations, consistency warnings (`targets.*, review.*, verdict.*, sections.*, card.*, consistency.*`) | ☐ | ☐ |
| ☐ | **Planner Confirm & apply** dialog (INSERT / UPDATE / DISABLE counts + item list), **guardrail blockers / override dialog** (`confirmDialog.*, manifest.*, guardrails.*, override.*`) — must read as strongly as English | ☐ | ☐ |
| ☐ | Planner reject dialog, plan discussion, settings modal (`reject.*, discussion.*, settings.*`) | ☐ | ☐ |
| ☐ | Tasks: filters, summary, "Hide outdated", task card, done / decline / snooze dialogs, translation notes + "Show original" (`tasks.json`) | ☐ | ☐ |

Terms coined here (add to the glossary once confirmed):

| English | Türkçe | العربية |
|---|---|---|
| report (agronomist) | rapor | تقرير |
| planner / plan | planlayıcı / plan | المخطِّط / خطة |
| data source | veri kaynağı | مصدر بيانات |
| in use / out of service (data source) | kullanımda / hizmet dışı | قيد الاستخدام / خارج الخدمة |
| weekly rollup | haftalık özet | الملخص الأسبوعي |
| long-term memory | uzun süreli bellek | الذاكرة طويلة المدى |
| clarification | açıklama | توضيح |
| regenerate | yeniden oluşturmak | إعادة الإنشاء |
| canopy capture / frame | kanopi çekimi / kare | تصوير المجموع الخضري / لقطة |
| noon session | öğle çekimi | جلسة الظهيرة |
| reference sensor | referans sensör | الحساس المرجعي |
| thinking effort | düşünme düzeyi | مستوى التفكير |
| system prompt | sistem istemi | موجّه النظام |
| recommendation / priority | öneri / öncelik | توصية / الأولوية |
| operator task | operatör görevi | مهمة المشغّل |
| snooze / decline / reopen (task) | ertele / reddet / yeniden aç | تأجيل / رفض / إعادة فتح |
| outdated (task) | eskimiş | متقادمة |
| guardrail | koruma kuralı | قاعدة حماية |
| override (guardrail) | geçersiz kılma | تجاوز |
| target (planner) / scorecard | hedef / karne | هدف / بطاقة التقييم |
| verdict pass / partial / fail | geçti / kısmi / başarısız | ناجح / جزئي / فاشل |
| apply manifest | uygulama listesi | قائمة التطبيق |
| tank duty (%) | tank (dozlama) oranı | نسبة تشغيل الخزان |
| translated automatically | otomatik çevrildi | تُرجم تلقائيًا |

To decide:
- ☐ ar "خارج الخدمة" (out of service, data sources) sits next to "في الخدمة" = armed (automations). Different screens, but a reviewer should confirm no one reads a data source as "disarmed".
- ☐ Planner manifest verbs are translated (EKLE / GÜNCELLE / DEVRE DIŞI BIRAK, إضافة / تحديث / تعطيل); keep them, or keep the English INSERT / UPDATE / DISABLE as on the audit log?
- ☐ tr "Agronomist" left as is (glossary). ar page title "المهندس الزراعي".
- ☐ Planner/agronomist dates and times now use the farm time zone (`fmt.dateTime`) instead of the phone's; plan dates (calendar days) are formatted in UTC so the weekday never shifts.

### Phase 2 — agent F: Reports, Logs, Alerts, Cameras, Analytics, Debug, 404

Screens (namespace file):

| | Screen | tr | ar |
|---|---|---|---|
| ☐ | Alerts page: filters, summary line, Acknowledge / Acknowledge all + confirmation, empty states, "Show original (English)" toggle (`alerts.json`) | ☐ | ☐ |
| ☐ | Logs page: presets, time ranges, filters, legend, audit-start note, day headings (`logs.json`) | ☐ | ☐ |
| ☐ | Logs detail drawer: facts, relay writes ("read-back did NOT confirm"), field changes, raw blocks (`logs.json: drawer.*`) | ☐ | ☐ |
| ☐ | Reports: KPIs, day rows, day detail, legend, power table (`reports.json: page.*`) | ☐ | ☐ |
| ☐ | Reports measured section: comparison / runs / cycles tables, coverage line, flags, caveats, calibration hint (`reports.json: measured.*, calibration.*`) | ☐ | ☐ |
| ☐ | Fertigation → Measured dosing card (`reports.json: dosingCard.*`) and Reports → Consumption tracker (`consumption.*`) | ☐ | ☐ |
| ☐ | Cameras: cards, capture age, add/edit form, delete confirmation, history, live view errors (`cameras.json`) | ☐ | ☐ |
| ☐ | PTZ pad: direction names, presets, status badge (`cameras.json: ptz.*`) | ☐ | ☐ |
| ☐ | Data Export (`analytics.json`), System Debug (`debug.json`), 404 (`notFound.json`) | ☐ | ☐ |

Terms coined:

| English | Türkçe | العربية |
|---|---|---|
| acknowledge (alert) | onayla | تأكيد الاطلاع |
| acknowledged / unacknowledged | onaylanmış / onaylanmamış | مؤكَّدة / غير مؤكَّدة |
| repeats collapsed | tekrar birleştirildi | تكرارات مدمجة |
| activity log / audit log | etkinlik kaydı / denetim kaydı | سجل النشاط / سجل التدقيق |
| request log | istek günlüğü | سجل الطلبات |
| refused (403) / notable | reddedildi / dikkat çekici | مرفوض / لافت |
| unconfirmed | doğrulanmadı | غير مؤكَّد |
| relay drift | röle sapması | انحراف المرحّلات |
| measured / estimated (source tag) | ölçülen (ölç) / tahmini (tah) | مقيس / تقديري (تقدير) |
| not metered | ölçülmüyor | غير مقيس |
| monitor (irrigation monitor, short) | izleme | المراقِب |
| drain-back blip | geri drenaj sıçraması | ارتداد صرف |
| coverage (partial / complete day) | kısmi / tam | جزئي / كامل |
| calibration hint / implied flow | kalibrasyon ipucu / çıkarılan debi | تلميح المعايرة / التدفق المستنتج |
| baseline (consumption tracker) | başlangıç değeri | خط الأساس |
| snapshot / capture | anlık görüntü / kayıt | لقطة / التقاط |
| pan / tilt / zoom, preset (PTZ) | çevir / eğ / yakınlaştır, ön ayar | تدوير / إمالة / تكبير، موضع محفوظ |
| W / F row letters (Reports) | S / F | م / س |

To decide:
- ☐ tr "Alarmlar" for the Alerts page title (glossary: alert = alarm in tr). Fine next to the header alarm badge?
- ☐ ar "تأكيد الاطلاع" (acknowledge) is long for a phone button; shorter alternative "اطّلعت".
- ☐ Consumption tracker "Stop" = stop *tracking* a meter (tr "Bırak", ar "إيقاف التتبّع") — deliberately not the Stop All wording.
- ☐ PTZ centre button "Stop moving" (tr "Hareketi durdur", ar "إيقاف الحركة") — camera movement only, not a relay stop.
- ☐ Reports row letters W / F → tr S / F, ar م / س: clear enough, or spell "Su / Fert"?
- ☐ The numeric tables in Reports (comparison, runs, cycles, calibration, power, measured dosing) stay left-to-right in Arabic like the last-cycle table; the PTZ pad stays left-to-right (pan-left is the camera's left).

### Crop & Nutrition + fertilizer advisor (2026-09-28)

Machine-translated, pending native review: `frontend/src/locales/{tr,ar}/nutrition.json`, `nav:items.nutrition`, backend `src/i18n/{tr,ar}/fertilizer_advisor.json`. New glossary rows: crop profile, crop cycle, variety / breeder, transplant, growth stages, dripper, buffer tank, source water, fertilizer advisor, second opinion, agronomist protocol, agrees / extends / differs, advisory only.

To decide:
- ☐ tr "Islahçı firma" / ar "شركة الإنتاج" for *breeder* (seed company, e.g. Sakata).
- ☐ ar "النقاط" for *dripper* (alternative "المنقط").
- ☐ Stage *flowering* is shown as "flowering / fruit set" (tr "Çiçeklenme / meyve tutumu", ar "الإزهار / عقد الثمار") because the cucumber protocol's day 25-32 phase is first fruit set.
- ☐ The AI advice text itself is translated by the model (AgronomistTranslationService helpers, same glossary); only the UI chrome is in these files.

