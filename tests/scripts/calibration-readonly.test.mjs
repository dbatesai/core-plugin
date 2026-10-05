import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {join,delimiter} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {symlinkCapable} from './trusted-test-tmp.mjs';
const source=fileURLToPath(new URL('../../',import.meta.url));
const cal=new URL('../../plugins/core/skills/core/scripts/calibrate-classifier.mjs',import.meta.url).href;
const log=new URL('../../plugins/core/skills/core/scripts/log-event.mjs',import.meta.url).href;
const metrics=new URL('../../plugins/core/skills/core/scripts/metrics-check.mjs',import.meta.url).href;
const gate=pathToFileURL(fileURLToPath(new URL('./fs-confine.mjs',import.meta.url))).href;
function fixture(t){
 const base=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calibration-readonly-'))),root=join(base,'project'),home=join(base,'home');
 fs.mkdirSync(root);fs.mkdirSync(home);fs.mkdirSync(join(home,'.core'));fs.writeFileSync(join(home,'.core','projects.json'),JSON.stringify([{path:root}]));
 t.after(()=>fs.rmSync(base,{recursive:true,force:true}));return {base,root,home};
}
function snap(dir){return fs.readdirSync(dir,{recursive:true}).sort().map(p=>{const f=join(dir,p),s=fs.lstatSync(f);return [p,s.isSymbolicLink()?'link:'+fs.readlinkSync(f):s.isFile()?createHash('sha256').update(fs.readFileSync(f)).digest('hex'):'directory'];});}
function run(f,body,{cli=false,harness='codex'}={}){
 const patch=`import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';os.userInfo=()=>({homedir:${JSON.stringify(f.home)}});os.homedir=()=>${JSON.stringify(f.home)};syncBuiltinESMExports();`;
 const args=['--import',gate,'--import','data:text/javascript,'+encodeURIComponent(patch),...(cli?[fileURLToPath(cal),f.root,'--check','--json']:['--input-type=module','-e',body])];
 const r=spawnSync(process.execPath,args,{cwd:f.root,encoding:'utf8',env:{...process.env,NODE_OPTIONS:'',CORE_HARNESS:harness,CORE_METRICS_ENABLED:'0',CORE_HOOKS_LOG_FILE:'/dev/null',FS_CONFINE_ROOTS:[source,f.root,f.home].join(delimiter)}});
 assert.equal(r.status,cli?1:0,r.stderr);const m=r.stderr.match(/FS_CONFINE_VIOLATIONS (.*)/);assert.ok(m,r.stderr);assert.deepEqual(JSON.parse(m[1]),[]);return JSON.parse(r.stdout.trim());
}
for(const kind of ['readiness','metrics-reader','cli'])test(`${kind} leaves an unenrolled registered folder and account byte-identical`,t=>{
 const f=fixture(t),beforeRoot=snap(f.root),beforeHome=snap(f.home);
 const body=kind==='metrics-reader'?`const {checkCalibrationPool}=await import(${JSON.stringify(metrics)});console.log(JSON.stringify(checkCalibrationPool(${JSON.stringify(f.root)},{home:${JSON.stringify(f.home)}})));`:`const {readinessReport}=await import(${JSON.stringify(cal)});console.log(JSON.stringify(readinessReport({project:${JSON.stringify(f.root)},home:${JSON.stringify(f.home)}})));`;
 const r=run(f,body,{cli:kind==='cli'});assert.equal(r.labeled_count,0);assert.equal(r.is_calibrated,false);assert.equal(r.available,false);assert.match(r.reason,/trusted calibration/);assert.deepEqual(snap(f.root),beforeRoot);assert.deepEqual(snap(f.home),beforeHome);
});
for(const harness of ['codex','claude-code'])test(`readiness reads existing ${harness} calibration and pool without changing enrollment`,t=>{
 const f=fixture(t);
 run(f,`const {operationalMetricsDir}=await import(${JSON.stringify(log)});const {writeCalibrationState,emptyCalibrationState}=await import(${JSON.stringify(cal)});const fs=await import('node:fs');const {join}=await import('node:path');const dir=operationalMetricsDir(${JSON.stringify(f.root)},{home:${JSON.stringify(f.home)}});fs.mkdirSync(join(dir,'classified'));fs.writeFileSync(join(dir,'classified','2026-10-05.jsonl'),'{}\\n{}\\n'.replaceAll('\\\\n','\\n'));const written=writeCalibrationState(dir,{...emptyCalibrationState(),is_calibrated:true,provisional:false,labeled_count:120,overall_precision:0.84});console.log(JSON.stringify(written));`,{harness});
 const beforeRoot=snap(f.root),beforeHome=snap(f.home);const r=run(f,`const {readinessReport}=await import(${JSON.stringify(cal)});console.log(JSON.stringify(readinessReport({project:${JSON.stringify(f.root)},home:${JSON.stringify(f.home)}})));`,{harness});
 assert.equal(r.available,true);assert.equal(r.is_calibrated,true);assert.equal(r.labeled_count,120);assert.equal(r.overall_precision,0.84);assert.equal(r.pool_size,2);assert.deepEqual(snap(f.root),beforeRoot);assert.deepEqual(snap(f.home),beforeHome);
});
test('readiness refuses a linked core directory before any foreign traversal',t=>{
 if(!symlinkCapable())return t.skip('symlink fixture privilege unavailable');const f=fixture(t);const foreign=join(f.base,'foreign');fs.mkdirSync(foreign);fs.symlinkSync(foreign,join(f.root,'.core'),'dir');
 const beforeHome=snap(f.home);const r=run(f,`const {readinessReport}=await import(${JSON.stringify(cal)});console.log(JSON.stringify(readinessReport({project:${JSON.stringify(f.root)},home:${JSON.stringify(f.home)}})));`);
 assert.equal(r.labeled_count,0);assert.equal(r.available,false);assert.match(r.reason,/METRICS_DIRECTORY_CUSTODY/);assert.deepEqual(fs.readdirSync(foreign),[]);assert.deepEqual(snap(f.home),beforeHome);
});

function enrolledFixture(t, {local=false}={}) {
 const f=fixture(t);
 if(local){fs.writeFileSync(join(f.home,'.core','projects.json'),'[]');fs.mkdirSync(join(f.root,'.git'));}
 const directory=local
  ? `join(localStateDir({root:${JSON.stringify(f.root)},harness:process.env.CORE_HARNESS,coreDir:${JSON.stringify(join(f.home,'.core'))}}),'metrics')`
  : `operationalMetricsDir(${JSON.stringify(f.root)},{home:${JSON.stringify(f.home)}})`;
 f.meta=run(f,`const {operationalMetricsDir}=await import(${JSON.stringify(log)});const {localStateDir}=await import(${JSON.stringify(new URL('../../plugins/core/skills/core/scripts/project-state.mjs',import.meta.url).href)});const {writeCalibrationState,emptyCalibrationState}=await import(${JSON.stringify(cal)});const fs=await import('node:fs');const {join}=await import('node:path');const dir=${directory};fs.mkdirSync(dir,{recursive:true});writeCalibrationState(dir,{...emptyCalibrationState(),is_calibrated:true,provisional:false,labeled_count:120,overall_precision:0.84});console.log(JSON.stringify(dir));`);
 return f;
}
const readBody=f=>`const {readinessReport}=await import(${JSON.stringify(cal)});console.log(JSON.stringify(readinessReport({project:${JSON.stringify(f.root)},home:${JSON.stringify(f.home)}})));`;
for(const mode of ['malformed-state','denied-state','linked-state','hardlinked-state','linked-classified','linked-daily','hardlinked-daily','malformed-daily','denied-daily'])test(`readiness reports unavailable without foreign traversal or mutation: ${mode}`,t=>{
 if(mode.startsWith('linked-')&&!symlinkCapable())return t.skip('symlink fixture privilege unavailable');
 const f=enrolledFixture(t),state=join(f.meta,'calibration-state.json'),dir=join(f.meta,'classified'),daily=join(dir,'2026-10-05.jsonl');
 const foreign=join(f.base,'foreign');fs.mkdirSync(foreign);const target=join(foreign,'sentinel');fs.writeFileSync(target,mode.endsWith('state')?fs.readFileSync(state):'{}\n');
 if(mode==='malformed-state')fs.writeFileSync(state,'{invalid');
 if(mode==='linked-state'||mode==='hardlinked-state'){fs.rmSync(state);if(mode==='linked-state')fs.symlinkSync(target,state);else fs.linkSync(target,state);}
 if(mode==='linked-classified'){fs.writeFileSync(join(foreign,'2026-10-05.jsonl'),'{}\n');fs.symlinkSync(foreign,dir,'dir');}
 if(mode.endsWith('daily')){fs.mkdirSync(dir);if(mode==='linked-daily')fs.symlinkSync(target,daily);else if(mode==='hardlinked-daily')fs.linkSync(target,daily);else fs.writeFileSync(daily,mode==='malformed-daily'?'{invalid\n':'{}\n');}
 const beforeRoot=snap(f.root),beforeHome=snap(f.home),beforeForeign=snap(foreign);
 const denied=mode==='denied-state'?state:mode==='denied-daily'?daily:null;
 const fault=denied?`const fs=await import('node:fs');const read=fs.default.readFileSync;fs.default.readFileSync=(p,...a)=>{if(String(p)===${JSON.stringify(denied)})throw Object.assign(new Error('synthetic read denied'),{code:'EACCES'});return read(p,...a)};const {syncBuiltinESMExports}=await import('node:module');syncBuiltinESMExports();`:'';
 const r=run(f,fault+readBody(f));assert.equal(r.available,false);assert.match(r.reason,/unavailable/i);assert.equal(r.is_calibrated,false,'unknown required evidence cannot claim current readiness');if(mode.endsWith('daily')||mode==='linked-classified')assert.equal(r.labeled_count,120,'usable stored state remains available in its own fields');assert.deepEqual(snap(f.root),beforeRoot);assert.deepEqual(snap(f.home),beforeHome);assert.deepEqual(snap(foreign),beforeForeign);
});
test('a genuinely absent state and classified directory remains a usable empty pool',t=>{
 const f=enrolledFixture(t);fs.rmSync(join(f.meta,'calibration-state.json'));const before=snap(f.root);const r=run(f,readBody(f));assert.equal(r.available,true);assert.equal(r.labeled_count,0);assert.equal(r.pool_size,0);assert.deepEqual(snap(f.root),before);
});

for(const mode of ['malformed-state','linked-classified'])test(`actual check CLI keeps ${mode} evidence unavailable without mutations`,t=>{
 if(mode==='linked-classified'&&!symlinkCapable())return t.skip('symlink fixture privilege unavailable');const f=enrolledFixture(t);
 if(mode==='malformed-state')fs.writeFileSync(join(f.meta,'calibration-state.json'),'{invalid');else{const foreign=join(f.base,'foreign');fs.mkdirSync(foreign);fs.writeFileSync(join(foreign,'2026-10-05.jsonl'),'{}\n');fs.symlinkSync(foreign,join(f.meta,'classified'),'dir');}
 const beforeRoot=snap(f.root),beforeHome=snap(f.home);const r=run(f,'',{cli:true});assert.equal(r.available,false);assert.equal(r.is_calibrated,false);assert.match(r.reason,/unavailable/i);assert.deepEqual(snap(f.root),beforeRoot);assert.deepEqual(snap(f.home),beforeHome);
});

test('a stale persisted instrument cannot become a current measured zero',t=>{
 const f=enrolledFixture(t),path=join(f.meta,'calibration-state.json');const state=JSON.parse(fs.readFileSync(path));state.classifier_version='synthetic-old-version';fs.writeFileSync(path,JSON.stringify(state));const before=snap(f.root);const r=run(f,readBody(f));assert.equal(r.available,false);assert.match(r.reason,/CALIBRATION_STALE/);assert.equal(r.is_calibrated,false);assert.deepEqual(snap(f.root),before);
});
test('an existing empty classified file is a genuine available zero pool',t=>{
 const f=enrolledFixture(t),dir=join(f.meta,'classified');fs.mkdirSync(dir);fs.writeFileSync(join(dir,'2026-10-05.jsonl'),'');fs.rmSync(join(f.meta,'calibration-state.json'));const before=snap(f.root);const r=run(f,readBody(f));assert.equal(r.available,true);assert.equal(r.labeled_count,0);assert.equal(r.pool_size,0);assert.deepEqual(snap(f.root),before);
});

for(const [field,value] of [['labeled_count','unknown'],['is_calibrated','yes'],['overall_precision','0.84']])test(`valid JSON with invalid ${field} cannot claim usable calibration`,t=>{
 const f=enrolledFixture(t),path=join(f.meta,'calibration-state.json'),state=JSON.parse(fs.readFileSync(path));state[field]=value;fs.writeFileSync(path,JSON.stringify(state));const before=snap(f.root);const r=run(f,readBody(f));assert.equal(r.available,false);assert.equal(r.is_calibrated,false);assert.match(r.reason,/unavailable/i);assert.deepEqual(snap(f.root),before);
});
test('an existing valid zero-label state remains a usable measured zero',t=>{
 const f=enrolledFixture(t),path=join(f.meta,'calibration-state.json'),state=JSON.parse(fs.readFileSync(path));Object.assign(state,{is_calibrated:false,provisional:true,labeled_count:0,overall_precision:null});fs.writeFileSync(path,JSON.stringify(state));const before=snap(f.root);const r=run(f,readBody(f));assert.equal(r.available,true);assert.equal(r.labeled_count,0);assert.equal(r.is_calibrated,false);assert.deepEqual(snap(f.root),before);
});

for(const [mode,local] of [['project-metrics-link',false],['local-metrics-link',true],['local-root-link',true],['local-key-link',true],['local-harness-link',true]])test(`selected calibration parent custody is enforced before child probes: ${mode}`,t=>{
 if(!symlinkCapable())return t.skip('symlink fixture privilege unavailable');const f=enrolledFixture(t,{local});
 const foreign=join(f.base,'foreign');fs.mkdirSync(foreign);let linked=f.meta;
 if(mode==='local-harness-link')linked=f.meta.slice(0,-'/metrics'.length);
 if(mode==='local-key-link')linked=f.meta.split('/').slice(0,-2).join('/');
 if(mode==='local-root-link')linked=join(f.home,'.core','local');
 fs.renameSync(linked,join(foreign,'retained'));fs.symlinkSync(join(foreign,'retained'),linked,'dir');
 const beforeForeign=snap(foreign),beforeRoot=snap(f.root),beforeHome=snap(f.home);const r=run(f,readBody(f));
 assert.equal(r.available,false);assert.equal(r.is_calibrated,false);assert.match(r.reason,/unavailable|trusted calibration/i);
 assert.deepEqual(snap(foreign),beforeForeign);assert.deepEqual(snap(f.root),beforeRoot);assert.deepEqual(snap(f.home),beforeHome);
});
test('existing selected local calibration remains readable without enrollment or mutation',t=>{
 const f=enrolledFixture(t,{local:true}),beforeRoot=snap(f.root),beforeHome=snap(f.home);const r=run(f,readBody(f));
 assert.equal(r.available,true);assert.equal(r.is_calibrated,true);assert.equal(r.labeled_count,120);assert.equal(r.overall_precision,0.84);
 assert.deepEqual(snap(f.root),beforeRoot);assert.deepEqual(snap(f.home),beforeHome);
});

for(const local of [false,true])for(const mode of ['dangling','non-directory','unreadable'])test(`selected ${local?'local':'project'} metrics parent is unavailable: ${mode}`,t=>{
 if(mode==='dangling'&&!symlinkCapable())return t.skip('symlink fixture privilege unavailable');const f=enrolledFixture(t,{local});
 let fault='';if(mode==='unreadable')fault=`const fs=await import('node:fs');const lstat=fs.default.lstatSync;fs.default.lstatSync=(p,...a)=>{if(String(p)===${JSON.stringify(f.meta)})throw Object.assign(new Error('synthetic parent read denied'),{code:'EACCES'});return lstat(p,...a)};const {syncBuiltinESMExports}=await import('node:module');syncBuiltinESMExports();`;
 else{fs.rmSync(f.meta,{recursive:true});if(mode==='dangling')fs.symlinkSync(join(f.base,'absent-foreign'),f.meta,'dir');else fs.writeFileSync(f.meta,'not a directory');}
 const beforeRoot=snap(f.root),beforeHome=snap(f.home);const r=run(f,fault+readBody(f));assert.equal(r.available,false);assert.equal(r.is_calibrated,false);assert.match(r.reason,/METRICS_DIRECTORY_CUSTODY|EACCES/);assert.deepEqual(snap(f.root),beforeRoot);assert.deepEqual(snap(f.home),beforeHome);
});
for(const local of [false,true])test(`genuinely absent ${local?'local':'project'} metrics remains an available empty instrument`,t=>{
 const f=enrolledFixture(t,{local});fs.rmSync(f.meta,{recursive:true});const beforeRoot=snap(f.root),beforeHome=snap(f.home);const r=run(f,readBody(f));assert.equal(r.available,true);assert.equal(r.labeled_count,0);assert.equal(r.pool_size,0);assert.deepEqual(snap(f.root),beforeRoot);assert.deepEqual(snap(f.home),beforeHome);
});
test('a linked unselected local route does not suppress healthy project evidence',t=>{
 if(!symlinkCapable())return t.skip('symlink fixture privilege unavailable');const f=enrolledFixture(t),foreign=join(f.base,'unselected');fs.mkdirSync(foreign);fs.symlinkSync(foreign,join(f.home,'.core','local'),'dir');const beforeHome=snap(f.home);const r=run(f,readBody(f));assert.equal(r.available,true);assert.equal(r.labeled_count,120);assert.deepEqual(snap(f.home),beforeHome);assert.deepEqual(fs.readdirSync(foreign),[]);
});

for(const linked of [false,true])test(`foreign-install selection preserves local reader custody: ${linked?'linked parent refused':'healthy evidence readable'}`,t=>{
 if(linked&&!symlinkCapable())return t.skip('symlink fixture privilege unavailable');const f=enrolledFixture(t);
 const stampPath=join(f.root,'.core','codex','stamp'),stamp=JSON.parse(fs.readFileSync(stampPath));stamp.install_id='synthetic-foreign-install';fs.writeFileSync(stampPath,JSON.stringify(stamp));
 f.meta=run(f,`const {operationalMetricsDir}=await import(${JSON.stringify(log)});const {writeCalibrationState,emptyCalibrationState}=await import(${JSON.stringify(cal)});const {localStateDir}=await import(${JSON.stringify(new URL('../../plugins/core/skills/core/scripts/project-state.mjs',import.meta.url).href)});const fs=await import('node:fs');const {join}=await import('node:path');const dir=join(localStateDir({root:${JSON.stringify(f.root)},harness:'codex',coreDir:${JSON.stringify(join(f.home,'.core'))}}),'metrics');fs.mkdirSync(dir,{recursive:true});writeCalibrationState(dir,{...emptyCalibrationState(),is_calibrated:true,provisional:false,labeled_count:120,overall_precision:0.84});console.log(JSON.stringify(dir));`);
 let foreign=null;if(linked){foreign=join(f.base,'foreign-local');fs.mkdirSync(foreign);const localRoot=join(f.home,'.core','local');fs.renameSync(localRoot,join(foreign,'retained'));fs.symlinkSync(join(foreign,'retained'),localRoot,'dir');}
 const beforeRoot=snap(f.root),beforeHome=snap(f.home),beforeForeign=foreign?snap(foreign):null;const r=run(f,readBody(f));assert.equal(r.available,!linked);assert.equal(r.is_calibrated,!linked);if(!linked)assert.equal(r.labeled_count,120);else assert.match(r.reason,/METRICS_DIRECTORY_CUSTODY/);
 assert.deepEqual(snap(f.root),beforeRoot);assert.deepEqual(snap(f.home),beforeHome);if(foreign)assert.deepEqual(snap(foreign),beforeForeign);
});

for(const local of [false,true])test(`actual check CLI refuses linked ${local?'local':'project'} metrics parent without mutation`,t=>{
 if(!symlinkCapable())return t.skip('symlink fixture privilege unavailable');const f=enrolledFixture(t,{local}),foreign=join(f.base,'foreign-cli');fs.renameSync(f.meta,foreign);fs.symlinkSync(foreign,f.meta,'dir');const beforeRoot=snap(f.root),beforeHome=snap(f.home),beforeForeign=snap(foreign);const r=run(f,'',{cli:true});assert.equal(r.available,false);assert.equal(r.is_calibrated,false);assert.match(r.reason,/METRICS_DIRECTORY_CUSTODY/);assert.deepEqual(snap(f.root),beforeRoot);assert.deepEqual(snap(f.home),beforeHome);assert.deepEqual(snap(foreign),beforeForeign);
});
