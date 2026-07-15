/**
 * select-relevant-units.mjs — the recall-oriented candidate shortlist for the
 * abstract-relevance prototype (DC-94b, Gate G3).
 *
 * The design seam behind obligation-3: lexical retrieval (retrieve-context.mjs) is
 * cheap but can't bridge a value→instance leap ("heritage"→El Primero). The fix isn't
 * a better scorer — it's a two-step split: a CHEAP, recall-oriented shortlist (this
 * script) that errs toward including the right unit even when it scores low, then an
 * EXPENSIVE, reasoning-oriented selection (the agent, using world knowledge) over that
 * shortlist. This script only does the cheap half — it is deterministic and runs no LLM.
 *
 * Shortlist = union of (active units sharing ≥1 query token with their topics/summary)
 * and (the most-recently-updated active units), capped at `max`. When the store has
 * fewer active units than `max`, return all active — for a small store the right
 * recall move is "give the reasoner everything active." Retired units never appear.
 *
 * GATE G3: this ships as a flagged prototype scaffold + measured evidence. Whether the
 * reasoning tier becomes default retrieval infrastructure is David's call on the numbers.
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only.
 *
 * CLI: node select-relevant-units.mjs <storePath> "<query>" [--max N]
 */

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFreshIndex } from './generate-summary-index.mjs';
import { tokenize } from './bm25.mjs';

// loadFreshIndex validates the recursive source signature on every call. This
// module's old local loader accepted any parseable cache, which could serve a
// retired unit into the reasoning-tier shortlist — same defect class as the
// standalone-bm25 stale cache (Hale 2026-07-11 §4), closed at the shared loader.
const loadIndex = loadFreshIndex;

export function selectCandidates(query, storePath, { max = 30 } = {}) {
  const root = resolve(storePath);
  const units = loadIndex(root).units; // index already excludes retired/non-active
  const shape = (u) => ({ id: u.id, summary: u.summary, topics: u.topics || [] });

  // Small store: recall move is "include all active" — the reasoner sees everything.
  if (units.length <= max) {
    return units.slice().sort((a, b) => a.id.localeCompare(b.id)).map(shape);
  }

  const qTokens = new Set(tokenize(query));
  const overlaps = (u) => {
    const bag = new Set([...(u.topics || []).flatMap(t => tokenize(t)), ...tokenize(u.summary)]);
    for (const t of qTokens) if (bag.has(t)) return true;
    return false;
  };

  const chosen = new Map();
  // 1. topic/token overlap (the precision-ish slice)
  for (const u of units) if (overlaps(u)) chosen.set(u.id, u);
  // 2. recency fallback (the recall slice) — fill remaining budget with most-recent active
  const byRecency = units.slice().sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')) || a.id.localeCompare(b.id));
  for (const u of byRecency) { if (chosen.size >= max) break; if (!chosen.has(u.id)) chosen.set(u.id, u); }

  return [...chosen.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, max).map(shape);
}

function main(argv) {
  const args = argv.filter(a => a !== '--max');
  const maxIdx = argv.indexOf('--max');
  const max = maxIdx >= 0 ? Number(argv[maxIdx + 1]) || 30 : 30;
  const storePath = args[0];
  const query = args[1] || '';
  if (!storePath) { process.stderr.write('usage: select-relevant-units.mjs <storePath> "<query>" [--max N]\n'); return 2; }
  const cands = selectCandidates(query, storePath, { max });
  for (const c of cands) process.stdout.write(`${c.id} [${(c.topics || []).join(', ')}] — ${c.summary}\n`);
  return 0;
}

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
