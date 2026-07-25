/**
 * select-relevant-units.mjs — the recall-oriented candidate shortlist for the
 * abstract-relevance prototype (Gate G3).
 *
 * The design seam behind obligation-3: lexical retrieval (retrieve-context.mjs) is
 * cheap but can't bridge a value→instance leap ("heritage"→El Primero). The fix isn't
 * a better scorer — it's a two-step split: a CHEAP, recall-oriented shortlist (this
 * script) that errs toward including the right unit even when it scores low, then an
 * EXPENSIVE, reasoning-oriented selection (the agent, using world knowledge) over that
 * shortlist. This script only does the cheap half — it is deterministic and runs no LLM.
 *
 * The selector orders the whole active corpus once: full-body product ranking first,
 * then every unmatched active unit in deterministic id order. It partitions that
 * exhaustive order into bounded shards for the already-active Claude/Codex model to
 * reason over. No fixed shortlist can silently drop the gold unit as the corpus grows.
 * Retired and invalidated units never appear because the shared fresh index excludes them.
 *
 * GATE G3: promotion RATIFIED (2026-07-15). The 2026-07-17 scale repair
 * removes the unsafe 100-row ceiling, reuses the shipped full-body product scorer,
 * and wires an automatic no-hit directive from the per-turn hook. Queries with
 * lexical hits still rely on the active model to judge insufficiency and follow
 * the Tier 3 protocol; a deterministic layer cannot judge semantic sufficiency.
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only.
 *
 * CLI: node select-relevant-units.mjs <storePath> "<query>" [--shard N] [--shard-size N]
 */

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFreshIndex } from './generate-summary-index.mjs';
import { productRankedScores } from './retrieve-context.mjs';

// loadFreshIndex validates the recursive source signature on every call. This
// module's old local loader accepted any parseable cache, which could serve a
// retired unit into the reasoning-tier shortlist — same defect class as the
// standalone-bm25 stale cache, closed at the shared loader.
const loadIndex = loadFreshIndex;

function partitionCandidateShards(units, shardSize) {
  const shards = [];
  for (let offset = 0; offset < units.length; offset += shardSize) {
    shards.push(units.slice(offset, offset + shardSize));
  }
  return shards;
}

export function selectCandidateShards(query, storePath, { shardSize = 80 } = {}) {
  const root = resolve(storePath);
  const index = loadIndex(root);
  const unitsById = new Map(index.units.map((unit) => [unit.id, unit]));
  const ranked = productRankedScores(query, root, index)
    .map((hit) => unitsById.get(hit.id))
    .filter(Boolean);
  const rankedIds = new Set(ranked.map((unit) => unit.id));
  const fallback = index.units
    .filter((unit) => !rankedIds.has(unit.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const units = [...ranked, ...fallback];
  const shape = (u) => ({ id: u.id, summary: u.summary, topics: u.topics || [] });
  const shards = partitionCandidateShards(units, Math.max(1, shardSize));
  const out = [];
  let shardIndex = 0;
  for (const shard of shards) {
    out.push({
      shard: shardIndex,
      shard_count: shards.length,
      units_scanned: units.length,
      units_total: units.length,
      candidates: shard.map(shape),
    });
    shardIndex += 1;
  }
  return out;
}

// Production entry point. The historical name is retained for callers, but the
// return value is now the exhaustive shard plan — never a fixed-row shortlist.
export function selectCandidates(query, storePath, options = {}) {
  return selectCandidateShards(query, storePath, options);
}

function main(argv) {
  const valueFlag = (name, fallback) => {
    const at = argv.indexOf(name);
    return at >= 0 ? Number(argv[at + 1]) : fallback;
  };
  const flagIndexes = new Set();
  for (const name of ['--shard', '--shard-size']) {
    const at = argv.indexOf(name);
    if (at >= 0) { flagIndexes.add(at); flagIndexes.add(at + 1); }
  }
  const args = argv.filter((_, index) => !flagIndexes.has(index));
  const shard = Math.max(0, valueFlag('--shard', 0));
  const shardSize = Math.max(1, valueFlag('--shard-size', 80));
  const storePath = args[0];
  const query = args[1] || '';
  if (!storePath) { process.stderr.write('usage: select-relevant-units.mjs <storePath> "<query>" [--shard N] [--shard-size N]\n'); return 2; }
  const shards = selectCandidateShards(query, storePath, { shardSize });
  const selected = shards[shard];
  if (!selected) { process.stderr.write(`reasoning shard ${shard} is out of range (count=${shards.length})\n`); return 2; }
  process.stdout.write(`Reasoning shard ${shard + 1}/${selected.shard_count}; units_scanned=${selected.units_scanned}; units_total=${selected.units_total}\n`);
  for (const c of selected.candidates) process.stdout.write(`${c.id} [${(c.topics || []).join(', ')}] — ${c.summary}\n`);
  return 0;
}

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
