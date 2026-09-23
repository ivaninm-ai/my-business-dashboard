import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareSetup, saveSetup, validateInput } from '../app/shared/onboarding.mjs';
import { runOnboarding, prepareProposal } from '../worker/onboarding.mjs';
import { generateJson } from '../worker/gemini.mjs';
import { runImport } from '../worker/importer.mjs';
import { readKeyValues, writeKeyValues, parseJsonCell } from '../app/shared/workspace.mjs';
import { startFakeEnv } from './helpers/fake-env.mjs';
const schema=JSON.parse(readFileSync(new URL('../app/shared/setup-package.schema.json',import.meta.url)));
const request=()=>({id:'prepare_1',source:{source_id:'stock_file',kind:'manual_package',label:'Warehouse stock'},profile:{name:'Practice',synthetic:true,currency:'MYR',timezone:'Asia/Kuala_Lumpur'},aiDataMode:'synthetic',dataAsOf:'2026-08-30',fileName:'stock.csv',reportingMode:'latest_event_date',input:{tables:[{name:'Stock',rows:[['SKU','Qty','Min'],['R1',8,10]]}]}});
const selection={name:'Stock',entity:'stock',header_row:1,fields:[{canonical:'id',header:'SKU'},{canonical:'on_hand',header:'Qty'},{canonical:'reorder_threshold',header:'Min'}]};
const proposal=()=>({input:request().input,selections:[structuredClone(selection)],status_map:{pending:[],done:[],excluded:[],blank:'pending'},notes:[]});
const response=obj=>({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(obj)}]}}]});
const fake=()=>({generateContent:async()=>response({...proposal(),document_tables:[]})});

test('proposal previews numeric records and keeps the original file values for deterministic import',()=>{
  const out=prepareSetup({request:request(),proposal:proposal(),schema});
  assert.equal(out.preview[0].rows,1);assert.equal(out.pkg.confirmation.state,'confirmed');
  assert.deepEqual(out.entries['manual_rows.stock_file_stock'],request().input.tables[0].rows);
});
test('duplicate IDs, duplicated headers and missing stable IDs fail before activation',()=>{
  const p=proposal();p.input.tables[0].rows.push(['R1',5,10]);
  assert.throws(()=>prepareSetup({request:request(),proposal:p,schema}),/appears on rows/);
  p.input.tables[0].rows=[['SKU','Qty','Qty'],['R1',3,4]];
  assert.throws(()=>prepareSetup({request:request(),proposal:p,schema}),/duplicated/);
  const noId=proposal();noId.selections[0].fields.shift();
  assert.throws(()=>prepareSetup({request:request(),proposal:noId,schema}),/id/i);
});
test('a second source cannot silently replace an existing authoritative table',()=>{
  const first=prepareSetup({request:request(),proposal:proposal(),schema});
  const second=request();second.source.source_id='other_stock';
  assert.throws(()=>prepareSetup({request:second,proposal:proposal(),previous:first.pkg,schema}),/authoritative source/);
});
test('source date order changes do not change unrelated source date parsing',()=>{
  const first=prepareSetup({request:request(),proposal:proposal(),schema});
  const second=request();second.source.source_id='sales_file';
  const p={input:{tables:[{name:'Orders',rows:[['ID','Date','Total'],['S1','09/01/2026',20]]}]},selections:[{name:'Orders',entity:'sales',header_row:1,fields:[{canonical:'id',header:'ID'},{canonical:'date',header:'Date'},{canonical:'amount',header:'Total'}]}],dateOrder:'mdy',status_map:{pending:[],done:[],excluded:[],blank:'pending'}};
  const out=prepareSetup({request:second,proposal:p,previous:first.pkg,schema});
  assert.equal(out.pkg.policies.dates.order,'dmy');
  assert.equal(out.pkg.tables.find(t=>t.entity==='sales').fields.find(f=>f.canonical==='date').date_order,'mdy');
});
test('private data never reaches an unpaid-mode provider call',async()=>{
  const r=request();r.profile.synthetic=false;
  await assert.rejects(prepareProposal(r,{}, {apiKey:'x',clientFactory:()=>{throw new Error('provider must not be called');}}),/billing-enabled/);
});
test('oversized extracted data is rejected, never silently truncated',()=>{
  assert.throws(()=>validateInput({tables:[],text:'x'.repeat(80001)}),/80,000/);
});
test('Gemini transport uses a secret header, rejects truncation, and classifies quota without leaking upstream data',async()=>{
  let captured;
  const result=await generateJson({apiKey:'private-test-key',system:'rules',prompt:'data',fetchFn:async(url,init)=>{captured={url,init};return {ok:true,json:async()=>response({ok:true})};}});
  assert.equal(result.parsed.ok,true);assert.equal(captured.init.headers['x-goog-api-key'],'private-test-key');
  assert.ok(!captured.url.includes('private-test-key'));assert.ok(!captured.init.body.includes('private-test-key'));
  await assert.rejects(generateJson({apiKey:'key',clientFactory:()=>({generateContent:async()=>({candidates:[{finishReason:'MAX_TOKENS'}]})})}),/complete result/);
  await assert.rejects(generateJson({apiKey:'key',fetchFn:async()=>({ok:false,status:429,json:async()=>({error:{message:'PRIVATE SOURCE CONTENT'}})})}),e=>e.status===429&&!e.message.includes('PRIVATE'));
});
test('worker proposal requires review; activation and replacement preserve decisions; stale previews are rejected',async()=>{
  const env=await startFakeEnv();
  try {
    const id=await env.createWorkspace();const req=request();
    await writeKeyValues(env.browser,id,'Settings',{setup_request:req});
    const ready=await runOnboarding({credentials:env.credentials,workspaceId:id,apiKey:'test',clientFactory:fake});
    assert.equal(ready.status,'ready');
    let settings=(await readKeyValues(env.browser,id,'Settings')).values;
    assert.ok(!settings.setup_package,'AI cannot activate its own proposal');
    assert.equal((await runOnboarding({credentials:env.credentials,workspaceId:id,apiKey:'test',clientFactory:()=>{throw new Error('duplicate call')}})).status,'skipped');
    const result=(await readKeyValues(env.browser,id,'Setup_Result')).values;
    const prepared=prepareSetup({request:req,proposal:parseJsonCell(result.proposal),schema});
    await saveSetup(env.browser,id,prepared,req,settings);
    const imported = await runImport({credentials:env.credentials,workspaceId:id});
    assert.equal(imported.status,'success',JSON.stringify(imported));
    await env.saveDecision(id,{task_key:'review_replenishment:R1',status:'accepted',note:'Call supplier'});
    const next=request();next.id='prepare_2';next.input.tables[0].rows[1][1]=33;
    await writeKeyValues(env.browser,id,'Settings',{setup_request:next});
    settings=(await readKeyValues(env.browser,id,'Settings')).values;
    const nextProposal=proposal();nextProposal.input=next.input;
    const updated=prepareSetup({request:next,proposal:nextProposal,previous:parseJsonCell(settings.setup_package),schema});
    await saveSetup(env.browser,id,updated,next,settings);
    await runImport({credentials:env.credentials,workspaceId:id});
    assert.equal((await env.read(id,'Data_stock'))[0].on_hand,33);
    assert.equal((await env.read(id,'Task_Decisions'))[0].note,'Call supplier');
    await assert.rejects(saveSetup(env.browser,id,updated,next,settings),/changed|newer/);
  }finally{await env.close();}
});
