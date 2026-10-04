// Project-only mode: CORE run from one folder. Every check runs the real entry point in a child
// process under the attempted-access gate, with the project and this repo (the code) as the only
// roots, so a touch of ~/.core, the OS temp dir or another folder is refused and recorded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { assertHarnessName } from '../../plugins/core/skills/core/scripts/project-state.mjs';
import { readPendingManifest, projectOnlyContext, PROJECT_ONLY_DIR } from '../../plugins/core/skills/core/scripts/project-only.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CORE = join(REPO, 'plugins/core/skills/core');
const GATE = pathToFileURL(join(REPO, 'tests/scripts/fs-confine.mjs')).href;
const isWin = process.platform === 'win32';
const isRoot = process.getuid?.() === 0;

function project({ withUnits = true } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'project-only-')));
  const root = join(base, 'proj');
  mkdirSync(root);
  if (withUnits) {
    mkdirSync(join(root, '_memories'));
    writeFileSync(join(root, '_memories', 'dc-1-widgets.md'), '---\nid: dc-1-widgets\ntype: decision\nstatus: active\n---\nWidgets are blue.\n');
    writeFileSync(join(root, 'PROJECT.md'), '# P\n');
  }
  return { base, root, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
// Runs a node entry confined to the project + code. Returns status, stdout, stderr and violations.
function confined(root, args, { input = '', env = {} } = {}) {
  const r = spawnSync(process.execPath, ['--import', GATE, ...args], {
    input, encoding: 'utf8', cwd: root,
    env: { ...process.env, FS_CONFINE_ROOTS: [root, REPO].join(delimiter), ...env },
  });
  const m = r.stderr.match(/FS_CONFINE_VIOLATIONS (.*)/);
  return { ...r, violations: m ? JSON.parse(m[1]) : null };
}
const tree = (dir) => {
  const out = {};
  const walk = (d) => { for (const n of readdirSync(d, { withFileTypes: true })) { const p = join(d, n.name); if (n.isDirectory()) walk(p); else out[p] = createHash('sha256').update(readFileSync(p)).digest('hex'); } };
  if (existsSync(dir)) walk(dir);
  return out;
};

test('startup on a fresh folder touches nothing outside it, writes .gitignore first, and never creates .core/<harness>/', () => {
  const p = project();
  try {
    const r = confined(p.root, [join(CORE, 'scripts/project-only.mjs'), 'startup', '--root', p.root, '--harness', 'claude-code', '--session', 's1']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.violations, []);
    const out = JSON.parse(r.stdout);
    assert.deepEqual([out.status, out.mode, out.automatic, out.capture], ['ok', 'project-only', 'off', 'default']);
    assert.equal(readFileSync(join(p.root, '.core', '.gitignore'), 'utf8'), '*\n');
    assert.ok(existsSync(join(p.root, '.core', PROJECT_ONLY_DIR, 'claude-code', 'bootstrap.json')));
    assert.equal(existsSync(join(p.root, '.core', 'claude-code')), false, 'the signed harness envelope is never created');
  } finally { p.cleanup(); }
});

test('existing harness state stays byte-identical through project-only startup', () => {
  const p = project();
  try {
    const h = join(p.root, '.core', 'claude-code');
    mkdirSync(h, { recursive: true });
    writeFileSync(join(h, 'stamp'), 'signed-stamp\n'); writeFileSync(join(h, 'workspace.json'), '{"agent_name":"Plover"}\n'); writeFileSync(join(p.root, '.core', '.gitignore'), '*\n!keep\n');
    const before = tree(h);
    const r = confined(p.root, [join(CORE, 'scripts/project-only.mjs'), 'startup', '--root', p.root]);
    assert.deepEqual(r.violations, []);
    assert.deepEqual(tree(h), before);
    assert.equal(readFileSync(join(p.root, '.core', '.gitignore'), 'utf8'), '*\n!keep\n', "the user's own ignore rules are kept");
  } finally { p.cleanup(); }
});

test('the pending folder can never be read as a harness folder', () => {
  assert.throws(() => assertHarnessName(PROJECT_ONLY_DIR));
});

test('automatic hooks in a project-only folder touch nothing outside it; SessionStart says why', () => {
  const p = project();
  try {
    mkdirSync(join(p.root, '.core', PROJECT_ONLY_DIR, 'claude-code'), { recursive: true });
    const payload = (extra) => JSON.stringify({ cwd: p.root, session_id: 's1', ...extra });
    const start = confined(p.root, [join(CORE, 'hooks/session-start-hook.mjs')], { input: payload({}) });
    assert.deepEqual(start.violations, []);
    assert.match(start.stdout, /project-only mode/);
    assert.doesNotMatch(start.stdout, /invoke the `\/core` skill/);
    for (const [hook, input] of [
      ['hooks/retrieve-context-hook.mjs', payload({ prompt: 'what colour are widgets' })],
      ['hooks/retrieve-context-hook-codex.mjs', payload({ prompt: 'what colour are widgets' })],
      ['hooks/close-pass-hook.mjs', payload({ reason: 'exit' })],
    ]) {
      const r = confined(p.root, [join(CORE, hook)], { input });
      assert.equal(r.status, 0, `${hook}: ${r.stderr}`);
      assert.deepEqual(r.violations, [], hook);
      assert.equal(r.stdout.trim(), '', `${hook} injects nothing`);
    }
  } finally { p.cleanup(); }
});

test('control: without the project-only folder the same hooks do reach outside, so the gate is seeing them', () => {
  const p = project();
  try {
    const r = confined(p.root, [join(CORE, 'hooks/retrieve-context-hook.mjs')], { input: JSON.stringify({ cwd: p.root, prompt: 'widgets' }) });
    assert.ok(r.violations.length > 0, 'the installed-mode path is outside-dependent');
  } finally { p.cleanup(); }
});

test('explicit retrieval works from the folder alone', () => {
  const p = project();
  try {
    const r = confined(p.root, [join(CORE, 'scripts/retrieve-context.mjs'), p.root, 'what colour are widgets']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /dc-1-widgets/);
    assert.deepEqual(r.violations, []);
  } finally { p.cleanup(); }
});

test('capture status reads only the folder and calls outside history unknown; deferred and unknown commands refuse first', () => {
  const p = project();
  try {
    mkdirSync(join(p.root, '_metrics', 'turn-capture'), { recursive: true });
    writeFileSync(join(p.root, '_metrics', 'turn-capture', '2026-10-04.jsonl'), '{"a":1}\n{"a":2}\n');
    const s = confined(p.root, [join(CORE, 'scripts/project-only.mjs'), 'capture-status', '--root', p.root]);
    assert.deepEqual(s.violations, []);
    const out = JSON.parse(s.stdout);
    assert.deepEqual([out.in_project.rows, out.outside_history], [2, 'unknown']);
    for (const [cmd, want] of [['purge', 'unavailable'], ['retention', 'unavailable'], ['finalize', 'unavailable'], ['register', 'refused']]) {
      const r = confined(p.root, [join(CORE, 'scripts/project-only.mjs'), cmd, '--root', p.root]);
      assert.equal(JSON.parse(r.stdout).status, want, cmd);
      assert.deepEqual(r.violations, [], cmd);
      assert.equal(r.status, 2);
    }
  } finally { p.cleanup(); }
});

test('the root must resolve to a real directory, and never the home or a filesystem root', () => {
  const p = project();
  try {
    assert.equal(projectOnlyContext({ root: join(p.base, 'missing') }).state, 'root-unresolved');
    assert.equal(projectOnlyContext({ root: '/' }).state, 'refused');
    assert.equal(projectOnlyContext({ root: p.root, harness: '../x' }).state, 'bad-harness');
    assert.equal(projectOnlyContext({ root: p.root }).root, p.root);
  } finally { p.cleanup(); }
});

test('only restrictions in the unverified manifest take effect; an unreadable one holds capture', { skip: isWin || isRoot ? 'chmod denial needs POSIX non-root' : false }, () => {
  const p = project();
  try {
    const ctx = projectOnlyContext({ root: p.root });
    const dir = join(p.root, '.core', PROJECT_ONLY_DIR, 'claude-code');
    mkdirSync(dir, { recursive: true });
    const m = join(dir, 'manifest.json');
    assert.equal(readPendingManifest(ctx).capture, 'default');
    writeFileSync(m, JSON.stringify({ agent_name: 'Wren', turn_capture: false })); assert.deepEqual([readPendingManifest(ctx).capture, readPendingManifest(ctx).agent_name], ['disabled', 'Wren']);
    writeFileSync(m, JSON.stringify({ metrics_enabled: true, turn_capture: true })); assert.equal(readPendingManifest(ctx).capture, 'default', 'a true never widens');
    writeFileSync(m, '{not json'); assert.equal(readPendingManifest(ctx).capture, 'held');
    writeFileSync(m, '{}'); chmodSync(m, 0o000);
    try { assert.equal(readPendingManifest(ctx).capture, 'held'); } finally { chmodSync(m, 0o644); }
  } finally { p.cleanup(); }
});

// A folder can arrive with CORE's own paths as links to somewhere else; nothing may follow them out.
test('a linked .core, pending folder, manifest or capture file is refused, and nothing is written or read outside', { skip: isWin ? 'symlink fixtures need POSIX' : false }, async () => {
  const { symlinkSync } = await import('node:fs');
  const run = (root, ...args) => confined(root, [join(CORE, 'scripts/project-only.mjs'), ...args, '--root', root]);
  for (const linkAt of ['.core', '.core/_project-only', '.core/_project-only/claude-code']) {
    const p = project();
    try {
      const elsewhere = join(p.base, 'elsewhere'); mkdirSync(elsewhere);
      mkdirSync(dirname(join(p.root, linkAt)), { recursive: true });
      symlinkSync(elsewhere, join(p.root, linkAt));
      const r = run(p.root, 'startup');
      assert.equal(JSON.parse(r.stdout).state, 'refused-link', linkAt);
      assert.deepEqual(readdirSync(elsewhere), [], `nothing written through ${linkAt}`);
      if (linkAt !== '.core') assert.equal(existsSync(join(p.root, '.core', '.gitignore')), false, `a refusal at ${linkAt} creates nothing first`);
    } finally { p.cleanup(); }
  }
  const p = project();
  try {
    const secret = join(p.base, 'secret.json'); writeFileSync(secret, JSON.stringify({ agent_name: 'Leaked', turn_capture: true }));
    const dir = join(p.root, '.core', PROJECT_ONLY_DIR, 'claude-code'); mkdirSync(dir, { recursive: true });
    symlinkSync(secret, join(dir, 'manifest.json'));
    const s = JSON.parse(run(p.root, 'status').stdout);
    assert.deepEqual([s.manifest, s.capture], ['refused-link', 'held'], 'a linked manifest is not read, and capture holds');
    const tc = join(p.root, '_metrics', 'turn-capture'); mkdirSync(tc, { recursive: true });
    const outsideRows = join(p.base, 'rows.jsonl'); writeFileSync(outsideRows, '{"x":1}\n{"x":2}\n{"x":3}\n');
    symlinkSync(outsideRows, join(tc, '2026-10-04.jsonl'));
    const c = JSON.parse(run(p.root, 'capture-status').stdout);
    assert.deepEqual([c.in_project.state, c.in_project.rows, c.outside_history], ['refused-link', undefined, 'unknown'], 'a linked capture file refuses the count rather than reading through it');
  } finally { p.cleanup(); }
});

test('a link to another place inside the folder is refused too, so pending writes never land in the memory store', { skip: isWin ? 'symlink fixtures need POSIX' : false }, async () => {
  const { symlinkSync } = await import('node:fs');
  const p = project();
  try {
    mkdirSync(join(p.root, '.core'), { recursive: true });
    symlinkSync(join(p.root, '_memories'), join(p.root, '.core', PROJECT_ONLY_DIR));
    const before = tree(join(p.root, '_memories'));
    const r = confined(p.root, [join(CORE, 'scripts/project-only.mjs'), 'startup', '--root', p.root]);
    assert.equal(JSON.parse(r.stdout).state, 'refused-link');
    assert.deepEqual(tree(join(p.root, '_memories')), before);
  } finally { p.cleanup(); }
});

test('a project-only process takes locks without reading the install id; withFileLock passes a given identity through', () => {
  const p = project();
  try {
    const fl = pathToFileURL(join(CORE, 'scripts/file-lock.mjs')).href;
    const lock = join(p.root, '_memories', '_lib', '.probe.lock');
    const code = (declare) => `const m = await import(${JSON.stringify(fl)});
      ${declare ? 'm.useNoMachineIdentity();' : ''}
      const { mkdirSync } = await import('node:fs'); mkdirSync(${JSON.stringify(join(p.root, '_memories', '_lib'))}, { recursive: true });
      m.withFileLock(${JSON.stringify(lock)}, () => {});
      let seen; m.withFileLock(${JSON.stringify(lock)}, () => { seen = m.inspectFileLock(${JSON.stringify(lock)}, { machine: null }).lock.machine ?? 'none'; }, { machine: 'probe-id' });
      process.stdout.write(String(seen));`;
    const none = confined(p.root, ['--input-type=module', '-e', code(true)]);
    assert.equal(none.status, 0, none.stderr);
    assert.deepEqual(none.violations, [], 'no install-id read once the process has declared no identity');
    assert.equal(none.stdout, 'probe-id', 'an explicit identity reaches the lock');
    const control = confined(p.root, ['--input-type=module', '-e', code(false)]);
    assert.ok(control.violations.some((v) => v.path.endsWith('install-id')), 'without the declaration the default reads the install id');
  } finally { p.cleanup(); }
});
