// End-to-end worker behaviour against the fake Google server: access boundaries,
// mapped import, refresh, duplicate import, partial failure, permission removal,
// decisions surviving refresh, install check and template-update safety.
// Simulated Google; not a live account check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeEnv, SA_EMAIL } from './helpers/fake-env.mjs';
import { runImport } from '../worker/importer.mjs';
import { runInstallCheck } from '../worker/install-check.mjs';
import { mergeTasks } from '../app/shared/tasks.mjs';
import { inspectWorkspace, ensureWorkspace, TAB_NAMES, readKeyValues, parseJsonCell } from '../app/shared/workspace.mjs';

let env;
test.before(async () => { env = await startFakeEnv(); });
test.after(async () => { await env.close(); });

const cents = n => Math.round(n * 100);

test('access: the worker cannot read a source that was not shared, and a stranger cannot open the workspace', async () => {
  const ws = await env.createWorkspace();
  const src = await env.createSourceFromFixture('b2b', 'day1', { shareWithWorker: false });
  await env.importPackage(ws, env.loadPackage('b2b'));
  await env.bindSource(ws, 'main', src);
  const r = await runImport({ credentials: env.credentials, workspaceId: ws, runId: 'r-denied' });
  assert.equal(r.status, 'failed');
  assert.match(r.message, /Share that Sheet with the service-account email as Viewer/);
  await assert.rejects(env.stranger.getSpreadsheet(ws), /HTTP 403/);
  const meta = await env.meta(ws);
  assert.equal(meta.current_snapshot_id, '', 'no snapshot was written');
  assert.equal(meta.lease_holder, '', 'lease released after failure');
});

test('access: read-only scope cannot write, even when the sheet is shared as writer', async () => {
  const { createSheetsClient } = await import('../app/shared/sheets.mjs');
  const { tokenProvider } = await import('../worker/google-auth.mjs');
  const src = await env.createSourceFromFixture('b2b', 'day1');
  await env.admin('share', { id: src, principal: SA_EMAIL, role: 'writer' });
  const ro = createSheetsClient({ apiBase: env.base, getToken: tokenProvider(env.credentials, 'readonly') });
  await assert.rejects(ro.update(src, 'Stock!B2', [['x']]), /HTTP 403/);
});

test('first complete path: import, decide, refresh with changed source, decision preserved, no duplicates', async () => {
  const ws = await env.createWorkspace();
  const src = await env.createSourceFromFixture('b2b', 'day1');
  await env.importPackage(ws, env.loadPackage('b2b'));
  await env.bindSource(ws, 'main', src, 'BetterSpace B2B');

  const r1 = await runImport({ credentials: env.credentials, workspaceId: ws, runId: 'r1' });
  assert.equal(r1.status, 'success', r1.message);
  assert.equal(r1.metrics.reporting_date, '2026-08-30');
  assert.equal(r1.metrics.outstanding_balance, cents(91090));
  assert.equal(r1.metrics.overdue_balance, cents(30515));
  const sales = await env.read(ws, 'Data_sales');
  assert.equal(sales.length, 90);
  assert.equal(typeof sales[0].amount, 'number');
  assert.equal(sales.find(s => s.id === 'BS-001').date, '2026-08-20', 'dates stored as ISO calendar strings');
  const suggested1 = await env.read(ws, 'Tasks_Suggested');
  const keys1 = suggested1.map(t => t.task_key);
  assert.equal(new Set(keys1).size, keys1.length);
  assert.ok(keys1.includes('payment_follow_up:BS-001'));
  assert.ok(keys1.includes('review_replenishment:T001'));

  // Owner decides: complete BS-001 follow-up, dismiss BC-006 review, accept + edit T001.
  await env.saveDecision(ws, { task_key: 'payment_follow_up:BS-001', status: 'completed', note: 'Called Mei; payment promised', snapshot_at_decision: r1.snapshot_id });
  await env.saveDecision(ws, { task_key: 'review_account:BC-006', status: 'dismissed', snapshot_at_decision: r1.snapshot_id });
  await env.saveDecision(ws, { task_key: 'review_replenishment:T001', status: 'accepted', action_date: '2026-08-31', owner: 'Amir', note: 'Check supplier', snapshot_at_decision: r1.snapshot_id });

  // Same source again: nothing changes, nothing rewritten, no duplicates.
  const r2 = await runImport({ credentials: env.credentials, workspaceId: ws, runId: 'r2' });
  assert.equal(r2.status, 'unchanged');
  assert.equal((await env.read(ws, 'Tasks_Suggested')).length, suggested1.length);

  // Day 2 replaces Day 1 in the source (full-snapshot replacement, not append).
  await env.replaceSourceFromFixture(src, 'b2b', 'day2');
  const r3 = await runImport({ credentials: env.credentials, workspaceId: ws, runId: 'r3' });
  assert.equal(r3.status, 'success', r3.message);
  assert.equal(r3.metrics.reporting_date, '2026-08-31');
  assert.equal(r3.metrics.outstanding_balance, cents(86590));
  assert.equal(r3.metrics.overdue_balance, cents(26015));
  assert.equal((await env.read(ws, 'Data_sales')).length, 90, 'replacement, not append');
  assert.equal((await env.read(ws, 'Data_customers')).length, 46);
  assert.equal((await env.read(ws, 'Data_payments')).length, 147);

  const suggested3 = (await env.read(ws, 'Tasks_Suggested')).map(t => ({ ...t, active: t.active === 'TRUE', evidence: parseJsonCell(t.evidence_json, {}) }));
  const keys3 = suggested3.map(t => t.task_key);
  assert.equal(new Set(keys3).size, keys3.length, 'no duplicate task keys after refresh');
  const bs001 = suggested3.find(t => t.task_key === 'payment_follow_up:BS-001');
  assert.equal(bs001.active, false, 'BS-001 balance is now 0: suggestion resolved by data');
  assert.equal(bs001.resolved_snapshot, r3.snapshot_id);
  assert.equal(bs001.first_snapshot, r1.snapshot_id, 'first-seen snapshot kept');
  assert.ok(keys3.includes('completion_overdue:BS-003'), 'BS-003 became overdue on Day 2');
  assert.ok(keys3.includes('unassigned_prospect:BC-046'), 'new unassigned prospect on Day 2');
  assert.ok(keys3.includes('follow_up_due:BC-046'));
  const bc036 = suggested3.find(t => t.task_key === 'follow_up_due:BC-036');
  assert.equal(bc036.recorded_deadline, '2026-09-04', 'recorded deadline updated from source');

  const decisions = await env.read(ws, 'Task_Decisions');
  const merged = mergeTasks(suggested3, decisions);
  const m1 = merged.find(t => t.task_key === 'payment_follow_up:BS-001');
  assert.equal(m1.status, 'completed'); assert.equal(m1.resolved, true); assert.equal(m1.note, 'Called Mei; payment promised');
  assert.equal(merged.find(t => t.task_key === 'review_account:BC-006').status, 'dismissed');
  const t001 = merged.find(t => t.task_key === 'review_replenishment:T001');
  assert.equal(t001.status, 'accepted'); assert.equal(t001.owner, 'Amir'); assert.equal(t001.action_date, '2026-08-31');
  assert.equal(t001.stale, true, 'decision made on an older snapshot is flagged stale');
  assert.equal(t001.recorded_deadline, '', 'no recorded deadline for stock');
  assert.equal(t001.suggested_date, '2026-08-31');
  // Completing a contact task did not change the sale: Day 1 balance was 4500 and it was the source that cleared it.
  const bs001Sale = (await env.read(ws, 'Data_sales')).find(s => s.id === 'BS-001');
  assert.equal(bs001Sale.amount, 9000);
  const log = await env.read(ws, 'Sync_Log');
  assert.deepEqual(log.map(l => l.status), ['success', 'unchanged', 'success']);
});

test('changed headers produce an actionable message and keep the last good snapshot', async () => {
  const ws = await env.createWorkspace();
  const src = await env.createSourceFromFixture('b2c', 'day1');
  await env.importPackage(ws, env.loadPackage('b2c'));
  await env.bindSource(ws, 'main', src);
  const r1 = await runImport({ credentials: env.credentials, workspaceId: ws, runId: 'h1' });
  assert.equal(r1.status, 'success');
  await env.admin('set-values', { id: src, range: 'Sales!I1', values: [['Total (RM)']] }); // rename total_amount
  const r2 = await runImport({ credentials: env.credentials, workspaceId: ws, runId: 'h2' });
  assert.equal(r2.status, 'failed');
  assert.match(r2.message, /Column "total_amount" \(used for sales\.amount\) was not found in "Sales"/);
  assert.match(r2.details.errors[0], /Headers found: .*"Total \(RM\)"/);
  assert.equal((await env.meta(ws)).current_snapshot_id, r1.snapshot_id, 'last good snapshot retained');
  assert.equal((await env.read(ws, 'Data_sales')).length, 320, 'data tabs untouched');
});

test('partial failure: one unreadable worksheet blocks the whole import', async () => {
  const ws = await env.createWorkspace();
  const src = await env.createSourceFromFixture('b2c', 'day1', { sheetNames: { Stock: 'Inventory' } });
  await env.importPackage(ws, env.loadPackage('b2c'));
  await env.bindSource(ws, 'main', src);
  const r = await runImport({ credentials: env.credentials, workspaceId: ws, runId: 'p1' });
  assert.equal(r.status, 'failed');
  assert.match(r.message, /worksheet named in the mapping was not found/);
  assert.equal((await env.read(ws, 'Data_sales')).length, 0, 'nothing partially written');
});

test('source IDs: missing and colliding identifiers are rejected before any write', async () => {
  const ws = await env.createWorkspace();
  const src = await env.createSourceFromFixture('b2c', 'day1');
  await env.importPackage(ws, env.loadPackage('b2c'));
  await env.bindSource(ws, 'main', src);
  await env.admin('set-values', { id: src, range: 'Sales!A3', values: [['RS-001']] }); // duplicate of row 2
  await env.admin('set-values', { id: src, range: 'Payments!A5', values: [['']] });   // blank id
  const r = await runImport({ credentials: env.credentials, workspaceId: ws, runId: 'id1' });
  assert.equal(r.status, 'failed');
  assert.ok(r.details.errors.some(e => /identifier "RS-001" appears on rows 2 and 3/.test(e)), r.details.errors.join('\n'));
  assert.ok(r.details.errors.some(e => /required field payments\.id is blank/.test(e)));
  assert.equal((await env.read(ws, 'Data_sales')).length, 0);
});

test('read permission removed after a good import keeps the last good data and reports stale', async () => {
  const ws = await env.createWorkspace();
  const src = await env.createSourceFromFixture('b2b', 'day1');
  await env.importPackage(ws, env.loadPackage('b2b'));
  await env.bindSource(ws, 'main', src);
  const r1 = await runImport({ credentials: env.credentials, workspaceId: ws, runId: 'perm1' });
  assert.equal(r1.status, 'success');
  await env.admin('share', { id: src, principal: SA_EMAIL, role: null });
  const r2 = await runImport({ credentials: env.credentials, workspaceId: ws, runId: 'perm2' });
  assert.equal(r2.status, 'failed');
  assert.match(r2.message, /Viewer/);
  const meta = await env.meta(ws);
  assert.equal(meta.current_snapshot_id, r1.snapshot_id);
  assert.equal(meta.last_import_status, 'failed');
  assert.equal((await env.read(ws, 'Data_payments')).length, 146);
});

test('two header layouts: renamed columns with a matching mapping give identical totals', async () => {
  const rename = { sale_id: 'Order No', customer_id: 'Client', sale_date: 'Booked on', total_amount: 'Value (RM)', status: 'Stage', payment_due_date: 'Pay by', promised_completion_date: 'Deliver by', payment_id: 'Receipt', payment_date: 'Received', amount: 'Amt', item_id: 'SKU', on_hand_quantity: 'On hand', reserved_quantity: 'Held', reorder_threshold: 'Min level', customer_name: 'Client name', customer_type: 'Kind' };
  const pkg = env.loadPackage('b2b');
  for (const t of pkg.tables) for (const f of t.fields) if (rename[f.header]) f.header = rename[f.header];
  const ws = await env.createWorkspace();
  const src = await env.createSourceFromFixture('b2b', 'day1', { renameHeaders: rename });
  await env.importPackage(ws, pkg);
  await env.bindSource(ws, 'main', src);
  const r = await runImport({ credentials: env.credentials, workspaceId: ws, runId: 'alt1' });
  assert.equal(r.status, 'success', r.message);
  assert.equal(r.metrics.all_time_order_value, cents(623640));
  assert.equal(r.metrics.overdue_balance, cents(30515));
  assert.deepEqual(r.metrics.low_stock_ids, ['T001', 'T003', 'T005']);
});

test('install check reports each step without printing data, and re-adds a deleted tab without clearing others', async () => {
  const ws = await env.createWorkspace();
  const src = await env.createSourceFromFixture('b2b', 'day1');
  await env.importPackage(ws, env.loadPackage('b2b'));
  await env.bindSource(ws, 'main', src, 'BetterSpace B2B');
  await runImport({ credentials: env.credentials, workspaceId: ws, runId: 'ic0' });
  await env.saveDecision(ws, { task_key: 'payment_follow_up:BS-012', status: 'accepted' });
  // Simulate a template update that introduces a tab: delete Calendar to emulate an older workspace.
  const info = await env.browser.getSpreadsheet(ws);
  const cal = info.sheets.find(s => s.title === 'Calendar');
  await env.browser.batchUpdate(ws, [{ deleteSheet: { sheetId: cal.sheetId } }]);
  const report = await runInstallCheck({ credentials: env.credentials, workspaceId: ws, runId: 'ic1', aiKeyPresent: true });
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter(c => !c.ok)));
  const noKey = await runInstallCheck({ credentials: env.credentials, workspaceId: ws, runId: 'ic_nokey', aiKeyPresent: false });
  assert.equal(noKey.ok, false, 'Business setup needs Gemini, so a missing key fails the check');
  assert.ok(noKey.checks.some(c => c.name === 'GEMINI_API_KEY secret present' && !c.ok));
  assert.ok(report.checks.some(c => c.name.startsWith('Missing tabs added') && c.detail === 'Calendar'));
  assert.ok(report.checks.some(c => c.name === 'Source "BetterSpace B2B" readable as Viewer' && c.ok));
  assert.equal((await env.read(ws, 'Task_Decisions')).length, 1, 'decisions preserved through the migration');
  assert.equal((await env.read(ws, 'Data_sales')).length, 90);
  const state = await inspectWorkspace(env.browser, ws);
  assert.deepEqual(state.missing, []);
  const serialised = JSON.stringify(report);
  assert.doesNotMatch(serialised, /ABC Workspace Demo/, 'no cell contents in the report');
});

test('workspace safety: a source workbook is never initialised as a workspace', async () => {
  const src = await env.createSourceFromFixture('b2c', 'day1');
  await env.admin('share', { id: src, principal: SA_EMAIL, role: 'writer' });
  await assert.rejects(ensureWorkspace(env.browser, src, { appVersion: 'test', actor: 'x' }), /not a Dashboard Workspace/);
  const r = await runImport({ credentials: env.credentials, workspaceId: src, runId: 'safe' }).catch(e => e);
  assert.match(r.message, /does not point at a Dashboard Workspace/);
  const dump = await env.dump(src);
  assert.deepEqual(dump.sheets.map(s => s.title), ['Customers', 'Sales', 'Payments', 'Stock'], 'source untouched');
});

test('concurrency: an active lease makes a second run wait instead of writing', async () => {
  const ws = await env.createWorkspace();
  const src = await env.createSourceFromFixture('b2c', 'day1');
  await env.importPackage(ws, env.loadPackage('b2c'));
  await env.bindSource(ws, 'main', src);
  const { writeKeyValues } = await import('../app/shared/workspace.mjs');
  await writeKeyValues(env.browser, ws, '_Workspace', { lease_holder: 'other-run', lease_expires: new Date(Date.now() + 60000).toISOString() }, { timestamp: false });
  await assert.rejects(runImport({ credentials: env.credentials, workspaceId: ws, runId: 'c2' }), /still in progress/);
  await writeKeyValues(env.browser, ws, '_Workspace', { lease_holder: 'other-run', lease_expires: new Date(Date.now() - 1000).toISOString() }, { timestamp: false });
  const r = await runImport({ credentials: env.credentials, workspaceId: ws, runId: 'c3' });
  assert.equal(r.status, 'success', 'expired lease is taken over');
});

test('setup package: an invalid package is rejected by the worker before touching data', async () => {
  const ws = await env.createWorkspace();
  const pkg = env.loadPackage('b2c');
  pkg.tables[1].fields = pkg.tables[1].fields.filter(f => f.canonical !== 'amount');
  await env.importPackage(ws, pkg);
  const r = await runImport({ credentials: env.credentials, workspaceId: ws, runId: 'bad' });
  assert.equal(r.status, 'failed');
  assert.match(r.message, /required field sales\.amount is not mapped/);
});

test('all workspace tabs exist after creation and _Workspace carries role/version metadata', async () => {
  const ws = await env.createWorkspace();
  const state = await inspectWorkspace(env.browser, ws);
  assert.equal(state.isWorkspace, true);
  assert.deepEqual(state.missing, []);
  assert.equal(state.titles.length, TAB_NAMES.length);
  const { values } = await readKeyValues(env.browser, ws, '_Workspace');
  assert.equal(values.role, 'dashboard-workspace');
  assert.equal(Number(values.schema_version), 1);
});
