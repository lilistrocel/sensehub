/**
 * Split an agronomist report's markdown into tab-sized sections.
 *
 * Current reports use fixed `## ` headings (State of the Crop, Irrigation &
 * Fertigation, Nutrient Status, Risks & Anomalies, Recommendations), but old
 * reports vary, so nothing here may drop text:
 *   - text before the first heading is returned as `intro` (shown on Overview);
 *   - a known heading gets a short stable key + label (crop, irrigation, ...);
 *   - an unknown heading becomes its own section with a shortened label;
 *   - a report with no headings returns everything as `intro`.
 * Headings inside ``` fences are ignored. When the markdown has no `## `
 * headings at all, top-level `# ` headings are used instead.
 */

const KNOWN = [
  { key: 'crop', label: 'Crop', re: /\bcrop|plant|canopy/i },
  { key: 'irrigation', label: 'Irrigation', re: /irrigat|fertigat/i },
  { key: 'nutrients', label: 'Nutrients', re: /nutrient|\bamic\b|\blab\b/i },
  { key: 'climate', label: 'Climate', re: /climate|environment|weather/i },
  { key: 'risks', label: 'Risks', re: /risk|anomal|concern/i },
  { key: 'recommendations', label: 'Actions', re: /recommend|\bnext steps?\b|\bactions?\b/i },
];

// Tab ids the report view owns; a section key must never collide with them.
const RESERVED = new Set(['overview', 'actions', 'discussion']);

const FENCE_RE = /^\s*(```|~~~)/;

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'section';
}

/** "Water Quality: feed vs drain (AMIC)" -> "Water Quality" */
export function shortLabel(title) {
  let t = String(title || '').replace(/\(.*?\)/g, '').replace(/[*_`#]/g, '').trim();
  t = t.split(/\s+(?:&|and|-|–|—)\s+|:/)[0].trim() || t;
  if (t.length > 16) t = t.split(/\s+/).slice(0, 2).join(' ');
  if (t.length > 18) t = `${t.slice(0, 16)}…`;
  return t || 'Section';
}

function classify(title) {
  const hit = KNOWN.find(k => k.re.test(title));
  if (hit) return { key: hit.key, label: hit.label };
  return { key: `sec-${slug(title)}`, label: shortLabel(title) };
}

function headingLines(lines, level) {
  const re = level === 2 ? /^##\s+(.+?)\s*#*\s*$/ : /^#\s+(.+?)\s*#*\s*$/;
  const out = [];
  let inFence = false;
  lines.forEach((line, i) => {
    if (FENCE_RE.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    const m = re.exec(line);
    if (m) out.push({ index: i, title: m[1] });
  });
  return out;
}

/**
 * @returns {{ intro: string, sections: Array<{ key, label, title, body }> }}
 */
export function splitReportSections(markdown) {
  const md = String(markdown || '').replace(/\r\n?/g, '\n');
  if (!md.trim()) return { intro: '', sections: [] };
  const lines = md.split('\n');

  let level = 2;
  let heads = headingLines(lines, 2);
  if (heads.length === 0) { level = 1; heads = headingLines(lines, 1); }
  if (heads.length === 0) return { intro: md.trim(), sections: [] };

  let introLines = lines.slice(0, heads[0].index);
  // A lone document title ("# Daily report 2026-09-24") above `## ` sections
  // repeats the header; drop it so Overview does not open with it.
  if (level === 2) {
    const nonBlank = introLines.filter(l => l.trim());
    if (nonBlank.length === 1 && /^#\s+/.test(nonBlank[0])) introLines = [];
  }

  const sections = [];
  const byKey = new Map();
  heads.forEach((h, n) => {
    const end = n + 1 < heads.length ? heads[n + 1].index : lines.length;
    const body = lines.slice(h.index + 1, end).join('\n').trim();
    let { key, label } = classify(h.title);
    if (RESERVED.has(key)) key = `sec-${key}`;
    // Two "Recommendations" headings fold into one; any other repeat gets a suffix.
    if (byKey.has(key)) {
      if (key === 'recommendations') {
        const prev = byKey.get(key);
        prev.body = [prev.body, body].filter(Boolean).join('\n\n');
        return;
      }
      let i = 2;
      while (byKey.has(`${key}-${i}`)) i += 1;
      key = `${key}-${i}`;
      label = `${label} ${i}`;
    }
    const section = { key, label, title: h.title.replace(/[*_`]/g, ''), body };
    byKey.set(key, section);
    sections.push(section);
  });

  return { intro: introLines.join('\n').trim(), sections };
}

export default splitReportSections;
