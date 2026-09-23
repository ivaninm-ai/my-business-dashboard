#!/usr/bin/env node
// Runs a worker command against the simulation server started by
// `npm run fake-google`. Usage: node test/sim/worker.mjs <setup|import|ai|install-check> <workspaceId> [--day day2]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const sim = JSON.parse(readFileSync(path.join(here, '../.state/sim.json'), 'utf8'));
const sa = readFileSync(path.join(here, '../.state/sa.json'), 'utf8');
const [, , command, workspaceId, ...rest] = process.argv;
const base = `http://127.0.0.1:${sim.port}`;
const dayIdx = rest.indexOf('--day');
if (dayIdx >= 0) {
  const day = rest[dayIdx + 1];
  const r = await fetch(`${base}/_admin/load-fixture`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: sim.sourceId, business: sim.business, day }) });
  console.log(`source workbook replaced with ${sim.business} ${day}: ${r.status}`);
  if (!command) process.exit(0);
}
const env = { ...process.env, GOOGLE_API_BASE: base, GOOGLE_TOKEN_URL: `${base}/token`, GOOGLE_SERVICE_ACCOUNT_JSON: sa, DASHBOARD_WORKSPACE_ID: workspaceId || '', GEMINI_API_KEY: process.env.GEMINI_API_KEY || '' };
const r = spawnSync(process.execPath, [path.join(here, '../../worker/run.mjs'), command], { env, stdio: 'inherit' });
process.exit(r.status ?? 1);
