# SenseHub glossary — English / Türkçe / العربية

**Mandatory for every translation** (frontend `src/locales/*`, backend message catalogues, the agronomist translation prompt). If a term is missing, add it here in the same change. All tr/ar entries are machine-chosen and pending native review (`docs/i18n-review.md`).

Aligned with the backend agent's term list (2026-09-27). Where the two differed, the choice below wins and the backend should follow it (marked ⚑).

## Safety controls — exact wording

| English | Türkçe | العربية | Notes |
|---|---|---|---|
| Stop All (header button) | Tümünü Durdur | إيقاف الكل | Switches EVERY relay off incl. all fans/climate; automations stay armed. |
| Stop (compact label on phones) | Durdur | إيقاف | Only as the 390 px label of Stop All. |
| Emergency stop / E-STOP | Acil Durdurma (short: Acil Dur) | إيقاف الطوارئ | Everything off + automations disarmed. |
| Stop irrigation | Sulamayı Durdur | إيقاف الري | Pumps, zones, dosing only — fans and climate keep running. |
| armed (automations) | devrede | في الخدمة | Global state of the automation engine. |
| disarmed (automations) | askıda / askıya alındı | موقوفة | ⚑ Not "devre dışı"/"معطّلة": those mean *disabled* (a single rule/device). |
| re-arm | yeniden devreye almak | استئناف الأتمتة | |
| disable / disabled (a rule, a device) | devre dışı bırakmak / devre dışı | تعطيل / معطّل | |
| enable / enabled | etkinleştirmek / etkin | تفعيل / مفعّل | |
| energised (relay) | enerjili | تحت الجهد | "may still be energised" = "hâlâ enerjili olabilir" = "قد تكون لا تزال تحت الجهد". |
| switch off at the panel | panodan kapatın | أطفئها من لوحة التحكم | Keep the imperative; never soften. |
| confirmed OFF / NOT confirmed | KAPALI doğrulandı / DOĞRULANMADI | الإطفاء مؤكَّد / غير مؤكَّد | Keep capitals where English has them. |
| pending timer | bekleyen zamanlayıcı | مؤقّت معلّق | |
| sensor polling (paused) | sensör sorgulama (duraklatıldı) | استطلاع الحساسات (متوقف مؤقتًا) | |
| heartbeat poll | yaşam sinyali sorgusu | نبضة الاستطلاع | |
| fail-safe (firmware) | arıza emniyeti | حماية الإيقاف | |

## Relay states and status

| English | Türkçe | العربية | Notes |
|---|---|---|---|
| ON (relay state) | AÇIK | يعمل | State word, not an action. |
| OFF (relay state) | KAPALI | مطفأ | Not "متوقف" (too close to disarmed "موقوفة"). |
| unknown | bilinmiyor | غير معروف | Never rendered as OFF. |
| stale | eski | قديمة | |
| commanded (write-only) | komut verildi | صدر أمر | |
| read-back | geri okuma | القراءة الراجعة | |
| ok / normal | normal | طبيعي / سليم | "سليم" for a completed zone/run. |
| caution | dikkat | تنبيه | |
| alarm | alarm | إنذار | |
| alert (an item on the Alerts page) | alarm | تنبيه | tr uses "alarm" for both. |
| critical / warning / info | kritik / uyarı / bilgi | حرج / تحذير / معلومة | |
| online / offline | çevrim içi / çevrim dışı | متصل / غير متصل | ⚑ TDK spelling "çevrim içi" (backend wrote "çevrimiçi"). |
| idle | beklemede | خامل | |
| irrigating | sulama yapılıyor | الري جارٍ | |
| in progress | sürüyor | جارٍ | |
| cut short | erken kesildi | انتهى مبكرًا | |
| shut down | kapatıldı | أُطفئ | |
| no water | su yok | لا ماء | |
| stopped by operator | operatör durdurdu | أوقفه المشغّل | |

## Farm and fertigation terms

| English | Türkçe | العربية |
|---|---|---|
| irrigation | sulama | الري |
| irrigation zone / zone | sulama bölgesi / bölge | منطقة الري / المنطقة |
| fertigation | fertigasyon | التسميد بالري |
| dosing | dozlama | الحقن |
| dose cycle | dozlama döngüsü | دورة الحقن |
| dosing tank | dozlama tankı | خزان الحقن |
| dosing valve | dozlama vanası | صمام الحقن |
| dosing board | dozlama kartı | لوحة الحقن |
| dose program | dozlama programı | برنامج الحقن |
| recipe | reçete | وصفة |
| stock solution | stok çözelti | المحلول المركّز |
| concentrate | konsantre | المركّز |
| fertiliser | gübre | السماد |
| venturi | venturi | فنتوري |
| pump / irrigation pump / mixing pump | pompa / sulama pompası / karıştırma pompası | مضخة / مضخة الري / مضخة الخلط |
| valve | vana | صمام |
| pH Down | pH düşürücü | خفض pH |
| relay | röle | مرحّل (colloquial: ريليه — reviewer to decide) |
| relay board / board | röle kartı / kart | لوحة المرحّلات / لوحة |
| channel | kanal | قناة |
| panel (manual control panel) | pano | لوحة التحكم |
| controller (SenseHub) | denetleyici | وحدة التحكم |
| interlock / interlocked | kilitleme / kilitlemeli | تعشيق / معشّق |
| flow | debi | التدفق |
| flow meter | debimetre | عداد التدفق |
| expected flow | beklenen debi | التدفق المتوقع |
| flow watch | debi izleme | مراقبة التدفق |
| irrigation monitor (device) | sulama izleme cihazı | جهاز مراقبة الري |
| drain | drenaj | الصرف |
| substrate | substrat | وسط الزراعة |
| substrate moisture | substrat nemi | رطوبة وسط الزراعة |
| pore EC | gözenek EC | EC المسامي |
| canopy | kanopi (bitki örtüsü) | المجموع الخضري |
| setpoint | ayar noktası | نقطة الضبط |
| relative humidity | bağıl nem | الرطوبة النسبية |
| shielded / exposed (sensor) | korumalı / açık | محمي / مكشوف |
| fans / climate relays | fanlar / iklim röleleri | المراوح / مرحّلات التحكم المناخي |
| cooling pads | pedler | وسائد التبريد |
| shade (open / close) | gölgelik (aç / kapat) | التظليل (فتح / إغلاق) |
| automation / automation rule | otomasyon / otomasyon kuralı | الأتمتة / قاعدة أتمتة |
| climate rules | iklim kuralları | قواعد المناخ |
| schedule / scheduled / manual | program / zamanlanmış / manuel | جدول / مجدول / يدوي |
| run (an irrigation run) | çalışma | تشغيل |
| cycle | döngü | دورة |
| watchdog | izleme servisi | خدمة المراقبة |
| cold restart | soğuk yeniden başlatma | إعادة تشغيل باردة |
| sensor | sensör | الحساس |
| equipment | ekipman | المعدات |
| agronomist | agronomist | المهندس الزراعي |
| crop | ürün | المحصول |
| dashboard | gösterge paneli | لوحة المتابعة |
| status board | durum panosu | لوحة الحالة |

## Units and abbreviations — never translated

EC, pH, mS/cm, µS/cm, L, L/h, L/min, m³, m³/h, °C, %, kPa, kWh, VPD, RH, ppm, CO₂, ratios (1:200), tank letters (A–D), relay / channel / zone numbers, Modbus, MQTT, SEKO, AMIC, Priva, SenseHub, A20Core, product and chemical names.

Digits are always Western 0-9 (Arabic included); the decimal mark is always `.`.

Duration words are localized (they are words, not SI units):

| English | Türkçe | العربية |
|---|---|---|
| s | sn | ث |
| min | dk | د |
| h | sa | س |
| d (days, ranges) | gün | أيام |
