// The analytics commands /process-memory runs keep the gate: with nothing opted in each one exits
// cleanly and writes nothing in the project or the account home; with analytics on, at least one
// of them writes (the control that shows the diff can see their writes).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerFixtureProject } from './registered-project-fixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPTS = join(ROOT, 'plugins', 'core', 'skills', 'core', 'scripts');
const FIXT = join(ROOT, 'tests', 'fixtures', 'obligation3-store');
const PRELOAD_URL = pathToFileURL(join(ROOT, 'tests', 'helpers', 'account-home-preload.mjs')).href;

// Exactly the analytics commands plugins/core/skills/process-memory/SKILL.md tells the agent to run.
const COMMANDS = [
  ['analyze-retrieval-quality.mjs'],
  ['analyze-retrieval-skip.mjs'],
  ['analyze-capability-drift.mjs'],
  ['classify-turns.mjs'],
  ['metrics-rollup.mjs'],
  ['metrics-detectors.mjs'],
  ['calibrate-classifier.mjs', '--check'],
];

const cleanup = [];
after(() => { for (const d of cleanup) rmSync(d, { recursive: true, force: true }); });

function sandbox() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'pm-gate-')));
  cleanup.push(base);
  const home = join(base, 'home');
  mkdirSync(join(home, '.core'), { recursive: true });
  const project = join(base, 'proj');
  cpSync(FIXT, project, { recursive: true });
  writeFileSync(join(project, 'PROJECT.md'), '# Fixture\n');
  registerFixtureProject(home, project);
  return { base, home, project };
}

function childEnv(home, gate) {
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CORE_TEST_ACCOUNT_HOME: home,
    NODE_OPTIONS: `--import ${PRELOAD_URL}`, CORE_HARNESS: 'claude-code', ...gate };
  for (const k of ['TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'LANG']) if (process.env[k]) env[k] = process.env[k];
  return env;
}

function snapshot(base) {
  const files = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isDirectory()) { files.set(relative(base, p).split(sep).join('/') + '/', 'dir'); walk(p); }
      else files.set(relative(base, p).split(sep).join('/'), st.isFile() ? createHash('sha256').update(readFileSync(p)).digest('hex') : 'link');
    }
  };
  walk(base);
  return files;
}

const diff = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter((p) => a.get(p) !== b.get(p)).sort();

function runAll(gate) {
  const s = sandbox();
  const env = childEnv(s.home, gate);
  const results = [];
  for (const [script, ...args] of COMMANDS) {
    const before = snapshot(s.base);
    const r = spawnSync(process.execPath, [join(SCRIPTS, script), s.project, ...args], { env, cwd: s.project, encoding: 'utf8', timeout: 60000 });
    results.push({ script, status: r.status, stdout: r.stdout, stderr: r.stderr, written: diff(before, snapshot(s.base)) });
  }
  return results;
}

test('nothing opted in: every analytics command /process-memory runs writes nothing', () => {
  for (const r of runAll({})) {
    assert.equal(r.status === 0 || r.status === 1, true, `${r.script} exits cleanly (0, or 1 for a reported condition): ${r.status}\n${r.stderr}`);
    assert.deepEqual(r.written, [], `${r.script} wrote with analytics off:\n${r.written.join('\n')}`);
  }
});

test('control: with analytics opted in, the same commands do write', () => {
  const wrote = runAll({ CORE_METRICS_ENABLED: '1' }).filter((r) => r.written.length);
  assert.ok(wrote.length > 0, 'at least one command writes when analytics are on, so the diff can see writes');
});
