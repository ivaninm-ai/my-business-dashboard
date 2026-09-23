// Test environment: fake Google server + ephemeral service-account key + helpers
// that play the browser's role (owner token) and the admin's role (sharing).
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeGoogle } from '../fake-google/server.mjs';
import { createSheetsClient } from '../../app/shared/sheets.mjs';
import { ensureWorkspace, writeKeyValues, upsertRows, readTable, readKeyValues } from '../../app/shared/workspace.mjs';
import { readCsv, sheetify } from './csv.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(here, '../..');
export const OWNER = 'owner@example.com';
export const SA_EMAIL = 'dashboard-worker@example-project.iam.gserviceaccount.com';

export async function startFakeEnv() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const credentials = { type: 'service_account', client_email: SA_EMAIL, private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'ignored' };
  const fake = createFakeGoogle();
  const port = await fake.listen(0);
  const base = `http://127.0.0.1:${port}`;
  process.env.GOOGLE_API_BASE = base;
  process.env.GOOGLE_TOKEN_URL = `${base}/token`;
  const admin = async (p, body) => (await fetch(`${base}/_admin/${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })).json();
  const browser = createSheetsClient({ apiBase: base, getToken: async () => `mock:${OWNER}` });
  const stranger = createSheetsClient({ apiBase: base, getToken: async () => 'mock:stranger@example.com' });
  return {
    fake, base, credentials, admin, browser, stranger,
    async close() { await fake.close(); delete process.env.GOOGLE_API_BASE; delete process.env.GOOGLE_TOKEN_URL; },
    async dump(id) { return (await fetch(`${base}/_admin/dump?id=${id}`)).json(); },
    // Source workbook from fixture CSVs (owned by the student, shared as chosen).
    async createSourceFromFixture(business, day, { shareWithWorker = true, renameHeaders = null, sheetNames = null } = {}) {
      const dir = path.join(ROOT, 'test/fixtures/betterspace', business, day);
      const sheets = [];
      for (const name of ['Customers', 'Sales', 'Payments', 'Stock']) {
        let rows = sheetify(readCsv(path.join(dir, `${name}.csv`)));
        if (renameHeaders) rows = [rows[0].map(h => renameHeaders[h] || h), ...rows.slice(1)];
        sheets.push({ title: sheetNames?.[name] || name, values: rows });
      }
      const { id } = await admin('create', { title: `BetterSpace ${business.toUpperCase()} ${day}`, owner: OWNER, acl: shareWithWorker ? { [SA_EMAIL]: 'reader' } : {}, sheets });
      return id;
    },
    async replaceSourceFromFixture(id, business, day) {
      const dir = path.join(ROOT, 'test/fixtures/betterspace', business, day);
      for (const name of ['Customers', 'Sales', 'Payments', 'Stock']) {
        const rows = sheetify(readCsv(path.join(dir, `${name}.csv`)));
        await admin('set-values', { id, range: `${name}!A1`, values: [] });
        // clear then write: emulate a full replacement paste
        const dumpBefore = await this.dump(id);
        const sheet = dumpBefore.sheets.find(s => s.title === name);
        const blank = sheet.values.map(r => r.map(() => ''));
        if (blank.length) await admin('set-values', { id, range: `${name}!A1`, values: blank });
        await admin('set-values', { id, range: `${name}!A1`, values: rows });
      }
    },
    // The browser's flow: create the workspace under drive.file, initialise tabs, share with worker as Editor.
    async createWorkspace({ shareWithWorker = true } = {}) {
      const created = await browser.create('Dashboard Workspace (test)', ['_Workspace']);
      await ensureWorkspace(browser, created.id, { appVersion: 'test', actor: OWNER });
      if (shareWithWorker) await admin('share', { id: created.id, principal: SA_EMAIL, role: 'writer' });
      return created.id;
    },
    async importPackage(workspaceId, pkg) {
      await writeKeyValues(browser, workspaceId, 'Settings', { setup_package: pkg, package_id: pkg.package_id, business_name: pkg.business.name, imported_at: new Date().toISOString() });
    },
    async bindSource(workspaceId, sourceId, spreadsheetId, label = 'Test source') {
      await upsertRows(browser, workspaceId, 'Sources', 'source_id', [{ source_id: sourceId, kind: 'google_sheet', spreadsheet_id: spreadsheetId, label, refresh: 'scheduled', updated_at: new Date().toISOString() }]);
    },
    async saveDecision(workspaceId, decision) {
      await upsertRows(browser, workspaceId, 'Task_Decisions', 'task_key', [{ updated_at: new Date().toISOString(), updated_by: OWNER, ...decision }]);
    },
    async read(workspaceId, tab) { return (await readTable(browser, workspaceId, tab)).rows; },
    async meta(workspaceId) { return (await readKeyValues(browser, workspaceId, '_Workspace')).values; },
    loadPackage(business) { return JSON.parse(readFileSync(path.join(ROOT, 'config/examples', `betterspace-${business}.setup-package.json`), 'utf8')); },
  };
}
