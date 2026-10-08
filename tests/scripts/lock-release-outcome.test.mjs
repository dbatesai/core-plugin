import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withFileLock, useNoMachineIdentity, currentLockFile, inspectFileLock,
  releaseFileLock } from '../../plugins/core/skills/core/scripts/file-lock.mjs';
import { applyMigration, checkLegacyDrift } from '../../plugins/core/skills/core/scripts/migrate-workspace-state.mjs';
import { appendRows, acquireLock } from '../../plugins/core/skills/core/scripts/capability-history.mjs';
import { beginClose } from '../../plugins/core/skills/core/scripts/close-pass.mjs';

useNoMachineIdentity();
function sandbox() {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'lock-release-outcome-')));
  const root = join(base, 'project'), coreDir = join(base, 'home/.core');
  fs.mkdirSync(root); fs.mkdirSync(coreDir, { recursive: true });
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  fs.writeFileSync(join(coreDir, 'projects.json'), JSON.stringify([{ path: root }]));
  return { base, root, coreDir, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}
function migrationFixture() {
  const f = sandbox();
  const legacy = join(f.coreDir, 'workspaces/legacy');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(join(legacy, 'workspace.json'), '{}');
  fs.writeFileSync(join(legacy, 'capability-history.jsonl'), '{"row":1}\n');
  fs.writeFileSync(join(f.coreDir, 'index.json'), JSON.stringify([{ path: f.root, workspace_id: 'legacy' }]));
  fs.writeFileSync(join(f.root, 'workspace.json'), JSON.stringify({ workspace_id: 'legacy' }));
  return { ...f, legacy, options: { root: f.root, coreDir: f.coreDir, harness: 'codex',
    table: { entries: { legacy: { harness: 'codex', evidence: 'synthetic fixture' } } } } };
}
function denial(lock, fn, primary = null) {
  const original = fs.renameSync;
  let attempts = 0;
  fs.renameSync = (from, to) => {
    if (String(from).startsWith(lock + '.g') && String(to).endsWith('.done')) {
      attempts++; throw Object.assign(new Error('synthetic release denial'), { code: 'EPERM' });
    }
    if (primary && String(to).endsWith('_close-marker.json')) throw primary;
    return original(from, to);
  };
  syncBuiltinESMExports();
  try { fn(); assert.ok(attempts > 0, 'release denial exercised'); }
  finally { fs.renameSync = original; syncBuiltinESMExports(); }
}
function captureError(fn) { let error; try { fn(); } catch (e) { error = e; }
  assert.ok(error, 'failed release must not return clean success'); return error; }
function assertRelease(error, lock) {
  assert.equal(error.code, 'LOCK_RELEASE_FAILED');
  assert.equal(error.lockPath, lock);
  assert.equal(error.releaseResult.error, 'EPERM');
  assert.equal(error.recovery.retry_operation, false);
  assert.ok(error.recovery.instruction.includes('inspect'));
  assert.ok(currentLockFile(lock), 'failed release leaves a visible live generation');
}
function recover(lock) {
  const seen = inspectFileLock(lock);
  assert.equal(releaseFileLock(lock, seen.lock.nonce).released, true);
}

test('shared wrapper preserves its completed result and executes the operation only once', () => {
  const f = sandbox(), lock = join(f.root, 'test.lock');
  try {
    let calls = 0;
    const result = { appended: 1, path: 'synthetic' };
    denial(lock, () => {
      const error = captureError(() => withFileLock(lock, () => { calls++; return result; }));
      assertRelease(error, lock); assert.equal(error.operationResult, result);
    });
    assert.equal(calls, 1); recover(lock);
  } finally { f.cleanup(); }
});

test('shared wrapper preserves a primary operation error when release also fails', () => {
  const f = sandbox(), lock = join(f.root, 'test.lock');
  try {
    const primary = Object.assign(new Error('primary operation failure'), { code: 'EIO' });
    denial(lock, () => {
      const error = captureError(() => withFileLock(lock, () => { throw primary; }));
      assert.equal(error, primary); assert.equal(error.code, 'EIO');
      assert.equal(error.lockReleaseFailure.error, 'EPERM');
      assert.equal(error.lockPath, lock); assert.equal(error.recovery.retry_operation, false);
    });
    recover(lock);
  } finally { f.cleanup(); }
});

test('migration reports failed release with the completed copy result; recovery does not recopy bytes', () => {
  const f = migrationFixture(), lock = join(f.root, '_memories/_close.lock');
  try {
    const original = fs.readFileSync(join(f.legacy, 'capability-history.jsonl'));
    denial(lock, () => {
      const error = captureError(() => applyMigration(f.options));
      assertRelease(error, lock); assert.equal(error.operationResult.status, 'migrated');
      assert.ok(error.operationResult.files > 0);
    });
    const receipt = JSON.parse(fs.readFileSync(join(f.root, '_core/codex/migrated-from.json')));
    const copied = receipt.files.find(x => x.from.endsWith('capability-history.jsonl')).to;
    assert.deepEqual(fs.readFileSync(copied), original);
    recover(lock);
    assert.equal(applyMigration(f.options).status, 'already-migrated');
    assert.deepEqual(fs.readFileSync(copied), original);
    assert.deepEqual(fs.readFileSync(join(f.legacy, 'capability-history.jsonl')), original);
  } finally { f.cleanup(); }
});

test('legacy drift reports the completed append; a later check is a no-op after explicit recovery', () => {
  const f = migrationFixture(), lock = join(f.root, '_memories/_close.lock');
  try {
    assert.equal(applyMigration(f.options).status, 'migrated');
    const receipt = JSON.parse(fs.readFileSync(join(f.root, '_core/codex/migrated-from.json')));
    const copied = receipt.files.find(x => x.from.endsWith('capability-history.jsonl')).to;
    fs.appendFileSync(join(f.legacy, 'capability-history.jsonl'), '{"row":2}\n');
    denial(lock, () => {
      const error = captureError(() => checkLegacyDrift(f.options));
      assertRelease(error, lock); assert.equal(error.operationResult.status, 'brought-in');
      assert.equal(error.operationResult.appended.length, 1);
    });
    assert.equal(fs.readFileSync(copied, 'utf8'), '{"row":1}\n{"row":2}\n');
    recover(lock); assert.equal(checkLegacyDrift(f.options).status, 'unchanged');
    assert.equal(fs.readFileSync(copied, 'utf8'), '{"row":1}\n{"row":2}\n');
  } finally { f.cleanup(); }
});

test('capability append preserves its completed row and does not repeat after release denial', () => {
  const f = sandbox(), lock = join(f.root, '_metrics/capability-history/codex.lock');
  try {
    denial(lock, () => {
      const error = captureError(() => appendRows({ root: f.root, harness: 'codex' },
        [{ capability_id: 'synthetic' }], {}, { project: f.root }));
      assertRelease(error, lock); assert.equal(error.operationResult.appended, 1);
      assert.equal(fs.readFileSync(error.operationResult.path, 'utf8').trim().split('\n').length, 1);
    });
    recover(lock);
  } finally { f.cleanup(); }
});

test('the capability release closure surfaces denial and leaves its own lock recoverable', () => {
  const f = sandbox(), lock = join(f.root, 'capability.lock');
  try {
    const release = acquireLock(lock);
    denial(lock, () => assertRelease(captureError(release), lock));
    recover(lock);
  } finally { f.cleanup(); }
});

test('reusing a capability completion closure after release denial cannot replay its material operation', () => {
  const f = sandbox(), lock = join(f.root, 'capability.lock');
  try {
    const release = acquireLock(lock); let calls = 0;
    const operation = () => ({ calls: ++calls });
    denial(lock, () => {
      const error = captureError(() => release(operation));
      assert.equal(captureError(() => release(operation)), error);
      assert.equal(calls, 1);
    });
    recover(lock);
  } finally { f.cleanup(); }
});

test('a closed diagnostic stream cannot mask the primary operation or release evidence', () => {
  const f = sandbox(), lock = join(f.root, 'test.lock');
  const write = process.stderr.write;
  try {
    const primary = new Error('primary failure');
    denial(lock, () => {
      process.stderr.write = () => { throw new Error('closed diagnostic stream'); };
      try {
        const error = captureError(() => withFileLock(lock, () => { throw primary; }));
        assert.equal(error, primary); assert.equal(error.lockReleaseFailure.error, 'EPERM');
      } finally { process.stderr.write = write; }
    });
    recover(lock);
  } finally { process.stderr.write = write; f.cleanup(); }
});

test('begin-close preserves marker-write error and surfaces failure releasing the acquired lock', () => {
  const f = sandbox(), lock = join(f.root, '_memories/_close.lock');
  try {
    const primary = Object.assign(new Error('synthetic marker-write denial'), { code: 'EIO' });
    denial(lock, () => {
      const error = captureError(() => beginClose(f.root, { sessionId: 'synthetic' }));
      assert.equal(error, primary); assert.equal(error.lockReleaseFailure.error, 'EPERM');
      assert.equal(error.lockPath, lock); assert.equal(error.recovery.retry_operation, false);
    }, primary);
    recover(lock);
  } finally { f.cleanup(); }
});

for (const mode of ['completed-copy', 'primary-error', 'nested-releases']) {
  test(`migration CLI: ${mode} preserves material and release evidence with a nonzero exit`, () => {
    const f = migrationFixture();
    try {
      const lockModule = new URL('../../plugins/core/skills/core/scripts/file-lock.mjs', import.meta.url).href;
      const preload = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
        import {useNoMachineIdentity} from ${JSON.stringify(lockModule)};useNoMachineIdentity();
        const original=fs.renameSync;fs.renameSync=(from,to)=>{
          if(${JSON.stringify(mode)}==='primary-error'&&String(to).endsWith('migrated-from.json'))
            throw Object.assign(new Error('synthetic receipt write failure'),{code:'EIO'});
          if(String(to).endsWith('.done')&&(String(from).includes('_close.lock')||
            (${JSON.stringify(mode)}==='nested-releases'&&String(from).includes('index.lock'))))
            throw Object.assign(new Error('synthetic release denial'),{code:'EPERM'});
          return original(from,to);};syncBuiltinESMExports();`;
      const table = join(f.base, 'table.json'); fs.writeFileSync(table, JSON.stringify(f.options.table));
      const script = fileURLToPath(new URL('../../plugins/core/skills/core/scripts/migrate-workspace-state.mjs', import.meta.url));
      const r = spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload),
        script, '--apply', '--root', f.root, '--harness', 'codex', '--core-dir', f.coreDir, '--table', table],
      { cwd: f.root, encoding: 'utf8' });
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stdout, /^\{/, 'the CLI must preserve structured evidence even alongside a primary error');
      const report = JSON.parse(r.stdout);
      assert.equal(report.recovery.retry_operation, false);
      assert.equal(report.release.error, 'EPERM');
      assert.ok(currentLockFile(join(f.root, '_memories/_close.lock')));
      if (mode === 'completed-copy') {
        assert.equal(report.status, 'lock-release-failed'); assert.equal(report.operation.status, 'migrated');
        const receipt = JSON.parse(fs.readFileSync(join(f.root, '_core/codex/migrated-from.json')));
        const copy = receipt.files.find(x => x.from.endsWith('capability-history.jsonl')).to;
        assert.equal(fs.readFileSync(copy, 'utf8'), '{"row":1}\n');
      } else if (mode === 'primary-error') {
        assert.equal(report.status, 'operation-failed'); assert.equal(report.error.code, 'EIO');
      } else {
        assert.equal(report.status, 'lock-release-failed');
        assert.ok(report.additional_lock_releases.some(x => x.lockPath.endsWith('_close.lock')));
        assert.ok(report.lock_path.endsWith('index.lock'), 'the registry lock is the inner lock; no account-wide manifest lock is taken');
      }
    } finally { f.cleanup(); }
  });
}
