/**
 * target-surface-collab-files-probe.mjs — v2.6.0 target-surface capability.
 *
 * Proves that this install's configured collab-files repo (if any) is
 * reachable, is the expected git repo, has a known remote, and has a
 * parseable working-tree state. Called by capability-probe.mjs when the
 * descriptor declares delegate: 'capability/target-surface-collab-files-probe.mjs'.
 *
 * Five proofs per HC critique evt-202605271654:
 *   1. Files repo path exists at the configured location
 *   2. Git repo root matches configured path (not a sub-directory of something else)
 *   3. Working tree state is parseable (git status --porcelain exits 0)
 *   4. Remote URL matches the DECLARED expected upstream — an undeclared destination is
 *      not verified, and this surface writes, so it degrades rather than corroborates
 *   5. Write capability: git push --dry-run succeeds, OR explicitly marked unproven
 *
 * Config source, in priority order:
 *   1. opts.filesRepo / opts.expectedRemote        (test override)
 *   2. CORE_COLLAB_FILES_REPO / CORE_COLLAB_FILES_EXPECTED_REMOTE   (per-installation env vars)
 *   3. descriptor's surfaces.collab_files_repo / surfaces.collab_files_expected_remote
 *      (Option A per completion plan §1.2 — descriptor is the per-harness contract surface)
 *
 * The descriptor ships with (3) unset (null) — this capability only applies to an
 * install that actually uses a git-backed collab-files transport (see collab-plugin's
 * `github:<repo>` transport), which is not every install. Earlier versions baked a
 * specific personal repo path and remote into the shared descriptor as the (3) default,
 * so every install — not just that one — silently probed connectivity to somebody
 * else's private repo. Per-installation config now goes through (2); (3) stays as an
 * opt-in descriptor override for an install that wants to bake in its own default,
 * never as a value that ships pointing at anyone's personal repo.
 *
 * Identity_status:
 *   PASS     — all five proofs pass
 *   DEGRADED — one or more proofs produce conflicting evidence (repo mismatch,
 *              wrong or undeclared remote, push-dry-run failed)
 *   NOT-YET  — configured but the surface has not been created here yet; not ready
 *              rather than broken, and still not a PASS, so mutation gates stay closed
 *   UNKNOWN  — probe couldn't run (nothing configured, git not found, etc.)
 *
 * Ships with the plugin by design.
 * Node.js (.mjs) only, zero dependencies.
 */

import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export const SCHEMA_VERSION = '1.0.0';
export const CAPABILITY_ID = 'target-surface-collab-files';

// Expand ~ to homedir. Only handles leading ~/ (not ~user/).
function expandTilde(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

// Run a git command under cwd; return { stdout, ok, error }.
function gitRun(args, cwd) {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return { stdout, ok: true };
  } catch (e) {
    return { stdout: null, ok: false, error: e.message };
  }
}

/**
 * probe() — exported entry point. Called by capability-probe.mjs invokeProbe().
 *
 * @param {object} opts
 * @param {object} [opts.descriptor]  the loaded harness-capability-descriptor.json
 * @param {string} [opts.filesRepo]   override files repo path (for testing)
 * @param {string} [opts.expectedRemote] override expected remote URL (for testing)
 */
export async function probe(opts = {}) {
  const observed_at = new Date().toISOString();
  const evidence = [];

  // Resolve config per the priority order documented above the probe() entry point:
  // test override > per-installation env var > descriptor surfaces (opt-in only).
  const surfaces = opts.descriptor?.surfaces || {};
  const configuredRepo = opts.filesRepo
    || expandTilde(process.env.CORE_COLLAB_FILES_REPO)
    || expandTilde(surfaces.collab_files_repo)
    || null;
  const expectedRemote = opts.expectedRemote
    || process.env.CORE_COLLAB_FILES_EXPECTED_REMOTE
    || surfaces.collab_files_expected_remote
    || null;

  // --- Proof 1: files repo path exists ---
  // Not every install uses a git-backed collab-files transport, so "unconfigured" is
  // the expected default state, not a broken one. UNKNOWN is still the right
  // identity_status for a mutation-kind capability nobody's set up — it correctly
  // fails closed against any pre-action gate that requires this capability PASS —
  // but the evidence should read as "not applicable to this install" rather than
  // "something is wrong."
  if (!configuredRepo) {
    evidence.push({
      source: 'config-check',
      value: 'not configured for this install — set CORE_COLLAB_FILES_REPO (and optionally CORE_COLLAB_FILES_EXPECTED_REMOTE) to enable, or configure surfaces.collab_files_repo in the descriptor',
      agrees_with_others: false,
      weight: 'conflicting',
    });
    return buildRow({ identity_status: 'UNKNOWN', observed_at, evidence, configuredRepo });
  }

  let repoPath;
  try { repoPath = realpathSync(configuredRepo); } catch { repoPath = configuredRepo; }

  // A configured surface that isn't there yet has not failed — it has not been set up.
  // Reporting that as DEGRADED tells the user something is wrong with a repo they simply
  // have not cloned, and buries a real degradation in the same bucket. NOT-YET is the
  // readiness state; it is not a PASS, so a mutation gate still stays closed.
  if (!existsSync(repoPath)) {
    evidence.push({
      source: 'repo-exists',
      value: { configured: configuredRepo, resolved: repoPath, exists: false, note: 'configured but not present — clone or create it to enable this surface' },
      agrees_with_others: false,
      weight: 'conflicting',
    });
    return buildRow({ identity_status: 'NOT-YET', reason_code: 'target-surface-not-scaffolded', observed_at, evidence, configuredRepo });
  }
  evidence.push({
    source: 'repo-exists',
    value: { resolved: repoPath, exists: true },
    agrees_with_others: true,
    weight: 'primary',
  });

  // --- Proof 2: git repo root matches configured path ---
  const rootResult = gitRun(['rev-parse', '--show-toplevel'], repoPath);
  if (!rootResult.ok) {
    evidence.push({
      source: 'git-repo-root',
      value: { error: rootResult.error },
      agrees_with_others: false,
      weight: 'conflicting',
    });
    return buildRow({ identity_status: 'UNKNOWN', observed_at, evidence, configuredRepo });
  }
  let actualRoot;
  try { actualRoot = realpathSync(rootResult.stdout); } catch { actualRoot = rootResult.stdout; }
  const rootMatches = actualRoot === repoPath;
  evidence.push({
    source: 'git-repo-root',
    value: { actual: actualRoot, configured: repoPath, matches: rootMatches },
    agrees_with_others: rootMatches,
    weight: rootMatches ? 'primary' : 'conflicting',
  });

  // --- Proof 3: working tree state parseable ---
  const statusResult = gitRun(['status', '--porcelain'], repoPath);
  if (!statusResult.ok) {
    evidence.push({
      source: 'git-status',
      value: { error: statusResult.error },
      agrees_with_others: false,
      weight: 'conflicting',
    });
  } else {
    const lines = statusResult.stdout.split('\n').filter(l => l.trim());
    evidence.push({
      source: 'git-status',
      value: { parseable: true, uncommitted_count: lines.length },
      agrees_with_others: true,
      weight: 'corroborating',
    });
  }

  // --- Proof 4: remote URL matches expected ---
  const remoteResult = gitRun(['remote', 'get-url', 'origin'], repoPath);
  if (!remoteResult.ok) {
    evidence.push({
      source: 'git-remote',
      value: { error: remoteResult.error },
      agrees_with_others: false,
      weight: 'conflicting',
    });
  } else {
    const actualRemote = remoteResult.stdout;
    if (expectedRemote) {
      const remoteMatches = actualRemote === expectedRemote;
      evidence.push({
        source: 'git-remote',
        value: { actual: actualRemote, expected: expectedRemote, matches: remoteMatches },
        agrees_with_others: remoteMatches,
        weight: remoteMatches ? 'corroborating' : 'conflicting',
      });
    } else {
      // This is a mutation surface, and the remote IS the destination a write lands on.
      // Accepting an undeclared remote as corroborating let every other proof pass and
      // opened the gate onto whatever origin the repo happened to carry. An unverified
      // destination is not a destination: conflicting, so the surface degrades.
      evidence.push({
        source: 'git-remote',
        value: { actual: actualRemote, expected: null, unverified_code: 'target_surface_destination_undeclared', note: 'expected_remote not configured — set CORE_COLLAB_FILES_EXPECTED_REMOTE so writes have a declared destination' },
        agrees_with_others: false,
        weight: 'conflicting',
      });
    }
  }

  // --- Proof 5: write/push capability ---
  // Try git push --dry-run. If it fails (no-op remote, auth error, etc.), mark unproven
  // with a stable enum code rather than failing hard. The probe documents the limit honestly.
  const pushResult = gitRun(['push', '--dry-run', 'origin', 'HEAD'], repoPath);
  if (pushResult.ok) {
    evidence.push({
      source: 'git-push-dry-run',
      value: { ok: true },
      agrees_with_others: true,
      weight: 'corroborating',
    });
  } else {
    // M11 / Doctrine 4 (fail-closed mutation): this is a `mutation`-kind surface, and the
    // runner's ONLY mutation lever is identity_status (runPreAction gates mutation on
    // identity PASS). "Unproven ≠ conflicting" is the right epistemics for an *observation*,
    // but on a mutation surface an unproven write must not yield a PASS that authorizes a
    // write — a read-only collab repo would clear a mutating-action gate. So a failed
    // write-proof is conflicting → DEGRADED → the pre-action gate blocks. The value still
    // documents this as unproven (not proven-broken); the startup path (fail-open) still
    // reports the row, just degraded.
    evidence.push({
      source: 'git-push-dry-run',
      value: {
        ok: false,
        unproven_code: 'target_surface_write_unproven',
        note: 'push dry-run failed; write capability unverified — mutation-kind surface degrades fail-closed',
        error: pushResult.error?.slice(0, 200),
      },
      agrees_with_others: false,
      weight: 'conflicting',
    });
  }

  // Identity classification
  const conflicting = evidence.filter(e => e.weight === 'conflicting');
  const identity_status = conflicting.length === 0 ? 'PASS' : 'DEGRADED';

  return buildRow({ identity_status, observed_at, evidence, configuredRepo });
}

function buildRow({ identity_status, observed_at, evidence, configuredRepo, reason_code = null }) {
  return {
    schema_version: SCHEMA_VERSION,
    ...(reason_code ? { reason_code } : {}),
    capability_id: CAPABILITY_ID,
    capability_name: 'Target surface — collab files transport',
    capability_kind: 'mutation',
    freshness: 'operation-volatile',
    refresh_policy: 'per-operation',
    observed_at,
    cwd: process.cwd(),
    target_surface: configuredRepo || null,
    identity_status,
    // mutation_permitted is set by capability-probe.mjs runner after the action gate
    mutation_permitted: null,
    mutation_block_reason: null,
    evidence,
  };
}
