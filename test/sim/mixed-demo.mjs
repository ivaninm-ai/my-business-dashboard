// Seed only the local fake Google server for a reproducible browser walkthrough.
import { readFileSync, writeFileSync } from 'node:fs';
import { createSheetsClient } from '../../app/shared/sheets.mjs';
import { writeKeyValues, upsertRows, readTable } from '../../app/shared/workspace.mjs';
import { manualRowsFromPackage } from '../../app/shared/package.mjs';
import { runImport } from '../../worker/importer.mjs';
const sim = JSON.parse(readFileSync('test/.state/sim.json', 'utf8'));
const credentials = JSON.parse(readFileSync('test/.state/sa.json', 'utf8'));
const base = `http://127.0.0.1:${sim.port}`;
process.env.GOOGLE_API_BASE = base; process.env.GOOGLE_TOKEN_URL = `${base}/token`;
const ws = process.argv[2];
if (!ws?.startsWith('fake')) throw new Error('Pass a workspace ID from the local simulation only.');
const client = createSheetsClient({ apiBase: base, getToken: async () => 'mock:owner@example.com' });
await fetch(`${base}/_admin/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ws, principal: sim.serviceAccount, role: 'writer' }) });
const pkg = JSON.parse(readFileSync('config/examples/betterspace-b2b.setup-package.json', 'utf8'));
await writeKeyValues(client, ws, 'Settings', { setup_package: pkg });
await upsertRows(client, ws, 'Sources', 'source_id', [{ source_id: 'main', kind: 'google_sheet', spreadsheet_id: sim.sourceId, label: 'Live sales and customers', refresh: 'scheduled' }]);
await runImport({ credentials, workspaceId: ws });
pkg.sources.push({ source_id: 'excel', kind: 'manual_package', label: 'Inventory Excel', refresh: 'manual' }, { source_id: 'pdf', kind: 'manual_package', label: 'Payment PDF', refresh: 'manual' });
pkg.records = {};
for (const entity of ['stock', 'payments']) {
  const table = pkg.tables.find(t => t.entity === entity);
  table.source_id = entity === 'stock' ? 'excel' : 'pdf';
  const fields = new Set(table.fields.map(f => f.canonical));
  pkg.records[entity] = (await readTable(client, ws, `Data_${entity}`)).rows.map(row => Object.fromEntries(Object.entries(row).filter(([k, v]) => fields.has(k) && v !== '')));
}
await writeKeyValues(client, ws, 'Settings', { setup_package: pkg, ...manualRowsFromPackage(pkg) });
await runImport({ credentials, workspaceId: ws });
const stock = structuredClone(pkg.records.stock); stock.find(r => r.id === 'T001').on_hand = 999;
writeFileSync('test/.state/source-update.json', JSON.stringify({ update_version: '1.0', source_id: 'excel', mode: 'replace', data_as_of: '2026-08-31', file_name: 'inventory-aug31.xlsx', confirmed: true, records: { stock } }, null, 2));
console.log('Synthetic mixed sources seeded; test/.state/source-update.json is ready for the browser preview.');
