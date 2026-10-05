import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

for (const legacyRecord of [false, true]) test(`${legacyRecord ? 'older signed check' : 'fresh check'}: unresolved root-pointer tracking stays visible; healthy recovery resumes fast checks`, () => {
  const base=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'migration-pointer-warning-')));
  try {
    const root=join(base,'project'),home=join(base,'home'),core=join(home,'.core'),source=join(core,'workspaces','legacy');
    fs.mkdirSync(root);fs.mkdirSync(source,{recursive:true});
    const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('GIT_')));
    Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',NODE_OPTIONS:'',CORE_HOOKS_LOG_FILE:process.platform==='win32'?'NUL':'/dev/null'});
    const git=args=>spawnSync('git',['-C',root,...args],{env,encoding:'utf8'});
    assert.equal(git(['init','--quiet']).status,0);
    const pointer=join(root,'workspace.json'),before=JSON.stringify({workspace_id:'legacy',owner_note:'preserved synthetic note'});
    fs.writeFileSync(pointer,before);assert.equal(git(['add','workspace.json']).status,0);
    fs.writeFileSync(join(source,'workspace.json'),JSON.stringify({workspace_id:'legacy',harness:'codex'}));fs.writeFileSync(join(source,'notes.md'),'synthetic material\n');
    fs.writeFileSync(join(core,'index.json'),JSON.stringify([{workspace_id:'legacy',path:root}]));
    const table=join(core,'fixture-table.json');fs.writeFileSync(table,JSON.stringify({entries:{legacy:{harness:'codex',evidence:'synthetic'}}}));
    const fail=join(base,'git-unavailable');
    const preload=`import fs from 'node:fs';import os from 'node:os';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';os.userInfo=()=>({homedir:${JSON.stringify(home)}});os.homedir=()=>${JSON.stringify(home)};const original=cp.execFileSync;let checks=0;cp.execFileSync=(cmd,args,...rest)=>{if(cmd==='git'&&args.includes('--error-unmatch')&&args.at(-1)==='workspace.json'){checks++;if(fs.existsSync(${JSON.stringify(fail)}))throw Object.assign(new Error('synthetic tracking EIO'),{code:'EIO'});}return original(cmd,args,...rest);};syncBuiltinESMExports();process.on('exit',()=>process.stderr.write('SELECTED_GIT_CHECKS '+checks+'\\n'));`;
    const script=resolve(dirname(fileURLToPath(import.meta.url)),'../../plugins/core/skills/core/scripts/migrate-workspace-state.mjs');
    const run=()=>{
      const r=spawnSync(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(preload),script,'--apply','--root',root,'--harness','codex','--core-dir',core,'--table',table],{cwd:root,env,encoding:'utf8',timeout:10000});
      assert.equal(r.error,undefined,r.stderr);assert.equal(r.status,0,r.stderr);assert.equal(fs.readFileSync(pointer,'utf8'),before);return {out:JSON.parse(r.stdout),checks:Number(r.stderr.match(/SELECTED_GIT_CHECKS (\d+)/)?.[1])};
    };
    if (legacyRecord) {
      run();run(); // Complete a healthy transfer and obtain current input fingerprints.
      const stateModule=resolve(dirname(fileURLToPath(import.meta.url)),'../../plugins/core/skills/core/scripts/project-state.mjs');
      const code=`const {readSignedFile,writeSignedFile}=await import(${JSON.stringify(pathToFileURL(stateModule).href)});const opts={root:${JSON.stringify(root)},harness:'codex',coreDir:${JSON.stringify(core)},name:'migration-check.json'};const record=JSON.parse(readSignedFile(opts));delete record.validation_version;writeSignedFile({dir:${JSON.stringify(join(root,'.core','codex'))},name:opts.name,coreDir:opts.coreDir,body:JSON.stringify(record)});`;
      const old=spawnSync(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(preload),'--input-type=module','-e',code],{cwd:root,env,encoding:'utf8',timeout:10000});assert.equal(old.error,undefined,old.stderr);assert.equal(old.status,0,old.stderr);
    }
    fs.writeFileSync(fail,'synthetic selected EIO');
    let receipt=null;
    for(let invocation=1;invocation<=3;invocation++) {
      const r=run();assert.equal(r.out.root_pointer,'kept (tracking-unknown)',`invocation ${invocation} must retain unresolved pointer status`);assert.equal(r.out.fast===true,false);assert.equal(r.checks,1);assert.equal(r.out.released,true);assert.equal(r.out.status,invocation===1&&!legacyRecord?'migrated':'already-migrated');
      const bytes=fs.readFileSync(join(root,'.core','codex','migrated-from.json'),'utf8');if(receipt===null)receipt=bytes;else assert.equal(bytes,receipt,'completed material is not replayed');
    }
    fs.unlinkSync(fail);const recovered=run();assert.equal(recovered.out.root_pointer,undefined);assert.equal(recovered.out.fast===true,false);assert.equal(recovered.checks,1);
    const fast=run();assert.equal(fast.out.fast,true);assert.equal(fast.out.root_pointer,undefined);assert.equal(fast.checks,0);assert.equal(fs.readFileSync(join(root,'.core','codex','migrated-from.json'),'utf8'),receipt);
  } finally {fs.rmSync(base,{recursive:true,force:true});}
});
