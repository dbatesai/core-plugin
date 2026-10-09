import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {recordPublishOutcome,recordRevocation,publishReceiptPathFor} from '../../plugins/core/skills/core/scripts/artifact-receipts.mjs';
for(const location of ['project','local-history','global-history','first-account-write','first-account-alias'])test(`historical ${location} receipt: actual publish/revocation destination and preserved input`,()=>{
 const base=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'receipt-history-location-')));try{
  const home=join(base,'home'),root=join(base,'project');fs.mkdirSync(home);let dir=location==='project'?join(root,'_core','codex','artifact-receipts'):location==='local-history'?join(home,'.core','local','synthetic-key','codex','artifact-receipts'):join(home,'.core','artifact-receipts');if(location==='first-account-alias'){const alias=join(base,'home-alias');fs.symlinkSync(home,alias,process.platform==='win32'?'junction':'dir');dir=join(alias,'.core','artifact-receipts');}if(!location.startsWith('first-account'))fs.mkdirSync(dir,{recursive:true});
  const path=join(dir,'generation.json'),gen=JSON.stringify({kind:'core-memory-browse-preflight',schema_version:'1',generated_at:'2026-01-01T00:00:00Z',artifact_sha256:'a'.repeat(64),project:root});if(location.startsWith('first-account')){assert.throws(()=>recordPublishOutcome({generationReceiptPath:path,status:'declined',home}),e=>e.code==='STATE_NO_PROJECT_PLACE');assert.equal(fs.existsSync(join(home,'.core')),false);return;}fs.writeFileSync(path,gen);
  if(location==='project'){const result=recordPublishOutcome({generationReceiptPath:path,status:'declined',home});assert.equal(result.path,publishReceiptPathFor(path));assert.equal(fs.existsSync(result.path),true);}else{assert.throws(()=>recordPublishOutcome({generationReceiptPath:path,status:'declined',home}),e=>e.code==='STATE_NO_PROJECT_PLACE'&&e.reason==='historical-receipt-outside-project');assert.equal(fs.existsSync(publishReceiptPathFor(path)),false);}
  assert.equal(fs.readFileSync(path,'utf8'),gen);
  const published=join(dir,'previous-published.publish.json'),before=JSON.stringify({kind:'core-memory-browse-publish',publish_status:'published-private',revoked_at:null});fs.writeFileSync(published,before);
  if(location==='project'){const result=recordRevocation(published,{home});assert.equal(result.path,published);assert.ok(result.receipt.revoked_at);}else{assert.throws(()=>recordRevocation(published,{home}),e=>e.code==='STATE_NO_PROJECT_PLACE'&&e.reason==='historical-receipt-outside-project');assert.equal(fs.readFileSync(published,'utf8'),before);}
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});
