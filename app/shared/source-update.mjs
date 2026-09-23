// Reviewed file updates affect one manual source, never the setup or live links.
import { applyTableMapping } from './mapping.mjs';
import { manualRowsFromPackage } from './package.mjs';
import { parseJsonCell, LIMITS, writeKeyValues, readKeyValues } from './workspace.mjs';
import { isIsoDate } from './dates.mjs';

export function sourceUpdateRecipe(pkg, sourceId) {
  const source = pkg.sources.find(s => s.source_id === sourceId);
  if (source?.kind !== 'manual_package') throw new Error('Choose a manual file source.');
  return {
    purpose: 'Attach this recipe and your new file to Claude using the dashboard onboarding skill. Return a source-update.json, not a new setup package.',
    source, tables: pkg.tables.filter(t => t.source_id === sourceId), policies: pkg.policies, status_map: pkg.status_map,
    format: { update_version: '1.0', source_id: sourceId, mode: 'replace', data_as_of: 'YYYY-MM-DD', file_name: 'original-file-name', confirmed: true, records: 'Object keyed by entity, with reviewed rows using canonical field names and original status values; include every table in this source.' },
    modes: { replace: 'Complete replacement snapshot for this source only', append: 'Additional records; identical IDs are skipped, changed duplicates are rejected', upsert: 'Full corrected records matched by stable ID; missing records are retained' },
  };
}

export function prepareSourceUpdate(pkg, settings, update, stamp = new Date().toISOString()) {
  const fail = msg => { throw new Error(msg); };
  if (!update || update.update_version !== '1.0' || update.confirmed !== true) fail('Confirm the source update before saving.');
  const allowed = ['update_version', 'source_id', 'mode', 'data_as_of', 'file_name', 'confirmed', 'records'];
  if (Object.keys(update).some(k => !allowed.includes(k))) fail('The update includes unexpected fields. It must contain records for one source only.');
  const source = pkg.sources.find(s => s.source_id === update.source_id);
  if (source?.kind !== 'manual_package') fail('This update must target an existing manual file source, not a Google Sheet.');
  if (!['replace', 'append', 'upsert'].includes(update.mode)) fail('Choose replace, append, or upsert.');
  if (!isIsoDate(update.data_as_of)) fail('Provide the date these records describe (data_as_of), not an invented date.');
  if (typeof update.file_name !== 'string' || !update.file_name.trim() || update.file_name.length > 200) fail('Include the original file name (up to 200 characters).');
  const tables = pkg.tables.filter(t => t.source_id === source.source_id);
  const records = update.records;
  if (!records || Array.isArray(records) || typeof records !== 'object') fail('records must contain the reviewed tables.');
  if (Object.keys(records).length !== tables.length || tables.some(t => !Array.isArray(records[t.entity]))) fail('Include every table belonging to this source, and no tables from another source.');
  const raw = manualRowsFromPackage({ ...pkg, tables, records });
  const entries = {}, preview = [];
  for (const table of tables) {
    if (table.identity?.mode === 'row_number') fail('File updates require stable record IDs. Remap this source before updating.');
    const knownFields = new Set(table.fields.map(f => f.canonical));
    for (const row of records[table.entity]) {
      if (!row || Array.isArray(row) || typeof row !== 'object' || Object.keys(row).some(k => !knownFields.has(k))) fail(`${table.entity}: use only fields declared in the source recipe.`);
      if (Object.values(row).some(v => v !== null && typeof v === 'object')) fail(`${table.entity}: nested values are not supported.`);
    }
    const key = `manual_rows.${table.table_id}`;
    const incoming = raw[key];
    const prior = parseJsonCell(settings[key], null);
    const parse = rows => {
      const mapped = applyTableMapping(table, rows, pkg);
      const errors = mapped.issues.filter(i => i.level === 'error');
      if (errors.length) fail(errors[0].message);
      return mapped.records;
    };
    const nextRecords = parse(incoming);
    const oldRecords = prior ? parse(prior) : [];
    let merged = incoming, skipped = 0;
    if (update.mode !== 'replace' && prior) {
      merged = prior.map(r => [...r]);
      const existing = new Map(oldRecords.map(r => [r.id, r]));
      const comparable = r => JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_'))));
      for (const rec of nextRecords) {
        const old = existing.get(rec.id);
        if (old && comparable(old) === comparable(rec)) { skipped++; continue; }
        if (old && update.mode === 'append') fail(`Record ${rec.id} already exists with different values. Use corrected-record update or review the duplicate in the source.`);
        const row = incoming[rec._row - 1];
        if (old) merged[old._row - 1] = row;
        else merged.push(row);
      }
    }
    const mergedRecords = parse(merged);
    if (mergedRecords.length > LIMITS.records_per_table) fail(`${table.entity} exceeds the ${LIMITS.records_per_table}-row limit.`);
    const nextIds = new Set(mergedRecords.map(r => r.id));
    preview.push({ entity: table.entity, before: oldRecords.length, after: mergedRecords.length, removed: oldRecords.filter(r => !nextIds.has(r.id)).length, skipped });
    entries[key] = merged;
  }
  entries[`source_meta.${source.source_id}`] = { source_id: source.source_id, kind: source.kind, label: source.label || source.source_id, data_as_of: update.data_as_of, uploaded_at: stamp, file_name: update.file_name, mode: update.mode };
  return { entries, preview, source, mode: update.mode };
}

export async function saveSourceUpdate(client, workspaceId, pkg, update, { expectedSettings } = {}) {
  const { values: meta } = await readKeyValues(client, workspaceId, '_Workspace');
  if (meta.lease_holder && Date.parse(meta.lease_expires) > Date.now()) throw new Error('An import is running. Wait for it to finish, then preview this file again.');
  const { values: settings } = await readKeyValues(client, workspaceId, 'Settings');
  if (expectedSettings && settings.setup_package !== expectedSettings.setup_package) throw new Error('The setup changed. Reload and preview again.');
  const prepared = prepareSourceUpdate(pkg, settings, update);
  if (expectedSettings && Object.keys(prepared.entries).some(k => settings[k] !== expectedSettings[k])) throw new Error('This source changed since the preview. Preview again before saving.');
  await writeKeyValues(client, workspaceId, 'Settings', prepared.entries);
  return prepared;
}
