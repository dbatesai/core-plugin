/**
 * orphan-detector.mjs — definition-of-done enforcement for the plugin.
 *
 * CORE kept building mechanisms and never wiring them in (the "last-mile" debt:
 * metrics-init, adversarial-run-gate, generate-agents-md, clusters.md — a fifth
 * example, instruction-surface-adapter.mjs, was never wired and has since been
 * removed rather than kept staged). The rule adopted to stop it: a mechanism isn't done until a skill
 * invokes it AND a test asserts the wiring. This script is the standing check.
 *
 * It flags two kinds of orphan:
 *   1. A `scripts/**.mjs` OR `hooks/*.mjs` file that nothing reaches — not named
 *      in any skill/protocol/reference `.md` or hook manifest (`hooks.json`,
 *      `hooks-codex.json` — the ACTUAL registration surface for a hook entry
 *      point, prose is not how a hook gets invoked), and not imported
 *      (transitively) by a file that IS reached.
 *   2. A `protocols/*.md` file not listed in the SKILL.md protocol index (so it
 *      never loads).
 *
 * Deliberately-staged forward-wiring (built ahead of its consumer on purpose) is
 * NOT neglect. Such items go on ALLOWLIST with a documented reason and a pointer
 * to the decision that gates their activation. The detector still PRINTS them every
 * run so they stay visible and don't rot silently — "tracked, not forgotten."
 *
 * Logged gap, fixed 2026-07-19 (Antigravity's catch during the D1 security fix,
 * 2026-07-18): hook files were entirely absent from the scan, so a scripts/
 * utility imported ONLY from a hook was structurally invisible to the import
 * closure, and genuine hook-level dead code could accumulate unflagged. Hook
 * files are now scanned symmetrically with scripts/, seeded as wired from
 * BOTH hook manifests (not skill prose), with their import edges followed the
 * same way. No currently-shipped file changed reachability status — this
 * closes a structural blind spot, not a live incident.
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only.
 *
 * CLI:  node orphan-detector.mjs [--core-root <dir>] [--json]
 *   exit 0 — no un-allowlisted orphans (allowlisted items still printed)
 *   exit 1 — new orphan(s) found (wire it or allowlist it with a reason)
 */

import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, dirname, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Scripts built ahead of their consumer on purpose. Each entry carries the
// reason, the date it was allowlisted, and a reviewBy date — when reviewBy
// passes, the detector flags the entry REVIEW OVERDUE so deliberate staging
// can't rot into permanent exemption (MEM-017). Reviewed at /finalize.
export const ALLOWLIST = Object.freeze({
  'retrieval-harness.mjs': {
    reason: 'Offline Recall@K gold harness (DC-113 Tier-A T1; arms trimmed to model-free per DC-114) — the measurement instrument, not a runtime-wired retrieval path. Consumed by its test and by the DC-115 measurement ceremony. Wire into the forthcoming stats/validation surface when that lands; until then it is a measurement utility like score-ladder.mjs.',
    allowlistDate: '2026-07-07',
    reviewBy: '2026-10-07',
  },
});

// Back-compat: callers (and older trees) may still pass string-form entries.
function allowlistEntry(allowlist, name) {
  const raw = allowlist[name];
  if (!raw) return null;
  return typeof raw === 'string' ? { reason: raw, allowlistDate: null, reviewBy: null } : raw;
}

function walk(dir, ext, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, ext, out);
    else if (e.name.endsWith(ext)) out.push(full);
  }
  return out;
}

export function resolveCoreRoot({ coreRootArg, scriptUrl } = {}) {
  if (coreRootArg) return coreRootArg;
  const here = scriptUrl ? dirname(fileURLToPath(scriptUrl)) : dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..'); // scripts -> core -> skills -> <plugin root>
}

/**
 * Find orphans under a plugin root.
 * @returns {{orphanScripts: string[], orphanProtocols: string[], allowlisted: string[], wiredCount: number, scriptCount: number}}
 */
export function findOrphans({ coreRoot, allowlist = ALLOWLIST, today = new Date() } = {}) {
  const skillsDir = join(coreRoot, 'skills');
  const scriptsRoot = join(coreRoot, 'skills', 'core', 'scripts');
  const hooksRoot = join(coreRoot, 'skills', 'core', 'hooks');

  const scripts = walk(scriptsRoot, '.mjs');
  // Logged gap (2026-07-18, Antigravity's catch during the D1 security fix):
  // the transitive-closure walk used to only follow scripts/*.mjs import
  // chains, so a scripts/ utility imported ONLY from a hook file was
  // structurally invisible — allowlisted rather than fixed, to avoid
  // scope-creeping that security patch. Fixed here: hook files are scanned
  // for imports the same way scripts are, so a hook-only import chain is
  // followed correctly, and a hook file itself is now a checkable object
  // (genuine hook-level dead code no longer accumulates unflagged).
  const hookFiles = walk(hooksRoot, '.mjs');
  const allMjs = [...scripts, ...hookFiles];

  // The surfaces that reach a script in production: prose the agent reads (.md)
  // AND data files that name scripts for dynamic dispatch (.json — e.g. the
  // capability descriptor's `delegate` fields invoke `capability/*.mjs`). Tests
  // are excluded — a script referenced only by a test is dormant in production.
  const docs = [...walk(skillsDir, '.md'), ...walk(skillsDir, '.json')];
  // Hook entry points are reached via the hook MANIFESTS (hooks.json for
  // Claude, hooks-codex.json for Codex), which live in a `hooks/` dir
  // SIBLING to `skills/` — never scanned by the skillsDir walk above. Without
  // this, every hook file would read as unreachable regardless of the import
  // fix, since skill/protocol/reference prose is not how a hook gets invoked.
  const hookManifests = [join(coreRoot, 'hooks', 'hooks.json'), join(coreRoot, 'hooks', 'hooks-codex.json')];
  const docText = [...docs.map(safeRead), ...hookManifests.map(safeRead)].join('\n');

  // Import graph: which file imports which (relative ./X.mjs or ../X.mjs).
  const importsOf = new Map(); // basename -> Set of imported basenames
  for (const s of allMjs) {
    const src = safeRead(s);
    const imported = new Set();
    const re = /(?:import[^'"]*from\s*|import\(\s*)['"]([^'"]+\.mjs)['"]/g;
    let m;
    while ((m = re.exec(src))) imported.add(basename(m[1]));
    importsOf.set(basename(s), imported);
  }

  // Seed: files named in skill/protocol/reference prose OR a hook manifest
  // (by full basename). Match on a boundary, not a bare substring: a plain
  // includes('init.mjs') would falsely mark init.mjs reachable just because
  // the prose mentions metrics-init.mjs.
  const wired = new Set();
  const boundary = (name) => new RegExp(`(^|[^\\w.-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`);
  for (const s of allMjs) {
    const name = basename(s);
    if (boundary(name).test(docText)) wired.add(name);
  }
  // Transitive closure: anything imported by a wired file is wired.
  let grew = true;
  while (grew) {
    grew = false;
    for (const [scriptName, imps] of importsOf) {
      if (!wired.has(scriptName)) continue;
      for (const imp of imps) {
        if (!wired.has(imp) && importsOf.has(imp)) { wired.add(imp); grew = true; }
      }
    }
  }

  const orphanScripts = [];
  const allowlisted = [];
  const staleAllowlisted = [];
  const todayIso = today.toISOString().slice(0, 10);
  for (const s of allMjs) {
    const name = basename(s);
    if (wired.has(name)) continue;
    const entry = allowlistEntry(allowlist, name);
    if (entry) {
      allowlisted.push(name);
      if (entry.reviewBy && entry.reviewBy < todayIso) staleAllowlisted.push(name);
      continue;
    }
    orphanScripts.push(relative(coreRoot, s));
  }

  // Protocols not in the SKILL.md index.
  const skillMd = safeRead(join(coreRoot, 'skills', 'core', 'SKILL.md'));
  const protocolsDir = join(coreRoot, 'skills', 'core', 'protocols');
  const orphanProtocols = [];
  for (const p of walk(protocolsDir, '.md')) {
    const rel = `protocols/${basename(p)}`;
    if (!skillMd.includes(rel)) orphanProtocols.push(relative(coreRoot, p));
  }

  return {
    orphanScripts,
    orphanProtocols,
    allowlisted,
    staleAllowlisted,
    wiredCount: wired.size,
    scriptCount: allMjs.length,
  };
}

function safeRead(p) { try { return readFileSync(p, 'utf8'); } catch { return ''; } }

export function formatReport(r) {
  const L = [];
  L.push(`orphan-detector — ${r.wiredCount}/${r.scriptCount} scripts reachable`);
  if (r.allowlisted.length) {
    L.push('');
    L.push('Allowlisted (deliberately-staged forward-wiring — still tracked):');
    for (const a of r.allowlisted) {
      const entry = allowlistEntry(ALLOWLIST, a);
      const reason = entry ? entry.reason : '(allowlisted by caller)';
      const stale = r.staleAllowlisted && r.staleAllowlisted.includes(a)
        ? '  ⚠ REVIEW OVERDUE — re-justify or wire/retire' : '';
      L.push(`  ~ ${a} — ${reason}${stale}`);
    }
  }
  if (r.orphanScripts.length || r.orphanProtocols.length) {
    L.push('');
    L.push('ORPHANS (wire it + assert the wiring in a test, or allowlist with a reason):');
    for (const s of r.orphanScripts) L.push(`  ✖ script  ${s}`);
    for (const p of r.orphanProtocols) L.push(`  ✖ protocol ${p} — not in the SKILL.md protocol index, so it never loads`);
  } else {
    // Scope-honest closing line: this detector
    // proves FILE-level reachability minus the allowlist — it does not check
    // function-level wiring inside reachable files, and allowlisted entries are
    // deliberate exceptions, not reachable mechanisms.
    const allow = (r.allowlisted && r.allowlisted.length) || 0;
    L.push(`No un-allowlisted orphans. File-level reachability holds${allow ? ` (${allow} allowlisted exception${allow === 1 ? '' : 's'} carried, each with a reason above)` : ''}; function-level wiring is not checked here.`);
  }
  return L.join('\n');
}

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
  const coreRoot = resolveCoreRoot({ coreRootArg: opt('core-root') });
  const r = findOrphans({ coreRoot });
  if (argv.includes('--json')) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else process.stdout.write(formatReport(r) + '\n');
  process.exit(r.orphanScripts.length + r.orphanProtocols.length > 0 ? 1 : 0);
}
