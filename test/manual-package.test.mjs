// Offline import: a manual_package source with reviewed records (e.g. from a PDF or a
// local Excel file) goes through the same mapping and validation as a live sheet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeEnv } from './helpers/fake-env.mjs';
import { runImport } from '../worker/importer.mjs';
import { manualRowsFromPackage, validatePackage } from '../app/shared/package.mjs';
import { SCHEMA } from '../worker/importer.mjs';
import { writeKeyValues } from '../app/shared/workspace.mjs';

function manualPackage() {
  return {
    package_version: '1.0', package_id: 'manual-example-001', generated_at: '2026-09-22T10:00:00+08:00',
    confirmation: { state: 'confirmed', open_questions: [] },
    business: { name: 'Demo Tutoring Centre', model: 'service', timezone: 'Asia/Kuala_Lumpur', currency: 'MYR', currency_symbol: 'RM', synthetic: true },
    reporting_date: { mode: 'fixed', value: '2026-08-30' },
    modules: { overview: true, sales: true, payments: true, customers: false, stock: false, tasks: true, calendar: true, ai: false },
    sources: [{ source_id: 'pdf', kind: 'manual_package', label: 'August invoices (PDF, reviewed)', refresh: 'manual' }],
    tables: [
      { table_id: 'invoices', entity: 'sales', source_id: 'pdf', header_row: 1, row_meaning: 'One row is one invoice', identity: { mode: 'source_id', field: 'Invoice' }, load: { mode: 'replace' },
        fields: [{ canonical: 'id', header: 'Invoice' }, { canonical: 'date', header: 'Date' }, { canonical: 'amount', header: 'Amount' }, { canonical: 'status', header: 'Status' }, { canonical: 'payment_due_date', header: 'Due' }, { canonical: 'description', header: 'Student' }] },
      { table_id: 'receipts', entity: 'payments', source_id: 'pdf', header_row: 1, row_meaning: 'One row is one receipt', identity: { mode: 'source_id', field: 'Receipt' }, load: { mode: 'replace' },
        fields: [{ canonical: 'id', header: 'Receipt' }, { canonical: 'sale_id', header: 'Invoice' }, { canonical: 'date', header: 'Paid' }, { canonical: 'amount', header: 'Amount' }] },
    ],
    status_map: { pending: [], done: ['Issued'], excluded: ['Void'] },
    policies: { dates: { order: 'dmy' }, money: { unit: 'major' }, tasks: [{ rule: 'payment_follow_up', enabled: true, params: { offset_days: 2 } }] },
    provenance: { samples: [{ file: 'invoices-aug.pdf', type: 'pdf', pages: '1-3' }], notes: ['Values reviewed by the owner on 22 Sep 2026; INV-3 flagged unverified on page 2 and confirmed.'] },
    records: {
      sales: [
        { id: 'INV-1', date: '2026-08-02', amount: 300, status: 'Issued', payment_due_date: '2026-08-16', description: 'A. Lim' },
        { id: 'INV-2', date: '2026-08-10', amount: 450, status: 'Issued', payment_due_date: '2026-08-24', description: 'B. Tan' },
        { id: 'INV-3', date: '2026-08-20', amount: 300, status: 'Void', payment_due_date: '2026-09-03', description: 'C. Wong' },
      ],
      payments: [{ id: 'RC-1', sale_id: 'INV-1', date: '2026-08-05', amount: 300 }],
    },
  };
}

test('manual package: reviewed records import through the same validation; no live source needed', async () => {
  const env = await startFakeEnv();
  try {
    const pkg = manualPackage();
    const v = validatePackage(pkg, SCHEMA);
    assert.deepEqual(v.errors, []);
    const ws = await env.createWorkspace();
    await writeKeyValues(env.browser, ws, 'Settings', { setup_package: pkg, ...manualRowsFromPackage(pkg) });
    const r = await runImport({ credentials: env.credentials, workspaceId: ws, runId: 'man1' });
    assert.equal(r.status, 'success', r.message);
    assert.equal(r.metrics.period_order_value, 75000, 'void invoice excluded');
    assert.equal(r.metrics.outstanding_balance, 45000);
    assert.equal(r.metrics.overdue_balance, 45000, 'INV-2 due 24 Aug < 30 Aug');
    const tasks = await env.read(ws, 'Tasks_Suggested');
    assert.ok(tasks.some(t => t.task_key === 'payment_follow_up:INV-2'));
    // A live-source package must not carry records.
    const bad = { ...pkg, sources: [{ source_id: 'pdf', kind: 'google_sheet', label: 'x' }] };
    bad.tables = bad.tables.map(t => ({ ...t, sheet_name: 'S' }));
    assert.ok(validatePackage(bad, SCHEMA).errors.some(e => /only accepted for a manual_package source/.test(e)));
  } finally { await env.close(); }
});
