/**
 * resolve-plugin-root.mjs — v2.6.0 identity gate.
 *
 * The foundational primitive every other piece of v2.6.0 depends on. Returns
 * a capability row (per skills/core/scripts/capability/row-schema.md) describing
 * what plugin we're actually running and how confident we are in that answer.
 *
 * Six invariants per HC's locked list (collab evt-202605271247-core-codex-5fd2):
 *   1. Deterministic. No network, no writes.
 *   2. Read-only. No file writes, no env mutations, no process side effects.
 *   3. realpath from executing module (NOT cwd). Cwd is evidence only.
 *   4. *_PLUGIN_ROOT env vars are corroborating evidence only, never authoritative.
 *   5. Returns the full evidence shape per the row schema.
 *   6. Single helper API: resolvePluginRoot({ from? }) for callers.
 *
 * Identity quality is the four-state enum (PASS / DEGRADED / NOT-YET / UNKNOWN).
 * Mutation permission is a separate dimension — consumers read mutation_permitted
 * + mutation_block_reason, not identity_status. (HC refinement, same event.)
 *
 * Per DC-77 the script ships with the plugin.
 * Per DC-80 the plugin ships Node.js (.mjs) only.
 */

import { realpathSync, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export const SCHEMA_VERSION = '1.0.0';

// Ordered: most-likely-Codex-first because Codex empirical work is the
// v2.6.0 wedge target. Order doesn't change semantics — first match wins
// during the walk-up since each anchor is harness-specific.
export const PLUGIN_ROOT_ANCHORS = [
  { file: '.codex-plugin/plugin.json',  harness: 'codex' },
  { file: '.claude-plugin/plugin.json', harness: 'claude-code' },
  { file: '.gemini-plugin/plugin.json', harness: 'gemini' },
];

export const ENV_VAR_BY_HARNESS = {
  'claude-code': 'CLAUDE_PLUGIN_ROOT',
  'codex': 'CODEX_PLUGIN_ROOT',
  'gemini': 'GEMINI_PLUGIN_ROOT',
};

// ---------- Pure helpers (testable in isolation) ----------

export function findPluginRootAnchor(startingPath) {
  let current;
  try { current = realpathSync(startingPath); } catch { current = startingPath; }

  // If starting path is a file (or doesn't exist), step up to its directory.
  // existsSync on a non-existent path returns false; treat as "step up anyway."
  if (!existsSync(current) || !isLikelyDir(current)) {
    current = dirname(current);
  }

  while (true) {
    for (const { file, harness } of PLUGIN_ROOT_ANCHORS) {
      const candidate = join(current, file);
      if (existsSync(candidate)) {
        return { manifest_path: candidate, plugin_root: current, harness };
      }
    }
    const parent = dirname(current);
    if (parent === current) return null;  // filesystem root
    current = parent;
  }
}

function isLikelyDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    // statSync errors here mean either path doesn't exist or we don't have
    // permission. Either way, walking up is the right fallback.
    return false;
  }
}

export function safeReadManifest(path) {
  try {
    const raw = readFileSync(path, 'utf8');
    const json = JSON.parse(raw);
    return {
      ok: true,
      plugin_id: json.name || null,
      plugin_version: json.version || null,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Authority classification. Takes a `home` parameter so tests can mock it.
export function classifyAuthority(pluginRoot, home = homedir()) {
  // installed-cache paths
  if (pluginRoot.includes(`${home}/.claude/plugins/`)) return 'installed-cache';
  if (pluginRoot.includes(`${home}/.codex/plugins/`)) return 'installed-cache';
  if (pluginRoot.includes(`${home}/.gemini/plugins/`)) return 'installed-cache';

  // harness workspace paths (rare; means a plugin is being executed from
  // inside a per-workspace cache rather than the user-scope cache)
  if (pluginRoot.includes(`${home}/.claude/workspaces/`)) return 'harness-workspace';
  if (pluginRoot.includes(`${home}/.codex/workspaces/`)) return 'harness-workspace';

  // canonical source — common dev locations. Conservative: only classify as
  // canonical-source when we recognize the location; otherwise return
  // 'unknown' so mutation gates fail closed rather than open.
  if (pluginRoot.includes(`${home}/Documents/Projects/`)) return 'canonical-source';
  if (pluginRoot.includes(`${home}/dev/`)) return 'canonical-source';
  if (pluginRoot.includes(`${home}/code/`)) return 'canonical-source';
  if (pluginRoot.includes(`${home}/src/`)) return 'canonical-source';
  if (pluginRoot.includes(`${home}/work/`)) return 'canonical-source';

  return 'unknown';
}

// ---------- Public API ----------

export function resolvePluginRoot({ from, env = process.env, cwd = process.cwd(), home = homedir() } = {}) {
  const observed_at = new Date().toISOString();
  const env_signals = {
    CLAUDE_PLUGIN_ROOT: env.CLAUDE_PLUGIN_ROOT || null,
    CODEX_PLUGIN_ROOT: env.CODEX_PLUGIN_ROOT || null,
    GEMINI_PLUGIN_ROOT: env.GEMINI_PLUGIN_ROOT || null,
    CLAUDE_CODE_SESSION_ID: env.CLAUDE_CODE_SESSION_ID || null,
    CODEX_THREAD_ID: env.CODEX_THREAD_ID || null,
  };
  const evidence = [];

  // Step 1: starting path (HC invariant #3 — module-relative, never cwd)
  const startingPath = from || fileURLToPath(import.meta.url);
  let effective_script_root;
  try { effective_script_root = realpathSync(startingPath); }
  catch { effective_script_root = startingPath; }
  evidence.push({
    source: 'starting-path',
    value: { input: startingPath, realpath: effective_script_root },
    agrees_with_others: true,
    weight: 'primary',
  });

  // Step 2: walk for manifest anchor
  const found = findPluginRootAnchor(effective_script_root);
  if (!found) {
    evidence.push({
      source: 'manifest-walk',
      value: 'no plugin-root anchor found from starting path',
      agrees_with_others: false,
      weight: 'conflicting',
    });
    return buildRow({
      identity_status: 'UNKNOWN',
      mutation_block_reason: 'identity-unknown',
      observed_at, env_signals, cwd, effective_script_root, evidence,
    });
  }
  evidence.push({
    source: 'manifest-walk',
    value: found.manifest_path,
    agrees_with_others: true,
    weight: 'primary',
  });

  // Step 3: read manifest
  const manifest = safeReadManifest(found.manifest_path);
  if (!manifest.ok) {
    evidence.push({
      source: 'manifest-read',
      value: { error: manifest.error },
      agrees_with_others: false,
      weight: 'conflicting',
    });
    return buildRow({
      identity_status: 'DEGRADED',
      mutation_block_reason: 'identity-degraded',
      observed_at, env_signals, cwd,
      effective_script_root,
      harness: found.harness,
      manifest_path: found.manifest_path,
      evidence,
    });
  }
  evidence.push({
    source: 'manifest-read',
    value: { plugin_id: manifest.plugin_id, plugin_version: manifest.plugin_version },
    agrees_with_others: true,
    weight: 'primary',
  });

  // Step 4: env signal reconciliation (HC invariant #4 — corroborating only)
  const envVarName = ENV_VAR_BY_HARNESS[found.harness];
  const envValue = env_signals[envVarName];
  if (envValue != null) {
    let envResolved;
    try { envResolved = realpathSync(envValue); } catch { envResolved = null; }
    if (envResolved == null) {
      evidence.push({
        source: `env-var-${envVarName}`,
        value: { raw: envValue, error: 'path does not exist or unreachable' },
        agrees_with_others: false,
        weight: 'conflicting',
      });
    } else if (envResolved !== found.plugin_root) {
      evidence.push({
        source: `env-var-${envVarName}`,
        value: { env: envResolved, manifest_root: found.plugin_root },
        agrees_with_others: false,
        weight: 'conflicting',
      });
    } else {
      evidence.push({
        source: `env-var-${envVarName}`,
        value: envValue,
        agrees_with_others: true,
        weight: 'corroborating',
      });
    }
  }

  // Step 5: manifest plugin_id sanity (no name → DEGRADED)
  if (!manifest.plugin_id) {
    evidence.push({
      source: 'manifest-id-check',
      value: 'manifest has no "name" field',
      agrees_with_others: false,
      weight: 'conflicting',
    });
  }

  // Step 6: authority classification
  const authority = classifyAuthority(found.plugin_root, home);
  evidence.push({
    source: 'authority-classify',
    value: authority,
    agrees_with_others: true,
    weight: 'corroborating',
  });

  // Step 7: identity status reconciliation
  const conflictingCount = evidence.filter(e => e.weight === 'conflicting').length;
  const identity_status = conflictingCount === 0 ? 'PASS' : 'DEGRADED';
  const mutation_block_reason = identity_status === 'PASS' ? null : 'identity-degraded';

  return buildRow({
    identity_status,
    mutation_block_reason,
    observed_at, env_signals, cwd,
    effective_script_root,
    harness: found.harness,
    manifest_path: found.manifest_path,
    plugin_id: manifest.plugin_id,
    plugin_version: manifest.plugin_version,
    cache_path: authority === 'installed-cache' ? found.plugin_root : null,
    authority,
    evidence,
  });
}

function buildRow(f) {
  return {
    schema_version: SCHEMA_VERSION,
    capability_id: 'plugin-root-resolution',
    capability_name: 'Plugin root resolution',
    capability_kind: 'identity',
    freshness: 'session-stable',
    refresh_policy: 'per-session',
    observed_at: f.observed_at,
    harness: f.harness || 'unknown',
    workspace_id: null,
    cwd: f.cwd,
    env_signals: f.env_signals,
    effective_script_root: f.effective_script_root,
    manifest_path: f.manifest_path || null,
    plugin_id: f.plugin_id || null,
    plugin_version: f.plugin_version || null,
    cache_path: f.cache_path || null,
    authority: f.authority || 'unknown',
    identity_status: f.identity_status,
    mutation_permitted: f.identity_status === 'PASS',
    mutation_block_reason: f.mutation_block_reason || null,
    evidence: f.evidence,
  };
}

// ---------- CLI ----------

export function main(argv) {
  const asJson = argv.includes('--json');
  let from;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from' && argv[i + 1]) from = argv[i + 1];
  }
  const row = resolvePluginRoot({ from });
  if (asJson) {
    process.stdout.write(JSON.stringify(row, null, 2) + '\n');
  } else {
    const lines = [
      `plugin-root-resolution: ${row.identity_status} (harness=${row.harness}, authority=${row.authority})`,
      `  manifest: ${row.manifest_path || '(none)'}`,
      `  plugin: ${row.plugin_id || '(unknown)'} @ ${row.plugin_version || '(unknown)'}`,
      `  mutation_permitted: ${row.mutation_permitted}` +
        (row.mutation_block_reason ? ` (${row.mutation_block_reason})` : ''),
      `  evidence: ${row.evidence.length} item(s)`,
    ];
    process.stdout.write(lines.join('\n') + '\n');
  }
  if (row.identity_status === 'PASS') return 0;
  if (row.identity_status === 'DEGRADED') return 1;
  return 2;
}

const _cliEntryCanonical = (p) => { try { return realpathSync(p); } catch { return p; } };
const _cliEntryArgv1 = _cliEntryCanonical(process.argv[1]);
const _cliEntrySelf = _cliEntryCanonical(fileURLToPath(import.meta.url));
if (process.env.CORE_DEBUG_CLI_ENTRY) {
  process.stderr.write(
    `[cli-entry] argv[1]=${JSON.stringify(_cliEntryArgv1)}\n` +
    `[cli-entry] self  =${JSON.stringify(_cliEntrySelf)}\n` +
    `[cli-entry] match=${_cliEntryArgv1 === _cliEntrySelf}\n`
  );
}
if (_cliEntryArgv1 === _cliEntrySelf) {
  process.exit(main(process.argv.slice(2)));
}
