/**
 * generate-harness-md.mjs — generate a harness instruction file (CLAUDE.md or
 * AGENTS.md) from CONTRACT.md. One generator for every harness; the only
 * per-harness facts live in the HARNESSES table below.
 *
 * Thin wrapper over contract-format.mjs (all logic + determinism live there).
 *
 * Modes: write | check | dry-run. `--mode check` exits 1 on drift (a hand edit),
 * so /cut-release can block a release when a generated file diverged from the
 * contract. Ships as a script with the plugin; .mjs only.
 *
 * CLI:
 *   node generate-harness-md.mjs --harness claude-code|codex --contract <CONTRACT.md>
 *        [--out <file>] [--override <file>] [--mode write|check|dry-run]
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateForHarness, HARNESS_OUTPUT } from './contract-format.mjs';
import { isCliEntry } from './cli-entry.mjs';

// Per-harness table. `missingContract` is the policy when CONTRACT.md is absent:
//   'error' — the file is expected; fail loudly (Claude Code projects adopt the contract).
//   'skip'  — absent is the common case; return { skipped } and exit 0 (Codex projects
//             often have CLAUDE.md or nothing and no adopted contract yet — the crash on
//             ENOENT here is what once blocked configure-project from wiring this in).
export const HARNESSES = {
  'claude-code': { output: HARNESS_OUTPUT['claude-code'], missingContract: 'error' },
  codex: { output: HARNESS_OUTPUT.codex, missingContract: 'skip' },
};

export function harnessOrThrow(name) {
  const h = HARNESSES[name];
  if (!h) throw new Error(`generate-harness-md: unknown harness "${name}" (expected one of ${Object.keys(HARNESSES).join(', ')})`);
  return h;
}

export async function generate({ harness, contractPath, outputPath, overridePath = null, mode = 'dry-run' }) {
  const h = harnessOrThrow(harness);
  if (!contractPath || !existsSync(contractPath)) {
    if (h.missingContract === 'skip') return { skipped: true, reason: 'no-contract', contractPath: contractPath || null, harness };
    // Library callers see the raw error on a bad path for the strict harness; the CLI
    // pre-checks the same condition to give one bounded diagnostic instead of a stack.
    throw Object.assign(new Error(`contract file not found: ${contractPath}`), { code: 'ENOENT' });
  }
  const out = outputPath || join(dirname(contractPath), h.output);
  return generateForHarness({ harness, contractPath, outputPath: out, overridePath, mode });
}

if (isCliEntry(import.meta.url)) {
  // Async IIFE — NOT a top-level await. A module with top-level await is an async ESM
  // module; one of those in an import chain perturbs node:test's per-file evaluation on
  // Windows+Node20. Keeping the CLI body off the module's top level keeps it synchronous.
  (async () => {
    const args = process.argv.slice(2);
    const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
    const harness = opt('harness');
    if (!harness || !HARNESSES[harness]) {
      process.stderr.write(`generate-harness-md: pass --harness ${Object.keys(HARNESSES).join('|')}\n`);
      process.exit(2);
    }
    const h = HARNESSES[harness];
    const contractPath = opt('contract') || 'CONTRACT.md';
    const mode = opt('mode') || 'dry-run';
    // CLI trust boundary: validate the contract file exists BEFORE any read, so an
    // empty, --help, or hostile invocation gets one named diagnostic — never a stack.
    if (!existsSync(contractPath)) {
      if (h.missingContract === 'skip') { process.stdout.write(`SKIP: no CONTRACT.md at ${String(contractPath).slice(0, 120)} — ${h.output} not generated\n`); process.exit(0); }
      process.stderr.write(`generate-harness-md: contract file not found: ${String(contractPath).slice(0, 120)} (pass --contract <CONTRACT.md>)\n`);
      process.exit(2);
    }
    const r = await generate({ harness, contractPath, outputPath: opt('out'), overridePath: opt('override'), mode });
    (r.warnings || []).forEach((w) => process.stderr.write(`(warn) ${w}\n`));
    if (mode === 'check') {
      (r.fatalErrors || []).forEach((e) => process.stderr.write(`(fatal) ${e}\n`));
      if (r.fatal) process.stdout.write('FAIL: CONTRACT.md has a fatal provenance issue (see above)\n');
      else process.stdout.write(r.drift ? `DRIFT: ${h.output} diverged from CONTRACT.md\n` : `OK: ${h.output} matches CONTRACT.md\n`);
      process.exit((r.drift || r.fatal) ? 1 : 0);
    } else if (mode === 'write') {
      process.stdout.write(`wrote ${r.written}\n`);
    } else {
      process.stdout.write(r.wouldWrite);
    }
  })();
}
