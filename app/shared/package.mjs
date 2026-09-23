// Setup-package validation: a small JSON-schema subset validator plus semantic
// checks against the canonical model. The app refuses to touch workspace data
// until a package passes both. Business setup runs the same validation before it
// saves, so the owner sees these messages at review time.

import { ENTITIES, TASK_RULES, MODULES } from './model.mjs';
import { isIsoDate } from './dates.mjs';
import { tr } from './i18n.mjs';

export const PACKAGE_VERSION = '1.0';

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function typeMatches(v, t) {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

export function validateAgainstSchema(schema, value, path = '$', errors = []) {
  if (schema.const !== undefined && value !== schema.const) errors.push(tr('{0}: must be {1}', path, JSON.stringify(schema.const)));
  if (schema.enum && !schema.enum.includes(value)) errors.push(tr('{0}: must be one of {1}', path, schema.enum.map(e => JSON.stringify(e)).join(', ')));
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(t => typeMatches(value, t))) {
      errors.push(tr('{0}: expected {1}, got {2}', path, types.join(' or '), typeOf(value)));
      return errors;
    }
  }
  if (typeOf(value) === 'string') {
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(tr('{0}: longer than {1} characters', path, schema.maxLength));
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(tr('{0}: "{1}" does not match the required format', path, value.slice(0, 40)));
  }
  if (typeOf(value) === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(tr('{0}: needs at least {1} item(s)', path, schema.minItems));
    if (schema.items) value.forEach((item, i) => validateAgainstSchema(schema.items, item, `${path}[${i}]`, errors));
  }
  if (typeOf(value) === 'object') {
    for (const req of schema.required || []) {
      if (!(req in value)) errors.push(tr('{0}: missing required property "{1}"', path, req));
    }
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) validateAgainstSchema(props[k], v, `${path}.${k}`, errors);
      else if (schema.additionalProperties === false) errors.push(tr('{0}: unexpected property "{1}"', path, k));
    }
  }
  return errors;
}

export function semanticChecks(pkg) {
  const errors = [];
  const warnings = [];
  const sourceIds = new Set();
  for (const s of pkg.sources || []) {
    if (sourceIds.has(s.source_id)) errors.push(tr('sources: duplicate source_id "{0}"', s.source_id));
    sourceIds.add(s.source_id);
  }
  const entitiesSeen = new Set();
  const tableIds = new Set();
  for (const t of pkg.tables || []) {
    if (tableIds.has(t.table_id)) errors.push(tr('tables: duplicate table_id "{0}"', t.table_id));
    tableIds.add(t.table_id);
    if (entitiesSeen.has(t.entity)) errors.push(tr('tables: entity "{0}" is mapped twice ({1}). Version 1 supports one table per entity; do not combine duplicate exports.', t.entity, t.table_id));
    entitiesSeen.add(t.entity);
    if (!sourceIds.has(t.source_id)) errors.push(tr('tables[{0}]: source_id "{1}" is not declared in sources', t.table_id, t.source_id));
    const src = (pkg.sources || []).find(s => s.source_id === t.source_id);
    if (src?.kind === 'google_sheet' && !t.sheet_name) errors.push(tr('tables[{0}]: sheet_name is required for a Google Sheet source', t.table_id));
    const entity = ENTITIES[t.entity];
    if (!entity) continue;
    const mapped = new Set();
    for (const f of t.fields || []) {
      const spec = entity.fields[f.canonical];
      if (!spec) { errors.push(tr('tables[{0}]: "{1}" is not a field of {2}. Allowed: {3}', t.table_id, f.canonical, t.entity, Object.keys(entity.fields).join(', '))); continue; }
      if (mapped.has(f.canonical)) errors.push(tr('tables[{0}]: field "{1}" is mapped twice', t.table_id, f.canonical));
      mapped.add(f.canonical);
      const hasHeader = typeof f.header === 'string' && f.header.trim() !== '';
      const hasConstant = f.constant !== undefined;
      if (hasHeader === hasConstant) errors.push(tr('tables[{0}].{1}: give either a header or a constant, not both/neither', t.table_id, f.canonical));
      if (spec.type === 'enum' && f.values) {
        for (const k of Object.keys(f.values)) {
          if (!spec.values.includes(k)) errors.push(tr('tables[{0}].{1}: "{2}" is not an allowed meaning ({3})', t.table_id, f.canonical, k, spec.values.join(', ')));
        }
      }
      if (hasConstant && spec.type === 'enum' && !spec.values.includes(String(f.constant))) errors.push(tr('tables[{0}].{1}: constant "{2}" is not one of {3}', t.table_id, f.canonical, f.constant, spec.values.join(', ')));
    }
    for (const [name, spec] of Object.entries(entity.fields)) {
      if (spec.required && !mapped.has(name)) errors.push(tr('tables[{0}]: required field {1}.{2} is not mapped', t.table_id, t.entity, name));
    }
    const identity = t.identity || { mode: 'source_id' };
    if (identity.mode === 'source_id' && !mapped.has('id')) errors.push(tr('tables[{0}]: identity uses the source id but "id" is not mapped', t.table_id));
    if (identity.mode === 'composite') {
      if (!Array.isArray(identity.fields) || identity.fields.length < 2) errors.push(tr('tables[{0}]: composite identity needs at least two fields', t.table_id));
      else for (const f of identity.fields) if (!mapped.has(f)) errors.push(tr('tables[{0}]: composite identity field "{1}" is not mapped', t.table_id, f));
      if (!identity.limits) warnings.push(tr('tables[{0}]: composite identity has no "limits" note; disclose what happens when the combination repeats', t.table_id));
    }
    if (identity.mode === 'row_number') warnings.push(tr('tables[{0}]: row-number identity is fragile — sorting or inserting rows changes identities and task history', t.table_id));
    if (t.entity === 'sales' && mapped.has('status')) {
      const sm = pkg.status_map || {};
      const total = (sm.pending || []).length + (sm.done || []).length + (sm.excluded || []).length;
      if (!total) errors.push(tr('status_map: sales.status is mapped but status_map lists no values'));
      const all = [...(sm.pending || []), ...(sm.done || []), ...(sm.excluded || [])].map(v => v.toLowerCase());
      const dup = all.filter((v, i) => all.indexOf(v) !== i);
      if (dup.length) errors.push(tr('status_map: value(s) {0} appear in more than one bucket', [...new Set(dup)].join(', ')));
    }
  }
  if (!entitiesSeen.has('sales')) warnings.push(tr('No sales table is mapped: order value, cash and balance metrics will be unavailable'));
  if (entitiesSeen.has('payments') && !entitiesSeen.has('sales')) errors.push(tr('payments cannot be mapped without sales'));
  for (const [name, on] of Object.entries(pkg.modules || {})) {
    if (!MODULES.includes(name)) errors.push(tr('modules: unknown module "{0}"', name));
    if (on && ['sales', 'customers', 'payments', 'stock'].includes(name) && !entitiesSeen.has(name)) warnings.push(tr('modules.{0} is enabled but no {1} table is mapped; the section will be hidden', name, name));
  }
  for (const rule of pkg.policies?.tasks || []) {
    const def = TASK_RULES[rule.rule];
    if (!def) { errors.push(tr('policies.tasks: unknown rule "{0}"', rule.rule)); continue; }
    for (const [p, v] of Object.entries(rule.params || {})) {
      if (!def.params[p]) errors.push(tr('policies.tasks[{0}]: unknown parameter "{1}"', rule.rule, p));
      else if (!Number.isInteger(v) || v < 0 || v > 365) errors.push(tr('policies.tasks[{0}].{1}: must be a whole number of days between 0 and 365', rule.rule, p));
    }
    if (rule.enabled !== false && !def.needs.every(n => entitiesSeen.has(n))) warnings.push(tr('policies.tasks[{0}] needs {1}; it will be skipped until those tables are mapped', rule.rule, def.needs.join(' + ')));
  }
  const rd = pkg.reporting_date || {};
  if (rd.mode === 'fixed' && !isIsoDate(rd.value)) errors.push(tr('reporting_date: mode "fixed" needs a valid value (YYYY-MM-DD)'));
  if (pkg.period?.history_start && !isIsoDate(pkg.period.history_start)) errors.push(tr('period.history_start is not a valid date'));
  if (pkg.confirmation?.state !== 'confirmed') warnings.push(tr('confirmation.state is not "confirmed": the app will import it as a draft and show the open questions'));
  if (pkg.records) {
    for (const [entity, rows] of Object.entries(pkg.records)) {
      if (!entitiesSeen.has(entity)) errors.push(tr('records.{0} supplied but no {1} table is mapped', entity, entity));
      const src = (pkg.tables || []).find(t => t.entity === entity);
      const kind = (pkg.sources || []).find(s => s.source_id === src?.source_id)?.kind;
      if (kind !== 'manual_package') errors.push(tr('records.{0}: reviewed records are only accepted for a manual_package source', entity));
      if (rows.length > 5000) errors.push(tr('records.{0}: {1} rows exceeds the 5,000-row limit for a manual package', entity, rows.length));
    }
  }
  return { errors, warnings };
}

export function validatePackage(pkg, schema) {
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
    return { ok: false, errors: [tr('The file is not a setup package object.')], warnings: [] };
  }
  const schemaErrors = validateAgainstSchema(schema, pkg);
  if (schemaErrors.length) return { ok: false, errors: schemaErrors, warnings: [] };
  const { errors, warnings } = semanticChecks(pkg);
  return { ok: errors.length === 0, errors, warnings };
}

// Which dashboard modules are actually shown: enabled AND supported by mapped tables.
export function effectiveModules(pkg) {
  const mapped = new Set((pkg.tables || []).map(t => t.entity));
  const m = pkg.modules || {};
  const on = name => m[name] !== false;
  return {
    overview: on('overview'),
    sales: on('sales') && mapped.has('sales'),
    customers: on('customers') && mapped.has('customers'),
    payments: on('payments') && mapped.has('payments'),
    stock: on('stock') && mapped.has('stock'),
    tasks: on('tasks'),
    calendar: on('calendar'),
    ai: on('ai'),
  };
}

// For manual_package sources: turn reviewed canonical records into header+rows that
// the importer maps exactly like a spreadsheet. Stored in Settings as manual_rows.<table_id>.
export function manualRowsFromPackage(pkg) {
  const out = {};
  if (!pkg.records) return out;
  for (const tb of pkg.tables) {
    const rows = pkg.records[tb.entity];
    if (!rows) continue;
    const mapped = tb.fields.filter(f => f.header);
    const header = mapped.map(f => f.header);
    out[`manual_rows.${tb.table_id}`] = [...Array.from({ length: Math.max(1, tb.header_row || 1) - 1 }, () => []), header, ...rows.map(r => mapped.map(f => { const v = r[f.canonical]; return v === null || v === undefined ? '' : v; }))];
  }
  return out;
}
