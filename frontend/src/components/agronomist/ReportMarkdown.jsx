import React, { useMemo } from 'react';

/**
 * Small markdown renderer for agronomist reports, built as React elements
 * (never an HTML string), so model output cannot inject markup: raw HTML in
 * the text shows as text. Covers what the reports use: headings, paragraphs,
 * bold / italic / strike / inline code, links (http/https only), bullet and
 * numbered lists with nesting, GFM pipe tables, fenced code, blockquotes and
 * rules. Chosen over react-markdown + remark-gfm to keep the bundle small
 * (this file is a few kB vs ~40 kB gzip) for content with a fixed shape.
 */

const LIST_RE = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const FENCE_RE = /^\s*(```|~~~)/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;

const indentOf = (s) => s.replace(/\t/g, '    ').length;

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i += 1; continue; }
    if (s[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

const isTableStart = (lines, i) =>
  lines[i].includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && TABLE_SEP_RE.test(lines[i + 1]);

function startsBlock(lines, i) {
  const l = lines[i];
  return FENCE_RE.test(l) || HEADING_RE.test(l) || HR_RE.test(l) || LIST_RE.test(l) || QUOTE_RE.test(l) || isTableStart(lines, i);
}

/** Build a nested list tree from the raw lines of one list block. */
function parseList(lines) {
  const first = LIST_RE.exec(lines[0]);
  const mkList = (m) => ({ ordered: /\d/.test(m[2]), start: parseInt(m[2], 10) || 1, items: [] });
  const root = mkList(first);
  const stack = [{ indent: indentOf(first[1]), list: root }];
  for (const line of lines) {
    const m = LIST_RE.exec(line);
    if (m) {
      const indent = indentOf(m[1]);
      while (stack.length > 1 && indent < stack[stack.length - 1].indent) stack.pop();
      const top = stack[stack.length - 1];
      const last = top.list.items[top.list.items.length - 1];
      if (indent >= top.indent + 2 && last) {
        const nested = mkList(m);
        last.children.push(nested);
        stack.push({ indent, list: nested });
      }
      stack[stack.length - 1].list.items.push({ text: m[3], children: [] });
    } else if (line.trim()) {
      // Continuation line: belongs to the deepest open item.
      const top = stack[stack.length - 1];
      const last = top.list.items[top.list.items.length - 1];
      if (last) last.text += `\n${line.trim()}`;
    }
  }
  return root;
}

/** Parse markdown into a flat array of block nodes. */
export function parseBlocks(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }

    if (FENCE_RE.test(line)) {
      const fence = FENCE_RE.exec(line)[1];
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) { body.push(lines[i]); i += 1; }
      i += 1; // closing fence (or EOF)
      blocks.push({ type: 'code', text: body.join('\n') });
      continue;
    }

    const h = HEADING_RE.exec(line);
    if (h) { blocks.push({ type: 'heading', level: h[1].length, text: h[2] }); i += 1; continue; }

    if (HR_RE.test(line)) { blocks.push({ type: 'hr' }); i += 1; continue; }

    if (isTableStart(lines, i)) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]).map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : null));
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) { rows.push(splitRow(lines[i])); i += 1; }
      blocks.push({ type: 'table', header, align, rows });
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) { body.push(QUOTE_RE.exec(lines[i])[1]); i += 1; }
      blocks.push({ type: 'quote', blocks: parseBlocks(body.join('\n')) });
      continue;
    }

    if (LIST_RE.test(line)) {
      const body = [];
      while (i < lines.length) {
        const l = lines[i];
        if (LIST_RE.test(l) || (l.trim() && indentOf(l.match(/^\s*/)[0]) >= 2)) { body.push(l); i += 1; continue; }
        if (l.trim() && body.length && !startsBlock(lines, i)) { body.push(l); i += 1; continue; } // lazy continuation
        if (!l.trim()) {
          // A blank line keeps the list open only if the list carries on after it.
          let j = i + 1;
          while (j < lines.length && !lines[j].trim()) j += 1;
          if (j < lines.length && (LIST_RE.test(lines[j]) || indentOf(lines[j].match(/^\s*/)[0]) >= 2)) { i = j; continue; }
        }
        break;
      }
      blocks.push({ type: 'list', list: parseList(body) });
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && (para.length === 0 || !startsBlock(lines, i))) { para.push(lines[i].trim()); i += 1; }
    blocks.push({ type: 'para', text: para.join('\n') });
  }
  return blocks;
}

// Inline: `code`, **bold**, __bold__, ~~strike~~, [text](http...), *italic*.
// Single-underscore italics are deliberately unsupported: reports quote
// identifiers like flat_saturated that must not turn italic.
const INLINE_RE = /(`+)([^`]+?)\1|\*\*(?=\S)([\s\S]+?)\*\*|__(?=\S)([\s\S]+?)__|~~(?=\S)([\s\S]+?)~~|\[([^\]\n]+)\]\(([^)\s]+)\)|(^|[^*\w])\*(?=\S)([^*\n]+?)\*(?!\*)/g;

function renderInline(text, keyBase = 'i') {
  const out = [];
  const src = String(text || '');
  let last = 0;
  let n = 0;
  const pushText = (s) => {
    if (!s) return;
    // Soft line breaks inside a paragraph stay visible, as the old renderer did.
    s.split('\n').forEach((part, idx) => {
      if (idx > 0) out.push(<br key={`${keyBase}-br-${n++}`} />);
      if (part) out.push(part);
    });
  };
  // A fresh regex per call: renderInline recurses, and a shared /g regex
  // would have its lastIndex reset under the outer loop.
  const re = new RegExp(INLINE_RE.source, 'g');
  let m;
  while ((m = re.exec(src)) !== null) {
    const k = `${keyBase}-${n++}`;
    if (m[2] !== undefined) {
      pushText(src.slice(last, m.index));
      out.push(<code key={k} className="font-mono text-[0.9em] bg-field border border-line rounded px-1 py-px break-words">{m[2]}</code>);
    } else if (m[3] !== undefined || m[4] !== undefined) {
      pushText(src.slice(last, m.index));
      out.push(<strong key={k} className="font-semibold text-ink">{renderInline(m[3] ?? m[4], k)}</strong>);
    } else if (m[5] !== undefined) {
      pushText(src.slice(last, m.index));
      out.push(<s key={k}>{renderInline(m[5], k)}</s>);
    } else if (m[6] !== undefined) {
      pushText(src.slice(last, m.index));
      const href = m[7];
      out.push(/^https?:\/\//i.test(href)
        ? <a key={k} href={href} target="_blank" rel="noopener noreferrer" className="text-brand underline underline-offset-2 break-words">{renderInline(m[6], k)}</a>
        : <span key={k}>{renderInline(m[6], k)}</span>);
    } else {
      // Italic: m[8] is the character before the opening star, kept as text.
      pushText(src.slice(last, m.index) + (m[8] || ''));
      out.push(<em key={k}>{renderInline(m[9], k)}</em>);
    }
    last = re.lastIndex;
  }
  pushText(src.slice(last));
  return out;
}

function ListNode({ list, depth = 0, keyBase }) {
  const Tag = list.ordered ? 'ol' : 'ul';
  const marker = list.ordered ? 'list-decimal' : depth === 0 ? 'list-disc' : depth === 1 ? 'list-[circle]' : 'list-[square]';
  return (
    <Tag
      start={list.ordered && list.start !== 1 ? list.start : undefined}
      className={`${marker} pl-5 space-y-1.5 marker:text-muted ${depth === 0 ? 'my-3' : 'mt-1.5'}`}
    >
      {list.items.map((item, i) => (
        <li key={i} className="pl-1">
          {renderInline(item.text, `${keyBase}-${i}`)}
          {item.children.map((child, c) => (
            <ListNode key={c} list={child} depth={depth + 1} keyBase={`${keyBase}-${i}-${c}`} />
          ))}
        </li>
      ))}
    </Tag>
  );
}

const HEADING_CLASS = {
  1: 'text-lg font-semibold mt-6 mb-2',
  2: 'text-base font-semibold mt-6 mb-2 pb-1 border-b border-line',
  3: 'text-base font-semibold mt-5 mb-1.5',
  4: 'text-sm font-semibold mt-4 mb-1',
};

function Block({ block, k }) {
  switch (block.type) {
    case 'heading': {
      const level = Math.min(block.level + 1, 6); // page and card own h1/h2
      const Tag = `h${level}`;
      return <Tag className={`font-display text-ink first:mt-0 ${HEADING_CLASS[block.level] || HEADING_CLASS[4]}`}>{renderInline(block.text, k)}</Tag>;
    }
    case 'para':
      return <p className="my-3 first:mt-0 last:mb-0">{renderInline(block.text, k)}</p>;
    case 'list':
      return <ListNode list={block.list} keyBase={k} />;
    case 'code':
      return <pre className="my-3 p-3 bg-field border border-line rounded-md overflow-x-auto text-xs font-mono whitespace-pre"><code>{block.text}</code></pre>;
    case 'quote':
      return (
        <blockquote className="my-3 pl-3 border-l-[3px] border-line text-muted">
          {block.blocks.map((b, i) => <Block key={i} block={b} k={`${k}-${i}`} />)}
        </blockquote>
      );
    case 'hr':
      return <hr className="my-5 border-line" />;
    case 'table':
      return (
        // The table scrolls inside its own box so a wide table never widens the page.
        <div className="my-4 max-w-full overflow-x-auto border border-line rounded-md" role="region" aria-label="Table" tabIndex={0}>
          <table className="min-w-full text-sm border-collapse [overflow-wrap:normal]">
            <thead className="bg-field">
              <tr>
                {block.header.map((c, i) => (
                  <th key={i} scope="col" className="px-3 py-2 text-left whitespace-nowrap border-b border-line" style={block.align[i] ? { textAlign: block.align[i] } : undefined}>
                    {renderInline(c, `${k}-h${i}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r} className="border-b border-line last:border-b-0">
                  {block.header.map((_, c) => (
                    <td key={c} className="px-3 py-2 align-top tabular" style={block.align[c] ? { textAlign: block.align[c] } : undefined}>
                      {renderInline(row[c] ?? '', `${k}-${r}-${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return null;
  }
}

/**
 * Report prose: comfortable measure, relaxed leading, tabular numbers, and
 * long unbroken strings wrap instead of widening the page on a phone.
 */
export default function ReportMarkdown({ markdown, className = '' }) {
  const blocks = useMemo(() => parseBlocks(markdown), [markdown]);
  if (!blocks.length) return null;
  return (
    <div className={`max-w-prose text-[15px] leading-7 text-ink tabular break-words [overflow-wrap:anywhere] ${className}`.trim()}>
      {blocks.map((b, i) => <Block key={i} block={b} k={`b${i}`} />)}
    </div>
  );
}
