/**
 * capability-probe.mjs — v2.6.0 capability probe runner.
 *
 * Reads `../schemas/harness-capability-descriptor.json` to determine which
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
import { resolvePluginRoot, detectConsumingHarnessSignal } from './resolve-plugin-root.mjs';

export const SCHEMA_VERSION = '1.0.0';
const DESCRIPTOR_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas', 'harness-capability-descriptor.json');

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

// Delegates to detectConsumingHarnessSignal in resolve-plugin-root.mjs to keep
// one canonical detection chain. That signal looks at *_PLUGIN_ROOT env vars
// first, then session-id env vars (CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID),
// and returns 'unknown' / 'not_exposed' when nothing is set. Order in resolve-
// plugin-root.mjs: CLAUDE_PLUGIN_ROOT > CODEX_PLUGIN_ROOT > GEMINI_PLUGIN_ROOT
// > CLAUDE_CODE_SESSION_ID > CODEX_THREAD_ID > unknown.
export function detectConsumingHarness(env = process.env) {
  return detectConsumingHarnessSignal(env).harness;
}

// ---------- Probe invocation ----------

// For v2.6.0-β, the only declared capability is `plugin-root-resolution` and
// every harness delegates it to resolve-plugin-root.mjs directly. This switch
// stays small; v2.7.0+ extends to per-harness probe scripts that emit multiple
// rows per harness.
async function invokeProbe(capability, opts = {}) {
  if (capability.delegate === 'resolve-plugin-root.mjs') {
    const row = resolvePluginRoot(opts);
    return { ...row, capability_id: capability.capability_id, capability_kind: capability.capability_kind };
  }
  // Sub-directory delegates — capability/*.mjs scripts (e.g. target-surface probes)
  if (capability.delegate && capability.delegate.startsWith('capability/')) {
    const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
    const delegatePath = join(SCRIPTS_DIR, capability.delegate);
    // opts._importer is a test seam (defaults to dynamic import) so the crash
    // and import-failure branches can be exercised without a shipping fixture.
    const importer = opts._importer || ((p) => import(p));
    let mod;
    try {
      mod = await importer(delegatePath);
    } catch (e) {
      // Delegate didn't load (file missing / not implemented yet) — NOT-YET, not a crash.
      return makeNotYetRow(capability, `delegate import failed: ${e.message}`);
    }
    try {
      const row = await mod.probe(opts);
      return { ...row, capability_id: capability.capability_id, capability_kind: capability.capability_kind };
    } catch (e) {
      // §7 probe-itself validation: a probe that threw mid-execution is UNKNOWN, not a
      // missing row. Surface the crash so it can never pass silently as absent.
      return makeUnknownRow(capability, e.message);
    }
  }
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

// §7 probe-itself validation: a delegate that threw during probe() execution.
// Distinct from NOT-YET (not implemented): the probe exists and ran but crashed,
// so we report UNKNOWN with an explicit probe_failed evidence entry rather than
// letting a silent crash read as a missing or passing row.
function makeUnknownRow(capability, errorMessage) {
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
    identity_status: 'UNKNOWN',
    mutation_permitted: false,
    mutation_block_reason: 'identity-unknown',
    evidence: [
      {
        source: 'probe-execution',
        value: { error: String(errorMessage).slice(0, 300), capability_id: capability.capability_id },
        agrees_with_others: false,
        weight: 'conflicting',
        probe_failed: true,
      },
    ],
  };
}

// ---------- Public API ----------

export async function runStartup(opts = {}) {
  const descriptor = opts.descriptor || loadDescriptor();
  const harness = opts.harness || detectConsumingHarness();
  // Thread descriptor AND the resolved harness through opts. Resolving harness BEFORE
  // building probeOpts is load-bearing: a delegated probe like memory-accessed reads
  // opts.harness to pick the transcript parser and to label its row. Building probeOpts
  // without it let the probe fall back to its 'claude-code' default and mislabel a Codex
  // session (HC blocker #1, evt-202605291319). The harness key is harmless to delegates
  // that ignore it (resolve-plugin-root, target-surface).
  const probeOpts = { ...opts, descriptor, harness };
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
    rows.push(await invokeProbe(cap, probeOpts));
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
  // Resolve harness before probeOpts and thread it through (see runStartup — HC blocker #1).
  const probeOpts = { ...opts, descriptor, harness };
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
    rows.push(await invokeProbe(cap, probeOpts));
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
        mutation_permitted: null,
        mutation_block_reason: null,
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

  // Operation-scoped mutation gate per HC critique evt-202605271310. Identity
  // PASS alone is NOT a mutation permit. Apply the action profile's
  // allowed_authorities, allowed_harnesses, and target_surface against each
  // identity row, producing a per-row mutation decision with a stable
  // mutation_block_reason code.
  const allowedAuthorities = action.allowed_authorities ? new Set(action.allowed_authorities) : null;
  const allowedHarnesses = action.allowed_harnesses ? new Set(action.allowed_harnesses) : null;
  const requiredSignalWeight = action.allowed_signal_weight || null;  // 'strong' | null

  for (const row of rows) {
    // Identity must be PASS for any mutation to proceed
    if (row.identity_status !== 'PASS') {
      row.mutation_permitted = false;
      row.mutation_block_reason = `identity-${String(row.identity_status).toLowerCase()}`;
      continue;
    }
    // Authority gate (stable enum code: 'authority_not_allowed')
    if (allowedAuthorities && !allowedAuthorities.has(row.authority)) {
      row.mutation_permitted = false;
      row.mutation_block_reason = 'authority_not_allowed';
      continue;
    }
    // Consuming-harness gate ('harness_mismatch' or 'consuming_harness_unknown')
    if (allowedHarnesses) {
      const consumingHarness = row.consuming_harness || row.harness;  // back-compat
      if (consumingHarness === 'unknown') {
        row.mutation_permitted = false;
        row.mutation_block_reason = 'consuming_harness_unknown';
        continue;
      }
      if (!allowedHarnesses.has(consumingHarness)) {
        row.mutation_permitted = false;
        row.mutation_block_reason = 'harness_mismatch';
        continue;
      }
    }
    // Signal-weight gate — when action requires 'strong', a weak-only signal is
    // insufficient for mutation. Weak signal (e.g. only CODEX_THREAD_ID) is
    // diagnostic but not authoritative enough for writes to shared surfaces.
    if (requiredSignalWeight === 'strong' && row.consuming_harness_signal_weight === 'weak') {
      row.mutation_permitted = false;
      row.mutation_block_reason = 'consuming_harness_signal_weak';
      continue;
    }
    // All gates passed for this row
    row.mutation_permitted = true;
    row.mutation_block_reason = null;
  }

  const allPermitted = rows.length > 0 && rows.every(r => r.mutation_permitted === true);
  const blocking = rows.find(r => r.mutation_permitted !== true);

  return {
    harness,
    mode: 'pre-action',
    action: actionName,
    permitted: allPermitted,
    block_reason: allPermitted ? null : (blocking?.mutation_block_reason || 'no-rows'),
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
      // Three states: true (gated allow), false (gated block), null (identity-only,
      // runner hasn't applied gating — that's the startup-mode shape).
      let gate;
      if (row.mutation_permitted === true) gate = 'allow';
      else if (row.mutation_permitted === false) gate = `block (${row.mutation_block_reason})`;
      else gate = 'identity-only (no mutation gate applied)';
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
