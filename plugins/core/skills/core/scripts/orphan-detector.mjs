/**
 * orphan-detector.mjs — definition-of-done enforcement for the plugin.
 *
 * CORE kept building mechanisms and never wiring them in (the "last-mile" debt:
 * metrics-init, adversarial-run-gate, instruction-surface-adapter, generate-agents-md,
 * clusters.md). The rule adopted to stop it: a mechanism isn't done until a skill
 * invokes it AND a test asserts the wiring. This script is the standing check.
 *
 * It flags two kinds of orphan:
 *   1. A `scripts/**.mjs` file that nothing reaches — not named in any skill/
 *      protocol/reference `.md` (the prose the agent reads to invoke it), and not
 *      imported (transitively) by a script that IS reached.
 *   2. A `protocols/*.md` file not listed in the SKILL.md protocol index (so it
 *      never loads).
 *
 * Deliberately-staged forward-wiring (built ahead of its consumer on purpose) is
 * NOT neglect. Such items go on ALLOWLIST with a documented reason and a pointer
 * to the decision that gates their activation. The detector still PRINTS them every
 * run so they stay visible and don't rot silently — "tracked, not forgotten."
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only.
 *
 * CLI:  node orphan-detector.mjs [--core-root <dir>] [--json]
 *   exit 0 — no un-allowlisted orphans (allowlisted items still printed)
 *   exit 1 — new orphan(s) found (wire it or allowlist it with a reason)
 */

import { readdirSync, readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join, dirname, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Scripts built ahead of their consumer on purpose. Each MUST carry a reason and,
// where relevant, the decision that gates activation. Reviewed at /finalize.
export const ALLOWLIST = Object.freeze({
  'instruction-surface-adapter.mjs':
    'Deliberately-staged v3.0 instruction-surface system (dry-run core; --apply is David-gated + content-generation not implemented). Activation is tied to the pending "does the contract→generator system still earn its complexity at N=2 surfaces" decision (PROJECT.md §State). Wire or retire when that decides.',
});

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
export function findOrphans({ coreRoot, allowlist = ALLOWLIST } = {}) {
  const skillsDir = join(coreRoot, 'skills');
  const scriptsRoot = join(coreRoot, 'skills', 'core', 'scripts');

  const scripts = walk(scriptsRoot, '.mjs');
  // The surfaces that reach a script in production: prose the agent reads (.md)
  // AND data files that name scripts for dynamic dispatch (.json — e.g. the
  // capability descriptor's `delegate` fields invoke `capability/*.mjs`). Tests
  // are excluded — a script referenced only by a test is dormant in production.
  const docs = [...walk(skillsDir, '.md'), ...walk(skillsDir, '.json')];
  const docText = docs.map((d) => safeRead(d)).join('\n');

  // Import graph: which script imports which (relative ./X.mjs or ../X.mjs).
  const importsOf = new Map(); // script basename -> Set of imported basenames
  for (const s of scripts) {
    const src = safeRead(s);
    const imported = new Set();
    const re = /(?:import[^'"]*from\s*|import\(\s*)['"]([^'"]+\.mjs)['"]/g;
    let m;
    while ((m = re.exec(src))) imported.add(basename(m[1]));
    importsOf.set(basename(s), imported);
  }

  // Seed: scripts named in skill/protocol/reference prose (by full basename).
  const wired = new Set();
  for (const s of scripts) {
    if (docText.includes(basename(s))) wired.add(basename(s));
  }
  // Transitive closure: anything imported by a wired script is wired.
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
  for (const s of scripts) {
    const name = basename(s);
    if (wired.has(name)) continue;
    if (allowlist[name]) { allowlisted.push(name); continue; }
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
    wiredCount: wired.size,
    scriptCount: scripts.length,
  };
}

function safeRead(p) { try { return readFileSync(p, 'utf8'); } catch { return ''; } }

export function formatReport(r) {
  const L = [];
  L.push(`orphan-detector — ${r.wiredCount}/${r.scriptCount} scripts reachable`);
  if (r.allowlisted.length) {
    L.push('');
    L.push('Allowlisted (deliberately-staged forward-wiring — still tracked):');
    for (const a of r.allowlisted) L.push(`  ~ ${a} — ${ALLOWLIST[a]}`);
  }
  if (r.orphanScripts.length || r.orphanProtocols.length) {
    L.push('');
    L.push('ORPHANS (wire it + assert the wiring in a test, or allowlist with a reason):');
    for (const s of r.orphanScripts) L.push(`  ✖ script  ${s}`);
    for (const p of r.orphanProtocols) L.push(`  ✖ protocol ${p} — not in the SKILL.md protocol index, so it never loads`);
  } else {
    L.push('No un-allowlisted orphans. Every shipped mechanism is reachable.');
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
