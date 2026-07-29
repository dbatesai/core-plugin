import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { trustedTestTmpRoot } from './trusted-test-tmp.mjs';
import { runPackage } from '../../plugins/core/skills/core/scripts/metrics-package.mjs';
import { judgeUnjudgedTurns, judgmentLogPath } from '../../plugins/core/skills/core/scripts/hindsight-judge.mjs';
import { computeScorecard, appendScorecard, scorecardLogPath } from '../../plugins/core/skills/core/scripts/scorecard.mjs';
import { newRound, roundDir } from '../../plugins/core/skills/core/scripts/self-test-round.mjs';
import { captureTurnEvidence } from '../../plugins/core/skills/core/scripts/turn-capture.mjs';

const IS_WIN = platform() === 'win32';
const mode = (p) => statSync(p).mode & 0o777;

function makeProject(root, { units = 1 } = {}) {
  const project = join(root, 'proj');
  const store = join(project, '_memories');
  mkdirSync(store, { recursive: true });
  writeFileSync(join(project, 'workspace.json'), JSON.stringify({ workspace_id: 'perm-fixture' }));
  writeFileSync(join(project, 'PROJECT.md'), '# P\n');
  for (let i = 0; i < units; i += 1) {
    writeFileSync(join(store, `dc-${i}.md`), `---\nid: dc-${i}\ntype: decision\nstatus: active\ncreated: 2026-06-0${(i % 9) + 1}\n---\n\nA decision about retrieval quality grading.\n`);
  }
  return project;
}

test('a self-test round directory and its answer key are owner-only', { skip: IS_WIN && 'POSIX modes' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'perm-selftest-'));
  try {
    const project = makeProject(root, { units: 3 });
    const { round } = newRound(project);
    const dir = roundDir(project, round);
    assert.equal(mode(dir), 0o700, 'round dir is owner-only');
    for (const name of readdirSync(dir)) {
      assert.equal(mode(join(dir, name)), 0o600, `${name} is owner-only`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the hindsight judgment log is owner-only', { skip: IS_WIN && 'POSIX modes' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'perm-judge-'));
  try {
    const project = makeProject(root, { units: 2 });
    const env = { ...process.env };
    delete env.CORE_METRICS_ENABLED;
    delete env.CORE_TURN_CAPTURE;
    captureTurnEvidence(project, {
      retrieval_id: 'rid-perm-1',
      prompt_text: 'how does retrieval quality grading work',
      delivered: [{ id: 'dc-0-seed', score: 5 }],
    }, { env });
    judgeUnjudgedTurns(project);
    const log = judgmentLogPath(project);
    assert.equal(existsSync(log), true, 'a judgment landed');
    assert.equal(mode(log), 0o600);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the scorecard log is owner-only', { skip: IS_WIN && 'POSIX modes' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'perm-scorecard-'));
  try {
    const project = makeProject(root);
    appendScorecard(project, computeScorecard(project));
    assert.equal(mode(scorecardLogPath(project)), 0o600);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the exported package is owner-only where it lands', { skip: IS_WIN && 'POSIX modes' }, () => {
  const root = mkdtempSync(join(trustedTestTmpRoot(), 'perm-package-'));
  try {
    const project = makeProject(root, { units: 2 });
    const home = join(root, 'home');
    mkdirSync(join(home, '.core'), { recursive: true });
    mkdirSync(join(home, 'Desktop'), { recursive: true });
    const result = runPackage([project, '--out', join(root, 'out'), '--home', home]);
    assert.ok(result.shipped, result.error);
    assert.equal(mode(result.shipped.path), result.shipped.kind === 'zip' ? 0o600 : 0o700);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
