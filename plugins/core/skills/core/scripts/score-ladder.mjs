/**
 * score-ladder.mjs — the obligation-3 acceptance scorer (DC-94b).
 *
 * Obligation 3 of the memory north-star: "remember what was said three weeks ago
 * and reason it into today's context." We measure that as RETRIEVAL-RECALL — did
 * the right weeks-ago unit surface in the top-N for a present-day hook — not by
 * judging the connection itself (that's the model's free job once context is right,
 * per A6). The four rungs climb from literal keyword overlap to a pure
 * world-knowledge leap:
 *
 *   literal     — keyword overlap (omega speedmaster sale → the speedmaster want)
 *   category    — genre leap, no shared keyword (speedmaster listing → "iconic chronograph")
 *   value       — value→instance leap (zenith el primero sale → "values heritage/firsts")
 *   crossdomain — different domain entirely (open-agenda hook → "try latest MoE")
 *
 * The fixture units live in CORE/_outputs/2026-06-27/fixtures/obligation3-store/.
 * Lexical recall (Task 8) is expected to clear rung 1 and miss rungs 2-3; the
 * reasoning prototype (Task 10) is what should bridge them. This module only does
 * the scoring math; the recall numbers are produced by those tasks.
 *
 * PROVISIONAL_BAR holds A8's starting thresholds. They are PROVISIONAL on purpose —
 * Gate G1: David ratifies the real bar; the autonomous run must not be sole author
 * of its own definition-of-done (R-1).
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TOP_N = 5;

// A8 provisional thresholds (Gate G1 — David sets the real bar).
export const PROVISIONAL_BAR = Object.freeze({
  literal: 1.0,
  category: 1.0,
  value: 0.6,
  crossdomain: 0.6,
});

// The four rungs: each a planted weeks-ago memory + a present-day hook + the unit
// id we expect to surface. expectId values match the committed fixture filenames.
export const RUNGS = Object.freeze([
  {
    rung: 'literal',
    hook: 'omega speedmaster sale email',
    expectId: 'want-omega-speedmaster-on-sale-wait',
    fixtureFile: 'want-omega-speedmaster-on-sale-wait.md',
  },
  {
    rung: 'category',
    hook: 'omega speedmaster professional listing',
    expectId: 'want-iconic-chronograph',
    fixtureFile: 'want-iconic-chronograph.md',
  },
  {
    rung: 'value',
    hook: 'zenith el primero on sale',
    expectId: 'values-heritage',
    fixtureFile: 'values-heritage.md',
  },
  {
    rung: 'crossdomain',
    hook: "what's left on our agenda?",
    expectId: 'try-latest-moe-qwen',
    fixtureFile: 'try-latest-moe-qwen.md',
  },
]);

/**
 * Score a ladder run.
 * @param {Object<string,string[]>} retrievedIdsByRung — rung name -> ordered list of retrieved unit ids
 * @returns {{ perRung: Object, recallAt5: Object, passesProvisionalBar: boolean }}
 */
export function scoreLadder(retrievedIdsByRung, { topN = TOP_N, bar = PROVISIONAL_BAR } = {}) {
  const perRung = {};
  const recallAt5 = {};
  let passesAll = true;

  for (const r of RUNGS) {
    const retrieved = Array.isArray(retrievedIdsByRung?.[r.rung]) ? retrievedIdsByRung[r.rung] : [];
    const topSlice = retrieved.slice(0, topN);
    const hit = topSlice.includes(r.expectId);
    // recall@N for a single expected id is binary (1 if surfaced in top-N, else 0).
    const recall = hit ? 1 : 0;
    perRung[r.rung] = { hit, recallAt5: recall, expectId: r.expectId, retrievedCount: retrieved.length };
    recallAt5[r.rung] = recall;
    if (recall < (bar[r.rung] ?? 1.0)) passesAll = false;
  }

  return { perRung, recallAt5, passesProvisionalBar: passesAll };
}

function main(argv) {
  // CLI is informational: print the rungs + the provisional bar so the harness
  // contract is inspectable. No retrieval here — Tasks 8/10 produce the numbers.
  void argv;
  console.log(JSON.stringify({ RUNGS, PROVISIONAL_BAR, TOP_N }, null, 2));
  return 0;
}

const _cliEntryCanonical = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_cliEntryCanonical(process.argv[1]) === _cliEntryCanonical(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
