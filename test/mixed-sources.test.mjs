import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeEnv } from './helpers/fake-env.mjs';
import { runImport } from '../worker/importer.mjs';
import { runAi } from '../worker/ai.mjs';
import { manualRowsFromPackage } from '../app/shared/package.mjs';
import { prepareSourceUpdate, saveSourceUpdate } from '../app/shared/source-update.mjs';
import { writeKeyValues, readKeyValues, parseJsonCell, upsertRows, fromStoredRow } from '../app/shared/workspace.mjs';
import { buildCalendarItems } from '../app/shared/calendar.mjs';
import { mergeTasks } from '../app/shared/tasks.mjs';
import { computeMetrics } from '../app/shared/metrics.mjs';

async function setup() {
  const env = await startFakeEnv();
  const ws = await env.createWorkspace();
  const pkg = env.loadPackage('b2b');
  pkg.sources.push({ source_id: 'excel', kind: 'manual_package', label: 'Inventory Excel', refresh: 'manual' }, { source_id: 'pdf', kind: 'manual_package', label: 'Payment PDF', refresh: 'manual' });
  for (const t of pkg.tables) if (['stock', 'payments'].includes(t.entity)) t.source_id = t.entity === 'stock' ? 'excel' : 'pdf';
  const source = await env.createSourceFromFixture('b2b', 'day1');
  // Read synthetic fixture values once to stand in for Claude-reviewed file records.
  const initial = await runOriginalImport(env, pkg, source);
  pkg.records = { stock: initial.stock, payments: initial.payments };
  await writeKeyValues(env.browser, ws, 'Settings', { setup_package: pkg, ...manualRowsFromPackage(pkg) });
  await env.bindSource(ws, 'main', source);
  return { env, ws, pkg, source };
}

async function runOriginalImport(env, pkg, source) {
  const temp = await env.createWorkspace();
  await env.importPackage(temp, env.loadPackage('b2b'));
  await env.bindSource(temp, 'main', source);
  assert.equal((await runImport({ credentials: env.credentials, workspaceId: temp })).status, 'success');
  const result = {};
  for (const entity of ['stock', 'payments']) {
    const fields = new Set(pkg.tables.find(t => t.entity === entity).fields.map(f => f.canonical));
    result[entity] = (await env.read(temp, `Data_${entity}`)).map(row => Object.fromEntries(Object.entries(row).filter(([k, v]) => fields.has(k) && v !== '')));
  }
  return result;
}

const updateFor = (source, records, mode = 'replace') => ({ update_version: '1.0', source_id: source, mode, data_as_of: '2026-08-30', file_name: `${source}-new-file`, confirmed: true, records });

test('Sheets + PDF + Excel: replace only stock; preserve payments, live links, decisions and calendar; reject conflicting append', async () => {
  const { env, ws, pkg } = await setup();
  try {
    const first = await runImport({ credentials: env.credentials, workspaceId: ws });
    assert.equal(first.status, 'success', first.message);
    await env.saveDecision(ws, { task_key: 'review_replenishment:T001', status: 'accepted', action_date: '2026-08-31', owner: 'Amir', note: 'Call supplier', snapshot_at_decision: first.snapshot_id });
    await upsertRows(env.browser, ws, 'Calendar', 'entry_id', [{ entry_id: 'meeting', date: '2026-08-31', title: 'Supplier call', detail: 'Ask about delivery', deleted: 'FALSE' }]);
    const beforePayments = await env.read(ws, 'Data_payments');
    const beforeLinks = await env.read(ws, 'Sources');
    const stock = structuredClone(pkg.records.stock);
    stock.find(r => r.id === 'T001').on_hand = 999;
    const settings = (await readKeyValues(env.browser, ws, 'Settings')).values;
    const update = updateFor('excel', { stock });
    await saveSourceUpdate(env.browser, ws, pkg, update, { expectedSettings: settings });
    await assert.rejects(saveSourceUpdate(env.browser, ws, pkg, update, { expectedSettings: settings }), /changed since the preview/);
    const second = await runImport({ credentials: env.credentials, workspaceId: ws });
    assert.equal(second.status, 'success', second.message);
    assert.deepEqual(await env.read(ws, 'Data_payments'), beforePayments);
    assert.deepEqual(await env.read(ws, 'Sources'), beforeLinks);
    assert.equal((await env.read(ws, 'Calendar'))[0].title, 'Supplier call');
    assert.equal((await env.read(ws, 'Task_Decisions'))[0].note, 'Call supplier');
    assert.equal((await env.read(ws, 'Tasks_Suggested')).find(t => t.task_key === 'review_replenishment:T001').active, 'FALSE');
    const saved = (await readKeyValues(env.browser, ws, 'Settings')).values;
    const repeat = prepareSourceUpdate(pkg, saved, updateFor('excel', { stock }, 'append'));
    assert.equal(repeat.preview[0].skipped, stock.length);
    const conflict = structuredClone(stock); conflict[0].on_hand = 22;
    assert.throws(() => prepareSourceUpdate(pkg, saved, updateFor('excel', { stock: conflict }, 'append')), /already exists with different values/);
    assert.throws(() => prepareSourceUpdate(pkg, saved, updateFor('main', { stock })), /not a Google Sheet/);
    assert.throws(() => prepareSourceUpdate(pkg, saved, updateFor('excel', { stock, payments: [] })), /no tables from another source/);
    assert.throws(() => prepareSourceUpdate(pkg, saved, updateFor('excel', { stock: [stock[0], stock[0]] })), /duplicate|Duplicate/);
    const corrected = prepareSourceUpdate(pkg, saved, updateFor('excel', { stock: [conflict[0]] }, 'upsert'));
    assert.equal(corrected.preview[0].after, stock.length);
    // A source condition may return, but the student's note/owner stays attached once.
    await saveSourceUpdate(env.browser, ws, pkg, updateFor('excel', pkg.records.stock ? { stock: pkg.records.stock } : {}));
    assert.equal((await runImport({ credentials: env.credentials, workspaceId: ws })).status, 'success');
    const suggestions = (await env.read(ws, 'Tasks_Suggested')).map(r => ({ ...r, active: r.active === 'TRUE' }));
    const tasks = mergeTasks(suggestions, await env.read(ws, 'Task_Decisions'));
    assert.equal(tasks.find(t => t.task_key === 'review_replenishment:T001').owner, 'Amir');
    assert.equal(tasks.filter(t => t.task_key === 'review_replenishment:T001').length, 1);
  } finally { await env.close(); }
});

test('daily clock advances without new source rows; changed rules are recalculated; AI includes calendar, notes and mixed freshness', async () => {
  const { env, ws, pkg } = await setup();
  try {
    pkg.reporting_date = { mode: 'today' };
    await writeKeyValues(env.browser, ws, 'Settings', { setup_package: pkg });
    await saveSourceUpdate(env.browser, ws, pkg, updateFor('excel', { stock: pkg.records.stock }));
    const before = await runImport({ credentials: env.credentials, workspaceId: ws, now: () => Date.parse('2026-08-30T23:59:00+08:00') });
    const after = await runImport({ credentials: env.credentials, workspaceId: ws, now: () => Date.parse('2026-08-31T00:01:00+08:00') });
    assert.equal(before.metrics.reporting_date, '2026-08-30');
    assert.equal(after.metrics.reporting_date, '2026-08-31');
    assert.notEqual(before.snapshot_id, after.snapshot_id);
    pkg.policies.tasks = pkg.policies.tasks.filter(r => r.rule !== 'review_replenishment');
    await writeKeyValues(env.browser, ws, 'Settings', { setup_package: pkg });
    const remap = await runImport({ credentials: env.credentials, workspaceId: ws, now: () => Date.parse('2026-08-31T00:02:00+08:00') });
    assert.equal(remap.status, 'success', 'policy changes cannot hit data-only unchanged cache');
    await env.saveDecision(ws, { task_key: 'custom:call', title: 'Call supplier', status: 'accepted', action_date: '2026-08-31', note: 'Ask for Tuesday delivery', owner: 'Amir' });
    await upsertRows(env.browser, ws, 'Calendar', 'entry_id', [{ entry_id: 'meeting', date: '2026-09-01', title: 'Team planning', detail: 'Discuss September targets', deleted: 'FALSE' }]);
    let prompt = '', logs = [];
    const result = await runAi({ credentials: env.credentials, workspaceId: ws, apiKey: 'test', log: line => logs.push(line), clientFactory: () => ({ generateContent: async p => {
      prompt = p.contents[0].parts[0].text;
      return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ headline: 'PRIVATE CUSTOMER BRIEF', summary: 'Plan the week.', priorities: [], watch_items: [], data_caveats: [] }) }] } }] };
    } }) });
    assert.equal(result.status, 'success');
    assert.match(prompt, /Team planning/); assert.match(prompt, /Ask for Tuesday delivery/);
    assert.match(prompt, /data as of 2026-08-30/); assert.match(prompt, /Payment PDF: data as of unknown/);
    assert.ok(result.results[0].brief.data_caveats.some(s => s.includes('does not refresh automatically')));
    assert.doesNotMatch(logs.join('\n'), /PRIVATE CUSTOMER/);
  } finally { await env.close(); }
});

test('calendar follows recorded deadlines and accepted dates; excludes completed, dismissed, resolved and deleted items', () => {
  const tasks = mergeTasks([{ task_key: 'due:1', active: true, suggested_date: '2026-08-31', suggested_owner: 'Amy' }], [{ task_key: 'due:1', status: 'accepted', action_date: '', owner: '' }]);
  assert.equal(tasks[0].action_date, ''); assert.equal(tasks[0].owner, '', 'explicitly cleared fields stay cleared');
  const dates = buildCalendarItems({ records: { sales: [{ id: 'S1', status: 'pending', promised_completion_date: '2026-09-01' }] }, metrics: { balances: [{ sale_id: 'S1', balance: 0, due: '2026-09-01' }] }, tasks: [
    ...tasks, { task_key: 'custom:ok', status: 'accepted', action_date: '2026-09-02', title: 'Accepted' },
    ...['suggested', 'completed', 'dismissed'].map(status => ({ task_key: status, status, action_date: '2026-09-02' })),
    { task_key: 'resolved', status: 'accepted', resolved: true, action_date: '2026-09-02' },
  ], entries: [{ entry_id: 'deleted', date: '2026-09-01', deleted: 'TRUE' }], reportingDate: '2026-08-31' });
  assert.deepEqual(dates.map(d => d.id), ['completion:S1', 'custom:ok']);
});

test('interrupted write blocks AI and stays marked until a successful rebuild', async () => {
  const { env, ws } = await setup();
  try {
    let fail = true;
    const fetchFn = (url, options) => {
      if (fail && options?.method === 'PUT' && decodeURIComponent(String(url)).includes('Data_sales')) {
        fail = false; return Promise.resolve(new Response('{}', { status: 503 }));
      }
      return fetch(url, options);
    };
    const broken = await runImport({ credentials: env.credentials, workspaceId: ws, fetchFn });
    assert.equal(broken.status, 'writing');
    assert.equal((await env.meta(ws)).snapshot_incomplete, 'TRUE');
    await assert.rejects(runAi({ credentials: env.credentials, workspaceId: ws }), /incomplete/);
    const recovered = await runImport({ credentials: env.credentials, workspaceId: ws });
    assert.equal(recovered.status, 'success');
    assert.equal((await env.meta(ws)).snapshot_incomplete, 'FALSE');
    assert.equal((await env.read(ws, 'Data_sales')).length, 90);
  } finally { await env.close(); }
});
