/**
 * maintenance-run.mjs — narrated, cadence-ledgered mechanical memory maintenance (DC-110).
 *
 * The mechanical half of memory upkeep, separated from the judgment half (graduation,
 * retire calls) that stays in /process-memory. Runs the cheap deterministic ops —
 * index regeneration, summary-index freshness, ghost-duplicate cleanup, PROJECT.md
 * cap check — gated on a durable signature so it only does work when the units actually
 * changed since last run. Records what ran in <store>/_memories/_maintenance-state.json
 * (the cadence ledger), and returns a narration string so the run is VISIBLE, never
 * silent (honors visible-continuous-curation). This is NOT a per-turn Stop hook: DC-110
 * is ledger-first — observe real cadence, then decide whether unattended runs are
 * warranted. Autonomous/unattended operation is gated behind the preconditions in
 * hygiene.md §"Autonomous maintenance" (deterministic clear-cut gate, kill switch,
 * per-change audit log) and is deliberately not built here.
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only.
 *
 * CLI: node maintenance-run.mjs <projectPath> [--json] [--dry-run]
 */

import { readFileSync, existsSync, statSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { buildIndex as buildDecisionsIndex } from './generate-decisions-index.mjs';
import { buildIndex as buildRisksIndex } from './generate-risks-index.mjs';
import { generateSummaryIndex, computeSourceSignature } from './generate-summary-index.mjs';

// Matches compact-project.mjs SOFT_TARGET_BYTES — the soft cap PROJECT.md should stay under.
export const PROJECT_SOFT_CAP_BYTES = 70000;

// Remove `<name> 2.md` cloud-sync conflict duplicates that exactly match their original.
// (Mirrors /process-memory Step 2.5; verification-before-delete is load-bearing — never
// remove a ghost whose content differs from the original.)
function cleanGhosts(memoriesDir, apply) {
  const removed = [];
  let entries;
  try { entries = readdirSync(memoriesDir); } catch { return removed; }
  for (const name of entries) {
    if (!/ 2\.md$/.test(name)) continue;
    const ghost = join(memoriesDir, name);
    const original = join(memoriesDir, name.replace(/ 2\.md$/, '.md'));
    if (!existsSync(original)) continue; // a genuinely different file, not a dup — leave it
    try {
      if (readFileSync(ghost, 'utf8') === readFileSync(original, 'utf8')) {
        if (apply) rmSync(ghost);
        removed.push(name);
      }
    } catch { /* unreadable — leave for human */ }
  }
  return removed;
}

/**
 * @param {string} projectPath
 * @param {{ apply?: boolean, now?: string }} opts
 * @returns {{ ranOps: string[], notes: string[], unitsChanged: boolean, narration: string }}
 */
export function runMaintenance(projectPath, { apply = true, now = new Date().toISOString() } = {}) {
  const root = resolve(projectPath);
  const mem = join(root, '_memories');
  const ledgerPath = join(mem, '_maintenance-state.json');

  let ledger = {};
  if (existsSync(ledgerPath)) {
    try { ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')); } catch { ledger = {}; }
  }

  const ranOps = [];
  const notes = [];

  // 1. Ghost cleanup — always (cheap). A removal changes the store, so it forces a regen.
  const ghosts = cleanGhosts(mem, apply);
  if (ghosts.length) ranOps.push('ghost-cleanup');

  // 2. Index + summary regeneration — only when the unit set changed since last run.
  const sig = computeSourceSignature(root);
  const unitsChanged = ledger.last_sig !== sig || ghosts.length > 0;
  if (unitsChanged) {
    if (apply) {
      atomicWriteFileSync(join(mem, 'INDEX-decisions.md'), buildDecisionsIndex(mem));
      atomicWriteFileSync(join(mem, 'INDEX-risks.md'), buildRisksIndex(mem));
      generateSummaryIndex(root);
    }
    ranOps.push('decisions-index', 'risks-index', 'summary-index');
  }

  // 3. PROJECT.md cap check — always; surface only (compaction itself is its own gated op).
  const pmPath = join(root, 'PROJECT.md');
  if (existsSync(pmPath)) {
    const bytes = statSync(pmPath).size;
    if (bytes > PROJECT_SOFT_CAP_BYTES) {
      notes.push(`PROJECT.md is ${(bytes / 1000).toFixed(1)}KB, over the ~${PROJECT_SOFT_CAP_BYTES / 1000}KB soft cap — run compaction`);
    }
  }

  // 4. Update the cadence ledger (per-op run counts = the "observe cadence" data for DC-110 M2).
  const ops = (ledger.ops && typeof ledger.ops === 'object') ? ledger.ops : {};
  for (const op of ranOps) {
    const prev = ops[op] || { run_count: 0 };
    ops[op] = { last_run: now, run_count: (prev.run_count || 0) + 1 };
  }
  const newLedger = { last_run: now, last_sig: sig, ops };
  // Recompute sig AFTER ghost removal so the stored signature matches the on-disk store.
  if (ranOps.includes('ghost-cleanup')) newLedger.last_sig = computeSourceSignature(root);
  if (apply) atomicWriteFileSync(ledgerPath, JSON.stringify(newLedger, null, 2) + '\n');

  const narration = composeNarration(ranOps, notes);
  return { ranOps, notes, unitsChanged, narration };
}

function composeNarration(ranOps, notes) {
  const parts = [];
  if (!ranOps.length) parts.push('Memory already current — no unit changes since last maintenance.');
  else {
    const friendly = [];
    if (ranOps.includes('ghost-cleanup')) friendly.push('cleaned cloud-sync ghost duplicates');
    if (ranOps.includes('decisions-index')) friendly.push('regenerated indexes + summary index');
    parts.push('Kept memory current: ' + friendly.join('; ') + '.');
  }
  for (const n of notes) parts.push('Heads up: ' + n + '.');
  return parts.join(' ');
}

function main(argv) {
  const json = argv.includes('--json');
  const dryRun = argv.includes('--dry-run');
  const projectPath = argv.find(a => !a.startsWith('--'));
  if (!projectPath) { process.stderr.write('usage: maintenance-run.mjs <projectPath> [--json] [--dry-run]\n'); return 2; }
  const res = runMaintenance(projectPath, { apply: !dryRun });
  if (json) process.stdout.write(JSON.stringify(res) + '\n');
  else process.stdout.write(res.narration + '\n');
  return 0;
}

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
