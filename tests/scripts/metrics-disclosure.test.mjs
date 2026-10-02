// Behavioral test for the one-time first-run metrics disclosure. Every test runs
// against a temp home and temp project folders, so nothing touches the real ~/.core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, realpathSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { checkMetricsDisclosure, NOTICE_TEXT, NOTICE_VERSION } from '../../plugins/core/skills/core/scripts/metrics-disclosure.mjs';
import { updateManifest, readManifest, stateDir, writeSignedFile } from '../../plugins/core/skills/core/scripts/project-state.mjs';

const SCRIPT = join(process.cwd(), 'plugins/core/skills/core/scripts/metrics-disclosure.mjs');
const HARNESS = 'claude-code';
const ENV = { CORE_HARNESS: HARNESS };

function sandbox(fn, { registered = true } = {}) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'metrics-disclosure-')));
  const home = join(base, 'home');
  const coreDir = join(home, '.core');
  const project = join(base, 'project');
  mkdirSync(coreDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  if (registered) writeFileSync(join(coreDir, 'projects.json'), JSON.stringify([{ path: project }]));
  try { return fn({ home, coreDir, project }); }
  finally { rmSync(base, { recursive: true, force: true }); }
}

const manifestFile = (coreDir, project) =>
  join(stateDir({ root: project, harness: HARNESS, coreDir, forWrite: true }).dir, 'workspace.json');

test('first call for a project shows the notice and persists the flag in its .core manifest', () => {
  sandbox(({ home, coreDir, project }) => {
    updateManifest({ root: project, harness: HARNESS, coreDir, fields: { schema_version: 'v2' } });
    const result = checkMetricsDisclosure({ projectDir: project, home, env: ENV });
    assert.equal(result.ok, true);
    assert.equal(result.shown, true);
    assert.equal(result.alreadyShown, false);
    assert.equal(result.noticeText, NOTICE_TEXT);
    const file = manifestFile(coreDir, project);
    assert.equal(file, join(realpathSync(project), '.core', HARNESS, 'workspace.json'), 'the manifest lives in the project');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(manifest.metrics_disclosure_shown, true, 'flag persisted into the manifest');
    assert.equal(manifest.schema_version, 'v2', 'pre-existing manifest fields preserved, not clobbered');
  });
});

test('second and subsequent calls report ALREADY-SHOWN and write nothing further', () => {
  sandbox(({ home, coreDir, project }) => {
    assert.equal(checkMetricsDisclosure({ projectDir: project, home, env: ENV }).shown, true);
    const before = readFileSync(manifestFile(coreDir, project), 'utf8');
    const second = checkMetricsDisclosure({ projectDir: project, home, env: ENV });
    assert.equal(second.ok, true);
    assert.equal(second.shown, false);
    assert.equal(second.alreadyShown, true);
    assert.equal(second.noticeText, null, 'no notice text on repeat calls — never nags');
    assert.equal(checkMetricsDisclosure({ projectDir: project, home, env: ENV }).alreadyShown, true);
    assert.equal(readFileSync(manifestFile(coreDir, project), 'utf8'), before, 'manifest untouched on repeat calls');
  });
});

test('a project with no manifest yet still shows once and creates the manifest with the flag set', () => {
  sandbox(({ home, coreDir, project }) => {
    assert.equal(existsSync(join(project, '.core')), false);
    const result = checkMetricsDisclosure({ projectDir: project, home, env: ENV });
    assert.equal(result.shown, true);
    assert.equal(readManifest({ root: project, harness: HARNESS, coreDir }).metrics_disclosure_shown, true);
  });
});

test('a flag planted by a cloned repo never suppresses the notice', () => {
  sandbox(({ home, project }) => {
    const planted = join(project, '.core', HARNESS);
    mkdirSync(planted, { recursive: true });
    writeFileSync(join(planted, 'workspace.json'), JSON.stringify({ metrics_disclosure_shown: true, metrics_disclosure_version: NOTICE_VERSION }));
    const result = checkMetricsDisclosure({ projectDir: project, home, env: ENV });
    assert.equal(result.shown, true, 'an unstamped manifest is not trusted');
    assert.equal(result.noticeText, NOTICE_TEXT);
  });
});

test('an unregistered folder shows the notice and keeps its manifest out of the folder', () => {
  sandbox(({ home, project }) => {
    const result = checkMetricsDisclosure({ projectDir: project, home, env: ENV });
    assert.equal(result.shown, true);
    assert.equal(existsSync(join(project, '.core')), false, 'no .core/ planted in an unregistered folder');
  }, { registered: false });
});

test('missing projectDir fails without throwing and shows nothing', () => {
  const result = checkMetricsDisclosure({});
  assert.equal(result.ok, false);
  assert.equal(result.shown, false);
  assert.equal(result.noticeText, null);
  assert.equal(result.reason, 'missing-project-dir');
});

test('an unsigned manifest reads as absent: the notice shows and the old bytes are set aside, not clobbered', () => {
  sandbox(({ home, coreDir, project }) => {
    const file = manifestFile(coreDir, project);
    writeFileSync(file, '{ not valid json');
    const result = checkMetricsDisclosure({ projectDir: project, home, env: ENV });
    assert.equal(result.noticeText, NOTICE_TEXT, 'fails toward showing the notice');
    const dir = stateDir({ root: project, harness: HARNESS, coreDir }).dir;
    const aside = readdirSync(dir).filter((n) => n.startsWith('workspace.json.unverified-'));
    assert.equal(aside.length, 1, 'the unverified manifest is kept beside the new one');
    assert.equal(readFileSync(join(dir, aside[0]), 'utf8'), '{ not valid json', 'its bytes are untouched');
  });
});

test('a signed but unparseable manifest is never clobbered, and the notice still shows', () => {
  sandbox(({ home, coreDir, project }) => {
    const dir = stateDir({ root: project, harness: HARNESS, coreDir, forWrite: true }).dir;
    writeSignedFile({ dir, name: 'workspace.json', body: '{ not valid json', coreDir });
    const result = checkMetricsDisclosure({ projectDir: project, home, env: ENV });
    assert.equal(result.ok, false);
    assert.equal(result.noticeText, NOTICE_TEXT, 'fails toward showing the notice');
    assert.match(result.reason, /manifest-unparseable/);
    assert.equal(readFileSync(join(dir, 'workspace.json'), 'utf8'), '{ not valid json', 'the unreadable manifest is left as it was');
  });
});

test('the notice text names both opt-out mechanisms and where the log lives', () => {
  assert.match(NOTICE_TEXT, /CORE_METRICS_ENABLED=0/, 'names the env-var opt-out');
  assert.match(NOTICE_TEXT, /metrics_enabled:\s*false/, 'names the manifest opt-out');
  assert.match(NOTICE_TEXT, /\.core\/<harness>\/workspace\.json/, 'names the config file where it really lives');
  assert.match(NOTICE_TEXT, /lives in this project's folder/, 'says where the log lives');
  assert.match(NOTICE_TEXT, /syncs with it/, 'says a synced project folder syncs the log too');
  assert.doesNotMatch(NOTICE_TEXT, /this machine/i, 'no claim the log stays on this machine');
});

test('CLI: first run prints the notice text; second run prints ALREADY-SHOWN', { skip: platform() === 'win32' ? 'shell redirection differs on Windows CI' : false }, () => {
  sandbox(({ home, project }) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, CORE_HARNESS: HARNESS };
    const firstOut = execFileSync('node', [SCRIPT, 'check', project], { encoding: 'utf8', env });
    assert.equal(firstOut.trim(), NOTICE_TEXT.trim());
    const secondOut = execFileSync('node', [SCRIPT, 'check', project], { encoding: 'utf8', env });
    assert.equal(secondOut.trim(), 'ALREADY-SHOWN');
  });
});

test('CLI: an unknown subcommand exits nonzero with a usage message', () => {
  assert.throws(() => {
    execFileSync('node', [SCRIPT, 'nope'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  }, /Command failed/);
});

test('a project stamped under an older notice version is shown the current notice again', () => {
  sandbox(({ home, coreDir, project }) => {
    updateManifest({ root: project, harness: HARNESS, coreDir, fields: { metrics_disclosure_shown: true } });
    const res = checkMetricsDisclosure({ projectDir: project, home, env: ENV });
    assert.equal(res.shown, true, 'a materially newer notice must reach an already-stamped project');
    assert.equal(res.noticeText, NOTICE_TEXT);
    assert.equal(readManifest({ root: project, harness: HARNESS, coreDir }).metrics_disclosure_version, NOTICE_VERSION);
  });
});

test('a project stamped at the current notice version stays silent', () => {
  sandbox(({ home, coreDir, project }) => {
    updateManifest({ root: project, harness: HARNESS, coreDir, fields: { metrics_disclosure_shown: true, metrics_disclosure_version: NOTICE_VERSION } });
    const res = checkMetricsDisclosure({ projectDir: project, home, env: ENV });
    assert.equal(res.shown, false);
    assert.equal(res.alreadyShown, true);
  });
});
