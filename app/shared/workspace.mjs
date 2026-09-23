// Dashboard Workspace workbook layout and operations. The workbook is a storage
// implementation the student never edits by hand. Importer-owned tabs are rewritten
// by the worker; user-owned tabs are written only by the dashboard; the worker
// only ever appends to its own log/result tabs. Rows are located by stable keys
// before any update so sorting or inserting rows cannot corrupt data.

import { ENTITIES } from './model.mjs';
import { quoteSheet } from './sheets.mjs';
import { tr } from './i18n.mjs';

export const WORKSPACE_ROLE = 'dashboard-workspace';
export const WORKSPACE_SCHEMA_VERSION = 1;
export const MAX_CELL_CHARS = 40000; // Google's limit is 50,000; keep headroom for chunking
export const LIMITS = {
  records_per_table: 5000,
  tasks: 2000,
  calendar_entries: 2000,
  snapshots_kept: 30,
  ai_results_kept: 100,
  sync_log_kept: 200,
};

const dataHeader = entity => [...Object.keys(ENTITIES[entity].fields), 'status_text', '_source'];

export const TABS = {
  Setup_Result: { owner: 'worker', header: ['key', 'value'] },
  _Workspace: { owner: 'shared', header: ['key', 'value'] },
  Settings: { owner: 'user', header: ['key', 'value', 'updated_at'] },
  Sources: { owner: 'user', header: ['source_id', 'kind', 'spreadsheet_id', 'label', 'refresh', 'updated_at'] },
  Data_customers: { owner: 'importer', header: dataHeader('customers') },
  Data_sales: { owner: 'importer', header: dataHeader('sales') },
  Data_payments: { owner: 'importer', header: dataHeader('payments') },
  Data_stock: { owner: 'importer', header: dataHeader('stock') },
  Metrics: { owner: 'importer', header: ['key', 'value'] },
  Snapshots: { owner: 'importer', header: ['snapshot_id', 'taken_at', 'reporting_date', 'reporting_basis', 'coverage_json', 'row_counts_json', 'content_hash', 'status', 'message'] },
  Tasks_Suggested: { owner: 'importer', header: ['task_key', 'rule', 'record_type', 'record_id', 'title', 'reason', 'evidence_json', 'recorded_deadline', 'suggested_date', 'suggested_owner', 'first_snapshot', 'last_snapshot', 'active', 'resolved_snapshot'] },
  Task_Decisions: { owner: 'user', header: ['task_key', 'status', 'action_date', 'owner', 'note', 'title', 'detail', 'snapshot_at_decision', 'updated_at', 'updated_by'] },
  Calendar: { owner: 'user', header: ['entry_id', 'date', 'title', 'detail', 'kind', 'related_task_key', 'created_at', 'updated_at', 'deleted'] },
  AI_Requests: { owner: 'user', header: ['request_id', 'requested_at', 'requested_by', 'kind', 'note'] },
  AI_Results: { owner: 'worker', header: ['result_id', 'request_id', 'generated_at', 'snapshot_id', 'model', 'rules_version', 'kind', 'status', 'headline', 'content_json', 'error'] },
  Sync_Log: { owner: 'worker', header: ['run_id', 'job', 'started_at', 'finished_at', 'status', 'message', 'snapshot_id', 'details_json'] },
};

export const TAB_NAMES = Object.keys(TABS);

const cell = v => (v === null || v === undefined) ? '' : (typeof v === 'object' ? JSON.stringify(v) : v);

export function rowsToObjects(header, rows) {
  const out = [];
  for (const r of rows) {
    if (!r || r.every(v => v === '' || v === null || v === undefined)) continue;
    const o = {};
    header.forEach((h, i) => { o[h] = r[i] === undefined ? '' : r[i]; });
    out.push(o);
  }
  return out;
}

export function objectsToRows(header, objects) {
  return objects.map(o => header.map(h => cell(o[h])));
}

// --- structure -----------------------------------------------------------------

export async function inspectWorkspace(client, id) {
  const info = await client.getSpreadsheet(id);
  const titles = new Set(info.sheets.map(s => s.title));
  let meta = {};
  if (titles.has('_Workspace')) {
    const [vr] = await client.batchGet(id, [`${quoteSheet('_Workspace')}!A1:B50`]);
    meta = Object.fromEntries(rowsToObjects(['key', 'value'], vr.values.slice(1)).map(r => [r.key, r.value]));
  }
  const isWorkspace = meta.role === WORKSPACE_ROLE;
  const missing = TAB_NAMES.filter(t => !titles.has(t));
  const foreign = info.sheets.filter(s => !TABS[s.title]).map(s => s.title);
  return { info, titles: [...titles], meta, isWorkspace, missing, foreign, schemaVersion: Number(meta.schema_version || 0) };
}

// Adds any missing tabs and headers without touching existing ones. Refuses to
// initialise a workbook that already holds unrelated tabs unless it is already a
// workspace (so a source workbook can never be turned into disposable output).
export async function ensureWorkspace(client, id, { appVersion, actor }) {
  const state = await inspectWorkspace(client, id);
  const { info, missing, foreign, isWorkspace } = state;
  if (!isWorkspace) {
    // Only a completely blank workbook (every sheet empty) may be initialised.
    const empty = await isBlank(client, id, info.sheets);
    if (!empty) {
      throw new Error(tr('This workbook is not a Dashboard Workspace. Create the workspace from the dashboard (Data connections > Create workspace); source workbooks are never initialised.'));
    }
  }
  const requests = [];
  for (const t of missing) requests.push({ addSheet: { properties: { title: t } } });
  if (requests.length) await client.batchUpdate(id, requests);
  const writes = [];
  for (const t of missing) writes.push({ range: `${quoteSheet(t)}!A1`, values: [TABS[t].header] });
  if (!isWorkspace) {
    writes.push({ range: `${quoteSheet('_Workspace')}!A1`, values: [
      ['key', 'value'],
      ['role', WORKSPACE_ROLE],
      ['schema_version', WORKSPACE_SCHEMA_VERSION],
      ['created_at', new Date().toISOString()],
      ['created_by', actor || ''],
      ['app_version', appVersion || ''],
      ['current_snapshot_id', ''],
      ['lease_holder', ''],
      ['lease_expires', ''],
      ['last_import_status', ''],
      ['last_successful_import_at', ''],
    ] });
  }
  if (writes.length) await client.batchUpdateValues(id, writes);
  // If the default "Sheet1" is the only foreign tab and it is blank, remove it.
  if (!isWorkspace && foreign.length === 1) {
    const sheet = info.sheets.find(s => s.title === foreign[0]);
    if (sheet) await client.batchUpdate(id, [{ deleteSheet: { sheetId: sheet.sheetId } }]).catch(() => {});
  }
  return { created: !isWorkspace, addedTabs: missing };
}

async function isBlank(client, id, sheets) {
  if (!sheets.length) return true;
  const ranges = sheets.map(s => `${quoteSheet(s.title)}!A1:C3`);
  const vrs = await client.batchGet(id, ranges);
  return vrs.every(vr => vr.values.length === 0);
}

// --- key/value tabs -------------------------------------------------------------

export async function readKeyValues(client, id, tab) {
  const [vr] = await client.batchGet(id, [`${quoteSheet(tab)}!A1:C1000`]);
  const rows = rowsToObjects(['key', 'value', 'updated_at'], vr.values.slice(1));
  const out = {};
  const chunks = {};
  for (const r of rows) {
    const m = String(r.key).match(/^(.*)\.chunk(\d+)$/);
    if (m) { (chunks[m[1]] ||= [])[Number(m[2])] = String(r.value ?? ''); }
    else out[r.key] = r.value;
  }
  for (const [k, parts] of Object.entries(chunks)) out[k] = parts.join('');
  return { values: out, rows: vr.values };
}

export async function writeKeyValues(client, id, tab, entries, { timestamp = true } = {}) {
  const { rows } = await readKeyValues(client, id, tab);
  const index = new Map();
  rows.forEach((r, i) => { if (i > 0 && r[0] !== undefined && r[0] !== '') index.set(String(r[0]), i + 1); });
  const writes = [];
  const appends = [];
  const stamp = new Date().toISOString();
  const put = (key, value) => {
    const row = [key, cell(value), ...(timestamp ? [stamp] : [])];
    if (index.has(key)) writes.push({ range: `${quoteSheet(tab)}!A${index.get(key)}`, values: [row] });
    else appends.push(row);
  };
  for (const [key, raw] of Object.entries(entries)) {
    const value = typeof raw === 'object' && raw !== null ? JSON.stringify(raw) : raw;
    const text = value === null || value === undefined ? '' : String(value);
    if (text.length > MAX_CELL_CHARS) {
      const n = Math.ceil(text.length / MAX_CELL_CHARS);
      put(key, ''); // marker row keeps the key visible
      for (let i = 0; i < n; i++) put(`${key}.chunk${i}`, text.slice(i * MAX_CELL_CHARS, (i + 1) * MAX_CELL_CHARS));
      // stale chunks beyond n are cleared
      for (const [k, rowNo] of index) {
        const m = k.match(new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.chunk(\\d+)$`));
        if (m && Number(m[1]) >= n) writes.push({ range: `${quoteSheet(tab)}!A${rowNo}`, values: [['', '', stamp]] });
      }
    } else {
      put(key, text);
      for (const [k, rowNo] of index) {
        if (k.startsWith(`${key}.chunk`)) writes.push({ range: `${quoteSheet(tab)}!A${rowNo}`, values: [['', '', stamp]] });
      }
    }
  }
  if (writes.length) await client.batchUpdateValues(id, writes);
  if (appends.length) await client.append(id, `${quoteSheet(tab)}!A1`, appends);
}

// --- tables ----------------------------------------------------------------------

export async function readTable(client, id, tab) {
  const header = TABS[tab].header;
  const lastCol = columnLetter(header.length);
  const [vr] = await client.batchGet(id, [`${quoteSheet(tab)}!A1:${lastCol}${LIMITS.records_per_table + 1}`]);
  const actualHeader = (vr.values[0] || []).map(String);
  const useHeader = actualHeader.length ? actualHeader : header;
  return { header: useHeader, rows: rowsToObjects(useHeader, vr.values.slice(1)), rawRows: vr.values };
}

export async function replaceTable(client, id, tab, objects) {
  const header = TABS[tab].header;
  const lastCol = columnLetter(header.length);
  await client.clear(id, `${quoteSheet(tab)}!A1:${lastCol}`);
  const values = [header, ...objectsToRows(header, objects)];
  // Write in chunks to stay well under request size limits.
  const CHUNK = 2000;
  for (let i = 0; i < values.length; i += CHUNK) {
    await client.update(id, `${quoteSheet(tab)}!A${i + 1}`, values.slice(i, i + CHUNK));
  }
}

export async function appendRows(client, id, tab, objects) {
  const header = TABS[tab].header;
  if (!objects.length) return;
  await client.append(id, `${quoteSheet(tab)}!A1`, objectsToRows(header, objects));
}

export async function upsertRows(client, id, tab, keyField, objects) {
  const header = TABS[tab].header;
  const { rawRows } = await readTable(client, id, tab);
  const keyIdx = header.indexOf(keyField);
  const index = new Map();
  rawRows.forEach((r, i) => { if (i > 0 && r[keyIdx] !== undefined && r[keyIdx] !== '') index.set(String(r[keyIdx]), i + 1); });
  const writes = [];
  const appends = [];
  for (const o of objects) {
    const row = header.map(h => cell(o[h]));
    const key = String(o[keyField]);
    if (index.has(key)) writes.push({ range: `${quoteSheet(tab)}!A${index.get(key)}`, values: [row] });
    else appends.push(row);
  }
  if (writes.length) await client.batchUpdateValues(id, writes);
  if (appends.length) await client.append(id, `${quoteSheet(tab)}!A1`, appends);
  return { updated: writes.length, appended: appends.length };
}

export function columnLetter(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// Trim a worker-owned history tab to its retention limit (keeps the newest rows).
export async function trimTable(client, id, tab, keep) {
  const { rows } = await readTable(client, id, tab);
  if (rows.length <= keep) return;
  await replaceTable(client, id, tab, rows.slice(rows.length - keep));
}

export function parseJsonCell(text, fallback = null) {
  if (text === null || text === undefined || text === '') return fallback;
  try { return JSON.parse(String(text)); } catch { return fallback; }
}

// --- canonical record <-> stored row -------------------------------------------
// Money is calculated in integer cents but stored in the workbook in major units
// (RM 9,000 is stored as 9000) so the workspace stays human-readable.

export function toStoredRow(entity, record) {
  const fields = ENTITIES[entity].fields;
  const out = {};
  for (const [k, v] of Object.entries(record)) {
    if (k === '_row') continue;
    if (fields[k]?.type === 'money' && typeof v === 'number') out[k] = v / 100;
    else out[k] = v;
  }
  return out;
}

export function fromStoredRow(entity, row) {
  const fields = ENTITIES[entity].fields;
  const out = {};
  for (const [k, spec] of Object.entries(fields)) {
    const v = row[k];
    if (v === '' || v === undefined || v === null) { out[k] = spec.type === 'text' ? '' : (spec.default ?? null); continue; }
    switch (spec.type) {
      case 'money': out[k] = Math.round(Number(v) * 100); break;
      case 'integer': out[k] = Number(v); break;
      case 'date': out[k] = String(v); break;
      default: out[k] = String(v);
    }
  }
  out.status_text = row.status_text === undefined ? '' : String(row.status_text);
  out._source = row._source === undefined ? '' : String(row._source);
  return out;
}
