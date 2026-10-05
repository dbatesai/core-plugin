import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { useNoMachineIdentity } from '../../plugins/core/skills/core/scripts/file-lock.mjs';
import { updateManifest, stateDir, localStateDir, writeSignedFile } from '../../plugins/core/skills/core/scripts/project-state.mjs';
import * as metrics from '../../plugins/core/skills/core/scripts/log-event.mjs';
import * as capture from '../../plugins/core/skills/core/scripts/turn-capture.mjs';

// Every path and installation identity in these controls is synthetic.
useNoMachineIdentity();
function fixture(fields, registered = true) {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'capture-gate-read-')));
  const root = join(base, 'project'), home = join(base, 'home'), coreDir = join(home, '.core');
  fs.mkdirSync(root); fs.mkdirSync(coreDir, { recursive: true });
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  fs.writeFileSync(join(coreDir, 'projects.json'), JSON.stringify(registered ? [{ path: root }] : []));
  if (fields && registered) updateManifest({ root, harness: 'codex', coreDir, fields });
  if (fields && !registered) {
    const dir = localStateDir({root, harness:'codex', coreDir});
    fs.mkdirSync(dir, {recursive:true});
    writeSignedFile({dir, name:'workspace.json', body:JSON.stringify(fields), coreDir});
  }
  const dir = fields ? stateDir({ root, harness: 'codex', coreDir }).dir : join(root, '.core/codex');
  return { base, root, home, manifest: join(dir, 'workspace.json'),
    options: { project: root, home, env: { CORE_HARNESS: 'codex' } } };
}
function snapshot(dir) {
  return fs.readdirSync(dir).sort().flatMap(n => {
    const p = join(dir, n);
    return fs.statSync(p).isDirectory() ? snapshot(p) : [[p, fs.readFileSync(p).toString('base64')]];
  });
}
function denied(file, fn, code = 'EACCES') {
  const original = fs.readFileSync;
  let attempts = 0;
  fs.readFileSync = (p, ...args) => {
    if (String(p) === file) { attempts++; throw Object.assign(new Error('synthetic read denial'), { code }); }
    return original(p, ...args);
  };
  syncBuiltinESMExports();
  try { fn(); assert.ok(attempts > 0, 'the intended reader was exercised'); }
  finally { fs.readFileSync = original; syncBuiltinESMExports(); }
}

for (const code of ['EACCES', 'EIO']) {
  for (const [name, gate, fields, env] of [
    ['metrics', metrics.metricsEnabled, { metrics_enabled: false }, {}],
    ['turn capture', capture.turnCaptureEnabled, { metrics_enabled: true, turn_capture: false }, {}],
    ['turn capture with aggregate opt-in', capture.turnCaptureEnabled,
      { turn_capture: false }, { CORE_METRICS_ENABLED: '1' }],
  ]) test(`${name}: unreadable signed opt-out stays OFF (${code}), then recovers`, () => {
    const f = fixture(fields);
    try {
      const opt = { ...f.options, env: { ...f.options.env, ...env } };
      const before = snapshot(f.base);
      assert.equal(gate(opt), false);
      denied(f.manifest, () => {
        assert.equal(gate(opt), false);
        assert.equal((name === 'turn capture with aggregate opt-in'
          ? capture.turnCaptureGateFailure : metrics.metricsGateFailure), code);
      }, code);
      assert.equal(gate(opt), false);
      assert.deepEqual(snapshot(f.base), before, 'a gate read never creates or remints state');
    } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
  });
}

test('absent state remains default ON and creates no installation identity', () => {
  const f = fixture();
  try {
    const before = snapshot(f.base);
    assert.equal(metrics.metricsEnabled(f.options), true);
    assert.equal(capture.turnCaptureEnabled(f.options), true);
    assert.deepEqual(snapshot(f.base), before);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

for (const suffix of ['', '.mac']) test(`local fallback manifest${suffix}: unreadable is OFF and read creates no state`, () => {
  const f = fixture({ metrics_enabled: false, turn_capture: false }, false);
  try {
    assert.ok(f.manifest.startsWith(join(f.home, '.core/local')));
    const before = snapshot(f.base);
    assert.equal(metrics.metricsEnabled(f.options), false);
    denied(f.manifest + suffix, () => {
      assert.equal(metrics.metricsEnabled(f.options), false);
      assert.equal(capture.turnCaptureEnabled({ ...f.options,
        env: { ...f.options.env, CORE_METRICS_ENABLED: '1' } }), false);
    });
    assert.deepEqual(snapshot(f.base), before);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('updating an unreadable manifest preserves its bytes and project identity', () => {
  const f = fixture({ metrics_enabled: false });
  try {
    const body = fs.readFileSync(f.manifest), mac = fs.readFileSync(f.manifest + '.mac');
    denied(f.manifest, () => assert.throws(() => updateManifest({ root: f.root,
      harness: 'codex', coreDir: join(f.home, '.core'), fields: { agent_name: 'test' } }), { code: 'EACCES' }));
    assert.deepEqual(fs.readFileSync(f.manifest), body);
    assert.deepEqual(fs.readFileSync(f.manifest + '.mac'), mac);
    assert.equal(fs.readdirSync(join(f.root, '.core/codex')).some(n => n.includes('.unverified-')), false);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('readable untrusted opt-outs survive; malformed readable data retains its existing default', () => {
  const f = fixture({ metrics_enabled: true });
  try {
    // Replacing signed bytes without a stamp makes this readable but untrusted.
    fs.writeFileSync(f.manifest, JSON.stringify({ metrics_enabled: false, turn_capture: false }));
    const before = snapshot(f.base);
    assert.equal(metrics.metricsEnabled(f.options), false);
    assert.equal(capture.turnCaptureEnabled({ ...f.options,
      env: { ...f.options.env, CORE_METRICS_ENABLED: '1' } }), false);
    assert.deepEqual(snapshot(f.base), before);
    fs.writeFileSync(f.manifest, '{malformed');
    assert.equal(metrics.metricsEnabled(f.options), true);
    assert.equal(capture.turnCaptureEnabled(f.options), true);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

for (const [name, gate, env] of [
  ['metrics', metrics.metricsEnabled, {}],
  ['turn capture', capture.turnCaptureEnabled, { CORE_METRICS_ENABLED: '1' }],
]) test(`${name}: an unreadable legacy root manifest is OFF, an absent one stays ON`, () => {
  const f = fixture();
  try {
    const opt = { ...f.options, env: { ...f.options.env, ...env } };
    const file = join(f.root, 'workspace.json');
    assert.equal(gate(opt), true);
    fs.writeFileSync(file, JSON.stringify({ metrics_enabled: false, turn_capture: false }));
    const before = snapshot(f.base);
    denied(file, () => assert.equal(gate(opt), false));
    assert.equal(gate(opt), false);
    assert.deepEqual(snapshot(f.base), before);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('explicit environment precedence is unchanged under manifest read denial', () => {
  const f = fixture({ metrics_enabled: false, turn_capture: false });
  try {
    // Opt-ins intentionally precede manifest reads, so do not require the denial seam to run.
    const original = fs.readFileSync;
    fs.readFileSync = (p, ...args) => {
      if (String(p) === f.manifest) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return original(p, ...args);
    };
    syncBuiltinESMExports();
    try {
      const env = { CORE_HARNESS: 'codex', CORE_METRICS_ENABLED: '1', CORE_TURN_CAPTURE: '1' };
      assert.equal(metrics.metricsEnabled({ ...f.options, env }), true);
      assert.equal(capture.turnCaptureEnabled({ ...f.options, env }), true);
      assert.equal(capture.turnCaptureEnabled({ ...f.options,
        env: { ...env, CORE_METRICS_ENABLED: '0' } }), false);
      assert.equal(capture.turnCaptureEnabled({ ...f.options,
        env: { ...env, CORE_TURN_CAPTURE: '0' } }), false);
    } finally { fs.readFileSync = original; syncBuiltinESMExports(); }
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});
