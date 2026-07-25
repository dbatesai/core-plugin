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

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateForHarness, HARNESS_OUTPUT } from './contract-format.mjs';

export const HARNESS = 'claude-code';

export async function generate({ contractPath, outputPath, overridePath = null, mode = 'dry-run' }) {
  const out = outputPath || join(dirname(contractPath), HARNESS_OUTPUT[HARNESS]);
  return generateForHarness({ harness: HARNESS, contractPath, outputPath: out, overridePath, mode });
}

function isMain() {
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
}

if (isMain()) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
  const contractPath = opt('contract') || 'CONTRACT.md';
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
