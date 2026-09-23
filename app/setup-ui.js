import { ENTITIES } from './shared/model.mjs';
import { businessProfile, prepareSetup, saveSetup } from './shared/onboarding.mjs';
import { readKeyValues, writeKeyValues, parseJsonCell } from './shared/workspace.mjs';
import { extractSpreadsheetId } from './shared/sheets.mjs';

export function renderBusinessSetup(ctx) {
  const { h, t, add, state, toast, modal, loadSchema, loadWorkspace, navigate } = ctx;
  const root = h('div', { class: 'card', id: 'business-setup' }, t('h2', 'Business setup'), t('p', 'Describe your business, connect a source, then review its records here. No chat, Skill installation or code is needed.', 'small ink2'));
  const profile = parseJsonCell(state.ws.settings.business_profile, state.pkg?.business || {});
  // A queued request carries the owner's latest choices until it is activated.
  const pending = parseJsonCell(state.ws.settings.setup_request);
  const field = (label, value = '', type = 'text') => {
    const input = h('input', { type, value, 'aria-label': label });
    return { input, node: h('label', { class: 'stack' }, t('span', label), input) };
  };
  const select = (label, options, value) => {
    const el = h('select', { 'aria-label': label }, ...options.map(([key, text]) => h('option', { value: key, selected: key === value }, text)));
    return { input: el, node: h('label', { class: 'stack' }, t('span', label), el) };
  };
  const name = field('Business name', profile.name);
  const model = select('Business type', [['b2c', 'Sell to consumers'], ['b2b', 'Sell to businesses'], ['service', 'Services / bookings'], ['mixed', 'Mixed'], ['other', 'Other']], profile.model || 'other');
  const description = field('What do you sell or do?', profile.description);
  const language = select('Brief language', [['en', 'English'], ['zh-CN', '中文'], ['ms', 'Bahasa Melayu']], profile.locale || 'en');
  const currency = field('Currency (e.g. MYR)', profile.currency || 'MYR');
  const timezone = field('Timezone', profile.timezone || 'Asia/Kuala_Lumpur');
  const guidance = field('AI priorities and tone', profile.ai_guidance || 'Focus on overdue payments and upcoming commitments. Use clear, practical language.');
  const dataMode = select('AI data setting', [['', 'Choose before sending data'], ['synthetic', 'Synthetic practice records · free tier'], ['paid', 'Real business records · billing-enabled Gemini project']], profile.synthetic === true ? 'synthetic' : state.ws.settings.ai_data_mode || '');
  const reporting = select('Report date', [['today', 'Today (daily business)'], ['latest_event_date', 'Latest record date (historical practice data)']], pending?.reportingMode || state.pkg?.reporting_date?.mode || state.ws.settings.reporting_mode || 'today');
  const readProfile = () => businessProfile({ ...profile, name: name.input.value, model: model.input.value, description: description.input.value, locale: language.input.value, currency: currency.input.value, timezone: timezone.input.value, ai_guidance: guidance.input.value, synthetic: dataMode.input.value === 'synthetic' });
  const grid = h('div', { class: 'two' }, ...[name, model, description, language, currency, timezone, guidance, dataMode, reporting].map(f => f.node));
  add(root, grid, t('p', 'Gemini receives the profile, source samples (document text for PDFs/DOCX) and daily facts. Google’s free tier must not receive personal or confidential records. This selection records your choice; it does not enable billing.', 'small ink2'), h('a', { href: 'https://ai.google.dev/gemini-api/terms', target: '_blank', rel: 'noopener' }, 'Google data terms ↗'));
  add(root, h('button', { class: 'btn', onclick: async () => {
    try {
      if (!dataMode.input.value) throw new Error('Choose your AI data setting.');
      const p = readProfile();
      const { values: current } = await readKeyValues(state.client, state.ws.id, 'Settings');
      if ((current.setup_package || '') !== (state.ws.settings.setup_package || '')) throw new Error('Settings changed. Reload first.');
      // reporting_mode keeps the choice before the first source is activated.
      const entries = { business_profile: p, ai_data_mode: dataMode.input.value, reporting_mode: reporting.input.value };
      if (state.pkg) entries.setup_package = { ...state.pkg, business: p, reporting_date: { mode: reporting.input.value } };
      await writeKeyValues(state.client, state.ws.id, 'Settings', entries);
      await loadWorkspace({ silent: true }); toast('Business profile saved.');
    } catch (e) { toast(e.message, { error: true, ms: 8000 }); }
  } }, 'Save business profile'));

  const existing = state.pkg?.sources || [];
  const sourceChoice = select('Source', [['new', 'Add a new source'], ...existing.map(s => [s.source_id, `Update / remap: ${s.label || s.source_id}`])], 'new');
  const kind = select('Source type', [['google_sheet', 'Live Google Sheet'], ['manual_package', 'Local file: XLSX / CSV / PDF / DOCX']], 'google_sheet');
  const sourceLabel = field('Source name', 'My business records');
  const sheetLink = field('Google Sheet link');
  const file = h('input', { type: 'file', accept: '.xlsx,.csv,.pdf,.docx', 'aria-label': 'Source file' });
  const date = field('File data as of', '', 'date');
  const fileBox = h('div', { class: 'stack', hidden: true }, file, date.node, t('p', 'Files: 10 MB; tables: 5,000 records each; text documents: 80,000 characters. Upload only the source that changed.', 'small'));
  const toggle = () => { const manual = kind.input.value === 'manual_package'; sheetLink.node.hidden = manual; fileBox.hidden = !manual; };
  kind.input.addEventListener('change', toggle);
  sourceChoice.input.addEventListener('change', () => {
    const source = existing.find(s => s.source_id === sourceChoice.input.value);
    kind.input.disabled = !!source;
    if (source) {
      kind.input.value = source.kind; sourceLabel.input.value = source.label || source.source_id;
      const binding = state.ws.sources.find(s => s.source_id === source.source_id);
      sheetLink.input.value = binding?.spreadsheet_id || source.spreadsheet_id || '';
      date.input.value = parseJsonCell(state.ws.settings[`source_meta.${source.source_id}`], {}).data_as_of || '';
    }
    toggle();
  });
  const repo = state.config.repo || {};
  const runUrl = repo.owner && repo.name ? `https://github.com/${repo.owner}/${repo.name}/actions/workflows/import.yml` : null;
  const runLink = () => runUrl ? h('a', { class: 'btn', href: runUrl, target: '_blank', rel: 'noopener' }, 'Open Import data → Run workflow ↗') : t('p', 'Run “2 · Import data” in your repository Actions.');
  add(root, t('h3', 'Connect or update a source'), sourceChoice.node, kind.node, sourceLabel.node, sheetLink.node, fileBox,
    t('p', 'For a live Sheet, share it with your service-account email as Viewer. File replacements keep other sources and task decisions. One authoritative table per record type is supported.', 'small'),
    h('button', { class: 'btn primary', onclick: async event => {
      const button = event.currentTarget; button.disabled = true;
      try {
        if (!dataMode.input.value) throw new Error('Choose your AI data setting first.');
        const p = readProfile();
        const old = existing.find(s => s.source_id === sourceChoice.input.value);
        const source = { source_id: old?.source_id || 's_' + crypto.randomUUID().replaceAll('-', '').slice(0, 20), kind: kind.input.value, label: sourceLabel.input.value.trim().slice(0,120) };
        let input = { tables: [] }, fileName = '';
        if (source.kind === 'google_sheet') {
          source.spreadsheet_id = extractSpreadsheetId(sheetLink.input.value);
          if (!source.spreadsheet_id) throw new Error('Paste a valid Google Sheet link.');
          if (source.spreadsheet_id === state.ws.id) throw new Error('Choose your original data Sheet, not the Dashboard Workspace.');
        } else {
          if (!file.files?.[0]) throw new Error('Choose the updated source file.');
          if (!date.input.value) throw new Error('Choose the date these records describe.');
          const { extractFile } = await import('./vendor/file-readers.js');
          input = await extractFile(file.files[0]); fileName = file.files[0].name;
        }
        const request = { id: crypto.randomUUID(), source, input, fileName, dataAsOf: date.input.value, profile: p, aiDataMode: dataMode.input.value, reportingMode: reporting.input.value, basePackage: state.ws.settings.setup_package || '', requestedAt: new Date().toISOString() };
        await writeKeyValues(state.client, state.ws.id, 'Settings', { setup_request: request, business_profile: p, ai_data_mode: dataMode.input.value, reporting_mode: reporting.input.value });
        await loadWorkspace({ silent: true }); navigate('settings'); toast('Source queued. Run Import data, then Reload here to review.');
      } catch (e) { toast(e.message, { error: true, ms: 10000 }); }
      finally { button.disabled = false; }
    } }, 'Prepare source'),
    t('p', 'Preparation runs in GitHub Actions. To process it now, open the link below and click Run workflow. Otherwise it waits for the next hourly worker opportunity; GitHub can delay runs. Return here and press Reload to review.', 'small'), runLink());

  if (pending) {
    const statusBox = h('div', { class: 'card' }, t('h3', 'Source preparation'), t('p', 'Checking preparation status…'));
    add(root, statusBox);
    readKeyValues(state.client, state.ws.id, 'Setup_Result').then(({ values }) => {
      statusBox.textContent = ''; add(statusBox, t('h3', pending.source.label));
      if (values.request_id !== pending.id || !['ready', 'failed'].includes(values.status)) add(statusBox, t('p', 'Waiting for the worker. Run Import data, wait for it to finish, then Reload this dashboard.'));
      else if (values.status === 'failed') add(statusBox, t('p', values.error || 'Preparation failed.', 'bad'), h('button', { class: 'btn', onclick: async () => {
        await writeKeyValues(state.client, state.ws.id, 'Settings', { setup_request: { ...pending, id: crypto.randomUUID() } });
        await loadWorkspace({ silent: true }); toast('Retry queued. Run Import data.');
      } }, 'Retry preparation'));
      else {
        const proposal = parseJsonCell(values.proposal);
        add(statusBox, t('p', 'Ready for review. Nothing has been activated yet.'), h('button', { class: 'btn primary', onclick: () => review(pending, proposal) }, 'Review detected records'));
      }
      add(statusBox, h('button', { class: 'btn ghost', onclick: async () => { await writeKeyValues(state.client, state.ws.id, 'Settings', { setup_request: '' }); await loadWorkspace({ silent: true }); } }, 'Cancel this preparation'));
    }).catch(e => { statusBox.textContent = e.message; });
  }

  function review(request, draft) {
    const proposal = structuredClone(draft);
    const body = h('div', {}, t('p', 'Confirm what each row and column means. Fields marked * are required. Ignored tables are not imported.'));
    add(body, h('ul', {}, ...(proposal.notes || []).map(n => h('li', {}, n))));
    const savedOrder = (state.pkg?.tables || []).filter(tb => tb.source_id === request.source.source_id).flatMap(tb => tb.fields).find(f => f.date_order)?.date_order;
    const order = select('Date format in this source', [['dmy','Day / month / year'],['mdy','Month / day / year'],['ymd','Year / month / day']], savedOrder || proposal.dateOrder || 'dmy'); add(body,order.node);
    const editors = [];
    for (const table of proposal.input.tables) {
      const guess = proposal.selections.find(s => s.name === table.name);
      const entity = select(`${table.name}: each row represents`, [['','Ignore this table'],...Object.entries(ENTITIES).map(([key,spec])=>[key,spec.row_meaning])], guess?.entity || ''); entity.input.dataset.entity = table.name;
      const header = field('Row containing column names', guess?.header_row || 1, 'number');
      const mapping = h('div', { class:'stack' });
      const chosen = new Map();
      const remap = () => {
        mapping.textContent = ''; chosen.clear();
        if (!ENTITIES[entity.input.value]) return;
        const headers = table.rows[Number(header.input.value)-1] || [];
        for (const [key,spec] of Object.entries(ENTITIES[entity.input.value].fields)) {
          const old = guess?.entity === entity.input.value ? guess.fields.find(f=>f.canonical===key) : null;
          const pick = select(`${key}${spec.required?' *':''}${spec.doc?' — '+spec.doc:''}`, [['','Not provided'],...headers.filter(v=>v!==null&&v!=='').map(v=>[String(v),String(v)])], old?.header || '');
          chosen.set(key,pick.input); add(mapping,pick.node);
        }
      };
      entity.input.addEventListener('change',remap); header.input.addEventListener('change',remap); remap();
      const tableView = h('div', { class:'table-wrap' }, h('table', {}, h('tbody', {}, ...table.rows.slice(0,51).map(row=>h('tr',{},...row.map(v=>t('td',String(v??''))))))));
      // Documents get the full extracted record table; spreadsheet samples stay compact.
      if (proposal.input.text && table.rows.length > 51) for (const row of table.rows.slice(51)) add(tableView.querySelector('tbody'),h('tr',{},...row.map(v=>t('td',String(v??'')))));
      const recordSection = h('details',{},h('summary',{},`${table.name}: ${table.rows.length} extracted rows including headers — view records`),tableView);
      add(body,h('div',{class:'card'},recordSection,entity.node,header.node,mapping));
      editors.push(()=>({name:table.name,entity:entity.input.value,header_row:Number(header.input.value),fields:[...chosen].filter(([,el])=>el.value).map(([canonical,el])=>({canonical,header:el.value}))}));
    }
    // Order statuses only matter when this source supplies the sales table.
    const statusBox = h('div', { class:'stack' });
    const statusFields = {};
    for(const bucket of ['pending','done','excluded']) {
      const control = field(`Order statuses meaning ${bucket} (separate with commas)`, (proposal.status_map?.[bucket]||[]).join(', ')); statusFields[bucket]=control.input; add(statusBox,control.node);
    }
    const blank = select('Blank order status means',[['pending','Pending'],['done','Done'],['excluded','Excluded'] ],proposal.status_map?.blank || 'pending'); add(statusBox,blank.node);
    add(body,statusBox);
    const syncStatus = () => { statusBox.hidden = !body.querySelectorAll('select[data-entity]').length || ![...body.querySelectorAll('select[data-entity]')].some(s => s.value === 'sales'); };
    body.querySelectorAll('select[data-entity]').forEach(s => s.addEventListener('change', syncStatus)); syncStatus();
    if(proposal.input.text) add(body,t('p','Compare all extracted rows with the original document, especially IDs, amounts and dates. AI extraction can omit or misread records.','warn'));
    const check = h('input',{type:'checkbox'});
    add(body,h('label',{},check,' I checked the source rows, column meanings and status choices.'));
    modal('Review source',body,{actions:[{label:'Validate and preview totals',primary:true,onclick:async()=>{
      try {
        if(!check.checked) throw new Error('Review the records and tick the confirmation box.');
        if((state.ws.settings.setup_package||'')!==request.basePackage) throw new Error('Business setup changed since this request. Prepare the source again.');
        proposal.selections=editors.map(fn=>fn()).filter(s=>s.entity);
        proposal.dateOrder=order.input.value;
        proposal.status_map={...Object.fromEntries(Object.entries(statusFields).map(([key,el])=>[key,el.value.split(',').map(s=>s.trim()).filter(Boolean)])),blank:blank.input.value};
        const prepared=prepareSetup({request,proposal,previous:state.pkg,schema:await loadSchema(),actor:state.email});
        const expected={...state.ws.settings};
        const preview=h('div',{},t('p','This will save the selected source and its mapping. Existing task decisions and other sources are retained.'),h('ul',{},...prepared.preview.map(p=>h('li',{},`${p.entity}: ${p.rows} records${['sales','payments'].includes(p.entity)?` · amount column total ${prepared.pkg.business.currency} ${p.amount.toLocaleString()} (every row, including cancelled or excluded statuses — compare with your file's column sum)`:''}`,h('ul',{},...p.warnings.map(w=>h('li',{},w)))))));
        modal('Confirm source totals',preview,{actions:[{label:'Activate source',primary:true,onclick:async()=>{
          try { await saveSetup(state.client,state.ws.id,prepared,request,expected); await loadWorkspace({silent:true}); navigate('connections'); toast('Source activated. Run Import data to refresh figures.'); }
          catch(e){toast(e.message,{error:true,ms:10000}); return true;}
        }}]});
      } catch(e){toast(e.message,{error:true,ms:10000});}
      return true;
    }}]});
  }
  return root;
}
