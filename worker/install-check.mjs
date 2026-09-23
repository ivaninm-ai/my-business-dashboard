// Installer / connection check. Non-destructive: it verifies secrets, opens the
// workspace, adds any missing tabs (never clears existing ones), checks that the
// service account can read each bound source, and records a Sync_Log row. It
// prints a summary without any cell contents.

import { inspectWorkspace, ensureWorkspace, readTable, appendRows, readKeyValues } from '../app/shared/workspace.mjs';
import { makeClients, loadSetup, loadBindings, APP_VERSION } from './importer.mjs';

export async function runInstallCheck({ credentials, workspaceId, fetchFn, now = Date.now, runId = `check_${Date.now()}`, aiKeyPresent = false }) {
  const report = { checks: [], ok: true };
  const check = (name, ok, detail) => { report.checks.push({ name, ok, detail }); if (!ok) report.ok = false; };
  const { workspace: ws, sources, email } = makeClients(credentials, { fetchFn });
  check('Service-account key parsed', true, `${email}`);
  if (!workspaceId) { check('DASHBOARD_WORKSPACE_ID secret present', false, 'Add the workspace ID shown in the dashboard (Data connections) as a repository secret.'); return report; }
  check('DASHBOARD_WORKSPACE_ID secret present', true, `${workspaceId.slice(0, 6)}…${workspaceId.slice(-4)}`);
  let state;
  try { state = await inspectWorkspace(ws, workspaceId); }
  catch (e) { check('Workspace reachable with Editor access', false, `${e.message} Share the Dashboard Workspace with ${email} as Editor.`); return report; }
  if (!state.isWorkspace) { check('Workbook is a Dashboard Workspace', false, 'The ID does not point at a workspace created by the dashboard. Source workbooks are never initialised.'); return report; }
  check('Workbook is a Dashboard Workspace', true, `schema v${state.schemaVersion}, ${state.titles.length} tabs`);
  if (state.missing.length) {
    await ensureWorkspace(ws, workspaceId, { appVersion: APP_VERSION, actor: 'install-check' });
    check('Missing tabs added (existing data untouched)', true, state.missing.join(', '));
  } else check('All workspace tabs present', true, '');
  // Write test: Sync_Log append proves Editor access without touching data tabs.
  try {
    await appendRows(ws, workspaceId, 'Sync_Log', [{ run_id: runId, job: 'install-check', started_at: new Date(now()).toISOString(), finished_at: new Date(now()).toISOString(), status: 'success', message: 'Install check wrote this row.', snapshot_id: '', details_json: {} }]);
    check('Worker can write to the workspace', true, 'Sync_Log row appended');
  } catch (e) { check('Worker can write to the workspace', false, e.message); return report; }
  const { values: meta } = await readKeyValues(ws, workspaceId, '_Workspace');
  check('Current snapshot', true, meta.current_snapshot_id ? `${meta.current_snapshot_id} (reporting ${meta.current_reporting_date})` : 'none yet — run the import after connecting sources');
  let pkg = null;
  try { ({ pkg } = await loadSetup(ws, workspaceId)); check('Setup package', !!pkg, pkg ? `${pkg.business.name} (${pkg.tables.length} tables, ${pkg.confirmation.state})` : 'not configured yet — complete Settings > Business setup'); }
  catch (e) { check('Setup package', false, e.message); }
  if (pkg) {
    const bindings = await loadBindings(ws, workspaceId, pkg);
    for (const s of bindings) {
      if (s.kind !== 'google_sheet') { check(`Source "${s.label}"`, true, 'saved file records (replace them in Settings > Business setup)'); continue; }
      if (!s.spreadsheet_id) { check(`Source "${s.label}" connected`, false, 'Not connected: paste the Sheet link in Data connections.'); continue; }
      try {
        const info = await sources.getSpreadsheet(s.spreadsheet_id);
        const wanted = pkg.tables.filter(t => t.source_id === s.source_id).map(t => t.sheet_name);
        const have = new Set(info.sheets.map(x => x.title));
        const missing = wanted.filter(w => !have.has(w));
        check(`Source "${s.label}" readable as Viewer`, missing.length === 0, missing.length ? `Worksheets not found: ${missing.join(', ')} (found: ${[...have].join(', ')})` : `${wanted.length} worksheet(s) found`);
      } catch (e) {
        check(`Source "${s.label}" readable as Viewer`, false, e.status === 403 ? `Denied. Share this Sheet with ${email} as Viewer.` : e.message);
      }
    }
  }
  // Business setup prepares every source through Gemini, so the key is required.
  check('GEMINI_API_KEY secret present', aiKeyPresent, aiKeyPresent ? 'set — used by Business setup and the AI brief' : 'missing — create a key in Google AI Studio and add it under Secrets; Business setup cannot prepare sources without it');
  const dec = await readTable(ws, workspaceId, 'Task_Decisions');
  check('Existing task decisions preserved', true, `${dec.rows.length} decision row(s)`);
  return report;
}
