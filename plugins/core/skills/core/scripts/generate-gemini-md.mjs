/**
 * generate-gemini-md.mjs — v3.0 generator for Gemini's GEMINI.md from CONTRACT.md.
 * Thin wrapper over contract-format.mjs; see generate-claude-md.mjs for the shape.
 * Per DC-77 ships as a script; per DC-80 .mjs only.
 *
 * CLI: node generate-gemini-md.mjs --contract <CONTRACT.md> [--out <GEMINI.md>] [--override <f>] [--mode write|check|dry-run]
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateForHarness, HARNESS_OUTPUT } from './contract-format.mjs';

export const HARNESS = 'gemini';

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
  const r = await generate({ contractPath: opt('contract') || 'CONTRACT.md', outputPath: opt('out'), overridePath: opt('override'), mode: opt('mode') || 'dry-run' });
  (r.warnings || []).forEach((w) => process.stderr.write(`(warn) ${w}\n`));
  if ((opt('mode') || 'dry-run') === 'check') { (r.fatalErrors || []).forEach((e) => process.stderr.write(`(fatal) ${e}\n`)); process.stdout.write(r.fatal ? 'FAIL: CONTRACT.md has a fatal provenance issue\n' : (r.drift ? 'DRIFT: GEMINI.md diverged from CONTRACT.md\n' : 'OK: GEMINI.md matches CONTRACT.md\n')); process.exit((r.drift || r.fatal) ? 1 : 0); }
  else if ((opt('mode')) === 'write') process.stdout.write(`wrote ${r.written}\n`);
  else process.stdout.write(r.wouldWrite);
}
