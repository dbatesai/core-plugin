/**
 * close-hook-regression-parent-sha.test.mjs — the production duplicate-close defect,
 * proven bookend-style against the actual parent SHA (RC-06).
 *
 * RED-01/RED-04's evidence for the exact-session redesign is a missing-export
 * SyntaxError, invalid under the test contract because it never executes a real
 * oracle. A parent-SHA-compatible falsifier
 * has to run at e81903fc5c58529f7ab0b05421df126c3f9e4f2d (last release, before this branch
 * added any new export) without import-erroring, reach a real assertion, fail there, then
 * pass at the fixed tip.
 *
 * This test materializes the ENTIRE skills/core tree at e81903f via `git archive` (so the
 * historical hook's relative imports resolve against historical dependencies, not today's)
 * and runs it as a real subprocess with a real payload — no new symbol is imported, so
 * nothing can SyntaxError. The oracle: a manual close for sess-A, followed by a second
 * SessionEnd for the SAME sess-A with a real transcript on the payload (didWork=true at
 * that SHA), must not spawn a second close. It does, at e81903f — that IS the reported
 * defect (a manual finalize followed 59.7s later by a second reasoning close). At the
 * current tip, wired end to end by close-process-request.test.mjs's RC-01..RC-05, it
 * does not.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { trustedTestTmpRoot } from './trusted-test-tmp.mjs';

const PARENT_SHA = 'e81903fc5c58529f7ab0b05421df126c3f9e4f2d';
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SESSION_A = 'sess-parent-0192aa8c-1f4d-4a51-9d3e-11c0ffee0030';

/** Materialize plugins/core/skills/core exactly as it stood at PARENT_SHA. */
function materializeParentTree() {
  const dir = mkdtempSync(join(tmpdir(), 'parent-sha-tree-'));
  execFileSync('sh', ['-c', `git archive ${PARENT_SHA} -- plugins/core/skills/core | tar -x -C "${dir}"`], { cwd: REPO_ROOT });
  return dir;
}

const _isolatedLogDirs = [];
after(() => { for (const d of _isolatedLogDirs) rmSync(d, { recursive: true, force: true }); });
function isolatedLog() {
  const dir = mkdtempSync(join(trustedTestTmpRoot(), 'close-parent-sha-'));
  _isolatedLogDirs.push(dir);
  return join(dir, 'hooks-log.jsonl');
}

function registeredStore() {
  const store = mkdtempSync(join(tmpdir(), 'close-parent-store-'));
  mkdirSync(join(store, '_memories'), { recursive: true });
  // CORE_CLOSE_INDEX is only honored when it resolves inside the trusted ~/.core
  // (D1 fix) — a project-forwarded env pointing outside it is ignored, so the index
  // file itself (unlike the store it lists) has to live under trustedTestTmpRoot().
  const idxDir = mkdtempSync(join(trustedTestTmpRoot(), 'close-parent-idx-'));
  const idxPath = join(idxDir, 'index.json');
  writeFileSync(idxPath, JSON.stringify([{ workspace_id: 't', path: store }]));
  return { store, idxPath, idxDir };
}

function runHook(hookPath, payload, env) {
  const res = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, ...env },
  });
  return res;
}

function spawnedClose(logFile) {
  if (!existsSync(logFile)) return false;
  return readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
    .some((l) => { try { const e = JSON.parse(l); return e.hook === 'session-end' && e.action === 'spawn'; } catch { return false; } });
}

test('RC-06 [parent-SHA falsifier] a second SessionEnd for an already-closed session re-spawns at e81903f (the reported defect), and does not at the fixed tip', () => {
  const parentTree = materializeParentTree();
  const { store, idxPath, idxDir } = registeredStore();
  const transcriptPath = join(store, 'transcript.jsonl');
  writeFileSync(transcriptPath, JSON.stringify({ timestamp: '2026-07-27T16:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'x' }] } }) + '\n');

  try {
    // --- Manual close for sess-A, using the marker mechanism that existed at e81903f
    // (begin/record/finish — unchanged today) — this is what /finalize did at that SHA.
    const parentClosePass = join(parentTree, 'plugins', 'core', 'skills', 'core', 'scripts', 'close-pass.mjs');
    const ops = 'maintenance-run,render-project-md,hot-section,demote-moves,compact-project,demote-state,check-units,decorate-graph,reflection-a,reflection-b,metrics,session-summary,memory-refresh';
    execFileSync(process.execPath, [parentClosePass, 'begin', store, '--session', SESSION_A, '--ops', ops]);
    for (const op of ops.split(',')) execFileSync(process.execPath, [parentClosePass, 'record', store, '--op', op, '--status', 'done']);
    execFileSync(process.execPath, [parentClosePass, 'finish', store, '--session', SESSION_A]);

    // --- A second SessionEnd fires for the SAME session, moments later, with a real
    // transcript on the payload (didWork=true under e81903f's heuristic).
    const parentHook = join(parentTree, 'plugins', 'core', 'skills', 'core', 'hooks', 'close-pass-hook.mjs');
    const parentLog = isolatedLog();
    runHook(parentHook, { cwd: store, reason: 'other', session_id: SESSION_A, transcript_path: transcriptPath },
      { CORE_CLOSE_INDEX: idxPath, CORE_HOOKS_LOG_FILE: parentLog });
    assert.equal(spawnedClose(parentLog), true,
      'REPRODUCED: at e81903f a same-session repeat SessionEnd re-spawns a close — the reported defect');

    // --- The exact same scenario against the CURRENT tip, using the NEW mechanism
    // (process-request) to perform the equivalent "already closed" step.
    const currentClosePass = join(REPO_ROOT, 'plugins', 'core', 'skills', 'core', 'scripts', 'close-pass.mjs');
    execFileSync(process.execPath, [currentClosePass, 'process-request', store, '--session', SESSION_A, '--transcript', transcriptPath]);

    const currentHook = join(REPO_ROOT, 'plugins', 'core', 'skills', 'core', 'hooks', 'close-pass-hook.mjs');
    const currentLog = isolatedLog();
    runHook(currentHook, { cwd: store, reason: 'other', session_id: SESSION_A, transcript_path: transcriptPath },
      { CORE_CLOSE_INDEX: idxPath, CORE_HOOKS_LOG_FILE: currentLog });
    assert.equal(spawnedClose(currentLog), false,
      'FIXED: the same repeat SessionEnd for an already-closed exact session must not re-spawn at the current tip');
  } finally {
    // Retried: the detached child can still hold the tree briefly on Windows
    // (EBUSY on an in-use directory), and force alone does not wait it out.
    // Best-effort: the detached child can outlive the retries on a slow
    // Windows runner; a leftover temp dir is the OS temp reaper's job, and
    // cleanup failure must not fail assertions that already passed.
    const rm = (p) => { try { rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* best-effort */ } };
    rm(parentTree);
    rm(store);
    rm(idxDir);
  }
});
