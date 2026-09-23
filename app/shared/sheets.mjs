import { tr } from './i18n.mjs';
// Thin Google Sheets API v4 client used by both the browser (user OAuth token,
// drive.file scope) and the worker (service-account token). It only ever talks to
// the configured API host and never logs cell contents or tokens.

export const DEFAULT_API_BASE = 'https://sheets.googleapis.com';

export class SheetsError extends Error {
  constructor(message, { status, stage, code } = {}) {
    super(message);
    this.status = status;
    this.stage = stage;
    this.code = code || (status === 401 ? 'unauthorised' : status === 403 ? 'forbidden' : status === 404 ? 'not_found' : status === 429 ? 'rate_limited' : 'request_failed');
  }
}

const HINTS = {
  400: 'Google rejected the request. Check the spreadsheet ID and the range/sheet name.',
  401: 'The access token was rejected or has expired. Reconnect and try again.',
  403: 'Access denied. Share the workbook with the correct account (service account as Editor for the workspace, Viewer for sources) and make sure the Google Sheets API is enabled.',
  404: 'Spreadsheet not found. Check the ID and that this account can access it.',
  429: 'Google is limiting requests. Wait a minute and retry.',
};

export function extractSpreadsheetId(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  const m = t.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]{10,})/);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{10,}$/.test(t) ? t : null;
}

export function quoteSheet(name) {
  return `'${String(name).replace(/'/g, "''")}'`;
}

export function createSheetsClient({ apiBase = DEFAULT_API_BASE, getToken, fetchFn = globalThis.fetch, timeoutMs = 30000 }) {
  if (typeof getToken !== 'function') throw new Error('createSheetsClient needs a getToken function');
  const base = apiBase.replace(/\/$/, '');

  async function call(stage, method, pathAndQuery, body) {
    const token = await getToken();
    let response;
    try {
      response = await fetchFn(`${base}/v4/spreadsheets${pathAndQuery}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new SheetsError(tr('{0}: could not reach Google Sheets (network error or timeout).', stage), { stage, code: 'network' });
    }
    if (!response.ok) {
      // Do not include the upstream body: it can echo private cell values.
      throw new SheetsError(tr('{0}: HTTP {1}. {2}', stage, response.status, HINTS[response.status] ? tr(HINTS[response.status]) : tr('Google could not complete the request.')), { status: response.status, stage });
    }
    try { return await response.json(); }
    catch { throw new SheetsError(tr('{0}: Google returned an unreadable response.', stage), { stage, code: 'bad_response' }); }
  }

  const q = obj => new URLSearchParams(obj).toString();

  return {
    apiBase: base,
    async getSpreadsheet(id) {
      const data = await call(tr('Open workbook'), 'GET', `/${encodeURIComponent(id)}?${q({ fields: 'spreadsheetId,properties.title,sheets.properties(sheetId,title,index,gridProperties)' })}`);
      return { id: data.spreadsheetId, title: data.properties?.title || '', sheets: (data.sheets || []).map(s => s.properties) };
    },
    async batchGet(id, ranges) {
      const params = new URLSearchParams({ majorDimension: 'ROWS', valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER' });
      for (const r of ranges) params.append('ranges', r);
      const data = await call(tr('Read workbook'), 'GET', `/${encodeURIComponent(id)}/values:batchGet?${params}`);
      if (!Array.isArray(data.valueRanges)) throw new SheetsError(tr('Read workbook: response did not contain the requested ranges.'), { code: 'bad_response' });
      return data.valueRanges.map(vr => ({ range: vr.range, values: Array.isArray(vr.values) ? vr.values : [] }));
    },
    async update(id, range, values) {
      return call(tr('Write workbook'), 'PUT', `/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?${q({ valueInputOption: 'RAW' })}`, { range, majorDimension: 'ROWS', values });
    },
    async batchUpdateValues(id, data) {
      return call(tr('Write workbook'), 'POST', `/${encodeURIComponent(id)}/values:batchUpdate`, { valueInputOption: 'RAW', data: data.map(d => ({ range: d.range, majorDimension: 'ROWS', values: d.values })) });
    },
    async append(id, range, values) {
      return call(tr('Append rows'), 'POST', `/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}:append?${q({ valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' })}`, { range, majorDimension: 'ROWS', values });
    },
    async clear(id, range) {
      return call(tr('Clear range'), 'POST', `/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}:clear`, {});
    },
    async batchUpdate(id, requests) {
      return call(tr('Update workbook structure'), 'POST', `/${encodeURIComponent(id)}:batchUpdate`, { requests });
    },
    async create(title, sheetTitles) {
      const data = await call(tr('Create workbook'), 'POST', '', {
        properties: { title },
        sheets: sheetTitles.map((t, i) => ({ properties: { title: t, index: i } })),
      });
      return { id: data.spreadsheetId, url: data.spreadsheetUrl, title: data.properties?.title };
    },
  };
}
