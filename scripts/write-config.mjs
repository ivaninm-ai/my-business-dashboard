// Generates app/config.json for publishing from repository VARIABLES only.
// Never reads secrets. Run by the "Publish dashboard" workflow.
import { readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const [owner = '', name = ''] = (process.env.GITHUB_REPOSITORY || '/').split('/');
const clientId = (process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
if (clientId && !/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(clientId)) {
  console.error(`GOOGLE_OAUTH_CLIENT_ID does not look like a Google OAuth client ID (expected ...apps.googleusercontent.com). Got ${clientId.length} characters.`);
  process.exit(1);
}
for (const [k, v] of Object.entries(process.env)) {
  if (/PRIVATE KEY|sk-ant-/.test(String(v)) && ['GOOGLE_OAUTH_CLIENT_ID', 'BUSINESS_LABEL'].includes(k)) {
    console.error(`${k} contains secret-like content; refusing to publish.`);
    process.exit(1);
  }
}
const cfg = {
  app_version: pkg.version,
  auth: { mode: 'google', client_id: clientId },
  google_api_base: 'https://sheets.googleapis.com',
  repo: { owner, name },
  business_label: (process.env.BUSINESS_LABEL || '').trim().slice(0, 80),
  published_at: new Date().toISOString(),
};
writeFileSync('app/config.json', JSON.stringify(cfg, null, 2) + '\n');
console.log(`config.json written (client_id set: ${!!clientId}, repo: ${owner}/${name})`);
