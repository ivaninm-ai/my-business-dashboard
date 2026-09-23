import { renderBusinessSetup } from './setup-ui.js';
// Business Dashboard — static frontend. Runs entirely in the browser against the
// student's own Google Sheets with a Google-issued access token (drive.file scope).
// No keys, no business data and no proxy live on the site. All rendering uses
// textContent so imported text can never execute.

import { createSheetsClient, extractSpreadsheetId, quoteSheet, SheetsError } from './shared/sheets.mjs';
import { ensureWorkspace, inspectWorkspace, readKeyValues, writeKeyValues, upsertRows, appendRows, readTable, TABS, TAB_NAMES, LIMITS, fromStoredRow, parseJsonCell, columnLetter, rowsToObjects } from './shared/workspace.mjs';
import { validatePackage, effectiveModules, manualRowsFromPackage } from './shared/package.mjs';
import { computeMetrics, formatMoney } from './shared/metrics.mjs';
import { mergeTasks } from './shared/tasks.mjs';
import { buildCalendarItems } from './shared/calendar.mjs';
import { sourceUpdateRecipe, prepareSourceUpdate, saveSourceUpdate } from './shared/source-update.mjs';
import { TASK_RULES, ENTITIES } from './shared/model.mjs';
import { isIsoDate, addDays, monthStart, daysInMonth, formatDate, todayIso, priorMonthSameDays } from './shared/dates.mjs';

const APP_VERSION = '1.2.0-rc.1';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const LS_WORKSPACE = 'bd.workspaceId';
const LS_PREFS = 'bd.prefs';

// ---------------------------------------------------------------------------- state
const state = {
  config: null, token: null, tokenExpiresAt: 0, email: '', client: null, tokenClient: null,
  workspaceId: null, ws: null, // ws: loaded workspace contents
  pkg: null, modules: null, records: null, metricsBase: null,
  filters: { preset: 'mtd', start: '', end: '', channel: '', owner: '' },
  page: 'overview', prefs: {},
};

// ---------------------------------------------------------------------------- dom helpers
const $ = sel => document.querySelector(sel);
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') { /* never used with data */ }
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    add(el, c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const t = (tag, text, cls) => h(tag, { class: cls, text });
// DOM append that ignores null/false children (native append would render the text "null").
function add(parent, ...children) { for (const c of children.flat()) { if (c === null || c === undefined || c === false) continue; parent.append(c instanceof Node ? c : document.createTextNode(String(c))); } return parent; }
function toast(message, { error = false, ms = 3500 } = {}) {
  const el = $('#toast'); el.textContent = message; el.className = 'toast' + (error ? ' error' : ''); el.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.hidden = true; }, ms);
}
function modal(title, body, { actions = [], onClose } = {}) {
  const root = $('#modal-root'); root.textContent = '';
  const close = () => { root.textContent = ''; onClose?.(); };
  const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, t('h2', title), body,
    h('div', { class: 'foot' }, ...actions.map(a => h('button', { class: 'btn ' + (a.primary ? 'primary' : ''), onclick: async () => { const keep = await a.onclick?.(); if (!keep) close(); } }, a.label)), h('button', { class: 'btn ghost', onclick: close }, 'Close')));
  add(root, h('div', { class: 'modal-back', onclick: e => { if (e.target === e.currentTarget) close(); } }, box));
  return close;
}
function drawer(title, body) {
  const root = $('#modal-root'); root.textContent = '';
  const close = () => { root.textContent = ''; };
  add(root, h('div', { class: 'drawer', role: 'dialog', 'aria-label': title }, h('button', { class: 'btn ghost small close', onclick: close }, 'Close ×'), t('h2', title), body));
  document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
  return close;
}
function copyButton(text, label = 'Copy') {
  return h('button', { class: 'btn small', onclick: async () => { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy failed — select and copy manually', { error: true }); } } }, label);
}
function money(c) { return formatMoney(c, state.pkg?.business?.currency_symbol || state.pkg?.business?.currency || ''); }
function label(key, fallback) { return state.pkg?.labels?.[key] || fallback; }
function savePrefs() { try { localStorage.setItem(LS_PREFS, JSON.stringify(state.prefs)); } catch { /* ignore */ } }
function loadPrefs() { try { state.prefs = JSON.parse(localStorage.getItem(LS_PREFS) || '{}') || {}; } catch { state.prefs = {}; } }

// ---------------------------------------------------------------------------- boot
async function boot() {
  loadPrefs();
  try {
    const res = await fetch('./config.json', { cache: 'no-store' });
    state.config = await res.json();
  } catch {
    return gate('Configuration missing', 'config.json could not be loaded. Publish the dashboard with the "Publish dashboard" workflow.');
  }
  window.addEventListener('hashchange', () => { if (state.ws) navigate(location.hash.slice(1) || 'overview'); });
  $('#menu-toggle').addEventListener('click', () => { const n = $('#nav'); n.classList.toggle('open'); $('#menu-toggle').setAttribute('aria-expanded', n.classList.contains('open')); });
  $('#nav').addEventListener('click', e => { if (e.target.closest('a')) $('#nav').classList.remove('open'); });
  $('#signout-btn').addEventListener('click', signOut);
  $('#refresh-btn').addEventListener('click', () => loadWorkspace({ silent: false }));
  if (state.config.auth?.mode === 'mock') return gateMock();
  if (!state.config.auth?.client_id) {
    return gate('Not configured yet', 'The repository variable GOOGLE_OAUTH_CLIENT_ID is empty. Add it (Settings › Secrets and variables › Actions › Variables) and run "Publish dashboard" again.');
  }
  gate('Connect your Google account', 'Sign in with the Google account that owns your Dashboard Workspace. Google shows what the dashboard may access: only files it creates or you open with it.', [
    h('button', { class: 'btn primary', onclick: () => requestToken({ prompt: 'consent' }) }, 'Connect Google'),
  ]);
  loadGis().then(() => { if (state.prefs.connectedBefore) requestToken({ prompt: '' }); }).catch(() => gate('Google sign-in unavailable', 'The Google Identity script did not load. Check your connection or ad-blocker and reload.'));
}

function gate(title, status, actions = []) {
  $('#shell').hidden = true; $('#gate').hidden = false;
  $('#gate-title').textContent = state.config?.business_label || title;
  $('#gate-status').textContent = status;
  const a = $('#gate-actions'); a.textContent = ''; actions.forEach(x => add(a, x));
}

function gateMock() {
  // Simulation mode for local tests only: config.json says auth.mode = "mock". The
  // published app never uses it because the deploy workflow generates a google config.
  gate('Simulation sign-in', 'This build is running against the simulated Google API (test only).', [
    h('button', { class: 'btn primary', onclick: () => { state.token = `mock:${state.config.auth.email}`; state.tokenExpiresAt = Date.now() + 3600e3; state.email = state.config.auth.email; afterToken(); } }, `Sign in as ${state.config.auth.email}`),
  ]);
}

function loadGis() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.defer = true;
    s.onload = resolve; s.onerror = reject; add(document.head, s);
  });
}

async function requestToken({ prompt = '' } = {}) {
  try { await loadGis(); } catch { return; }
  if (!state.tokenClient) {
    state.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: state.config.auth.client_id,
      scope: SCOPE,
      callback: async resp => {
        if (resp.error) { gate('Authorisation did not complete', `Google returned "${resp.error}". If you saw "access blocked", add your email as a test user in Google Auth Platform › Audience, or check the Authorized JavaScript origin.`, [h('button', { class: 'btn primary', onclick: () => requestToken({ prompt: 'consent' }) }, 'Try again')]); return; }
        state.token = resp.access_token; state.tokenExpiresAt = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
        state.prefs.connectedBefore = true; savePrefs();
        await fetchEmail();
        afterToken();
      },
      error_callback: err => { if (err?.type !== 'popup_closed') gate('Authorisation did not complete', `${err?.type || 'error'}: ${err?.message || ''}`, [h('button', { class: 'btn primary', onclick: () => requestToken({ prompt: 'consent' }) }, 'Try again')]); },
    });
  }
  state.tokenClient.requestAccessToken({ prompt });
}

async function fetchEmail() {
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=' + encodeURIComponent(state.token));
    const j = await r.json(); state.email = j.email || '';
  } catch { state.email = ''; }
}

function tokenValid() { return state.token && Date.now() < state.tokenExpiresAt - 30000; }

async function getToken() {
  if (tokenValid()) return state.token;
  throw new SheetsError('Your Google session has expired. Click Reconnect.', { status: 401 });
}

function afterToken() {
  state.client = createSheetsClient({ apiBase: state.config.google_api_base || undefined, getToken });
  $('#account').textContent = state.email;
  const saved = (() => { try { return localStorage.getItem(LS_WORKSPACE); } catch { return null; } })();
  if (saved) { state.workspaceId = saved; loadWorkspace({ silent: false }); }
  else showWorkspacePicker();
}

function signOut() {
  const token = state.token;
  state.token = null; state.tokenExpiresAt = 0; state.ws = null; state.records = null; state.pkg = null; state.client = null;
  $('#page').textContent = ''; $('#banner').hidden = true; $('#modal-root').textContent = '';
  if (state.config.auth?.mode !== 'mock' && token && window.google?.accounts?.oauth2) { try { google.accounts.oauth2.revoke(token, () => {}); } catch { /* ignore */ } }
  state.prefs.connectedBefore = false; savePrefs();
  if (state.config.auth?.mode === 'mock') return gateMock();
  gate('Signed out', 'Business data was cleared from this page. Connect again to continue.', [h('button', { class: 'btn primary', onclick: () => requestToken({ prompt: 'consent' }) }, 'Connect Google')]);
}

// ---------------------------------------------------------------------------- workspace selection
function showWorkspacePicker() {
  const input = h('input', { type: 'text', placeholder: 'Paste the workspace link or ID', style: 'width:100%' });
  gate('Choose your Dashboard Workspace', 'The workspace is a Google Sheet that this dashboard creates in your Drive to store settings, imported snapshots, tasks and AI results. Your original records stay in their own files.', [
    h('button', { class: 'btn primary', onclick: createWorkspace }, 'Create a new Dashboard Workspace'),
    h('div', { class: 'stack' }, t('p', 'Already created one on another device?', 'small muted'), input, h('button', { class: 'btn', onclick: () => useWorkspace(extractSpreadsheetId(input.value)) }, 'Use this workspace')),
  ]);
}

async function createWorkspace() {
  try {
    $('#gate-status').textContent = 'Creating the workspace in your Google Drive…';
    const created = await state.client.create('Dashboard Workspace', ['_Workspace']);
    await ensureWorkspace(state.client, created.id, { appVersion: APP_VERSION, actor: state.email || 'owner' });
    try { localStorage.setItem(LS_WORKSPACE, created.id); } catch { /* ignore */ }
    state.workspaceId = created.id;
    toast('Workspace created');
    await loadWorkspace({ silent: false });
    navigate('connections');
  } catch (e) { $('#gate-status').textContent = `Could not create the workspace: ${e.message}`; }
}

async function useWorkspace(id) {
  if (!id) return toast('That does not look like a Google Sheet link or ID', { error: true });
  try {
    const st = await inspectWorkspace(state.client, id);
    if (!st.isWorkspace) return toast('That workbook is not a Dashboard Workspace created by this dashboard.', { error: true });
    try { localStorage.setItem(LS_WORKSPACE, id); } catch { /* ignore */ }
    state.workspaceId = id;
    await loadWorkspace({ silent: false });
  } catch (e) {
    toast(e.status === 403 || e.status === 404 ? 'Google did not allow access. With the drive.file permission the dashboard can only open workspaces it created for this Google account; create a new workspace or sign in with the account that created it.' : e.message, { error: true, ms: 8000 });
  }
}

// ---------------------------------------------------------------------------- loading
async function loadWorkspace({ silent }) {
  if (!state.workspaceId || !state.client) return;
  if (!silent) { $('#gate').hidden = false; $('#shell').hidden = true; $('#gate-status').textContent = 'Reading your workspace…'; $('#gate-actions').textContent = ''; }
  try {
    const id = state.workspaceId;
    const st = await inspectWorkspace(state.client, id);
    if (!st.isWorkspace) throw new Error('The saved workspace ID is not a Dashboard Workspace.');
    if (st.missing.length) await ensureWorkspace(state.client, id, { appVersion: APP_VERSION, actor: state.email });
    const ranges = TAB_NAMES.map(tab => `${quoteSheet(tab)}!A1:${columnLetter(TABS[tab].header.length)}${LIMITS.records_per_table + 2}`);
    const vrs = await state.client.batchGet(id, ranges);
    const tabs = {};
    TAB_NAMES.forEach((tab, i) => { const vals = vrs[i].values; const header = (vals[0] || []).map(String); tabs[tab] = rowsToObjects(header.length ? header : TABS[tab].header, vals.slice(1)); });
    const kv = rows => { const out = {}; const chunks = {}; for (const r of rows) { const m = String(r.key).match(/^(.*)\.chunk(\d+)$/); if (m) (chunks[m[1]] ||= [])[+m[2]] = String(r.value ?? ''); else out[r.key] = r.value; } for (const [k, p] of Object.entries(chunks)) out[k] = p.join(''); return out; };
    state.ws = { id, meta: kv(tabs._Workspace), settings: kv(tabs.Settings), metrics: kv(tabs.Metrics), sources: tabs.Sources, suggested: tabs.Tasks_Suggested.map(r => ({ ...r, active: String(r.active) === 'TRUE', evidence: parseJsonCell(r.evidence_json, {}) })), decisions: tabs.Task_Decisions, calendar: tabs.Calendar.filter(r => String(r.deleted) !== 'TRUE'), aiRequests: tabs.AI_Requests, aiResults: tabs.AI_Results, syncLog: tabs.Sync_Log, snapshots: tabs.Snapshots, data: { customers: tabs.Data_customers, sales: tabs.Data_sales, payments: tabs.Data_payments, stock: tabs.Data_stock } };
    state.pkg = parseJsonCell(state.ws.settings.setup_package);
    state.modules = state.pkg ? effectiveModules(state.pkg) : null;
    state.records = null;
    if (state.pkg) {
      state.records = {};
      for (const tbl of state.pkg.tables) state.records[tbl.entity] = (state.ws.data[tbl.entity] || []).map(r => fromStoredRow(tbl.entity, r));
    }
    $('#gate').hidden = true; $('#shell').hidden = false;
    $('#business-name').textContent = state.pkg?.business?.name || state.config.business_label || 'Business Dashboard';
    document.title = `${state.pkg?.business?.name || 'Business'} Dashboard`;
    renderNav();
    renderBanner();
    navigate(location.hash.slice(1) || (state.pkg ? 'overview' : 'connections'));
    if (!silent) toast('Workspace loaded');
  } catch (e) {
    if (e.status === 401) { gate('Session expired', 'Your Google session expired. Reconnect to continue.', [h('button', { class: 'btn primary', onclick: () => requestToken({ prompt: '' }) }, 'Reconnect')]); return; }
    gate('Could not open the workspace', e.message, [h('button', { class: 'btn', onclick: () => { try { localStorage.removeItem(LS_WORKSPACE); } catch { /* ignore */ } state.workspaceId = null; showWorkspacePicker(); } }, 'Choose a different workspace'), h('button', { class: 'btn primary', onclick: () => loadWorkspace({ silent: false }) }, 'Try again')]);
  }
}

function reportingDate() { return state.ws?.meta?.current_reporting_date || state.ws?.metrics?.reporting_date || todayIso(state.pkg?.business?.timezone); }

function periodRange() {
  const rd = reportingDate();
  const f = state.filters;
  if (f.preset === 'custom' && isIsoDate(f.start) && isIsoDate(f.end)) return { start: f.start, end: f.end };
  if (f.preset === 'prev_month') { const ps = monthStart(addDays(monthStart(rd), -1)); return { start: ps, end: addDays(monthStart(rd), -1) }; }
  if (f.preset === 'last7') return { start: addDays(rd, -6), end: rd };
  if (f.preset === 'last30') return { start: addDays(rd, -29), end: rd };
  if (f.preset === 'all') return { start: state.pkg?.period?.history_start || '2000-01-01', end: rd };
  return { start: monthStart(rd), end: rd };
}

function metrics() {
  if (!state.records) return null;
  const { start, end } = periodRange();
  return computeMetrics(state.records, reportingDate(), { periodStart: start, periodEnd: end, historyStart: state.pkg?.period?.history_start, filters: { channel: state.filters.channel || undefined, owner: state.filters.owner || undefined } });
}

function allTasks() { return mergeTasks(state.ws.suggested, state.ws.decisions); }

// ---------------------------------------------------------------------------- nav / banner
function renderNav() {
  const m = state.modules;
  for (const a of $('#nav').querySelectorAll('a[data-page]')) {
    const p = a.dataset.page;
    a.hidden = ['sales', 'customers', 'payments', 'stock', 'tasks', 'calendar', 'ai'].includes(p) && !(m && m[p]);
    if (p === 'overview') a.hidden = !m;
    if (p === 'customers') a.firstChild.textContent = label('customers', 'Customers');
    if (p === 'sales') a.firstChild.textContent = label('sales', 'Sales');
    if (p === 'payments') a.firstChild.textContent = label('payments', 'Payments');
  }
  const open = state.ws ? allTasks().filter(x => !x.resolved && ['suggested', 'accepted'].includes(x.status)).length : 0;
  $('#nav-tasks-count').textContent = open ? String(open) : '';
  $('#nav-foot').textContent = `v${APP_VERSION} · ${state.email || ''}`;
}

function renderBanner() {
  const b = $('#banner'); b.textContent = ''; b.hidden = true; b.className = 'banner';
  const meta = state.ws.meta;
  const badge = $('#data-badge');
  if (!state.pkg) { badge.textContent = 'no setup'; badge.className = 'badge muted-badge'; b.hidden = false; b.classList.add('info'); add(b, 'No business setup yet. Connect and review your records in ', h('a', { href: '#settings' }, 'Settings'), '.'); return; }
  if (!meta.current_snapshot_id) { badge.textContent = 'no import yet'; badge.className = 'badge warning'; b.hidden = false; b.classList.add('warning'); add(b, 'Business setup is saved, but no data has been imported yet. Run "Import data" in GitHub Actions (link under ', h('a', { href: '#connections' }, 'Data connections'), '), then press Reload.'); return; }
  const status = String(meta.last_import_status || '');
  if (status === 'failed') { badge.textContent = 'stale — last import failed'; badge.className = 'badge critical'; b.hidden = false; b.classList.add('critical'); add(b, `The last import failed and the dashboard shows the previous snapshot (${formatDate(meta.current_reporting_date)}). ${String(meta.last_import_message || '')} `, h('a', { href: '#connections' }, 'Details')); return; }
  if (status === 'writing') { badge.textContent = 'import in progress'; badge.className = 'badge warning'; b.hidden = false; b.classList.add('warning'); add(b, 'An import is writing to the workspace right now. Reload in a minute.'); return; }
  badge.textContent = `data as of ${formatDate(meta.current_reporting_date)}`; badge.className = 'badge good';
  if (state.pkg.confirmation?.state !== 'confirmed') { b.hidden = false; b.classList.add('warning'); add(b, 'The setup package is a draft with open questions. Figures are calculated from the draft mapping; review the source in Business setup.'); }
}

function navigate(page) {
  const allowed = new Set(['connections', 'settings']);
  if (state.modules) for (const [k, v] of Object.entries(state.modules)) if (v) allowed.add(k);
  if (!allowed.has(page)) page = state.pkg ? 'overview' : 'connections';
  state.page = page;
  for (const a of $('#nav').querySelectorAll('a[data-page]')) a.classList.toggle('active', a.dataset.page === page);
  if (location.hash.slice(1) !== page) history.replaceState(null, '', '#' + page);
  const root = $('#page'); root.textContent = '';
  if ((state.ws.meta.last_import_status === 'writing' || state.ws.meta.snapshot_incomplete === 'TRUE') && !['connections', 'settings'].includes(page)) {
    add(root, h('div', { class: 'banner warning' }, 'The snapshot is being written or needs recovery. Figures are hidden until Import data finishes successfully. Check Data connections, rerun Import data if it failed, then Reload.'));
    return;
  }
  const render = { overview: renderOverview, sales: renderSales, customers: renderCustomers, payments: renderPayments, stock: renderStock, tasks: renderTasks, calendar: renderCalendar, ai: renderAi, connections: renderConnections, settings: renderSettings }[page];
  try { add(root, render()); } catch (e) { add(root, h('div', { class: 'banner critical' }, `This section could not be rendered: ${e.message}`)); console.error(e); }
  $('#main').focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------- shared pieces
function scopeBar() {
  const rd = reportingDate();
  const { start, end } = periodRange();
  const meta = state.ws.meta;
  const cov = parseJsonCell(state.ws.metrics.coverage, {});
  return h('div', { class: 'card small', style: 'margin-bottom:12px' },
    h('div', { class: 'row' },
      h('span', {}, h('b', {}, 'Reporting date: '), formatDate(rd), ` (${state.ws.metrics.reporting_basis || 'unknown basis'})`),
      h('span', {}, h('b', {}, 'Source coverage: '), cov.latest_event_date ? `records up to ${formatDate(cov.latest_event_date)}` : '—'),
      h('span', {}, h('b', {}, 'Last successful read: '), meta.last_successful_import_at ? new Date(meta.last_successful_import_at).toLocaleString() : '—'),
      h('span', {}, h('b', {}, 'Period: '), `${formatDate(start)} – ${formatDate(end)}`)),
    t('div', 'Period filters apply to order value, order count and cash collected. Balances, deadlines, follow-ups and stock are as-of measures and ignore the period.', 'muted'));
}

function filterBar({ channel = true, owner = true } = {}) {
  const f = state.filters;
  const presets = [['mtd', 'Month to date'], ['prev_month', 'Previous month'], ['last7', 'Last 7 days'], ['last30', 'Last 30 days'], ['all', 'All history'], ['custom', 'Custom']];
  const sel = h('select', { onchange: e => { f.preset = e.target.value; navigate(state.page); } }, ...presets.map(([v, l]) => h('option', { value: v, selected: f.preset === v }, l)));
  const bar = h('div', { class: 'filters' }, h('label', {}, 'Period ', sel));
  if (f.preset === 'custom') {
    add(bar, h('label', {}, 'From ', h('input', { type: 'date', value: f.start, onchange: e => { f.start = e.target.value; navigate(state.page); } })), h('label', {}, 'To ', h('input', { type: 'date', value: f.end, onchange: e => { f.end = e.target.value; navigate(state.page); } })));
  }
  const channels = [...new Set((state.records.sales || []).map(s => s.channel).filter(Boolean))].sort();
  if (channel && channels.length > 1) add(bar, h('label', {}, `${label('channel', 'Channel')} `, h('select', { onchange: e => { f.channel = e.target.value; navigate(state.page); } }, h('option', { value: '' }, 'All'), ...channels.map(c => h('option', { value: c, selected: f.channel === c }, c)))));
  const owners = [...new Set((state.records.customers || []).map(c => c.owner).filter(Boolean))].sort();
  if (owner && owners.length) add(bar, h('label', {}, `${label('owner', 'Owner')} `, h('select', { onchange: e => { f.owner = e.target.value; navigate(state.page); } }, h('option', { value: '' }, 'All'), ...owners.map(c => h('option', { value: c, selected: f.owner === c }, c)))));
  if (f.preset !== 'mtd' || f.channel || f.owner) add(bar, h('button', { class: 'btn ghost small', onclick: () => { state.filters = { preset: 'mtd', start: '', end: '', channel: '', owner: '' }; navigate(state.page); } }, 'Reset'));
  return bar;
}

function tile({ label: lbl, value, delta, foot, hero = false, cls = '' }) {
  return h('div', { class: `tile ${hero ? 'hero' : ''} ${cls}` }, t('div', lbl, 'label'), t('div', value, 'value'), delta ? h('div', { class: `delta ${delta.dir || ''}` }, delta.text) : null, foot ? t('div', foot, 'foot') : null);
}

function dataTable({ columns, rows, onRow, empty = 'Nothing to show', sortKey, pageSize = 50 }) {
  let sort = { key: sortKey || columns[0].key, asc: true };
  let query = '';
  let shown = pageSize;
  const wrap = h('div');
  const search = h('input', { type: 'search', placeholder: 'Search…', oninput: e => { query = e.target.value.toLowerCase(); shown = pageSize; draw(); } });
  const table = h('table');
  const more = h('button', { class: 'btn small', onclick: () => { shown += pageSize; draw(); } }, 'Show more');
  function draw() {
    table.textContent = '';
    const thead = h('thead', {}, h('tr', {}, ...columns.map(c => h('th', { class: (c.num ? 'num ' : '') + (sort.key === c.key ? 'sorted ' + (sort.asc ? 'asc' : '') : ''), onclick: () => { if (sort.key === c.key) sort.asc = !sort.asc; else sort = { key: c.key, asc: true }; draw(); } }, c.label))));
    let list = rows;
    if (query) list = list.filter(r => columns.some(c => String(c.text ? c.text(r) : r[c.key] ?? '').toLowerCase().includes(query)));
    const col = columns.find(c => c.key === sort.key);
    list = list.slice().sort((a, b) => { const va = col?.sortValue ? col.sortValue(a) : a[sort.key]; const vb = col?.sortValue ? col.sortValue(b) : b[sort.key]; const r = va === vb ? 0 : va === null || va === undefined || va === '' ? 1 : vb === null || vb === undefined || vb === '' ? -1 : (typeof va === 'number' && typeof vb === 'number') ? va - vb : String(va).localeCompare(String(vb)); return sort.asc ? r : -r; });
    const tbody = h('tbody');
    for (const r of list.slice(0, shown)) {
      add(tbody, h('tr', { class: onRow ? 'clickable' : '', onclick: onRow ? () => onRow(r) : null }, ...columns.map(c => h('td', { class: c.num ? 'num' : '' }, c.render ? c.render(r) : (c.text ? c.text(r) : (r[c.key] ?? ''))))));
    }
    if (!list.length) add(tbody, h('tr', {}, h('td', { colspan: columns.length, class: 'empty' }, empty)));
    add(table, thead, tbody);
    more.hidden = list.length <= shown;
    count.textContent = `${Math.min(shown, list.length)} of ${list.length}`;
  }
  const count = h('span', { class: 'small muted' });
  add(wrap, h('div', { class: 'row', style: 'margin-bottom:8px' }, search, count), h('div', { class: 'table-wrap' }, table), more);
  draw();
  return wrap;
}

function customerName(id) { return (state.records.customers || []).find(c => c.id === id)?.name || id || ''; }
function customerOwner(id) { return (state.records.customers || []).find(c => c.id === id)?.owner || ''; }

function saleDrawer(sale) {
  const m = metrics();
  const payments = (state.records.payments || []).filter(p => p.sale_id === sale.id).sort((a, b) => a.date.localeCompare(b.date));
  const paid = payments.filter(p => p.date <= reportingDate()).reduce((a, p) => a + p.amount, 0);
  const tasks = allTasks().filter(x => x.record_type === 'sales' && x.record_id === sale.id);
  drawer(`${label('sale', 'Sale')} ${sale.id}`, h('div', { class: 'stack' },
    h('dl', { class: 'kv' },
      t('dt', label('customer', 'Customer')), h('dd', {}, h('a', { href: '#', onclick: e => { e.preventDefault(); const c = state.records.customers?.find(x => x.id === sale.customer_id); if (c) customerDrawer(c); } }, customerName(sale.customer_id))),
      t('dt', 'Date'), t('dd', formatDate(sale.date)),
      t('dt', 'Description'), t('dd', `${sale.description || '—'}${sale.quantity ? ` × ${sale.quantity}` : ''}`),
      t('dt', 'Amount'), t('dd', money(sale.amount)),
      t('dt', 'Status'), t('dd', `${sale.status_text || sale.status} (${sale.status})`),
      t('dt', 'Channel'), t('dd', sale.channel || '—'),
      t('dt', 'Payment due'), t('dd', sale.payment_due_date ? formatDate(sale.payment_due_date) : '—'),
      t('dt', 'Promised completion'), t('dd', sale.promised_completion_date ? formatDate(sale.promised_completion_date) : '—'),
      t('dt', 'Actual completion'), t('dd', sale.actual_completion_date ? formatDate(sale.actual_completion_date) : '—'),
      t('dt', 'Paid to date'), t('dd', `${money(paid)} · balance ${money(sale.amount - paid)}`),
      t('dt', 'Source row'), t('dd', sale._source || '—')),
    t('h3', `${label('payments', 'Payments')} (${payments.length})`),
    payments.length ? h('ul', { class: 'list' }, ...payments.map(p => h('li', {}, `${formatDate(p.date)} · ${money(p.amount)}${p.method ? ' · ' + p.method : ''} · ${p.id}`))) : t('p', 'No receipts recorded.', 'muted'),
    tasks.length ? h('div', {}, t('h3', 'Related tasks'), h('ul', { class: 'list' }, ...tasks.map(x => h('li', {}, `${x.title} — `, h('span', { class: `status ${x.status}` }, x.status))))) : null,
    void m));
}

function customerDrawer(c) {
  const sales = (state.records.sales || []).filter(s => s.customer_id === c.id).sort((a, b) => b.date.localeCompare(a.date));
  const tasks = allTasks().filter(x => x.record_type === 'customers' && x.record_id === c.id);
  drawer(`${label('customer', 'Customer')} ${c.name}`, h('div', { class: 'stack' },
    h('dl', { class: 'kv' },
      t('dt', 'ID'), t('dd', c.id), t('dt', 'Type'), t('dd', c.type), t('dt', 'Contact'), t('dd', c.contact || '—'),
      t('dt', 'Added'), t('dd', c.created_date ? formatDate(c.created_date) : '—'), t('dt', label('owner', 'Owner')), t('dd', c.owner || 'unassigned'),
      t('dt', 'Next follow-up'), t('dd', c.next_follow_up_date ? formatDate(c.next_follow_up_date) : 'none recorded'), t('dt', 'Notes'), t('dd', c.notes || '—')),
    t('h3', `${label('sales', 'Sales')} (${sales.length})`),
    sales.length ? h('ul', { class: 'list' }, ...sales.map(s => h('li', {}, h('a', { href: '#', onclick: e => { e.preventDefault(); saleDrawer(s); } }, s.id), ` · ${formatDate(s.date)} · ${money(s.amount)} · ${s.status_text || s.status}`))) : t('p', 'No sales rows for this account.', 'muted'),
    tasks.length ? h('div', {}, t('h3', 'Related tasks'), h('ul', { class: 'list' }, ...tasks.map(x => h('li', {}, `${x.title} — `, h('span', { class: `status ${x.status}` }, x.status))))) : null));
}

// ---------------------------------------------------------------------------- pages
function renderOverview() {
  const m = metrics();
  const rd = reportingDate();
  const root = h('div');
  add(root, h('div', { class: 'page-head' }, t('h1', 'Overview'), h('span', { class: 'small muted' }, state.pkg.business.synthetic ? 'Synthetic training data' : '')), scopeBar(), filterBar());
  const tiles = h('div', { class: 'tiles' });
  const cmp = m.comparison;
  const deltaText = cmp.growth === null ? `vs ${formatDate(cmp.start)}–${formatDate(cmp.end)}: unavailable (no prior sales)` : `${cmp.growth >= 0 ? '+' : ''}${(cmp.growth * 100).toFixed(1)}% vs ${formatDate(cmp.start)}–${formatDate(cmp.end)} (${money(cmp.prior_order_value)})`;
  add(tiles, tile({ label: 'Order value in period', value: money(m.period_order_value), hero: true, delta: { text: deltaText, dir: cmp.growth === null ? '' : cmp.growth >= 0 ? 'up' : 'down' }, foot: `${m.period_order_count} orders${m.average_order_value !== null ? ` · average ${money(m.average_order_value)}` : ''} · booked value, not profit` }));
  if (state.modules.payments) add(tiles, tile({ label: 'Cash collected in period', value: money(m.period_cash_collected), foot: `${m.period_receipt_count} receipts by payment date` }));
  if (state.modules.payments) add(tiles, tile({ label: 'Outstanding balance', value: money(m.outstanding_balance), foot: `as of ${formatDate(rd)}` }));
  if (state.modules.payments) add(tiles, tile({ label: 'Overdue balance', value: money(m.overdue_balance), foot: `${m.overdue_payment_count} sale(s) past due date`, cls: m.overdue_balance > 0 ? 'alert' : '' }));
  add(tiles, tile({ label: 'Pending completion', value: String(m.pending_completion_count), foot: `${m.overdue_completion_ids.length} overdue · ${m.due_today_completion_ids.length} due today` }));
  if (state.modules.stock) add(tiles, tile({ label: 'Low-stock items', value: String(m.low_stock_ids.length), foot: `${m.out_of_stock_ids.length} with no available units · snapshot ${m.stock_snapshot_date ? formatDate(m.stock_snapshot_date) : '—'}` }));
  if (state.modules.customers && (state.records.customers || []).some(c => c.next_follow_up_date)) add(tiles, tile({ label: 'Follow-ups', value: String(m.overdue_follow_up_ids.length), foot: `recorded actions overdue · ${m.follow_up_today_ids.length} due today · ${m.unassigned_prospect_ids.length} unassigned prospects` }));
  if (m.negative_balance_count) add(tiles, tile({ label: 'Data check', value: String(m.negative_balance_count), foot: 'sale(s) with receipts exceeding the amount — check the source', cls: 'alert' }));
  add(root, tiles);
  const grid = h('div', { class: 'grid cols-2' });
  add(grid, h('div', { class: 'card' }, t('h2', 'Monthly order value'), t('div', 'Eligible sales by sale date; the current month is partial.', 'scope'), trendChart(m.trend, rd)));
  const channels = Object.entries(m.by_channel).sort((a, b) => b[1] - a[1]);
  if (channels.length > 1) add(grid, h('div', { class: 'card' }, t('h2', `Order value by ${label('channel', 'channel').toLowerCase()}`), t('div', 'Selected period.', 'scope'), hbars(channels.map(([k, v]) => ({ label: k, value: v })))));
  const tasks = allTasks().filter(x => !x.resolved && ['suggested', 'accepted'].includes(x.status)).sort((a, b) => (a.action_date || '').localeCompare(b.action_date || '')).slice(0, 6);
  add(grid, h('div', { class: 'card' }, t('h2', 'Next actions'), t('div', 'Open task suggestions by action date.', 'scope'), tasks.length ? h('ul', { class: 'list' }, ...tasks.map(x => h('li', {}, h('a', { href: '#tasks' }, x.title), h('div', { class: 'small muted' }, `${x.action_date ? formatDate(x.action_date) : ''}${x.owner ? ' · ' + x.owner : ''} · `, h('span', { class: `status ${x.status}` }, x.status))))) : t('p', 'No open tasks.', 'muted')));
  const ai = latestAi();
  add(grid, h('div', { class: 'card' }, t('h2', 'AI brief'), ai ? h('div', {}, t('p', ai.brief.headline || '', ''), h('a', { href: '#ai' }, 'Read the full brief')) : t('p', 'No AI brief yet. See the AI insights section.', 'muted')));
  add(root, grid);
  return root;
}

function trendChart(trend, rd) {
  const W = 640, H = 220, padL = 56, padR = 12, padT = 16, padB = 34;
  const max = Math.max(1, ...trend.map(x => x.order_value));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'chart'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Monthly order value bar chart');
  const ns = (tag, attrs) => { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };
  const defs = ns('defs', {});
  const pat = ns('pattern', { id: 'hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
  add(pat, ns('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: 'var(--accent)', 'stroke-width': 2 }));
  add(defs, pat); add(svg, defs);
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const step = innerW / Math.max(1, trend.length);
  const barW = Math.min(48, step * 0.6);
  for (let i = 0; i <= 4; i++) {
    const y = padT + innerH - (innerH * i) / 4;
    add(svg, ns('line', { x1: padL, x2: W - padR, y1: y, y2: y, class: i === 0 ? 'axis' : 'grid' }));
    const lab = ns('text', { x: padL - 6, y: y + 4, 'text-anchor': 'end' }); lab.textContent = compactMoney((max * i) / 4); add(svg, lab);
  }
  const wrap = h('div', { class: 'chart-wrap' });
  const tip = h('div', { class: 'chart-tip', hidden: true });
  trend.forEach((pt, i) => {
    const x = padL + step * i + (step - barW) / 2;
    const hgt = (innerH * pt.order_value) / max;
    const y = padT + innerH - hgt;
    const r = ns('rect', { x, y, width: barW, height: Math.max(0, hgt), rx: 4, class: 'bar' + (pt.partial ? ' partial' : '') });
    const show = () => { tip.hidden = false; tip.textContent = `${pt.month}${pt.partial ? ' (to ' + formatDate(pt.end) + ')' : ''}: ${money(pt.order_value)}`; tip.style.left = `${((x + barW / 2) / W) * 100}%`; tip.style.top = `${(y / H) * 100}%`; };
    r.addEventListener('mouseenter', show); r.addEventListener('mousemove', show); r.addEventListener('mouseleave', () => { tip.hidden = true; });
    add(svg, r);
    const lab = ns('text', { x: x + barW / 2, y: H - padB + 16, 'text-anchor': 'middle' }); lab.textContent = pt.month.slice(5) + '/' + pt.month.slice(2, 4) + (pt.partial ? '*' : ''); add(svg, lab);
  });
  add(wrap, svg, tip, t('div', `* partial month, up to ${formatDate(rd)}`, 'hint'));
  return wrap;
}

function compactMoney(cents) { const v = cents / 100; if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'; if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e4 ? 0 : 1) + 'K'; return String(Math.round(v)); }

function hbars(items) {
  const max = Math.max(1, ...items.map(i => i.value));
  return h('div', {}, ...items.map(i => h('div', { class: 'hbar' }, h('span', { class: 'nowrap', title: i.label }, i.label), h('div', { class: 'track' }, h('div', { class: 'fill', style: `width:${(i.value / max) * 100}%` })), h('span', { class: 'num right' }, money(i.value)))));
}

function renderSales() {
  const m = metrics();
  const { start, end } = periodRange();
  const root = h('div', {}, h('div', { class: 'page-head' }, t('h1', label('sales', 'Sales'))), scopeBar(), filterBar());
  let scope = 'period';
  const statusSel = h('select', {}, h('option', { value: '' }, 'All statuses'), h('option', { value: 'pending' }, 'Pending'), h('option', { value: 'done' }, 'Completed'), h('option', { value: 'excluded' }, 'Cancelled/excluded'));
  const scopeSel = h('select', {}, h('option', { value: 'period' }, 'Selected period'), h('option', { value: 'all' }, 'All history'));
  const holder = h('div');
  const draw = () => {
    holder.textContent = '';
    let rows = (state.records.sales || []).filter(s => s.date <= reportingDate());
    if (state.filters.channel) rows = rows.filter(s => (s.channel || '') === state.filters.channel);
    if (state.filters.owner) rows = rows.filter(s => customerOwner(s.customer_id) === state.filters.owner);
    if (scope === 'period') rows = rows.filter(s => s.date >= start && s.date <= end);
    if (statusSel.value) rows = rows.filter(s => s.status === statusSel.value);
    add(holder, dataTable({ sortKey: 'date', rows, onRow: saleDrawer, columns: [
      { key: 'id', label: 'ID' }, { key: 'date', label: 'Date', text: r => formatDate(r.date), sortValue: r => r.date },
      { key: 'customer_id', label: label('customer', 'Customer'), text: r => customerName(r.customer_id) },
      { key: 'description', label: 'Description' }, { key: 'channel', label: label('channel', 'Channel') },
      { key: 'amount', label: 'Amount', num: true, text: r => money(r.amount) },
      { key: 'status', label: 'Status', text: r => r.status_text || r.status },
      { key: 'promised_completion_date', label: 'Promised', text: r => r.promised_completion_date ? formatDate(r.promised_completion_date) : '' },
    ] }));
  };
  statusSel.onchange = draw; scopeSel.onchange = () => { scope = scopeSel.value; draw(); };
  add(root, h('div', { class: 'tiles' }, tile({ label: 'Order value', value: money(m.period_order_value), foot: 'selected period' }), tile({ label: 'Orders', value: String(m.period_order_count) }), tile({ label: 'Average order', value: m.average_order_value === null ? '—' : money(m.average_order_value) }), tile({ label: 'Overdue completions', value: String(m.overdue_completion_ids.length), foot: 'as of reporting date' })));
  add(root, h('div', { class: 'card' }, h('div', { class: 'filters' }, h('label', {}, 'Rows ', scopeSel), h('label', {}, 'Status ', statusSel)), holder));
  draw();
  return root;
}

function renderCustomers() {
  const m = metrics();
  const root = h('div', {}, h('div', { class: 'page-head' }, t('h1', label('customers', 'Customers'))), scopeBar(), filterBar({ channel: false }));
  const sales = state.records.sales || [];
  const bySale = new Map(); for (const s of sales) { if (s.status === 'excluded') continue; bySale.set(s.customer_id, (bySale.get(s.customer_id) || 0) + 1); }
  const paidBySale = new Map(); for (const p of state.records.payments || []) if (p.date <= reportingDate()) paidBySale.set(p.sale_id, (paidBySale.get(p.sale_id) || 0) + p.amount);
  const balance = new Map(); for (const s of sales) { if (s.status === 'excluded' || s.date > reportingDate()) continue; const b = s.amount - (paidBySale.get(s.id) || 0); if (b > 0) balance.set(s.customer_id, (balance.get(s.customer_id) || 0) + b); }
  let rows = state.records.customers || [];
  if (state.filters.owner) rows = rows.filter(c => (c.owner || '') === state.filters.owner);
  const hasFollow = rows.some(c => c.next_follow_up_date);
  const hasOwner = rows.some(c => c.owner);
  add(root, h('div', { class: 'tiles' }, tile({ label: 'Accounts', value: String(rows.length) }), tile({ label: 'Repeat customers in period', value: String(m.repeat_customer_ids.length), foot: '2+ sales in the selected period' }), hasFollow ? tile({ label: 'Follow-ups overdue', value: String(m.overdue_follow_up_ids.length), foot: `${m.follow_up_today_ids.length} due today` }) : null, hasOwner ? tile({ label: 'Unassigned prospects', value: String(m.unassigned_prospect_ids.length) }) : null));
  add(root, h('div', { class: 'card' }, dataTable({ rows, onRow: customerDrawer, sortKey: 'name', columns: [
    { key: 'id', label: 'ID' }, { key: 'name', label: 'Name' }, { key: 'type', label: 'Type' },
    hasOwner ? { key: 'owner', label: label('owner', 'Owner'), text: r => r.owner || 'unassigned' } : null,
    { key: 'sales', label: label('sales', 'Sales'), num: true, text: r => String(bySale.get(r.id) || 0), sortValue: r => bySale.get(r.id) || 0 },
    { key: 'balance', label: 'Balance', num: true, text: r => balance.get(r.id) ? money(balance.get(r.id)) : '', sortValue: r => balance.get(r.id) || 0 },
    hasFollow ? { key: 'next_follow_up_date', label: 'Next follow-up', text: r => r.next_follow_up_date ? `${formatDate(r.next_follow_up_date)}${r.next_follow_up_date < reportingDate() ? ' (overdue)' : ''}` : '' } : null,
  ].filter(Boolean) })));
  return root;
}

function renderPayments() {
  const m = metrics();
  const { start, end } = periodRange();
  const root = h('div', {}, h('div', { class: 'page-head' }, t('h1', label('payments', 'Payments'))), scopeBar(), filterBar());
  add(root, h('div', { class: 'tiles' }, tile({ label: 'Cash collected', value: money(m.period_cash_collected), foot: 'selected period, by payment date' }), tile({ label: 'Outstanding', value: money(m.outstanding_balance), foot: 'all eligible sales' }), tile({ label: 'Overdue', value: money(m.overdue_balance), foot: `${m.overdue_payment_count} sale(s)` }), tile({ label: 'Due today', value: money(m.due_today_balance) })));
  const salesById = new Map((state.records.sales || []).map(s => [s.id, s]));
  const balances = m.balances.slice();
  add(root, h('div', { class: 'card' }, t('h2', 'Unpaid balances'), t('div', 'As of the reporting date. Overdue = recorded due date before the reporting date.', 'scope'), dataTable({ rows: balances, sortKey: 'due', onRow: r => saleDrawer(salesById.get(r.sale_id)), columns: [
    { key: 'sale_id', label: label('sale', 'Sale') }, { key: 'customer_id', label: label('customer', 'Customer'), text: r => customerName(r.customer_id) },
    { key: 'amount', label: 'Amount', num: true, text: r => money(r.amount) }, { key: 'paid', label: 'Paid', num: true, text: r => money(r.paid) }, { key: 'balance', label: 'Balance', num: true, text: r => money(r.balance) },
    { key: 'due', label: 'Due', text: r => r.due ? formatDate(r.due) : '—' }, { key: 'state', label: 'State', render: r => h('span', { class: `badge ${r.state === 'overdue' ? 'critical' : r.state === 'due_today' ? 'warning' : 'muted-badge'}` }, r.state.replace('_', ' ')) },
  ], empty: 'No unpaid balances' })));
  let rows = (state.records.payments || []).filter(p => p.date >= start && p.date <= end);
  if (state.filters.channel) rows = rows.filter(p => (salesById.get(p.sale_id)?.channel || '') === state.filters.channel);
  add(root, h('div', { class: 'card' }, t('h2', 'Receipts in period'), dataTable({ rows, sortKey: 'date', onRow: r => { const s = salesById.get(r.sale_id); if (s) saleDrawer(s); }, columns: [
    { key: 'id', label: 'ID' }, { key: 'date', label: 'Date', text: r => formatDate(r.date), sortValue: r => r.date }, { key: 'sale_id', label: label('sale', 'Sale') }, { key: 'customer', label: label('customer', 'Customer'), text: r => customerName(salesById.get(r.sale_id)?.customer_id) }, { key: 'amount', label: 'Amount', num: true, text: r => money(r.amount) }, { key: 'method', label: 'Method' },
  ] })));
  return root;
}

function renderStock() {
  const m = metrics();
  const root = h('div', {}, h('div', { class: 'page-head' }, t('h1', 'Stock')), scopeBar());
  add(root, h('div', { class: 'banner info' }, `Stock is one shared snapshot dated ${m.stock_snapshot_date ? formatDate(m.stock_snapshot_date) : 'unknown'}; it ignores period and channel filters. Available = on hand − reserved. Reservations are product totals, not allocations to orders.`));
  add(root, h('div', { class: 'tiles' }, tile({ label: 'Products', value: String(m.stock.length) }), tile({ label: 'Low stock', value: String(m.low_stock_ids.length), foot: 'available ≤ threshold (equality counts)' }), tile({ label: 'No available units', value: String(m.out_of_stock_ids.length), foot: 'subset of low stock' })));
  add(root, h('div', { class: 'card' }, dataTable({ rows: m.stock, sortKey: 'available', columns: [
    { key: 'id', label: 'ID' }, { key: 'name', label: 'Product' }, { key: 'on_hand', label: 'On hand', num: true }, { key: 'reserved', label: 'Reserved', num: true }, { key: 'available', label: 'Available', num: true },
    { key: 'reorder_threshold', label: 'Threshold', num: true }, { key: 'open_units', label: 'Open units', num: true }, { key: 'unreserved_pending', label: 'Unreserved pending', num: true },
    { key: 'low', label: 'Status', render: r => r.out ? h('span', { class: 'badge critical' }, '⚠ no available units') : r.low ? h('span', { class: 'badge warning' }, '▲ low') : h('span', { class: 'badge good' }, '✓ ok') },
  ] })));
  return root;
}

// ---------------------------------------------------------------------------- tasks
function renderTasks() {
  const root = h('div', {}, h('div', { class: 'page-head' }, t('h1', 'Tasks'), h('button', { class: 'btn primary small', onclick: () => editTask(null) }, '+ Add task')), scopeBar());
  const tasks = allTasks();
  let view = state.prefs.taskView || 'open';
  const tabs = h('div', { class: 'pill-tabs' });
  const holder = h('div', { class: 'card' });
  const counts = { open: tasks.filter(x => !x.resolved && ['suggested', 'accepted'].includes(x.status)).length, completed: tasks.filter(x => x.status === 'completed').length, dismissed: tasks.filter(x => x.status === 'dismissed').length, resolved: tasks.filter(x => x.resolved && x.status !== 'completed' && x.status !== 'dismissed').length };
  const draw = () => {
    tabs.textContent = '';
    for (const [k, l] of [['open', 'Open'], ['completed', 'Completed'], ['dismissed', 'Dismissed'], ['resolved', 'Resolved by data']]) add(tabs, h('button', { class: view === k ? 'active' : '', onclick: () => { view = k; state.prefs.taskView = k; savePrefs(); draw(); } }, `${l} (${counts[k]})`));
    holder.textContent = '';
    let list = tasks.filter(x => view === 'open' ? (!x.resolved && ['suggested', 'accepted'].includes(x.status)) : view === 'completed' ? x.status === 'completed' : view === 'dismissed' ? x.status === 'dismissed' : (x.resolved && !['completed', 'dismissed'].includes(x.status)));
    list.sort((a, b) => (a.action_date || '9999').localeCompare(b.action_date || '9999') || a.title.localeCompare(b.title));
    if (!list.length) add(holder, t('div', view === 'open' ? 'No open tasks. Suggestions appear after an import; you can also add your own.' : 'Nothing here.', 'empty'));
    for (const x of list) add(holder, taskCard(x));
  };
  draw();
  add(root, h('p', { class: 'small muted' }, 'Suggested dates, owners and priorities are proposals until you accept them. Recorded deadlines come from your records and are never changed here. Completing a task never changes a sale or payment.'), tabs, holder);
  return root;
}

function taskCard(x) {
  const rd = reportingDate();
  const overdue = x.action_date && x.action_date < rd && ['suggested', 'accepted'].includes(x.status);
  const meta = h('div', { class: 'meta' },
    h('span', {}, h('span', { class: `status ${x.status}` }, x.status), x.stale ? h('span', { class: 'status stale', title: 'Decided on an older data snapshot; the suggestion has since been regenerated' }, ' stale ') : null, x.resolved ? h('span', { class: 'status resolved', title: 'The condition that generated this suggestion no longer exists in the current data' }, ' resolved by data ') : null),
    x.action_date ? h('span', {}, `Action: ${formatDate(x.action_date)}${overdue ? ' (past)' : ''}${x.status === 'suggested' ? ' (suggested)' : ''}`) : null,
    x.recorded_deadline ? h('span', {}, `Recorded deadline: ${formatDate(x.recorded_deadline)}`) : null,
    h('span', {}, `${label('owner', 'Owner')}: ${x.owner || 'unassigned'}${x.status === 'suggested' && x.suggested_owner ? ' (suggested)' : ''}`),
    x.rule !== 'custom' ? h('span', {}, `Rule: ${TASK_RULES[x.rule]?.title || x.rule}`) : h('span', {}, 'Your task'),
    x.record_id ? h('a', { href: '#', onclick: e => { e.preventDefault(); openRecord(x.record_type, x.record_id); } }, `Evidence: ${x.record_id}`) : null);
  const actions = h('div', { class: 'actions' });
  const btn = (lbl, status, cls = '') => h('button', { class: `btn small ${cls}`, onclick: () => saveDecision(x, { status }) }, lbl);
  const row = h('div', { class: 'row' });
  if (!x.resolved) {
    if (x.status === 'suggested') add(row, btn('Accept', 'accepted', 'primary'));
    if (['suggested', 'accepted'].includes(x.status)) add(row, btn('Complete', 'completed'), btn('Dismiss', 'dismissed', 'ghost'));
    if (['completed', 'dismissed'].includes(x.status)) add(row, btn('Reopen', 'accepted', 'ghost'));
  } else if (['suggested', 'accepted'].includes(x.status)) add(row, btn('Mark completed', 'completed', 'ghost'));
  add(row, h('button', { class: 'btn small ghost', onclick: () => editTask(x) }, 'Edit'));
  add(actions, row);
  return h('div', { class: `task ${['completed', 'dismissed'].includes(x.status) ? 'done' : ''}` }, h('div', {}, t('div', x.title, 'title'), t('div', x.reason, 'reason'), x.note ? h('div', { class: 'small' }, h('b', {}, 'Note: '), x.note) : null, meta), actions);
}

function openRecord(type, id) {
  if (type === 'sales') { const s = state.records.sales?.find(r => r.id === id); if (s) return saleDrawer(s); }
  if (type === 'customers') { const c = state.records.customers?.find(r => r.id === id); if (c) return customerDrawer(c); }
  if (type === 'stock') { location.hash = '#stock'; return; }
  toast('Record not found in the current snapshot');
}

async function saveDecision(x, patch) {
  const existing = state.ws.decisions.find(d => d.task_key === x.task_key) || {};
  const row = { task_key: x.task_key, status: existing.status || x.status, action_date: existing.action_date || '', owner: existing.owner || '', note: existing.note || '', title: existing.title || (x.custom ? x.title : ''), detail: existing.detail || (x.custom ? x.reason : ''), ...patch, snapshot_at_decision: state.ws.meta.current_snapshot_id || '', updated_at: new Date().toISOString(), updated_by: state.email || 'owner' };
  if (row.status === 'accepted' && !row.action_date && !Object.hasOwn(patch, 'action_date')) row.action_date = x.suggested_date || '';
  if (row.status === 'accepted' && !row.owner && !Object.hasOwn(patch, 'owner')) row.owner = x.suggested_owner || '';
  try {
    await upsertRows(state.client, state.ws.id, 'Task_Decisions', 'task_key', [row]);
    const i = state.ws.decisions.findIndex(d => d.task_key === x.task_key);
    if (i >= 0) state.ws.decisions[i] = row; else state.ws.decisions.push(row);
    toast('Saved to your workspace');
    renderNav(); navigate(state.page);
  } catch (e) { toast(`Could not save: ${e.message}`, { error: true, ms: 7000 }); }
}

function editTask(x) {
  const isNew = !x;
  const title = h('input', { type: 'text', value: x?.title || '', maxlength: 200, disabled: x && !x.custom });
  const detail = h('textarea', { maxlength: 1000 }); detail.value = x?.custom ? (x.reason || '') : '';
  const date = h('input', { type: 'date', value: x?.action_date || reportingDate() });
  const owner = h('input', { type: 'text', value: x?.owner || '', maxlength: 80, list: 'owners' });
  const owners = h('datalist', { id: 'owners' }, ...(state.pkg.business.team || []).map(o => h('option', { value: o })));
  const note = h('textarea', { maxlength: 1000 }); note.value = x?.note || '';
  const body = h('div', {}, h('label', { class: 'field' }, t('span', 'Title'), title), x && !x.custom ? null : h('label', { class: 'field' }, t('span', 'Detail'), detail), x?.recorded_deadline ? h('p', { class: 'small muted' }, `Recorded deadline ${formatDate(x.recorded_deadline)} comes from your records and cannot be edited here.`) : null, h('label', { class: 'field' }, t('span', 'Action date'), date), h('label', { class: 'field' }, t('span', label('owner', 'Owner')), owner, owners), h('label', { class: 'field' }, t('span', 'Note'), note));
  modal(isNew ? 'Add task' : 'Edit task', body, { actions: [{ label: 'Save', primary: true, onclick: async () => {
    if (isNew && !title.value.trim()) { toast('Give the task a title', { error: true }); return true; }
    if (date.value && !isIsoDate(date.value)) { toast('Invalid date', { error: true }); return true; }
    const target = x || { task_key: `custom:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, custom: true, status: 'accepted', title: title.value.trim(), reason: detail.value.trim() };
    await saveDecision(target, { action_date: date.value, owner: owner.value.trim(), note: note.value.trim(), ...(target.custom ? { title: title.value.trim(), detail: detail.value.trim(), status: x?.status || 'accepted' } : {}) });
  } }] });
}

// ---------------------------------------------------------------------------- calendar
function renderCalendar() {
  const rd = reportingDate();
  state.prefs.calMonth ||= monthStart(rd);
  const root = h('div', {}, h('div', { class: 'page-head' }, t('h1', 'Calendar'), h('button', { class: 'btn primary small', onclick: () => editEntry(null) }, '+ Add note')), scopeBar());
  const items = calendarItems();
  const month = state.prefs.calMonth;
  const head = h('div', { class: 'cal-head' }, h('button', { class: 'btn small', onclick: () => { state.prefs.calMonth = monthStart(addDays(month, -1)); savePrefs(); navigate('calendar'); } }, '‹'), t('h2', new Date(month + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })), h('button', { class: 'btn small', onclick: () => { state.prefs.calMonth = addDays(month, daysInMonth(month)); savePrefs(); navigate('calendar'); } }, '›'), h('button', { class: 'btn ghost small', onclick: () => { state.prefs.calMonth = monthStart(rd); savePrefs(); navigate('calendar'); } }, 'Reporting month'));
  const grid = h('div', { class: 'cal-grid' });
  for (const d of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) add(grid, t('div', d, 'cal-dow'));
  const first = new Date(month + 'T00:00:00Z');
  const offset = (first.getUTCDay() + 6) % 7;
  const start = addDays(month, -offset);
  const byDate = new Map(); for (const it of items) { if (!byDate.has(it.date)) byDate.set(it.date, []); byDate.get(it.date).push(it); }
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    const other = d.slice(0, 7) !== month.slice(0, 7);
    const cell = h('div', { class: `cal-day ${other ? 'other' : ''} ${d === rd ? 'today' : ''}` }, t('div', String(Number(d.slice(8))), 'd'));
    for (const it of (byDate.get(d) || []).slice(0, 6)) add(cell, h('span', { class: `cal-item ${it.kind}${it.overdue ? ' overdue' : ''}`, title: it.title, onclick: it.onclick }, it.title));
    if ((byDate.get(d) || []).length > 6) add(cell, t('span', `+${byDate.get(d).length - 6} more`, 'small muted'));
    add(grid, cell);
  }
  add(root, head, grid, h('div', { class: 'legend' }, h('span', { class: 'deadline' }, 'Recorded deadline (from your records)'), h('span', { class: 'task' }, 'Task action date'), h('span', { class: 'entry' }, 'Your note'), h('span', { class: 'overdue' }, 'Recorded deadline before the reporting date')));
  add(root, t('p', 'Dates are calendar days; the records contain no appointment times, so none are shown. Nothing here is sent to an external calendar.', 'hint'));
  return root;
}

function calendarItems() {
  return buildCalendarItems({ records: state.records, metrics: metrics(), tasks: allTasks(), entries: state.ws.calendar, reportingDate: reportingDate(), money }).map(item => ({ ...item, onclick: () => {
    if (item.kind === 'entry') return editEntry(state.ws.calendar.find(e => e.entry_id === item.id));
    if (item.kind === 'task') { location.hash = '#tasks'; return; }
    if (item.record_type === 'sales') return saleDrawer(state.records.sales.find(s => s.id === item.record_id));
    return customerDrawer(state.records.customers.find(c => c.id === item.record_id));
  } }));
}

function editEntry(e) {
  const title = h('input', { type: 'text', value: e?.title || '', maxlength: 200 });
  const date = h('input', { type: 'date', value: e?.date || reportingDate() });
  const detail = h('textarea', { maxlength: 1000 }); detail.value = e?.detail || '';
  const body = h('div', {}, h('label', { class: 'field' }, t('span', 'Title'), title), h('label', { class: 'field' }, t('span', 'Date'), date), h('label', { class: 'field' }, t('span', 'Detail'), detail));
  const actions = [{ label: 'Save', primary: true, onclick: async () => {
    if (!title.value.trim() || !isIsoDate(date.value)) { toast('Title and a valid date are required', { error: true }); return true; }
    const row = { entry_id: e?.entry_id || `cal_${Date.now().toString(36)}`, date: date.value, title: title.value.trim(), detail: detail.value.trim(), kind: 'note', related_task_key: e?.related_task_key || '', created_at: e?.created_at || new Date().toISOString(), updated_at: new Date().toISOString(), deleted: 'FALSE' };
    try { await upsertRows(state.client, state.ws.id, 'Calendar', 'entry_id', [row]); const i = state.ws.calendar.findIndex(c => c.entry_id === row.entry_id); if (i >= 0) state.ws.calendar[i] = row; else state.ws.calendar.push(row); toast('Saved'); navigate('calendar'); } catch (err) { toast(err.message, { error: true }); }
  } }];
  if (e) actions.push({ label: 'Delete', onclick: async () => { try { await upsertRows(state.client, state.ws.id, 'Calendar', 'entry_id', [{ ...e, deleted: 'TRUE', updated_at: new Date().toISOString() }]); state.ws.calendar = state.ws.calendar.filter(c => c.entry_id !== e.entry_id); toast('Deleted'); navigate('calendar'); } catch (err) { toast(err.message, { error: true }); } } });
  modal(e ? 'Edit note' : 'Add note', body, { actions });
}

// ---------------------------------------------------------------------------- AI
function latestAi() {
  const rows = state.ws.aiResults.filter(r => String(r.status) === 'complete').sort((a, b) => String(b.generated_at).localeCompare(String(a.generated_at)));
  if (!rows.length) return null;
  return { ...rows[0], brief: parseJsonCell(rows[0].content_json, {}) };
}

function renderAi() {
  const root = h('div', {}, h('div', { class: 'page-head' }, t('h1', 'AI insights')), scopeBar());
  const repo = state.config.repo || {};
  const actionsUrl = repo.owner && repo.name ? `https://github.com/${repo.owner}/${repo.name}/actions/workflows/ai.yml` : null;
  const latest = latestAi();
  // One row per result_id: a settled (complete/failed) row supersedes its earlier 'running' row.
  const rank = r => (['complete', 'failed'].includes(String(r.status)) ? 1 : 0);
  const byResult = new Map();
  for (const r of state.ws.aiResults) { const k = String(r.result_id); const prev = byResult.get(k); if (!prev || rank(r) >= rank(prev)) byResult.set(k, r); }
  const results = [...byResult.values()].sort((a, b) => String(b.generated_at).localeCompare(String(a.generated_at)));
  const byRequest = new Map(); for (const r of results) { const k = String(r.request_id); const prev = byRequest.get(k); if (!prev || rank(r) > rank(prev)) byRequest.set(k, r); }
  const pending = state.ws.aiRequests.filter(r => { const s = byRequest.get(String(r.request_id)); return !s || !['complete', 'failed'].includes(String(s.status)); });
  add(root, h('div', { class: 'card' }, t('h2', 'Request a new brief'), t('p', 'The brief is generated by the background worker in your GitHub repository using your own AI provider key. It is queued here and produced when the worker next runs — after each scheduled import, or now if you run the "AI brief" workflow.', 'small ink2'),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: requestAnalysis }, 'Request analysis'), actionsUrl ? h('a', { class: 'btn', href: actionsUrl, target: '_blank', rel: 'noopener' }, 'Run the AI brief workflow now ↗') : null),
    pending.length ? h('p', { class: 'small' }, h('span', { class: 'badge warning' }, `${pending.length} request(s) queued`), ' waiting for the worker.') : null));
  if (latest) {
    const b = latest.brief;
    const stale = latest.snapshot_id !== state.ws.meta.current_snapshot_id;
    add(root, h('div', { class: 'card' }, h('div', { class: 'row' }, t('h2', 'Latest brief'), stale ? h('span', { class: 'badge warning', title: 'Generated from an older data snapshot' }, 'older snapshot') : h('span', { class: 'badge good' }, 'current snapshot')),
      t('p', `Generated ${new Date(latest.generated_at).toLocaleString()} · model ${latest.model} · rules ${latest.rules_version} · snapshot ${latest.snapshot_id}`, 'small muted'),
      t('h3', b.headline || ''), t('p', b.summary || ''),
      b.priorities?.length ? h('div', {}, t('h3', 'Priorities'), h('ol', { class: 'steps' }, ...b.priorities.map(p => { const task = allTasks().find(x => x.task_key === p.task_key); return h('li', {}, h('b', {}, task?.title || p.task_key), ` — ${p.why} `, h('i', {}, p.suggested_action), task ? h('span', {}, ' · ', h('span', { class: `status ${task.status}` }, task.status), ' ', h('a', { href: '#tasks' }, 'open')) : null); }))) : null,
      b.watch_items?.length ? h('div', {}, t('h3', 'Watch'), h('ul', {}, ...b.watch_items.map(w => h('li', {}, w)))) : null,
      b.data_caveats?.length ? h('div', {}, t('h3', 'Data caveats'), h('ul', {}, ...b.data_caveats.map(w => h('li', {}, w)))) : null,
      b.dropped_references ? t('p', `${b.dropped_references} reference(s) to unknown tasks were removed from this brief.`, 'small muted') : null));
  } else add(root, h('div', { class: 'card' }, t('p', 'No completed brief yet.', 'muted')));
  add(root, h('div', { class: 'card' }, t('h2', 'History'), results.length ? h('ul', { class: 'list' }, ...results.slice(0, 20).map(r => h('li', {}, h('span', { class: `badge ${r.status === 'complete' ? 'good' : r.status === 'failed' ? 'critical' : 'warning'}` }, String(r.status)), ` ${new Date(r.generated_at).toLocaleString()} · ${r.kind}${r.request_id ? ' · request ' + r.request_id : ' · automatic'}${r.error ? ' · ' + r.error : ''}`))) : t('p', 'No runs yet.', 'muted')));
  return root;
}

async function requestAnalysis() {
  const row = { request_id: `req_${Date.now().toString(36)}`, requested_at: new Date().toISOString(), requested_by: state.email || 'owner', kind: 'brief', note: '' };
  try { await appendRows(state.client, state.ws.id, 'AI_Requests', [row]); state.ws.aiRequests.push(row); toast('Queued. The worker will process it on its next run.'); navigate('ai'); }
  catch (e) { toast(e.message, { error: true }); }
}

// ---------------------------------------------------------------------------- connections
function renderConnections() {
  const root = h('div', {}, h('div', { class: 'page-head' }, t('h1', 'Data connections')));
  const meta = state.ws.meta;
  const saEmail = String(state.ws.settings.service_account_email || '');
  const url = `https://docs.google.com/spreadsheets/d/${state.ws.id}/edit`;
  const saInput = h('input', { type: 'text', value: saEmail, placeholder: 'name@project.iam.gserviceaccount.com', style: 'width:100%' });
  add(root, h('div', { class: 'card' }, t('h2', 'Dashboard Workspace'), h('dl', { class: 'kv' }, t('dt', 'Workspace ID'), h('dd', {}, h('span', { class: 'copy' }, state.ws.id, copyButton(state.ws.id))), t('dt', 'Open in Google Sheets'), h('dd', {}, h('a', { href: url, target: '_blank', rel: 'noopener' }, 'Open workspace ↗')), t('dt', 'Created'), t('dd', meta.created_at ? new Date(meta.created_at).toLocaleString() : '—'), t('dt', 'Schema'), t('dd', `v${meta.schema_version} · app ${meta.app_version || '—'}`)),
    h('ol', { class: 'steps small' }, h('li', {}, 'Copy the Workspace ID and add it to your GitHub repository as the secret ', h('code', {}, 'DASHBOARD_WORKSPACE_ID'), '.'), h('li', {}, 'Open the workspace in Google Sheets › Share › add your service-account email as ', h('b', {}, 'Editor'), '.')),
    h('div', { class: 'field' }, t('span', 'Your service-account email (shown here so you can copy it when sharing; it is not a secret)'), h('div', { class: 'row' }, saInput, h('button', { class: 'btn small', onclick: async () => { const v = saInput.value.trim(); if (v && !/@.+\.iam\.gserviceaccount\.com$/.test(v)) return toast('That is not a service-account email', { error: true }); await writeKeyValues(state.client, state.ws.id, 'Settings', { service_account_email: v }); state.ws.settings.service_account_email = v; toast('Saved'); navigate('connections'); } }, 'Save'))),
    h('button', { class: 'btn ghost small', onclick: () => { try { localStorage.removeItem(LS_WORKSPACE); } catch { /* ignore */ } state.workspaceId = null; state.ws = null; showWorkspacePicker(); } }, 'Use a different workspace on this device')));
  const sources = state.pkg?.sources || [];
  const bound = new Map(state.ws.sources.map(s => [String(s.source_id), s]));
  const card = h('div', { class: 'card' }, t('h2', 'Sources'));
  if (!sources.length) add(card, h('a', { class: 'btn primary', href: '#settings' }, 'Start Business setup'));
  for (const s of sources) {
    const b = bound.get(s.source_id) || {};
    if (s.kind === 'manual_package') { add(card, manualSourceCard(s)); continue; }
    const input = h('input', { type: 'text', value: b.spreadsheet_id ? `https://docs.google.com/spreadsheets/d/${b.spreadsheet_id}/edit` : '', placeholder: 'Paste the Google Sheet link', style: 'width:100%' });
    const tables = state.pkg.tables.filter(x => x.source_id === s.source_id);
    add(card, h('div', { style: 'padding:10px 0;border-bottom:1px solid var(--grid)' }, h('div', { class: 'row' }, t('b', s.label || s.source_id), h('span', { class: `badge ${b.spreadsheet_id ? 'good' : 'warning'}` }, b.spreadsheet_id ? 'connected' : 'not connected'), t('span', s.kind === 'manual_package' ? 'manual package (refresh by importing a new package)' : 'Google Sheet, read by the worker', 'small muted')),
      t('div', `Worksheets expected: ${tables.map(x => x.sheet_name).join(', ')}`, 'small muted'),
      s.kind === 'google_sheet' ? h('div', { class: 'row', style: 'margin-top:6px' }, input, h('button', { class: 'btn small primary', onclick: async () => { const id = extractSpreadsheetId(input.value); if (!id) return toast('Paste the full Google Sheet link', { error: true }); if (id === state.ws.id) return toast('That is the workspace itself, not a source', { error: true }); try { await upsertRows(state.client, state.ws.id, 'Sources', 'source_id', [{ source_id: s.source_id, kind: 'google_sheet', spreadsheet_id: id, label: s.label || s.source_id, refresh: s.refresh || 'scheduled', updated_at: new Date().toISOString() }]); toast('Source saved. Share it with the service account as Viewer, then run "Import data".'); await loadWorkspace({ silent: true }); navigate('connections'); } catch (e) { toast(e.message, { error: true }); } } }, 'Save link')) : null,
      s.kind === 'google_sheet' ? h('p', { class: 'small muted', style: 'margin-top:4px' }, `Share this Sheet with ${saEmail || 'your service-account email'} as Viewer (General access stays Restricted). The dashboard itself never reads your source directly.`) : null));
  }
  add(root, card);
  const repo = state.config.repo || {};
  const importUrl = repo.owner && repo.name ? `https://github.com/${repo.owner}/${repo.name}/actions/workflows/import.yml` : null;
  const snap = state.ws.snapshots.slice(-1)[0];
  const sample = state.pkg?.validation?.sample;
  const rec = snap && sample ? h('div', {}, t('h3', 'Reconciliation with the sample'), h('table', {}, h('thead', {}, h('tr', {}, t('th', 'Table'), t('th', 'Sample rows'), t('th', 'Live rows'))), h('tbody', {}, ...Object.entries(parseJsonCell(snap.row_counts_json, {})).map(([k, v]) => h('tr', {}, t('td', k), t('td', String(sample.row_counts?.[k] ?? '—')), t('td', String(v))))))) : null;
  add(root, h('div', { class: 'card' }, t('h2', 'Imports'), h('dl', { class: 'kv' }, t('dt', 'Last import'), h('dd', {}, meta.last_import_at ? `${new Date(meta.last_import_at).toLocaleString()} — ` : '', h('span', { class: `badge ${meta.last_import_status === 'success' || meta.last_import_status === 'unchanged' ? 'good' : meta.last_import_status === 'failed' ? 'critical' : 'muted-badge'}` }, String(meta.last_import_status || 'none'))), t('dt', 'Message'), t('dd', String(meta.last_import_message || '—')), t('dt', 'Current snapshot'), t('dd', meta.current_snapshot_id ? `${meta.current_snapshot_id} · reporting ${formatDate(meta.current_reporting_date)}` : 'none')),
    h('p', { class: 'small ink2' }, 'Imports run in GitHub Actions on the schedule set by the ', h('code', {}, 'REFRESH_HOURS_UTC'), ' variable (default 23 UTC = about 07:17 Malaysia). GitHub may delay or skip scheduled runs; use the manual run to request a refresh. Public-repository schedules can stop after 60 days without repository activity; re-enable the workflow in GitHub Actions if disabled.'),
    importUrl ? h('a', { class: 'btn', href: importUrl, target: '_blank', rel: 'noopener' }, 'Run "Import data" now ↗') : null,
    rec,
    t('h3', 'Recent runs'), state.ws.syncLog.length ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, t('th', 'When'), t('th', 'Job'), t('th', 'Status'), t('th', 'Message'))), h('tbody', {}, ...state.ws.syncLog.slice(-15).reverse().map(l => h('tr', {}, t('td', l.finished_at ? new Date(l.finished_at).toLocaleString() : ''), t('td', String(l.job)), h('td', {}, h('span', { class: `badge ${['success', 'unchanged'].includes(String(l.status)) ? 'good' : String(l.status) === 'failed' ? 'critical' : 'muted-badge'}` }, String(l.status))), t('td', String(l.message || ''))))))) : t('p', 'No runs recorded yet.', 'muted')));
  return root;
}

function downloadJson(value, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const a = h('a', { href: url, download: name }); add(document.body, a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function manualSourceCard(source) {
  const meta = parseJsonCell(state.ws.settings[`source_meta.${source.source_id}`], {});
  return h('div', { class: 'card' }, t('h3', source.label || source.source_id),
    t('p', `File records as of ${meta.data_as_of || 'unknown'} · ${meta.file_name || ''}`, 'small'),
    t('p', 'To replace this file, open Business setup, select this existing source, then choose the new file. Review and activate it, then run Import data. Other sources are kept.', 'small'),
    h('a', { class: 'btn', href: '#settings' }, 'Update this file in Business setup'));
}

// ---------------------------------------------------------------------------- settings
function renderSettings() {
  const root = h('div', {}, h('div', { class: 'page-head' }, t('h1', 'Settings')));
  const pkg = state.pkg;
  if (pkg) {
    add(root, h('div', { class: 'card' }, t('h2', 'Business profile'), h('dl', { class: 'kv' }, t('dt', 'Name'), t('dd', pkg.business.name), t('dt', 'Model'), t('dd', pkg.business.model || '—'), t('dt', 'Industry'), t('dd', pkg.business.industry || '—'), t('dt', 'Team'), t('dd', (pkg.business.team || []).join(', ') || '—'), t('dt', 'Timezone / currency'), t('dd', `${pkg.business.timezone} · ${pkg.business.currency}`), t('dt', 'Reporting date'), t('dd', `${pkg.reporting_date.mode}${pkg.reporting_date.value ? ' ' + pkg.reporting_date.value : ''}${pkg.reporting_date.note ? ' — ' + pkg.reporting_date.note : ''}`), t('dt', 'Package'), t('dd', `${pkg.package_id} · v${pkg.package_version} · ${pkg.confirmation.state}${state.ws.settings.imported_at ? ' · imported ' + new Date(state.ws.settings.imported_at).toLocaleString() : ''}`)),
      pkg.confirmation.open_questions?.length ? h('div', {}, t('h3', 'Open questions'), h('ul', {}, ...pkg.confirmation.open_questions.map(q => h('li', {}, q)))) : null,
      t('h3', 'Tables and mappings'), h('ul', { class: 'list small' }, ...pkg.tables.map(tb => h('li', {}, h('b', {}, `${tb.entity}`), ` ← ${tb.sheet_name || tb.table_id}: ${tb.fields.map(f => `${f.canonical}=${f.header ?? JSON.stringify(f.constant)}`).join(', ')}`))),
      t('h3', 'Task rules'), h('ul', { class: 'list small' }, ...(pkg.policies.tasks || []).map(r => h('li', {}, `${TASK_RULES[r.rule]?.title || r.rule}: ${r.enabled === false ? 'off' : 'on'}${r.params ? ' ' + JSON.stringify(r.params) : ''}${r.note ? ' — ' + r.note : ''}`))),
      pkg.meanings?.length ? h('div', {}, t('h3', 'Confirmed meanings'), h('ul', { class: 'list small' }, ...pkg.meanings.map(m => h('li', {}, h('b', {}, m.field), `: ${m.meaning} (${m.basis || 'stated'})`)))) : null));
  }
  root.prepend(renderBusinessSetup({ h, t, add, state, toast, modal, loadSchema, loadWorkspace, navigate }));
  add(root, h('div', { class: 'card' }, t('h2', 'Backup and restore'), t('p', 'Export your settings, source links, task decisions, calendar notes and AI requests as one JSON file. Saved file records are included and may contain private business data. Rebuilt data snapshots and keys are not included.', 'small ink2'), h('div', { class: 'row' }, h('button', { class: 'btn', onclick: exportBackup }, 'Export backup'), h('button', { class: 'btn', onclick: restoreBackup }, 'Restore from backup…')),
    t('h3', 'Appearance'), h('div', { class: 'row' }, ...[['', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => h('button', { class: 'btn small', onclick: () => { state.prefs.theme = v; savePrefs(); applyTheme(); } }, l))),
    t('h3', 'Limits of this release'), h('ul', { class: 'small ink2' }, h('li', {}, `Up to ${LIMITS.records_per_table.toLocaleString()} rows per table and ${LIMITS.tasks.toLocaleString()} task suggestions.`), h('li', {}, 'One editor at a time is assumed for tasks and notes; Google Sheets has no row-level locking.'), h('li', {}, 'Google Sheets sources refresh on the worker schedule. Local XLSX/CSV/PDF/DOCX files are selected and reviewed in Business setup; replace them there when they change.'), h('li', {}, 'Browser access tokens last about an hour; reconnect when asked. Sign out clears all data from this page.'))));
  return root;
}

function applyTheme() { const v = state.prefs.theme || ''; if (v) document.documentElement.setAttribute('data-theme', v); else document.documentElement.removeAttribute('data-theme'); }

let schemaCache = null;
async function loadSchema() { if (!schemaCache) schemaCache = await (await fetch('./shared/setup-package.schema.json', { cache: 'no-store' })).json(); return schemaCache; }

async function previewPackage(text) {
  let pkg;
  try { pkg = JSON.parse(text); } catch { return toast('That is not valid JSON', { error: true }); }
  const schema = await loadSchema();
  const v = validatePackage(pkg, schema);
  const body = h('div', {});
  if (!v.ok) { add(body, t('p', 'The package was rejected. Nothing was changed.', 'bad'), h('ul', { class: 'check-list' }, ...v.errors.slice(0, 30).map(e => h('li', { class: 'bad' }, e)))); return modal('Setup package rejected', body); }
  const prev = state.pkg;
  add(body, t('p', `${pkg.business.name} · ${pkg.business.model || ''} · ${pkg.tables.length} table(s) · ${pkg.confirmation.state}`, ''),
    h('ul', { class: 'small' }, ...pkg.tables.map(tb => h('li', {}, h('b', {}, `${tb.entity}`), ` from "${tb.sheet_name || tb.table_id}" (${tb.row_meaning || 'row meaning not stated'}): ${tb.fields.length} fields, identity by ${tb.identity?.mode || 'source_id'}`))),
    pkg.validation?.sample ? h('p', { class: 'small' }, `Previously validated sample: ${Object.entries(pkg.validation.sample.row_counts || {}).map(([k, n]) => `${n} ${k}`).join(', ')}${pkg.validation.sample.totals ? ' · totals ' + Object.entries(pkg.validation.sample.totals).map(([k, n]) => `${k}=${n}`).join(', ') : ''}. Live totals are checked against these after the first import (Data connections).`) : t('p', 'No sample validation figures included.', 'small muted'),
    v.warnings.length ? h('div', {}, t('h3', 'Warnings'), h('ul', { class: 'check-list small' }, ...v.warnings.map(w => h('li', { class: 'warn' }, w)))) : null,
    pkg.confirmation.open_questions?.length ? h('div', {}, t('h3', 'Open questions'), h('ul', { class: 'small' }, ...pkg.confirmation.open_questions.map(q => h('li', {}, q)))) : null,
    pkg.records ? h('p', { class: 'small' }, `Includes reviewed records: ${Object.entries(pkg.records).map(([k, r]) => `${r.length} ${k}`).join(', ')} (manual source; refresh by importing a new package).`) : null,
    prev ? t('p', `This replaces the current package "${prev.package_id}". Source links and task decisions are kept.`, 'small warn') : null);
  modal('Setup package preview', body, { actions: [{ label: 'Import this package', primary: true, onclick: async () => { await importPackage(pkg); } }] });
}

async function importPackage(pkg) {
  try {
    const entries = { setup_package: pkg, package_id: pkg.package_id, package_version: pkg.package_version, business_name: pkg.business.name, imported_at: new Date().toISOString(), imported_by: state.email || 'owner' };
    Object.assign(entries, manualRowsFromPackage(pkg));
    for (const source of pkg.sources.filter(s => s.kind === 'manual_package')) {
      if (pkg.tables.some(tb => tb.source_id === source.source_id && pkg.records?.[tb.entity])) entries[`source_meta.${source.source_id}`] = { source_id: source.source_id, kind: source.kind, label: source.label || source.source_id, uploaded_at: new Date().toISOString(), data_as_of: '', file_name: '', mode: 'replace' };
    }
    await writeKeyValues(state.client, state.ws.id, 'Settings', entries);
    const bindings = pkg.sources.filter(s => s.kind === 'google_sheet' && s.spreadsheet_id).map(s => ({ source_id: s.source_id, kind: 'google_sheet', spreadsheet_id: s.spreadsheet_id, label: s.label || s.source_id, refresh: s.refresh || 'scheduled', updated_at: new Date().toISOString() }));
    if (bindings.length) await upsertRows(state.client, state.ws.id, 'Sources', 'source_id', bindings);
    toast('Setup package saved to your workspace');
    await loadWorkspace({ silent: true });
    navigate('connections');
  } catch (e) { toast(`Import failed: ${e.message}`, { error: true, ms: 8000 }); }
}

async function exportBackup() {
  const backup = { backup_version: '1.0', exported_at: new Date().toISOString(), workspace_id: state.ws.id, app_version: APP_VERSION, settings: state.ws.settings, sources: state.ws.sources, task_decisions: state.ws.decisions, calendar: state.ws.calendar, ai_requests: state.ws.aiRequests };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `dashboard-backup-${new Date().toISOString().slice(0, 10)}.json` }); add(document.body, a); a.click(); a.remove();
}

function restoreBackup() {
  const file = h('input', { type: 'file', accept: '.json,application/json' });
  modal('Restore from backup', h('div', {}, t('p', 'Restores settings, source links, task decisions, calendar notes and AI requests into this workspace. Existing rows with the same keys are overwritten; other rows are kept. Saved file records are restored too; rebuilt data snapshots are refreshed by the next import.', 'small'), file), { actions: [{ label: 'Restore', primary: true, onclick: async () => {
    if (!file.files?.[0]) { toast('Choose a backup file', { error: true }); return true; }
    let b; try { b = JSON.parse(await file.files[0].text()); } catch { toast('Not a valid backup file', { error: true }); return true; }
    if (b.backup_version !== '1.0' || !b.settings) { toast('Unsupported backup format', { error: true }); return true; }
    try {
      const settings = { ...b.settings }; delete settings.setup_package;
      if (b.settings.setup_package) { const pkg = parseJsonCell(b.settings.setup_package); const v = validatePackage(pkg, await loadSchema()); if (!v.ok) { toast('The backup contains an invalid setup package; it was not restored: ' + v.errors[0], { error: true, ms: 8000 }); return true; } settings.setup_package = pkg; }
      await writeKeyValues(state.client, state.ws.id, 'Settings', settings);
      if (b.sources?.length) await upsertRows(state.client, state.ws.id, 'Sources', 'source_id', b.sources);
      if (b.task_decisions?.length) await upsertRows(state.client, state.ws.id, 'Task_Decisions', 'task_key', b.task_decisions);
      if (b.calendar?.length) await upsertRows(state.client, state.ws.id, 'Calendar', 'entry_id', b.calendar);
      if (b.ai_requests?.length) await upsertRows(state.client, state.ws.id, 'AI_Requests', 'request_id', b.ai_requests);
      toast('Backup restored');
      await loadWorkspace({ silent: true }); navigate('settings');
    } catch (e) { toast(e.message, { error: true }); return true; }
  } }] });
}

// ---------------------------------------------------------------------------- start
applyTheme();
boot();
void ENTITIES; void priorMonthSameDays; void readKeyValues; void readTable;
