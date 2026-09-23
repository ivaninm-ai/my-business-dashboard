#!/usr/bin/env node
// Worker entry point used by the prepared GitHub workflows.
//   node worker/run.mjs install-check
//   node worker/run.mjs import [--scheduled]
//   node worker/run.mjs ai [--mode after_import|manual|requests]
//   node worker/run.mjs validate-package <file.json>
// Secrets come from the environment (GitHub Secrets/Variables). Nothing here
// prints cell contents, tokens or keys.

import { readFileSync, appendFileSync } from 'node:fs';
import { parseServiceAccount } from './google-auth.mjs';
import { runImport, ImportError, SCHEMA } from './importer.mjs';
import { runOnboarding } from './onboarding.mjs';
import { runAi, DEFAULT_MODEL } from './ai.mjs';
import { runInstallCheck } from './install-check.mjs';
import { validatePackage } from '../app/shared/package.mjs';

const [, , command = 'help', ...rest] = process.argv;
const flag = name => { const i = rest.indexOf(name); return i === -1 ? null : (rest[i + 1] ?? true); };
const runId = process.env.GITHUB_RUN_ID ? `gh_${process.env.GITHUB_RUN_ID}_${process.env.GITHUB_RUN_ATTEMPT || 1}` : `local_${Date.now()}`;

function summary(lines) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n'); } catch { /* ignore */ }
  }
}

function importOutput(status) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `import_status=${status}\n`);
}

async function main() {
  if (command === 'help') {
    console.log('Commands: install-check | import [--scheduled] | ai [--mode after_import|manual|requests] | validate-package <file>');
    return;
  }
  if (command === 'validate-package') {
    const file = rest[0];
    if (!file) throw new Error('Usage: validate-package <file.json>');
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    const v = validatePackage(pkg, SCHEMA);
    console.log(JSON.stringify(v, null, 2));
    process.exitCode = v.ok ? 0 : 1;
    return;
  }
  // The hourly schedule starts as soon as a repository is created from the template. Until
  // the owner has added the keys, scheduled runs finish quietly instead of failing, so
  // GitHub does not e-mail "Run failed" every hour during installation. Manual runs still
  // report missing secrets.
  const scheduled = flag('--scheduled') || process.env.GITHUB_EVENT_NAME === 'schedule';
  if (scheduled && ['setup', 'import'].includes(command) && (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON || !(process.env.DASHBOARD_WORKSPACE_ID || '').trim())) {
    if (command === 'import') importOutput('skipped');
    console.log('Scheduled run skipped: installation not finished (GOOGLE_SERVICE_ACCOUNT_JSON or DASHBOARD_WORKSPACE_ID is not set yet).');
    return;
  }
  const credentials = parseServiceAccount(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const workspaceId = (process.env.DASHBOARD_WORKSPACE_ID || '').trim();
  if (command === 'install-check') {
    const report = await runInstallCheck({ credentials, workspaceId, runId, aiKeyPresent: !!process.env.GEMINI_API_KEY });
    const lines = ['## Install check', '', '| Check | Result | Detail |', '|---|---|---|'];
    for (const c of report.checks) { lines.push(`| ${c.name} | ${c.ok ? '✅' : '❌'} | ${c.detail.replace(/\|/g, '\\|')} |`); console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ' — ' + c.detail : ''}`); }
    lines.push('', report.ok ? '**Install check passed.**' : '**Install check found problems.** Fix the ❌ rows and run again.');
    summary(lines);
    console.log(report.ok ? 'Install check passed' : 'Install check found problems');
    process.exitCode = report.ok ? 0 : 1;
    return;
  }
  if (!workspaceId) throw new Error('DASHBOARD_WORKSPACE_ID secret is not set.');
  if (command === 'setup') {
    const result = await runOnboarding({ credentials, workspaceId, apiKey: process.env.GEMINI_API_KEY || '', model: process.env.AI_MODEL || DEFAULT_MODEL });
    console.log('Source preparation: ' + result.status + '. Review Business setup in your private dashboard.');
    return;
  }
  if (command === 'import') {
    importOutput('skipped');
    if (flag('--scheduled')) {
      const hours = (process.env.REFRESH_HOURS_UTC || '23').split(',').map(s => s.trim()).filter(Boolean);
      const hour = String(new Date().getUTCHours());
      if (hours[0] === 'off' || !hours.includes(hour)) { console.log(`Scheduled run skipped: current UTC hour ${hour} is not in REFRESH_HOURS_UTC (${hours.join(',')}).`); return; }
    }
    try {
      const result = await runImport({ credentials, workspaceId, runId });
      const ok = ['success', 'unchanged', 'no_setup'].includes(result.status);
      importOutput(result.status);
      console.log(`Import ${result.status}. Open Data connections in your private dashboard for details.`);
      summary(['## Import', '', `**${result.status}** — Open Data connections in your dashboard for details. Business records are never printed in public workflow logs.`]);
      process.exitCode = ok ? 0 : 1;
    } catch (e) {
      if (e instanceof ImportError && e.code === 'busy') { importOutput('busy'); console.log('Another import is running. Try again when it finishes.'); return; }
      throw e;
    }
    return;
  }
  if (command === 'ai') {
    const mode = flag('--mode') || (process.env.AI_AUTO === 'off' ? 'requests' : 'after_import');
    const model = (process.env.AI_MODEL || DEFAULT_MODEL).trim();
    const result = await runAi({ credentials, workspaceId, apiKey: process.env.GEMINI_API_KEY || '', model, mode, runId, log: m => console.log(m) });
    summary(['## AI brief', '', `**${result.status}** — Open AI insights in your dashboard for private results and error details.`]);
    process.exitCode = result.status === 'failed' ? 1 : 0;
    return;
  }
  throw new Error(`Unknown command "${command}"`);
}

main().catch(e => {
  const message = process.env.GITHUB_STEP_SUMMARY ? 'Worker failed. Check the installation steps and the private dashboard status; business details are omitted from public logs.' : e.message;
  console.error(message);
  summary(['## Worker failed', '', message]);
  process.exitCode = 1;
});
