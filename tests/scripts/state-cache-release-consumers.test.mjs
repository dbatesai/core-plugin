import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const scripts = fileURLToPath(new URL('../../plugins/core/skills/core/scripts/', import.meta.url));

function fixture() {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'stamp-release-consumer-')));
  const root = join(base, 'project'), home = join(base, 'home');
  fs.mkdirSync(join(root, '_memories', '_lib'), { recursive: true });
  fs.mkdirSync(home);
  fs.writeFileSync(join(root, 'PROJECT.md'), '# Project\n\n## What & Why\n\nPurpose.\n');
  const preload = join(base, 'faults.mjs');
  fs.writeFileSync(preload, `
    import fs from 'node:fs'; import os from 'node:os';
    import { syncBuiltinESMExports } from 'node:module';
    os.userInfo = () => ({ homedir: ${JSON.stringify(home)} });
    os.homedir = () => ${JSON.stringify(home)};
    const rename = fs.renameSync, read = fs.readFileSync;
    fs.renameSync = (a, b) => {
      if (process.env.STAMP_RELEASE_DENIED === '1' && String(a).includes('.state-cache.lock.g') && String(b).endsWith('.done'))
        throw Object.assign(new Error('synthetic release denial'), { code: 'EPERM' });
      if (process.env.STAMP_WRITE_DENIED === '1' && String(b) === ${JSON.stringify(join(root, '_memories', '_lib', 'state-cache.json'))})
        throw Object.assign(new Error('synthetic write failure'), { code: 'EIO' });
      return rename(a, b);
    };
    fs.readFileSync = (p, ...args) => {
      if (process.env.STAMP_READ_DENIED === '1' && String(p) === ${JSON.stringify(join(root, '_memories', '_lib', 'state-cache.json'))})
        throw Object.assign(new Error('synthetic cache read denial'), { code: 'EACCES' });
      return read(p, ...args);
    };
    syncBuiltinESMExports();
  `);
  return { base, root, home, preload, cache: join(root, '_memories', '_lib', 'state-cache.json') };
}

function child(f, args, extra = {}) {
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(f.preload).href, ...args], {
    cwd: f.root, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, NODE_OPTIONS: '', CORE_HOOKS_LOG_FILE: '/dev/null', CORE_METRICS_DISABLED: '1', ...extra },
  });
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.error, undefined);
  return result;
}

function api(f, body, extra) {
  const result = child(f, ['--input-type=module', '-e', body], extra);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function stamp(f, extra) {
  return api(f, `const {stampFiles} = await import(${JSON.stringify(pathToFileURL(join(scripts, 'state-cache.mjs')).href)});
    console.log(JSON.stringify(stampFiles(${JSON.stringify(f.root)}, [{path:${JSON.stringify(join(f.root, 'PROJECT.md'))},hash:'new-hash',lastWrittenBy:'test'}])));`, extra);
}

function prepareHot(f, clear = false) {
  api(f, `const {recordProjectMdWrite,applyHotSection} = await import(${JSON.stringify(pathToFileURL(join(scripts, 'hot-section.mjs')).href)});
    recordProjectMdWrite(${JSON.stringify(join(f.root, 'PROJECT.md'))});
    ${clear ? `applyHotSection(${JSON.stringify(f.root)},'Old hot text.');` : ''}
    console.log('{}');`);
}

function assertRelease(outcome, f) {
  assert.equal(outcome.recovery, 'recovery-required');
  assert.equal(outcome.lockReleaseFailures.length, 1);
  assert.equal(outcome.lockReleaseFailures[0].lockPath, join(f.root, '_memories', '_lib', '.state-cache.lock'));
  assert.equal(outcome.lockReleaseFailures[0].releaseResult.released, false);
  assert.equal(outcome.lockRecovery.retry_operation, false);
  assert.match(outcome.lockRecovery.instruction, /Do not repeat/);
  assert.ok(fs.readdirSync(join(f.root, '_memories', '_lib')).some(p => p.startsWith('.state-cache.lock.g') && !p.endsWith('.done')));
}

test('successful stamp and failed release retain completion and name held lock', () => {
  const f = fixture();
  try {
    const outcome = stamp(f, { STAMP_RELEASE_DENIED: '1' });
    assert.equal(outcome.stamped, true);
    assert.equal(JSON.parse(fs.readFileSync(f.cache)).files[join(f.root, 'PROJECT.md')].last_hash, 'new-hash');
    assertRelease(outcome, f);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('unreadable cache refusal and failed release retain original reason and bytes', () => {
  const f = fixture();
  try {
    const before = '{"files":{"old":{"last_hash":"keep"}}}'; fs.writeFileSync(f.cache, before);
    const outcome = stamp(f, { STAMP_RELEASE_DENIED: '1', STAMP_READ_DENIED: '1' });
    assert.equal(outcome.stamped, false);
    assert.equal(outcome.outcome, 'refused');
    assert.match(outcome.reason, /cache-unreadable.*EACCES/);
    assert.equal(fs.readFileSync(f.cache, 'utf8'), before);
    assertRelease(outcome, f);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('primary write error and failed release retain primary error, cleanup, and old cache', () => {
  const f = fixture();
  try {
    const before = '{"files":{"old":{"last_hash":"keep"}}}'; fs.writeFileSync(f.cache, before);
    const outcome = stamp(f, { STAMP_RELEASE_DENIED: '1', STAMP_WRITE_DENIED: '1' });
    assert.equal(outcome.stamped, false);
    assert.equal(outcome.reason, 'EIO');
    assert.equal(outcome.primaryError.code, 'EIO');
    assert.equal(fs.readFileSync(f.cache, 'utf8'), before);
    assertRelease(outcome, f);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('healthy stamp retains simple success with no cleanup failure', () => {
  const f = fixture();
  try { assert.deepEqual(stamp(f), { stamped: true }); }
  finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('quarantined corrupt cache receipt survives failed release after completed stamp', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.cache, '{broken');
    const outcome = stamp(f, { STAMP_RELEASE_DENIED: '1' });
    assert.equal(outcome.stamped, true);
    assert.equal(outcome.outcome, 'prior-attribution-unknown');
    assert.equal(fs.readFileSync(outcome.quarantined, 'utf8'), '{broken');
    assertRelease(outcome, f);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('quarantine survives primary write failure plus failed cleanup without claiming stamp success', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.cache, '{broken');
    const outcome = stamp(f, { STAMP_RELEASE_DENIED: '1', STAMP_WRITE_DENIED: '1' });
    assert.equal(outcome.stamped, false);
    assert.equal(outcome.reason, 'EIO');
    assert.equal(fs.readFileSync(outcome.quarantined, 'utf8'), '{broken');
    assertRelease(outcome, f);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

for (const command of ['apply', 'clear']) {
  test(`actual hot-section CLI ${command} reports landed stamp plus failed cleanup, nonzero`, () => {
    const f = fixture();
    try {
      prepareHot(f, command === 'clear');
      const args = [join(scripts, 'hot-section.mjs'), command, f.root];
      if (command === 'apply') args.push('--text', 'New hot text.');
      const result = child(f, args, { STAMP_RELEASE_DENIED: '1' });
      assert.equal(result.status, 1, result.stderr);
      const receipt = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('{')));
      assert.equal(receipt.content_write, 'ok');
      assert.equal(receipt.attribution_stamp, 'ok');
      assertRelease(receipt.stampOutcome, f);
      assert.match(result.stderr, /stamp landed.*lock cleanup failed/i);
      assert.doesNotMatch(result.stderr, /reconcile\/re-stamp is owed|authorship stamp failed/);
      const bytes = fs.readFileSync(join(f.root, 'PROJECT.md'), 'utf8');
      if (command === 'apply') assert.match(bytes, /New hot text/);
      else assert.doesNotMatch(bytes, /Old hot text/);
    } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
  });
}

test('decorate API and actual CLI preserve landed attribution and require lock recovery', () => {
  for (const cli of [false, true]) {
    const f = fixture();
    try {
      fs.writeFileSync(join(f.root, '_memories', 'a.md'), '---\nid: a\ntype: decision\nstatus: active\nedges:\n  - type: cites\n    target: b\n---\n\n# A\n\nBody.\n');
      fs.writeFileSync(join(f.root, '_memories', 'b.md'), '---\nid: b\ntype: decision\nstatus: active\n---\n\n# B\n');
      api(f, `const {stampCreatedBaseline}=await import(${JSON.stringify(pathToFileURL(join(scripts, 'lifecycle-detect.mjs')).href)});
        stampCreatedBaseline(${JSON.stringify(f.root)},${JSON.stringify(join(f.root, '_memories', 'a.md'))},{kind:'unit'}); console.log('{}');`);
      let outcome;
      if (cli) {
        const result = child(f, [join(scripts, 'decorate-graph.mjs'), f.root], { STAMP_RELEASE_DENIED: '1' });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /stamp landed.*lock cleanup failed/i);
        assert.doesNotMatch(result.stderr, /authorship stamp failed/);
        assert.match(fs.readFileSync(join(f.root, '_memories', 'a.md'), 'utf8'), /\[\[b\]\]/);
        continue;
      } else {
        outcome = api(f, `const {decorateStore}=await import(${JSON.stringify(pathToFileURL(join(scripts, 'decorate-graph.mjs')).href)});
          console.log(JSON.stringify(decorateStore(${JSON.stringify(f.root)})));`, { STAMP_RELEASE_DENIED: '1' }).attribution;
      }
      assert.equal(outcome.stamped, true);
      assertRelease(outcome, f);
      assert.match(fs.readFileSync(join(f.root, '_memories', 'a.md'), 'utf8'), /\[\[b\]\]/);
    } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
  }
});

test('maintenance API and actual CLI retain index attribution and cleanup diagnostics', () => {
  for (const cli of [false, true]) {
    const f = fixture();
    try {
      let report;
      if (cli) {
        const result = child(f, [join(scripts, 'maintenance-run.mjs'), f.root, '--json'], { STAMP_RELEASE_DENIED: '1' });
        assert.equal(result.status, 1, result.stderr);
        report = JSON.parse(result.stdout);
      } else {
        report = api(f, `const {runMaintenance}=await import(${JSON.stringify(pathToFileURL(join(scripts, 'maintenance-run.mjs')).href)});
          console.log(JSON.stringify(runMaintenance(${JSON.stringify(f.root)},{metrics:false})));`, { STAMP_RELEASE_DENIED: '1' });
      }
      assert.equal(report.attribution.stamped, true);
      assertRelease(report.attribution, f);
      assert.match(report.narration, /stamp landed.*lock cleanup failed/i);
      assert.doesNotMatch(report.narration, /attribution stamp failed/);
      assert.ok(fs.existsSync(join(f.root, '_memories', 'INDEX-decisions.md')));
    } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
  }
});

test('actual project-only process-memory CLI preserves maintenance cleanup and exits nonzero', () => {
  const f = fixture();
  try {
    const result = child(f, [join(scripts, 'project-only.mjs'), 'process-memory', '--root', f.root, '--harness', 'codex', '--apply'], { STAMP_RELEASE_DENIED: '1' });
    const report = JSON.parse(result.stdout);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(report.status, 'refused');
    assert.equal(report.state, 'recovery-required');
    assert.equal(report.upkeep.attribution.stamped, true);
    assertRelease(report.upkeep.attribution, f);
    assert.ok(fs.existsSync(join(f.root, '_memories', 'INDEX-decisions.md')));
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('actual creation-baseline CLI retains landed stamp and cleanup receipt, nonzero', () => {
  const f = fixture();
  try {
    const result = child(f, [join(scripts, 'lifecycle-detect.mjs'), f.root, '--stamp-created', 'PROJECT.md', '--kind', 'project', '--json'], { STAMP_RELEASE_DENIED: '1' });
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.stamped, true);
    assertRelease(report.stampOutcome, f);
    assert.match(result.stderr, /stamp landed.*lock cleanup failed/i);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('actual adoption JSON CLI counts landed stamp and retains per-file cleanup, nonzero', () => {
  const f = fixture();
  try {
    const result = child(f, [join(scripts, 'lifecycle-detect.mjs'), f.root, '--adopt-existing-store', '--apply', '--json'], { STAMP_RELEASE_DENIED: '1' });
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.stamped_count, 1);
    assert.equal(report.failed.length, 0);
    assert.equal(report.stamp_outcomes[0].stamped, true);
    assertRelease(report.stamp_outcomes[0], f);
    assert.match(result.stderr, /stamp landed.*lock cleanup failed/i);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('actual adoption JSON CLI exposes a primary stamp failure and exits nonzero', () => {
  const f = fixture();
  try {
    const result = child(f, [join(scripts, 'lifecycle-detect.mjs'), f.root, '--adopt-existing-store', '--apply', '--json'], { STAMP_WRITE_DENIED: '1' });
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.stamped_count, 0);
    assert.equal(report.failed.length, 1);
    assert.equal(report.stamp_outcomes[0].stamped, false);
    assert.equal(report.stamp_outcomes[0].primaryError.code, 'EIO');
    assert.equal(fs.readFileSync(join(f.root, 'PROJECT.md'), 'utf8'), '# Project\n\n## What & Why\n\nPurpose.\n');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

for (const json of [false, true]) test(`adoption refusal preserves an unknown baseline and is nonzero (${json ? 'JSON' : 'text'})`, () => {
  const f = fixture();
  try {
    const before = '{damaged baseline'; fs.writeFileSync(f.cache, before);
    const result = child(f, [join(scripts, 'lifecycle-detect.mjs'), f.root, '--adopt-existing-store', '--apply', ...(json ? ['--json'] : [])]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /adoption refused/);
    assert.doesNotMatch(result.stdout, /nothing to adopt|DRY RUN/);
    if (json) assert.equal(JSON.parse(result.stdout).refused_reason, 'baseline-not-absent');
    assert.equal(fs.readFileSync(f.cache, 'utf8'), before);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});
