/**
 * generate-claude-md.mjs — v3.0 generator for Claude Code's CLAUDE.md from CONTRACT.md.
 *
 * Thin wrapper over contract-format.mjs (all logic + determinism live there). The agents-md
 * generator is the same wrapper with a different harness name — the only
 * per-harness facts are the name and the output filename (HARNESS_OUTPUT).
 *
 * Modes: write | check | dry-run. `--check` exits 1 on drift (a hand edit), so /cut-release
 * can block a release when a generated file diverged from the contract.
 *
 * Ships as a script with the plugin; .mjs only.
 *
 * CLI:
 *   node generate-claude-md.mjs --contract <CONTRACT.md> [--out <CLAUDE.md>]
 *        [--override <CLAUDE.md.override>] [--mode write|check|dry-run]
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateForHarness, HARNESS_OUTPUT } from './contract-format.mjs';
import { isCliEntry } from './cli-entry.mjs';

export const HARNESS = 'claude-code';

export async function generate({ contractPath, outputPath, overridePath = null, mode = 'dry-run' }) {
  const out = outputPath || join(dirname(contractPath), HARNESS_OUTPUT[HARNESS]);
  return generateForHarness({ harness: HARNESS, contractPath, outputPath: out, overridePath, mode });
}

if (isCliEntry(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
  const contractPath = opt('contract') || 'CONTRACT.md';
  // CLI trust boundary: validate the contract file exists BEFORE any read, so an
  // empty, --help, or hostile invocation gets one named diagnostic and a nonzero
  // exit — never an uncaught ENOENT stack. Library callers still see the raw
  // throw on a bad path; only the CLI pre-checks.
  if (!existsSync(contractPath)) {
    process.stderr.write(`generate-claude-md: contract file not found: ${String(contractPath).slice(0, 120)} (pass --contract <CONTRACT.md>)\n`);
    process.exit(2);
  }
  const outputPath = opt('out');
  const overridePath = opt('override');
  const mode = opt('mode') || 'dry-run';
  const r = await generate({ contractPath, outputPath, overridePath, mode });
  (r.warnings || []).forEach((w) => process.stderr.write(`(warn) ${w}\n`));
  if (mode === 'check') {
    (r.fatalErrors || []).forEach((e) => process.stderr.write(`(fatal) ${e}\n`));
    if (r.fatal) process.stdout.write('FAIL: CONTRACT.md has a fatal provenance issue (see above)\n');
    else process.stdout.write(r.drift ? 'DRIFT: CLAUDE.md diverged from CONTRACT.md\n' : 'OK: CLAUDE.md matches CONTRACT.md\n');
    process.exit((r.drift || r.fatal) ? 1 : 0);
  } else if (mode === 'write') {
    process.stdout.write(`wrote ${r.written}\n`);
  } else {
    process.stdout.write(r.wouldWrite);
  }
}
