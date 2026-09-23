// Installer / connection check. Non-destructive: it verifies secrets, opens the
// workspace, adds any missing tabs (never clears existing ones), checks that the
// service account can read each bound source, and records a Sync_Log row. It
// prints a summary without any cell contents.

import { inspectWorkspace, ensureWorkspace, readTable, appendRows, readKeyValues } from '../app/shared/workspace.mjs';
import { makeClients, loadSetup, loadBindings, APP_VERSION } from './importer.mjs';
import { tr, tl } from '../app/shared/i18n.mjs';

export async function runInstallCheck({ credentials, workspaceId, fetchFn, now = Date.now, runId = `check_${Date.now()}`, aiKeyPresent = false }) {
  const report = { checks: [], ok: true };
  const check = (name, ok, detail) => { report.checks.push({ name, ok, detail }); if (!ok) report.ok = false; };
  const { workspace: ws, sources, email } = makeClients(credentials, { fetchFn });
  check(tl('Service-account key parsed'), true, `${email}`);
  if (!workspaceId) { check(tl('DASHBOARD_WORKSPACE_ID secret present'), false, tr('Add the workspace ID shown in the dashboard (Data connections) as a repository secret.')); return report; }
  check(tl('DASHBOARD_WORKSPACE_ID secret present'), true, `${workspaceId.slice(0, 6)}…${workspaceId.slice(-4)}`);
  let state;
  try { state = await inspectWorkspace(ws, workspaceId); }
  catch (e) { check(tl('Workspace reachable with Editor access'), false, tr('{0} Share the Dashboard Workspace with {1} as Editor.', e.message, email)); return report; }
  if (!state.isWorkspace) { check(tl('Workbook is a Dashboard Workspace'), false, tr('The ID does not point at a workspace created by the dashboard. Source workbooks are never initialised.')); return report; }
  check(tl('Workbook is a Dashboard Workspace'), true, tr('schema v{0}, {1} tabs', state.schemaVersion, state.titles.length));
  if (state.missing.length) {
    await ensureWorkspace(ws, workspaceId, { appVersion: APP_VERSION, actor: 'install-check' });
    check(tl('Missing tabs added (existing data untouched)'), true, state.missing.join(', '));
  } else check(tl('All workspace tabs present'), true, '');
  // Write test: Sync_Log append proves Editor access without touching data tabs.
  try {
    await appendRows(ws, workspaceId, 'Sync_Log', [{ run_id: runId, job: 'install-check', started_at: new Date(now()).toISOString(), finished_at: new Date(now()).toISOString(), status: 'success', message: tr('Install check wrote this row.'), snapshot_id: '', details_json: {} }]);
    check(tl('Worker can write to the workspace'), true, tr('Sync_Log row appended'));
  } catch (e) { check(tl('Worker can write to the workspace'), false, e.message); return report; }
  const { values: meta } = await readKeyValues(ws, workspaceId, '_Workspace');
  check(tl('Current snapshot'), true, meta.current_snapshot_id ? tr('{0} (reporting {1})', meta.current_snapshot_id, meta.current_reporting_date) : tr('none yet — run the import after connecting sources'));
  let pkg = null;
  try { ({ pkg } = await loadSetup(ws, workspaceId)); check(tl('Setup package'), !!pkg, pkg ? tr('{0} ({1} tables, {2})', pkg.business.name, pkg.tables.length, pkg.confirmation.state) : tr('not configured yet — complete Settings > Business setup')); }
  catch (e) { check(tl('Setup package'), false, e.message); }
  if (pkg) {
    const bindings = await loadBindings(ws, workspaceId, pkg);
    for (const s of bindings) {
      if (s.kind !== 'google_sheet') { check(tl('Source "{0}"', s.label), true, tr('saved file records (replace them in Settings > Business setup)')); continue; }
      if (!s.spreadsheet_id) { check(tl('Source "{0}" connected', s.label), false, tr('Not connected: paste the Sheet link in Data connections.')); continue; }
      try {
        const info = await sources.getSpreadsheet(s.spreadsheet_id);
        const wanted = pkg.tables.filter(t => t.source_id === s.source_id).map(t => t.sheet_name);
        const have = new Set(info.sheets.map(x => x.title));
        const missing = wanted.filter(w => !have.has(w));
        check(tl('Source "{0}" readable as Viewer', s.label), missing.length === 0, missing.length ? tr('Worksheets not found: {0} (found: {1})', missing.join(', '), [...have].join(', ')) : tr('{0} worksheet(s) found', wanted.length));
      } catch (e) {
        check(tl('Source "{0}" readable as Viewer', s.label), false, e.status === 403 ? tr('Denied. Share this Sheet with {0} as Viewer.', email) : e.message);
      }
    }
  }
  // Business setup prepares every source through Gemini, so the key is required.
  check(tl('GEMINI_API_KEY secret present'), aiKeyPresent, aiKeyPresent ? tr('set — used by Business setup and the AI brief') : tr('missing — create a key in Google AI Studio and add it under Secrets; Business setup cannot prepare sources without it'));
  const dec = await readTable(ws, workspaceId, 'Task_Decisions');
  check(tl('Existing task decisions preserved'), true, tr('{0} decision row(s)', dec.rows.length));
  return report;
}
