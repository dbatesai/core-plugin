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
 assert.equal(r.labeled_count,0);assert.equal(r.available,false);assert.match(r.reason,/trusted calibration/);assert.deepEqual(fs.readdirSync(foreign),[]);assert.deepEqual(snap(f.home),beforeHome);
});
