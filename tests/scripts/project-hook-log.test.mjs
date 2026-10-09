import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, delimiter, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { symlinkCapable } from './trusted-test-tmp.mjs';
const norm = p => String(p).split(sep).join('/');
const source = fileURLToPath(new URL('../../', import.meta.url));
const hookBase = new URL('../../plugins/core/skills/core/hooks/', import.meta.url);
const gate = new URL('./fs-confine.mjs', import.meta.url).href;   // --import takes a URL; a bare Windows path fails
const logger = new URL('hook-log.mjs', hookBase).href;
function fixture() {
  const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'project-hook-log-')));
  const root = join(base, 'project'), home = join(base, 'home'), wrong = join(base, 'wrong-cwd');
  for (const p of [root, home, wrong]) fs.mkdirSync(p);
  fs.mkdirSync(join(home, '.core'));
  fs.writeFileSync(join(home, '.core/projects.json'), JSON.stringify([{ path: root }]));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  fs.writeFileSync(join(root, '.gitignore'), '!.core/**\n');
  return { base, root, home, wrong, log: join(root, '_core/_hooks/hooks-log.jsonl'),
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}
function run(f, { entry = {}, env = {}, fault = '', hook = null, payload = {} } = {}) {
  const audit = join(f.base, 'audit-' + Math.random().toString(36).slice(2) + '.jsonl');
  const patch = `import os from 'node:os';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    os.userInfo=()=>({homedir:${JSON.stringify(f.home)}});${fault};syncBuiltinESMExports();`;
  const code = `const {logHookEvent}=await import(${JSON.stringify(logger)});
    console.log(JSON.stringify(logHookEvent(${JSON.stringify({ hook: 'synthetic', action: 'skip', cwd: f.root, projectRoot: f.root, ...entry })})));`;
  const r = spawnSync(process.execPath, ['--import', gate, '--import', 'data:text/javascript,' + encodeURIComponent(patch),
    ...(hook ? [fileURLToPath(new URL(hook, hookBase))] : ['--input-type=module', '-e', code])],
  { cwd: f.wrong, input: JSON.stringify({ cwd: f.root, ...payload }), encoding: 'utf8',
    env: { ...process.env, CORE_AUTOSTART_SKILL: '', CORE_CLOSE_PASS_ACTIVE: '0', CORE_AUTO_CLOSE: '0',
      CORE_HOOKS_LOG_FILE: '', FS_CONFINE_ROOTS: [source, f.root, f.home, f.wrong].join(delimiter),
      FS_CONFINE_LOG: audit, ...env } });
  assert.equal(r.status, 0, r.stderr);
  const violations = JSON.parse(r.stderr.match(/FS_CONFINE_VIOLATIONS (.*)/)[1]);
  const calls = fs.readFileSync(audit, 'utf8').trim().split('\n').filter(Boolean).map(x => JSON.parse(x));
  const writes = calls.filter(x => /^(appendFile|writeFile|mkdir|mkdtemp|rename|chmod)/.test(x.call));
  assert.equal(writes.some(x => !norm(x.path).startsWith(norm(f.root) + '/')), false, 'no write attempt outside the project');
  return { ...r, violations, calls, result: hook ? null : JSON.parse(r.stdout) };
}
function rows(f) { return fs.readFileSync(f.log, 'utf8').trim().split('\n').map(x => JSON.parse(x)); }

test('hook logger writes an excluded project-local receipt, with protected producer identity and no enrollment', () => {
  const f = fixture();
  try {
    const r = run(f, { entry: { producer_version: 'forged', producer_sha: 'forged' } });
    assert.equal(r.result.written, true); assert.deepEqual(r.violations, []);
    const [row] = rows(f); assert.equal(row.cwd, f.root); assert.notEqual(row.producer_sha, 'forged');
    assert.notEqual(row.producer_version, 'forged'); assert.ok(row.ts);
    assert.equal(spawnSync('git', ['-C', f.root, 'check-ignore', '_core/_hooks/hooks-log.jsonl']).status, 0);
    assert.equal(fs.existsSync(join(f.home, '.core/install-id')), false);
    assert.equal(fs.readdirSync(join(f.root, '_core')).some(n => n === 'codex' || n === 'claude-code'), false);
  } finally { f.cleanup(); }
});

test('a global or sibling-project override cannot redirect a local hook receipt', () => {
  const f = fixture();
  try {
    const foreign = join(f.home, '.core/foreign-log.jsonl');
    assert.equal(run(f, { env: { CORE_HOOKS_LOG_FILE: foreign } }).result.written, true);
    assert.equal(fs.existsSync(foreign), false); assert.equal(rows(f).length, 1);
  } finally { f.cleanup(); }
});

for (const target of ['core', 'hooks', 'leaf', 'ignore']) test(`linked ${target} is refused before any foreign access`, t => {
  if (!symlinkCapable()) return t.skip('symlink fixture privilege unavailable');
  const f = fixture();
  try {
    const outside = join(f.base, 'outside'); fs.mkdirSync(outside);
    let link;
    if (target === 'core') link = join(f.root, '_core');
    else { fs.mkdirSync(join(f.root, '_core'), { recursive: true });
      if (target === 'hooks') link = join(f.root, '_core/_hooks');
      else { fs.mkdirSync(join(f.root, '_core/_hooks')); link = target === 'leaf' ? f.log : join(f.root, '_core/_hooks/.gitignore'); }
    }
    if (target === 'ignore' || target === 'leaf') {
      fs.writeFileSync(join(outside, 'file'), target === 'ignore' ? '*\n' : 'untouched');
      fs.symlinkSync(join(outside, 'file'), link);
    } else fs.symlinkSync(outside, link, 'dir');
    const r = run(f); assert.equal(r.result.written, false); assert.deepEqual(r.violations, []);
    assert.equal(fs.existsSync(join(outside, 'hooks-log.jsonl')), false);
    if (target === 'leaf') assert.equal(fs.readFileSync(join(outside, 'file'), 'utf8'), 'untouched');
  } finally { f.cleanup(); }
});

test('permission denial reports failure without a global or OS-temp fallback', () => {
  const f = fixture();
  try {
    const fault = `const append=fs.appendFileSync;fs.appendFileSync=(p,...args)=>{
      if(String(p)===${JSON.stringify(f.log)})throw Object.assign(new Error('denied'),{code:'EACCES'});
      return append(p,...args);}`;
    const r = run(f, { fault }); assert.equal(r.result.written, false); assert.equal(r.result.error_code, 'EACCES');
    assert.deepEqual(r.violations, []); assert.equal(fs.existsSync(join(f.home, '.core/hooks-log.jsonl')), false);
  } finally { f.cleanup(); }
});

test('tracked receipts and a custom non-excluding ignore file are preserved and refused', () => {
  const f = fixture();
  try {
    fs.mkdirSync(join(f.root, '_core/_hooks'), { recursive: true });
    const ignore = join(f.root, '_core/_hooks/.gitignore');
    fs.writeFileSync(ignore, '# user custom\n');
    assert.equal(run(f).result.written, false); assert.equal(fs.readFileSync(ignore, 'utf8'), '# user custom\n');
    fs.writeFileSync(ignore, '*\n'); fs.writeFileSync(f.log, 'preserved\n');
    assert.equal(spawnSync('git', ['-C', f.root, 'add', '-f', f.log]).status, 0);
    assert.equal(run(f).result.written, false); assert.equal(fs.readFileSync(f.log, 'utf8'), 'preserved\n');
  } finally { f.cleanup(); }
});

test('silencing the logger causes no directory or foreign sink access', () => {
  const f = fixture();
  try {
    const r = run(f, { env: { CORE_HOOKS_LOG_FILE: '/dev/null' } });
    assert.equal(r.result.written, true); assert.deepEqual(r.violations, []);
    assert.equal(fs.existsSync(join(f.root, '_core')), false);
  } finally { f.cleanup(); }
});

for (const [hook, env, reason] of [
  ['session-start-hook.mjs', { CORE_AUTOSTART: '0' }, 'opt-out'],
  ['session-start-hook.mjs', { CORE_CLOSE_PASS_ACTIVE: '1' }, 'close-pass-child'],
  ['close-pass-hook.mjs', { CORE_AUTO_CLOSE: '0' }, 'kill-switch'],
  ['close-pass-hook.mjs', { CORE_CLOSE_PASS_ACTIVE: '1' }, 'recursion-guard'],
  ['retrieve-context-hook.mjs', { CORE_RETRIEVAL_HOOK: '0' }, 'retrieval-opt-out'],
  ['retrieve-context-hook.mjs', { CORE_RETRIEVAL_HOOK: '1' }, 'empty-prompt'],
]) test(`${hook} ${reason}: payload cwd wins over process cwd for the early receipt`, () => {
  const f = fixture();
  try {
    const r = run(f, { hook, env }); assert.deepEqual(r.violations, []);
    assert.ok(rows(f).some(x => x.reason === reason && x.cwd === f.root));
    assert.equal(fs.existsSync(join(f.wrong, '_core')), false);
  } finally { f.cleanup(); }
});
