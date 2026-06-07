/**
 * configure-project.mjs — one-shot, idempotent project bootstrap + health check.
 *
 * The Codex equivalent of Claude Code's startup mandate: a returning Codex (or
 * Claude) session on a shared project folder runs this once to confirm the
 * install is sound, the store validates, workspace identity resolves, and the
 * harness's instruction surface (AGENTS.md) exists. Per DC-104 the project store
 * is harness-agnostic and the two harnesses co-exist on one folder; this script
 * is harness-neutral with a thin per-harness branch.
 *
 * Invoked by the `/configure-project` skill (skills/configure-project/SKILL.md)
 * and referenced as the Codex setup step in harnesses/codex.md.
 *
 * Idempotent. Default mode is REPORT-ONLY (--dry-run is implied): the only write
 * it ever performs is generating AGENTS.md, and only under --apply. Workspace
 * identity is detected, never mutated here (forking is startup's job).
 *
 *   node configure-project.mjs [--project <dir>] [--harness claude-code|codex]
 *                              [--apply] [--json] [--core-root <dir>]
 *
 * Per DC-77 ships as a script; per DC-80 .mjs only.
 *
 * ── The capability report is two-tier on purpose (JC-1) ──────────────────────
 * A node script can read what's CONFIGURED ON DISK and validate the store, but it
 * CANNOT see whether an MCP connector is actually reachable + authed THIS session
 * — that's agent/session context, not the filesystem. So the report splits:
 *   • script-visible : asserted by the script (manifests, store, configured MCP
 *                       servers found in a named file, capability-probe rows).
 *   • session-live   : the agent fills these in from the running session; the
 *                       script states the QUESTION, never a false answer.
 * "Configured in ~/.claude.json" is reported as declared-in-config, NOT as
 * verified-reachable. The script never asserts a capability it cannot check.
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { checkFork } from './workspace-fork-check.mjs';
import { iterActiveUnits, checkSchema, checkIntegrity, exitCode } from './check-units.mjs';
import { generate as generateAgentsMd } from './generate-agents-md.mjs';

// ── CORE_ROOT (the plugin root) ──────────────────────────────────────────────
// This script lives at <CORE_ROOT>/skills/core/scripts/configure-project.mjs, so
// the plugin root is three levels up from the scripts dir. An explicit override
// wins (tests, unusual installs).
export function resolveCoreRoot({ coreRootArg, scriptUrl } = {}) {
  if (coreRootArg) return resolve(coreRootArg);
  const here = scriptUrl ? dirname(fileURLToPath(scriptUrl)) : dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..');
}

// ── Harness detection (thin) ─────────────────────────────────────────────────
// Mirrors capability-probe's consuming-harness signals without importing its
// startup machinery. Codex sets CODEX_* env; default to claude-code.
export function detectHarness(env = process.env) {
  if (env.CORE_HARNESS) return env.CORE_HARNESS;
  if (env.CODEX_PLUGIN_ROOT || env.CODEX_HARNESS || env.CODEX_SANDBOX) return 'codex';
  return 'claude-code';
}

// ── Manifest / install presence (script-visible) ─────────────────────────────
export function checkManifests(coreRoot) {
  return {
    coreRoot,
    claudePlugin: existsSync(join(coreRoot, '.claude-plugin', 'plugin.json')),
    codexPlugin: existsSync(join(coreRoot, '.codex-plugin', 'plugin.json')),
    skillCoreDir: existsSync(join(coreRoot, 'skills', 'core')),
    claudeAdapter: existsSync(join(coreRoot, 'skills', 'core', 'harnesses', 'claude-code.md')),
    codexAdapter: existsSync(join(coreRoot, 'skills', 'core', 'harnesses', 'codex.md')),
  };
}

// ── Store validation (script-visible) ────────────────────────────────────────
// Composes check-units in-process. Replicates check-units main's no-units guard
// (the guard lives in main, NOT in the exported functions) so an empty/missing
// _memories/ reports honestly instead of slipping through as exit 0.
export function validateStore(projectPath, today = new Date()) {
  let memoriesDir = join(projectPath, '_memories');
  if (!existsSync(memoriesDir)) {
    // check-units falls back to treating the project dir itself as the store.
    if (existsSync(join(projectPath, 'workspace.json')) || hasUnitFiles(projectPath)) {
      memoriesDir = projectPath;
    } else {
      return { found: false, memoriesDir, unitCount: 0, exitTier: 3, noUnits: true, findings: [] };
    }
  }
  const units = iterActiveUnits(memoriesDir);
  if (!units.length) {
    return { found: true, memoriesDir, unitCount: 0, exitTier: 3, noUnits: true, findings: [] };
  }
  const findings = [];
  checkSchema(units, memoriesDir, findings);
  checkIntegrity(units, memoriesDir, today, findings);
  return {
    found: true,
    memoriesDir,
    unitCount: units.length,
    exitTier: exitCode(findings),
    noUnits: false,
    findings: findings.map((f) => ({ level: f.level, check: f.check })),
  };
}

function hasUnitFiles(dir) {
  try {
    return readdirSync(dir).some((f) => f.endsWith('.md') && !f.startsWith('_') && !f.startsWith('INDEX'));
  } catch { return false; }
}

// ── Workspace identity (script-visible, detect-only) ─────────────────────────
// Always dry-run: configure-project REPORTS the identity decision; it never
// mutates identity (the fork mutation is startup's job). Wrapped in its
// own try/catch because we import checkFork directly, bypassing the CLI main's
// error wrapper.
export function detectIdentity(projectPath, coreDir, now = new Date()) {
  try {
    const r = checkFork({ cwd: projectPath, coreDir, now, dryRun: true });
    if (r.action === 'error') return { status: 'error', detail: r.error };
    if (r.action === 'would-fork') return { status: 'would-fork', original_id: r.original_id, new_id: r.new_id };
    return { status: 'returning-or-new', reason: r.reason, workspace_id: r.workspace_id || null };
  } catch (e) {
    return { status: 'error', detail: e.message };
  }
}

// ── Configured MCP connectors (script-visible: DECLARED-in-config, not verified) ─
// JC-1: read the RIGHT file per harness and frame the result as "checked <file>,
// found N" — never assert absence as "no connectors". Whether a configured server
// is reachable+authed this session is session-live (agent-reported), not here.
export function readConfiguredMcp(projectPath, harness, home = homedir()) {
  if (harness === 'codex') {
    // Codex configures MCP in ~/.codex/config.toml (TOML). We don't bundle a TOML
    // parser (dependency-free per DC-80), so we DON'T claim to have read the
    // server list — we report the file's presence and defer the list to the
    // session-live tier. Reporting "0 servers" here would be the false-absence bug.
    const cfg = join(home, '.codex', 'config.toml');
    return { harness, source: cfg, checked: false, servers: null,
      note: existsSync(cfg) ? 'config.toml present; server list is session-live (not parsed)'
                            : 'no ~/.codex/config.toml found; server list is session-live' };
  }
  // Claude Code: mcpServers live in ~/.claude.json (top-level + per-project).
  const claudeJson = join(home, '.claude.json');
  if (!existsSync(claudeJson)) {
    return { harness, source: claudeJson, checked: false, servers: null, note: 'no ~/.claude.json found' };
  }
  try {
    const d = JSON.parse(readFileSync(claudeJson, 'utf8'));
    const names = new Set(Object.keys(d.mcpServers || {}));
    const proj = (d.projects || {})[resolve(projectPath)] || (d.projects || {})[projectPath];
    for (const k of Object.keys(proj?.mcpServers || {})) names.add(k);
    return { harness, source: claudeJson, checked: true, servers: [...names].sort(),
      note: `checked ~/.claude.json: ${names.size} mcpServers configured (declared in config, not verified reachable)` };
  } catch (e) {
    return { harness, source: claudeJson, checked: false, servers: null, note: `~/.claude.json unparseable: ${e.message}` };
  }
}

// ── Optional project-local connector map (B5 extension point) ────────────────
// CORE ships NO connector-map (connector specifics are overlay-owned — see
// source-registration-framework.md §"What CORE does NOT ship"). configure-project
// only READS a map an overlay/project may provide and reports it.
export function readConnectorMap(projectPath) {
  const p = join(projectPath, 'connector-map.json');
  if (!existsSync(p)) return { present: false, path: p, count: 0 };
  try {
    const d = JSON.parse(readFileSync(p, 'utf8'));
    const count = Array.isArray(d) ? d.length : Object.keys(d.connectors || d || {}).length;
    return { present: true, path: p, count };
  } catch (e) {
    return { present: true, path: p, count: 0, error: e.message };
  }
}

// ── AGENTS.md (B6a, guarded on CONTRACT.md — JC-3) ───────────────────────────
// The common case for a Codex project today is NO CONTRACT.md → skip cleanly.
// Generate only under --apply AND when CONTRACT.md exists. Reports, never crashes.
export async function planAgentsMd(projectPath, { apply = false } = {}) {
  const contractPath = join(projectPath, 'CONTRACT.md');
  const agentsPath = join(projectPath, 'AGENTS.md');
  if (!existsSync(contractPath)) {
    return { status: 'skipped-no-contract', contractPath, agentsPath, present: existsSync(agentsPath) };
  }
  if (!apply) {
    return { status: existsSync(agentsPath) ? 'present-would-refresh' : 'would-generate', contractPath, agentsPath };
  }
  const r = await generateAgentsMd({ contractPath, outputPath: agentsPath, mode: 'write' });
  // The existsSync above already proved the contract present, so r.skipped can only
  // fire if CONTRACT.md vanished between the check and the read (TOCTOU) — report it
  // as that, not the duplicate 'skipped-no-contract' the precheck already returns.
  if (r.skipped) return { status: 'skipped-contract-vanished', contractPath, agentsPath };
  return { status: 'generated', contractPath, agentsPath, written: r.written || agentsPath };
}

// ── Assemble the structured report ───────────────────────────────────────────
export async function configureProject({
  projectPath, coreRoot, harness, apply = false,
  home = homedir(), today = new Date(), probe = null,
} = {}) {
  const proj = resolve(projectPath);
  const coreDir = join(home, '.core');

  const manifests = checkManifests(coreRoot);
  const store = validateStore(proj, today);
  const identity = detectIdentity(proj, coreDir, today);
  const mcp = readConfiguredMcp(proj, harness, home);
  const connectorMap = readConnectorMap(proj);
  const agentsMd = await planAgentsMd(proj, { apply });

  let probeRows = null;
  if (probe) {
    try { probeRows = await probe({ coreRoot, harness }); }
    catch (e) { probeRows = { error: e.message }; }
  }

  return {
    schema: 'configure-project/1',
    project: proj, harness, coreRoot, apply,
    scriptVisible: { manifests, store, identity, mcp, connectorMap, agentsMd, probeRows },
    sessionLive: [
      'Are the configured MCP connectors actually reachable + authed THIS session? (script can only see config on disk)',
      harness === 'codex'
        ? 'Codex ~/.codex/config.toml server list (not parsed by this script).'
        : 'Any session-scoped MCP servers not written to ~/.claude.json.',
      'Live two-harness validation (open this same folder from the other harness) — the remaining external check.',
    ],
  };
}

// ── Plain-voice receipt ──────────────────────────────────────────────────────
const TIER = { 0: 'pass', 1: 'degraded (non-blocking)', 2: 'hard-fail', 3: 'no units found' };

export function formatReceipt(r) {
  const sv = r.scriptVisible;
  const L = [];
  L.push(`configure-project — ${r.project}`);
  L.push(`harness: ${r.harness}${r.apply ? '' : '  (report-only; pass --apply to write AGENTS.md)'}`);
  L.push('');
  L.push('Script-visible (checked from disk):');
  const m = sv.manifests;
  L.push(`  install: core-root ${m.skillCoreDir ? 'ok' : 'MISSING'}` +
    `  · .claude-plugin ${m.claudePlugin ? 'y' : 'n'} · .codex-plugin ${m.codexPlugin ? 'y' : 'n'}` +
    ` · codex-adapter ${m.codexAdapter ? 'y' : 'n'}`);
  L.push(`  store: ${sv.store.noUnits ? 'no units found' : `${sv.store.unitCount} units, ${TIER[sv.store.exitTier]}`}` +
    (sv.store.findings.length ? ` (${sv.store.findings.length} findings)` : ''));
  L.push(`  identity: ${describeIdentity(sv.identity)}`);
  L.push(`  mcp (configured, not verified): ${sv.mcp.note}`);
  if (sv.mcp.servers?.length) L.push(`    → ${sv.mcp.servers.join(', ')}`);
  L.push(`  connector-map: ${sv.connectorMap.present ? `${sv.connectorMap.count} mappings (overlay-provided)` : 'none (CORE ships none — overlay-owned)'}`);
  L.push(`  AGENTS.md: ${describeAgents(sv.agentsMd)}`);
  if (sv.probeRows && !sv.probeRows.error) L.push(`  capability-probe: ${summarizeProbe(sv.probeRows)}`);
  else if (sv.probeRows?.error) L.push(`  capability-probe: unavailable (${sv.probeRows.error})`);
  L.push('');
  L.push('Session-live (agent confirms — NOT asserted by this script):');
  for (const q of r.sessionLive) L.push(`  • ${q}`);
  return L.join('\n');
}

function describeIdentity(id) {
  if (id.status === 'would-fork') return `would fork (copied pointer from ${id.original_id}) — run /core to register as ${id.new_id}`;
  if (id.status === 'error') return `could not resolve (${id.detail})`;
  if (id.reason === 'path-match') return `returning workspace${id.workspace_id ? ` (${id.workspace_id})` : ''}`;
  if (id.reason === 'no-pointer' || id.reason === 'no-index') return 'new / unregistered (no pointer or index yet)';
  if (id.reason === 'unregistered-id') return 'pointer id not in index — new registration';
  return id.reason || 'resolved';
}

function describeAgents(a) {
  switch (a.status) {
    case 'skipped-no-contract': return `skipped — no CONTRACT.md (common case)${a.present ? '; existing AGENTS.md left as-is' : ''}`;
    case 'would-generate': return 'CONTRACT.md present, AGENTS.md absent — would generate (pass --apply)';
    case 'present-would-refresh': return 'CONTRACT.md + AGENTS.md present — would refresh (pass --apply)';
    case 'generated': return `generated ${a.written}`;
    default: return a.status;
  }
}

function summarizeProbe(rows) {
  if (Array.isArray(rows)) return `${rows.length} rows`;
  if (rows.summary) return JSON.stringify(rows.summary);
  return 'ran';
}

// ── CLI ──────────────────────────────────────────────────────────────────────
export async function main(argv) {
  const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
  const has = (n) => argv.includes(`--${n}`);

  const projectPath = opt('project') || process.cwd();
  const coreRoot = resolveCoreRoot({ coreRootArg: opt('core-root') });
  const harness = opt('harness') || detectHarness();
  const apply = has('apply');

  // Best-effort capability probe; never blocks. Imported lazily so a probe-side
  // failure can't stop the rest of the report.
  const probe = async ({ harness: h }) => {
    try {
      const { runStartup } = await import('./capability-probe.mjs');
      return await runStartup({ harnessOverride: h });
    } catch (e) { return { error: e.message }; }
  };

  const report = await configureProject({ projectPath, coreRoot, harness, apply, probe });

  if (has('json')) { process.stdout.write(JSON.stringify(report, null, 2) + '\n'); }
  else { process.stdout.write(formatReceipt(report) + '\n'); }

  // Exit code mirrors the store tier but never hard-fails on a degraded store at
  // setup time (a fresh/migrating store with orphans must not block). 2 only on a
  // schema/enum/broken-edge hard fail.
  const tier = report.scriptVisible.store.exitTier;
  return tier === 2 ? 2 : 0;
}

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1]) === _canon(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
