// Reconciliation with the BetterSpace answer keys (expected_metrics.json). The
// fixtures are inputs only; the dashboard code never reads expected_metrics.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readCsv, sheetify } from './helpers/csv.mjs';
import { applyTableMapping, relationalChecks, resolveReportingDate, hasErrors } from '../app/shared/mapping.mjs';
import { computeMetrics } from '../app/shared/metrics.mjs';
import { generateSuggestions } from '../app/shared/tasks.mjs';
import { validatePackage } from '../app/shared/package.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const schema = JSON.parse(readFileSync(path.join(root, 'app/shared/setup-package.schema.json'), 'utf8'));

export function loadFixture(business, day, { datesAsSerial = true } = {}) {
  const dir = path.join(here, 'fixtures/betterspace', business, day);
  const sheets = {};
  for (const name of ['Customers', 'Sales', 'Payments', 'Stock']) {
    sheets[name] = sheetify(readCsv(path.join(dir, `${name}.csv`)), { datesAsSerial });
  }
  const expected = JSON.parse(readFileSync(path.join(dir, 'expected_metrics.json'), 'utf8'));
  const metadata = JSON.parse(readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
  return { sheets, expected, metadata };
}

export function loadPackage(business) {
  return JSON.parse(readFileSync(path.join(root, 'config/examples', `betterspace-${business}.setup-package.json`), 'utf8'));
}

export function mapAll(pkg, sheets) {
  const records = {};
  let issues = [];
  for (const t of pkg.tables) {
    const r = applyTableMapping(t, sheets[t.sheet_name] || [], pkg);
    records[t.entity] = r.records;
    issues = issues.concat(r.issues);
  }
  issues = issues.concat(relationalChecks(records));
  return { records, issues };
}

const cents = n => Math.round(n * 100);

for (const business of ['b2c', 'b2b']) {
  const pkg = loadPackage(business);
  test(`${business}: example setup package is valid`, () => {
    const v = validatePackage(pkg, schema);
    assert.deepEqual(v.errors, []);
    assert.equal(v.ok, true);
  });
  for (const day of ['day1', 'day2']) {
    test(`${business} ${day}: mapped totals reconcile with expected_metrics.json`, () => {
      const { sheets, expected, metadata } = loadFixture(business, day);
      const { records, issues } = mapAll(pkg, sheets);
      assert.equal(hasErrors(issues), false, JSON.stringify(issues.filter(i => i.level === 'error').slice(0, 3)));
      const rd = resolveReportingDate(pkg, records, '2099-01-01');
      assert.equal(rd.date, metadata.as_of_date, 'reporting date derived from records equals metadata.as_of_date');
      assert.equal(records.customers.length, expected.row_counts.Customers);
      assert.equal(records.sales.length, expected.row_counts.Sales);
      assert.equal(records.payments.length, expected.row_counts.Payments);
      assert.equal(records.stock.length, expected.row_counts.Stock);
      const m = computeMetrics(records, rd.date, { periodStart: '2026-08-01', periodEnd: rd.date, historyStart: '2026-06-01' });
      assert.equal(m.all_time_order_value, cents(expected.all_time_order_value));
      assert.equal(m.all_time_cash_collected, cents(expected.all_time_cash_collected));
      assert.equal(m.outstanding_balance, cents(expected.outstanding_balance));
      assert.equal(m.overdue_balance, cents(expected.overdue_balance));
      assert.equal(m.period_order_value, cents(expected.august_order_value));
      assert.equal(m.period_order_count, expected.august_order_count);
      assert.equal(m.period_cash_collected, cents(expected.august_cash_collected));
      assert.equal(m.comparison.prior_order_value, cents(expected.prior_comparable_order_value));
      assert.deepEqual(m.overdue_sale_ids, [...expected.overdue_sale_ids].sort());
      assert.deepEqual(m.overdue_completion_ids, [...expected.overdue_completion_ids].sort());
      assert.deepEqual(m.low_stock_ids, [...expected.low_stock_ids].sort());
      assert.deepEqual(m.overdue_follow_up_ids, [...expected.overdue_follow_up_ids].sort());
      assert.deepEqual(m.unassigned_prospect_ids, [...expected.unassigned_prospect_ids].sort());
      assert.equal(m.negative_balance_count, 0);
      if (business === 'b2b') {
        const story = m.balances.find(b => b.sale_id === 'BS-001');
        assert.equal(story ? story.balance : 0, cents(expected.story_sale_balance));
      }
    });
  }
}

test('b2b day1: suggestions carry evidence, recorded deadlines and suggested dates that differ', () => {
  const pkg = loadPackage('b2b');
  const { sheets } = loadFixture('b2b', 'day1');
  const { records } = mapAll(pkg, sheets);
  const m = computeMetrics(records, '2026-08-30', { historyStart: '2026-06-01' });
  const tasks = generateSuggestions(records, m, '2026-08-30', pkg.policies, 'RM');
  const keys = tasks.map(t => t.task_key);
  assert.equal(new Set(keys).size, keys.length, 'task keys are unique');
  const bs001 = tasks.find(t => t.task_key === 'payment_follow_up:BS-001');
  assert.ok(bs001, 'BS-001 payment follow-up exists');
  assert.equal(bs001.recorded_deadline, '2026-08-29');
  assert.equal(bs001.suggested_date, '2026-08-30', 'already overdue -> reporting date');
  assert.equal(bs001.suggested_owner, 'Mei');
  assert.equal(bs001.evidence.balance, 450000);
  const notDue = tasks.find(t => t.task_key === 'payment_follow_up:BS-002');
  assert.equal(notDue.recorded_deadline, '2026-09-18');
  assert.equal(notDue.suggested_date, '2026-09-19', 'due date + 1 day');
  assert.ok(tasks.some(t => t.task_key === 'review_replenishment:T001'));
  assert.ok(tasks.some(t => t.task_key === 'review_account:BC-006'));
  assert.ok(tasks.some(t => t.task_key === 'follow_up_due:BC-036'));
  assert.equal(tasks.filter(t => t.rule === 'completion_overdue').length, 0, 'no overdue completions on Day 1');
});

test('b2c day1: ISO text dates map identically to serial dates', () => {
  const pkg = loadPackage('b2c');
  const a = mapAll(pkg, loadFixture('b2c', 'day1', { datesAsSerial: true }).sheets).records;
  const b = mapAll(pkg, loadFixture('b2c', 'day1', { datesAsSerial: false }).sheets).records;
  assert.deepEqual(a.sales.map(s => s.date), b.sales.map(s => s.date));
  assert.deepEqual(a.stock.map(s => s.snapshot_date), b.stock.map(s => s.snapshot_date));
});
