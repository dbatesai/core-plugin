/**
 * capability-probe.mjs — v2.6.0 capability probe runner.
 *
 * Reads `capability/harness-capability-descriptor.json` to determine which
 * capabilities the current harness should probe, invokes the per-harness
 * probe script (or directly delegates to a sibling script if `delegate` is
 * declared), and returns a rows array matching `capability/row-schema.md`.
 *
 * Two invocation modes per DC-97 (fail-open observation, fail-closed mutation):
 *   --startup            Run all capabilities the current harness declares.
 *                        Fail-open: returns the rows even when some are DEGRADED
 *                        or UNKNOWN; exit code 0 even with non-PASS rows.
 *
 *   --pre-action <name>  Run only the capabilities required for the named
 *                        action. Fail-closed: exit code 1 if any required
 *                        capability is not PASS, with mutation_block_reason
 *                        on the stderr.
 *
 * Doctrine consumer for "Fail-open observation, fail-closed mutation" — see
 * `references/architecture-doctrines.md §Doctrine 4`.
 *
 * Per DC-77 the script ships with the plugin.
 * Per DC-80 the plugin ships Node.js (.mjs) only.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePluginRoot } from './resolve-plugin-root.mjs';

export const SCHEMA_VERSION = '1.0.0';
const DESCRIPTOR_PATH = join(dirname(fileURLToPath(import.meta.url)), 'capability', 'harness-capability-descriptor.json');

// ---------- Descriptor loading ----------

export function loadDescriptor(path = DESCRIPTOR_PATH) {
  const raw = readFileSync(path, 'utf8');
  const json = JSON.parse(raw);
  if (json.schema_version !== SCHEMA_VERSION) {
    throw new Error(
      `descriptor schema_version=${json.schema_version} does not match runner SCHEMA_VERSION=${SCHEMA_VERSION}. ` +
      `Coordinated update required.`
    );
  }
  return json;
}

// ---------- Harness detection ----------

// Detection is intentionally narrow: looks at which *_PLUGIN_ROOT env var is set.
// If multiple are set (unusual; multi-harness shell session), prefer the order
// CLAUDE_PLUGIN_ROOT > CODEX_PLUGIN_ROOT > GEMINI_PLUGIN_ROOT because that's
// the order new harnesses tend to ship in. Returns 'unknown' when no signals
// are present; capability-probe handles 'unknown' by returning UNKNOWN rows.
export function detectConsumingHarness(env = process.env) {
  if (env.CLAUDE_PLUGIN_ROOT) return 'claude-code';
  if (env.CODEX_PLUGIN_ROOT) return 'codex';
  if (env.GEMINI_PLUGIN_ROOT) return 'gemini';
  // Fallback: walk resolve-plugin-root to see which manifest the running
  // script is actually under. Same precedence applies on tie.
  try {
    const row = resolvePluginRoot();
    if (row.harness && row.harness !== 'unknown') return row.harness;
  } catch {}
  return 'unknown';
}

// ---------- Probe invocation ----------

// For v2.6.0-β, the only declared capability is `plugin-root-resolution` and
// every harness delegates it to resolve-plugin-root.mjs directly. This switch
// stays small; v2.7.0+ extends to per-harness probe scripts that emit multiple
// rows per harness.
async function invokeProbe(capability, opts = {}) {
  if (capability.delegate === 'resolve-plugin-root.mjs') {
    const row = resolvePluginRoot(opts);
    // Override capability_id from the descriptor so the row matches what the
    // consumer declared (e.g., the descriptor row could be "plugin-root-resolution"
    // even though the delegate's own emitted id matches).
    return {
      ...row,
      capability_id: capability.capability_id,
      capability_kind: capability.capability_kind,
    };
  }
  // Per-harness probe scripts (codex-capability-probe.mjs, etc.) ship in v2.6.0-γ.
  // For now, return a NOT-YET row with evidence naming the missing implementation.
  return makeNotYetRow(capability);
}

function makeNotYetRow(capability, reason = 'per-harness probe script not yet implemented') {
  return {
    schema_version: SCHEMA_VERSION,
    capability_id: capability.capability_id,
    capability_name: capability.capability_id,
    capability_kind: capability.capability_kind,
    freshness: 'session-stable',
    refresh_policy: 'per-session',
    observed_at: new Date().toISOString(),
    harness: 'unknown',
    workspace_id: null,
    cwd: process.cwd(),
    env_signals: {},
    effective_script_root: null,
    manifest_path: null,
    plugin_id: null,
    plugin_version: null,
    cache_path: null,
    authority: 'unknown',
    identity_status: 'NOT-YET',
    mutation_permitted: false,
    mutation_block_reason: 'identity-not-yet',
    evidence: [
      {
        source: 'descriptor-walk',
        value: { reason, capability_id: capability.capability_id },
        agrees_with_others: false,
        weight: 'conflicting',
      },
    ],
  };
}

// ---------- Public API ----------

export async function runStartup(opts = {}) {
  const descriptor = opts.descriptor || loadDescriptor();
  const harness = opts.harness || detectConsumingHarness();
  const harnessEntry = descriptor.harnesses[harness];

  // Unknown harness or no probes declared → return one informational row
  if (!harnessEntry || !harnessEntry.capabilities || harnessEntry.capabilities.length === 0) {
    return {
      harness,
      mode: 'startup',
      rows: [],
      summary: {
        total: 0,
        pass: 0,
        degraded: 0,
        not_yet: 0,
        unknown: 0,
      },
    };
  }

  const rows = [];
  for (const cap of harnessEntry.capabilities) {
    rows.push(await invokeProbe(cap, opts));
  }
  return {
    harness,
    mode: 'startup',
    rows,
    summary: summarize(rows),
  };
}

export async function runPreAction(actionName, opts = {}) {
  const descriptor = opts.descriptor || loadDescriptor();
  const harness = opts.harness || detectConsumingHarness();
  const action = descriptor.consumer_actions?.[actionName];

  if (!action || actionName.startsWith('_')) {
    const declared = Object.keys(descriptor.consumer_actions || {}).filter(k => !k.startsWith('_'));
    throw new Error(`Unknown consumer action: '${actionName}'. Declared actions: ${declared.join(', ')}`);
  }

  const harnessEntry = descriptor.harnesses[harness];
  if (!harnessEntry || !harnessEntry.capabilities) {
    // Unknown harness — fail closed
    return {
      harness,
      mode: 'pre-action',
      action: actionName,
      permitted: false,
      block_reason: 'unknown-harness',
      rows: [],
      summary: { total: 0, pass: 0, degraded: 0, not_yet: 0, unknown: 0 },
    };
  }

  // Run only the capabilities this action requires
  const requiredIds = new Set(action.requires_pass || []);
  const relevantCaps = harnessEntry.capabilities.filter(c => requiredIds.has(c.capability_id));
  const rows = [];
  for (const cap of relevantCaps) {
    rows.push(await invokeProbe(cap, opts));
  }

  // Identify any required-but-undeclared capability
  const declaredIds = new Set(relevantCaps.map(c => c.capability_id));
  for (const reqId of requiredIds) {
    if (!declaredIds.has(reqId)) {
      rows.push({
        schema_version: SCHEMA_VERSION,
        capability_id: reqId,
        capability_name: reqId,
        capability_kind: 'unknown',
        identity_status: 'NOT-YET',
        mutation_permitted: false,
        mutation_block_reason: 'identity-not-yet',
        observed_at: new Date().toISOString(),
        harness,
        evidence: [{
          source: 'descriptor-walk',
          value: { reason: `harness '${harness}' has no declared probe for required capability '${reqId}'` },
          agrees_with_others: false,
          weight: 'conflicting',
        }],
      });
    }
  }

  const allPass = rows.length > 0 && rows.every(r => r.identity_status === 'PASS' && r.mutation_permitted);
  const blocking = rows.find(r => !r.mutation_permitted);

  return {
    harness,
    mode: 'pre-action',
    action: actionName,
    permitted: allPass,
    block_reason: allPass ? null : (blocking?.mutation_block_reason || 'no-rows'),
    rows,
    summary: summarize(rows),
  };
}

function summarize(rows) {
  const summary = { total: rows.length, pass: 0, degraded: 0, not_yet: 0, unknown: 0 };
  for (const r of rows) {
    if (r.identity_status === 'PASS') summary.pass++;
    else if (r.identity_status === 'DEGRADED') summary.degraded++;
    else if (r.identity_status === 'NOT-YET') summary.not_yet++;
    else if (r.identity_status === 'UNKNOWN') summary.unknown++;
  }
  return summary;
}

// ---------- CLI ----------

export async function main(argv) {
  const asJson = argv.includes('--json');
  const startupIdx = argv.indexOf('--startup');
  const preActionIdx = argv.indexOf('--pre-action');

  if (startupIdx === -1 && preActionIdx === -1) {
    process.stderr.write(`usage: capability-probe.mjs [--startup | --pre-action <name>] [--json]\n`);
    return 2;
  }

  let result;
  if (startupIdx !== -1) {
    result = await runStartup();
  } else {
    const actionName = argv[preActionIdx + 1];
    if (!actionName || actionName.startsWith('--')) {
      process.stderr.write(`error: --pre-action requires an action name\n`);
      return 2;
    }
    try {
      result = await runPreAction(actionName);
    } catch (e) {
      process.stderr.write(`error: ${e.message}\n`);
      return 2;
    }
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    const { harness, mode, rows, summary } = result;
    process.stdout.write(`capability-probe (mode=${mode}, harness=${harness})\n`);
    process.stdout.write(`  rows: ${summary.total} (PASS=${summary.pass} DEGRADED=${summary.degraded} NOT-YET=${summary.not_yet} UNKNOWN=${summary.unknown})\n`);
    for (const row of rows) {
      const gate = row.mutation_permitted ? 'allow' : `block (${row.mutation_block_reason})`;
      process.stdout.write(`  - ${row.capability_id}: ${row.identity_status} → ${gate}\n`);
    }
    if (mode === 'pre-action') {
      process.stdout.write(`  action: ${result.action} → ${result.permitted ? 'PERMITTED' : 'BLOCKED'}` +
        (result.block_reason ? ` (${result.block_reason})` : '') + '\n');
    }
  }

  // Exit codes:
  //   startup: always 0 (fail-open) unless internal error
  //   pre-action: 0 if permitted, 1 if blocked
  if (result.mode === 'pre-action' && !result.permitted) return 1;
  return 0;
}

// CLI entry guard
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
  const exit = await main(process.argv.slice(2));
  process.exit(exit);
}
