/**
 * Excel-safe CSV writer. Outputs UTF-8 with BOM, properly quotes fields containing
 * commas / quotes / newlines, and formats numbers without thousands separators.
 *
 * Usage:
 *   const buf = csvFromRows(['ts','metric','mean'], rows.map(r => [r.ts, r.metric, r.mean]));
 *   stream.write(buf);
 */

const UTF8_BOM = '﻿';

function escapeCell(v) {
  if (v == null) return '';
  let s;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '';
    s = String(v); // No thousands separators; point decimal. Best for cross-locale CSV.
  } else if (v instanceof Date) {
    s = formatTimestamp(v);
  } else if (typeof v === 'boolean') {
    s = v ? 'true' : 'false';
  } else {
    s = String(v);
    // Strip embedded CR; preserve LF inside quoted cell
    s = s.replace(/\r/g, '');
  }
  if (/[",\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function csvLine(cells) {
  return cells.map(escapeCell).join(',') + '\n';
}

function csvFromRows(header, rows, opts = {}) {
  const parts = [];
  if (opts.bom !== false) parts.push(UTF8_BOM);
  parts.push(csvLine(header));
  for (const r of rows) parts.push(csvLine(r));
  return parts.join('');
}

/**
 * Streaming CSV writer for big files. Caller provides a write fn (e.g. zip entry stream).
 * Returns { writeRow, writeHeader, end }.
 */
function streamingCsvWriter(write, opts = {}) {
  if (opts.bom !== false) write(UTF8_BOM);
  return {
    writeHeader(header) { write(csvLine(header)); },
    writeRow(cells) { write(csvLine(cells)); },
  };
}

/**
 * Format a JS Date or ISO string as "YYYY-MM-DD HH:MM:SS" (UTC).
 * Excel parses this format reliably across locales.
 */
function formatTimestamp(d) {
  const date = d instanceof Date ? d : new Date(d);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/**
 * Normalize a SQLite timestamp string ("2026-05-17T11:46:12.091Z" or "2026-05-17 11:46:12")
 * to "YYYY-MM-DD HH:MM:SS". Returns input as-is if unparseable.
 */
function normalizeTimestampStr(s) {
  if (!s) return '';
  // If already in "YYYY-MM-DD HH:MM:SS" form with no T and no fractional seconds, leave it
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return s;
  const iso = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return s;
  return formatTimestamp(d);
}

module.exports = {
  UTF8_BOM,
  escapeCell,
  csvLine,
  csvFromRows,
  streamingCsvWriter,
  formatTimestamp,
  normalizeTimestampStr,
};
