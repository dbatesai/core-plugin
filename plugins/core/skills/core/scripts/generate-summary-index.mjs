/**
 * generate-summary-index.mjs — build <store>/_memories/_lib/unit-summaries.json,
 * one compact { id, path, type, tier, summary, topics, status, updated } record per
 * ACTIVE unit, walked RECURSIVELY (v3.11 premise: index every eligible note; nested
 * trees like observations/<YYYY-MM>/ are part of the retrieval population).
 *
 * Each record carries `path` (relative to _memories/, forward slashes) — consumers
 * (bm25.mjs bodies, retrieve-context.mjs edge expansion) MUST resolve files through
 * it and never reconstruct `_memories/<id>.md`, which is wrong for nested units.
 * `tier` labels authority ('observation' for raw capture, 'canonical' otherwise) so
 * retrieval results never flatten raw observations into graduated truth unlabeled
 * (Hale 2026-07-11 §2). Tier is a label on every result; ranking policy between
 * tiers is a ceremony question, decided on measurement, not hardcoded here.
 *
 * The shared compact index behind DC-94a retrieval (retrieve-context.mjs) and the
 * DC-94b abstract-relevance prototype (select-relevant-units.mjs). One responsibility:
 * render the index. No scoring, no retrieval — those read this file. loadFreshIndex()
 * below is the ONE validating loader every consumer uses (freshness on every call —
 * a stale index resurrecting a retired unit is an anti-resurrection breach).
 *
 * Parser choice (DC-94a, deviates from the build plan on purpose): the plan named
 * frontmatter-flat.mjs, but that flat parser silently DROPS multi-line `topics:` lists
 * (it skips every indented line). topics is load-bearing for the downstream retrieval
 * scorers, so this uses priority.mjs's canonical parseFrontmatter via loadUnit, which
 * parses lists. The flat parser would have shipped an index with empty topics.
 *
 * Per DC-77 the script ships with the plugin. Per DC-80 the plugin ships .mjs only.
 *
 * CLI:
 *   node generate-summary-index.mjs <storePath>
 *   node generate-summary-index.mjs --store <storePath>
 */

import { readdirSync, statSync, mkdirSync, realpathSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadUnit, isInvalidated } from './priority.mjs';
import { atomicWriteFileSync } from './fs-atomic.mjs';

export const SUMMARY_MAX = 240;

// A candidate unit file is any *.md not starting with `_` or `INDEX` (mirrors the
// generation filter below). Shared so the signature covers exactly the file set the
// index is built from.
function isCandidateName(name) {
  return name.endsWith('.md') && !name.startsWith('_') && !name.startsWith('INDEX');
}

// Directories the recursive walk descends into: anything not starting with `_`
// (skips _lib, _validation) — same convention as the file filter.
function isCandidateDir(name) {
  return !name.startsWith('_');
}

/**
 * Recursive candidate-file walk. Returns [{ rel, full, mtimeMs }] where `rel` is the
 * path relative to _memories/ with forward slashes on every platform (the index's
 * `path` field and the signature both use it, so the two stay in lockstep).
 * Deterministic order (sorted per directory level).
 */
function walkCandidateFiles(memoriesDir) {
  const out = [];
  const walkDir = (dir, relPrefix) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.isDirectory()) {
        if (isCandidateDir(e.name)) walkDir(join(dir, e.name), relPrefix + e.name + '/');
        continue;
      }
      if (!e.isFile() || !isCandidateName(e.name)) continue;
      const full = join(dir, e.name);
      let st;
      try { st = statSync(full); } catch { continue; }
      out.push({ rel: relPrefix + e.name, full, mtimeMs: st.mtimeMs });
    }
  };
  walkDir(memoriesDir, '');
  return out;
}

/**
 * computeSourceSignature — a cheap freshness fingerprint of the store's source units.
 * Sorted `relpath:mtimeMs` over candidate files, RECURSIVE (a nested observation's
 * edit must invalidate the cache exactly like a top-level unit's — a flat signature
 * over a recursive index would go silently stale). NO frontmatter parsing, so it's
 * safe to run on every retrieval. Changes when a unit is added, deleted, or edited
 * in place (including a retire, which bumps the file's mtime) — the three cases that
 * must invalidate the cached index. Tradeoff (DC-94b R1): a cloud-sync touch that
 * bumps mtime without a content change triggers one benign regen — cheaper than
 * hashing every file's content on every turn, and the regen is atomic + idempotent.
 * @returns {string}
 */
export function computeSourceSignature(storePath) {
  const memoriesDir = join(resolve(storePath), '_memories');
  return walkCandidateFiles(memoriesDir).map(f => `${f.rel}:${f.mtimeMs}`).sort().join('|');
}

/**
 * loadFreshIndex — THE validating index loader. Reads the cached index when its
 * source_sig matches the store's current recursive signature; regenerates otherwise.
 * Every consumer (retrieve-context, bm25, select-relevant-units, the harness) loads
 * through this, so no public entry point can serve a stale index — the standalone
 *-bm25Rank-resurrects-a-retired-unit defect (Hale 2026-07-11 §4) is closed here,
 * at the loader, not per-caller.
 */
export function loadFreshIndex(storePath) {
  const root = resolve(storePath);
  const indexPath = join(root, '_memories', '_lib', 'unit-summaries.json');
  if (existsSync(indexPath)) {
    try {
      const idx = JSON.parse(readFileSync(indexPath, 'utf8'));
      if (idx && Array.isArray(idx.units) && idx.source_sig !== undefined &&
          idx.source_sig === computeSourceSignature(root) &&
          // A pre-v3.11 cache (no per-unit path) must regenerate once so path-driven
          // consumers never fall back to reconstructing top-level-only locations.
          (idx.units.length === 0 || idx.units[0].path !== undefined)) {
        return idx;
      }
    } catch { /* fall through to regenerate */ }
  }
  return generateSummaryIndex(root);
}

// First `# ` heading stripped, else first non-blank non-heading line. Mirrors
// generate-decisions-index.mjs extractSummary so the index reads the same shape.
export function deriveSummary(body) {
  for (const line of body.split('\n')) {
    const s = line.trim();
    if (s.startsWith('# ')) return s.slice(2).trim();
  }
  for (const line of body.split('\n')) {
    const s = line.trim();
    if (s && !s.startsWith('#') && !s.startsWith('---')) return s;
  }
  return '';
}

function truncate(text, maxLen = SUMMARY_MAX) {
  const t = String(text ?? '');
  return t.length <= maxLen ? t : t.slice(0, maxLen - 1).trimEnd() + '…';
}

// Active = status missing or literally 'active'. Anything else (retired, archived,
// superseded, cold) is excluded from the retrieval surface.
function isActive(fm) {
  const s = fm.status === undefined || fm.status === null ? 'active' : String(fm.status).trim().toLowerCase();
  return s === 'active' || s === '';
}

function asTopicList(topics) {
  if (Array.isArray(topics)) return topics.map(String);
  if (topics === undefined || topics === null || topics === '') return [];
  return [String(topics)];
}

// Authority tier from the unit's declared type (fallback: filename prefix). Raw
// capture (observations) is a lower-authority recall channel than graduated units;
// the tier travels with every index record so no retrieval surface can flatten them.
function authorityTier(fm, rel) {
  const typ = String(fm.type || '').toLowerCase();
  if (typ === 'observation') return 'observation';
  if (!typ && /(^|\/)obs-/.test(rel)) return 'observation';
  return 'canonical';
}

export function generateSummaryIndex(storePath) {
  const memoriesDir = join(resolve(storePath), '_memories');
  const now = new Date();
  const units = [];
  const seenIds = new Map(); // id -> rel path that claimed it (first wins, sorted walk)
  for (const f of walkCandidateFiles(memoriesDir)) {
    let unit;
    try { unit = loadUnit(f.full); } catch { continue; }
    const fm = unit.fm || {};
    if (!isActive(fm)) continue;
    // Also exclude units whose validity dimension is invalid as of now — the
    // status check alone missed a `status: active` unit with a past t_invalid,
    // which then leaked into per-turn retrieval (the read path this index feeds).
    if (isInvalidated(unit, now)) continue;
    if (seenIds.has(unit.id)) {
      process.stderr.write(`warn: duplicate unit id '${unit.id}' at ${f.rel} — first occurrence (${seenIds.get(unit.id)}) kept, this file excluded from the index\n`);
      continue;
    }
    seenIds.set(unit.id, f.rel);
    units.push({
      id: unit.id,
      path: f.rel,
      type: String(fm.type || ''),
      tier: authorityTier(fm, f.rel),
      summary: truncate(deriveSummary(unit.body || '')),
      topics: asTopicList(fm.topics),
      status: fm.status === undefined ? 'active' : String(fm.status),
      updated: fm.updated ? String(fm.updated).slice(0, 10) : (fm.created ? String(fm.created).slice(0, 10) : ''),
    });
  }
  units.sort((a, b) => a.id.localeCompare(b.id));
  const out = { count: units.length, generated: '', source_sig: computeSourceSignature(storePath), units };

  const libDir = join(memoriesDir, '_lib');
  try { mkdirSync(libDir, { recursive: true }); } catch { /* ignore */ }
  atomicWriteFileSync(join(libDir, 'unit-summaries.json'), JSON.stringify(out, null, 2) + '\n');
  return out;
}

function main(argv) {
  const args = argv.filter(a => a !== '--store');
  const storePath = args[0] || '.';
  const res = generateSummaryIndex(storePath);
  console.log(`Wrote ${join(resolve(storePath), '_memories', '_lib', 'unit-summaries.json')} (${res.count} active units)`);
  return 0;
}

// CLI entry guard (matches generate-decisions-index.mjs). CORE_DEBUG_CLI_ENTRY=1 logs both
// resolved paths if the invocation silently no-ops (symlink/OneDrive path-normalization).
const _cliEntryCanonical = (p) => { try { return realpathSync(p); } catch { return p; } };
const _cliEntryArgv1 = _cliEntryCanonical(process.argv[1]);
const _cliEntrySelf = _cliEntryCanonical(fileURLToPath(import.meta.url));
if (process.env.CORE_DEBUG_CLI_ENTRY) {
  process.stderr.write(`[cli-entry] argv[1]=${JSON.stringify(_cliEntryArgv1)}\n[cli-entry] self  =${JSON.stringify(_cliEntrySelf)}\n[cli-entry] match=${_cliEntryArgv1 === _cliEntrySelf}\n`);
}
if (_cliEntryArgv1 === _cliEntrySelf) {
  process.exit(main(process.argv.slice(2)));
}
