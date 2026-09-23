// Setup-package validation: a small JSON-schema subset validator plus semantic
// checks against the canonical model. The app refuses to touch workspace data
// until a package passes both. Business setup runs the same validation before it
// saves, so the owner sees these messages at review time.

import { ENTITIES, TASK_RULES, MODULES } from './model.mjs';
import { isIsoDate } from './dates.mjs';

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
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: must be one of ${schema.enum.map(e => JSON.stringify(e)).join(', ')}`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(t => typeMatches(value, t))) {
      errors.push(`${path}: expected ${types.join(' or ')}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if (typeOf(value) === 'string') {
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength} characters`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: "${value.slice(0, 40)}" does not match the required format`);
  }
  if (typeOf(value) === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: needs at least ${schema.minItems} item(s)`);
    if (schema.items) value.forEach((item, i) => validateAgainstSchema(schema.items, item, `${path}[${i}]`, errors));
  }
  if (typeOf(value) === 'object') {
    for (const req of schema.required || []) {
      if (!(req in value)) errors.push(`${path}: missing required property "${req}"`);
    }
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) validateAgainstSchema(props[k], v, `${path}.${k}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected property "${k}"`);
    }
  }
  return errors;
}

export function semanticChecks(pkg) {
  const errors = [];
  const warnings = [];
  const sourceIds = new Set();
  for (const s of pkg.sources || []) {
    if (sourceIds.has(s.source_id)) errors.push(`sources: duplicate source_id "${s.source_id}"`);
    sourceIds.add(s.source_id);
  }
  const entitiesSeen = new Set();
  const tableIds = new Set();
  for (const t of pkg.tables || []) {
    if (tableIds.has(t.table_id)) errors.push(`tables: duplicate table_id "${t.table_id}"`);
    tableIds.add(t.table_id);
    if (entitiesSeen.has(t.entity)) errors.push(`tables: entity "${t.entity}" is mapped twice (${t.table_id}). Version 1 supports one table per entity; do not combine duplicate exports.`);
    entitiesSeen.add(t.entity);
    if (!sourceIds.has(t.source_id)) errors.push(`tables[${t.table_id}]: source_id "${t.source_id}" is not declared in sources`);
    const src = (pkg.sources || []).find(s => s.source_id === t.source_id);
    if (src?.kind === 'google_sheet' && !t.sheet_name) errors.push(`tables[${t.table_id}]: sheet_name is required for a Google Sheet source`);
    const entity = ENTITIES[t.entity];
    if (!entity) continue;
    const mapped = new Set();
    for (const f of t.fields || []) {
      const spec = entity.fields[f.canonical];
      if (!spec) { errors.push(`tables[${t.table_id}]: "${f.canonical}" is not a field of ${t.entity}. Allowed: ${Object.keys(entity.fields).join(', ')}`); continue; }
      if (mapped.has(f.canonical)) errors.push(`tables[${t.table_id}]: field "${f.canonical}" is mapped twice`);
      mapped.add(f.canonical);
      const hasHeader = typeof f.header === 'string' && f.header.trim() !== '';
      const hasConstant = f.constant !== undefined;
      if (hasHeader === hasConstant) errors.push(`tables[${t.table_id}].${f.canonical}: give either a header or a constant, not both/neither`);
      if (spec.type === 'enum' && f.values) {
        for (const k of Object.keys(f.values)) {
          if (!spec.values.includes(k)) errors.push(`tables[${t.table_id}].${f.canonical}: "${k}" is not an allowed meaning (${spec.values.join(', ')})`);
        }
      }
      if (hasConstant && spec.type === 'enum' && !spec.values.includes(String(f.constant))) errors.push(`tables[${t.table_id}].${f.canonical}: constant "${f.constant}" is not one of ${spec.values.join(', ')}`);
    }
    for (const [name, spec] of Object.entries(entity.fields)) {
      if (spec.required && !mapped.has(name)) errors.push(`tables[${t.table_id}]: required field ${t.entity}.${name} is not mapped`);
    }
    const identity = t.identity || { mode: 'source_id' };
    if (identity.mode === 'source_id' && !mapped.has('id')) errors.push(`tables[${t.table_id}]: identity uses the source id but "id" is not mapped`);
    if (identity.mode === 'composite') {
      if (!Array.isArray(identity.fields) || identity.fields.length < 2) errors.push(`tables[${t.table_id}]: composite identity needs at least two fields`);
      else for (const f of identity.fields) if (!mapped.has(f)) errors.push(`tables[${t.table_id}]: composite identity field "${f}" is not mapped`);
      if (!identity.limits) warnings.push(`tables[${t.table_id}]: composite identity has no "limits" note; disclose what happens when the combination repeats`);
    }
    if (identity.mode === 'row_number') warnings.push(`tables[${t.table_id}]: row-number identity is fragile — sorting or inserting rows changes identities and task history`);
    if (t.entity === 'sales' && mapped.has('status')) {
      const sm = pkg.status_map || {};
      const total = (sm.pending || []).length + (sm.done || []).length + (sm.excluded || []).length;
      if (!total) errors.push('status_map: sales.status is mapped but status_map lists no values');
      const all = [...(sm.pending || []), ...(sm.done || []), ...(sm.excluded || [])].map(v => v.toLowerCase());
      const dup = all.filter((v, i) => all.indexOf(v) !== i);
      if (dup.length) errors.push(`status_map: value(s) ${[...new Set(dup)].join(', ')} appear in more than one bucket`);
    }
  }
  if (!entitiesSeen.has('sales')) warnings.push('No sales table is mapped: order value, cash and balance metrics will be unavailable');
  if (entitiesSeen.has('payments') && !entitiesSeen.has('sales')) errors.push('payments cannot be mapped without sales');
  for (const [name, on] of Object.entries(pkg.modules || {})) {
    if (!MODULES.includes(name)) errors.push(`modules: unknown module "${name}"`);
    if (on && ['sales', 'customers', 'payments', 'stock'].includes(name) && !entitiesSeen.has(name)) warnings.push(`modules.${name} is enabled but no ${name} table is mapped; the section will be hidden`);
  }
  for (const rule of pkg.policies?.tasks || []) {
    const def = TASK_RULES[rule.rule];
    if (!def) { errors.push(`policies.tasks: unknown rule "${rule.rule}"`); continue; }
    for (const [p, v] of Object.entries(rule.params || {})) {
      if (!def.params[p]) errors.push(`policies.tasks[${rule.rule}]: unknown parameter "${p}"`);
      else if (!Number.isInteger(v) || v < 0 || v > 365) errors.push(`policies.tasks[${rule.rule}].${p}: must be a whole number of days between 0 and 365`);
    }
    if (rule.enabled !== false && !def.needs.every(n => entitiesSeen.has(n))) warnings.push(`policies.tasks[${rule.rule}] needs ${def.needs.join(' + ')}; it will be skipped until those tables are mapped`);
  }
  const rd = pkg.reporting_date || {};
  if (rd.mode === 'fixed' && !isIsoDate(rd.value)) errors.push('reporting_date: mode "fixed" needs a valid value (YYYY-MM-DD)');
  if (pkg.period?.history_start && !isIsoDate(pkg.period.history_start)) errors.push('period.history_start is not a valid date');
  if (pkg.confirmation?.state !== 'confirmed') warnings.push('confirmation.state is not "confirmed": the app will import it as a draft and show the open questions');
  if (pkg.records) {
    for (const [entity, rows] of Object.entries(pkg.records)) {
      if (!entitiesSeen.has(entity)) errors.push(`records.${entity} supplied but no ${entity} table is mapped`);
      const src = (pkg.tables || []).find(t => t.entity === entity);
      const kind = (pkg.sources || []).find(s => s.source_id === src?.source_id)?.kind;
      if (kind !== 'manual_package') errors.push(`records.${entity}: reviewed records are only accepted for a manual_package source`);
      if (rows.length > 5000) errors.push(`records.${entity}: ${rows.length} rows exceeds the 5,000-row limit for a manual package`);
    }
  }
  return { errors, warnings };
}

export function validatePackage(pkg, schema) {
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
    return { ok: false, errors: ['The file is not a setup package object.'], warnings: [] };
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
