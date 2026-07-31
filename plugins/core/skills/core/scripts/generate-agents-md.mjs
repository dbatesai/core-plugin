/**
 * generate-agents-md.mjs — v3.0 generator for Codex's AGENTS.md from CONTRACT.md.
 * Thin wrapper over contract-format.mjs; see generate-claude-md.mjs for the shape.
 * Ships with the plugin as a script; .mjs only.
 *
 * CLI: node generate-agents-md.mjs --contract <CONTRACT.md> [--out <AGENTS.md>] [--override <f>] [--mode write|check|dry-run]
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateForHarness, HARNESS_OUTPUT } from './contract-format.mjs';
import { isCliEntry } from './cli-entry.mjs';

export const HARNESS = 'codex';

export async function generate({ contractPath, outputPath, overridePath = null, mode = 'dry-run' }) {
  // A missing CONTRACT.md is the common case for Codex projects today: a folder
  // can have CLAUDE.md (or neither) and no adopted contract yet. Skip cleanly
  // rather than letting parseContract's readFileSync throw an uncaught ENOENT —
  // that crash is what blocked configure-project from wiring this in. Guard ONLY
  // the absent case: a present-but-malformed contract (bad frontmatter, missing
  // required fields) must still throw loudly so a real authoring error surfaces.
  if (!contractPath || !existsSync(contractPath)) {
    return { skipped: true, reason: 'no-contract', contractPath: contractPath || null };
  }
  const out = outputPath || join(dirname(contractPath), HARNESS_OUTPUT[HARNESS]);
  return generateForHarness({ harness: HARNESS, contractPath, outputPath: out, overridePath, mode });
}

if (isCliEntry(import.meta.url)) {
  // Async IIFE — NOT a top-level await. A module with top-level await is an async ESM
  // module; one of those in an import chain perturbs node:test's per-file evaluation on
  // Windows+Node20 (configure-project.test.mjs exited 1 with every assertion passing).
  // Keeping the CLI body off the module's top level makes this module synchronous.
  (async () => {
    const args = process.argv.slice(2);
    const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
    const r = await generate({ contractPath: opt('contract') || 'CONTRACT.md', outputPath: opt('out'), overridePath: opt('override'), mode: opt('mode') || 'dry-run' });
    if (r.skipped) { process.stdout.write(`SKIP: no CONTRACT.md at ${r.contractPath ?? '(unset)'} — AGENTS.md not generated\n`); process.exit(0); }
    (r.warnings || []).forEach((w) => process.stderr.write(`(warn) ${w}\n`));
    if ((opt('mode') || 'dry-run') === 'check') { (r.fatalErrors || []).forEach((e) => process.stderr.write(`(fatal) ${e}\n`)); process.stdout.write(r.fatal ? 'FAIL: CONTRACT.md has a fatal provenance issue\n' : (r.drift ? 'DRIFT: AGENTS.md diverged from CONTRACT.md\n' : 'OK: AGENTS.md matches CONTRACT.md\n')); process.exit((r.drift || r.fatal) ? 1 : 0); }
    else if ((opt('mode')) === 'write') process.stdout.write(`wrote ${r.written}\n`);
    else process.stdout.write(r.wouldWrite);
  })();
}
