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
import { createHash } from 'node:crypto';
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
 * computeSourceSignature — a CONTENT-DERIVED freshness fingerprint of the store's
 * source units. Sorted `relpath:sha1(content)` over candidate files, RECURSIVE.
 * Content hashes, not mtimes, because anti-resurrection is an invariant: a unit
 * rewritten as retired with its original timestamp restored (editor telemetry,
 * cloud-sync restoration, deliberate tampering) MUST still invalidate the cache —
 * Hale's re-review demonstrated the mtime version serving exactly that retired
 * unit. Cost: reads every candidate file (~430 files ≈ a few MB) per validation —
 * the same order of work the BM25 body pass already does per call; measured in
 * the harness latency line, ceiling per the evaluation contract.
 * @returns {string}
 */
export function computeSourceSignature(storePath) {
  const memoriesDir = join(resolve(storePath), '_memories');
  const parts = [];
  for (const f of walkCandidateFiles(memoriesDir)) {
    let content;
    try { content = readFileSync(f.full); } catch { continue; }
    parts.push(`${f.rel}:${createHash('sha1').update(content).digest('hex')}`);
  }
  return parts.sort().join('|');
}

/**
 * Structural validation of a cached index — EVERY record, not a sample. A cache
 * is trustworthy only if each unit has a non-empty string id and a safe relative
 * path (no absolute paths, no `..` traversal, forward slashes, `.md`), and ids
 * are unique. Anything else → regenerate. (Hale re-review: validating only
 * units[0] let a partially path-less cache serve nested units from wrong paths.)
 */
export function validateIndexRecords(idx) {
  if (!idx || !Array.isArray(idx.units)) return false;
  const seen = new Set();
  for (const u of idx.units) {
    if (!u || typeof u.id !== 'string' || !u.id.trim()) return false;
    if (typeof u.path !== 'string' || !u.path.trim()) return false;
    if (u.path.startsWith('/') || u.path.includes('\\') || /^[a-zA-Z]:/.test(u.path)) return false;
    if (u.path.split('/').some(seg => seg === '..' || seg === '')) return false;
    if (!u.path.endsWith('.md')) return false;
    if (seen.has(u.id)) return false;
    seen.add(u.id);
  }
  return true;
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
      if (idx && idx.source_sig !== undefined &&
          idx.source_sig === computeSourceSignature(root) &&
          // Every record validated — id/path shape, path containment, uniqueness.
          // A partially-broken cache is regenerated, never partially trusted.
          validateIndexRecords(idx)) {
        return idx;
      }
    } catch { /* fall through to regenerate */ }
  }
  return generateSummaryIndex(root);
}

/**
 * loadSnapshot — the request-scoped, content-addressed store snapshot (Train A A3).
 * ONE load per retrieval request feeds every reader and scorer; the snapshot_id is
 * sha256 of the index's content-derived source signature, so two requests that saw
 * the same bytes report the same id and any store mutation changes it. Traces and
 * evidence receipts carry this id — a retrieval number without it is not reproducible.
 */
export function loadSnapshot(storePath, { captureBodies = false } = {}) {
  const index = loadFreshIndex(storePath);
  const snapshot = {
    index,
    snapshotId: createHash('sha256').update(index.source_sig || '').digest('hex'),
  };
  // Blocker 2 (Hale verdict §2): a measurement run captures BODY BYTES too, so no
  // evaluator reader ever touches live files after the id is minted. The id needs
  // no new input — source_sig is already content-derived over these same files —
  // capture just makes every reader consume the bytes the id describes.
  if (captureBodies) snapshot.bodies = loadUnitBodies(storePath, index);
  return snapshot;
}

/**
 * loadUnitBodies — ONE owner for the unit-body walk (bm25's loadActiveBodies
 * delegates here). Files resolve through the index's per-unit `path` — the only
 * correct location for nested units. Returns [{id, tier, text}] where text is
 * summary + topics + frontmatter-stripped body.
 */
export function loadUnitBodies(storePath, index) {
  const root = resolve(storePath);
  const out = [];
  for (const u of index.units) {
    const fpath = join(root, '_memories', ...(u.path ? u.path.split('/') : [`${u.id}.md`]));
    if (!existsSync(fpath)) continue;
    let raw;
    try { raw = readFileSync(fpath, 'utf8'); } catch { continue; }
    const body = raw.replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    const topics = (u.topics || []).join(' ');
    out.push({ id: u.id, tier: u.tier || 'canonical', text: `${u.summary}\n${topics}\n${body}`.trim() });
  }
  return out;
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
  // Collect ALL candidates first, then resolve duplicate ids deterministically —
  // authority-aware, never silent-lossy (Hale re-review §1: walk-order first-wins let
  // a nested observation shadow a canonical unit out of the index entirely).
  const candidates = [];
  for (const f of walkCandidateFiles(memoriesDir)) {
    let unit;
    try { unit = loadUnit(f.full); } catch { continue; }
    const fm = unit.fm || {};
    if (!isActive(fm)) continue;
    // Also exclude units whose validity dimension is invalid as of now — the
    // status check alone missed a `status: active` unit with a past t_invalid,
    // which then leaked into per-turn retrieval (the read path this index feeds).
    if (isInvalidated(unit, now)) continue;
    candidates.push({
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
  // Duplicate resolution: canonical outranks observation (an observation must never
  // shadow canonical truth); same-tier ties keep the lexicographically-first path.
  // Every conflict is recorded on the index itself — the store is DEGRADED until the
  // duplicate is fixed, and consumers (the hook, check surfaces) can say so loudly.
  const byId = new Map();
  const conflicts = [];
  for (const c of candidates) {
    const prev = byId.get(c.id);
    if (!prev) { byId.set(c.id, c); continue; }
    const rank = (u) => (u.tier === 'canonical' ? 0 : 1);
    const winner = rank(c) < rank(prev) || (rank(c) === rank(prev) && c.path < prev.path) ? c : prev;
    const loser = winner === c ? prev : c;
    byId.set(c.id, winner);
    conflicts.push({ id: c.id, kept: winner.path, excluded: loser.path });
    process.stderr.write(`DUPLICATE UNIT ID '${c.id}': kept ${winner.path} (${winner.tier}), excluded ${loser.path} (${loser.tier}) — the store is degraded until this is resolved\n`);
  }
  const units = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const out = {
    count: units.length,
    generated: '',
    source_sig: computeSourceSignature(storePath),
    degraded: conflicts.length > 0,
    duplicate_conflicts: conflicts,
    units,
  };

  const libDir = join(memoriesDir, '_lib');
  try { mkdirSync(libDir, { recursive: true }); } catch { /* ignore */ }
  atomicWriteFileSync(join(libDir, 'unit-summaries.json'), JSON.stringify(out, null, 2) + '\n');
  return out;
}

function main(argv) {
  const args = argv.filter(a => a !== '--store');
  const storePath = args[0] || '.';
  const res = generateSummaryIndex(storePath);
  console.log(`Wrote ${join(resolve(storePath), '_memories', '_lib', 'unit-summaries.json')} (${res.count} active units${res.degraded ? `; DEGRADED — ${res.duplicate_conflicts.length} duplicate-id conflict(s)` : ''})`);
  return res.degraded ? 1 : 0; // duplicate identity fails loudly, never silently
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
