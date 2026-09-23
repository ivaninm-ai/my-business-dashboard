// A genuinely different layout (service business, text dates, money text, no stock)
// handled by mapping alone; plus backup/restore and template-update safety.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCsv } from './helpers/csv.mjs';
import { startFakeEnv } from './helpers/fake-env.mjs';
import { applyTableMapping, relationalChecks, hasErrors } from '../app/shared/mapping.mjs';
import { computeMetrics } from '../app/shared/metrics.mjs';
import { generateSuggestions } from '../app/shared/tasks.mjs';
import { validatePackage, effectiveModules } from '../app/shared/package.mjs';
import { ensureWorkspace, writeKeyValues, upsertRows, readTable, readKeyValues, inspectWorkspace } from '../app/shared/workspace.mjs';
import { runImport } from '../worker/importer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const schema = JSON.parse(readFileSync(path.join(root, 'app/shared/setup-package.schema.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(path.join(root, 'config/examples/demo-physio-studio.setup-package.json'), 'utf8'));
const fixture = name => readCsv(path.join(here, 'fixtures/alt-service-studio', `${name}.csv`)); // text cells only, like a pasted sheet
const cents = n => Math.round(n * 100);

test('service layout: package validates and stock module is hidden', () => {
  const v = validatePackage(pkg, schema);
  assert.deepEqual(v.errors, []);
  const m = effectiveModules(pkg);
  assert.equal(m.stock, false);
  assert.equal(m.sales, true);
});

test('service layout: text dates and money map correctly and hand-checked totals reconcile', () => {
  const sheets = { Clients: fixture('Clients'), Bookings: fixture('Bookings'), Receipts: fixture('Receipts') };
  const records = {};
  let issues = [];
  for (const t of pkg.tables) { const r = applyTableMapping(t, sheets[t.sheet_name], pkg); records[t.entity] = r.records; issues = issues.concat(r.issues); }
  issues = issues.concat(relationalChecks(records));
  assert.equal(hasErrors(issues), false, JSON.stringify(issues));
  assert.equal(records.sales.find(s => s.id === 'B-1003').amount, cents(1200), '"RM 1,200.00" parsed');
  assert.equal(records.sales.find(s => s.id === 'B-1003').date, '2026-08-12', 'dd/mm/yyyy parsed');
  assert.equal(records.customers.every(c => c.type === 'customer'), true, 'constant field applied');
  assert.equal(records.sales.find(s => s.id === 'B-1006').status, 'excluded');
  const m = computeMetrics(records, '2026-08-30', { periodStart: '2026-08-01', periodEnd: '2026-08-30', historyStart: '2026-06-01' });
  assert.equal(m.period_order_value, cents(1910));
  assert.equal(m.period_order_count, 6);
  assert.equal(m.period_cash_collected, cents(990));
  assert.equal(m.all_time_cash_collected, cents(1190));
  assert.equal(m.outstanding_balance, cents(920));
  assert.equal(m.overdue_balance, cents(800));
  assert.deepEqual(m.overdue_completion_ids, ['B-1005']);
  assert.deepEqual(m.due_today_completion_ids, []);
  assert.deepEqual(m.overdue_follow_up_ids, ['C-03']);
  assert.deepEqual(m.follow_up_today_ids, ['C-04']);
  assert.deepEqual(m.unassigned_prospect_ids, []);
  assert.equal(m.stock.length, 0);
  const tasks = generateSuggestions(records, m, '2026-08-30', pkg.policies, 'RM');
  const keys = tasks.map(t => t.task_key);
  assert.ok(keys.includes('payment_follow_up:B-1003'));
  assert.ok(keys.includes('completion_overdue:B-1005'));
  assert.ok(keys.includes('completion_due_soon:B-1007'), 'appointment on 31/08 within 2 days');
  assert.ok(!keys.some(k => k.startsWith('review_replenishment')), 'no stock rules without stock');
  const due = tasks.find(t => t.task_key === 'completion_due_soon:B-1007');
  assert.equal(due.recorded_deadline, '2026-08-31');
  assert.equal(due.suggested_date, '2026-08-30', 'prepare the day before, not before the reporting date');
});

test('service layout: bad text date and unknown status produce row-level messages', () => {
  const bookings = fixture('Bookings');
  bookings[3][2] = '31/02/2026';      // impossible date
  bookings[5][5] = 'Rescheduled';     // unknown status
  const r = applyTableMapping(pkg.tables[1], bookings, pkg);
  assert.ok(r.issues.some(i => i.code === 'bad_date' && i.row === 4));
  assert.ok(r.issues.some(i => i.code === 'unknown_status' && /Rescheduled/.test(i.message) && i.row === 6));
});

test('backup/restore: user-owned tabs restored into a fresh workspace; template update keeps state', async () => {
  const env = await startFakeEnv();
  try {
    const ws = await env.createWorkspace();
    const src = await env.createSourceFromFixture('b2c', 'day1');
    await env.importPackage(ws, env.loadPackage('b2c'));
    await env.bindSource(ws, 'main', src, 'B2C');
    const r = await runImport({ credentials: env.credentials, workspaceId: ws, runId: 'bk1' });
    assert.equal(r.status, 'success');
    await env.saveDecision(ws, { task_key: 'completion_overdue:RS-001', status: 'completed', note: 'Delivered late, customer informed', snapshot_at_decision: r.snapshot_id });
    await upsertRows(env.browser, ws, 'Calendar', 'entry_id', [{ entry_id: 'cal_1', date: '2026-09-01', title: 'Stock count', detail: '', kind: 'note', related_task_key: '', created_at: 'x', updated_at: 'x', deleted: 'FALSE' }]);
    // Export (what the browser's Export backup produces).
    const backup = { backup_version: '1.0', settings: (await readKeyValues(env.browser, ws, 'Settings')).values, sources: (await readTable(env.browser, ws, 'Sources')).rows, task_decisions: (await readTable(env.browser, ws, 'Task_Decisions')).rows, calendar: (await readTable(env.browser, ws, 'Calendar')).rows, ai_requests: [] };
    // Fresh workspace + restore.
    const ws2 = await env.createWorkspace();
    const settings = { ...backup.settings }; settings.setup_package = JSON.parse(settings.setup_package);
    await writeKeyValues(env.browser, ws2, 'Settings', settings);
    await upsertRows(env.browser, ws2, 'Sources', 'source_id', backup.sources);
    await upsertRows(env.browser, ws2, 'Task_Decisions', 'task_key', backup.task_decisions);
    await upsertRows(env.browser, ws2, 'Calendar', 'entry_id', backup.calendar);
    const r2 = await runImport({ credentials: env.credentials, workspaceId: ws2, runId: 'bk2' });
    assert.equal(r2.status, 'success', r2.message);
    const dec = await env.read(ws2, 'Task_Decisions');
    assert.equal(dec.length, 1); assert.equal(dec[0].note, 'Delivered late, customer informed');
    assert.equal((await env.read(ws2, 'Calendar')).length, 1);
    assert.equal((await env.read(ws2, 'Data_sales')).length, 320);
    // Template update: ensureWorkspace on an existing workspace must not clear anything.
    const before = await env.dump(ws2);
    await ensureWorkspace(env.browser, ws2, { appVersion: '9.9.9', actor: 'update' });
    const after = await env.dump(ws2);
    assert.deepEqual(after.sheets.map(s => [s.title, s.values.length]), before.sheets.map(s => [s.title, s.values.length]));
    assert.equal((await inspectWorkspace(env.browser, ws2)).isWorkspace, true);
  } finally { await env.close(); }
});
