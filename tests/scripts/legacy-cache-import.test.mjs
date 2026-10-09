import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const url = (name) => pathToFileURL(join(REPO, 'plugins/core/skills/core/scripts', name)).href;
const isWin = process.platform === 'win32';
const canLink = (() => { const d = fs.mkdtempSync(join(tmpdir(), 'legacy-link-probe-')); try { fs.symlinkSync(d, join(d, 'p')); return true; } catch { return false; } finally { fs.rmSync(d, { recursive: true, force: true }); } })();
const original = '---\nid: decision\ntype: decision\nstatus: active\n---\n\n# Decision\n\nOriginal owner decision.\n';
function fixture() {
  const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'legacy-cache-import-')));
  const root = join(base, 'project'), home = join(base, 'home');
  fs.mkdirSync(join(root, '_memories'), { recursive: true });
  fs.mkdirSync(join(home, '.core'), { recursive: true });
  const unit = join(root, '_memories', 'decision.md');
  fs.writeFileSync(unit, original);
  const source = join(home, '.core', 'state-cache.json');
  const cache = join(root, '_memories', '_lib', 'state-cache.json');
  const run = (body, extraPreload = '') => {
    const preload = `import fs from 'node:fs';import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';
      os.userInfo=()=>({homedir:${JSON.stringify(home)}});os.homedir=()=>${JSON.stringify(home)};${extraPreload};syncBuiltinESMExports();`;
    const code = `import fs from 'node:fs';import {join,sep} from 'node:path';const nx=(p)=>String(p).replaceAll(String.fromCharCode(92),'/');import assert from 'node:assert/strict';import {syncBuiltinESMExports} from 'node:module';
      const sc=await import(${JSON.stringify(url('state-cache.mjs'))});
      const ld=await import(${JSON.stringify(url('lifecycle-detect.mjs'))});
      const dg=await import(${JSON.stringify(url('decorate-graph.mjs'))});
      const root=${JSON.stringify(root)},unit=${JSON.stringify(unit)},home=${JSON.stringify(home)},source=${JSON.stringify(source)},cache=${JSON.stringify(cache)},original=${JSON.stringify(original)};
      const oldStamp={last_hash:sc.hashText(original),outside_hash:dg.hashOutsideEdgesBlock(original),last_written:'2026-10-01T00:00:00Z',last_written_by:'decorate-graph',last_section_written:'Decision'};
      const writeSource=(files)=>fs.writeFileSync(source,JSON.stringify({files}));
      const writeLocal=(data)=>{fs.mkdirSync(join(root,'_memories/_lib'),{recursive:true});fs.writeFileSync(cache,JSON.stringify(data));};
      const importOld=(opts={})=>sc.importLegacyProjectCache(root,opts);
      ${body}`;
    const r = spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), '--input-type=module', '-e', code], {
      cwd: root, encoding: 'utf8', timeout: 10000, env: { ...process.env, NODE_OPTIONS: '', CORE_HOOKS_LOG_FILE: '/dev/null' },
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim() ? JSON.parse(r.stdout) : null;
  };
  return { base, root, home, source, cache, unit, run, clean: () => fs.rmSync(base, { recursive: true, force: true }) };
}
function control(name, body, opts = {}) {
  test(name, opts, () => {
    const s = fixture();
    try { s.run(body); } finally { s.clean(); }
  });
}

control('review dotted local key is retained without shadowing; independent transfer proceeds', `
  const dotted=[root,'_memories','.','decision.md'].join(sep),local={...oldStamp,last_hash:sc.hashText('local authority'),last_written_by:'local-authority'};
  const other=join(root,'_memories/other.md');fs.writeFileSync(other,original);writeLocal({files:{[dotted]:local}});writeSource({[unit]:oldStamp,[other]:oldStamp});
  const r=importOld({apply:true});assert.equal(r.status,'held');assert.equal(r.imported_count,1);
  const c=JSON.parse(fs.readFileSync(cache,'utf8'));assert.deepEqual(c.files[dotted],local);assert.equal(Object.hasOwn(c.files,unit),false);assert.deepEqual(c.files[other],oldStamp);
`);

control('review recovery binds receipt digest and attribution to selected preserved source entries', `
  writeSource({[unit]:oldStamp});const rename=fs.renameSync;let commits=0;
  fs.renameSync=(from,to,...a)=>{const r=rename(from,to,...a);if(String(to)===cache&&++commits===1)throw Object.assign(new Error('interrupted'),{code:'EIO'});return r;};syncBuiltinESMExports();assert.equal(importOld({apply:true}).status,'held');fs.renameSync=rename;syncBuiltinESMExports();
  const initial=fs.readFileSync(cache,'utf8'),sourceBefore=fs.readFileSync(source,'utf8');
  const {createHash}=await import('node:crypto');const stable=(v)=>Array.isArray(v)?'['+v.map(stable).join(',')+']':v!==null&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}':JSON.stringify(v);const digest=v=>createHash('sha256').update(stable(v)).digest('hex');
  for(const kind of ['stamp','attribution']){
    const c=JSON.parse(initial),receipt=c.legacy_baseline_import;
    if(kind==='stamp'){c.files[unit]={...oldStamp,last_hash:sc.hashText('contradicting B'),last_written_by:'contradicting-B'};receipt.imports[0].stamp_sha256=digest(c.files[unit]);receipt.imports[0].last_written_by='contradicting-B';}
    else receipt.imports[0].last_written_by='contradicting-display';
    delete receipt.checksum;receipt.checksum=digest(receipt);fs.writeFileSync(cache,JSON.stringify(c));const before=fs.readFileSync(cache,'utf8');
    for(const apply of [false,true]){const r=importOld({recover:true,apply});assert.equal(r.status,'held');assert.equal(r.reason,'recorded-source-key-mismatch');assert.equal(fs.readFileSync(cache,'utf8'),before);assert.equal(fs.readFileSync(source,'utf8'),sourceBefore);}
  }
`);

control('review returned refusal survives simultaneous checked mutex release failure', `
  writeSource({[unit]:oldStamp});const link=fs.linkSync,rename=fs.renameSync;let injected=null;
  fs.linkSync=(from,to,...a)=>{const r=link(from,to,...a);if(String(to).startsWith(join(root,'_memories/_lib/.state-cache.lock.g'))){injected=JSON.stringify({files:{},legacy_baseline_import:{broken:true}});fs.writeFileSync(cache,injected);}return r;};
  fs.renameSync=(from,to,...a)=>{if(nx(to).includes('/.state-cache.lock.')&&String(to).endsWith('.done'))throw Object.assign(new Error('release failed after refusal'),{code:'EACCES'});return rename(from,to,...a);};syncBuiltinESMExports();
  const r=importOld({apply:true});assert.equal(r.status,'held');assert.equal(r.reason,'LOCK_RELEASE_FAILED');assert.equal(r.operationResult?.status,'held');assert.equal(r.operationResult?.reason,'import-receipt-invalid');assert.equal(r.lockReleaseFailures.length,1);assert.equal(fs.readFileSync(cache,'utf8'),injected);
`);

control('review shared tracking guard keeps broken Git metadata unknown when index is missing', `
  const ps=await import(${JSON.stringify(url('project-state.mjs'))}),pa=await import(${JSON.stringify(url('project-artifacts.mjs'))});
  fs.writeFileSync(join(root,'.git'),'gitdir: missing-git-dir\\n');
  assert.equal(ps.trackedStateFiles(root,'codex').has('workspace.json'),true);assert.throws(()=>pa.ensureProjectArtifactDir(root,'_hooks'));assert.equal(fs.existsSync(join(root,'.core')),false);
  fs.unlinkSync(join(root,'.git'));fs.mkdirSync(join(root,'.git'));assert.equal(ps.trackedStateFiles(root,'codex').has('workspace.json'),true);assert.throws(()=>pa.ensureProjectArtifactDir(root,'_scratch'));assert.equal(fs.existsSync(join(root,'.core')),false);
`);

control('review shared tracking guard accepts a valid unborn Git repository without an index', `
  const {spawnSync}=await import('node:child_process');const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('GIT_')));Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'});
  assert.equal(spawnSync('git',['-C',root,'init','--quiet'],{env,encoding:'utf8'}).status,0);assert.equal(fs.existsSync(join(root,'.git/index')),false);
  const ps=await import(${JSON.stringify(url('project-state.mjs'))}),pa=await import(${JSON.stringify(url('project-artifacts.mjs'))});assert.equal(ps.trackedStateFiles(root,'codex').has('workspace.json'),false);assert.equal(ps.trackedStateFiles(root,'codex').size,0);assert.ok(nx(pa.ensureProjectArtifactDir(root,'_hooks')).endsWith('/_core/_hooks'));
`);

control('invalid transfer timestamp is refused before producing an invalid receipt', `
  writeSource({[unit]:oldStamp});const bytes=fs.readFileSync(source,'utf8');
  for(const now of ['not-a-date',null,42]){
    const r=importOld({apply:true,now});assert.equal(r.status,'held');assert.equal(r.reason,'invalid-import-timestamp');
    assert.equal(fs.existsSync(join(root,'_memories/_lib')),false);assert.equal(fs.readFileSync(source,'utf8'),bytes);
  }
`);

control('import preserves old baseline and attribution; later owner edit stays pending; source retained', `
  writeSource({[unit]:oldStamp});const bytes=fs.readFileSync(source,'utf8');
  fs.writeFileSync(unit,original.replace('Original owner decision.','Later owner edit.'));
  const r=importOld({apply:true});assert.equal(r.status,'verified');assert.equal(r.imported_count,1);
  const local=JSON.parse(fs.readFileSync(cache,'utf8'));assert.deepEqual(local.files[unit],oldStamp);
  assert.equal(ld.detectStore(root).files[0].classification,'pending-edit');
  assert.equal(fs.readFileSync(source,'utf8'),bytes);
`);

control('dry-run plans old evidence without cache, directory, receipt or source changes', `
  writeSource({[unit]:oldStamp});const bytes=fs.readFileSync(source,'utf8');
  const r=importOld();assert.equal(r.status,'planned');assert.equal(r.eligible_count,1);
  assert.equal(fs.existsSync(join(root,'_memories/_lib')),false);assert.equal(fs.readFileSync(source,'utf8'),bytes);
`);

control('local own key beats newer, older and tied legacy timestamps without modifying its evidence', `
  for(const timestamp of ['2000-01-01T00:00:00Z','2026-10-01T00:00:00Z','2030-01-01T00:00:00Z']){
    const localStamp={...oldStamp,last_written:'2026-10-01T00:00:00Z',last_written_by:'local-authority'};
    writeLocal({files:{[unit]:localStamp},unrelated:{keep:true}});writeSource({[unit]:{...oldStamp,last_written:timestamp}});
    const r=importOld({apply:true});assert.equal(r.status,'verified');assert.equal(r.imported_count,0);
    const c=JSON.parse(fs.readFileSync(cache,'utf8'));assert.deepEqual(c.files[unit],localStamp);assert.deepEqual(c.unrelated,{keep:true});
  }
`);

control('null local own key is held, never replaced by a valid legacy entry', `
  writeLocal({files:{[unit]:null}});writeSource({[unit]:oldStamp});const before=fs.readFileSync(cache,'utf8');
  const r=importOld({apply:true});assert.equal(r.status,'held');assert.equal(fs.readFileSync(cache,'utf8'),before);
`);

control('corrupt source and corrupt local cache do not become absence or trigger adoption', `
  fs.writeFileSync(source,'{broken');const r=importOld({apply:true});assert.equal(r.status,'held');assert.equal(fs.existsSync(cache),false);
  writeSource({[unit]:oldStamp});fs.mkdirSync(join(root,'_memories/_lib'),{recursive:true});fs.writeFileSync(cache,'{damaged');
  const again=importOld({apply:true});assert.equal(again.status,'held');assert.equal(fs.readFileSync(cache,'utf8'),'{damaged');
`);

control('verified repeat is a local-only no-op and retains a newer local stamp and receipt', `
  writeSource({[unit]:oldStamp});assert.equal(importOld({apply:true}).status,'verified');
  assert.equal(sc.stampFile(root,unit,sc.hashText('new stamp'),'later-writer',{now:'2026-10-02T00:00:00Z',extra:{outside_hash:sc.hashText('new stamp')}}).stamped,true);
  const before=fs.readFileSync(cache,'utf8');let attempts=0;const read=fs.readFileSync,stat=fs.lstatSync,dir=fs.readdirSync;
  const block=(fn)=>(p,...a)=>{if(String(p)===source||nx(p).startsWith(nx(home)+'/.core/')){attempts++;throw Object.assign(new Error('legacy access denied'),{code:'EACCES'});}return fn(p,...a);};
  fs.readFileSync=block(read);fs.lstatSync=block(stat);fs.readdirSync=block(dir);syncBuiltinESMExports();
  const r=importOld({apply:true});assert.equal(r.status,'verified');assert.equal(r.noop,true);assert.equal(attempts,0);
  assert.equal(fs.readFileSync(cache,'utf8'),before);assert.equal(JSON.parse(before).files[unit].last_written_by,'later-writer');
`);

control('missing project candidate retains held coverage while valid old evidence transfers', `
  writeSource({[unit]:oldStamp,[join(root,'_memories/missing.md')]:oldStamp});
  const r=importOld({apply:true});assert.equal(r.status,'held');assert.equal(r.imported_count,1);
  assert.deepEqual(sc.readProjectCache(root).files[unit],oldStamp);
  const before=fs.readFileSync(cache,'utf8');let attempts=0;const read=fs.readFileSync;
  fs.readFileSync=(p,...a)=>{if(String(p)===source){attempts++;throw new Error('no legacy reread');}return read(p,...a);};syncBuiltinESMExports();
  const again=importOld({apply:true});assert.equal(again.status,'held');assert.equal(again.noop,true);assert.equal(attempts,0);assert.equal(fs.readFileSync(cache,'utf8'),before);
`);

control('legacy entry without outside hash is copied unchanged and remains insufficient domain evidence', `
  const older={...oldStamp};delete older.outside_hash;writeSource({[unit]:older});
  const r=importOld({apply:true});assert.equal(r.status,'verified');assert.deepEqual(JSON.parse(fs.readFileSync(cache,'utf8')).files[unit],older);
  assert.equal(ld.detectStore(root).files[0].classification,'pending-edit');assert.equal(ld.detectStore(root).files[0].domain,'no-baseline');
`);

control('other-project and root-prefix sibling targets are never opened', `
  const foreign=root+'-sibling/_memories/foreign.md';writeSource({[unit]:oldStamp,[foreign]:oldStamp});
  let reads=0;const read=fs.readFileSync;fs.readFileSync=(p,...a)=>{if(String(p)===foreign){reads++;throw new Error('unselected target');}return read(p,...a);};syncBuiltinESMExports();
  assert.equal(importOld({apply:true}).status,'verified');assert.equal(reads,0);assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(cache,'utf8')).files),[unit]);
`);

control('verified source absence creates no current-byte baseline and remains distinct from source damage', `
  const r=importOld({apply:true});assert.equal(r.status,'source-absent');
  assert.deepEqual(sc.readProjectCache(root).files,{});assert.equal(ld.detectStore(root).files[0].classification,'no-baseline');
`);

test('different-spelling source is held without rewriting or importing an unused baseline', { skip: process.platform === 'win32' }, () => {
  const s = fixture();
  try {
    const alias = join(s.base, 'alias');fs.symlinkSync(s.root,alias);
    s.run(`writeSource({[unit]:oldStamp});const r=sc.importLegacyProjectCache(${JSON.stringify(alias)},{apply:true});assert.equal(r.status,'held');assert.equal(r.reason,'selected-evidence-held');assert.equal(fs.existsSync(cache),false);`);
  } finally { s.clean(); }
});

test('exact alias key imports to existing consumers; reader and stamper compatibility preserved', { skip: process.platform === 'win32' }, () => {
  const s = fixture();
  try {
    const alias = join(s.base, 'alias');fs.symlinkSync(s.root,alias);
    s.run(`
      const alias=${JSON.stringify(alias)},aliasUnit=alias+'/_memories/decision.md';writeSource({[aliasUnit]:oldStamp});
      assert.equal(sc.cacheCustodyProblem(alias),null,'physical alias custody remains valid');
      const imported=sc.importLegacyProjectCache(alias,{apply:true});assert.equal(imported.status,'verified');
      assert.deepEqual(sc.readProjectCache(alias).files[aliasUnit],oldStamp);
      assert.equal(ld.detectStore(alias).files[0].classification,'clean');
      fs.writeFileSync(unit,original.replace('Original owner decision.','Later alias edit.'));
      assert.equal(ld.detectStore(alias).files[0].classification,'pending-edit');
      const before=fs.readFileSync(cache,'utf8');let reads=0;const read=fs.readFileSync;
      fs.readFileSync=(p,...a)=>{if(String(p)===source){reads++;throw new Error('different spelling must not reopen legacy source');}return read(p,...a);};syncBuiltinESMExports();
      const again=importOld({apply:true});assert.equal(again.status,'held');assert.equal(again.reason,'import-key-scope-mismatch');assert.equal(reads,0);assert.equal(fs.readFileSync(cache,'utf8'),before);
      assert.equal(sc.stampFile(alias,aliasUnit,sc.hashText(original),'alias-writer').stamped,true);
    `);
  } finally { s.clean(); }
});

control('clean legacy envelope with no matching keys is held, never reported as absence or full coverage', `
  writeSource({[root+'-sibling/_memories/foreign.md']:oldStamp});
  const r=importOld({apply:true});assert.equal(r.status,'held');assert.equal(r.reason,'selected-evidence-held');assert.equal(fs.existsSync(cache),false);
`);

control('new generated cache has local ignore policy before the first cache or mutex write', `
  writeSource({[unit]:oldStamp});const open=fs.openSync,write=fs.writeFileSync;
  const check=(p)=>{if(String(p).startsWith(join(root,'_memories/_lib/'))&&!nx(p).endsWith('/.gitignore'))assert.equal(fs.readFileSync(join(root,'_memories/_lib/.gitignore'),'utf8').trim(),'*');};
  fs.openSync=(p,...a)=>{check(p);return open(p,...a);};fs.writeFileSync=(p,...a)=>{check(p);return write(p,...a);};syncBuiltinESMExports();
  assert.equal(importOld({apply:true}).status,'verified');
`);

control('tracked generated cache is retained, not overwritten despite ignore policy', `
  const {spawnSync}=await import('node:child_process');const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
  assert.equal(spawnSync('git',['-C',root,'init','--quiet'],{env,encoding:'utf8'}).status,0);
  writeLocal({files:{},retained:'tracked'});assert.equal(spawnSync('git',['-C',root,'add','--force','_memories/_lib/state-cache.json'],{env,encoding:'utf8'}).status,0);
  const before=fs.readFileSync(cache,'utf8');writeSource({[unit]:oldStamp});const r=importOld({apply:true});assert.equal(r.status,'held');assert.equal(fs.readFileSync(cache,'utf8'),before);assert.equal(fs.existsSync(join(root,'_memories/_lib/.state-cache.lock')),false);
`);

control('existing incompatible ignore policy is preserved and prevents importer writes', `
  writeSource({[unit]:oldStamp});fs.mkdirSync(join(root,'_memories/_lib'),{recursive:true});const ignore=join(root,'_memories/_lib/.gitignore');fs.writeFileSync(ignore,'*\\n!state-cache.json\\n');
  const r=importOld({apply:true});assert.equal(r.status,'held');assert.equal(fs.readFileSync(ignore,'utf8'),'*\\n!state-cache.json\\n');assert.equal(fs.existsSync(cache),false);assert.equal(fs.existsSync(join(root,'_memories/_lib/.state-cache.lock')),false);
`);

control('unknown project Git metadata cannot be treated as no tracked generated files', `
  writeSource({[unit]:oldStamp});const stat=fs.lstatSync;let checks=0;
  fs.lstatSync=(p,...a)=>{if(String(p)===join(root,'.git')){checks++;throw Object.assign(new Error('metadata unavailable'),{code:'EACCES'});}return stat(p,...a);};syncBuiltinESMExports();
  const r=importOld({apply:true});assert.equal(r.status,'held');assert.ok(checks>0);assert.equal(fs.existsSync(cache),false);assert.equal(fs.existsSync(join(root,'_memories/_lib/.state-cache.lock')),false);
`);

control('unresolved local alternate key is retained without shadowing it with a new exact key', `
  const alternate=root+'-alias/_memories/decision.md';writeLocal({files:{[alternate]:oldStamp}});writeSource({[unit]:oldStamp});const before=fs.readFileSync(cache,'utf8');
  const r=importOld({apply:true});assert.equal(r.status,'held');assert.equal(fs.readFileSync(cache,'utf8'),before);
`);

test('nonregular cache data is refused before byte selection, separate from mutex publication', { skip: process.platform === 'win32' }, () => {
  const s = fixture();
  try {
    fs.mkdirSync(dirname(s.cache),{recursive:true});
    const made=spawnSync('mkfifo',[s.cache],{encoding:'utf8'});assert.equal(made.status,0,made.stderr);
    s.run(`
      let attempts=0;const read=fs.readFileSync;
      fs.readFileSync=(p,...a)=>{if(String(p)===cache){attempts++;throw Object.assign(new Error('selected nonregular read'),{code:'EIO'});}return read(p,...a);};syncBuiltinESMExports();
      assert.equal(sc.readProjectCache(root).status,'unreadable');assert.equal(attempts,0);
      const out=sc.stampFile(root,unit,sc.hashText(original),'data-control');assert.equal(out.stamped,false);assert.equal(out.outcome,'refused');assert.equal(attempts,0);
    `);
  } finally { s.clean(); }
});

control('first rename lands then throws: outcome reports landed but unverified evidence', `
  writeSource({[unit]:oldStamp});const rename=fs.renameSync;let commits=0;
  fs.renameSync=(from,to,...a)=>{const r=rename(from,to,...a);if(String(to)===cache&&++commits===1)throw Object.assign(new Error('first image landed'),{code:'EIO'});return r;};syncBuiltinESMExports();
  const r=importOld({apply:true});fs.renameSync=rename;syncBuiltinESMExports();
  assert.equal(r.status,'held');assert.equal(r.phase,'applied-unverified');assert.equal(r.imported_count,1);
  assert.deepEqual(JSON.parse(fs.readFileSync(cache,'utf8')).files[unit],oldStamp);
`);

control('interrupted imported key later legitimately stamped remains authoritative and unverified on recovery', `
  writeSource({[unit]:oldStamp});const rename=fs.renameSync;let commits=0;
  fs.renameSync=(from,to,...a)=>{const r=rename(from,to,...a);if(String(to)===cache&&++commits===1)throw Object.assign(new Error('first image landed'),{code:'EIO'});return r;};syncBuiltinESMExports();
  assert.equal(importOld({apply:true}).status,'held');fs.renameSync=rename;syncBuiltinESMExports();
  const text=original.replace('Original owner decision.','Legitimate later local write.');fs.writeFileSync(unit,text);
  assert.equal(sc.stampFile(root,unit,sc.hashText(text),'later-writer',{now:'2026-10-03T00:00:00Z',extra:{outside_hash:dg.hashOutsideEdgesBlock(text)}}).stamped,true);
  const before=fs.readFileSync(cache,'utf8');const r=importOld({apply:true,recover:true});
  assert.equal(r.status,'held');assert.equal(r.reason,'superseded-before-verification');assert.equal(r.phase,'applied-unverified');
  assert.equal(fs.readFileSync(cache,'utf8'),before);assert.equal(JSON.parse(before).files[unit].last_written_by,'later-writer');
`);

control('unrelated normal stamp after interruption survives per-key recovery and old transfer verification', `
  writeSource({[unit]:oldStamp});const rename=fs.renameSync;let commits=0;
  fs.renameSync=(from,to,...a)=>{const r=rename(from,to,...a);if(String(to)===cache&&++commits===1)throw Object.assign(new Error('first image landed'),{code:'EIO'});return r;};syncBuiltinESMExports();
  assert.equal(importOld({apply:true}).status,'held');fs.renameSync=rename;syncBuiltinESMExports();
  const other=join(root,'_memories/other.md');fs.writeFileSync(other,original);
  assert.equal(ld.stampCreatedBaseline(root,other,{kind:'unit',now:'2026-10-03T00:00:00Z',lastWrittenBy:'unrelated-writer'}).stamped,true);
  const stamp=JSON.parse(fs.readFileSync(cache,'utf8')).files[other];
  const r=importOld({apply:true,recover:true});assert.equal(r.status,'verified');
  const c=JSON.parse(fs.readFileSync(cache,'utf8'));assert.deepEqual(c.files[unit],oldStamp);assert.deepEqual(c.files[other],stamp);assert.equal(c.legacy_baseline_import.phase,'verified');
`);

control('damaged receipt is held locally without fallback or cache replacement', `
  writeSource({[unit]:oldStamp});assert.equal(importOld({apply:true}).status,'verified');
  const c=JSON.parse(fs.readFileSync(cache,'utf8'));c.legacy_baseline_import.root=root+'-wrong';fs.writeFileSync(cache,JSON.stringify(c));
  const before=fs.readFileSync(cache,'utf8');let reads=0;const read=fs.readFileSync;fs.readFileSync=(p,...a)=>{if(String(p)===source){reads++;throw new Error('no reimport');}return read(p,...a);};syncBuiltinESMExports();
  const r=importOld({apply:true,recover:true});assert.equal(r.status,'held');assert.equal(r.reason,'import-receipt-invalid');assert.equal(reads,0);assert.equal(fs.readFileSync(cache,'utf8'),before);
`);

control('actual import CLI is dry-run/apply; held coverage stays nonzero in JSON and text', `
  const {spawnSync}=await import('node:child_process');writeSource({[unit]:oldStamp,[join(root,'_memories/missing.md')]:oldStamp});
  const preload='data:text/javascript,'+encodeURIComponent('import os from "node:os";import {syncBuiltinESMExports} from "node:module";os.userInfo=()=>({homedir:'+JSON.stringify(home)+'});syncBuiltinESMExports();');
  const script=${JSON.stringify(fileURLToPath(new URL('../../plugins/core/skills/core/scripts/lifecycle-detect.mjs', import.meta.url)))};
  const run=(args)=>spawnSync(process.execPath,['--import',preload,script,root,'--import-legacy-cache',...args],{encoding:'utf8',timeout:5000,env:{...process.env,NODE_OPTIONS:'',CORE_HOOKS_LOG_FILE:'/dev/null'}});
  const dry=run(['--json']);assert.equal(dry.status,3);assert.equal(JSON.parse(dry.stdout).status,'held');assert.equal(fs.existsSync(cache),false);
  const applied=run(['--apply','--json']);assert.equal(applied.status,3,applied.stderr);const out=JSON.parse(applied.stdout);assert.equal(out.phase,'verified');assert.equal(out.coverage,'held');assert.equal(out.imported_count,1);
  const text=run(['--apply']);assert.equal(text.status,3);assert.match(text.stdout+text.stderr,/held/);assert.equal(JSON.parse(fs.readFileSync(cache,'utf8')).legacy_baseline_import.coverage,'held');
`);

for (const kind of ['parent-link','leaf-link','leaf-hardlink','leaf-fifo']) control('legacy source '+kind+' is held before selected byte reads', `
  writeSource({[unit]:oldStamp});const before=fs.readFileSync(source,'utf8');const foreign=home+'/foreign-cache.json';
  const kind=${JSON.stringify(kind)};
  if(kind==='parent-link'){fs.renameSync(home+'/.core',home+'/foreign-core');fs.symlinkSync(home+'/foreign-core',home+'/.core');}
  if(kind==='leaf-link'){fs.renameSync(source,foreign);fs.symlinkSync(foreign,source);}
  if(kind==='leaf-hardlink')fs.linkSync(source,foreign);
  if(kind==='leaf-fifo'){fs.renameSync(source,foreign);const {spawnSync}=await import('node:child_process');assert.equal(spawnSync('mkfifo',[source],{encoding:'utf8'}).status,0);}
  let reads=0;const read=fs.readFileSync;fs.readFileSync=(p,...a)=>{if(String(p)===source){reads++;throw new Error('unsafe source selected');}return read(p,...a);};syncBuiltinESMExports();
  const r=importOld({apply:true});assert.equal(r.status,'held');assert.equal(reads,0);assert.equal(fs.existsSync(cache),false);
  const retained=kind==='parent-link'?home+'/foreign-core/state-cache.json':foreign;assert.equal(read(kind==='leaf-hardlink'?source:retained,'utf8'),before);
`, { skip: kind === 'leaf-fifo' ? (isWin && 'mkfifo is POSIX') : (kind !== 'leaf-hardlink' && !canLink && 'symlinks need a privilege this account lacks') });

for (const errno of ['EACCES','EIO']) control('legacy metadata '+errno+' is unknown rather than absent', `
  writeSource({[unit]:oldStamp});const before=fs.readFileSync(source,'utf8');const stat=fs.lstatSync,read=fs.readFileSync;let reads=0;
  fs.lstatSync=(p,...a)=>{if(String(p)===source)throw Object.assign(new Error('unknown source metadata'),{code:${JSON.stringify(errno)}});return stat(p,...a);};
  fs.readFileSync=(p,...a)=>{if(String(p)===source){reads++;throw new Error('selected bytes');}return read(p,...a);};syncBuiltinESMExports();
  const r=importOld({apply:true});assert.equal(r.status,'held');assert.equal(reads,0);assert.equal(fs.existsSync(cache),false);assert.equal(read(source,'utf8'),before);
`);

control('source changes after first cache image: old material retained unverified, no stale recovery', `
  writeSource({[unit]:oldStamp});const rename=fs.renameSync;let commits=0;
  fs.renameSync=(from,to,...a)=>{const r=rename(from,to,...a);if(String(to)===cache&&++commits===1)writeSource({[unit]:{...oldStamp,last_written_by:'changed-source'}});return r;};syncBuiltinESMExports();
  const r=importOld({apply:true});fs.renameSync=rename;syncBuiltinESMExports();assert.equal(r.status,'held');assert.equal(r.phase,'applied-unverified');assert.equal(r.imported_count,1);
  const before=fs.readFileSync(cache,'utf8');assert.deepEqual(JSON.parse(before).files[unit],oldStamp);
  const again=importOld({apply:true,recover:true});assert.equal(again.status,'held');assert.equal(again.reason,'recorded-legacy-snapshot-changed');assert.equal(fs.readFileSync(cache,'utf8'),before);
`);

control('failed cache write before first rename leaves no imported evidence or completed receipt', `
  writeSource({[unit]:oldStamp});const rename=fs.renameSync;fs.renameSync=(from,to,...a)=>{if(String(to)===cache)throw Object.assign(new Error('cache image refused'),{code:'EIO'});return rename(from,to,...a);};syncBuiltinESMExports();
  const r=importOld({apply:true});assert.equal(r.status,'held');assert.equal(r.imported_count,0);assert.equal(fs.existsSync(cache),false);
`);

control('verified transfer retains checked lock-release failure alongside its material result', `
  writeSource({[unit]:oldStamp});const before=fs.readFileSync(source,'utf8');const rename=fs.renameSync;
  fs.renameSync=(from,to,...a)=>{if(nx(to).includes('/.state-cache.lock.')&&String(to).endsWith('.done'))throw Object.assign(new Error('lock release refused'),{code:'EACCES'});return rename(from,to,...a);};syncBuiltinESMExports();
  const r=importOld({apply:true});assert.equal(r.status,'held');assert.equal(r.reason,'LOCK_RELEASE_FAILED');assert.equal(r.phase,'verified');assert.equal(r.imported_count,1);assert.equal(r.lockReleaseFailures.length,1);
  assert.deepEqual(JSON.parse(fs.readFileSync(cache,'utf8')).files[unit],oldStamp);assert.equal(fs.readFileSync(source,'utf8'),before);
`);

control('local-only rerun exposes surviving mutex without reopening global source or claiming clean completion', `
  writeSource({[unit]:oldStamp});const rename=fs.renameSync;
  fs.renameSync=(from,to,...a)=>{if(nx(to).includes('/.state-cache.lock.')&&String(to).endsWith('.done'))throw Object.assign(new Error('lock release refused'),{code:'EACCES'});return rename(from,to,...a);};syncBuiltinESMExports();
  assert.equal(importOld({apply:true}).status,'held');fs.renameSync=rename;syncBuiltinESMExports();
  const read=fs.readFileSync;let reads=0;fs.readFileSync=(p,...a)=>{if(String(p)===source){reads++;throw new Error('no global reopen');}return read(p,...a);};syncBuiltinESMExports();
  const before=fs.readFileSync(cache,'utf8');const r=importOld({apply:true});assert.equal(r.status,'held');assert.equal(r.reason,'local-cache-mutex-unsettled');assert.equal(r.phase,'verified');assert.equal(reads,0);assert.equal(fs.readFileSync(cache,'utf8'),before);
`);

for (const [name,mutation] of [
  ['source identity missing','delete r.source.identity'],
  ['source identity malformed','r.source.identity="not-a-stat-snapshot"'],
  ['invalid provenance tool','r.tool={protocol:1,script_sha256:"invalid"}'],
  ['invalid import date','r.imported_at="not-a-date"'],
  ['invalid original attribution','r.imports[0].last_written_by=null'],
  ['duplicate import entry','r.imports.push({...r.imports[0]})'],
  ['invalid retained entry','r.retained=[null]'],
  ['retained-import overlap','r.retained=[{path:unit,disposition:"local-wins"}]'],
  ['held with no held candidates','r.coverage="held"'],
  ['invalid prior checksum','r.prior_sha256="not-a-digest"'],
]) control('receipt '+name+' is held even when its integrity checksum is recomputed', `
  writeSource({[unit]:oldStamp});assert.equal(importOld({apply:true}).status,'verified');
  const c=JSON.parse(fs.readFileSync(cache,'utf8')),r=c.legacy_baseline_import;${mutation};
  const {createHash}=await import('node:crypto');const stable=(v)=>Array.isArray(v)?'['+v.map(stable).join(',')+']':v!==null&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}':JSON.stringify(v);
  delete r.checksum;r.checksum=createHash('sha256').update(stable(r)).digest('hex');fs.writeFileSync(cache,JSON.stringify(c));const before=fs.readFileSync(cache,'utf8');
  let reads=0;const read=fs.readFileSync;fs.readFileSync=(p,...a)=>{if(String(p)===source){reads++;throw new Error('no fallback');}return read(p,...a);};syncBuiltinESMExports();
  const out=importOld({apply:true,recover:true});assert.equal(out.status,'held');assert.equal(out.reason,'import-receipt-invalid');assert.equal(reads,0);assert.equal(fs.readFileSync(cache,'utf8'),before);
`);

control('nested project boundary is held without inheriting its old baseline', `
  const nested=join(root,'_memories/observations/nested');fs.mkdirSync(nested,{recursive:true});fs.writeFileSync(nested+'/PROJECT.md','# Different project');const target=join(nested,'decision.md');fs.writeFileSync(target,original);writeSource({[unit]:oldStamp,[target]:oldStamp});
  const r=importOld({apply:true});assert.equal(r.status,'held');assert.equal(r.imported_count,1);const c=JSON.parse(fs.readFileSync(cache,'utf8'));assert.deepEqual(c.files[unit],oldStamp);assert.equal(Object.hasOwn(c.files,target),false);assert.ok(r.held.some(x=>x.path===target));
`);

control('malformed Git index is unknown even when its raw bytes omit the generated cache prefix', `
  const {spawnSync}=await import('node:child_process');const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
  assert.equal(spawnSync('git',['-C',root,'init','--quiet'],{env,encoding:'utf8'}).status,0);
  const invalid=Buffer.alloc(12);invalid.write('DIRC');invalid.writeUInt32BE(2,4);fs.writeFileSync(join(root,'.git/index'),invalid);writeSource({[unit]:oldStamp});
  const r=importOld({apply:true});assert.equal(r.status,'held');assert.equal(fs.existsSync(cache),false);assert.equal(fs.existsSync(join(root,'_memories/_lib/.state-cache.lock')),false);
`);

control('verified local receipt cannot clear a cache subsequently forced into the Git index', `
  const {spawnSync}=await import('node:child_process');const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
  assert.equal(spawnSync('git',['-C',root,'init','--quiet'],{env,encoding:'utf8'}).status,0);writeSource({[unit]:oldStamp});assert.equal(importOld({apply:true}).status,'verified');
  assert.equal(spawnSync('git',['-C',root,'add','--force','_memories/_lib/state-cache.json'],{env,encoding:'utf8'}).status,0);
  const before=fs.readFileSync(cache,'utf8');let reads=0;const read=fs.readFileSync;fs.readFileSync=(p,...a)=>{if(String(p)===source){reads++;throw new Error('no source reopen');}return read(p,...a);};syncBuiltinESMExports();
  const r=importOld({apply:true});assert.equal(r.status,'held');assert.equal(reads,0);assert.equal(fs.readFileSync(cache,'utf8'),before);
`);

control('local-only rerun detects broken ignore policy without rewriting it or accessing the source', `
  writeSource({[unit]:oldStamp});assert.equal(importOld({apply:true}).status,'verified');const ignore=join(root,'_memories/_lib/.gitignore');fs.writeFileSync(ignore,'!state-cache.json\\n');const before=fs.readFileSync(cache,'utf8');
  const read=fs.readFileSync;let reads=0;fs.readFileSync=(p,...a)=>{if(String(p)===source){reads++;throw new Error('no legacy read');}return read(p,...a);};syncBuiltinESMExports();
  const r=importOld({apply:true});assert.equal(r.status,'held');assert.equal(reads,0);assert.equal(fs.readFileSync(cache,'utf8'),before);assert.equal(fs.readFileSync(ignore,'utf8'),'!state-cache.json\\n');
`);

control('promotion write fails before landing: old material stays unverified and explicit recovery verifies it', `
  writeSource({[unit]:oldStamp});const rename=fs.renameSync;let commits=0;
  fs.renameSync=(from,to,...a)=>{if(String(to)===cache&&++commits===2)throw Object.assign(new Error('promotion refused'),{code:'EIO'});return rename(from,to,...a);};syncBuiltinESMExports();
  const r=importOld({apply:true});assert.equal(r.status,'held');assert.equal(r.phase,'applied-unverified');assert.equal(r.imported_count,1);assert.equal(JSON.parse(fs.readFileSync(cache,'utf8')).legacy_baseline_import.phase,'applied-unverified');
  fs.renameSync=rename;syncBuiltinESMExports();assert.equal(importOld({apply:true,recover:true}).status,'verified');
`);

control('promotion rename lands then throws: verified material is reported with held operation and no replay', `
  writeSource({[unit]:oldStamp});const rename=fs.renameSync;let commits=0;
  fs.renameSync=(from,to,...a)=>{const r=rename(from,to,...a);if(String(to)===cache&&++commits===2)throw Object.assign(new Error('promotion landed then failed'),{code:'EIO'});return r;};syncBuiltinESMExports();
  const r=importOld({apply:true});assert.equal(r.status,'held');assert.equal(r.phase,'verified');assert.equal(r.imported_count,1);assert.equal(commits,2);
  fs.renameSync=rename;syncBuiltinESMExports();const before=fs.readFileSync(cache,'utf8');const again=importOld({apply:true});assert.equal(again.status,'verified');assert.equal(again.noop,true);assert.equal(fs.readFileSync(cache,'utf8'),before);
`);

control('first output readback differs: retained applied evidence is not promoted or replayed', `
  writeSource({[unit]:oldStamp});const rename=fs.renameSync;let commits=0;
  fs.renameSync=(from,to,...a)=>{const r=rename(from,to,...a);if(String(to)===cache&&++commits===1){const c=JSON.parse(fs.readFileSync(cache,'utf8'));c.files[unit]={...oldStamp,last_written_by:'unrelated-after-landing'};fs.writeFileSync(cache,JSON.stringify(c));}return r;};syncBuiltinESMExports();
  const r=importOld({apply:true});assert.equal(r.status,'held');assert.equal(r.phase,'applied-unverified');assert.equal(commits,1);assert.equal(JSON.parse(fs.readFileSync(cache,'utf8')).files[unit].last_written_by,'unrelated-after-landing');
  fs.renameSync=rename;syncBuiltinESMExports();const before=fs.readFileSync(cache,'utf8');const again=importOld({apply:true,recover:true});assert.equal(again.status,'held');assert.equal(again.reason,'superseded-before-verification');assert.equal(fs.readFileSync(cache,'utf8'),before);
`);

control('interrupted recovery dry-run stays held and leaves both images untouched', `
  writeSource({[unit]:oldStamp});const rename=fs.renameSync;let commits=0;
  fs.renameSync=(from,to,...a)=>{const r=rename(from,to,...a);if(String(to)===cache&&++commits===1)throw Object.assign(new Error('interrupted'),{code:'EIO'});return r;};syncBuiltinESMExports();
  assert.equal(importOld({apply:true}).status,'held');fs.renameSync=rename;syncBuiltinESMExports();const before=fs.readFileSync(cache,'utf8'),sourceBefore=fs.readFileSync(source,'utf8');
  const r=importOld({recover:true});assert.equal(r.status,'held');assert.equal(r.phase,'applied-unverified');assert.equal(r.reason,'recovery-preview');assert.equal(r.imported_count,0);assert.equal(r.recoverable_count,1);assert.equal(fs.readFileSync(cache,'utf8'),before);assert.equal(fs.readFileSync(source,'utf8'),sourceBefore);
`);

control('ordinary real detection after import never opens or probes the legacy cache', `
  writeSource({[unit]:oldStamp});assert.equal(importOld({apply:true}).status,'verified');
  const read=fs.readFileSync,stat=fs.lstatSync;let attempts=0;const block=fn=>(p,...a)=>{if(nx(p).startsWith(nx(home)+'/.core/')){attempts++;throw Object.assign(new Error('no legacy access'),{code:'EACCES'});}return fn(p,...a);};fs.readFileSync=block(read);fs.lstatSync=block(stat);syncBuiltinESMExports();
  assert.equal(ld.detectStore(root).files[0].classification,'clean');fs.writeFileSync(unit,original.replace('Original owner decision.','Later ordinary detection edit.'));assert.equal(ld.detectStore(root).files[0].classification,'pending-edit');assert.equal(attempts,0);
`);

control('PROJECT and declared generated index keys retain old evidence without target-content adoption', `
  const hot=await import(${JSON.stringify(url('hot-section.mjs'))});const project=join(root,'PROJECT.md');fs.writeFileSync(project,original);
  const projectStamp={...oldStamp,last_written_by:'hot-section',outside_hash:hot.hashOutsideHotBlock(original)};
  const index=join(root,'_memories/INDEX-decisions.md'),summaries=join(root,'_memories/_lib/unit-summaries.json');fs.mkdirSync(join(root,'_memories/_lib'),{recursive:true});fs.writeFileSync(index,'old generated index');fs.writeFileSync(summaries,'{}');
  const indexStamp={...oldStamp,last_hash:sc.hashText('old generated index'),last_written_by:'maintenance-run'};delete indexStamp.outside_hash;
  const summaryStamp={...indexStamp,last_hash:sc.hashText('{}')};writeSource({[unit]:oldStamp,[project]:projectStamp,[index]:indexStamp,[summaries]:summaryStamp});
  let reads=0;const read=fs.readFileSync;fs.readFileSync=(p,...a)=>{if([unit,project,index,summaries].includes(String(p))){reads++;throw new Error('import must not adopt selected target bytes');}return read(p,...a);};syncBuiltinESMExports();
  const r=importOld({apply:true});assert.equal(r.status,'verified');assert.equal(r.imported_count,4);assert.equal(reads,0);fs.readFileSync=read;syncBuiltinESMExports();
  const c=JSON.parse(fs.readFileSync(cache,'utf8'));assert.deepEqual(c.files[project],projectStamp);assert.deepEqual(c.files[index],indexStamp);assert.deepEqual(c.files[summaries],summaryStamp);
  assert.equal(ld.detectStore(root).files.find(x=>x.path===project).classification,'clean');fs.writeFileSync(project,original.replace('Original owner decision.','Later project edit.'));assert.equal(ld.detectStore(root).files.find(x=>x.path===project).classification,'pending-edit');
`);

for(const kind of ['link','hardlink','directory']) control('ignore policy '+kind+' is held before importer mutex/cache writes', `
  writeSource({[unit]:oldStamp});fs.mkdirSync(join(root,'_memories/_lib'),{recursive:true});const ignore=join(root,'_memories/_lib/.gitignore'),foreign=join(root,'foreign-policy');fs.writeFileSync(foreign,'*\\n');
  const kind=${JSON.stringify(kind)};if(kind==='link')fs.symlinkSync(foreign,ignore);if(kind==='hardlink')fs.linkSync(foreign,ignore);if(kind==='directory')fs.mkdirSync(ignore);
  const r=importOld({apply:true});assert.equal(r.status,'held');assert.equal(fs.existsSync(cache),false);assert.equal(fs.readFileSync(foreign,'utf8'),'*\\n');assert.ok(!fs.readdirSync(join(root,'_memories/_lib')).some(n=>n.startsWith('.state-cache.lock')));
`, { skip: kind === 'link' && !canLink && 'symlinks need a privilege this account lacks' });

control('linked candidate parent holds before target probes while independent old stamp transfers', `
  const parent=join(root,'_memories/observations'),foreign=join(root,'foreign');fs.mkdirSync(foreign);const target=join(parent,'foreign.md');fs.writeFileSync(foreign+'/foreign.md',original);fs.symlinkSync(foreign,parent);writeSource({[unit]:oldStamp,[target]:oldStamp});
  const read=fs.readFileSync,stat=fs.lstatSync;let targetReads=0,targetStats=0;fs.readFileSync=(p,...a)=>{if(String(p)===target){targetReads++;throw new Error('target bytes must not be selected');}return read(p,...a);};fs.lstatSync=(p,...a)=>{if(String(p)===target){targetStats++;throw new Error('parent must be checked first');}return stat(p,...a);};syncBuiltinESMExports();
  const r=importOld({apply:true});assert.equal(r.status,'held');assert.equal(r.imported_count,1);assert.equal(targetReads,0);assert.equal(targetStats,0);assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(cache,'utf8')).files,target),false);
`, { skip: !canLink && 'symlinks need a privilege this account lacks' });

control('source envelope and selected stamp field damage remain held, source bytes retained', `
  for(const damaged of ['null','{"files":[]}','{"files":"unknown"}']){fs.writeFileSync(source,damaged);const r=importOld({apply:true});assert.equal(r.status,'held');assert.equal(fs.readFileSync(source,'utf8'),damaged);assert.equal(fs.existsSync(cache),false);}
  for(const patch of [{last_hash:42},{outside_hash:null},{last_written:'unknown'},{last_written_by:null},{last_section_written:[]}]){writeSource({[unit]:{...oldStamp,...patch}});const before=fs.readFileSync(source,'utf8');const r=importOld({apply:true});assert.equal(r.status,'held');assert.equal(fs.readFileSync(source,'utf8'),before);assert.equal(fs.existsSync(cache),false);}
`);

control('recovery without a recorded transfer is held locally and never initiates a new import', `
  writeSource({[unit]:oldStamp});let reads=0;const read=fs.readFileSync;fs.readFileSync=(p,...a)=>{if(String(p)===source){reads++;throw new Error('recovery has no recorded snapshot');}return read(p,...a);};syncBuiltinESMExports();
  for(const apply of [false,true]){const r=importOld({apply,recover:true});assert.equal(r.status,'held');assert.equal(r.reason,'no-import-to-recover');assert.equal(reads,0);assert.equal(fs.existsSync(cache),false);}
`);

for (const fault of [false,true]) control('Git worktree-style pointer '+(fault?'observed presence then unreadable remains unknown':'supports a normal import'), `
  const {spawnSync}=await import('node:child_process');const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};assert.equal(spawnSync('git',['-C',root,'init','--quiet'],{env,encoding:'utf8'}).status,0);
  fs.renameSync(join(root,'.git'),join(root,'.git-store'));fs.writeFileSync(join(root,'.git'),'gitdir: .git-store\\n');writeSource({[unit]:oldStamp});
  const fault=${JSON.stringify(fault)};const read=fs.readFileSync;let faults=0;fs.readFileSync=(p,...a)=>{if(fault&&String(p)===join(root,'.git')){faults++;throw Object.assign(new Error('observed pointer became unreadable'),{code:'ENOENT'});}return read(p,...a);};syncBuiltinESMExports();
  const r=importOld({apply:true});assert.equal(r.status,fault?'held':'verified');if(fault){assert.ok(faults>0);assert.equal(fs.existsSync(cache),false);}else assert.deepEqual(JSON.parse(fs.readFileSync(cache,'utf8')).files[unit],oldStamp);
`);

control('recovery rechecks receipt presence under the mutex and cannot restart a disappeared transfer', `
  writeSource({[unit]:oldStamp});const rename=fs.renameSync;let commits=0;
  fs.renameSync=(from,to,...a)=>{const r=rename(from,to,...a);if(String(to)===cache&&++commits===1)throw Object.assign(new Error('interrupted'),{code:'EIO'});return r;};syncBuiltinESMExports();assert.equal(importOld({apply:true}).status,'held');fs.renameSync=rename;syncBuiltinESMExports();
  const link=fs.linkSync;let afterRemoval=null;fs.linkSync=(from,to,...a)=>{const r=link(from,to,...a);if(String(to).startsWith(join(root,'_memories/_lib/.state-cache.lock.g'))){const c=JSON.parse(fs.readFileSync(cache,'utf8'));delete c.legacy_baseline_import;afterRemoval=JSON.stringify(c);fs.writeFileSync(cache,afterRemoval);}return r;};syncBuiltinESMExports();
  const r=importOld({apply:true,recover:true});assert.equal(r.status,'held');assert.equal(r.reason,'no-import-to-recover');assert.ok(afterRemoval);assert.equal(fs.readFileSync(cache,'utf8'),afterRemoval);assert.deepEqual(JSON.parse(afterRemoval).files[unit],oldStamp);
`);
