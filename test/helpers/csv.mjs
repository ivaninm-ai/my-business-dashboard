// Minimal RFC-4180 CSV reader for test fixtures (UTF-8 with optional BOM).
import { readFileSync } from 'node:fs';

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

export function readCsv(path) { return parseCsv(readFileSync(path, 'utf8')); }

// Convert CSV strings into the value types the Sheets API returns with
// UNFORMATTED_VALUE + SERIAL_NUMBER: numbers as numbers, ISO dates as serials.
export function sheetify(rows, { datesAsSerial = true } = {}) {
  const EPOCH = Date.UTC(1899, 11, 30);
  return rows.map((r, i) => r.map(v => {
    if (i === 0) return v;
    if (v === '') return '';
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    if (datesAsSerial && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const [y, m, d] = v.split('-').map(Number);
      return Math.round((Date.UTC(y, m - 1, d) - EPOCH) / 86400000);
    }
    return v;
  }));
}
