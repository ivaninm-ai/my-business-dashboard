// Evidence-based task suggestions. Each suggestion has a stable key
// (`rule:record_id`) so repeated imports never create duplicates. Recorded
// deadlines from the source are kept separately from suggested action dates,
// and a suggestion never changes any source record.

import { TASK_RULES } from './model.mjs';
import { addDays } from './dates.mjs';
import { formatMoney } from './metrics.mjs';

export const TASKS_VERSION = '1.0';

function enabledRules(policies) {
  const configured = policies?.tasks || [];
  const byRule = new Map(configured.map(t => [t.rule, t]));
  const result = [];
  for (const [rule, def] of Object.entries(TASK_RULES)) {
    const cfg = byRule.get(rule);
    if (!cfg || cfg.enabled === false) continue;
    const params = {};
    for (const [name, spec] of Object.entries(def.params)) {
      const v = cfg.params?.[name];
      params[name] = Number.isInteger(v) ? v : spec.default;
    }
    result.push({ rule, def, params });
  }
  return result;
}

export function generateSuggestions(records, metrics, reportingDate, policies, symbol = 'RM') {
  const customers = new Map((records.customers || []).map(c => [c.id, c]));
  const salesByCustomer = new Map();
  for (const s of records.sales || []) {
    if (s.status === 'excluded') continue;
    if (!salesByCustomer.has(s.customer_id)) salesByCustomer.set(s.customer_id, []);
    salesByCustomer.get(s.customer_id).push(s);
  }
  const salesById = new Map((records.sales || []).map(s => [s.id, s]));
  const out = [];
  const present = Object.fromEntries(Object.keys(records).map(k => [k, (records[k] || []).length > 0 || Array.isArray(records[k])]));
  const push = t => out.push({ ...t, task_key: `${t.rule}:${t.record_id}` });

  for (const { rule, params } of enabledRules(policies)) {
    const needs = TASK_RULES[rule].needs;
    if (!needs.every(n => Array.isArray(records[n]))) continue;
    switch (rule) {
      case 'payment_follow_up':
        for (const b of metrics.balances) {
          const sale = salesById.get(b.sale_id);
          const customer = customers.get(b.customer_id);
          const due = b.due;
          let suggested = due ? addDays(due, params.offset_days) : reportingDate;
          if (!suggested || suggested <= reportingDate) suggested = reportingDate;
          push({
            rule, record_type: 'sales', record_id: b.sale_id,
            title: `Follow up payment for ${b.sale_id}${customer ? ' · ' + customer.name : ''}`,
            reason: `${formatMoney(b.balance, symbol)} unpaid of ${formatMoney(b.amount, symbol)} (${formatMoney(b.paid, symbol)} received). ${due ? `Recorded due date ${due}${b.state === 'overdue' ? ' — overdue' : b.state === 'due_today' ? ' — due today' : ''}.` : 'No recorded due date.'}`,
            evidence: { balance: b.balance, amount: b.amount, paid: b.paid, state: b.state, customer_id: b.customer_id, description: sale?.description || '' },
            recorded_deadline: due || '',
            suggested_date: suggested,
            suggested_owner: customer?.owner || '',
          });
        }
        break;
      case 'follow_up_due':
        for (const c of records.customers) {
          if (!c.next_follow_up_date) continue;
          const overdue = c.next_follow_up_date < reportingDate;
          push({
            rule, record_type: 'customers', record_id: c.id,
            title: `Follow up ${c.name}`,
            reason: `Recorded next follow-up ${c.next_follow_up_date}${overdue ? ' is before the reporting date (recorded action overdue; this does not prove no contact occurred)' : c.next_follow_up_date === reportingDate ? ' is today' : ''}. ${c.type === 'prospect' ? 'Prospect' : 'Customer'}${c.owner ? ' · owner ' + c.owner : ' · no owner recorded'}.`,
            evidence: { next_follow_up_date: c.next_follow_up_date, type: c.type, owner: c.owner || '' },
            recorded_deadline: c.next_follow_up_date,
            suggested_date: overdue ? reportingDate : c.next_follow_up_date,
            suggested_owner: c.owner || '',
          });
        }
        break;
      case 'review_account':
        for (const c of records.customers) {
          if (c.type !== 'customer') continue;
          if ((salesByCustomer.get(c.id) || []).length) continue;
          push({
            rule, record_type: 'customers', record_id: c.id,
            title: `Review account information for ${c.name}`,
            reason: 'Recorded as a customer but no sales rows exist for this account. Review only; the classification is not changed.',
            evidence: { type: c.type, created_date: c.created_date || '' },
            recorded_deadline: '',
            suggested_date: reportingDate,
            suggested_owner: c.owner || '',
          });
        }
        break;
      case 'review_replenishment':
        for (const st of metrics.stock) {
          if (!st.low) continue;
          push({
            rule, record_type: 'stock', record_id: st.id,
            title: `Review replenishment for ${st.name || st.id}`,
            reason: `Available ${st.available} (on hand ${st.on_hand} − reserved ${st.reserved || 0}) is at or below the reorder threshold ${st.reorder_threshold || 0}.${st.unreserved_pending ? ` ${st.unreserved_pending} pending units are not covered by reservations.` : ''} Supplier lead times and purchase quantities are not in the records.`,
            evidence: { available: st.available, on_hand: st.on_hand, reserved: st.reserved || 0, reorder_threshold: st.reorder_threshold || 0, unreserved_pending: st.unreserved_pending, snapshot_date: st.snapshot_date || '' },
            recorded_deadline: '',
            suggested_date: reportingDate,
            suggested_owner: '',
          });
        }
        break;
      case 'completion_overdue':
        for (const id of metrics.overdue_completion_ids) {
          const s = salesById.get(id);
          const customer = customers.get(s.customer_id);
          push({
            rule, record_type: 'sales', record_id: id,
            title: `Confirm delivery / completion of ${id}${customer ? ' · ' + customer.name : ''}`,
            reason: `Status "${s.status_text || s.status}" with promised completion ${s.promised_completion_date}, which is before the reporting date. Confirm the actual status with the team; completing this task does not change the sale.`,
            evidence: { promised_completion_date: s.promised_completion_date, status: s.status_text || s.status, description: s.description || '' },
            recorded_deadline: s.promised_completion_date,
            suggested_date: reportingDate,
            suggested_owner: customer?.owner || '',
          });
        }
        break;
      case 'completion_due_soon': {
        const horizon = addDays(reportingDate, params.within_days);
        for (const s of records.sales) {
          if (s.status !== 'pending' || !s.promised_completion_date) continue;
          if (s.promised_completion_date < reportingDate || s.promised_completion_date > horizon) continue;
          const customer = customers.get(s.customer_id);
          push({
            rule, record_type: 'sales', record_id: s.id,
            title: `Prepare ${s.description || s.id}${customer ? ' for ' + customer.name : ''}`,
            reason: `Promised completion ${s.promised_completion_date} is within ${params.within_days} day(s) of the reporting date.`,
            evidence: { promised_completion_date: s.promised_completion_date, status: s.status_text || s.status },
            recorded_deadline: s.promised_completion_date,
            suggested_date: addDays(s.promised_completion_date, -1) >= reportingDate ? addDays(s.promised_completion_date, -1) : reportingDate,
            suggested_owner: customer?.owner || '',
          });
        }
        break;
      }
      case 'unassigned_prospect':
        for (const id of metrics.unassigned_prospect_ids) {
          const c = customers.get(id);
          push({
            rule, record_type: 'customers', record_id: id,
            title: `Assign an owner to ${c.name}`,
            reason: 'Prospect with no recorded owner. The owner stays unassigned until someone accepts this task.',
            evidence: { type: c.type, next_follow_up_date: c.next_follow_up_date || '' },
            recorded_deadline: c.next_follow_up_date || '',
            suggested_date: reportingDate,
            suggested_owner: '',
          });
        }
        break;
    }
  }
  void present;
  return out;
}

// Merge freshly generated suggestions with the previous importer-owned rows so that
// keys keep their first-seen snapshot and resolved suggestions stay visible (inactive).
export function reconcileSuggestions(previousRows, fresh, snapshotId) {
  const prev = new Map((previousRows || []).map(r => [r.task_key, r]));
  const out = [];
  const seen = new Set();
  for (const t of fresh) {
    const p = prev.get(t.task_key);
    out.push({ ...t, first_snapshot: p?.first_snapshot || snapshotId, last_snapshot: snapshotId, active: true, resolved_snapshot: '' });
    seen.add(t.task_key);
  }
  for (const [key, p] of prev) {
    if (seen.has(key)) continue;
    out.push({ ...p, active: false, resolved_snapshot: p.resolved_snapshot || snapshotId });
  }
  return out;
}

// Join for display: suggestions (importer-owned) + decisions (user-owned) + custom tasks.
export function mergeTasks(suggested, decisions) {
  const decisionByKey = new Map((decisions || []).map(d => [d.task_key, d]));
  const tasks = [];
  for (const s of suggested || []) {
    const d = decisionByKey.get(s.task_key);
    tasks.push({
      ...s,
      status: d?.status || 'suggested',
      action_date: d && Object.hasOwn(d, 'action_date') ? d.action_date : s.suggested_date,
      owner: d && Object.hasOwn(d, 'owner') ? d.owner : (s.suggested_owner || ''),
      note: d?.note || '',
      decided_at: d?.updated_at || '',
      stale: !!d && !!d.snapshot_at_decision && !!s.last_snapshot && d.snapshot_at_decision !== s.last_snapshot && s.active,
      resolved: !s.active,
      custom: false,
    });
    decisionByKey.delete(s.task_key);
  }
  for (const [key, d] of decisionByKey) {
    if (!key.startsWith('custom:')) {
      // Decision for a suggestion that no longer exists in Tasks_Suggested (e.g. rule disabled): keep history.
      tasks.push({ task_key: key, rule: key.split(':')[0], record_type: '', record_id: key.split(':').slice(1).join(':'), title: d.title || key, reason: d.detail || 'Suggestion no longer generated by the current rules.', evidence: {}, recorded_deadline: '', suggested_date: '', suggested_owner: '', status: d.status, action_date: d.action_date || '', owner: d.owner || '', note: d.note || '', decided_at: d.updated_at || '', stale: false, resolved: true, custom: false });
      continue;
    }
    tasks.push({ task_key: key, rule: 'custom', record_type: '', record_id: '', title: d.title || 'Task', reason: d.detail || '', evidence: {}, recorded_deadline: '', suggested_date: '', suggested_owner: '', status: d.status || 'accepted', action_date: d.action_date || '', owner: d.owner || '', note: d.note || '', decided_at: d.updated_at || '', stale: false, resolved: false, custom: true });
  }
  return tasks;
}
