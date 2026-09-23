// Service-account authentication for the background worker (evolved from the
// connection pilot). Sources are read with the read-only scope; the workspace is
// written with the full Sheets scope. Hosts are fixed Google endpoints unless a
// test explicitly overrides them through the environment.

import { createPrivateKey, createSign } from 'node:crypto';

export const SCOPES = {
  readonly: 'https://www.googleapis.com/auth/spreadsheets.readonly',
  write: 'https://www.googleapis.com/auth/spreadsheets',
};

export function tokenUrl() { return process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token'; }
export function apiBase() { return process.env.GOOGLE_API_BASE || 'https://sheets.googleapis.com'; }

export function parseServiceAccount(text) {
  let credentials;
  try { credentials = JSON.parse(text || ''); }
  catch { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is missing or is not the complete JSON key. Paste the whole downloaded key file into the repository secret.'); }
  if (credentials?.type !== 'service_account' || typeof credentials.client_email !== 'string' || !credentials.client_email.endsWith('.iam.gserviceaccount.com')) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not a service-account key from your own Google Cloud project.');
  }
  try {
    const key = createPrivateKey(credentials.private_key);
    if (key.asymmetricKeyType !== 'rsa') throw new Error();
  } catch {
    throw new Error('The service-account private key is missing or invalid. Create a new JSON key and replace the secret.');
  }
  return credentials;
}

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

export function signAssertion(credentials, scope, now = Date.now) {
  const iat = Math.floor(now() / 1000);
  const content = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: credentials.client_email, scope, aud: tokenUrl(), iat, exp: iat + 3600 })}`;
  const signature = createSign('RSA-SHA256').update(content).end().sign(createPrivateKey(credentials.private_key), 'base64url');
  return `${content}.${signature}`;
}

// Returns a getToken() function that caches one access token per scope.
export function tokenProvider(credentials, scopeName, { fetchFn = fetch, now = Date.now } = {}) {
  const scope = SCOPES[scopeName];
  if (!scope) throw new Error(`Unknown scope ${scopeName}`);
  let cached = null;
  return async function getToken() {
    if (cached && cached.expiresAt > now() + 60000) return cached.token;
    let response;
    try {
      response = await fetchFn(tokenUrl(), {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signAssertion(credentials, scope, now) }),
        redirect: 'error', signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new Error('Google sign-in: connection failed or timed out.');
    }
    if (!response.ok) {
      const hint = response.status === 400 ? 'Check the service-account key and the runner clock.' : response.status === 401 ? 'The credential was rejected. The key may have been deleted or revoked.' : 'Google could not sign the worker in.';
      throw new Error(`Google sign-in: HTTP ${response.status}. ${hint}`);
    }
    const data = await response.json().catch(() => ({}));
    if (typeof data.access_token !== 'string' || !data.access_token) throw new Error('Google sign-in returned no access token.');
    cached = { token: data.access_token, expiresAt: now() + (Number(data.expires_in) || 3600) * 1000 };
    return cached.token;
  };
}
