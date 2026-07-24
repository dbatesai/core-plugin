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
import { hashText, stampFiles } from './state-cache.mjs';
import { resolveWorkspaceId } from './log-event.mjs';
import { runTurnCaptureRetention, purgeTurnCapture, turnCaptureDir, TURN_CAPTURE_RETENTION_DAYS } from './turn-capture.mjs';
import { resolveStoragePath } from './log-event.mjs';
import { shouldComputeScorecard, computeScorecard, appendScorecard } from './scorecard.mjs';
import { regradeNewestRound } from './self-test-round.mjs';

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
 * @param {{ apply?: boolean, now?: string, home?: string }} opts
 * @returns {{ ranOps: string[], notes: string[], unitsChanged: boolean, narration: string }}
 */
export function runMaintenance(projectPath, { apply = true, now = new Date().toISOString(), home } = {}) {
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
      // Stamp the state cache for every generated file this pass actually
      // rewrites, in the same operation as the write (Hale's finding,
      // 2026-07-22 — same pattern decorate-graph.mjs and hot-section.mjs
      // use: a script that rewrites a file on the user's behalf must record
      // that in code, not rely on the agent remembering to update the cache
      // by hand). These files are fully machine-generated with no
      // human-authored region to preserve, so a plain whole-file hash is
      // enough — no marker-delimited-block split needed here.
      const stampEntries = [];

      const decisionsPath = join(mem, 'INDEX-decisions.md');
      const decisionsText = buildDecisionsIndex(mem);
      atomicWriteFileSync(decisionsPath, decisionsText);
      stampEntries.push({ path: decisionsPath, hash: hashText(decisionsText), lastWrittenBy: 'maintenance-run' });

      const risksPath = join(mem, 'INDEX-risks.md');
      const risksText = buildRisksIndex(mem);
      atomicWriteFileSync(risksPath, risksText);
      stampEntries.push({ path: risksPath, hash: hashText(risksText), lastWrittenBy: 'maintenance-run' });

      generateSummaryIndex(root);
      const summaryPath = join(mem, '_lib', 'unit-summaries.json');
      try {
        stampEntries.push({ path: summaryPath, hash: hashText(readFileSync(summaryPath, 'utf8')), lastWrittenBy: 'maintenance-run' });
      } catch { /* best-effort: a stamp we can't compute never blocks the regen itself */ }

      const stampOutcome = stampFiles(root, stampEntries, { now, home });
      // Truthful stamp-failure surfacing (Hale's point 6): the indexes wrote
      // but their attribution stamp didn't. These are machine-generated files
      // with no human region, so it's lower-stakes than a mixed-ownership
      // write — but still report it rather than claim a clean maintenance run.
      if (stampOutcome && stampOutcome.stamped === false) {
        notes.push(`index attribution stamp failed (${stampOutcome.outcome}: ${stampOutcome.reason}) — recovery-required`);
      }
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

  // 3.5 Turn-capture retention (v3.14.0 evidence stream). Deletes CORE's OWN
  // captured rows older than the 30-day window — scoped strictly to
  // <metrics-storage-base>/turn-capture/ by turn-capture.mjs's own path
  // assertions; it never touches user memory units or PROJECT.md. Honors
  // dry-run: apply:false reports what WOULD be deleted and removes nothing.
  try {
    const tc = runTurnCaptureRetention(root, { apply, now, windowDays: TURN_CAPTURE_RETENTION_DAYS, workspaceId: resolveWorkspaceId(root) });
    if (tc.ran) {
      if (apply && tc.deleted.length) {
        ranOps.push('turn-capture-retention');
        notes.push(`turn-capture retention: deleted ${tc.deleted.length} row file(s) older than ${tc.windowDays}d (cutoff ${tc.cutoff})${tc.verified ? ', verified gone' : ' — WARNING: some deletions unverified'}`);
      } else if (!apply && tc.candidates.length) {
        notes.push(`turn-capture retention (dry-run): ${tc.candidates.length} row file(s) older than ${tc.windowDays}d would be deleted (cutoff ${tc.cutoff})`);
      } else if (apply && !tc.verified) {
        notes.push('turn-capture retention: some deletions unverified — recovery-required');
      }
    }
  } catch (e) {
    notes.push(`turn-capture retention skipped (${String(e && e.message).slice(0, 60)})`);
  }

  // 3.6 One-release sweep: remove any leftover rich-context stream from the
  // retired opt-in mechanism (superseded by turn-capture, v3.14.0 — dc-127
  // closed by construction). The dirname is asserted before deletion, same
  // boundary discipline as every deletion op here. Remove this block in v3.15.0.
  if (apply) {
    try {
      const base = resolveStoragePath(root, { workspaceId: resolveWorkspaceId(root) });
      const legacyDir = join(base, 'rich-context');
      const legacyLock = join(base, '.rich-context.lock');
      if (existsSync(legacyDir)) {
        rmSync(legacyDir, { recursive: true, force: true });
        rmSync(legacyLock, { force: true });
        notes.push('removed the retired rich-context stream (superseded by turn-capture)');
      }
    } catch (e) {
      notes.push(`rich-context legacy sweep skipped (${String(e && e.message).slice(0, 60)})`);
    }
  }

  // 3.7 Scorecard computation (v3.14.0 Link 3): pin one immutable conclusions
  // row when a judgment or self-test result postdates the last pinned card.
  // Gated by shouldComputeScorecard (no new inputs → silent skip); failure
  // never blocks the pass.
  if (apply) {
    try {
      if (shouldComputeScorecard(root)) {
        const card = computeScorecard(root, { now });
        const pinRes = appendScorecard(root, card);
        if (pinRes.written) {
          ranOps.push('scorecard-computation');
          notes.push(`scorecard pinned: ${card.hindsight.judged_turns} judged turn(s), self-test headline ${card.self_test.headline ?? 'n/a'}`);
        } else {
          notes.push(`scorecard pin failed (${pinRes.reason})`);
        }
      }
    } catch (e) {
      notes.push(`scorecard computation skipped (${String(e && e.message).slice(0, 60)})`);
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

// Cheap, best-effort re-grading of the newest registered self-test round —
// rides this CLI's cadence (invoked unconditionally at startup, /finalize, and
// /process-memory per hygiene.md/startup.md) since that IS the DC-110
// maintenance cadence the redesign spec (§3d) wires it into. Deliberately
// scoped to this CLI entry point, not the synchronous in-process
// runMaintenance() export close-pass.mjs calls directly from the headless
// SessionEnd close — folding it in there would mean making that whole
// synchronous close chain async, a much larger and riskier change than this
// additive feature warrants. Skipped entirely on --dry-run (it's a real
// append, not a report). Never null-returns without a reason: no registered
// round is a normal, silent no-op (nothing to regrade yet).
async function autoRegradeSelfTest(projectPath, { dryRun }) {
  if (dryRun) return null;
  try {
    const record = await regradeNewestRound(projectPath);
    if (!record) return null;
    const pct = record.headline == null ? '—' : `${Math.round(record.headline * 100)}%`;
    return { note: `self-test round ${record.round} re-graded automatically: headline ${pct}`, record };
  } catch (e) {
    return { note: `self-test auto-regrade skipped (${String(e && e.message || e).slice(0, 80)})`, record: null };
  }
}

async function main(argv) {
  const json = argv.includes('--json');
  const dryRun = argv.includes('--dry-run');
  const projectPath = argv.find(a => !a.startsWith('--'));
  if (!projectPath) { process.stderr.write('usage: maintenance-run.mjs <projectPath> [--json] [--dry-run] [--purge-turn-capture]\n'); return 2; }

  // --purge-turn-capture: destructive, explicit, and standalone (never part of
  // a routine run). The confirmation contract is prose-level — the
  // SKILL/protocol require an explicit user ask before this is invoked; the
  // flag does the mechanical part only, behind turn-capture.mjs's
  // directory-name assertion so it can only ever remove
  // <storage-base>/turn-capture/. Respects --dry-run.
  if (argv.includes('--purge-turn-capture')) {
    const res = purgeTurnCapture(projectPath, { apply: !dryRun, workspaceId: resolveWorkspaceId(projectPath) });
    if (json) process.stdout.write(JSON.stringify(res) + '\n');
    else if (res.purged) process.stdout.write(`Purged the turn-capture evidence stream: ${res.dir}\n`);
    else if (res.reason === 'dry-run') process.stdout.write(`Would purge the turn-capture evidence stream: ${res.dir}\n`);
    else process.stdout.write(`Turn-capture purge did not run: ${res.reason} (${res.dir})\n`);
    return res.purged || res.reason === 'dry-run' ? 0 : 2;
  }

  const res = runMaintenance(projectPath, { apply: !dryRun });
  const regrade = await autoRegradeSelfTest(projectPath, { dryRun });
  if (json) process.stdout.write(JSON.stringify({ ...res, self_test_regrade: regrade }) + '\n');
  else process.stdout.write(res.narration + (regrade ? ' ' + regrade.note + '.' : '') + '\n');
  return 0;
}

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
