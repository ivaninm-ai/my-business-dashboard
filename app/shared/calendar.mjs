import { isIsoDate } from './dates.mjs';
import { tr } from './i18n.mjs';

// Shared by the dashboard and AI: suggestions are not appointments until accepted.
export function buildCalendarItems({ records, metrics, tasks, entries = [], reportingDate, symbol = '', money = v => String(v / 100) }) {
  const items = [];
  const customers = new Map((records.customers || []).map(c => [c.id, c]));
  const push = item => { if (isIsoDate(item.date)) items.push({ ...item, overdue: item.date < reportingDate }); };
  for (const sale of records.sales || []) {
    if (sale.status === 'pending') push({ id: `completion:${sale.id}`, date: sale.promised_completion_date, kind: 'deadline', record_type: 'sales', record_id: sale.id, title: tr('Promised: {0} · {1}', sale.description || sale.id, customers.get(sale.customer_id)?.name || sale.customer_id || '') });
  }
  for (const b of metrics.balances || []) if (b.balance > 0) push({ id: `payment:${b.sale_id}`, date: b.due, kind: 'deadline', record_type: 'sales', record_id: b.sale_id, title: tr('Payment due: {0} {1} {2}', b.sale_id, symbol, money(b.balance)) });
  for (const c of records.customers || []) push({ id: `followup:${c.id}`, date: c.next_follow_up_date, kind: 'deadline', record_type: 'customers', record_id: c.id, title: tr('Follow-up: {0}', c.name) });
  for (const task of tasks) if (task.status === 'accepted' && !task.resolved) push({ id: task.task_key, date: task.action_date, kind: 'task', title: tr('Task: {0}', task.title), owner: task.owner || '', note: task.note || '' });
  for (const entry of entries) if (String(entry.deleted) !== 'TRUE' && entry.deleted !== true) push({ id: entry.entry_id, date: entry.date, kind: 'entry', title: entry.title, note: entry.detail || '' });
  return items.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}
