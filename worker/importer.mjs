// Scheduled/manual import: read bound sources with the read-only service-account
// token, apply the saved mapping, validate everything, and only then write the
// snapshot, metrics and reconciled task suggestions into the workspace. A failed
// import leaves the last good snapshot in place and records why it failed.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createSheetsClient, quoteSheet } from '../app/shared/sheets.mjs';
import { inspectWorkspace, ensureWorkspace, readKeyValues, writeKeyValues, readTable, replaceTable, appendRows, trimTable, parseJsonCell, toStoredRow, LIMITS } from '../app/shared/workspace.mjs';
import { validatePackage } from '../app/shared/package.mjs';
import { applyTableMapping, relationalChecks, resolveReportingDate, sourceCoverage, hasErrors } from '../app/shared/mapping.mjs';
import { computeMetrics, METRICS_VERSION } from '../app/shared/metrics.mjs';
import { generateSuggestions, reconcileSuggestions, TASKS_VERSION } from '../app/shared/tasks.mjs';
import { todayIso, monthStart } from '../app/shared/dates.mjs';
import { tokenProvider, apiBase } from './google-auth.mjs';
import { tr, useWorkerLocale } from '../app/shared/i18n.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA = JSON.parse(readFileSync(path.join(here, '../app/shared/setup-package.schema.json'), 'utf8'));
export const APP_VERSION = JSON.parse(readFileSync(path.join(here, '../package.json'), 'utf8')).version;

const LEASE_MS = 10 * 60 * 1000;

export class ImportError extends Error {
  constructor(message, { code = 'import_failed', issues = [] } = {}) { super(message); this.code = code; this.issues = issues; }
}

export function makeClients(credentials, { fetchFn } = {}) {
  const base = apiBase();
  return {
    workspace: createSheetsClient({ apiBase: base, getToken: tokenProvider(credentials, 'write', { fetchFn }), fetchFn }),
    sources: createSheetsClient({ apiBase: base, getToken: tokenProvider(credentials, 'readonly', { fetchFn }), fetchFn }),
    email: credentials.client_email,
  };
}

export async function acquireLease(ws, id, holder, now = Date.now) {
  const { values } = await readKeyValues(ws, id, '_Workspace');
  const expires = Date.parse(values.lease_expires || '') || 0;
  if (values.lease_holder && expires > now()) {
    throw new ImportError(tr('Another worker run ({0}) is still in progress until {1}. Wait for it to finish; runs are serialised to protect the workspace.', values.lease_holder, values.lease_expires), { code: 'busy' });
  }
  await writeKeyValues(ws, id, '_Workspace', { lease_holder: holder, lease_expires: new Date(now() + LEASE_MS).toISOString() }, { timestamp: false });
}

export async function releaseLease(ws, id) {
  await writeKeyValues(ws, id, '_Workspace', { lease_holder: '', lease_expires: '' }, { timestamp: false }).catch(() => {});
}

export async function loadSetup(ws, id) {
  const { values } = await readKeyValues(ws, id, 'Settings');
  const pkg = parseJsonCell(values.setup_package);
  if (!pkg) return { pkg: null, settings: values };
  const v = validatePackage(pkg, SCHEMA);
  if (!v.ok) throw new ImportError(tr('The saved setup package is no longer valid: {0}. Re-import a valid package from Settings.', v.errors.slice(0, 3).join('; ')), { code: 'invalid_package' });
  return { pkg, settings: values, warnings: v.warnings };
}

export async function loadBindings(ws, id, pkg) {
  const { rows } = await readTable(ws, id, 'Sources');
  const bound = new Map(rows.map(r => [String(r.source_id), r]));
  const sources = [];
  for (const s of pkg.sources) {
    const b = bound.get(s.source_id);
    sources.push({ ...s, spreadsheet_id: String(b?.spreadsheet_id || s.spreadsheet_id || ''), label: b?.label || s.label || s.source_id, refresh: b?.refresh || s.refresh || 'scheduled' });
  }
  return sources;
}

export function contentHash(records, reportingDate, configuration = null) {
  return createHash('sha256').update(JSON.stringify({ records, reportingDate, configuration })).digest('hex');
}

export async function readSources({ sourcesClient, ws, workspaceId, pkg, sources, settings }) {
  const sheets = {};
  const errors = [];
  const coverage = [];
  for (const s of sources) {
    const tables = pkg.tables.filter(t => t.source_id === s.source_id);
    if (s.kind === 'manual_package') {
      for (const t of tables) {
        const rows = parseJsonCell(settings[`manual_rows.${t.table_id}`], null);
        if (!rows) errors.push(tr('Table "{0}" belongs to manual source "{1}" but no reviewed rows were imported for it. Import the setup package that contains the records.', t.table_id, s.source_id));
        else sheets[t.table_id] = rows;
      }
      coverage.push({ source_id: s.source_id, label: s.label, kind: s.kind, ...parseJsonCell(settings[`source_meta.${s.source_id}`], {}), tables: tables.map(t => t.table_id) });
      continue;
    }
    if (!s.spreadsheet_id) {
      errors.push(tr('Source "{0}" ({1}) is not connected to a Google Sheet yet. Open Data connections and paste the Sheet link.', s.label, s.source_id));
      continue;
    }
    const ranges = tables.map(t => quoteSheet(t.sheet_name));
    try {
      const vrs = await sourcesClient.batchGet(s.spreadsheet_id, ranges);
      tables.forEach((t, i) => { sheets[t.table_id] = vrs[i]?.values || []; });
      coverage.push({ source_id: s.source_id, label: s.label, kind: s.kind, read_at: new Date().toISOString(), tables: tables.map(t => t.table_id) });
    } catch (e) {
      const why = e.status === 403 ? tr('The service account cannot read "{0}". Share that Sheet with the service-account email as Viewer.', s.label)
        : e.status === 404 ? tr('"{0}" was not found. Check the Sheet link in Data connections.', s.label)
        : e.status === 400 ? tr('A worksheet named in the mapping was not found in "{0}" (expected: {1}).', s.label, tables.map(t => t.sheet_name).join(', '))
        : tr('Could not read "{0}": {1}', s.label, e.message);
      errors.push(why);
    }
  }
  return { sheets, errors, coverage };
}

export function mapSources(pkg, sheets) {
  const records = {};
  let issues = [];
  for (const t of pkg.tables) {
    const r = applyTableMapping(t, sheets[t.table_id] || [], pkg);
    records[t.entity] = r.records;
    issues = issues.concat(r.issues);
  }
  issues = issues.concat(relationalChecks(records));
  for (const [entity, rows] of Object.entries(records)) {
    if (rows.length > LIMITS.records_per_table) issues.push({ level: 'error', code: 'too_many_rows', message: tr('{0} has {1} rows; this release supports up to {2} per table.', entity, rows.length, LIMITS.records_per_table) });
  }
  return { records, issues };
}

export async function runImport({ credentials, workspaceId, fetchFn, now = Date.now, runId = `run_${Date.now()}`, log = () => {}, actor = 'worker', forceWrite = false }) {
  const { workspace: ws, sources: sourcesClient, email } = makeClients(credentials, { fetchFn });
  const startedAt = new Date(now()).toISOString();
  const state = await inspectWorkspace(ws, workspaceId).catch(e => { throw new ImportError(tr('Cannot open the Dashboard Workspace: {0} (share it with {1} as Editor).', e.message, email), { code: 'workspace_unreadable' }); });
  if (!state.isWorkspace) throw new ImportError(tr('DASHBOARD_WORKSPACE_ID does not point at a Dashboard Workspace created by the dashboard. Copy the ID shown in Data connections.'), { code: 'not_workspace' });
  if (state.missing.length) await ensureWorkspace(ws, workspaceId, { appVersion: APP_VERSION, actor });
  await acquireLease(ws, workspaceId, runId, now);
  const finish = async (status, message, extra = {}) => {
    await appendRows(ws, workspaceId, 'Sync_Log', [{ run_id: runId, job: 'import', started_at: startedAt, finished_at: new Date(now()).toISOString(), status, message, snapshot_id: extra.snapshot_id || '', details_json: extra.details || {} }]);
    await trimTable(ws, workspaceId, 'Sync_Log', LIMITS.sync_log_kept).catch(() => {});
    await writeKeyValues(ws, workspaceId, '_Workspace', { last_import_status: status, last_import_message: message, last_import_at: new Date(now()).toISOString() }, { timestamp: false });
    await releaseLease(ws, workspaceId);
    log(`${status}: ${message}`);
    return { status, message, ...extra };
  };
  try {
    const { pkg, settings } = await loadSetup(ws, workspaceId);
    if (pkg) useWorkerLocale(pkg.business?.locale);
    if (!pkg) return finish('no_setup', tr('No business setup yet. Open Settings > Business setup, prepare and review a source, then activate it.'));
    const sources = await loadBindings(ws, workspaceId, pkg);
    const read = await readSources({ sourcesClient, ws, workspaceId, pkg, sources, settings });
    if (read.errors.length) return finish('failed', tr('Source read failed; the last good data is kept. {0}', read.errors.join(' ')), { details: { errors: read.errors } });
    const { records, issues } = mapSources(pkg, sheets(read));
    const errors = issues.filter(i => i.level === 'error');
    const warnings = issues.filter(i => i.level === 'warning');
    if (errors.length) {
      return finish('failed', tr('Validation failed ({0} problem{1}); the last good data is kept. First: {2}', errors.length, errors.length === 1 ? '' : 's', errors[0].message), { details: { errors: errors.slice(0, 50).map(e => e.message), warnings: warnings.slice(0, 50).map(w => w.message) } });
    }
    let reporting;
    try { reporting = resolveReportingDate(pkg, records, todayIso(pkg.business.timezone, new Date(now()))); }
    catch (e) { return finish('failed', e.message); }
    const coverage = { ...sourceCoverage(records), sources: read.coverage };
    const sourceMetadata = Object.fromEntries(Object.entries(settings).filter(([k]) => k.startsWith('source_meta.')));
    const hash = contentHash(records, reporting.date, { pkg, sourceMetadata });
    const snapshotId = `snap_${new Date(now()).toISOString().replace(/[-:]/g, '').slice(0, 15)}_${hash.slice(0, 8)}`;
    const { values: wsMeta } = await readKeyValues(ws, workspaceId, '_Workspace');
    if (!forceWrite && wsMeta.current_content_hash === hash && wsMeta.current_snapshot_id && wsMeta.last_import_status !== 'writing' && wsMeta.snapshot_incomplete !== 'TRUE') {
      await writeKeyValues(ws, workspaceId, 'Metrics', { coverage }, { timestamp: false });
      await writeKeyValues(ws, workspaceId, '_Workspace', { last_successful_import_at: new Date(now()).toISOString(), last_read_at: new Date(now()).toISOString() }, { timestamp: false });
      return finish('unchanged', tr('Source data unchanged since snapshot {0}; nothing rewritten.', wsMeta.current_snapshot_id), { snapshot_id: wsMeta.current_snapshot_id, details: { warnings: warnings.map(w => w.message) } });
    }
    const metrics = computeMetrics(records, reporting.date, { periodStart: monthStart(reporting.date), periodEnd: reporting.date, historyStart: pkg.period?.history_start });
    const suggestions = generateSuggestions(records, metrics, reporting.date, pkg.policies, pkg.business.currency_symbol || pkg.business.currency);
    const previous = (await readTable(ws, workspaceId, 'Tasks_Suggested')).rows.map(r => ({ ...r, active: String(r.active) === 'TRUE' || r.active === true }));
    const reconciled = reconcileSuggestions(previous, suggestions, snapshotId);
    if (reconciled.length > LIMITS.tasks) return finish('failed', tr('{0} task suggestions exceed the {1} limit. Disable a rule or reduce the source.', reconciled.length, LIMITS.tasks));
    // --- write phase (all validation done) ---
    await writeKeyValues(ws, workspaceId, '_Workspace', { last_import_status: 'writing', snapshot_incomplete: 'TRUE' }, { timestamp: false });
    for (const entity of ['customers', 'sales', 'payments', 'stock']) {
      await replaceTable(ws, workspaceId, `Data_${entity}`, (records[entity] || []).map(r => toStoredRow(entity, r)));
    }
    const summary = metricsSummary(metrics);
    await writeKeyValues(ws, workspaceId, 'Metrics', { snapshot_id: snapshotId, reporting_date: reporting.date, reporting_basis: reporting.basis, generated_at: new Date(now()).toISOString(), metrics_version: METRICS_VERSION, tasks_version: TASKS_VERSION, summary, coverage, warnings: warnings.map(w => w.message) }, { timestamp: false });
    await replaceTable(ws, workspaceId, 'Tasks_Suggested', reconciled.map(t => ({ ...t, evidence_json: t.evidence || {}, active: t.active ? 'TRUE' : 'FALSE' })));
    await appendRows(ws, workspaceId, 'Snapshots', [{ snapshot_id: snapshotId, taken_at: new Date(now()).toISOString(), reporting_date: reporting.date, reporting_basis: reporting.basis, coverage_json: { ...coverage, sources: read.coverage }, row_counts_json: Object.fromEntries(Object.entries(records).map(([k, v]) => [k, v.length])), content_hash: hash, status: 'current', message: tr('{0} warning(s)', warnings.length) }]);
    await trimTable(ws, workspaceId, 'Snapshots', LIMITS.snapshots_kept).catch(() => {});
    await writeKeyValues(ws, workspaceId, '_Workspace', { current_snapshot_id: snapshotId, current_content_hash: hash, current_reporting_date: reporting.date, last_successful_import_at: new Date(now()).toISOString(), last_read_at: new Date(now()).toISOString(), app_version: APP_VERSION, snapshot_incomplete: 'FALSE' }, { timestamp: false });
    return finish('success', tr('Imported {0}; reporting date {1} ({2}); {3} suggestions ({4} warnings).', Object.entries(records).map(([k, v]) => `${v.length} ${k}`).join(', '), reporting.date, reporting.basis, suggestions.length, warnings.length), { snapshot_id: snapshotId, details: { warnings: warnings.slice(0, 50).map(w => w.message), counts: metrics.counts }, metrics: summary });
  } catch (e) {
    if (e instanceof ImportError && e.code === 'busy') throw e;
    const { values: current } = await readKeyValues(ws, workspaceId, '_Workspace');
    if (current.last_import_status === 'writing') return finish('writing', tr('The snapshot write was interrupted. Do not use these figures yet; rerun Import data to rebuild the snapshot.'));
    return finish('failed', tr('Import failed before publishing new data. {0}', e.message));
  }
}

const sheets = read => read.sheets;

export function metricsSummary(m) {
  const { balances, stock, ...rest } = m;
  return { ...rest, balances_count: balances.length, stock_count: stock.length, low_stock: stock.filter(s => s.low).map(s => ({ id: s.id, name: s.name, available: s.available, reorder_threshold: s.reorder_threshold, unreserved_pending: s.unreserved_pending })) };
}
