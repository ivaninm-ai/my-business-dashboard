// Guards that keep the skill, the app and the docs on the same contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const skillDir = path.join(root, '..', 'skill', 'business-dashboard-onboarding');

test('skill schema copy is identical to the app schema (when the skill directory is present)', { skip: !existsSync(skillDir) }, () => {
  const a = readFileSync(path.join(root, 'app/shared/setup-package.schema.json'), 'utf8');
  const b = readFileSync(path.join(skillDir, 'assets/setup-package.schema.json'), 'utf8');
  assert.equal(a, b);
  for (const f of ['betterspace-b2b', 'betterspace-b2c', 'demo-physio-studio']) {
    assert.equal(readFileSync(path.join(root, 'config/examples', `${f}.setup-package.json`), 'utf8'), readFileSync(path.join(skillDir, 'assets/examples', `${f}.setup-package.json`), 'utf8'), `${f} example differs`);
  }
});

test('no secret-like content in publishable app files or fixtures', async () => {
  const { readdirSync, statSync } = await import('node:fs');
  const walk = dir => readdirSync(dir).flatMap(n => { const p = path.join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const files = [...walk(path.join(root, 'app')), ...walk(path.join(root, 'test/fixtures')), ...walk(path.join(root, 'config'))];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    assert.ok(!/BEGIN (RSA )?PRIVATE KEY|sk-ant-|"private_key"\s*:/.test(text), `${path.relative(root, f)} looks like it contains a key`);
    const addresses = (text.match(/[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com/gi) || []).filter(a => !a.startsWith('name@project'));
    assert.deepEqual(addresses, [], `${path.relative(root, f)} contains a service-account address`);
  }
});
