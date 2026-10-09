import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, delimiter, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { symlinkCapable, tarWritesZip } from './trusted-test-tmp.mjs';
// These need a real zip from the local tar; without one the folder fallback is checked by its own test below.
const NOZIP = 'local tar writes no zip (GNU tar); the folder fallback test covers this machine';
const norm = p => String(p).split(sep).join('/');
const source = fileURLToPath(new URL('../../', import.meta.url));
const scripts = new URL('../../plugins/core/skills/core/scripts/', import.meta.url);
const check = new URL('metrics-check.mjs', scripts).href, pack = new URL('metrics-package.mjs', scripts).href;
const gate = fileURLToPath(new URL('./fs-confine.mjs', import.meta.url));
function fixture() {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'metrics-project-scratch-')));
  const root=join(base,'project'), other=join(base,'other'), home=join(base,'home'), out=join(base,'exports');
  for(const p of [root,other,home,out])fs.mkdirSync(p);
  for(const p of [root,other]){
    assert.equal(spawnSync('git',['init','-q',p]).status,0);
    fs.mkdirSync(join(p,'_memories'));fs.writeFileSync(join(p,'PROJECT.md'),'# Fixture\n');
    fs.writeFileSync(join(p,'_memories','obs-fixture.md'),'---\nid: obs-fixture\ntype: observation\nstatus: active\ncreated: 2026-01-01\ntopics: [fixture]\n---\n\nSynthetic fixture fact.\n');
  }
  fs.mkdirSync(join(home,'.core'));fs.writeFileSync(join(home,'.core','projects.json'),JSON.stringify([{path:root},{path:other}]));
  return {base,root,other,home,out,cleanup:()=>fs.rmSync(base,{recursive:true,force:true})};
}
function run(f, code, fault='') {
  const audit=join(f.base,'audit-'+Math.random().toString(36).slice(2)+'.jsonl');
  const patch=`import os from 'node:os';import fs from 'node:fs';import cp from 'node:child_process';import {sep} from 'node:path';const norm=p=>String(p).split(sep).join('/');import {syncBuiltinESMExports} from 'node:module';
    os.userInfo=()=>({homedir:${JSON.stringify(f.home)}});os.homedir=()=>${JSON.stringify(f.home)};${fault};syncBuiltinESMExports();`;
  const opts='--import='+pathToFileURL(gate).href+' --import=data:text/javascript,'+encodeURIComponent(patch);
  const r=spawnSync(process.execPath,['--input-type=module','-e',`try {const result=await (async()=>{${code}})();console.log(JSON.stringify({result}));}catch(e){console.log(JSON.stringify({thrown:{code:e.code,message:e.message}}));}`],{
    cwd:f.root,encoding:'utf8',timeout:120000,env:{...process.env,NODE_OPTIONS:opts,
      CORE_METRICS_ENABLED:'0',CORE_HOOKS_LOG_FILE:'/dev/null',CORE_CLOSE_INDEX:'',
      FS_CONFINE_ROOTS:[source,f.root,f.other,f.home,f.out].join(delimiter),FS_CONFINE_LOG:audit}
  });
  assert.equal(r.status,0,r.stderr);const data=JSON.parse(r.stdout.trim());
  // On CI, record what the packager returned: the hosted runners' tar differs from a developer's, and an assertion alone hides why.
  if(process.env.CI)console.log('# packager result: '+JSON.stringify(data).slice(0,1500));
  const calls=fs.readFileSync(audit,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  return {...data,calls,violations:calls.filter(x=>x.verdict.startsWith('refused-'))};
}
function cleanScratch(root){const dir=join(root,'_core','_scratch');assert.deepEqual(fs.readdirSync(dir),['.gitignore']);}
function localAllocations(r,root){const calls=r.calls.filter(x=>x.call==='mkdtempSync');assert.ok(calls.length>0);assert.ok(calls.every(x=>norm(x.path).startsWith(norm(join(root,'_core','_scratch'))+'/')));}
const gather=(f)=>`const {gatherMetrics}=await import(${JSON.stringify(check)});return await gatherMetrics(${JSON.stringify(f.root)},{home:${JSON.stringify(f.home)}});`;
const packageCode=(f,args=[f.root,'--home',f.home,'--out',f.out])=>`const {runPackage}=await import(${JSON.stringify(pack)});return runPackage(${JSON.stringify(args)});`;

test('live probe allocates unique local scratch and cleans both runs in the same process',()=>{
  const f=fixture();try{
    const r=run(f,`const {gatherMetrics}=await import(${JSON.stringify(check)});const a=await gatherMetrics(${JSON.stringify(f.root)},{home:${JSON.stringify(f.home)}});const b=await gatherMetrics(${JSON.stringify(f.root)},{home:${JSON.stringify(f.home)}});return [a.mechanics.probe.round_trip,b.mechanics.probe.round_trip];`);
    assert.deepEqual(r.result,[true,true]);assert.deepEqual(r.violations,[]);localAllocations(r,f.root);
    const names=r.calls.filter(x=>x.call==='mkdtempSync');assert.equal(names.length,2);
    const written=r.calls.filter(x=>x.call==='writeFileSync'&&norm(x.path).endsWith('/probe-live-fact.md')).map(x=>x.path);assert.equal(new Set(written).size,2,'both invocations used distinct actual directories');cleanScratch(f.root);
  }finally{f.cleanup();}
});
test('live probe failure remains degraded and cleans only its own local scratch',()=>{
  const f=fixture();try{
    const fault=`const write=fs.writeFileSync;fs.writeFileSync=(p,...args)=>{if(norm(p).endsWith('/probe-live-fact.md'))throw Object.assign(new Error('probe fault'),{code:'EIO'});return write(p,...args);}`;
    const r=run(f,gather(f),fault);assert.equal(r.result.mechanics.probe.round_trip,false);assert.match(r.result.caveats.join(' '),/probe crashed/);
    assert.deepEqual(r.violations,[]);localAllocations(r,f.root);cleanScratch(f.root);
  }finally{f.cleanup();}
});
test('a linked scratch folder is refused without probing its foreign target',t=>{
  if(!symlinkCapable())return t.skip('symlink fixture privilege unavailable');
  const f=fixture();try{
    const outside=join(f.base,'outside');fs.mkdirSync(outside);fs.mkdirSync(join(f.root,'_core'));fs.symlinkSync(outside,join(f.root,'_core','_scratch'),'dir');
    const r=run(f,gather(f));assert.equal(r.result.mechanics.probe.round_trip,false);assert.deepEqual(r.violations,[]);assert.deepEqual(fs.readdirSync(outside),[]);
  }finally{f.cleanup();}
});
test('package staging and actual archive round trip both allocate locally and clean up',t=>{if(!tarWritesZip())return t.skip(NOZIP);
  const f=fixture();try{
    const r=run(f,packageCode(f));assert.equal(r.thrown,undefined);assert.ok(r.result.shipped);assert.notEqual(r.result.shipped.kind,'staging');
    assert.deepEqual(r.violations,[]);localAllocations(r,f.root);cleanScratch(f.root);assert.ok(fs.existsSync(r.result.shipped.path));
    assert.ok(r.calls.some(x=>x.call==='mkdtempSync'&&x.path.includes('verify-')),'real extraction verification ran');
  }finally{f.cleanup();}
});
test('without zip support in the local tar, the package ships as a verified folder and says why',t=>{
  if(tarWritesZip())return t.skip('local tar writes a real zip; the archive tests cover this machine');
  const f=fixture();try{
    const r=run(f,packageCode(f));assert.equal(r.thrown,undefined);
    assert.equal(r.result.shipped?.kind,'folder',JSON.stringify(r.result).slice(0,600));assert.match(r.result.shipped.reason,/not a real zip/);
    assert.ok(fs.existsSync(join(r.result.shipped.path,'manifest.json')));assert.ok(!fs.existsSync(r.result.shipped.path+'.zip'),'the refused archive does not ship');
    assert.deepEqual(r.violations,[]);cleanScratch(f.root);
  }finally{f.cleanup();}
});
test('leakage abort leaves no staged scratch or shipped package',()=>{
  const f=fixture();try{
    fs.writeFileSync(join(f.home,'.core','index.json'),JSON.stringify([{id:'direct',path:f.other}]));
    const r=run(f,packageCode(f));assert.equal(r.result.exit,2);assert.match(r.result.error,/LEAKAGE/);assert.deepEqual(r.violations,[]);localAllocations(r,f.root);cleanScratch(f.root);assert.deepEqual(fs.readdirSync(f.out),[]);
  }finally{f.cleanup();}
});
test('unexpected staging write failure is structured and cleans its local scratch',()=>{
  const f=fixture();try{
    const fault=`const write=fs.writeFileSync;fs.writeFileSync=(p,...args)=>{if(norm(p).endsWith('/manifest.json')&&norm(p).includes('/_scratch/'))throw Object.assign(new Error('staging fault'),{code:'EIO'});return write(p,...args);}`;
    const r=run(f,packageCode(f),fault);assert.equal(r.thrown,undefined);assert.equal(r.result.exit,2);assert.equal(r.result.error_code,'EIO');assert.deepEqual(r.violations,[]);cleanScratch(f.root);assert.deepEqual(fs.readdirSync(f.out),[]);
  }finally{f.cleanup();}
});
test('--all requires an explicit scratch project before any salt or artifact write',()=>{
  const f=fixture();try{
    const r=run(f,packageCode(f,['--all','--home',f.home,'--out',f.out]));assert.equal(r.thrown,undefined);assert.equal(r.result.exit,2);assert.match(r.result.error,/scratch-project/);
    assert.equal(fs.existsSync(join(f.home,'.core','metrics-package-salt')),false);assert.equal(fs.existsSync(join(f.root,'_core')),false);assert.equal(fs.existsSync(join(f.other,'_core')),false);assert.deepEqual(r.violations,[]);
  }finally{f.cleanup();}
});
test('--all uses the explicitly selected registered project, irrespective of registry order',()=>{
  const f=fixture();try{
    const r=run(f,packageCode(f,['--all','--scratch-project',f.other,'--home',f.home,'--out',f.out]));assert.equal(r.thrown,undefined);assert.ok(r.result.shipped);assert.deepEqual(r.violations,[]);localAllocations(r,f.other);cleanScratch(f.other);assert.deepEqual(fs.readdirSync(join(f.root,'_core')),['_package'],'the other project keeps only its own package key and history, no scratch');
  }finally{f.cleanup();}
});
test('a scratch override outside the exported project set is refused before salt creation',()=>{
  const f=fixture();try{
    const r=run(f,packageCode(f,[f.root,'--scratch-project',f.other,'--home',f.home,'--out',f.out]));assert.equal(r.thrown,undefined);assert.equal(r.result.exit,2);assert.equal(fs.existsSync(join(f.home,'.core','metrics-package-salt')),false);assert.deepEqual(r.violations,[]);
  }finally{f.cleanup();}
});
test('archive verification failure and cleanup are local and preserve the staged source',()=>{
  const f=fixture();try{
    const stage=join(f.root,'staged');fs.mkdirSync(stage);fs.writeFileSync(join(stage,'receipt'),'preserved');const zip=join(f.out,'bad.zip');fs.writeFileSync(zip,'not an archive');
    const code=`const {verifyArchiveRoundTrip}=await import(${JSON.stringify(pack)});return verifyArchiveRoundTrip(${JSON.stringify(zip)},${JSON.stringify(stage)},{projectRoot:${JSON.stringify(f.root)}});`;
    const r=run(f,code);assert.equal(r.thrown,undefined);assert.equal(r.result.ok,false);assert.deepEqual(r.violations,[]);localAllocations(r,f.root);cleanScratch(f.root);assert.equal(fs.readFileSync(join(stage,'receipt'),'utf8'),'preserved');
  }finally{f.cleanup();}
});

test('the scratch directory helper alone creates no harness or install identity',()=>{
  const f=fixture();try{
    const helper=new URL('project-artifacts.mjs',scripts).href;
    const r=run(f,`const {ensureProjectArtifactDir}=await import(${JSON.stringify(helper)});return ensureProjectArtifactDir(${JSON.stringify(f.root)},'_scratch');`);
    assert.equal(r.thrown,undefined);assert.deepEqual(r.violations,[]);cleanScratch(f.root);
    assert.deepEqual(fs.readdirSync(join(f.root,'_core')),['_scratch']);assert.equal(fs.existsSync(join(f.home,'.core','install-id')),false);
  }finally{f.cleanup();}
});

const cleanupFault=`const remove=fs.rmSync;fs.rmSync=(p,...args)=>{if(norm(p).includes('/_scratch/'))throw Object.assign(new Error('cleanup denied'),{code:'EPERM'});return remove(p,...args);}`;
test('probe cleanup denial is visible, degrades its result, and retains only local scratch',()=>{
  const f=fixture();try{
    const r=run(f,gather(f),cleanupFault);assert.equal(r.thrown,undefined);assert.equal(r.result.mechanics.probe.round_trip,false);assert.match(r.result.caveats.join(' '),/cleanup failed.*EPERM/);assert.deepEqual(r.violations,[]);
    assert.ok(fs.readdirSync(join(f.root,'_core','_scratch')).some(n=>n.startsWith('probe-')));
  }finally{f.cleanup();}
});
test('verification cleanup denial preserves extraction failure and reports retained local scratch',()=>{
  const f=fixture();try{
    const stage=join(f.root,'staged');fs.mkdirSync(stage);const zip=join(f.out,'bad.zip');fs.writeFileSync(zip,'not an archive');
    const code=`const {verifyArchiveRoundTrip}=await import(${JSON.stringify(pack)});return verifyArchiveRoundTrip(${JSON.stringify(zip)},${JSON.stringify(stage)},{projectRoot:${JSON.stringify(f.root)}});`;
    const r=run(f,code,cleanupFault);assert.equal(r.thrown,undefined);assert.equal(r.result.ok,false);assert.match(r.result.reason,/archive did not extract/);assert.equal(r.result.scratch_cleanup.error_code,'EPERM');assert.ok(norm(r.result.scratch_cleanup.path).startsWith(norm(join(f.root,'_core','_scratch'))+'/'));assert.ok(fs.existsSync(r.result.scratch_cleanup.path));assert.deepEqual(r.violations,[]);
  }finally{f.cleanup();}
});
test('package cleanup denial keeps a primary leakage result and names retained scratch',()=>{
  const f=fixture();try{
    fs.writeFileSync(join(f.home,'.core','index.json'),JSON.stringify([{id:'direct',path:f.other}]));
    const r=run(f,packageCode(f),cleanupFault);assert.equal(r.thrown,undefined);assert.equal(r.result.exit,2);assert.match(r.result.error,/LEAKAGE/);assert.equal(r.result.scratch_cleanup.error_code,'EPERM');assert.ok(fs.existsSync(r.result.scratch_cleanup.path));assert.deepEqual(fs.readdirSync(f.out),[]);assert.deepEqual(r.violations,[]);
  }finally{f.cleanup();}
});
test('cleanup denial after a verified ship reports both the existing output and retained scratch',()=>{
  const f=fixture();try{
    // Permit verification scratch cleanup; deny only package staging cleanup after shipping.
    const fault=`const remove=fs.rmSync;fs.rmSync=(p,...args)=>{if(norm(p).includes('/_scratch/package-'))throw Object.assign(new Error('cleanup denied'),{code:'EPERM'});return remove(p,...args);}`;
    const r=run(f,packageCode(f),fault);assert.equal(r.thrown,undefined);assert.equal(r.result.exit,2);assert.equal(r.result.scratch_cleanup.error_code,'EPERM');assert.ok(fs.existsSync(r.result.shipped.path));assert.ok(fs.existsSync(r.result.scratch_cleanup.path));assert.deepEqual(r.violations,[]);
  }finally{f.cleanup();}
});

test('verification cleanup failure remains nonzero through the package consumer and keeps verified output',t=>{if(!tarWritesZip())return t.skip(NOZIP);
  const f=fixture();try{
    const fault=`const remove=fs.rmSync;fs.rmSync=(p,...args)=>{if(norm(p).includes('/_scratch/verify-'))throw Object.assign(new Error('verification cleanup denied'),{code:'EPERM'});return remove(p,...args);}`;
    const r=run(f,packageCode(f),fault);assert.equal(r.thrown,undefined);assert.equal(r.result.exit,2);assert.equal(r.result.scratch_cleanup.error_code,'EPERM');assert.ok(norm(r.result.scratch_cleanup.path).includes('/verify-'));assert.ok(fs.existsSync(r.result.shipped.path));assert.ok(fs.existsSync(r.result.scratch_cleanup.path));assert.equal(r.result.shipped.kind,'zip');assert.deepEqual(r.violations,[]);
  }finally{f.cleanup();}
});
test('both retained verification and staging scratch are reported without losing either failure',t=>{if(!tarWritesZip())return t.skip(NOZIP);
  const f=fixture();try{
    const r=run(f,packageCode(f),cleanupFault);assert.equal(r.thrown,undefined);assert.equal(r.result.exit,2);assert.equal(r.result.scratch_cleanup_failures.length,2);assert.ok(r.result.scratch_cleanup_failures.some(x=>norm(x.path).includes('/verify-')));assert.ok(r.result.scratch_cleanup_failures.some(x=>norm(x.path).includes('/package-')));assert.ok(fs.existsSync(r.result.shipped.path));assert.deepEqual(r.violations,[]);
  }finally{f.cleanup();}
});

test('an unrelated linked registry entry cannot veto the explicitly selected physical scratch project',t=>{
  if(!symlinkCapable())return t.skip('symlink fixture privilege unavailable');
  const f=fixture();try{
    const alias=join(f.root,'alias-project');fs.symlinkSync(f.other,alias,'dir');fs.writeFileSync(join(f.home,'.core','projects.json'),JSON.stringify([{path:alias},{path:f.root}]));
    const r=run(f,packageCode(f,['--all','--scratch-project',f.root,'--home',f.home,'--out',f.out]));assert.equal(r.thrown,undefined);assert.equal(r.result.error,undefined);assert.ok(r.result.shipped);assert.deepEqual(r.violations,[]);localAllocations(r,f.root);cleanScratch(f.root);
  }finally{f.cleanup();}
});

const extractionFailure=`const spawn=cp.spawnSync;cp.spawnSync=(command,args,...rest)=>args?.includes('-x')?{status:2,stdout:'',stderr:'synthetic extraction failure'}:spawn(command,args,...rest);`;
test('verified fallback folder survives source-cleanup denial with its material receipt',t=>{if(!tarWritesZip())return t.skip(NOZIP);
 const f=fixture();try{
  const fault=extractionFailure+`const remove=fs.rmSync;fs.rmSync=(p,...args)=>{if(norm(p).includes('/_scratch/package-'))throw Object.assign(new Error('staging cleanup denied'),{code:'EPERM'});return remove(p,...args);}`;
  const r=run(f,packageCode(f),fault);assert.equal(r.thrown,undefined);assert.equal(r.result.exit,2);assert.equal(r.result.shipped?.kind,'folder');assert.ok(fs.existsSync(join(r.result.shipped.path,'manifest.json')));assert.match(r.result.archive_verification.reason,/did not extract/);assert.ok(fs.existsSync(r.result.scratch_cleanup.path));assert.deepEqual(r.violations,[]);
 }finally{f.cleanup();}
});
test('rejected-archive deletion denial preserves staging, archive and verification cleanup evidence',t=>{if(!tarWritesZip())return t.skip(NOZIP);
 const f=fixture();try{
  const fault=extractionFailure+`const remove=fs.rmSync;fs.rmSync=(p,...args)=>{if(norm(p).includes('/_scratch/verify-')||norm(p).endsWith('.zip'))throw Object.assign(new Error('cleanup denied'),{code:'EPERM'});return remove(p,...args);}`;
  const r=run(f,packageCode(f),fault);assert.equal(r.thrown,undefined);assert.equal(r.result.exit,2);assert.equal(r.result.shipped,undefined);assert.match(r.result.archive_verification.reason,/did not extract/);assert.ok(fs.existsSync(r.result.scratch_cleanup.path));assert.ok(fs.existsSync(r.result.staging_retained));assert.ok(fs.existsSync(r.result.retained_archive.path));assert.equal(r.result.retained_archive.verified,false);assert.deepEqual(fs.existsSync(join(f.home,'.core','metrics-package-history'))?fs.readdirSync(join(f.home,'.core','metrics-package-history')):[],[]);assert.deepEqual(r.violations,[]);
 }finally{f.cleanup();}
});
test('unverified fallback copy keeps recoverable staging and does not advance delivery history',t=>{if(!tarWritesZip())return t.skip(NOZIP);
 const f=fixture();try{
  const fault=extractionFailure+`fs.cpSync=()=>{throw Object.assign(new Error('destination copy denied'),{code:'EIO'});};`;
  const r=run(f,packageCode(f),fault);assert.equal(r.thrown,undefined);assert.equal(r.result.exit,2);assert.equal(r.result.shipped,undefined);assert.ok(fs.existsSync(r.result.staging_retained));assert.match(r.result.archive_verification.reason,/did not extract/);assert.match(r.result.error,/copy failed/);assert.deepEqual(fs.existsSync(join(f.home,'.core','metrics-package-history'))?fs.readdirSync(join(f.home,'.core','metrics-package-history')):[],[]);assert.deepEqual(r.violations,[]);
 }finally{f.cleanup();}
});
test('later hardening failure preserves the already verified fallback output and verification evidence',t=>{if(!tarWritesZip())return t.skip(NOZIP);
 const f=fixture();try{
  const fault=extractionFailure+`let topReads=0;const read=fs.readdirSync;fs.readdirSync=(p,...args)=>{if(norm(p).startsWith(${JSON.stringify(norm(f.out)+'/core-metrics-package-')})&&!norm(p).slice(${norm(f.out).length+1}).includes('/')&&++topReads>1)throw Object.assign(new Error('hardening read denied'),{code:'EACCES'});return read(p,...args);};`;
  const r=run(f,packageCode(f),fault);assert.equal(r.thrown,undefined);assert.equal(r.result.exit,2);assert.equal(r.result.shipped?.kind,'folder');assert.ok(fs.existsSync(join(r.result.shipped.path,'manifest.json')));assert.match(r.result.archive_verification.reason,/did not extract/);assert.equal(r.result.error_code,'EACCES');assert.deepEqual(r.violations,[]);
 }finally{f.cleanup();}
});

test('cleanup-error CLI preserves coverage and project warnings beside verified output',t=>{if(!tarWritesZip())return t.skip(NOZIP);
 const f=fixture();try{
  fs.writeFileSync(join(f.root,'PROJECT.md'),'# Synthetic fixture\n'+'x'.repeat(80000));
  const fault=`const remove=fs.rmSync;fs.rmSync=(p,...args)=>{if(norm(p).includes('/_scratch/package-'))throw Object.assign(new Error('cleanup denied'),{code:'EPERM'});return remove(p,...args);}`;
  const args=[fileURLToPath(new URL('metrics-package.mjs',scripts)),f.root,'--home',f.home,'--out',f.out,'--json'];
  const r=run(f,`const {spawnSync}=await import("node:child_process");const child=spawnSync(process.execPath,${JSON.stringify(args)},{encoding:'utf8',env:process.env});return {status:child.status,stdout:child.stdout,stderr:child.stderr,result:JSON.parse(child.stdout.slice(child.stdout.indexOf('{')))};`,fault);
  assert.equal(r.thrown,undefined,JSON.stringify(r.thrown));assert.equal(r.result.status,2);assert.match(r.result.stdout,/coverage: 1\/1 project/);assert.match(r.result.stdout,/flag\[.*PROJECT\.md/);assert.match(r.result.stderr,/scratch retained:/);assert.equal(r.result.result.shipped.kind,'zip');assert.ok(fs.existsSync(r.result.result.shipped.path));assert.deepEqual(r.violations,[]);
 }finally{f.cleanup();}
});

test('actual --all CLI preserves explicit scratch, home and export paths containing spaces',()=>{
 const f=fixture();try{
  for(const [key,name] of [['root','project with spaces'],['home','home with spaces'],['out','exports with spaces']]){const path=join(f.base,name);fs.renameSync(f[key],path);f[key]=path;}
  fs.writeFileSync(join(f.home,'.core','projects.json'),JSON.stringify([{path:f.root},{path:f.other}]));
  const args=[fileURLToPath(new URL('metrics-package.mjs',scripts)),'--all','--scratch-project',f.root,'--home',f.home,'--out',f.out,'--json'];
  const r=run(f,`const {spawnSync}=await import('node:child_process');const child=spawnSync(process.execPath,${JSON.stringify(args)},{encoding:'utf8',env:process.env});return {status:child.status,stdout:child.stdout,stderr:child.stderr,result:JSON.parse(child.stdout.slice(child.stdout.indexOf('{')))};`);
  assert.equal(r.thrown,undefined,JSON.stringify(r.thrown));assert.ok([0,1].includes(r.result.status),r.result.stderr);assert.equal(r.result.result.coverage.length,2);assert.ok(r.result.stdout.includes('coverage: 2/2 project'));assert.ok(fs.existsSync(r.result.result.shipped.path));assert.ok(norm(r.result.result.shipped.path).startsWith(norm(f.out)+'/'));localAllocations(r,f.root);cleanScratch(f.root);assert.deepEqual(r.violations,[]);
 }finally{f.cleanup();}
});
