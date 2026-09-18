'use strict';

function escapeCsvField(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function toCsv(rows, columns) {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => escapeCsvField(row[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}

/**
 * RFC 4180 parser: quoted fields, escaped quotes, embedded newlines,
 * CRLF or LF. Returns an array of objects keyed by the header row.
 */
function parseCsv(text) {
  const records = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  const src = text.replace(/^﻿/, '');

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      record.push(field);
      field = '';
      records.push(record);
      record = [];
    } else {
      field += ch;
    }
  }
  if (inQuotes) throw new Error('Malformed CSV: unterminated quoted field');
  if (field !== '' || record.length) {
    record.push(field);
    records.push(record);
  }

  const nonEmpty = records.filter((r) => !(r.length === 1 && r[0] === ''));
  if (nonEmpty.length === 0) return [];
  const [header, ...body] = nonEmpty;
  return body.map((r) => Object.fromEntries(header.map((h, idx) => [h.trim(), r[idx] === undefined ? '' : r[idx]])));
}

module.exports = { toCsv, parseCsv, escapeCsvField };
