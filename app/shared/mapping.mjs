// Applies a setup package's table mappings to raw spreadsheet rows and produces
// canonical records plus a list of issues. Errors block an import; warnings are
// shown but do not block. Everything is deterministic and data-only: the package
// can name headers, types and allowed values, never expressions.

import { ENTITIES, STATUS_BUCKETS } from './model.mjs';
import { parseDate, isIsoDate } from './dates.mjs';
import { tr } from './i18n.mjs';

export function issue(level, code, message, extra = {}) {
  return { level, code, message, ...extra };
}

function normaliseHeader(h) {
  return String(h ?? '').replace(/^﻿/, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function findHeaderIndex(headers, wanted) {
  const target = normaliseHeader(wanted);
  return headers.findIndex(h => normaliseHeader(h) === target);
}

export function parseMoneyCents(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) : null;
  if (typeof value !== 'string') return null;
  let text = value.trim();
  if (!text) return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1); }
  text = text.replace(/[A-Za-z$€£¥₹]+\.?/g, '').replace(/[,\s]/g, '');
  if (text.startsWith('-')) { negative = !negative; text = text.slice(1); }
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const cents = Math.round(Number(text) * 100);
  return negative ? -cents : cents;
}

export function parseInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isInteger(value) ? value : (Math.abs(value - Math.round(value)) < 1e-9 ? Math.round(value) : null);
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/,/g, '');
  return /^-?\d+$/.test(text) ? Number(text) : null;
}

function parseText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value).trim();
}

// Untrusted text must never become a formula when written back to a Sheet, and must
// never be rendered as HTML. Prefixing neutralises formula-leading characters; the
// browser renders with textContent only.
export function neutraliseText(text) {
  if (typeof text !== 'string') return text;
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function matchEnum(value, field, spec) {
  const text = parseText(value);
  if (!text) return field.default ?? null;
  const map = spec.values || {};
  const lower = text.toLowerCase();
  for (const [canonical, aliases] of Object.entries(map)) {
    if ((aliases || []).some(a => String(a).trim().toLowerCase() === lower)) return canonical;
  }
  if (field.values.includes(lower)) return lower;
  return undefined; // unknown
}

function statusBucket(value, statusMap) {
  const text = parseText(value);
  if (!text) return statusMap?.blank || undefined;
  const lower = text.toLowerCase();
  for (const bucket of STATUS_BUCKETS) {
    if ((statusMap?.[bucket] || []).some(a => String(a).trim().toLowerCase() === lower)) return bucket;
  }
  return undefined;
}

export function applyTableMapping(table, rows, pkg) {
  const entity = ENTITIES[table.entity];
  const issues = [];
  const records = [];
  if (!entity) {
    issues.push(issue('error', 'unknown_entity', tr('Table "{0}" maps to unknown entity "{1}".', table.table_id, table.entity)));
    return { records, issues };
  }
  const headerRowIndex = Math.max(1, table.header_row || 1) - 1;
  if (!Array.isArray(rows) || rows.length <= headerRowIndex) {
    issues.push(issue('error', 'empty_table', tr('"{0}" has no header row at row {1}. Check the worksheet name and header row in the mapping.', table.sheet_name || table.table_id, headerRowIndex + 1), { table: table.table_id }));
    return { records, issues };
  }
  const headers = rows[headerRowIndex].map(parseText);
  const columnIndex = {};
  const missing = [];
  for (const f of table.fields || []) {
    if (f.constant !== undefined) continue;
    const idx = findHeaderIndex(headers, f.header);
    if (idx === -1) missing.push(f);
    else columnIndex[f.canonical] = idx;
  }
  if (missing.length) {
    const found = headers.filter(Boolean).map(h => `"${h}"`).join(', ') || tr('(none)');
    for (const f of missing) {
      issues.push(issue('error', 'missing_header',
        tr('Column "{0}" (used for {1}.{2}) was not found in "{3}". Headers found: {4}. If the column was renamed, review this source in Settings > Business setup.', f.header, table.entity, f.canonical, table.sheet_name || table.table_id, found),
        { table: table.table_id, field: f.canonical, header: f.header, headers_found: headers }));
    }
    return { records, issues };
  }
  const dateOrder = pkg?.policies?.dates?.order || 'dmy';
  const statusMap = pkg?.status_map;
  const seenIds = new Map();
  for (let r = headerRowIndex + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    if (row.every(v => v === null || v === undefined || parseText(v) === '')) continue; // blank row
    const rec = { _row: r + 1, _source: `${table.sheet_name || table.table_id}!${r + 1}` };
    let rowFailed = false;
    for (const f of table.fields || []) {
      const spec = entity.fields[f.canonical];
      if (!spec) {
        issues.push(issue('error', 'unknown_field', tr('Field "{0}" is not part of {1}.', f.canonical, table.entity), { table: table.table_id }));
        rowFailed = true; continue;
      }
      const raw = f.constant !== undefined ? f.constant : row[columnIndex[f.canonical]];
      let value;
      switch (spec.type) {
        case 'text': value = parseText(raw); break;
        case 'money': {
          value = parseMoneyCents(raw);
          if (value === null && raw !== '' && raw !== null && raw !== undefined) {
            issues.push(issue('error', 'bad_money', tr('Row {0} of "{1}": "{2}" in column "{3}" is not an amount.', r + 1, table.sheet_name, parseText(raw), f.header), { table: table.table_id, row: r + 1, field: f.canonical }));
            rowFailed = true;
          }
          break;
        }
        case 'integer': {
          value = parseInteger(raw);
          if (value === null && raw !== '' && raw !== null && raw !== undefined) {
            issues.push(issue('error', 'bad_integer', tr('Row {0} of "{1}": "{2}" in column "{3}" is not a whole number.', r + 1, table.sheet_name, parseText(raw), f.header), { table: table.table_id, row: r + 1, field: f.canonical }));
            rowFailed = true;
          }
          break;
        }
        case 'date': {
          value = parseDate(raw, { order: f.date_order || dateOrder });
          if (value === null && raw !== '' && raw !== null && raw !== undefined) {
            issues.push(issue('error', 'bad_date', tr('Row {0} of "{1}": "{2}" in column "{3}" is not a date. Expected ISO (2026-08-30), a spreadsheet date, or {4} text.', r + 1, table.sheet_name, parseText(raw), f.header, (f.date_order || dateOrder).toUpperCase()), { table: table.table_id, row: r + 1, field: f.canonical }));
            rowFailed = true;
          }
          break;
        }
        case 'enum': {
          value = matchEnum(raw, spec, f);
          if (value === undefined) {
            issues.push(issue('error', 'unknown_value', tr('Row {0} of "{1}": value "{2}" in column "{3}" is not one of the confirmed meanings for {4}.{5}. Add it to the mapping before importing.', r + 1, table.sheet_name, parseText(raw), f.header, table.entity, f.canonical), { table: table.table_id, row: r + 1, field: f.canonical, value: parseText(raw) }));
            rowFailed = true;
          }
          break;
        }
        case 'status': {
          value = statusBucket(raw, statusMap);
          rec.status_text = parseText(raw);
          if (value === undefined) {
            issues.push(issue('error', 'unknown_status', tr('Row {0} of "{1}": status "{2}" is not listed in status_map (pending/done/excluded). Confirm what it means before importing.', r + 1, table.sheet_name, parseText(raw)), { table: table.table_id, row: r + 1, value: parseText(raw) }));
            rowFailed = true;
          }
          break;
        }
        default: value = parseText(raw);
      }
      if ((value === null || value === '' || value === undefined) && spec.default !== undefined && spec.type !== 'text') value = spec.default;
      rec[f.canonical] = value;
    }
    for (const [name, spec] of Object.entries(entity.fields)) {
      if (!(name in rec)) {
        if (spec.default !== undefined) rec[name] = spec.default;
        else if (spec.type === 'text') rec[name] = '';
        else rec[name] = null;
      }
      if (spec.required && (rec[name] === null || rec[name] === '' || rec[name] === undefined)) {
        issues.push(issue('error', 'missing_required', tr('Row {0} of "{1}": required field {2}.{3} is blank.', r + 1, table.sheet_name, table.entity, name), { table: table.table_id, row: r + 1, field: name }));
        rowFailed = true;
      }
    }
    if (table.entity === 'sales' && rec.status === null && !(table.fields || []).some(f => f.canonical === 'status')) {
      rec.status = 'done'; rec.status_text = '';
    }
    if (rowFailed) continue;
    const id = deriveIdentity(table, rec, r + 1, issues);
    if (id === null) continue;
    rec.id = id;
    if (seenIds.has(id)) {
      issues.push(issue('error', 'duplicate_id', tr('{0} identifier "{1}" appears on rows {2} and {3} of "{4}". Each record needs one row; remove or correct the duplicate.', table.entity, id, seenIds.get(id), r + 1, table.sheet_name), { table: table.table_id, row: r + 1, id }));
      continue;
    }
    seenIds.set(id, r + 1);
    records.push(rec);
  }
  return { records, issues };
}

function deriveIdentity(table, rec, rowNumber, issues) {
  const identity = table.identity || { mode: 'source_id', field: 'id' };
  if (identity.mode === 'source_id') return rec.id;
  if (identity.mode === 'composite') {
    const parts = (identity.fields || []).map(f => rec[f] ?? '');
    if (parts.some(p => p === '' || p === null)) {
      issues.push(issue('error', 'identity_incomplete', tr('Row {0} of "{1}": composite identity fields ({2}) are incomplete.', rowNumber, table.sheet_name, (identity.fields || []).join(', ')), { table: table.table_id, row: rowNumber }));
      return null;
    }
    return parts.join('|');
  }
  if (identity.mode === 'row_number') return `${table.table_id}#${rowNumber}`;
  issues.push(issue('error', 'identity_mode', tr('Unknown identity mode "{0}" for table {1}.', identity.mode, table.table_id)));
  return null;
}

// Cross-table checks after all tables are mapped.
export function relationalChecks(records) {
  const issues = [];
  const customers = new Set((records.customers || []).map(c => c.id));
  const sales = new Map((records.sales || []).map(s => [s.id, s]));
  const stock = new Set((records.stock || []).map(s => s.id));
  for (const s of records.sales || []) {
    if (s.customer_id && records.customers && !customers.has(s.customer_id)) {
      issues.push(issue('warning', 'orphan_customer', tr('Sale {0} refers to customer "{1}" which is not in the customers table.', s.id, s.customer_id), { id: s.id }));
    }
    if (s.quantity !== null && s.quantity < 0) issues.push(issue('error', 'negative_quantity', tr('Sale {0} has a negative quantity.', s.id), { id: s.id }));
    if (s.amount !== null && s.amount < 0) issues.push(issue('error', 'negative_amount', tr('Sale {0} has a negative amount.', s.id), { id: s.id }));
    if (s.status === 'done' && s.actual_completion_date === null && s.promised_completion_date !== null) {
      // informational only: completed without a date is acceptable in many businesses
    }
  }
  for (const p of records.payments || []) {
    if (!sales.has(p.sale_id)) {
      issues.push(issue('error', 'orphan_payment', tr('Payment {0} refers to sale "{1}" which is not in the sales table. Money that cannot be matched to a sale would distort balances.', p.id, p.sale_id), { id: p.id }));
    }
    if (p.amount !== null && p.amount <= 0) issues.push(issue('error', 'nonpositive_payment', tr('Payment {0} has a zero or negative amount.', p.id), { id: p.id }));
  }
  for (const st of records.stock || []) {
    if (st.reserved !== null && st.on_hand !== null && st.reserved > st.on_hand) {
      issues.push(issue('warning', 'reserved_exceeds_on_hand', tr('Stock {0}: reserved {1} exceeds on hand {2}.', st.id, st.reserved, st.on_hand), { id: st.id }));
    }
  }
  const snapshotDates = new Set((records.stock || []).map(s => s.snapshot_date).filter(Boolean));
  if (snapshotDates.size > 1) {
    issues.push(issue('warning', 'mixed_snapshot_dates', tr('Stock rows carry {0} different snapshot dates ({1}). The dashboard labels the latest.', snapshotDates.size, [...snapshotDates].sort().join(', '))));
  }
  if (records.sales && stock.size) {
    for (const s of records.sales) {
      if (s.offering_type === 'product' && s.item_id && !stock.has(s.item_id)) {
        issues.push(issue('warning', 'unknown_item', tr('Sale {0} refers to product "{1}" which has no stock row.', s.id, s.item_id), { id: s.id }));
      }
    }
  }
  return issues;
}

// Decide the reporting date from the package policy and the mapped records.
export function resolveReportingDate(pkg, records, today) {
  const policy = pkg.reporting_date || { mode: 'today' };
  if (policy.mode === 'fixed') {
    if (!isIsoDate(policy.value)) throw new Error(tr('reporting_date.value "{0}" is not a valid date.', policy.value));
    return { date: policy.value, basis: 'fixed' };
  }
  if (policy.mode === 'latest_event_date') {
    let max = null;
    const consider = v => { if (isIsoDate(v) && (max === null || v > max)) max = v; };
    for (const s of records.sales || []) { consider(s.date); consider(s.actual_completion_date); }
    for (const p of records.payments || []) consider(p.date);
    for (const st of records.stock || []) consider(st.snapshot_date);
    for (const c of records.customers || []) consider(c.created_date);
    if (!max) throw new Error(tr('No dated records found to derive the reporting date.'));
    return { date: max, basis: 'latest_event_date' };
  }
  return { date: today, basis: 'today' };
}

export function sourceCoverage(records) {
  let max = null, min = null;
  const consider = v => {
    if (!isIsoDate(v)) return;
    if (max === null || v > max) max = v;
    if (min === null || v < min) min = v;
  };
  for (const s of records.sales || []) consider(s.date);
  for (const p of records.payments || []) consider(p.date);
  for (const st of records.stock || []) consider(st.snapshot_date);
  return { earliest_event_date: min, latest_event_date: max };
}

export function hasErrors(issues) { return issues.some(i => i.level === 'error'); }
