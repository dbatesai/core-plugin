import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join,  resolve } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { registryEnvFor } from './trusted-test-tmp.mjs';
import { resolveHookLogPath, logHookEvent } from '../../plugins/core/skills/core/hooks/hook-log.mjs';
import { detectCloseState, CLOSE_OPS } from '../../plugins/core/skills/core/scripts/close-pass.mjs';

const HOOKS = fileURLToPath(new URL('../../plugins/core/skills/core/hooks/', import.meta.url));
const CLOSE_PASS = join(HOOKS, '..', 'scripts', 'close-pass.mjs');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hook-log-project-'));
  return { root, log: join(root, '_core', '_hooks', 'hooks-log.jsonl'), cleanup: () => rmSync(root, {recursive:true,force:true}) };
}
function readLog(file) { return existsSync(file) ? readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; }
function hook(f, name, env = {}, payload = {}) {
  return execFileSync(process.execPath, [join(HOOKS, name)], {
    cwd:f.root, input:JSON.stringify({cwd:f.root,...payload}),encoding:'utf8',
    env:{...process.env, CORE_HOOKS_LOG_FILE:'', CORE_AUTOSTART_SKILL:'',CORE_CLOSE_PASS_ACTIVE:'0',
      ...registryEnvFor(f.root),...env}
  });
}
test('local path selection rejects missing roots and foreign overrides, permits direct children and mute', () => {
  const root = resolve('/project'), dir = join(root,'_core','_hooks'), dflt = join(dir,'hooks-log.jsonl');
  assert.equal(resolveHookLogPath({}),null);
  assert.equal(resolveHookLogPath({},root),dflt);
  assert.equal(resolveHookLogPath({CORE_HOOKS_LOG_FILE:'/other/log'},root),dflt);
  assert.equal(resolveHookLogPath({CORE_HOOKS_LOG_FILE:join(dir,'nested','log')},root),dflt);
  assert.equal(resolveHookLogPath({CORE_HOOKS_LOG_FILE:join(dir,'.gitignore')},root),dflt);
  assert.equal(resolveHookLogPath({CORE_HOOKS_LOG_FILE:join(dir,'custom.jsonl')},root),join(dir,'custom.jsonl'));
  assert.equal(resolveHookLogPath({CORE_HOOKS_LOG_FILE:'/dev/null'}),'/dev/null');
});
test('missing explicit root cannot infer an artifact destination from cwd', () => {
  assert.deepEqual(logHookEvent({hook:'test',action:'skip',cwd:process.cwd()}),{written:false,error_code:'hook-log-project-required'});
});
test('logger appends JSONL and protects its packaged producer fields', () => {
  const f=fixture();try {
    for(let i=0;i<2;i++) assert.equal(logHookEvent({hook:'test',action:'skip',projectRoot:f.root,cwd:f.root,producer_sha:'forged'}).written,true);
    const rows=readLog(f.log);assert.equal(rows.length,2);assert.ok(rows[0].ts);assert.notEqual(rows[0].producer_sha,'forged');
  }finally{f.cleanup();}
});
test('a file in place of a log directory returns failure without throwing or relocation', () => {
  const f=fixture();try{
    mkdirSync(join(f.root,'_core'));writeFileSync(join(f.root,'_core','_hooks'),'preserved');
    const out=logHookEvent({hook:'test',action:'skip',projectRoot:f.root});
    assert.equal(out.written,false);assert.equal(out.fallback,undefined);
    assert.equal(readFileSync(join(f.root,'_core','_hooks'),'utf8'),'preserved');
  }finally{f.cleanup();}
});
for(const [env,action,reason] of [
  [{CORE_AUTOSTART:''},'inject',undefined],
  [{CORE_AUTOSTART:'0'},'skip','opt-out'],
  [{CORE_CLOSE_PASS_ACTIVE:'1'},'skip','close-pass-child']
]) test(`SessionStart ${reason || action} produces one local receipt`,()=>{
  const f=fixture();try{
    const output=hook(f,'session-start-hook.mjs',env);const rows=readLog(f.log);
    assert.equal(rows.length,1);assert.equal(rows[0].action,action);assert.equal(rows[0].reason,reason);
    if(action==='inject')assert.match(output,/CORE session protocol/);else assert.equal(output,'');
  }finally{f.cleanup();}
});
test('SessionEnd recursion guard records local skip and spawns no child',()=>{
  const f=fixture();try{assert.equal(hook(f,'close-pass-hook.mjs',{CORE_CLOSE_PASS_ACTIVE:'1'}),'');
    assert.equal(readLog(f.log)[0].reason,'recursion-guard');
  }finally{f.cleanup();}
});
test('SessionEnd refuses an unregistered folder without creating a local log',()=>{
  const f=fixture(),other=fixture();try{
    hook(f,'close-pass-hook.mjs',{CORE_AUTO_CLOSE:'1',...registryEnvFor(other.root)},{reason:'other',transcript_path:'/x'});
    assert.equal(existsSync(f.log),false);
  }finally{f.cleanup();other.cleanup();}
});
test('a fully finished close owes no catch-up work',()=>{
  const f=fixture();try{
    mkdirSync(join(f.root,'_memories'));
    execFileSync(process.execPath,[CLOSE_PASS,'begin',f.root,'--session','s','--ops',CLOSE_OPS.join(',')]);
    for(const op of CLOSE_OPS)execFileSync(process.execPath,[CLOSE_PASS,'record',f.root,'--op',op,'--status','done']);
    execFileSync(process.execPath,[CLOSE_PASS,'finish',f.root,'--session','s']);
    const det=detectCloseState(f.root,{allOps:CLOSE_OPS});assert.equal(det.state,'closed');assert.deepEqual(det.owed,[]);
  }finally{f.cleanup();}
});
