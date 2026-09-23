import { ENTITIES, TASK_RULES } from './model.mjs';
import { applyTableMapping } from './mapping.mjs';
import { validatePackage } from './package.mjs';
import { readKeyValues, writeKeyValues, parseJsonCell, upsertRows } from './workspace.mjs';
import { isIsoDate } from './dates.mjs';

export const SETUP_LIMITS = { fileBytes: 10000000, textChars: 80000, stagedChars: 1500000, tables: 12, columns: 100, rows: 5000 };
export function validateInput(input) {
  if (JSON.stringify(input).length > SETUP_LIMITS.stagedChars) throw new Error('This source is too large. Use a smaller export (maximum 1.5 million extracted characters).');
  if (input.text && input.text.length > SETUP_LIMITS.textChars) throw new Error('Document exceeds 80,000 extracted characters. Split it into smaller documents.');
  if (!Array.isArray(input.tables) || input.tables.length > SETUP_LIMITS.tables) throw new Error('Use at most 12 worksheets per source.');
  const names = new Set();
  for (const table of input.tables) {
    if (!table.name || names.has(table.name)) throw new Error('Each worksheet needs a different name.');
    names.add(table.name);
    if (!Array.isArray(table.rows) || table.rows.length > SETUP_LIMITS.rows + 20) throw new Error(`${table.name}: maximum 5,000 data rows plus header rows.`);
    for (const row of table.rows) {
      if (!Array.isArray(row) || row.length > SETUP_LIMITS.columns || row.some(v => v !== null && !['string', 'number', 'boolean'].includes(typeof v))) throw new Error(`${table.name}: unsupported or oversized row.`);
    }
  }
  return input;
}

export function businessProfile(profile) {
  const business = { name: String(profile.name || '').trim(), model: profile.model || 'other', industry: profile.industry || '', description: profile.description || '', timezone: profile.timezone || 'Asia/Kuala_Lumpur', currency: String(profile.currency || 'MYR').toUpperCase(), locale: profile.locale || 'en', ai_guidance: profile.ai_guidance || '', synthetic: profile.synthetic === true };
  if (!business.name) throw new Error('Enter your business name.');
  try { new Intl.DateTimeFormat('en', { timeZone: business.timezone }); } catch { throw new Error('Choose a valid timezone.'); }
  if (!/^[A-Z]{3}$/.test(business.currency)) throw new Error('Currency must be a three-letter code, such as MYR.');
  return business;
}

// Proposals cannot commit changes. The browser invokes this only after review.
export function prepareSetup({ request, proposal, previous, schema, actor = 'owner' }) {
  const source = request.source;
  if (!source || !/^[A-Za-z0-9_-]{1,40}$/.test(source.source_id)) throw new Error('Invalid source.');
  const input = validateInput(proposal.input);
  const selections = proposal.selections || [];
  if (!selections.length) throw new Error('Select at least one supported table.');
  const pkg = previous ? structuredClone(previous) : {
    package_version: '1.0', package_id: 'dashboard_setup', generated_at: new Date().toISOString(),
    confirmation: { state: 'confirmed' }, business: businessProfile(request.profile), reporting_date: { mode: 'today' },
    modules: {}, sources: [], tables: [], policies: { dates: { order: 'dmy' }, money: { unit: 'major' }, tasks: [] },
  };
  pkg.business = businessProfile(request.profile);
  pkg.reporting_date = { mode: request.reportingMode || 'today' };
  const oldTables = pkg.tables.filter(t => t.source_id === source.source_id);
  pkg.tables = pkg.tables.filter(t => t.source_id !== source.source_id);
  pkg.sources = pkg.sources.filter(s => s.source_id !== source.source_id);
  pkg.sources.push({ source_id: source.source_id, kind: source.kind, label: source.label, ...(source.kind === 'google_sheet' ? { spreadsheet_id: source.spreadsheet_id, refresh: 'scheduled' } : { refresh: 'manual' }) });
  // Initial packages may contain embedded records. Saved rows are authoritative thereafter.
  delete pkg.records; delete pkg.validation;
  if (selections.some(s => s.entity === 'sales')) pkg.status_map = proposal.status_map;
  const entries = {}, preview = [];
  for (const selection of selections) {
    if (!ENTITIES[selection.entity]) throw new Error('Choose a supported table type.');
    if (pkg.tables.some(t => t.entity === selection.entity)) throw new Error(`${selection.entity} already has an authoritative source. Edit that source instead of adding a duplicate.`);
    const inputTable = input.tables.find(t => t.name === selection.name);
    if (!inputTable) throw new Error(`Missing worksheet: ${selection.name}`);
    const table = { table_id: oldTables.find(t => t.entity === selection.entity)?.table_id || `${source.source_id.slice(0,25)}_${selection.entity}`, source_id: source.source_id, entity: selection.entity,
      sheet_name: selection.name, header_row: Number(selection.header_row || 1), row_meaning: ENTITIES[selection.entity].row_meaning,
      fields: selection.fields.filter(f => f.header).map(f => ({ canonical: f.canonical, header: f.header, ...(ENTITIES[selection.entity].fields[f.canonical]?.type === 'date' ? { date_order: proposal.dateOrder || 'dmy' } : {}), ...(f.values ? { values: f.values } : {}) })), identity: { mode: 'source_id' }, load: { mode: 'replace' } };
    if (!Number.isInteger(table.header_row) || table.header_row < 1 || table.header_row > inputTable.rows.length) throw new Error('Choose the row containing column names.');
    const headers = inputTable.rows[table.header_row - 1].map(v => String(v ?? '').trim().toLowerCase());
    for (const f of table.fields) if (headers.filter(h => h === f.header.trim().toLowerCase()).length !== 1) throw new Error(`Column "${f.header}" is missing or duplicated. Choose a unique column.`);
    if (table.entity === 'stock' && source.kind === 'manual_package' && !table.fields.some(f => f.canonical === 'snapshot_date') && isIsoDate(request.dataAsOf)) {
      table.fields.push({ canonical: 'snapshot_date', constant: request.dataAsOf, note: 'Stock count date confirmed by owner in File data as of.' });
    }
    pkg.tables.push(table);
    const result = applyTableMapping(table, inputTable.rows, pkg);
    const errors = result.issues.filter(i => i.level === 'error');
    if (errors.length) throw new Error(errors.slice(0, 3).map(e => e.message).join('\n'));
    if (result.records.length > SETUP_LIMITS.rows) throw new Error('Maximum 5,000 records per table.');
    preview.push({ entity: table.entity, rows: result.records.length, amount: result.records.reduce((sum, r) => sum + (r.amount || 0), 0) / 100, warnings: result.issues.filter(i => i.level !== 'error').map(i => i.message) });
    if (source.kind === 'manual_package') entries[`manual_rows.${table.table_id}`] = inputTable.rows;
  }
  if (oldTables.some(t => !pkg.tables.some(n => n.table_id === t.table_id))) throw new Error('Include every table already belonging to this source; removing tables is not supported by this update.');
  const priorRules = new Map((pkg.policies.tasks || []).map(r => [r.rule, r]));
  pkg.policies.tasks = Object.entries(TASK_RULES).filter(([, r]) => r.needs.every(e => pkg.tables.some(t => t.entity === e))).map(([rule]) => priorRules.get(rule) || { rule, enabled: true });
  pkg.confirmation = { state: 'confirmed', confirmed_by: actor, confirmed_at: new Date().toISOString(), open_questions: [] };
  const valid = validatePackage(pkg, schema);
  if (!valid.ok) throw new Error(valid.errors.slice(0, 3).join('\n'));
  if (source.kind === 'manual_package') {
    if (!isIsoDate(request.dataAsOf)) throw new Error('Choose the date these file records describe.');
    entries[`source_meta.${source.source_id}`] = { source_id: source.source_id, kind: source.kind, label: source.label, data_as_of: request.dataAsOf, file_name: request.fileName || source.label, uploaded_at: new Date().toISOString(), mode: 'replace' };
  }
  return { pkg, entries, preview };
}

export async function saveSetup(client, workspaceId, prepared, request, expectedSettings) {
  const { values: meta } = await readKeyValues(client, workspaceId, '_Workspace');
  if (meta.lease_holder && Date.parse(meta.lease_expires) > Date.now()) throw new Error('Import is running. Wait, then preview again.');
  const { values: current } = await readKeyValues(client, workspaceId, 'Settings');
  if ((current.setup_package || '') !== (expectedSettings.setup_package || '') || Object.keys(prepared.entries).some(k => current[k] !== expectedSettings[k])) throw new Error('This source changed after preview. Reload and review it again.');
  if (parseJsonCell(current.setup_request)?.id !== request.id) throw new Error('A newer source request exists. Reload before saving.');
  await writeKeyValues(client, workspaceId, 'Settings', { ...prepared.entries, setup_package: prepared.pkg, business_profile: prepared.pkg.business, ai_data_mode: request.aiDataMode, setup_request: '', imported_at: new Date().toISOString() });
  if (request.source.kind === 'google_sheet') await upsertRows(client, workspaceId, 'Sources', 'source_id', [{ ...request.source, refresh: 'scheduled', updated_at: new Date().toISOString() }]);
}
