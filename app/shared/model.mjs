// The canonical record model shared by Business setup, the importer and the
// dashboard. A student's spreadsheet never has to use these names: the setup
// package maps their headers onto these fields. Types drive parsing/validation;
// nothing here is executable configuration.

export const MODEL_VERSION = '1.0';

export const ENTITIES = {
  customers: {
    label: 'Customers',
    row_meaning: 'One row is one customer account, client or prospect',
    fields: {
      id: { type: 'text', required: true, doc: 'Stable customer identifier' },
      name: { type: 'text', required: true, doc: 'Display name' },
      type: { type: 'enum', values: ['customer', 'prospect'], default: 'customer', doc: 'Recorded classification, not an inference' },
      contact: { type: 'text', doc: 'Contact detail, shown as text only' },
      created_date: { type: 'date', doc: 'Date the account was added' },
      owner: { type: 'text', doc: 'Person responsible; blank = unassigned' },
      next_follow_up_date: { type: 'date', doc: 'One recorded next contact action' },
      notes: { type: 'text', doc: 'Free text, displayed as text only' },
    },
  },
  sales: {
    label: 'Sales',
    row_meaning: 'One row is one order, job or booking with a single amount',
    fields: {
      id: { type: 'text', required: true, doc: 'Stable sale/order identifier' },
      customer_id: { type: 'text', doc: 'Reference to customers.id' },
      date: { type: 'date', required: true, doc: 'Order/booking date' },
      item_id: { type: 'text', doc: 'Reference to stock.id for products' },
      description: { type: 'text', doc: 'Offering name' },
      offering_type: { type: 'enum', values: ['product', 'service'], default: 'product' },
      quantity: { type: 'integer', default: 1 },
      unit_price: { type: 'money' },
      amount: { type: 'money', required: true, doc: 'Booked order value, not profit or cash' },
      channel: { type: 'text' },
      status: { type: 'status', doc: 'Mapped through status_map to pending/done/excluded' },
      payment_due_date: { type: 'date', doc: 'Recorded deadline for the balance' },
      promised_completion_date: { type: 'date', doc: 'Recorded delivery/completion promise' },
      actual_completion_date: { type: 'date' },
    },
  },
  payments: {
    label: 'Payments',
    row_meaning: 'One row is one receipt of money against one sale',
    fields: {
      id: { type: 'text', required: true },
      sale_id: { type: 'text', required: true, doc: 'Reference to sales.id' },
      date: { type: 'date', required: true, doc: 'Date the money was received' },
      amount: { type: 'money', required: true },
      method: { type: 'text' },
    },
  },
  stock: {
    label: 'Stock',
    row_meaning: 'One row is one product in a stock snapshot shared by all channels',
    fields: {
      id: { type: 'text', required: true },
      name: { type: 'text' },
      snapshot_date: { type: 'date', doc: 'Date the quantities were counted' },
      on_hand: { type: 'integer', required: true, doc: 'Units physically held, including reserved' },
      reserved: { type: 'integer', default: 0, doc: 'Units held for unfinished sales (product total, not per order)' },
      reorder_threshold: { type: 'integer', default: 0, doc: 'Flag when available is at or below this' },
    },
  },
};

export const STATUS_BUCKETS = ['pending', 'done', 'excluded'];

// Task rules are a fixed catalogue. A setup package can enable/disable them and set
// the listed parameters; it cannot add expressions or code.
export const TASK_RULES = {
  payment_follow_up: {
    title: 'Payment follow-up',
    needs: ['sales', 'payments'],
    params: { offset_days: { type: 'integer', default: 1, doc: 'Days after the recorded due date to suggest the follow-up' } },
    doc: 'Any eligible sale with a positive unpaid balance as of the reporting date',
  },
  follow_up_due: {
    title: 'Follow-up',
    needs: ['customers'],
    params: {},
    doc: 'Any customer/prospect with a recorded next follow-up date',
  },
  review_account: {
    title: 'Review account information',
    needs: ['customers', 'sales'],
    params: {},
    doc: 'A customer-type account with no sales rows; suggests a review only, never reclassification',
  },
  review_replenishment: {
    title: 'Review replenishment',
    needs: ['stock'],
    params: {},
    doc: 'Available stock at or below the reorder threshold; no purchase quantities are invented',
  },
  completion_overdue: {
    title: 'Confirm delivery / completion',
    needs: ['sales'],
    params: {},
    doc: 'Pending sale whose promised completion date is before the reporting date',
  },
  completion_due_soon: {
    title: 'Prepare delivery / appointment',
    needs: ['sales'],
    params: { within_days: { type: 'integer', default: 3 } },
    doc: 'Pending sale promised within the next N days (including the reporting date)',
  },
  unassigned_prospect: {
    title: 'Assign an owner',
    needs: ['customers'],
    params: {},
    doc: 'Prospect with no recorded owner',
  },
};

export const MODULES = ['overview', 'sales', 'customers', 'payments', 'stock', 'tasks', 'calendar', 'ai'];

export const DATE_ORDERS = ['dmy', 'mdy', 'ymd'];
export const REPORTING_MODES = ['fixed', 'today', 'latest_event_date'];
export const IDENTITY_MODES = ['source_id', 'composite', 'row_number'];
export const LOAD_MODES = ['replace'];

export function entityFor(name) {
  const entity = ENTITIES[name];
  if (!entity) throw new Error(`Unknown entity "${name}"`);
  return entity;
}
