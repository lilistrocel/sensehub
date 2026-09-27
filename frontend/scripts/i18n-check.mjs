#!/usr/bin/env node
/**
 * i18n check for SenseHub (npm run i18n:check). See docs/i18n-guide.md.
 *
 *  1. Locale files: keys missing in tr/ar (plural-aware: every CLDR category
 *     the language needs - Arabic zero/one/two/few/many/other, Turkish
 *     one/other), untranslated (empty) values, stale extra keys, and
 *     {{interpolation}} / <tag> mismatches against English.
 *  2. Code -> English: t('ns:key') / i18nKey="…" calls whose key does not exist
 *     in src/locales/en (dynamic `${…}` keys are checked by prefix).
 *  3. Hard-coded user-visible strings in JSX (heuristic): JSX text, the
 *     title / placeholder / aria-label / alt / label attributes, string
 *     literals rendered as JSX children, and literals passed to toast helpers.
 *     Units and technical abbreviations are ignored. Also counts physical
 *     direction classes (ml-, pr-, left-, text-right, border-l …) that need a
 *     logical equivalent for RTL.
 *
 * Output: a coverage table per page / component folder (the Phase 2 work
 * list). Exit code 1 when (1) or (2) found a missing key; hard-coded strings
 * never fail the run (they are the backlog).
 *
 * Flags: --files (per-file table)  --file <path> (list the strings with line
 *        numbers)  --json  --no-fail  --top <n>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const LOCALES = path.join(SRC, 'locales');
const BASE = 'en';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

// ---------------------------------------------------------------------------
// 1. Locale files
// ---------------------------------------------------------------------------
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

function loadLocales() {
  const langs = fs.readdirSync(LOCALES).filter((d) => fs.statSync(path.join(LOCALES, d)).isDirectory());
  const data = {};
  for (const lng of langs) {
    data[lng] = {};
    for (const f of fs.readdirSync(path.join(LOCALES, lng)).filter((x) => x.endsWith('.json'))) {
      const ns = f.replace(/\.json$/, '');
      try {
        data[lng][ns] = flatten(JSON.parse(fs.readFileSync(path.join(LOCALES, lng, f), 'utf8')));
      } catch (e) {
        console.error(`✗ ${lng}/${f}: invalid JSON (${e.message})`);
        process.exitCode = 1;
        data[lng][ns] = {};
      }
    }
  }
  return data;
}

const vars = (s) => new Set(String(s ?? '').match(/\{\{\s*[\w.]+\s*\}\}|<\/?[\w]+\s*\/?>/g)?.map((x) => x.replace(/\s/g, '')) || []);
const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

function checkLocales(data) {
  const report = { missing: [], empty: [], extra: [], interpolation: [] };
  const en = data[BASE] || {};
  for (const lng of Object.keys(data).filter((l) => l !== BASE)) {
    const categories = new Intl.PluralRules(lng).resolvedOptions().pluralCategories;
    for (const ns of new Set([...Object.keys(en), ...Object.keys(data[lng])])) {
      const src = en[ns] || {};
      const dst = data[lng][ns] || {};
      if (!en[ns]) { report.extra.push(`${lng}/${ns}.json (no English file)`); continue; }
      const expected = new Map(); // key -> English reference value
      const pluralBases = new Map();
      for (const [k, v] of Object.entries(src)) {
        const m = k.match(PLURAL_SUFFIX);
        if (m) {
          const base = k.replace(PLURAL_SUFFIX, '');
          if (!pluralBases.has(base)) pluralBases.set(base, src[`${base}_other`] ?? v);
        } else expected.set(k, v);
      }
      for (const [base, ref] of pluralBases) {
        for (const c of categories) expected.set(`${base}_${c}`, ref);
      }
      for (const [k, ref] of expected) {
        if (!(k in dst)) report.missing.push(`${lng} ${ns}:${k}`);
        else if (dst[k] === '' || dst[k] === null) report.empty.push(`${lng} ${ns}:${k}`);
        else {
          const a = vars(ref); const b = vars(dst[k]);
          // plural forms may drop {{count}} (Arabic "one"/"two" often spell the number)
          if (PLURAL_SUFFIX.test(k)) { a.delete('{{count}}'); b.delete('{{count}}'); }
          if (!setEq(a, b)) report.interpolation.push(`${lng} ${ns}:${k}  en[${[...a].join(' ')}] ${lng}[${[...b].join(' ')}]`);
        }
      }
      for (const k of Object.keys(dst)) {
        if (!expected.has(k)) report.extra.push(`${lng} ${ns}:${k}`);
      }
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// 2 + 3. Source scan
// ---------------------------------------------------------------------------
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'locales') walk(p, out); } else if (/\.(jsx?|tsx?)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

const TEXT_ATTRS = new Set(['title', 'placeholder', 'aria-label', 'alt', 'label', 'aria-description', 'aria-valuetext', 'summary', 'emptyText', 'subtitle', 'confirmLabel', 'cancelLabel', 'body', 'hint', 'text']);
const TOAST_FNS = new Set(['showSuccess', 'showError', 'showWarning', 'showInfo', 'notifyError', 'setError', 'setSuccess', 'alert', 'confirm']);

// Never translated (docs/i18n-guide.md "What is never translated").
const UNITS = [
  'mS/cm', 'µS/cm', 'uS/cm', 'L/h', 'L/min', 'm³/h', 'm3/h', 'm³', 'm3', '°C', '°F', 'kPa', 'kWh', 'kW', 'VPD', 'EC', 'pH', 'RH', 'PPFD',
  'DLI', 'CO2', 'CO₂', 'ppm', 'lux', 'Hz', 'V', 'A', 'W', 'ms', 'min', 'h', 's', 'd', 'L', 'mL', 'ml', 'kg', 'g', 'mm', 'cm', 'm',
  'ON', 'OFF', 'ID', 'ch', 'Modbus', 'RTU', 'TCP', 'MQTT', 'SEKO', 'AMIC', 'SenseHub', 'A20Core', 'Priva', 'FC03', 'FC04', 'N', 'P', 'K',
  'NO3', 'NH4', 'Ca', 'Mg', 'Fe', 'x', 'vs', 'OK', 'UTC', 'GMT', 'HTTP', 'API', 'JSON', 'CSV', 'PDF', 'URL', 'IP', 'SSID', 'DB',
];
const UNIT_RE = new RegExp(`(^|[^A-Za-z])(${[...UNITS].sort((x, y) => y.length - x.length).map((u) => u.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})(?=$|[^A-Za-z])`, 'g');

function isUserText(raw) {
  const s = String(raw).replace(/\s+/g, ' ').trim();
  if (!s) return false;
  if (/^(https?:|\/api\/|\/|#|\.\/|mailto:)/.test(s)) return false;              // paths/urls
  if (/^[\w.-]+@[\w.-]+$/.test(s)) return false;                                 // emails / placeholders like admin@x
  if (/^[a-z]+([A-Z][a-z0-9]*)+$/.test(s) || /^[a-z0-9]+([_-][a-z0-9]+)+$/.test(s)) return false; // identifiers
  const rest = s.replace(UNIT_RE, '$1').replace(/[^A-Za-zÀ-ɏ]/g, '');
  return rest.length >= 2;
}

const PHYSICAL = /^-?(?:(?:ml|mr|pl|pr|left|right|border-l|border-r|rounded-l|rounded-r|rounded-tl|rounded-tr|rounded-bl|rounded-br|scroll-ml|scroll-mr|space-x|divide-x)(?:-.+)?|text-left|text-right)$/;

/** Physical-direction classes in a class string. rtl:/ltr: variants are
 *  deliberate; space-x/divide-x are fine when paired with rtl:*-reverse. */
function countPhysical(classes) {
  const tokens = String(classes).split(/\s+/).filter(Boolean);
  const hasReverse = (k) => tokens.some((x) => x.includes('rtl:') && x.includes(`${k}-reverse`));
  return tokens.filter((tok) => {
    if (/(^|:)(rtl|ltr):/.test(tok)) return false;
    const base = tok.slice(tok.lastIndexOf(':') + 1).replace(/^!/, '');
    if (!PHYSICAL.test(base)) return false;
    if (/^(space-x|divide-x)/.test(base) && !base.endsWith('-reverse')) return !hasReverse(base.startsWith('space') ? 'space-x' : 'divide-x');
    return !base.endsWith('-reverse');
  }).length;
}

function scanFile(file) {
  const code = fs.readFileSync(file, 'utf8');
  const rel = path.relative(SRC, file);
  const result = { file: rel, hardcoded: [], keys: [], tCalls: 0, physical: 0 };
  let ast;
  try {
    ast = parse(code, { sourceType: 'module', plugins: ['jsx'], errorRecovery: true });
  } catch (e) {
    result.error = e.message;
    return result;
  }

  // default namespace(s) from useTranslation('ns') / useTranslation(['a','b'])
  const nsMatch = [...code.matchAll(/useTranslation\(\s*(\[[^\]]*\]|'[^']*'|"[^"]*")?/g)];
  const defaultNs = new Set();
  for (const m of nsMatch) {
    if (!m[1]) { defaultNs.add('common'); continue; }
    const first = (m[1].match(/['"]([\w-]+)['"]/) || [])[1];
    if (first) defaultNs.add(first);
  }
  const usesI18n = nsMatch.length > 0 || /i18nKey=|i18n\.t\(/.test(code);

  const add = (node, text, kind) => {
    if (isUserText(text)) result.hardcoded.push({ line: node.loc?.start.line, kind, text: String(text).replace(/\s+/g, ' ').trim().slice(0, 90) });
  };
  const literalText = (n) => {
    if (!n) return null;
    if (n.type === 'StringLiteral') return n.value;
    if (n.type === 'TemplateLiteral') return n.quasis.map((q) => q.value.cooked).join('…');
    return null;
  };
  // String literals that end up rendered (ternary / logical branches, parenthesised).
  const renderedLiterals = (n, kind) => {
    if (!n) return;
    const txt = literalText(n);
    if (txt !== null) { add(n, txt, kind); return; }
    if (n.type === 'ConditionalExpression') { renderedLiterals(n.consequent, kind); renderedLiterals(n.alternate, kind); }
    if (n.type === 'LogicalExpression') renderedLiterals(n.right, kind);
  };
  const keyFrom = (n) => {
    const out = [];
    const txt = n && (n.type === 'StringLiteral' ? n.value : n.type === 'TemplateLiteral' ? n.quasis.map((q, i) => q.value.cooked + (i < n.quasis.length - 1 ? '${}' : '')).join('') : null);
    if (txt !== null && txt !== undefined) out.push(txt);
    if (n && n.type === 'ConditionalExpression') out.push(...keyFrom(n.consequent), ...keyFrom(n.alternate));
    return out;
  };

  const visit = (node, parent) => {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'JSXText':
        add(node, node.value, 'text');
        break;
      case 'JSXAttribute': {
        const name = node.name?.name;
        if (name === 'className' || name === 'class') {
          const v = node.value;
          const txt = v?.type === 'StringLiteral' ? v.value
            : v?.type === 'JSXExpressionContainer' ? (v.expression.type === 'TemplateLiteral' ? v.expression.quasis.map((q) => q.value.cooked).join(' ') : literalText(v.expression)) : null;
          if (txt) result.physical += countPhysical(txt);
        } else if (name === 'i18nKey' && node.value?.type === 'StringLiteral') {
          result.keys.push({ key: node.value.value, line: node.loc?.start.line });
        } else if (TEXT_ATTRS.has(name)) {
          const v = node.value;
          if (v?.type === 'StringLiteral') add(v, v.value, `@${name}`);
          else if (v?.type === 'JSXExpressionContainer') renderedLiterals(v.expression, `@${name}`);
        }
        break;
      }
      case 'JSXExpressionContainer':
        if (parent && (parent.type === 'JSXElement' || parent.type === 'JSXFragment')) renderedLiterals(node.expression, 'expr');
        break;
      case 'CallExpression': {
        const callee = node.callee;
        const fname = callee.type === 'Identifier' ? callee.name : callee.type === 'MemberExpression' ? callee.property?.name : null;
        const obj = callee.type === 'MemberExpression' ? callee.object?.name : null;
        if ((fname === 't' || fname === 'tc') && callee.type === 'Identifier') {
          result.tCalls += 1;
          for (const k of keyFrom(node.arguments[0])) result.keys.push({ key: k, line: node.loc?.start.line });
        } else if (fname === 't' && obj === 'i18n') {
          result.tCalls += 1;
          for (const k of keyFrom(node.arguments[0])) result.keys.push({ key: k, line: node.loc?.start.line, explicit: true });
        } else if (TOAST_FNS.has(fname) && obj !== 'console') {
          node.arguments.slice(0, 2).forEach((a) => renderedLiterals(a, `${fname}()`));
        } else if (fname === 'addToast' && node.arguments[0]?.type === 'ObjectExpression') {
          node.arguments[0].properties.forEach((p) => {
            if (['title', 'message'].includes(p.key?.name)) renderedLiterals(p.value, 'addToast()');
          });
        }
        break;
      }
      default:
        break;
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra' || k === 'leadingComments' || k === 'trailingComments') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach((c) => visit(c, node));
      else if (v && typeof v === 'object' && typeof v.type === 'string') visit(v, node);
    }
  };
  visit(ast.program, null);
  // A file whose physical classes are deliberate (a dir="ltr" chart/table) says so once:
  //   /* i18n-check: physical-ok */
  if (/i18n-check:\s*physical-ok/.test(code)) result.physical = 0;
  result.usesI18n = usesI18n;
  result.defaultNs = [...defaultNs];
  return result;
}

function checkCodeKeys(scans, locales) {
  const en = locales[BASE] || {};
  const nsList = Object.keys(en);
  const exists = (ns, key) => {
    const table = en[ns];
    if (!table) return false;
    if (key.includes('${}')) {
      const prefix = key.slice(0, key.indexOf('${}'));
      return Object.keys(table).some((k) => k.startsWith(prefix));
    }
    return key in table || Object.keys(table).some((k) => k.replace(PLURAL_SUFFIX, '') === key || k.startsWith(`${key}.`));
  };
  const missing = [];
  for (const s of scans) {
    for (const { key, line } of s.keys) {
      if (!key || /\s/.test(key) || !/^[\w$.{}:-]+$/.test(key)) continue; // not a key (a sentence passed to some other t())
      let ns; let k = key;
      const m = key.match(/^([\w-]+):(.+)$/);
      if (m && nsList.includes(m[1])) { ns = m[1]; k = m[2]; }
      const candidates = ns ? [ns] : (s.defaultNs.length ? s.defaultNs : ['common']);
      if (!candidates.some((n) => exists(n, k))) missing.push(`${s.file}:${line}  ${ns ? '' : `[${candidates.join('|')}] `}${key}`);
    }
  }
  return missing;
}

function groupOf(rel) {
  const parts = rel.split(path.sep);
  if (parts[0] === 'pages') return parts.length > 2 ? `pages/${parts[1]}` : `pages/${parts[1].replace(/\.\w+$/, '')}`;
  if (parts[0] === 'components' && parts.length > 2) return `components/${parts[1]}`;
  if (parts[0] === 'components') return `components/${parts[1].replace(/\.\w+$/, '')}`;
  return parts.length > 1 ? parts[0] : parts[0].replace(/\.\w+$/, '');
}

function pad(s, n, right = false) { s = String(s); return right ? s.padStart(n) : s.padEnd(n); }

function table(rows, cols) {
  const widths = cols.map((c) => Math.max(c.title.length, ...rows.map((r) => String(r[c.key]).length)));
  const line = (r) => cols.map((c, i) => pad(r[c.key], widths[i], c.right)).join('  ');
  const head = cols.map((c, i) => pad(c.title, widths[i], c.right)).join('  ');
  return [head, widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

// ---------------------------------------------------------------------------
const locales = loadLocales();
const loc = checkLocales(locales);
const files = walk(SRC);
const scans = files.map(scanFile);
const missingCode = checkCodeKeys(scans, locales);

const one = opt('--file');
if (one) {
  const s = scans.find((x) => x.file === one || path.join(SRC, x.file) === path.resolve(one) || x.file.endsWith(one));
  if (!s) { console.error(`no such file under src/: ${one}`); process.exit(2); }
  console.log(`${s.file}: ${s.hardcoded.length} hard-coded, ${s.tCalls} t() calls, ${s.physical} physical-direction classes`);
  s.hardcoded.forEach((h) => console.log(`  ${pad(h.line, 5, true)}  ${pad(h.kind, 14)} ${h.text}`));
  process.exit(0);
}

const groups = new Map();
for (const s of scans) {
  const g = groupOf(s.file);
  const e = groups.get(g) || { area: g, files: 0, hardcoded: 0, translated: 0, physical: 0 };
  e.files += 1; e.hardcoded += s.hardcoded.length; e.translated += s.tCalls; e.physical += s.physical;
  groups.set(g, e);
}
const cov = (e) => (e.hardcoded + e.translated === 0 ? '-' : `${Math.round((100 * e.translated) / (e.hardcoded + e.translated))}%`);
const groupRows = [...groups.values()].map((e) => ({ ...e, coverage: cov(e) }))
  .sort((a, b) => b.hardcoded - a.hardcoded || a.area.localeCompare(b.area));
const totals = groupRows.reduce((t, e) => ({ hardcoded: t.hardcoded + e.hardcoded, translated: t.translated + e.translated, physical: t.physical + e.physical }), { hardcoded: 0, translated: 0, physical: 0 });

if (flag('--json')) {
  console.log(JSON.stringify({ locales: loc, missingCodeKeys: missingCode, groups: groupRows, totals, files: scans.map(({ file, hardcoded, tCalls, physical }) => ({ file, hardcoded: hardcoded.length, tCalls, physical })) }, null, 2));
} else {
  const langs = Object.keys(locales);
  const nsCount = Object.keys(locales[BASE] || {}).length;
  const keyCount = Object.values(locales[BASE] || {}).reduce((n, t) => n + Object.keys(t).length, 0);
  console.log(`\nSenseHub i18n check — languages: ${langs.join(', ')} · ${nsCount} namespaces · ${keyCount} English keys\n`);
  const section = (title, list, max = 40) => {
    console.log(`${list.length ? '✗' : '✓'} ${title}: ${list.length}`);
    list.slice(0, max).forEach((x) => console.log(`    ${x}`));
    if (list.length > max) console.log(`    … ${list.length - max} more`);
  };
  section('missing translations (tr/ar, plural-aware)', loc.missing);
  section('empty translations (fall back to English)', loc.empty);
  section('interpolation / tag mismatches', loc.interpolation);
  section('keys used in code but missing in en', missingCode);
  if (loc.extra.length) section('extra keys not in en (stale?)', loc.extra, 20);

  const top = Number(opt('--top')) || groupRows.length;
  console.log('\nHard-coded user-visible strings per area (Phase 2 work list)\n');
  console.log(table(groupRows.slice(0, top), [
    { key: 'area', title: 'area' },
    { key: 'files', title: 'files', right: true },
    { key: 'hardcoded', title: 'hard-coded', right: true },
    { key: 'translated', title: 't() calls', right: true },
    { key: 'coverage', title: 'coverage', right: true },
    { key: 'physical', title: 'rtl-fix', right: true },
  ]));
  console.log(`\nTOTAL: ${totals.hardcoded} hard-coded strings, ${totals.translated} t() calls, ${cov(totals)} coverage, ${totals.physical} physical-direction classes to convert (ml-/pr-/left-/text-right/border-l …)`);
  if (flag('--files')) {
    const fileRows = scans.map((s) => ({ file: s.file, hardcoded: s.hardcoded.length, translated: s.tCalls, physical: s.physical, coverage: cov({ hardcoded: s.hardcoded.length, translated: s.tCalls }) }))
      .filter((r) => r.hardcoded || r.translated || r.physical)
      .sort((a, b) => b.hardcoded - a.hardcoded);
    console.log('\nPer file\n');
    console.log(table(fileRows, [
      { key: 'file', title: 'file' },
      { key: 'hardcoded', title: 'hard-coded', right: true },
      { key: 'translated', title: 't() calls', right: true },
      { key: 'coverage', title: 'coverage', right: true },
      { key: 'physical', title: 'rtl-fix', right: true },
    ]));
  }
  console.log('\nDetails for one file: npm run i18n:check -- --file pages/Alerts.jsx\n');
}

if ((loc.missing.length || missingCode.length || loc.interpolation.length) && !flag('--no-fail')) process.exitCode = 1;
