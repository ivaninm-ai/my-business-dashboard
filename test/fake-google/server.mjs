// A small in-memory stand-in for the Google OAuth token endpoint and the Sheets API
// v4 subset used by the app and the worker. It enforces per-file sharing so the
// tests can prove access denial, and it exposes /_admin endpoints for test setup.
// It is a simulation: passing here does not prove the live Google API or account
// setup, only that the application logic behaves correctly against the contract.

import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '../../app');

export function createFakeGoogle({ testConfig } = {}) {
  const state = { files: new Map(), failures: [], log: [] };
  let counter = 0;

  function newId() { counter++; return `fake${String(counter).padStart(4, '0')}${'x'.repeat(30)}`; }

  function principalFromAuth(req) {
    const auth = req.headers.authorization || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    if (token.startsWith('mock:')) return { principal: token.slice(5), scope: 'user' };
    if (token.startsWith('sa:')) {
      const [, email, scope] = token.split(':');
      return { principal: email, scope: scope === 'readonly' ? 'readonly' : 'write' };
    }
    return null;
  }

  function role(file, principal) {
    return file.acl[principal] || (file.owner === principal ? 'owner' : null);
  }

  function parseRange(file, rangeText) {
    let sheetName, cells;
    const m = rangeText.match(/^'((?:[^']|'')*)'(?:!(.*))?$/) || rangeText.match(/^([^!]+)(?:!(.*))?$/);
    sheetName = m[1].replace(/''/g, "'");
    cells = m[2] || '';
    const sheet = file.sheets.find(s => s.title === sheetName);
    if (!sheet) return null;
    let r1 = 1, c1 = 1, r2 = Infinity, c2 = Infinity;
    if (cells) {
      const [a, b] = cells.split(':');
      const pa = parseCell(a); if (!pa) return null;
      c1 = pa.c ?? 1; r1 = pa.r ?? 1;
      if (b) { const pb = parseCell(b); if (!pb) return null; c2 = pb.c ?? Infinity; r2 = pb.r ?? Infinity; }
      else { c2 = pa.c ?? Infinity; r2 = pa.r ?? Infinity; }
    }
    return { sheet, r1, c1, r2, c2 };
  }

  function parseCell(ref) {
    const m = ref.match(/^([A-Z]*)(\d*)$/i);
    if (!m) return null;
    const col = m[1] ? m[1].toUpperCase().split('').reduce((a, ch) => a * 26 + (ch.charCodeAt(0) - 64), 0) : null;
    const row = m[2] ? Number(m[2]) : null;
    return { c: col, r: row };
  }

  function colLetter(n) { let s = ''; while (n > 0) { const mm = (n - 1) % 26; s = String.fromCharCode(65 + mm) + s; n = Math.floor((n - 1) / 26); } return s; }

  function getValues({ sheet, r1, c1, r2, c2 }) {
    const grid = sheet.grid;
    const lastRow = Math.min(r2, grid.length);
    const out = [];
    for (let r = r1; r <= lastRow; r++) {
      const row = grid[r - 1] || [];
      const lastCol = Math.min(c2, row.length);
      const vals = [];
      for (let c = c1; c <= lastCol; c++) vals.push(row[c - 1] === undefined ? '' : row[c - 1]);
      while (vals.length && (vals[vals.length - 1] === '' || vals[vals.length - 1] === undefined)) vals.pop();
      out.push(vals);
    }
    while (out.length && out[out.length - 1].length === 0) out.pop();
    return out;
  }

  function setValues({ sheet, r1, c1 }, values) {
    for (let i = 0; i < values.length; i++) {
      const r = r1 + i - 1;
      sheet.grid[r] ||= [];
      for (let j = 0; j < values[i].length; j++) {
        const v = values[i][j];
        if (typeof v === 'string' && v.startsWith('=')) throw Object.assign(new Error('formula received'), { status: 400 });
        sheet.grid[r][c1 + j - 1] = v;
      }
    }
    return { updatedRows: values.length, updatedColumns: Math.max(0, ...values.map(v => v.length)) };
  }

  function clearValues({ sheet, r1, c1, r2, c2 }) {
    const grid = sheet.grid;
    for (let r = r1; r <= Math.min(r2, grid.length); r++) {
      const row = grid[r - 1] || [];
      for (let c = c1; c <= Math.min(c2, row.length); c++) row[c - 1] = '';
    }
  }

  function appendValues(range, values) {
    const sheet = range.sheet;
    let last = 0;
    for (let r = 0; r < sheet.grid.length; r++) {
      const row = sheet.grid[r] || [];
      if (row.some(v => v !== '' && v !== undefined && v !== null)) last = r + 1;
    }
    return setValues({ sheet, r1: last + 1, c1: 1 }, values);
  }

  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS' });
    res.end(JSON.stringify(body));
  }

  function readBody(req) {
    return new Promise(resolve => { let d = ''; req.on('data', c => d += c); req.on('end', () => resolve(d ? JSON.parse(d) : {})); });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    state.log.push({ method: req.method, path: url.pathname });
    if (req.method === 'OPTIONS') return json(res, 204, {});
    try {
      // --- injected failures ---
      const fail = state.failures.find(f => url.pathname.includes(f.match) && f.remaining > 0);
      if (fail) { fail.remaining--; return json(res, fail.status, { error: { code: fail.status, message: 'injected failure' } }); }

      // --- token endpoint ---
      if (url.pathname === '/token' && req.method === 'POST') {
        let raw = ''; for await (const c of req) raw += c;
        const params = new URLSearchParams(raw);
        const assertion = params.get('assertion') || '';
        const parts = assertion.split('.');
        if (parts.length !== 3) return json(res, 400, { error: 'invalid_grant' });
        const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
        if (state.revoked?.has(claims.iss)) return json(res, 401, { error: 'invalid_client' });
        const scope = String(claims.scope || '').includes('readonly') ? 'readonly' : 'write';
        return json(res, 200, { access_token: `sa:${claims.iss}:${scope}`, token_type: 'Bearer', expires_in: 3600 });
      }

      // --- admin ---
      if (url.pathname.startsWith('/_admin/')) {
        const body = req.method === 'POST' ? await readBody(req) : {};
        if (url.pathname === '/_admin/reset') { state.files.clear(); state.failures = []; state.revoked = new Set(); state.log = []; return json(res, 200, { ok: true }); }
        if (url.pathname === '/_admin/create') {
          const id = body.id || newId();
          state.files.set(id, { id, title: body.title || 'Untitled', owner: body.owner || 'owner@example.com', acl: body.acl || {}, sheets: (body.sheets || [{ title: 'Sheet1', values: [] }]).map((s, i) => ({ sheetId: i + 1, title: s.title, grid: (s.values || []).map(r => [...r]) })), nextSheetId: (body.sheets || []).length + 1 });
          return json(res, 200, { id });
        }
        if (url.pathname === '/_admin/share') { const f = state.files.get(body.id); if (!f) return json(res, 404, {}); if (body.role) f.acl[body.principal] = body.role; else delete f.acl[body.principal]; return json(res, 200, { acl: f.acl }); }
        if (url.pathname === '/_admin/set-values') { const f = state.files.get(body.id); const r = parseRange(f, body.range); setValues(r, body.values); return json(res, 200, { ok: true }); }
        if (url.pathname === '/_admin/fail') { state.failures.push({ match: body.match, status: body.status || 503, remaining: body.times || 1 }); return json(res, 200, { ok: true }); }
        if (url.pathname === '/_admin/revoke') { (state.revoked ||= new Set()).add(body.principal); return json(res, 200, { ok: true }); }
        if (url.pathname === '/_admin/dump') { const f = state.files.get(url.searchParams.get('id')); if (!f) return json(res, 404, {}); return json(res, 200, { id: f.id, title: f.title, acl: f.acl, sheets: f.sheets.map(s => ({ title: s.title, values: getValues({ sheet: s, r1: 1, c1: 1, r2: Infinity, c2: Infinity }) })) }); }
        if (url.pathname === '/_admin/log') { const l = state.log; return json(res, 200, l); }
        if (url.pathname === '/_admin/files') return json(res, 200, [...state.files.values()].map(f => ({ id: f.id, title: f.title, acl: f.acl })));
        if (url.pathname === '/_admin/load-fixture') {
          // Replace a source workbook's four sheets with a BetterSpace fixture day (full replacement).
          const { readCsv, sheetify } = await import('../helpers/csv.mjs');
          const dir = path.join(here, '../fixtures/betterspace', body.business, body.day);
          const f = state.files.get(body.id); if (!f) return json(res, 404, {});
          for (const name of ['Customers', 'Sales', 'Payments', 'Stock']) {
            const rows = sheetify(readCsv(path.join(dir, `${name}.csv`)));
            let sheet = f.sheets.find(s => s.title === name);
            if (!sheet) { sheet = { sheetId: f.nextSheetId++, title: name, grid: [] }; f.sheets.push(sheet); }
            sheet.grid = rows.map(r => [...r]);
          }
          return json(res, 200, { ok: true });
        }
        return json(res, 404, {});
      }

      // --- static app for browser simulation ---
      if (!url.pathname.startsWith('/v4/')) {
        let rel = url.pathname.startsWith('/app/') ? url.pathname.slice(5) : url.pathname.slice(1);
        if (rel === '') rel = 'index.html';
        if (rel === 'config.json' && testConfig) return json(res, 200, testConfig);
        const file = path.join(appDir, rel);
        if (!file.startsWith(appDir) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
        const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
        res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        return res.end(readFileSync(file));
      }

      // --- Sheets API ---
      const auth = principalFromAuth(req);
      if (!auth) return json(res, 401, { error: { code: 401, message: 'no credentials' } });
      const m = url.pathname.match(/^\/v4\/spreadsheets(?:\/([^/:]+))?(?::(\w+))?(?:\/values(?::(\w+))?)?(?:\/(.+?))?(?::(\w+))?$/);
      if (!m) return json(res, 404, { error: { code: 404, message: 'unknown path' } });
      const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};

      if (!m[1] && req.method === 'POST') { // create
        if (auth.scope === 'readonly') return json(res, 403, { error: { code: 403, message: 'insufficient scope' } });
        const id = newId();
        const sheets = (body.sheets || []).map((s, i) => ({ sheetId: i + 1, title: s.properties.title, grid: [] }));
        if (!sheets.length) sheets.push({ sheetId: 1, title: 'Sheet1', grid: [] });
        state.files.set(id, { id, title: body.properties?.title || 'Untitled', owner: auth.principal, acl: { [auth.principal]: 'owner' }, sheets, nextSheetId: sheets.length + 1, createdByApp: true });
        return json(res, 200, { spreadsheetId: id, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${id}/edit`, properties: { title: body.properties?.title } });
      }
      const id = decodeURIComponent(m[1] || '');
      const file = state.files.get(id);
      if (!file) return json(res, 404, { error: { code: 404, message: 'not found' } });
      const r = role(file, auth.principal);
      if (!r) return json(res, 403, { error: { code: 403, message: 'The caller does not have permission' } });
      const canWrite = (r === 'writer' || r === 'owner') && auth.scope !== 'readonly';
      const op = m[2] || m[3] || m[5];
      const valuesRange = m[4] ? decodeURIComponent(m[4]) : null;

      if (req.method === 'GET' && !op && !valuesRange) {
        return json(res, 200, { spreadsheetId: id, properties: { title: file.title }, sheets: file.sheets.map((s, i) => ({ properties: { sheetId: s.sheetId, title: s.title, index: i, gridProperties: { rowCount: Math.max(1000, s.grid.length), columnCount: 26 } } })) });
      }
      if (req.method === 'GET' && op === 'batchGet') {
        const ranges = url.searchParams.getAll('ranges');
        const valueRanges = [];
        for (const rg of ranges) {
          const pr = parseRange(file, rg);
          if (!pr) return json(res, 400, { error: { code: 400, message: 'Unable to parse range' } });
          const values = getValues(pr);
          valueRanges.push({ range: `${pr.sheet.title}!A1:${colLetter(Math.max(1, ...values.map(v => v.length)))}${values.length || 1}`, majorDimension: 'ROWS', ...(values.length ? { values } : {}) });
        }
        return json(res, 200, { spreadsheetId: id, valueRanges });
      }
      if (!canWrite) return json(res, 403, { error: { code: 403, message: 'The caller does not have permission' } });
      if (req.method === 'PUT' && valuesRange) {
        const pr = parseRange(file, valuesRange); if (!pr) return json(res, 400, { error: { code: 400, message: 'Unable to parse range' } });
        return json(res, 200, { spreadsheetId: id, ...setValues(pr, body.values || []) });
      }
      if (req.method === 'POST' && op === 'batchUpdate' && m[3]) { // values:batchUpdate
        let total = 0;
        for (const d of body.data || []) { const pr = parseRange(file, d.range); if (!pr) return json(res, 400, { error: { code: 400, message: 'Unable to parse range' } }); total += setValues(pr, d.values || []).updatedRows; }
        return json(res, 200, { totalUpdatedRows: total });
      }
      if (req.method === 'POST' && op === 'append') {
        const pr = parseRange(file, valuesRange); if (!pr) return json(res, 400, { error: { code: 400, message: 'Unable to parse range' } });
        return json(res, 200, { updates: appendValues(pr, body.values || []) });
      }
      if (req.method === 'POST' && op === 'clear') {
        const pr = parseRange(file, valuesRange); if (!pr) return json(res, 400, { error: { code: 400, message: 'Unable to parse range' } });
        clearValues(pr); return json(res, 200, { clearedRange: valuesRange });
      }
      if (req.method === 'POST' && op === 'batchUpdate' && !m[3]) { // spreadsheet batchUpdate
        for (const rq of body.requests || []) {
          if (rq.addSheet) { file.sheets.push({ sheetId: file.nextSheetId++, title: rq.addSheet.properties.title, grid: [] }); }
          if (rq.deleteSheet) { file.sheets = file.sheets.filter(s => s.sheetId !== rq.deleteSheet.sheetId); }
        }
        return json(res, 200, { replies: [] });
      }
      return json(res, 404, { error: { code: 404, message: 'unsupported' } });
    } catch (e) {
      return json(res, e.status || 500, { error: { code: e.status || 500, message: e.message } });
    }
  });

  return {
    state,
    listen(port = 0) { return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server.address().port))); },
    close() { return new Promise(resolve => server.close(resolve)); },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  // Simulation server for the browser walkthrough: serves the app in mock-auth mode,
  // seeds a synthetic B2B source workbook shared with an ephemeral service account,
  // and writes that account's key to test/.state/ for the worker CLI. Test only.
  const port = Number(process.env.PORT || 8790);
  const testConfig = { app_version: 'test', auth: { mode: 'mock', email: 'owner@example.com', client_id: '' }, google_api_base: `http://127.0.0.1:${port}`, repo: { owner: 'example-student', name: 'my-business-dashboard' }, business_label: 'Simulation' };
  const fake = createFakeGoogle({ testConfig });
  const { generateKeyPairSync } = await import('node:crypto');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const SA = 'dashboard-worker@example-project.iam.gserviceaccount.com';
  const credentials = { type: 'service_account', client_email: SA, private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const stateDir = path.join(here, '../.state'); mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, 'sa.json'), JSON.stringify(credentials));
  const p = await fake.listen(port);
  const business = process.env.SIM_BUSINESS || 'b2b';
  const res = await fetch(`http://127.0.0.1:${p}/_admin/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: `BetterSpace ${business.toUpperCase()} (synthetic source)`, owner: 'owner@example.com', acl: { [SA]: 'reader' }, sheets: [] }) });
  const { id } = await res.json();
  await fetch(`http://127.0.0.1:${p}/_admin/load-fixture`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, business, day: 'day1' }) });
  writeFileSync(path.join(stateDir, 'sim.json'), JSON.stringify({ port: p, sourceId: id, serviceAccount: SA, business }));
  console.log(`fake google + app on http://127.0.0.1:${p}/app/`);
  console.log(`synthetic source workbook id: ${id} (shared with ${SA} as Viewer)`);
  console.log(`service-account key written to ${path.join(stateDir, 'sa.json')} (test only)`);
}
