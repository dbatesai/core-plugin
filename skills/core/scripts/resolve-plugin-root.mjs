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

// Detect the harness consuming this invocation — distinct from manifest_harness
// (which the realpath walk found). Per HC critique evt-202605271310:
// "Downstream scripts should not infer the active harness from whichever manifest
// anchor won the root walk." The consuming harness lives in env signals; absence
// of evidence is itself a state (UNKNOWN), not a guess.
//
// v2.6.0-delta: collect-all-signals first, then classify as unanimous/conflict/absent.
// First-match-wins is unsafe when multiple signals are present — a Codex run that also
// inherits CLAUDE_PLUGIN_ROOT from the parent env would have silently resolved to
// claude-code. Conflict → consuming_harness: unknown, source: conflict, identity DEGRADES.
// Signal weight distinguishes *_PLUGIN_ROOT (strong, explicit plugin context) from
// CLAUDE_CODE_SESSION_ID / CODEX_THREAD_ID (weak, env presence only).
export function detectConsumingHarnessSignal(env = process.env) {
  const signals = [];

  // Strong signals — *_PLUGIN_ROOT env vars mean the harness explicitly set plugin context
  if (env.CLAUDE_PLUGIN_ROOT) signals.push({ var: 'CLAUDE_PLUGIN_ROOT', harness: 'claude-code', weight: 'strong' });
  if (env.CODEX_PLUGIN_ROOT)  signals.push({ var: 'CODEX_PLUGIN_ROOT',  harness: 'codex',       weight: 'strong' });
  if (env.GEMINI_PLUGIN_ROOT) signals.push({ var: 'GEMINI_PLUGIN_ROOT', harness: 'gemini',      weight: 'strong' });

  // Weak signals — session/thread vars indicate harness presence, not plugin context
  if (env.CLAUDE_CODE_SESSION_ID) signals.push({ var: 'CLAUDE_CODE_SESSION_ID', harness: 'claude-code', weight: 'weak' });
  if (env.CODEX_THREAD_ID)        signals.push({ var: 'CODEX_THREAD_ID',        harness: 'codex',       weight: 'weak' });

  if (signals.length === 0) {
    return { harness: 'unknown', source: 'not_exposed', signal_weight: null, signals: [] };
  }

  const uniqueHarnesses = [...new Set(signals.map(s => s.harness))];
  if (uniqueHarnesses.length === 1) {
    // All signals agree. Presence of any strong signal → strong overall weight.
    const hasStrong = signals.some(s => s.weight === 'strong');
    return {
      harness: uniqueHarnesses[0],
      source: 'env',
      signal_weight: hasStrong ? 'strong' : 'weak',
      signals,
    };
  }

  // Multiple harnesses detected — conflict. Identity MUST degrade downstream.
  return { harness: 'unknown', source: 'conflict', signal_weight: null, signals };
}

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

  // Consuming-harness detection lives apart from manifest-walk (HC critique
  // evt-202605271310). Detect first; surface as separate fields. UNKNOWN
  // consuming-harness with PASS identity is a valid state.
  const consuming = detectConsumingHarnessSignal(env);

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
      observed_at, env_signals, cwd, effective_script_root, evidence,
      consuming_harness: consuming.harness,
      consuming_harness_source: consuming.source,
      consuming_harness_signal_weight: consuming.signal_weight || null,
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
      observed_at, env_signals, cwd,
      effective_script_root,
      manifest_harness: found.harness,
      consuming_harness: consuming.harness,
      consuming_harness_source: consuming.source,
      consuming_harness_signal_weight: consuming.signal_weight || null,
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

  // Step 6.5: consuming-harness cross-check. Three cases:
  //   (a) conflict in the env signals themselves → DEGRADE regardless of manifest
  //   (b) unanimous env says a different harness than manifest → split-brain DEGRADE
  //   (c) unanimous env agrees with manifest, or absent → corroborating/neutral
  if (consuming.source === 'conflict') {
    // Multiple harnesses detected in env — we cannot identify the consuming harness.
    // The conflict itself is the evidence; downstream mutation gates must refuse.
    evidence.push({
      source: 'consuming-harness-conflict',
      value: { signals: consuming.signals },
      agrees_with_others: false,
      weight: 'conflicting',
    });
  } else if (consuming.harness !== 'unknown' && consuming.harness !== found.harness) {
    // Unanimous env signal disagrees with manifest harness (split-brain).
    evidence.push({
      source: 'harness-split-brain',
      value: { manifest_harness: found.harness, consuming_harness: consuming.harness, consuming_harness_source: consuming.source },
      agrees_with_others: false,
      weight: 'conflicting',
    });
  } else if (consuming.harness === 'unknown') {
    // Absence of evidence is a state, not a guess. Don't flag as conflicting;
    // record as a corroborating gap so downstream consumers can read it.
    evidence.push({
      source: 'consuming-harness-detection',
      value: { harness: 'unknown', source: consuming.source },
      agrees_with_others: true,
      weight: 'corroborating',
    });
  } else {
    evidence.push({
      source: 'consuming-harness-detection',
      value: { harness: consuming.harness, source: consuming.source, signal_weight: consuming.signal_weight },
      agrees_with_others: true,
      weight: 'corroborating',
    });
  }

  // Step 7: identity status reconciliation. NOTE: identity_status is diagnostic
  // truth about WHERE we are. mutation_permitted is the operational contract
  // that runners apply via per-action profiles (allowed_authorities,
  // allowed_harnesses, target_surface). This delegate never sets mutation_permitted
  // to true on its own — that's a v2.6.0-β bug HC critique evt-202605271310
  // surfaced. Runner gates; delegate reports.
  const conflictingCount = evidence.filter(e => e.weight === 'conflicting').length;
  const identity_status = conflictingCount === 0 ? 'PASS' : 'DEGRADED';

  return buildRow({
    identity_status,
    observed_at, env_signals, cwd,
    effective_script_root,
    manifest_harness: found.harness,
    consuming_harness: consuming.harness,
    consuming_harness_source: consuming.source,
    consuming_harness_signal_weight: consuming.signal_weight || null,
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
    // manifest_harness = what the realpath walk found at the plugin-root anchor
    // consuming_harness = which harness is actually running (from env signals)
    // These are distinct dimensions per HC critique evt-202605271310. A
    // multi-harness plugin root can have manifest_harness=codex while the
    // consuming_harness is claude-code; downstream consumers that need to
    // know which harness is running must read consuming_harness, not manifest_harness.
    manifest_harness: f.manifest_harness || 'unknown',
    consuming_harness: f.consuming_harness || 'unknown',
    consuming_harness_source: f.consuming_harness_source || 'not_exposed',
    consuming_harness_signal_weight: f.consuming_harness_signal_weight || null,
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
    // Identity-only row. mutation_permitted stays null until a runner applies
    // operation-scoped gating via the descriptor's action profile (allowed_authorities,
    // allowed_harnesses, target_surface). A row with mutation_permitted: null is
    // not "unknown action permission" — it's "identity only; ask the runner."
    mutation_permitted: null,
    mutation_block_reason: null,
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
      `plugin-root-resolution: ${row.identity_status} (authority=${row.authority})`,
      `  manifest_harness:  ${row.manifest_harness}`,
      `  consuming_harness: ${row.consuming_harness} (source=${row.consuming_harness_source})`,
      `  manifest: ${row.manifest_path || '(none)'}`,
      `  plugin: ${row.plugin_id || '(unknown)'} @ ${row.plugin_version || '(unknown)'}`,
      `  mutation_permitted: identity-only (runner applies operation-scoped gating)`,
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
