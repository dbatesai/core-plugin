// Read paths never create this install's identity: looking at a project's state, with no
// install-secret or install-id on the machine, must leave the core folder exactly as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  classifyStamp, readSignedFile, readSignedFileAt, readInstallIdentity, adoptionCandidate,
  writeStamp, writeSignedFile,
} from '../../plugins/core/skills/core/scripts/project-state.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mint-')));
  const root = join(base, 'proj'); mkdirSync(root);
  const coreA = join(base, 'coreA'); mkdirSync(coreA);
  const coreB = join(base, 'coreB'); mkdirSync(coreB);   // a machine with no identity yet
  return { base, root, coreA, coreB, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('readInstallIdentity never creates: absent → null, present → the same values the writer made', () => {
  const s = setup();
  try {
    assert.equal(readInstallIdentity({ coreDir: s.coreB }), null);
    assert.deepEqual(readdirSync(s.coreB), []);
    const stamp = writeStamp({ root: s.root, harness: 'claude-code', coreDir: s.coreA });
    assert.equal(readInstallIdentity({ coreDir: s.coreA }).installId, stamp.install_id);
    writeFileSync(join(s.coreB, 'install-secret'), 'not hex\n'); writeFileSync(join(s.coreB, 'install-id'), 'x\n');
    assert.equal(readInstallIdentity({ coreDir: s.coreB }), null, 'a malformed secret is no identity');
  } finally { s.cleanup(); }
});

test('classifying, reading signed files and checking for adoption mint nothing on a machine with no identity', () => {
  const s = setup();
  try {
    // Install A stamps the project and signs a manifest; then the folder is looked at from machine B.
    writeStamp({ root: s.root, harness: 'claude-code', coreDir: s.coreA });
    const dir = join(s.root, '.core', 'claude-code');
    writeSignedFile({ dir, name: 'workspace.json', body: '{"agent_name":"A"}\n', coreDir: s.coreA });
    assert.equal(classifyStamp({ root: s.root, harness: 'claude-code', coreDir: s.coreA }).status, 'verified', 'control: its own install verifies it');

    assert.equal(classifyStamp({ root: s.root, harness: 'claude-code', coreDir: s.coreB }).status, 'foreign-install');
    assert.equal(readSignedFile({ root: s.root, harness: 'claude-code', name: 'workspace.json', coreDir: s.coreB }), null);
    assert.equal(readSignedFileAt({ dir, name: 'workspace.json', coreDir: s.coreA }), '{"agent_name":"A"}\n', 'control: its own install reads it');
    assert.equal(readSignedFileAt({ dir, name: 'workspace.json', coreDir: s.coreB }), null);
    adoptionCandidate({ root: s.root, harness: 'claude-code', coreDir: s.coreB });
    assert.equal(existsSync(join(s.coreB, 'install-secret')), false, 'no secret was created by reading');
    assert.equal(existsSync(join(s.coreB, 'install-id')), false, 'no id was created by reading');

    // Control: a write on machine B is what creates its identity.
    const other = join(s.base, 'proj2'); mkdirSync(other);
    writeStamp({ root: other, harness: 'claude-code', coreDir: s.coreB });
    assert.ok(existsSync(join(s.coreB, 'install-secret')) && existsSync(join(s.coreB, 'install-id')));
  } finally { s.cleanup(); }
});

test('readInstallIdentity is null for a malformed id, a missing file of either kind, and (not as root) an unreadable one; the writer refuses the same malformed id', async () => {
  const { ensureInstallIdentity } = await import('../../plugins/core/skills/core/scripts/project-state.mjs');
  const { chmodSync } = await import('node:fs');
  const s = setup();
  try {
    const good = 'a'.repeat(64) + '\n';
    const put = (secret, id) => { rmSync(s.coreB, { recursive: true, force: true }); mkdirSync(s.coreB); if (secret !== null) writeFileSync(join(s.coreB, 'install-secret'), secret); if (id !== null) writeFileSync(join(s.coreB, 'install-id'), id); };
    put(good, 'abc123\n'); assert.equal(readInstallIdentity({ coreDir: s.coreB }).installId, 'abc123', 'control: a well-formed pair reads');
    for (const [label, id] of [['empty', '\n'], ['two tokens', 'abc def\n'], ['two lines', 'abc\ndef\n'], ['a path', '../x\n'], ['too long', 'a'.repeat(129) + '\n']]) {
      put(good, id);
      assert.equal(readInstallIdentity({ coreDir: s.coreB }), null, `malformed id (${label}) is no identity`);
      assert.throws(() => ensureInstallIdentity({ coreDir: s.coreB }), /install-id is malformed/, `the writer refuses it too (${label})`);
    }
    put(good, null); assert.equal(readInstallIdentity({ coreDir: s.coreB }), null, 'secret without id');
    put(null, 'abc123\n'); assert.equal(readInstallIdentity({ coreDir: s.coreB }), null, 'id without secret');
    assert.equal(existsSync(join(s.coreB, 'install-secret')), false, 'and the missing half was not created');
    // A file that can't be read on any platform or uid: the name is a directory.
    put(good, null); mkdirSync(join(s.coreB, 'install-id'));
    assert.equal(readInstallIdentity({ coreDir: s.coreB }), null, 'unreadable id (a directory) is no identity');
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      put(good, 'abc123\n'); chmodSync(join(s.coreB, 'install-secret'), 0o000);
      try { assert.equal(readInstallIdentity({ coreDir: s.coreB }), null, 'unreadable secret (mode 000) is no identity'); }
      finally { chmodSync(join(s.coreB, 'install-secret'), 0o600); }
    }
  } finally { s.cleanup(); }
});

test('the metrics gate answers OFF, never throws, when the project list is malformed or cannot be read (any uid), says so once on stderr, and keeps the explicit opt-in', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'gate-')));
  try {
    const home = join(base, 'home'); const proj = join(base, 'proj');
    mkdirSync(join(home, '.core'), { recursive: true }); mkdirSync(proj);
    const probe = (setupCode) => spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
      const list = ${JSON.stringify(join(home, '.core', 'projects.json'))};
      rmSync(list, { recursive: true, force: true });
      ${setupCode}
      const m = await import(${JSON.stringify(pathToFileURL(join(REPO, 'plugins/core/skills/core/scripts/log-event.mjs')).href)});
      const a = m.metricsEnabled({ project: ${JSON.stringify(proj)}, home: ${JSON.stringify(home)}, env: {} });
      const b = m.metricsEnabled({ project: ${JSON.stringify(proj)}, home: ${JSON.stringify(home)}, env: {} });
      const c = m.metricsEnabled({ project: ${JSON.stringify(proj)}, home: ${JSON.stringify(home)}, env: { CORE_METRICS_ENABLED: '1' } });
      process.stdout.write(JSON.stringify({ a, b, c, why: m.metricsGateFailure }));
    `], { encoding: 'utf8' });
    const ok = probe(`writeFileSync(list, '{"projects":[]}');`);
    assert.deepEqual(JSON.parse(ok.stdout), { a: true, b: true, c: true, why: null }, 'control: a readable list keeps the default');
    assert.equal(ok.stderr, '');
    for (const [label, code, why] of [['malformed JSON', `writeFileSync(list, '{not json');`, 'SyntaxError'], ['a directory where the list should be', `mkdirSync(list);`, 'EISDIR']]) {
      const r = probe(code);
      assert.equal(r.status, 0, `${label}: ${r.stderr}`);
      assert.deepEqual(JSON.parse(r.stdout), { a: false, b: false, c: true, why }, label);
      assert.equal(r.stderr.split('\n').filter((l) => l.startsWith('CORE metrics gate:')).length, 1, `${label}: said once, not per call`);
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('the metrics gate also answers OFF on a project list it has no permission to read', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const { metricsEnabled } = await import('../../plugins/core/skills/core/scripts/log-event.mjs');
  const { chmodSync } = await import('node:fs');
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'gate-')));
  try {
    const home = join(base, 'home'); const proj = join(base, 'proj');
    mkdirSync(join(home, '.core'), { recursive: true }); mkdirSync(proj);
    const list = join(home, '.core', 'projects.json');
    writeFileSync(list, '{"projects":[]}'); chmodSync(list, 0o000);
    try { assert.equal(metricsEnabled({ project: proj, home, env: {} }), false); } finally { chmodSync(list, 0o644); }
  } finally { rmSync(base, { recursive: true, force: true }); }
});
