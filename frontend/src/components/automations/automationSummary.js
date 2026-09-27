/**
 * Pure helpers for the Automations page: parse rows, build the one-line
 * "WHEN → WHAT" summary from trigger + actions, classify rules into farm
 * sections, mirror the backend hysteresis pairing (AutomationGuards.js,
 * read-only) and compute schedule previews. No React, no fetch.
 *
 * i18n: every helper that produces text takes an optional `loc = { t, lng }`
 * (components pass the `t` of useTranslation('automations') and the active
 * language). The sentence is assembled from whole templates in
 * locales/<lng>/automations.json (`summary.*`), so each language keeps its own
 * word order ("Irrigation Pump ON 18 min" / "Irrigation Pump AÇIK 18 dk" /
 * "تشغيل Irrigation Pump لمدة 18 د"). Channel and equipment names are user
 * data and are never translated; in Arabic they are wrapped in bidi isolates.
 * Without `loc` the helpers speak English (tests, logs).
 */
import { getChannelDisplayName } from '../../utils/channelUtils';
import { toEpochMs } from '../../utils/freshness';
import { DURATION_UNITS } from '../../i18n/format';
import { dirOf, intlLocale } from '../../i18n/languages';
import EN_AUTOMATIONS from '../../locales/en/automations.json';

// ---------------------------------------------------------------------------
// Translation plumbing (pure: no i18next instance needed)
// ---------------------------------------------------------------------------

const lookup = (res, key) => key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), res);

/**
 * Minimal i18next-compatible `t` over a plain resource object: dotted keys,
 * `{{var}}` interpolation, `count` plurals via Intl.PluralRules (`key_one`,
 * `key_few`… like i18next) and `defaultValue`. Used as the English default and
 * by the unit tests for tr/ar.
 */
export function makeTranslator(resources, lng = 'en') {
  const rules = new Intl.PluralRules(lng);
  return (key, params = {}) => {
    let s;
    if (typeof params.count === 'number') {
      s = lookup(resources, `${key}_${rules.select(params.count)}`);
      if (s === undefined) s = lookup(resources, `${key}_other`);
    }
    if (s === undefined) s = lookup(resources, key);
    if (typeof s !== 'string') return params.defaultValue !== undefined ? params.defaultValue : key;
    return s.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (params[k] === undefined ? m : String(params[k])));
  };
}

const EN_LOC = { t: makeTranslator(EN_AUTOMATIONS, 'en'), lng: 'en' };
const L = (loc) => (loc && typeof loc.t === 'function' ? loc : EN_LOC);

const FSI = '\u2068';
const LRI = '\u2066';
const PDI = '\u2069';
const isRtl = (loc) => dirOf(loc.lng) === 'rtl';
/** User data (names) inside a translated sentence: first-strong isolate in RTL. */
const iso = (s, loc) => (isRtl(loc) ? `${FSI}${s}${PDI}` : String(s));
/** Technical left-to-right fragment ("> 30 °C", cron): LTR isolate in RTL. */
const ltrIso = (s, loc) => (isRtl(loc) ? `${LRI}${s}${PDI}` : String(s));
/** Collapse the gaps left by empty optional slots ("{{spec}}" = ''). */
const tidy = (s) => String(s).replace(/ {2,}/g, ' ').replace(/ ([,،)])/g, '$1').trim();

/** Remove bidi isolates (e.g. before saving a suggested name to the database). */
export function stripIsolates(s) {
  return String(s ?? '').replace(/[\u2066-\u2069]/g, '');
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function parseJson(raw, fallback) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return fallback; }
}

/** Register mappings of an equipment row as an array (JSON string or array). */
export function parseRegisterMappings(eq) {
  if (!eq || !eq.register_mappings) return [];
  const m = parseJson(eq.register_mappings, []);
  return Array.isArray(m) ? m : [];
}

export function isEnabled(auto) {
  return auto?.enabled === 1 || auto?.enabled === true;
}

/** Normalise an automation row into plain objects. */
export function parseAutomation(auto) {
  const trigger = parseJson(auto?.trigger_config, {}) || {};
  const conditions = parseJson(auto?.conditions, []);
  const actions = parseJson(auto?.actions, []);
  const skipConditions = parseJson(auto?.skip_conditions, []);
  return {
    trigger: typeof trigger === 'object' ? trigger : {},
    conditions: Array.isArray(conditions) ? conditions : [],
    actions: Array.isArray(actions) ? actions : [],
    skipConditions: Array.isArray(skipConditions) ? skipConditions : [],
  };
}

// ---------------------------------------------------------------------------
// Equipment index: id -> { name, status, enabled, coils: Map(reg -> label), metrics[] }
// ---------------------------------------------------------------------------

const toReg = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

export function buildEquipmentIndex(equipmentList, loc) {
  const index = new Map();
  for (const eq of Array.isArray(equipmentList) ? equipmentList : []) {
    if (!eq || eq.id === undefined) continue;
    const mappings = parseRegisterMappings(eq);
    const coils = new Map();
    const metrics = [];
    for (const m of mappings) {
      if (!m) continue;
      const reg = toReg(m.register ?? m.address);
      if (m.type === 'coil') {
        if (reg !== null) coils.set(reg, { label: getChannelDisplayName(m), access: m.access, mapping: m });
      } else {
        metrics.push({ name: m.name, label: m.label || m.name, unit: m.unit || '', register: reg });
      }
    }
    index.set(Number(eq.id), {
      id: Number(eq.id),
      name: eq.name || L(loc).t('summary.fallback.equipment', { id: eq.id }),
      type: eq.type,
      status: eq.status,
      enabled: eq.enabled === 1 || eq.enabled === true,
      coils,
      metrics,
      mappings,
      row: eq,
    });
  }
  return index;
}

export function equipmentLabel(equipIndex, id, loc) {
  const e = equipIndex?.get(Number(id));
  return e ? e.name : L(loc).t('summary.fallback.equipment', { id });
}

export function channelLabel(equipIndex, eqId, channel, loc) {
  const e = equipIndex?.get(Number(eqId));
  const reg = toReg(channel);
  const c = e && reg !== null ? e.coils.get(reg) : null;
  return c ? c.label : L(loc).t('summary.fallback.channel', { n: channel });
}

/** Writable coils of an equipment as [{ register, label }] sorted by register. */
export function writableCoils(equipIndex, eqId) {
  const e = equipIndex?.get(Number(eqId));
  if (!e) return [];
  return [...e.coils.entries()]
    .filter(([, c]) => c.access === 'readwrite')
    .map(([register, c]) => ({ register, label: c.label, mapping: c.mapping }))
    .sort((a, b) => a.register - b.register);
}

// ---------------------------------------------------------------------------
// WHEN
// ---------------------------------------------------------------------------

export const OP_SYM = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=', neq: '≠' };

/** Known sensor types -> key under summary.metric (short) / summary.metricLong. */
const METRIC_KEY = {
  temperature: 'temp',
  humidity: 'rh',
  'substrate moisture': 'vwc',
  'substrate temperature': 'substrateTemp',
  'water temperature': 'waterTemp',
};

export function metricShort(sensorType, loc) {
  const { t } = L(loc);
  const s = String(sensorType || '').trim();
  const k = METRIC_KEY[s.toLowerCase()];
  if (k) return t(`summary.metric.${k}`);
  return s || t('summary.metric.value');
}

function metricLong(sensorType, loc) {
  const { t } = L(loc);
  const s = String(sensorType || '').trim();
  const k = METRIC_KEY[s.toLowerCase()];
  if (k) return t(`summary.metricLong.${k}`);
  return s || t('summary.metric.value');
}

export function formatValueUnit(value, unit) {
  const v = value === undefined || value === null || value === '' ? '?' : String(value);
  const u = String(unit || '').trim();
  return u ? `${v} ${u}` : v;
}

export function describeThreshold(trigger, equipIndex, { long = false, loc } = {}) {
  const lc = L(loc);
  const op = OP_SYM[trigger?.operator] || trigger?.operator || '>';
  const metric = iso(long ? metricLong(trigger?.sensor_type, lc) : metricShort(trigger?.sensor_type, lc), lc);
  // Comparison + value + unit stay one left-to-right unit, as on the panels.
  const cmp = ltrIso(`${op} ${formatValueUnit(trigger?.threshold_value, trigger?.unit)}`, lc);
  if (long && trigger?.equipment_id) {
    return tidy(lc.t('summary.when.thresholdLong', { metric, sensor: iso(equipmentLabel(equipIndex, trigger.equipment_id, lc), lc), cmp }));
  }
  return tidy(lc.t('summary.when.threshold', { metric, cmp }));
}

const pad2 = (n) => String(n).padStart(2, '0');

/** Localized weekday name for 0 = Sunday … 6 = Saturday. */
export function weekdayName(dow, { long = false, loc } = {}) {
  const lc = L(loc);
  const d = Number.isInteger(dow) && dow >= 0 && dow <= 6 ? dow : 1;
  // 2023-01-01 was a Sunday; format in UTC so the day never shifts.
  return new Intl.DateTimeFormat(intlLocale(lc.lng), { weekday: long ? 'long' : 'short', timeZone: 'UTC' })
    .format(new Date(Date.UTC(2023, 0, 1 + d)));
}

function monthShort(date, loc) {
  return new Intl.DateTimeFormat(intlLocale(L(loc).lng), { month: 'short' }).format(date);
}

export function describeSchedule(trigger, { long = false, loc } = {}) {
  const lc = L(loc);
  const { t } = lc;
  const type = trigger?.schedule_type || 'daily';
  const time = trigger?.time || '08:00';
  if (type === 'once') {
    if (!trigger?.run_at) return t(long ? 'summary.when.onceUnsetLong' : 'summary.when.onceUnset');
    const d = new Date(trigger.run_at);
    if (Number.isNaN(d.getTime())) return t('summary.when.once', { date: ltrIso(trigger.run_at, lc) });
    return t('summary.when.once', { date: `${d.getDate()} ${monthShort(d, lc)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` });
  }
  if (type === 'daily') return t(long ? 'summary.when.dailyLong' : 'summary.when.daily', { time });
  if (type === 'weekly') {
    const day = weekdayName(parseInt(trigger?.day_of_week ?? 1, 10), { long, loc: lc });
    return t(long ? 'summary.when.weeklyLong' : 'summary.when.weekly', { day, time });
  }
  if (type === 'hourly') {
    const minute = pad2(parseInt(trigger?.minute ?? 0, 10) || 0);
    return t(long ? 'summary.when.hourlyLong' : 'summary.when.hourly', { minute });
  }
  if (type === 'custom') return trigger?.cron ? t('summary.when.cron', { cron: ltrIso(trigger.cron, lc) }) : t('summary.when.cronUnset');
  return t('summary.when.schedule');
}

export function describeWhen(trigger, equipIndex, opts = {}) {
  const type = trigger?.type || 'manual';
  if (type === 'threshold') return describeThreshold(trigger, equipIndex, opts);
  if (type === 'schedule') return describeSchedule(trigger, opts);
  if (type === 'event') return L(opts.loc).t('summary.when.event');
  return L(opts.loc).t('summary.when.manual');
}

export const TRIGGER_LABELS = { manual: 'Manual', schedule: 'Schedule', threshold: 'Threshold', event: 'Event' };

// ---------------------------------------------------------------------------
// WHAT
// ---------------------------------------------------------------------------

/**
 * Compact duration for summaries: 18 -> "18 s", 278 -> "4 min 38 s",
 * 3900 -> "1 h 5 min". Unit words per language (i18n/format DURATION_UNITS):
 * "4 dk 38 sn", "4 د 38 ث". `loc` may be a { t, lng } object or a language code.
 */
export function formatDuration(seconds, loc) {
  const lng = typeof loc === 'string' ? loc : L(loc).lng;
  const u = DURATION_UNITS[lng] || DURATION_UNITS.en;
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return '';
  if (s < 60) return `${s} ${u.s}`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  const parts = [];
  if (h) parts.push(`${h} ${u.h}`);
  if (m) parts.push(`${m} ${u.min}`);
  if (rest) parts.push(`${rest} ${u.s}`);
  return parts.join(' ');
}

/**
 * Flatten actions into relay targets: one entry per (equipment, channel, action).
 * "All channels" control actions expand to every writable coil; transitions
 * map each channel's state. Duplicates (same key) keep the first occurrence.
 */
export function collectTargets(actions, equipIndex, loc) {
  const lc = L(loc);
  const out = [];
  const seen = new Map();
  const push = (eqId, channel, action, extra) => {
    const key = `${eqId}:${channel}:${action}`;
    if (seen.has(key)) {
      // Same channel switched again later in the run (soft-switch: pumps once per zone).
      const t = seen.get(key);
      t.windows += 1;
      const d = Number(extra.duration_seconds) > 0 ? Number(extra.duration_seconds) : null;
      if (d !== t.duration) t.durationVaries = true;
      return;
    }
    const e = equipIndex?.get(Number(eqId));
    const target = {
      eqId: Number(eqId),
      eqName: e ? e.name : (extra.equipment_name || lc.t('summary.fallback.equipment', { id: eqId })),
      channel,
      label: e ? channelLabel(equipIndex, eqId, channel, lc) : (extra.channel_name || lc.t('summary.fallback.channel', { n: channel })),
      action,
      value: extra.value ?? null,
      duration: Number(extra.duration_seconds) > 0 ? Number(extra.duration_seconds) : null,
      delay: Number(extra.delay_seconds) > 0 ? Number(extra.delay_seconds) : null,
      online: e ? (e.enabled && e.status === 'online') : null,
      windows: 1,
      durationVaries: false,
    };
    seen.set(key, target);
    out.push(target);
  };

  for (const a of Array.isArray(actions) ? actions : []) {
    if (!a || typeof a !== 'object') continue;
    const eqId = parseInt(a.equipment_id, 10);
    if (!Number.isFinite(eqId)) continue;
    if (a.type === 'transition' && Array.isArray(a.transitions)) {
      for (const t of a.transitions) {
        const ch = toReg(t.channel);
        if (ch === null) continue;
        push(eqId, ch, t.state ? 'on' : 'off', { ...a, channel_name: t.name, value: null });
      }
    } else if (a.type === 'control') {
      const action = a.action || 'on';
      if (a.channel === null || a.channel === undefined || a.channel === '') {
        const coils = writableCoils(equipIndex, eqId);
        if (coils.length) {
          for (const c of coils) push(eqId, c.register, action, a);
        } else {
          push(eqId, '*', action, { ...a, channel_name: lc.t('summary.fallback.allChannelsLower') });
        }
      } else {
        const ch = toReg(a.channel);
        if (ch !== null) push(eqId, ch, action, a);
      }
    }
  }
  return out;
}

/** "01-03-05 Big Fan" -> "Big Fan"; "Irrigation Zone 1" -> "Irrigation Zone" (case kept). */
export function kindOfRaw(label) {
  let s = String(label || '').trim();
  s = s.replace(/^[\d\s\-–—/&.,()]+/, '');
  s = s.replace(/[\s\-–—#]*\d+\s*$/, '');
  s = s.trim();
  return s || String(label || 'channel');
}

/** "01-03-05 Big Fan" -> "big fan"; "Irrigation Zone 1" -> "irrigation zone". */
export function kindOf(label) {
  return kindOfRaw(label).toLowerCase();
}

export function pluralize(kind, n) {
  if (n === 1) return kind;
  return /s$/.test(kind) ? kind : `${kind}s`;
}

/** Localized action word of the summary: ON / AÇIK / تشغيل … */
export function actionWord(action, loc) {
  const a = String(action || 'on');
  return L(loc).t(`summary.action.${a}`, { defaultValue: a.toUpperCase() });
}

/**
 * The channel kind of a group, as the language wants it (`summary.kindStyle`):
 * English pluralizes the lower-cased stem ("irrigation zones"); Turkish and
 * Arabic keep the channel name as written ("Irrigation Zone") because it is
 * user data that cannot be inflected.
 */
function kindsOf(seg, n, lc) {
  return lc.t('summary.kindStyle') === 'englishPlural' ? pluralize(seg.kind, n) : iso(seg.kindRaw, lc);
}

/**
 * Same-kind targets with different start delays: "irrigation zones 1→4" +
 * "in sequence" when each starts as the previous one's duration ends (±2 s),
 * otherwise "staggered". Null when they all start together.
 */
function describeSequence(seg, lc) {
  const { t } = lc;
  const items = [...seg.items].sort((a, b) => (a.delay || 0) - (b.delay || 0));
  const delays = new Set(items.map(x => x.delay || 0));
  if (delays.size < 2) return null;
  const chained = seg.duration > 0 && items.every((x, i) => i === 0 || Math.abs((x.delay || 0) - ((items[i - 1].delay || 0) + seg.duration)) <= 2);
  const nums = items.map(x => { const m = /(\d+)\s*$/.exec(String(x.label)); return m ? parseInt(m[1], 10) : null; });
  const names = { kinds: kindsOf(seg, items.length, lc) };
  let subject = t('summary.subject.count', { ...names, n: items.length });
  if (nums.every(n => n !== null)) {
    const consecutive = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
    subject = consecutive
      ? t('summary.subject.range', { ...names, from: nums[0], to: nums[nums.length - 1] })
      : t('summary.subject.list', { ...names, list: nums.join(t('summary.listArrow')) });
  }
  return { subject, how: t(chained ? 'summary.how.inSequence' : 'summary.how.staggered') };
}

export function describeTargets(targets, loc) {
  const lc = L(loc);
  const { t } = lc;
  if (!targets.length) return '';
  const byAction = new Map();
  for (const x of targets) {
    if (!byAction.has(x.action)) byAction.set(x.action, []);
    byAction.get(x.action).push(x);
  }
  const dur = (s) => formatDuration(s, lc);
  const parts = [];
  for (const [action, list] of byAction) {
    const word = actionWord(action, lc);
    const segs = new Map();
    for (const x of list) {
      const key = `${kindOf(x.label)}|${x.duration || ''}|${x.value ?? ''}`;
      if (!segs.has(key)) segs.set(key, { kind: kindOf(x.label), kindRaw: kindOfRaw(x.label), duration: x.duration, value: x.value, items: [] });
      segs.get(key).items.push(x);
    }
    // "[value] [for] duration": the part after the action word.
    const spec = (d, value) => [
      action === 'set' && value !== null && value !== undefined ? String(value) : '',
      d ? t('summary.forDuration', { duration: dur(d) }) : '',
    ].filter(Boolean).join(' ');
    if (segs.size <= 3) {
      for (const seg of segs.values()) {
        if (seg.items.length === 1) {
          const x = seg.items[0];
          const label = iso(x.label, lc);
          if (x.windows > 1) {
            let text = x.durationVaries || !seg.duration
              ? t('summary.target.repeatTimes', { label, action: word, count: x.windows })
              : t('summary.target.repeatEach', { label, action: word, spec: spec(seg.duration, seg.value), n: x.windows });
            if (x.delay) text = t('summary.target.firstAfter', { text: tidy(text), delay: dur(x.delay) });
            parts.push(tidy(text));
            continue;
          }
          const key = x.delay ? 'summary.target.singleAfter' : 'summary.target.single';
          parts.push(tidy(t(key, { label, action: word, spec: spec(seg.duration, seg.value), delay: x.delay ? dur(x.delay) : '' })));
          continue;
        }
        const seq = describeSequence(seg, lc);
        if (seq) {
          const key = seg.duration ? 'summary.target.sequenceEach' : 'summary.target.sequence';
          parts.push(tidy(t(key, { subject: seq.subject, action: word, spec: spec(seg.duration, seg.value), how: seq.how })));
          continue;
        }
        const subject = t('summary.subject.count', { kinds: kindsOf(seg, seg.items.length, lc), n: seg.items.length });
        parts.push(tidy(t('summary.target.group', { subject, action: word, spec: spec(seg.duration, seg.value) })));
      }
    } else {
      const durations = list.map(x => x.duration || 0);
      const max = Math.max(...durations);
      const min = Math.min(...durations);
      const specText = max > 0
        ? (max === min ? t('summary.forDuration', { duration: dur(max) }) : t('summary.upTo', { duration: dur(max) }))
        : '';
      parts.push(tidy(t('summary.target.group', { subject: t('summary.relays', { count: list.length }), action: word, spec: specText })));
    }
  }
  return parts.join(t('summary.joinComma'));
}

export function describeWhat(actions, equipIndex, loc) {
  const lc = L(loc);
  const { t } = lc;
  const list = Array.isArray(actions) ? actions : [];
  if (!list.length) return t('summary.what.none');
  const parts = [];
  const relayText = describeTargets(collectTargets(list, equipIndex, lc), lc);
  if (relayText) parts.push(relayText);
  const alerts = list.filter(a => a?.type === 'alert');
  const logs = list.filter(a => a?.type === 'log');
  if (alerts.length === 1) {
    const sev = alerts[0].severity || 'info';
    parts.push(t('summary.what.alertOne', { severity: t(`summary.severity.${sev}`, { defaultValue: sev }) }));
  } else if (alerts.length > 1) parts.push(t('summary.what.alerts', { count: alerts.length }));
  if (logs.length === 1) parts.push(t('summary.what.logOne'));
  else if (logs.length > 1) parts.push(t('summary.what.logs', { count: logs.length }));
  const unknown = list.filter(a => a && !['alert', 'log', 'control', 'transition'].includes(a.type));
  if (unknown.length) parts.push(t('summary.what.other', { count: unknown.length }));
  return parts.join(t('summary.joinPlus')) || t('summary.what.none');
}

/**
 * @returns {{ when: string, what: string, text: string, long: string, triggerType: string }}
 */
export function summarizeAutomation(auto, equipIndex, loc) {
  const lc = L(loc);
  const { trigger, actions } = parseAutomation(auto);
  const when = describeWhen(trigger, equipIndex, { loc: lc });
  const what = describeWhat(actions, equipIndex, lc);
  const long = lc.t('summary.line', { when: describeWhen(trigger, equipIndex, { long: true, loc: lc }), what });
  return { when, what, text: lc.t('summary.line', { when, what }), long, triggerType: trigger?.type || 'manual' };
}

/** Same summary for the builder's in-progress form data (objects, not JSON). */
export function summarizeForm(formData, equipIndex, loc) {
  return summarizeAutomation({ trigger_config: formData.trigger_config, actions: formData.actions }, equipIndex, loc);
}

// ---------------------------------------------------------------------------
// Classification + row state
// ---------------------------------------------------------------------------

export const CATEGORY_ORDER = ['climate', 'irrigation', 'alerts', 'manual', 'other'];
export const CATEGORY_LABELS = {
  climate: 'Climate',
  irrigation: 'Irrigation & fertigation',
  alerts: 'Alerts & logs',
  manual: 'Manual',
  other: 'Other',
};

const IRRIGATION_EQUIPMENT_IDS = new Set([1, 2]);

export function classifyAutomation(auto) {
  const { trigger, actions } = parseAutomation(auto);
  if (/^\s*climate/i.test(auto?.name || '')) return 'climate';
  const touchesIrrigation = actions.some(a => a && (a.type === 'control' || a.type === 'transition') && IRRIGATION_EQUIPMENT_IDS.has(parseInt(a.equipment_id, 10)));
  if (auto?.dose_program_id || touchesIrrigation) return 'irrigation';
  if (actions.length > 0 && actions.every(a => a && (a.type === 'alert' || a.type === 'log'))) return 'alerts';
  if ((trigger?.type || 'manual') === 'manual') return 'manual';
  return 'other';
}

export const TRIGGER_ORDER = ['threshold', 'schedule', 'manual', 'event'];

/** Names of targeted equipment that is disabled or not online. */
export function offlineTargets(auto, equipIndex) {
  const { actions } = parseAutomation(auto);
  const names = new Set();
  for (const a of actions) {
    if (!a || (a.type !== 'control' && a.type !== 'transition')) continue;
    const e = equipIndex?.get(parseInt(a.equipment_id, 10));
    if (!e) continue;
    if (!e.enabled || e.status !== 'online') names.add(e.name);
  }
  return [...names];
}

export function findDuplicateNames(automations) {
  const counts = new Map();
  for (const a of automations || []) {
    const k = String(a?.name || '').trim().toLowerCase();
    if (!k) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const dupes = new Set();
  for (const [k, n] of counts) if (n > 1) dupes.add(k);
  return dupes;
}

export function relativeTime(ts, now = Date.now(), loc) {
  const { t } = L(loc);
  const ms = toEpochMs(ts);
  if (ms === null) return t('summary.ago.never');
  const diff = Math.max(0, now - ms);
  const s = Math.round(diff / 1000);
  if (s < 45) return t('summary.ago.justNow');
  const m = Math.round(s / 60);
  if (m < 60) return t('summary.ago.minutes', { n: m });
  const h = Math.round(m / 60);
  if (h < 48) return t('summary.ago.hours', { n: h });
  const d = Math.round(h / 24);
  if (d < 60) return t('summary.ago.days', { count: d });
  const mo = Math.round(d / 30);
  return t('summary.ago.months', { count: mo });
}

// ---------------------------------------------------------------------------
// Hysteresis pairing — mirrors backend/src/services/AutomationGuards.js
// (actionChannelMap / toThresholdRule / opposingChannels / checkPair).
// Read-only: used to show "Pairs with #89 ..." under a threshold rule.
// ---------------------------------------------------------------------------

export function actionChannelMap(actions, getEquipment) {
  const map = new Map();
  if (!Array.isArray(actions)) return map;
  for (const a of actions) {
    if (!a || typeof a !== 'object') continue;
    const eqId = parseInt(a.equipment_id, 10);
    if (!Number.isFinite(eqId)) continue;
    if (a.type === 'transition' && Array.isArray(a.transitions)) {
      for (const t of a.transitions) {
        const ch = parseInt(t.channel, 10);
        if (!Number.isFinite(ch)) continue;
        map.set(`${eqId}:${ch}`, t.state ? 'on' : 'off');
      }
    } else if (a.type === 'control' && (a.action === 'on' || a.action === 'off')) {
      if (a.channel === null || a.channel === undefined || a.channel === '') {
        let expanded = false;
        if (typeof getEquipment === 'function') {
          const row = getEquipment(eqId);
          const mappings = row ? parseRegisterMappings(row) : null;
          if (Array.isArray(mappings)) {
            for (const m of mappings) {
              if (!m || m.type !== 'coil' || m.access !== 'readwrite') continue;
              const ch = parseInt(m.register ?? m.address, 10);
              if (Number.isFinite(ch)) { map.set(`${eqId}:${ch}`, a.action); expanded = true; }
            }
          }
        }
        if (!expanded) map.set(`${eqId}:*`, a.action);
      } else {
        const ch = parseInt(a.channel, 10);
        if (Number.isFinite(ch)) map.set(`${eqId}:${ch}`, a.action);
      }
    }
  }
  return map;
}

export function toThresholdRule(row, getEquipment) {
  if (!row) return null;
  const trigger = parseJson(row.trigger_config, {}) || {};
  if (trigger.type !== 'threshold') return null;
  const threshold = Number(trigger.threshold_value);
  if (!Number.isFinite(threshold)) return null;
  const eqId = parseInt(trigger.equipment_id, 10);
  const metric = String(trigger.sensor_type || '').trim().toLowerCase();
  if (!metric) return null;
  return {
    id: row.id ?? null,
    name: row.name || `automation ${row.id}`,
    enabled: row.enabled === undefined ? true : !!row.enabled,
    metricKey: `${Number.isFinite(eqId) ? eqId : '?'}:${metric}`,
    operator: String(trigger.operator || 'gt').toLowerCase(),
    threshold,
    unit: trigger.unit || '',
    channels: actionChannelMap(parseJson(row.actions, []), getEquipment),
  };
}

const isUp = (op) => op === 'gt' || op === 'gte';
const isDown = (op) => op === 'lt' || op === 'lte';

export function opposingChannels(a, b) {
  const out = [];
  for (const [key, aAction] of a.channels) {
    const [eq, ch] = key.split(':');
    let bAction = b.channels.get(key);
    if (bAction === undefined) bAction = b.channels.get(`${eq}:*`);
    if (bAction === undefined && ch === '*') {
      for (const [bk, bv] of b.channels) if (bk.startsWith(`${eq}:`)) { bAction = bv; break; }
    }
    if (bAction !== undefined && bAction !== aAction) out.push({ key, aAction, bAction });
  }
  return out;
}

/** true when the ON/OFF pair's thresholds are crossed (backend would 400). */
function pairCrossed(onRule, offRule) {
  if (isUp(onRule.operator) && isDown(offRule.operator)) return !(onRule.threshold > offRule.threshold);
  if (isDown(onRule.operator) && isUp(offRule.operator)) return !(onRule.threshold < offRule.threshold);
  return false;
}

/**
 * Find the opposite rules paired with `candidate` on the same metric and
 * channels. Mirrors validateHysteresis' candidate/other selection.
 * @returns {Array<{ partner: object, role: 'on'|'off', crossed: boolean, channels: string[] }>}
 */
export function findHysteresisPartners(candidate, others, getEquipment) {
  const rule = toThresholdRule(candidate, getEquipment);
  if (!rule || rule.channels.size === 0) return [];
  const out = [];
  for (const row of others || []) {
    if (!row || (candidate.id != null && Number(row.id) === Number(candidate.id))) continue;
    if (!(row.enabled === 1 || row.enabled === true)) continue;
    const other = toThresholdRule(row, getEquipment);
    if (!other || other.metricKey !== rule.metricKey) continue;
    const opposing = opposingChannels(rule, other);
    if (!opposing.length) continue;
    const ruleOn = opposing.filter(c => c.aAction === 'on');
    const ruleOff = opposing.filter(c => c.aAction === 'off');
    if (ruleOn.length) out.push({ partner: other, role: 'off', crossed: pairCrossed(rule, other), channels: ruleOn.map(c => c.key) });
    if (ruleOff.length) out.push({ partner: other, role: 'on', crossed: pairCrossed(other, rule), channels: ruleOff.map(c => c.key) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Schedule preview (client-side, browser local time)
// ---------------------------------------------------------------------------

function parseCronField(field, min, max) {
  const set = new Set();
  if (field === undefined || field === null) return null;
  for (const part of String(field).trim().split(',')) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part.trim());
    if (!m) return null;
    let lo = m[1] === '*' ? min : parseInt(m[1], 10);
    let hi = m[1] === '*' ? max : (m[2] !== undefined ? parseInt(m[2], 10) : lo);
    const step = m[3] !== undefined ? parseInt(m[3], 10) : 1;
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(step) || step <= 0) return null;
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return set.size ? set : null;
}

export function parseCron(expr) {
  const fields = String(expr || '').trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = parseCronField(fields[0], 0, 59);
  const hour = parseCronField(fields[1], 0, 23);
  const dom = parseCronField(fields[2], 1, 31);
  const month = parseCronField(fields[3], 1, 12);
  const dow = parseCronField(fields[4].replace(/\b7\b/, '0'), 0, 6);
  if (!minute || !hour || !dom || !month || !dow) return null;
  return { minute, hour, dom, month, dow, domStar: fields[2] === '*', dowStar: fields[4] === '*' };
}

function nextCronRun(cron, now) {
  const start = new Date(now.getTime());
  start.setSeconds(0, 0);
  const hours = [...cron.hour].sort((a, b) => a - b);
  const minutes = [...cron.minute].sort((a, b) => a - b);
  for (let dayOffset = 0; dayOffset < 400; dayOffset++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + dayOffset);
    if (!cron.month.has(day.getMonth() + 1)) continue;
    const domOk = cron.dom.has(day.getDate());
    const dowOk = cron.dow.has(day.getDay());
    // Standard cron: if both dom and dow are restricted, either may match.
    const dayOk = cron.domStar && cron.dowStar ? true : cron.domStar ? dowOk : cron.dowStar ? domOk : (domOk || dowOk);
    if (!dayOk) continue;
    for (const h of hours) {
      for (const m of minutes) {
        const cand = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
        if (cand.getTime() > now.getTime()) return cand;
      }
    }
  }
  return null;
}

/** Next fire time for a schedule trigger, or null when it cannot be computed. */
export function nextScheduleRun(trigger, now = new Date()) {
  if (!trigger || trigger.type !== 'schedule') return null;
  const type = trigger.schedule_type || 'daily';
  const [hh, mm] = String(trigger.time || '08:00').split(':').map(n => parseInt(n, 10));
  if (type === 'once') {
    if (!trigger.run_at) return null;
    const d = new Date(trigger.run_at);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (type === 'daily') {
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }
  if (type === 'weekly') {
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    const dow = parseInt(trigger.day_of_week ?? 1, 10);
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
    let delta = (dow - d.getDay() + 7) % 7;
    if (delta === 0 && d <= now) delta = 7;
    d.setDate(d.getDate() + delta);
    return d;
  }
  if (type === 'hourly') {
    const minute = parseInt(trigger.minute ?? 0, 10) || 0;
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), minute, 0, 0);
    if (d <= now) d.setHours(d.getHours() + 1);
    return d;
  }
  if (type === 'custom') {
    const cron = parseCron(trigger.cron);
    return cron ? nextCronRun(cron, now) : null;
  }
  return null;
}

export function formatNextRun(date, now = new Date(), loc) {
  if (!date) return null;
  const lc = L(loc);
  const { t } = lc;
  const diffMs = date.getTime() - now.getTime();
  const mins = Math.round(diffMs / 60000);
  let rel;
  if (mins < 1) rel = t('summary.next.now');
  else if (mins < 60) rel = t('summary.next.inMinutes', { n: mins });
  else if (mins < 48 * 60) rel = t('summary.next.inHours', { n: Math.round(mins / 60) });
  else rel = t('summary.next.inDays', { count: Math.round(mins / 1440) });
  const sameDay = date.toDateString() === now.toDateString();
  const day = sameDay
    ? t('summary.next.today')
    : `${weekdayName(date.getDay(), { loc: lc })} ${date.getDate()} ${monthShort(date, lc)}`;
  return t('summary.next.at', { day, time: `${pad2(date.getHours())}:${pad2(date.getMinutes())}`, rel });
}

// ---------------------------------------------------------------------------
// Sequence timeline (builder preview; read-only, informational)
// ---------------------------------------------------------------------------

/** 0 -> "0:00", 270 -> "4:30", 3725 -> "1:02:05". */
export function formatClock(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  return h ? `${h}:${pad2(m)}:${pad2(rest)}` : `${m}:${pad2(rest)}`;
}

/** Tolerance before a gap or an overlap is worth flagging. */
export const SEQUENCE_TOLERANCE_S = 5;

/** Main-line irrigation pumps (not mixing / dosing pumps). */
export function isFeedPump(label) {
  const s = String(label || '');
  return /pump/i.test(s) && !/mix|dos|inject|stir|agitat|recirc/i.test(s);
}

/** Irrigation zones / field valves (not fertiliser injector valves). */
export function isZoneChannel(label) {
  const s = String(label || '');
  return /zone|valve/i.test(s) && !/inject|tank|dos|fert|drain/i.test(s);
}

const secondsOrNull = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Merge [start, end) intervals (end may be Infinity). */
function unionIntervals(list) {
  const sorted = list.filter(i => i.end > i.start).sort((a, b) => a.start - b.start);
  const out = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ start: i.start, end: i.end });
  }
  return out;
}

/** a minus b, both unions. */
function subtractIntervals(a, b) {
  const out = [];
  for (const seg of a) {
    let cursor = seg.start;
    for (const cut of b) {
      if (cut.end <= cursor || cut.start >= seg.end) continue;
      if (cut.start > cursor) out.push({ start: cursor, end: Math.min(cut.start, seg.end) });
      cursor = Math.max(cursor, cut.end);
      if (cursor >= seg.end) break;
    }
    if (cursor < seg.end) out.push({ start: cursor, end: seg.end });
  }
  return out;
}

/**
 * Lay the relay actions out on a time axis measured from the trigger.
 * Mirrors AutomationExecutor: delay_seconds offsets the start, duration_seconds
 * schedules the auto-OFF; no duration means the channel stays on until another
 * rule switches it off (open-ended, never 0).
 *
 * @returns {{ items: object[], show: boolean, total: number, openEnded: boolean,
 *   scaleEnd: number, gaps: object[], overlaps: object[], pumpCovered: boolean|null }}
 */
export function buildSequence(actions, equipIndex, loc) {
  const lc = L(loc);
  const items = [];
  const list = Array.isArray(actions) ? actions : [];
  list.forEach((a, index) => {
    if (!a || typeof a !== 'object') return;
    const eqId = parseInt(a.equipment_id, 10);
    if (!Number.isFinite(eqId)) return;
    const start = secondsOrNull(a.delay_seconds) || 0;
    const duration = secondsOrNull(a.duration_seconds);
    const eqName = equipmentLabel(equipIndex, eqId, lc) || a.equipment_name;
    const push = (channel, label, on, extra = {}) => {
      items.push({
        key: `${index}:${channel}`,
        index,
        eqId,
        eqName,
        channel,
        label,
        kind: on ? 'bar' : 'point',
        start,
        end: on ? (duration ? start + duration : null) : start,
        duration: on ? duration : null,
        role: isFeedPump(label) ? 'pump' : isZoneChannel(label) ? 'zone' : null,
        ...extra,
      });
    };
    if (a.type === 'control') {
      const on = (a.action || 'on') !== 'off';
      if (a.channel === null || a.channel === undefined || a.channel === '') {
        const n = writableCoils(equipIndex, eqId).length;
        push('*', n ? lc.t('summary.fallback.allChannelsCount', { n }) : lc.t('summary.fallback.allChannels'), on, {
          role: null,
          stagger: secondsOrNull(a.stagger_delay_seconds),
          action: a.action || 'on',
        });
      } else {
        const label = equipIndex?.get(eqId) ? channelLabel(equipIndex, eqId, a.channel, lc) : (a.channel_name || lc.t('summary.fallback.channel', { n: a.channel }));
        push(toReg(a.channel), label, on, { action: a.action || 'on' });
      }
    } else if (a.type === 'transition' && Array.isArray(a.transitions)) {
      for (const t of a.transitions) {
        const ch = toReg(t.channel);
        if (ch === null) continue;
        const label = equipIndex?.get(eqId) ? channelLabel(equipIndex, eqId, ch, lc) : (t.name || lc.t('summary.fallback.channel', { n: ch }));
        push(ch, label, !!t.state, { action: t.state ? 'on' : 'off', transition: true });
      }
    }
  });

  items.sort((x, y) => x.start - y.start || x.index - y.index);

  const bars = items.filter(i => i.kind === 'bar');
  const finiteEnds = bars.filter(b => b.end !== null).map(b => b.end);
  const total = Math.max(0, ...finiteEnds, ...items.map(i => i.start));
  const openEnded = bars.some(b => b.end === null);
  const durations = new Set(bars.map(b => (b.end === null ? 'open' : b.duration)));
  const anyDelay = items.some(i => i.start > 0 || i.stagger);
  const show = items.length >= 2 && total > 0 && (anyDelay || durations.size > 1);

  // Pump ON with no zone open (dead-heading), and zones on one board overlapping.
  const TOL = SEQUENCE_TOLERANCE_S;
  const span = (b) => ({ start: b.start, end: b.end === null ? Infinity : b.end });
  const pumps = bars.filter(b => b.role === 'pump');
  const zones = bars.filter(b => b.role === 'zone');
  let gaps = [];
  let pumpCovered = null;
  if (pumps.length && zones.length) {
    const raw = subtractIntervals(unionIntervals(pumps.map(span)), unionIntervals(zones.map(span)));
    gaps = raw.filter(g => g.end - g.start > TOL).map(g => ({
      start: g.start,
      end: g.end === Infinity ? null : g.end,
      pumps: pumps.filter(p => p.start < g.end && span(p).end > g.start).map(p => p.key),
    }));
    pumpCovered = gaps.length === 0;
  }
  const overlaps = [];
  for (let i = 0; i < zones.length; i++) {
    for (let j = i + 1; j < zones.length; j++) {
      const a = zones[i];
      const b = zones[j];
      if (a.eqId !== b.eqId || a.channel === b.channel) continue;
      const start = Math.max(a.start, b.start);
      const end = Math.min(span(a).end, span(b).end);
      if (end - start > TOL) overlaps.push({ a: a.key, b: b.key, aLabel: a.label, bLabel: b.label, start, end: end === Infinity ? null : end });
    }
  }

  // Headroom so an open-ended bar still reads as running past the last event.
  const scaleEnd = Math.max(openEnded ? total * 1.1 : total, 1);
  return { items, rows: groupSequenceRows(items), show, total, openEnded, scaleEnd, gaps, overlaps, pumpCovered };
}

/**
 * One timeline row per relay channel: several windows of the same channel
 * (soft-switch runs switch the pumps on once per zone) share a row as separate
 * segments instead of one row per action. "All channels" actions keep their
 * own row. Rows are ordered by their first start.
 */
export function groupSequenceRows(items) {
  const rows = new Map();
  for (const item of items || []) {
    const key = item.channel === '*' ? `all:${item.key}` : `${item.eqId}:${item.channel}`;
    let row = rows.get(key);
    if (!row) {
      row = { key, eqId: item.eqId, eqName: item.eqName, label: item.label, role: item.role, stagger: item.stagger || null, segments: [] };
      rows.set(key, row);
    }
    row.segments.push(item);
  }
  const out = [...rows.values()];
  for (const r of out) {
    r.segments.sort((a, b) => a.start - b.start || a.index - b.index);
    r.start = r.segments[0].start;
    r.end = r.segments.some(s => s.kind === 'bar' && s.end === null) ? null : Math.max(...r.segments.map(s => s.end));
  }
  return out.sort((a, b) => a.start - b.start || a.segments[0].index - b.segments[0].index);
}
