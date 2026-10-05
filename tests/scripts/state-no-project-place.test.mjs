import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {stateDir,ensureStateDir,writeStamp,localStateDir,updateManifest,writeBootstrap,ensureInstallIdentity,classifyStamp} from '../../plugins/core/skills/core/scripts/project-state.mjs';
import {touchProject} from '../../plugins/core/skills/core/scripts/index-registry.mjs';
import {operationalMetricsDir,trustedMetricsDir} from '../../plugins/core/skills/core/scripts/log-event.mjs';
import {appendRows} from '../../plugins/core/skills/core/scripts/capability-history.mjs';
import {buildRollup,writeRollup} from '../../plugins/core/skills/core/scripts/metrics-rollup.mjs';
import {generationReceiptLocation,publishArtifactWithReceipt} from '../../plugins/core/skills/core/scripts/artifact-receipts.mjs';
import {runClassification} from '../../plugins/core/skills/core/scripts/classify-turns.mjs';
import {runDetectors} from '../../plugins/core/skills/core/scripts/metrics-detectors.mjs';
import {mapProjectPathToSlug} from '../../plugins/core/skills/core/scripts/project-slug.mjs';
import {turnCapturePurgeScope} from '../../plugins/core/skills/core/scripts/turn-capture.mjs';
import {noticeTextFor,checkMetricsDisclosure,HISTORY_NOTICE_VERSION} from '../../plugins/core/skills/core/scripts/metrics-disclosure.mjs';

import {initMetrics} from '../../plugins/core/skills/core/scripts/metrics-init.mjs';

const routes=['registered','unregistered','not-a-project-root','root-not-writable','migrating','migrating-dangling','foreign-install','ask'];
function snapshot(root){const out={};if(!fs.existsSync(root))return out;const walk=d=>{for(const name of fs.readdirSync(d)){const p=join(d,name),s=fs.lstatSync(p);out[p.slice(root.length)]={type:s.isDirectory()?'dir':'file',hash:s.isFile()?createHash('sha256').update(fs.readFileSync(p)).digest('hex'):null};if(s.isDirectory())walk(p);}};walk(root);return out;}
function fixture(route,harness){
 const base=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'core-no-place-'))),home=join(base,'home'),coreDir=join(home,'.core');fs.mkdirSync(coreDir,{recursive:true});let root=join(base,'project');fs.mkdirSync(root);
 if(route==='not-a-project-root')root=home;
 if(route==='ask'){
  const old=join(base,'external','project');fs.mkdirSync(old,{recursive:true});writeStamp({root:old,harness,coreDir});fs.rmdirSync(root);fs.renameSync(old,root);fs.rmdirSync(dirname(old));assert.equal(classifyStamp({root,harness,coreDir}).status,'ask');
 }
 if(route==='foreign-install'){
  ensureInstallIdentity({coreDir});const d=join(root,'.core',harness);fs.mkdirSync(d,{recursive:true});fs.writeFileSync(join(d,'stamp'),JSON.stringify({path:root,harness,install_id:'f'.repeat(32),hmac:'b'.repeat(64)}));assert.equal(classifyStamp({root,harness,coreDir}).status,'foreign-install');
 }
 fs.cpSync(fileURLToPath(new URL('../fixtures/obligation3-store/_memories/',import.meta.url)),join(root,'_memories'),{recursive:true});
 if(route.startsWith('migrating')){writeStamp({root,harness,coreDir});const marker=join(root,'.core',harness,'.migrating');if(route==='migrating-dangling')fs.symlinkSync(join(base,'absent-migration-target'),marker,process.platform==='win32'?'junction':'file');else fs.writeFileSync(marker,'synthetic pending migration');}
 if(route!=='unregistered')fs.writeFileSync(join(coreDir,'projects.json'),JSON.stringify([{path:root}]));
 if(route==='root-not-writable')fs.chmodSync(root,0o555);
 return {base,home,coreDir,root,cleanup(){if(route==='root-not-writable')fs.chmodSync(root,0o755);fs.rmSync(base,{recursive:true,force:true});}};
}
for(const harness of ['claude-code','codex'])for(const route of routes)test(`${harness}: actual writers ${route}; history preserved and no account fallback writes`,{skip:route==='root-not-writable'&&(process.platform==='win32'||process.getuid?.()===0)},()=>{
 const c=fixture(route,harness);try{
  const reason=route==='migrating-dangling'?'migrating':route;
  const {root,home,coreDir}=c,env={CORE_HARNESS:harness,CORE_METRICS_ENABLED:'1'};
  const history=join(localStateDir({root,harness,coreDir}),'metrics','classified');fs.mkdirSync(history,{recursive:true});fs.writeFileSync(join(history,'2025-01-01.jsonl'),'synthetic retained history\n');
  const labels=join(dirname(history),'calibration','human-labels.jsonl');fs.mkdirSync(dirname(labels),{recursive:true});fs.writeFileSync(labels,'synthetic retained human label\n');
  const before=snapshot(join(coreDir,'local')),beforeReceipts=snapshot(join(coreDir,'artifact-receipts'));
  const sid='synthetic-session';
  const transcript=harness==='claude-code'?join(home,'.claude','projects',mapProjectPathToSlug(root),sid+'.jsonl'):join(home,'.codex','sessions','2026','01','01','rollout-'+sid+'.jsonl');
  fs.mkdirSync(dirname(transcript),{recursive:true});
  const events=harness==='claude-code'?[{message:{role:'user',content:[{type:'text',text:'synthetic question'}]}},{message:{role:'assistant',content:[{type:'text',text:'synthetic answer cites [[fixture-unknown-unit]]'}]}}]:[{type:'session_meta',payload:{id:sid,cwd:root}},{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'synthetic question'}]}},{type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'synthetic answer cites [[fixture-unknown-unit]]'}]}}];fs.writeFileSync(transcript,events.map(e=>JSON.stringify(e)).join('\n')+'\n');
  const opts={root,harness,coreDir};const outcomes=[];
  const run=(name,fn)=>{try{outcomes.push({name,value:fn()});}catch(e){outcomes.push({name,error:e.code,reason:e.reason,message:e.message});}};
  run('state-hot',()=>stateDir({...opts,kind:'hot',forWrite:true}));
  run('state-durable',()=>stateDir({...opts,kind:'durable',forWrite:true}));
  run('ensure-state-export',()=>ensureStateDir(opts));
  run('manifest',()=>updateManifest({...opts,fields:{agent_name:'synthetic'}}));
  run('bootstrap',()=>writeBootstrap({...opts,record:{session_started_at:'2026-01-01T00:00:00Z'}}));
  run('last-active',()=>touchProject(coreDir,{root,harness,when:'2026-01-01T00:00:00Z'}));
  run('metrics-writer',()=>{const dir=operationalMetricsDir(root,{home,env});fs.writeFileSync(join(dir,'probe.json'),'synthetic');return dir;});
  run('rollup',()=>writeRollup(buildRollup({project:root,home,env,today:'2026-01-01'})));
  run('capability-append',()=>appendRows({root,harness},[{capability_id:'synthetic',capability_kind:'identity',identity_status:'PASS',evidence:[]}],{session_id:'synthetic'},{home}));
  run('classification',()=>runClassification({project:root,cwd:root,harness,home,env,sessionId:sid,today:'2026-01-01'}));
  run('detector',()=>runDetectors({project:root,cwd:root,harness,home,env,sessionId:sid,today:'2026-01-01'}));
  const scaffold=initMetrics({projectDir:root,home,env});
  if(route==='registered')assert.equal(scaffold.ok,true);else{assert.equal(scaffold.status,'NOT_STORED');assert.equal(scaffold.reason,reason);assert.equal(fs.existsSync(join(root,'_metrics')),false,'unsupported scaffold creates no project capture folder');}
  run('disclosure',()=>checkMetricsDisclosure({projectDir:root,home,env}));
  const scripts=fileURLToPath(new URL('../../plugins/core/skills/core/scripts/',import.meta.url));
  const preload=`import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';os.userInfo=()=>({homedir:${JSON.stringify(home)}});os.homedir=()=>${JSON.stringify(home)};syncBuiltinESMExports();`;
  const cli=(name,args,{input}={})=>spawnSync(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(preload),join(scripts,name),...args],{cwd:root,env:{...process.env,...env,NODE_OPTIONS:'',CORE_HOOKS_LOG_FILE:process.platform==='win32'?'NUL':'/dev/null'},input,encoding:'utf8',timeout:15000});
  for(const verb of ['path','bootstrap','touch']){
   const child=cli('index-registry.mjs',[verb,'--root',root,'--harness',harness,'--core-dir',coreDir,...(verb==='path'?['--kind','durable','--name','drafts/probe.md']:[])]);
   assert.equal(child.error,undefined,child.stderr);
   if(route==='registered')assert.equal(child.status,0,child.stderr);else{assert.equal(child.status,1,child.stderr);assert.equal(child.stdout,'','a refused path door cannot emit a usable path');assert.match(child.stderr,/not stored:/);}
  }
  for(const operation of [['--export-worksheet'],['--import-labels',labels]]){
   const child=cli('calibrate-classifier.mjs',[root,...operation,'--harness',harness,'--json']);assert.equal(child.error,undefined,child.stderr);
   if(route!=='registered'){assert.equal(child.status,1);const result=JSON.parse(child.stdout);assert.equal(result.status,'NOT_STORED');assert.equal(result.reason,reason);}
  }
  const capability=cli('record-capability-snapshot.mjs',['--cwd',root,'--project',root,'--harness',harness,'--session-id',sid]);assert.equal(capability.error,undefined,capability.stderr);assert.equal(capability.status,0,capability.stderr);const recorded=JSON.parse(capability.stdout);if(route==='registered'){assert.equal(recorded.storage,'state');assert.ok(recorded.appended>0);assert.ok(recorded.path.startsWith(join(root,'.core',harness)));}else{assert.equal(recorded.status,'NOT_STORED');assert.equal(recorded.storage,'none');assert.equal(recorded.appended,0);assert.equal(recorded.reason,reason);}
  const hook=cli('../hooks/'+(harness==='codex'?'retrieve-context-hook-codex.mjs':'retrieve-context-hook.mjs'),[],{input:JSON.stringify({prompt:'omega speedmaster sale',cwd:root,session_id:sid})});assert.equal(hook.error,undefined,hook.stderr);assert.equal(hook.status,0,'optional capture hook must remain quiet');
  const captures=join(root,'_metrics','turn-capture');if(route==='registered'){assert.equal(fs.existsSync(captures),true,'positive actually captured evidence');const rows=fs.readdirSync(captures).filter(n=>n.endsWith('.jsonl')).flatMap(n=>fs.readFileSync(join(captures,n),'utf8').trim().split('\n').filter(Boolean));assert.equal(rows.length,1,'one actual hook capture');assert.equal(JSON.parse(rows[0]).prompt_text,'omega speedmaster sale');}
  if(route.startsWith('migrating')){
   assert.equal(fs.existsSync(captures),false,'capture must pause while project migration is fenced');
   fs.rmSync(join(coreDir,'local'),{recursive:true,force:true});
   const fresh=cli('../hooks/'+(harness==='codex'?'retrieve-context-hook-codex.mjs':'retrieve-context-hook.mjs'),[],{input:JSON.stringify({prompt:'omega speedmaster sale',cwd:root,session_id:sid})});assert.equal(fresh.status,0);assert.equal(fs.existsSync(captures),false,'a migration with no old fallback folder is fenced too');
   fs.mkdirSync(history,{recursive:true});fs.writeFileSync(join(history,'2025-01-01.jsonl'),'synthetic retained history\n');fs.mkdirSync(dirname(labels),{recursive:true});fs.writeFileSync(labels,'synthetic retained human label\n');
  }
  run('receipt-transaction',()=>{const l=generationReceiptLocation({home,projectDir:root,env,generatedAt:'2026-01-01T00:00:00Z'});return publishArtifactWithReceipt({outPath:join(root,'synthetic.html'),html:'synthetic artifact',receiptDir:l.receiptDir,receiptPath:l.receiptPath,manifest:{kind:'core-memory-browse-preflight',schema_version:'1',generated_at:'2026-01-01T00:00:00Z'}});});
  assert.deepEqual(snapshot(join(coreDir,'local')),before,`${route}: no fallback file, directory, lock or temp may be created/changed`);
  assert.deepEqual(snapshot(join(coreDir,'artifact-receipts')),beforeReceipts,`${route}: no receipt catch fallback`);
  if(route==='registered'){
   for(const o of outcomes)assert.equal(o.error,undefined,`${o.name}: ${o.message}`);
   for(const o of outcomes.filter(o=>['classification','detector'].includes(o.name))){assert.equal(o.value.status,'OK',o.name);assert.equal(o.value.written,true);assert.ok(o.value.written_records>0,`${o.name}: positive actually persisted a record`);}
   const signed=JSON.parse(fs.readFileSync(join(root,'.core',harness,'workspace.json'),'utf8'));assert.equal(signed.metrics_disclosure_version,HISTORY_NOTICE_VERSION,'classified history triggers the newer notice version');
   assert.equal(fs.existsSync(join(root,'.core',harness,'last-bootstrap.json')),true);assert.equal(fs.existsSync(join(root,'.core',harness,'metrics','orient-signal.txt')),true);assert.equal(fs.existsSync(join(root,'.core',harness,'capability-history.jsonl')),true);assert.equal(fs.existsSync(join(root,'.core',harness,'artifact-receipts','2026-01-01T00-00-00Z.json')),true);
  }else{
   for(const o of outcomes.filter(o=>['state-hot','state-durable','ensure-state-export','manifest','bootstrap','metrics-writer','capability-append','receipt-transaction'].includes(o.name))){assert.equal(o.error,'STATE_NO_PROJECT_PLACE',`${o.name} must return the typed no-place refusal`);assert.equal(o.reason,reason,`${o.name}: actual route`);}
   assert.equal(fs.existsSync(join(root,'synthetic.html')),false,'no artifact transaction without a project receipt');
   assert.equal(trustedMetricsDir(root,{home,env}),dirname(history),'retained local metrics history remains readable');
   for(const o of outcomes.filter(o=>['classification','detector'].includes(o.name))){assert.equal(o.value.status,'NOT_STORED',`${o.name}: no success laundering`);assert.equal(o.value.reason,reason);assert.equal(o.value.written,false);assert.equal(o.value.written_records,0);assert.ok(o.value.records.length>0,'the attempted write is not vacuous');}
  }
  assert.ok(turnCapturePurgeScope(root,{home,env}).some(e=>e.path===history),'purge planning retains the classified local copy');
  assert.match(noticeTextFor(root,{home,env}),new RegExp(history.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),'disclosure names the retained classified local copy');
 }finally{c.cleanup();}
});
