// AI worker behaviour with a mocked provider client: business-specific output is
// written to the workspace with snapshot/model/rule versions; provider failures
// and missing keys are recorded as failed results; queued requests are processed;
// references to unknown tasks are dropped. No real API calls are made.
import test from 'node:test';
import assert from 'node:assert/strict';

import { startFakeEnv, OWNER } from './helpers/fake-env.mjs';
import { runImport } from '../worker/importer.mjs';
import { runAi, buildPrompt, sanitiseBrief } from '../worker/ai.mjs';
import { upsertRows, parseJsonCell } from '../app/shared/workspace.mjs';

let env, ws;
test.before(async () => {
  env = await startFakeEnv();
  ws = await env.createWorkspace();
  const src = await env.createSourceFromFixture('b2b', 'day1');
  await env.importPackage(ws, env.loadPackage('b2b'));
  await env.bindSource(ws, 'main', src);
  const r = await runImport({ credentials: env.credentials, workspaceId: ws, runId: 'ai-import' });
  assert.equal(r.status, 'success');
});
test.after(async () => { await env.close(); });

const fakeClient = (handler) => () => ({ generateContent: async params => handler(params) });
const textResponse = obj => ({ modelVersion: 'gemini-3.5-flash-lite', usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200 }, candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(obj) }] } }] });

test('after_import: writes a complete result with snapshot, model and rule versions; prompt contains only calculated facts', async () => {
  let captured;
  const r = await runAi({ credentials: env.credentials, workspaceId: ws, apiKey: 'test-key', mode: 'after_import', runId: 'ai1', clientFactory: fakeClient(params => {
    captured = params;
    return textResponse({ headline: 'RM 30,515 is overdue across 15 orders; BS-001 first.', summary: 'Overdue balances need attention.', priorities: [{ task_key: 'payment_follow_up:BS-001', why: 'RM 4,500 overdue since 29 Aug', suggested_action: 'Mei calls ABC Workspace today' }, { task_key: 'made_up:XYZ', why: 'x', suggested_action: 'y' }], watch_items: ['T001 has no available stock'], data_caveats: ['No supplier lead times in the records'] });
  }) });
  assert.equal(r.status, 'success');
  assert.equal(captured.model, 'gemini-3.5-flash-lite');
  assert.equal(captured.generationConfig.responseMimeType, 'application/json');
  assert.match(captured.contents[0].parts[0].text, /Business: BetterSpace Office Solutions/);
  assert.match(captured.contents[0].parts[0].text, /RM 30,515/);
  assert.match(captured.contents[0].parts[0].text, /payment_follow_up:BS-001/);
  assert.doesNotMatch(JSON.stringify(captured), /test-key/, 'the key is never placed in the prompt');
  const results = await env.read(ws, 'AI_Results');
  const complete = results.find(x => x.status === 'complete');
  assert.ok(complete);
  assert.match(String(complete.snapshot_id), /^snap_/);
  assert.equal(complete.model, 'gemini-3.5-flash-lite');
  assert.match(String(complete.rules_version), /^1\.0\//);
  const content = parseJsonCell(complete.content_json);
  assert.equal(content.priorities.length, 1, 'reference to an unknown task key was dropped');
  assert.equal(content.dropped_references, 1);
  assert.equal(content.headline.includes('30,515'), true);
});

test('provider failure (401) is recorded as failed and metrics are untouched', async () => {
  const before = await env.meta(ws);
  const r = await runAi({ credentials: env.credentials, workspaceId: ws, apiKey: 'bad', mode: 'after_import', runId: 'ai2', clientFactory: fakeClient(() => { throw Object.assign(new Error('invalid key'), { status: 401 }); }) });
  assert.equal(r.status, 'failed');
  const results = await env.read(ws, 'AI_Results');
  const failed = results.filter(x => x.result_id.startsWith('ai2')).find(x => x.status === 'failed');
  assert.match(String(failed.error), /rejected the API key/);
  assert.doesNotMatch(String(failed.error), /bad/);
  assert.equal((await env.meta(ws)).current_snapshot_id, before.current_snapshot_id);
  assert.equal((await env.read(ws, 'Data_sales')).length, 90);
});

test('missing key is a clear failed result, not a crash', async () => {
  const r = await runAi({ credentials: env.credentials, workspaceId: ws, apiKey: '', mode: 'after_import', runId: 'ai3' });
  assert.equal(r.status, 'failed');
  const results = await env.read(ws, 'AI_Results');
  assert.ok(results.some(x => x.result_id.startsWith('ai3') && /GEMINI_API_KEY/.test(String(x.error))));
});

test('queued request from the dashboard is processed once and linked by request_id', async () => {
  await upsertRows(env.browser, ws, 'AI_Requests', 'request_id', [{ request_id: 'req_001', requested_at: new Date().toISOString(), requested_by: OWNER, kind: 'brief', note: 'Please summarise' }]);
  const r = await runAi({ credentials: env.credentials, workspaceId: ws, apiKey: 'k', mode: 'requests', runId: 'ai4', clientFactory: fakeClient(() => textResponse({ headline: 'Queued brief', summary: 's', priorities: [], watch_items: [], data_caveats: [] })) });
  assert.equal(r.status, 'success');
  assert.equal(r.results[0].request_id, 'req_001');
  const again = await runAi({ credentials: env.credentials, workspaceId: ws, apiKey: 'k', mode: 'requests', runId: 'ai5', clientFactory: fakeClient(() => { throw new Error('must not be called'); }) });
  assert.equal(again.status, 'skipped', 'settled requests are not processed twice');
});

test('sanitiseBrief keeps only known task keys and truncates', () => {
  const b = sanitiseBrief({ headline: 'h'.repeat(500), summary: 's', priorities: [{ task_key: 'a:1', why: 'w', suggested_action: 'x' }, { task_key: 'b:2', why: 'w', suggested_action: 'x' }], watch_items: [], data_caveats: [] }, ['a:1']);
  assert.equal(b.priorities.length, 1);
  assert.equal(b.headline.length, 300);
  assert.equal(b.dropped_references, 1);
});

test('buildPrompt reports unavailable growth instead of a fabricated percentage', () => {
  const pkg = env.loadPackage('b2c');
  const metrics = { period: { start: '2026-08-01', end: '2026-08-30', is_month_to_date: true }, period_order_value: 100, period_order_count: 1, average_order_value: 100, comparison: { start: '2026-07-01', end: '2026-07-30', prior_order_value: 0, growth: null }, period_cash_collected: 0, period_receipt_count: 0, outstanding_balance: 0, overdue_balance: 0, overdue_payment_count: 0, due_today_balance: 0, pending_completion_count: 0, overdue_completion_ids: [], due_today_completion_ids: [], counts: { stock: 0, customers: 0 }, low_stock_ids: [], out_of_stock_ids: [], overdue_follow_up_ids: [], follow_up_today_ids: [], unassigned_prospect_ids: [], repeat_customer_ids: [], by_channel: {} };
  const p = buildPrompt({ pkg, metrics, tasks: [], reportingDate: '2026-08-30', symbol: 'RM' });
  assert.match(p, /growth unavailable/);
});
