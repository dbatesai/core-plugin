// Capture writes CORE's own records, and they must physically be in the project: a link, or a second
// hard link, at any point capture writes through is refused before anything is read or written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, symlinkSync, linkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { captureTurnEvidence, captureCustodyProblem } from '../../plugins/core/skills/core/scripts/turn-capture.mjs';

const ENV = { CORE_METRICS_ENABLED: '1', CORE_TURN_CAPTURE: '1' };
const NOW = '2026-10-05T00:00:00Z';
const ROW = { prompt_text: 'Synthetic custody control', retrieval_id: 'synthetic-custody' };
const skip = process.platform === 'win32';

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'custody-')));
  const root = join(base, 'project'); const foreign = join(base, 'foreign');
  mkdirSync(join(root, '_memories'), { recursive: true }); mkdirSync(foreign);
  writeFileSync(join(foreign, 'sentinel'), 'FOREIGN\n');
  const snapshot = () => Object.fromEntries(readdirSync(foreign).sort().map((n) => [n, readFileSync(join(foreign, n), 'utf8')]));
  return { base, root, foreign, snapshot, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
const capture = (root) => captureTurnEvidence(root, ROW, { now: NOW, env: ENV });

test('control: a regular project captures the turn locally and reports no custody problem', () => {
  const s = setup();
  try {
    assert.equal(captureCustodyProblem(s.root), null);
    const r = capture(s.root);
    assert.equal(r.written, true, JSON.stringify(r));
    assert.match(readFileSync(join(s.root, '_metrics', 'turn-capture', '2026-10-05.jsonl'), 'utf8'), /synthetic-custody/);
    assert.equal(JSON.parse(readFileSync(join(s.root, '_metrics', 'turn-capture-health.json'), 'utf8')).attempts, 1);
    assert.equal(capture(s.root).written, true, 'and again, appending to its own existing files');
    assert.deepEqual(Object.keys(s.snapshot()), ['sentinel']);
  } finally { s.cleanup(); }
});

const cases = {
  'the metrics folder is a link': (s) => symlinkSync(s.foreign, join(s.root, '_metrics')),
  'the capture folder is a link': (s) => { mkdirSync(join(s.root, '_metrics')); symlinkSync(s.foreign, join(s.root, '_metrics', 'turn-capture')); },
  'the dated row is a link': (s) => { mkdirSync(join(s.root, '_metrics', 'turn-capture'), { recursive: true }); symlinkSync(join(s.foreign, 'sentinel'), join(s.root, '_metrics', 'turn-capture', '2026-10-05.jsonl')); },
  'the dated row has a second hard link': (s) => { mkdirSync(join(s.root, '_metrics', 'turn-capture'), { recursive: true }); linkSync(join(s.foreign, 'sentinel'), join(s.root, '_metrics', 'turn-capture', '2026-10-05.jsonl')); },
  'the health file is a link': (s) => { mkdirSync(join(s.root, '_metrics')); symlinkSync(join(s.foreign, 'sentinel'), join(s.root, '_metrics', 'turn-capture-health.json')); },
  'the health file has a second hard link': (s) => { mkdirSync(join(s.root, '_metrics')); linkSync(join(s.foreign, 'sentinel'), join(s.root, '_metrics', 'turn-capture-health.json')); },
  'the stream ignore file is a link': (s) => { mkdirSync(join(s.root, '_metrics', 'turn-capture'), { recursive: true }); symlinkSync(join(s.foreign, 'sentinel'), join(s.root, '_metrics', 'turn-capture', '.gitignore')); },
  'a lock generation has a second hard link': (s) => { mkdirSync(join(s.root, '_metrics')); writeFileSync(join(s.foreign, 'lockish'), '{}'); linkSync(join(s.foreign, 'lockish'), join(s.root, '_metrics', '.turn-capture.lock.g1')); },
  'the lock file is a link': (s) => { mkdirSync(join(s.root, '_metrics')); symlinkSync(join(s.foreign, 'sentinel'), join(s.root, '_metrics', '.turn-capture.lock')); },
};
for (const [name, plant] of Object.entries(cases)) {
  test(`refused, visibly, with foreign bytes unchanged: ${name}`, { skip }, () => {
    const s = setup();
    try {
      plant(s);
      const before = s.snapshot();
      const r = capture(s.root);
      assert.equal(r.written, false, 'never reports a write');
      assert.equal(r.refused, true);
      assert.match(r.reason, /^capture-refused: /);
      assert.deepEqual(s.snapshot(), before, 'nothing was appended, overwritten or created outside');
      assert.ok(captureCustodyProblem(s.root, { rowFile: join(s.root, '_metrics', 'turn-capture', '2026-10-05.jsonl') }));
    } finally { s.cleanup(); }
  });
}

test('a project reached through a linked path still captures, into the real project', { skip }, () => {
  const s = setup();
  try {
    const alias = join(s.base, 'alias'); symlinkSync(s.root, alias);
    assert.equal(capture(alias).written, true);
    assert.ok(existsSync(join(s.root, '_metrics', 'turn-capture', '2026-10-05.jsonl')));
  } finally { s.cleanup(); }
});

// The refusal comes before the producer looks inside the metrics folder at all: run for real under
// the attempted-access gate, a linked metrics folder produces no outside call of any kind, and a
// hard-linked lock generation is never read.
test('nothing under a linked metrics folder is probed, and a hard-linked lock generation is never read', { skip }, () => {
  const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const mod = pathToFileURL(join(REPO, 'plugins/core/skills/core/scripts/turn-capture.mjs')).href;
  const gate = pathToFileURL(join(REPO, 'tests/scripts/fs-confine.mjs')).href;
  const run = (s, countReadsOf = null) => {
    const home = join(s.base, 'home'); mkdirSync(join(home, '.core'), { recursive: true }); writeFileSync(join(home, '.core', 'projects.json'), JSON.stringify([{ path: s.root }]));
    const preload = `import fs from 'node:fs'; import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module'; globalThis.reads = 0; const read = fs.readFileSync; fs.readFileSync = (p, ...a) => { if (String(p) === ${JSON.stringify(countReadsOf)}) globalThis.reads++; return read(p, ...a); }; os.userInfo = () => ({ homedir: ${JSON.stringify(home)} }); os.homedir = () => ${JSON.stringify(home)}; syncBuiltinESMExports();`;
    const script = `const { captureTurnEvidence } = await import(${JSON.stringify(mod)}); const r = captureTurnEvidence(${JSON.stringify(s.root)}, ${JSON.stringify(ROW)}, { now: ${JSON.stringify(NOW)}, env: ${JSON.stringify(ENV)} }); console.log(JSON.stringify({ r, reads: globalThis.reads }));`;
    const r = spawnSync(process.execPath, ['--import', gate, '--import', 'data:text/javascript,' + encodeURIComponent(preload), '--input-type=module', '-e', script], { cwd: s.root, encoding: 'utf8', env: { ...process.env, CORE_HOOKS_LOG_FILE: '/dev/null', FS_CONFINE_ROOTS: [s.root, REPO, home].join(delimiter) } });
    const m = r.stderr.match(/FS_CONFINE_VIOLATIONS (.*)/);
    return { ...JSON.parse(r.stdout), violations: m ? JSON.parse(m[1]) : null };
  };
  const a = setup();
  try {
    symlinkSync(a.foreign, join(a.root, '_metrics'));
    const x = run(a);
    assert.equal(x.r.refused, true);
    assert.deepEqual(x.violations, [], 'no existence probe, read or write reached the foreign folder');
  } finally { a.cleanup(); }
  const b = setup();
  try {
    mkdirSync(join(b.root, '_metrics')); writeFileSync(join(b.foreign, 'lockish'), '{}');
    const lock = join(b.root, '_metrics', '.turn-capture.lock.g1'); linkSync(join(b.foreign, 'lockish'), lock);
    const x = run(b, lock);
    assert.equal(x.r.refused, true);
    assert.match(x.r.reason, /turn-capture\.lock\.g1 is a link, has a second name/);
    assert.equal(x.reads, 0, 'the shared lock file was never read');
    assert.equal(readFileSync(join(b.foreign, 'lockish'), 'utf8'), '{}');
  } finally { b.cleanup(); }
});
