import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {writeLiveState} from '../../plugins/core/skills/core/scripts/memory-view-watch.mjs';
for(const location of ['project','local-history','global-history','first-account-write','first-account-alias','alias-history'])test(`supplied live-state ${location}: preserved grant and no outside replacement`,()=>{
 const base=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'live-state-destination-')));try{
  const home=join(base,'home'),root=join(base,'project');fs.mkdirSync(home);fs.mkdirSync(root);
  let folder=location==='project'?join(root,'.core','codex'):location==='local-history'?join(home,'.core','local','key','codex'):join(home,'.core','artifact-receipts');
  if(location==='alias-history'){const target=join(home,'.core','local','key','codex');fs.mkdirSync(target,{recursive:true});folder=join(base,'history-alias');fs.symlinkSync(target,folder,process.platform==='win32'?'junction':'dir');}
  if(location==='first-account-alias'){const alias=join(base,'home-alias');fs.symlinkSync(home,alias,process.platform==='win32'?'junction':'dir');folder=join(alias,'.core','local','key','codex');}
  const path=join(folder,'memory-view-live.json'),before='synthetic old grant and publish budget\n';
  if(!location.startsWith('first-account')){fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path,before);}
  const args={home,artifactUrl:'https://example.invalid/synthetic',scope:'active',baselineSnapshot:'synthetic-snapshot',grantBasis:'synthetic current scope',publishCount:2};
  if(location==='project'){const record=writeLiveState(path,args);assert.equal(record.publish_budget.count,2);assert.equal(record.grant_basis,args.grantBasis);}else{assert.throws(()=>writeLiveState(path,args),e=>e.code==='STATE_NO_PROJECT_PLACE');if(location.startsWith('first-account'))assert.equal(fs.existsSync(join(home,'.core')),false);else assert.equal(fs.readFileSync(path,'utf8'),before);}
  const preload=`import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';os.userInfo=()=>({homedir:${JSON.stringify(home)}});os.homedir=()=>${JSON.stringify(home)};syncBuiltinESMExports();`;
  const script=fileURLToPath(new URL('../../plugins/core/skills/core/scripts/memory-view-watch.mjs',import.meta.url));
  const child=spawnSync(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(preload),script,'--write-live-state',path,'--artifact-url',args.artifactUrl,'--scope','active','--baseline-snapshot',args.baselineSnapshot,'--grant-basis',args.grantBasis,'--publish-count','2'],{encoding:'utf8',env:{...process.env,NODE_OPTIONS:''},timeout:10000});assert.equal(child.error,undefined,child.stderr);
  if(location==='project')assert.equal(child.status,0,child.stderr);else{assert.equal(child.status,1);assert.match(child.stderr,/not stored:/);if(location.startsWith('first-account'))assert.equal(fs.existsSync(join(home,'.core')),false);else assert.equal(fs.readFileSync(path,'utf8'),before);}
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});
