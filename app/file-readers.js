// Bundled at publish time. Raw files stay in the browser; only extracted values
// are staged in the student's workspace after they click Prepare source.
import readXlsxFile from 'read-excel-file/browser';
import mammoth from 'mammoth/mammoth.browser.js';
import Papa from 'papaparse';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/build/pdf.mjs';
import { SETUP_LIMITS, validateInput } from './shared/onboarding.mjs';
import { tr, setLocale } from './shared/i18n.mjs';

GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', import.meta.url).href;

// The bundle has its own copy of the translator, so the page passes its current language.
export async function extractFile(file, locale) {
  if (locale) setLocale(locale);
  if (!file || file.size > SETUP_LIMITS.fileBytes) throw new Error(tr('Choose a file no larger than 10 MB.'));
  const extension = file.name.split('.').pop().toLowerCase();
  let input;
  if (extension === 'csv') {
    const parsed = Papa.parse(await file.text(), { skipEmptyLines: 'greedy' });
    if (parsed.errors.length) throw new Error(tr('Could not read this CSV: {0}', parsed.errors[0].message));
    input = { tables: [{ name: file.name, rows: parsed.data }] };
  } else if (extension === 'xlsx') {
    const sheets = await readXlsxFile(file);
    if (sheets.length > SETUP_LIMITS.tables) throw new Error(tr('Use a workbook with at most 12 sheets.'));
    const tables = [];
    for (const { sheet: name, data: rows } of sheets) {
      tables.push({ name, rows: rows.map(r => r.map(v => v instanceof Date ? v.toISOString().slice(0, 10) : v)) });
    }
    input = { tables: tables.filter(t => t.rows.length) };
  } else if (extension === 'docx') {
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    input = { tables: [], text: result.value };
  } else if (extension === 'pdf') {
    // pdf.js 6 exposes destroy() on the loading task, not on the document.
    const task = getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false });
    const document = await task.promise;
    try {
      if (document.numPages > 50) throw new Error(tr('Use a PDF with at most 50 pages.'));
      const pages = [];
      for (let n = 1; n <= document.numPages; n++) {
        const page = await document.getPage(n);
        const content = await page.getTextContent();
        const text = content.items.map(x => x.str + (x.hasEOL ? '\n' : ' ')).join('');
        if (!text.trim()) throw new Error(tr('PDF page {0} has no readable text. Scanned pages need OCR; use a spreadsheet or text-based PDF.', n));
        pages.push(`[Page ${n}]\n${text}`);
      }
      input = { tables: [], text: pages.join('\n\n') };
    } finally { await task.destroy(); }
  } else throw new Error(tr('Choose XLSX, CSV, a text-based PDF, or DOCX. Save older XLS files as XLSX first.'));
  if (!input.tables.length && !input.text?.trim()) throw new Error(tr('The file has no readable records.'));
  return validateInput(input);
}
