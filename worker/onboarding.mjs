import { readFileSync } from 'node:fs';
import { makeClients, APP_VERSION, acquireLease, releaseLease } from './importer.mjs';
import { generateJson, DEFAULT_MODEL, providerError } from './gemini.mjs';
import { ENTITIES } from '../app/shared/model.mjs';
import { validateInput } from '../app/shared/onboarding.mjs';
import { ensureWorkspace, readKeyValues, writeKeyValues, parseJsonCell } from '../app/shared/workspace.mjs';
import { quoteSheet } from '../app/shared/sheets.mjs';

const instructions = readFileSync(new URL('../prompts/data_mapping.md', import.meta.url), 'utf8');

// Sent as responseJsonSchema so Gemini must answer in this shape (structured output).
const TEXT = { type: 'string' };
const TEXT_LIST = { type: 'array', items: TEXT };
export const MAPPING_SCHEMA = {
  type: 'object',
  required: ['selections', 'status_map', 'document_tables', 'notes'],
  properties: {
    selections: { type: 'array', items: { type: 'object', required: ['name', 'entity', 'header_row', 'fields'], properties: {
      name: TEXT,
      entity: { type: 'string', enum: Object.keys(ENTITIES) },
      header_row: { type: 'integer', minimum: 1 },
      fields: { type: 'array', items: { type: 'object', required: ['canonical', 'header'], properties: {
        canonical: { type: 'string', enum: [...new Set(Object.values(ENTITIES).flatMap(e => Object.keys(e.fields)))] },
        header: TEXT,
      } } },
    } } },
    status_map: { type: 'object', required: ['pending', 'done', 'excluded', 'blank'], properties: {
      pending: TEXT_LIST, done: TEXT_LIST, excluded: TEXT_LIST, blank: { type: 'string', enum: ['pending', 'done', 'excluded'] },
    } },
    document_tables: { type: 'array', items: { type: 'object', required: ['name', 'rows'], properties: {
      name: TEXT, rows: { type: 'array', items: { type: 'array', items: { type: ['string', 'null'] } } },
    } } },
    notes: TEXT_LIST,
  },
};

// Names the fields Gemini returned (never their values) so a rejected reply can be diagnosed.
function invalidProposal(parsed) {
  const shape = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? Object.entries(parsed).slice(0, 6).map(([k, v]) => `${String(k).replace(/[^\w-]/g, '').slice(0, 30)}:${Array.isArray(v) ? 'list' : v === null ? 'null' : typeof v}`).join(', ')
    : Array.isArray(parsed) ? 'a list' : typeof parsed;
  return new Error(`Gemini returned an invalid proposal (received ${shape || 'nothing'}). Retry source preparation.`);
}

function normaliseProposal(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.selections)) throw invalidProposal(parsed);
  const notes = Array.isArray(parsed.notes) ? parsed.notes : parsed.notes ? [parsed.notes] : [];
  return { ...parsed, notes, document_tables: Array.isArray(parsed.document_tables) ? parsed.document_tables : [] };
}

export async function prepareProposal(request, sources, options) {
  if (request.aiDataMode !== 'paid' && request.profile?.synthetic !== true) throw new Error('For real private records, select a billing-enabled Gemini project in Business setup. Free mode accepts synthetic practice data only.');
  let input = request.input || { tables: [] };
  if (request.source.kind === 'google_sheet') {
    let info;
    try { info = await sources.getSpreadsheet(request.source.spreadsheet_id); }
    catch { throw new Error('Cannot read this Google Sheet. Share the native Google Sheet with your service-account email as Viewer, then retry.'); }
    if (info.sheets.length > 12) throw new Error('This workbook has more than 12 tabs. Use a smaller workbook.');
    const values = await sources.batchGet(request.source.spreadsheet_id, info.sheets.map(s => `${quoteSheet(s.title)}!A1:CV5022`));
    input = { tables: info.sheets.map((s, i) => ({ name: s.title, rows: values[i]?.values || [] })).filter(t => t.rows.length) };
  }
  validateInput(input);
  // Spreadsheet rows remain authoritative; AI receives only a small mapping sample.
  const sample = input.text ? { text: input.text } : { tables: input.tables.map(t => ({ name: t.name, rows: t.rows.slice(0, 15) })) };
  const { parsed: raw } = await generateJson({ ...options, system: instructions, schema: MAPPING_SCHEMA, prompt: JSON.stringify({ business: request.profile, supportedFields: ENTITIES, source: sample }) });
  const parsed = normaliseProposal(raw);
  if (input.text) {
    if (!Array.isArray(parsed.document_tables) || !parsed.document_tables.length) throw new Error('No supported records found in this document. Use a text-based table or a spreadsheet export.');
    input = validateInput({ tables: parsed.document_tables, text: input.text });
  }
  const selections = parsed.selections.filter(s => ENTITIES[s.entity] && input.tables.some(t => t.name === s.name));
  if (!selections.length) throw new Error('No supported customer, order, received-payment or stock table was found. Use a detailed record export rather than a summary report.');
  for (const s of selections) if (!Array.isArray(s.fields)) throw new Error('Gemini returned an incomplete mapping. Retry.');
  return { input, selections, status_map: parsed.status_map || { pending: [], done: [], excluded: [], blank: 'pending' }, dateOrder: 'dmy', notes: parsed.notes.map(String).slice(0, 20) };
}

export async function runOnboarding({ credentials, workspaceId, apiKey, model = DEFAULT_MODEL, fetchFn, clientFactory }) {
  const { workspace: ws, sources } = makeClients(credentials, { fetchFn });
  await ensureWorkspace(ws, workspaceId, { appVersion: APP_VERSION, actor: 'worker' });
  const { values: settings } = await readKeyValues(ws, workspaceId, 'Settings');
  const request = parseJsonCell(settings.setup_request);
  if (!request?.id) return { status: 'skipped' };
  const { values: last } = await readKeyValues(ws, workspaceId, 'Setup_Result');
  if (last.request_id === request.id && ['ready', 'failed'].includes(last.status)) return { status: 'skipped' };
  await acquireLease(ws, workspaceId, `setup_${request.id}`);
  try {
    await writeKeyValues(ws, workspaceId, 'Setup_Result', { request_id: request.id, status: 'running', proposal: '', error: '' }, { timestamp: false });
    let proposal;
    try { proposal = await prepareProposal(request, sources, { apiKey, model, clientFactory }); }
    catch (e) {
      await writeKeyValues(ws, workspaceId, 'Setup_Result', { request_id: request.id, status: 'failed', error: providerError(e), proposal: '' }, { timestamp: false });
      return { status: 'failed' };
    }
    const { values: fresh } = await readKeyValues(ws, workspaceId, 'Settings');
    if (parseJsonCell(fresh.setup_request)?.id !== request.id) return { status: 'superseded' };
    await writeKeyValues(ws, workspaceId, 'Setup_Result', { request_id: request.id, status: 'ready', proposal, error: '' }, { timestamp: false });
    return { status: 'ready' };
  } finally { await releaseLease(ws, workspaceId); }
}
