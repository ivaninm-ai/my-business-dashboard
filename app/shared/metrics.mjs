// Deterministic metric calculations (METRIC_RULES.md, generalised). Money is in
// integer cents. Dates are 'YYYY-MM-DD' strings compared lexicographically. The
// reporting date is a parameter: the current clock is never used here.

import { monthStart, priorMonthSameDays, addDays, daysInMonth } from './dates.mjs';

export const METRICS_VERSION = '1.0';

const inRange = (d, start, end) => !!d && d >= start && d <= end;

export function computeMetrics(records, reportingDate, options = {}) {
  const { periodStart, periodEnd, historyStart, filters = {} } = options;
  const pStart = periodStart || monthStart(reportingDate);
  const pEnd = periodEnd || reportingDate;
  const customers = records.customers || [];
  const customerById = new Map(customers.map(c => [c.id, c]));
  const saleFilter = s => {
    if (filters.channel && (s.channel || '') !== filters.channel) return false;
    if (filters.owner) {
      const owner = customerById.get(s.customer_id)?.owner || '';
      if (owner !== filters.owner) return false;
    }
    return true;
  };
  const eligibleAll = (records.sales || []).filter(s => s.status !== 'excluded' && s.date && s.date <= reportingDate);
  const eligible = eligibleAll.filter(saleFilter);
  const eligibleIds = new Set(eligible.map(s => s.id));
  const inPeriod = eligible.filter(s => inRange(s.date, pStart, pEnd));

  const paidBySale = new Map(); // all receipts on/before reporting date, keyed by sale
  const cashInPeriod = { cents: 0, count: 0 };
  let allTimeCash = 0;
  for (const p of records.payments || []) {
    if (!eligibleIds.has(p.sale_id)) continue;
    if (!p.date || p.date > reportingDate) continue;
    paidBySale.set(p.sale_id, (paidBySale.get(p.sale_id) || 0) + p.amount);
    allTimeCash += p.amount;
    if (inRange(p.date, pStart, pEnd)) { cashInPeriod.cents += p.amount; cashInPeriod.count++; }
  }

  const balances = [];
  let outstanding = 0, overdue = 0, overdueCount = 0, dueTodayBalance = 0, negativeBalances = 0;
  for (const s of eligible) {
    const paid = paidBySale.get(s.id) || 0;
    const balance = s.amount - paid;
    if (balance < 0) negativeBalances++;
    if (balance > 0) {
      outstanding += balance;
      const state = s.payment_due_date && s.payment_due_date < reportingDate ? 'overdue'
        : s.payment_due_date === reportingDate ? 'due_today' : 'not_due';
      if (state === 'overdue') { overdue += balance; overdueCount++; }
      if (state === 'due_today') dueTodayBalance += balance;
      balances.push({ sale_id: s.id, customer_id: s.customer_id, amount: s.amount, paid, balance, due: s.payment_due_date, state });
    }
  }

  const pending = eligible.filter(s => s.status === 'pending');
  const overdueCompletion = pending.filter(s => s.promised_completion_date && s.promised_completion_date < reportingDate);
  const dueToday = pending.filter(s => s.promised_completion_date === reportingDate);

  const openUnits = new Map();
  for (const s of pending) {
    if (s.offering_type === 'product' && s.item_id) openUnits.set(s.item_id, (openUnits.get(s.item_id) || 0) + (s.quantity || 0));
  }
  const stock = (records.stock || []).map(st => {
    const reserved = st.reserved || 0;
    const available = st.on_hand - reserved;
    const open = openUnits.get(st.id) || 0;
    return { ...st, available, low: available <= (st.reorder_threshold || 0), out: available <= 0, open_units: open, unreserved_pending: Math.max(0, open - reserved) };
  });
  const stockSnapshotDate = stock.map(s => s.snapshot_date).filter(Boolean).sort().pop() || null;

  const followUps = customers.filter(c => c.next_follow_up_date).filter(c => !filters.owner || (c.owner || '') === filters.owner);
  const overdueFollowUps = followUps.filter(c => c.next_follow_up_date < reportingDate);
  const followUpsToday = followUps.filter(c => c.next_follow_up_date === reportingDate);
  const unassignedProspects = customers.filter(c => c.type === 'prospect' && !(c.owner || '').trim());

  const perCustomer = new Map();
  for (const s of inPeriod) perCustomer.set(s.customer_id, (perCustomer.get(s.customer_id) || 0) + 1);
  const repeatCustomers = [...perCustomer.entries()].filter(([, n]) => n >= 2).map(([id]) => id);

  const periodOrderValue = inPeriod.reduce((a, s) => a + s.amount, 0);
  const periodOrderCount = new Set(inPeriod.map(s => s.id)).size;

  // Comparison: month-to-date compares with the same day numbers of the prior month;
  // any other range compares with the immediately preceding window of equal length.
  let comparison;
  const isMtd = pStart === monthStart(pEnd);
  if (isMtd) {
    const prior = priorMonthSameDays(pStart, pEnd);
    comparison = { kind: 'prior_month_same_days', start: prior.start, end: prior.end, clamped: prior.clamped };
  } else {
    const len = Math.max(1, (Date.UTC(...pEnd.split('-').map((v, i) => i === 1 ? +v - 1 : +v)) - Date.UTC(...pStart.split('-').map((v, i) => i === 1 ? +v - 1 : +v))) / 86400000 + 1);
    comparison = { kind: 'preceding_window', start: addDays(pStart, -len), end: addDays(pStart, -1), clamped: false };
  }
  const priorSales = eligible.filter(s => inRange(s.date, comparison.start, comparison.end));
  const priorOrderValue = priorSales.reduce((a, s) => a + s.amount, 0);
  const growth = priorOrderValue > 0 ? (periodOrderValue - priorOrderValue) / priorOrderValue : null;

  // Monthly trend across the history window.
  const trendStart = historyStart || monthStart(eligible.map(s => s.date).sort()[0] || reportingDate);
  const trend = [];
  for (let m = monthStart(trendStart); m <= reportingDate; m = addDays(m, daysInMonth(m))) {
    const mEnd = addDays(m, daysInMonth(m) - 1);
    const value = eligible.filter(s => inRange(s.date, m, mEnd)).reduce((a, s) => a + s.amount, 0);
    trend.push({ month: m.slice(0, 7), order_value: value, partial: mEnd > reportingDate, end: mEnd > reportingDate ? reportingDate : mEnd });
  }

  const byChannel = {};
  for (const s of inPeriod) { const k = s.channel || '(none)'; byChannel[k] = (byChannel[k] || 0) + s.amount; }

  return {
    version: METRICS_VERSION,
    reporting_date: reportingDate,
    period: { start: pStart, end: pEnd, is_month_to_date: isMtd },
    filters,
    counts: {
      customers: customers.length,
      sales: (records.sales || []).length,
      payments: (records.payments || []).length,
      stock: (records.stock || []).length,
      eligible_sales: eligibleAll.length,
    },
    period_order_value: periodOrderValue,
    period_order_count: periodOrderCount,
    average_order_value: periodOrderCount ? Math.round(periodOrderValue / periodOrderCount) : null,
    period_cash_collected: cashInPeriod.cents,
    period_receipt_count: cashInPeriod.count,
    all_time_order_value: eligible.reduce((a, s) => a + s.amount, 0),
    all_time_cash_collected: allTimeCash,
    outstanding_balance: outstanding,
    overdue_balance: overdue,
    overdue_payment_count: overdueCount,
    due_today_balance: dueTodayBalance,
    negative_balance_count: negativeBalances,
    balances,
    pending_completion_count: pending.length,
    overdue_completion_ids: overdueCompletion.map(s => s.id).sort(),
    due_today_completion_ids: dueToday.map(s => s.id).sort(),
    overdue_sale_ids: balances.filter(b => b.state === 'overdue').map(b => b.sale_id).sort(),
    stock,
    stock_snapshot_date: stockSnapshotDate,
    low_stock_ids: stock.filter(s => s.low).map(s => s.id).sort(),
    out_of_stock_ids: stock.filter(s => s.out).map(s => s.id).sort(),
    overdue_follow_up_ids: overdueFollowUps.map(c => c.id).sort(),
    follow_up_today_ids: followUpsToday.map(c => c.id).sort(),
    unassigned_prospect_ids: unassignedProspects.map(c => c.id).sort(),
    repeat_customer_ids: repeatCustomers.sort(),
    comparison: { ...comparison, prior_order_value: priorOrderValue, growth },
    trend,
    by_channel: byChannel,
  };
}

export function formatMoney(cents, symbol = 'RM') {
  if (cents === null || cents === undefined) return '—';
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const major = Math.floor(abs / 100).toLocaleString('en-US');
  const minor = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}${symbol} ${major}${minor === '00' ? '' : '.' + minor}`;
}
