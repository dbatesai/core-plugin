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
import { isInvalidated, parseFrontmatter, extractEdges } from './priority.mjs';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { loadValidEnrichments } from './enrichment-sidecar.mjs';
import { truncate as sharedTruncate } from './text-truncate.mjs';
import { EDGES_BEGIN, EDGES_END } from './unit-vocab.mjs';

export const SUMMARY_MAX = 240;

// A candidate unit file is any *.md not starting with `_` or `INDEX` (mirrors the
// generation filter below). Shared so the signature covers exactly the file set the
// index is built from.
function isCandidateName(name) {
  return name.endsWith('.md') && !name.startsWith('_') && !name.startsWith('INDEX');
}

// Directories the recursive walk descends into: anything not starting with `_`
// (skips _lib, _validation) — same convention as the file filter. `archive/`
// is excluded by name (Hale's 2026-07-21 finding): a top-level retired unit
// is suppressed from active results by status, but an archived unit is a
// separate, physical relocation out of the active tree — before this
// exclusion the walk still descended into archive/, so the source signature
// and any consumer reading the raw walk (not just the status-filtered index)
// could still see archived content. Path exclusion is the actual boundary
// for archived units; status filtering is what does the job for retired ones.
function isCandidateDir(name) {
  return !name.startsWith('_') && name !== 'archive';
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
      // K04 (Hale's audit): source_sig is a pure content hash — it only changes
      // when file BYTES change, so a unit valid at generation time but past its
      // own t_invalid date now would keep serving from cache forever if nothing
      // else in the store happens to be edited. next_invalidation_at is the
      // earliest such date baked in at generation time; once `now` reaches it,
      // the cache is stale regardless of whether any byte has moved.
      const todayIso = new Date().toISOString().slice(0, 10);
      const timeStale = idx && idx.next_invalidation_at && todayIso >= idx.next_invalidation_at;
      if (idx && !timeStale && idx.source_sig !== undefined &&
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
export function loadSnapshot(storePath, { captureBodies = false, retainRaw = false } = {}) {
  // captureBodies → the ATOMIC capture: id, index, and bodies all derived from
  // one read per file (captureStore). The earlier two-walk version (index walk
  // first, body walk second) carried a TOCTOU Hale reproduced deterministically
  // in round 11: a concurrent write between the walks let snapshot_id identify
  // OLD bytes while the evaluator measured NEW ones. Never reintroduce a second
  // walk here.
  if (captureBodies) return captureStore(storePath, { retainRaw });
  // Index-only consumers (no body reads downstream) keep the cache-validated path.
  const index = loadFreshIndex(storePath);
  return {
    index,
    snapshotId: createHash('sha256').update(index.source_sig || '').digest('hex'),
  };
}

/**
 * stripGeneratedEdgesBlock — removes decorate-graph.mjs's generated
 * [[wikilink]] block before a body ever reaches BM25. The block is
 * CORE-generated metadata (unit ids, edge types), not content the unit is
 * actually about, and letting it into the ranked body would skew relevance
 * toward whatever a unit happens to link to rather than what it says.
 *
 * ONE definition, used by both loadUnitBodies (the index-only path) and
 * captureStore's body derivation (the atomic-snapshot path decorate-graph.mjs
 * and the live retriever/harness actually read) — Hale's 2026-07-21 finding:
 * the two body-derivation sites duplicated the frontmatter-strip transform,
 * and only one of them got the edges-block strip when it was first added.
 */
export function stripGeneratedEdgesBlock(body) {
  const beginIdx = body.indexOf(EDGES_BEGIN);
  const endIdx = body.indexOf(EDGES_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) return body;
  return (body.slice(0, beginIdx) + body.slice(endIdx + EDGES_END.length)).trim();
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
    const body = stripGeneratedEdgesBlock(raw.replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---\n?/, '').trim());
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

// Found while regression-testing the K-series UTF-8 byte-cap fix (retrieve-
// context-hook.mjs), 2026-07-19: this is the actual source of the corruption
// that fix's test caught (`.slice(0, maxLen - 1)` counted UTF-16 code units
// and could orphan a surrogate pair). An independent review the same day
// found two more hand-duplicated copies of this exact bug
// (generate-decisions-index.mjs, generate-risks-index.mjs) that a same-file
// fix here didn't reach — collapsed all three into text-truncate.mjs so
// there's no second copy left to drift.
export function truncate(text, maxLen = SUMMARY_MAX) {
  return sharedTruncate(text, maxLen);
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

/**
 * captureStore — THE atomic store capture (Hale round 11). Each candidate file is
 * read from disk EXACTLY ONCE; the source signature (→ snapshotId), the index
 * records, and the BM25 body texts are all derived from those same buffers.
 *
 * Why single-read is the invariant: the previous design computed the signature in
 * one walk and read index/bodies in others — Hale's deterministic reproduction
 * showed a concurrent write between walks makes snapshot_id identify OLD bytes
 * while the evaluator measures NEW bytes. With one read per file, the id and the
 * measured bytes cannot diverge for any file; a mutation mid-capture yields a
 * mixed state whose id correctly identifies exactly those captured bytes.
 * (Cross-file capture is still not one atomic instant — but the id is always the
 * id OF THE BYTES USED, which is the reproducibility contract.)
 *
 * retainRaw keeps the raw buffers + per-file sha1s on the result so tests can
 * assert the id↔bytes coherence directly under a concurrent-writer barrier.
 */
export function captureStore(storePath, { retainRaw = false } = {}) {
  const memoriesDir = join(resolve(storePath), '_memories');
  const now = new Date();
  let nextInvalidationAt = null; // K04: earliest still-future t_invalid among included candidates

  // ONE read per file.
  const raws = [];
  for (const f of walkCandidateFiles(memoriesDir)) {
    try { raws.push({ rel: f.rel, buf: readFileSync(f.full) }); } catch { /* vanished mid-walk */ }
  }

  // Identity from these exact buffers (same shape computeSourceSignature produces).
  const fileSha1s = {};
  const sourceSha256ByPath = {};
  const sigParts = [];
  for (const { rel, buf } of raws) {
    const h = createHash('sha1').update(buf).digest('hex');
    fileSha1s[rel] = h;
    sourceSha256ByPath[rel] = createHash('sha256').update(buf).digest('hex');
    sigParts.push(`${rel}:${h}`);
  }
  const source_sig = sigParts.sort().join('|');

  // Index candidates from the same buffers — identical semantics to the old
  // loadUnit path (parseFrontmatter is the same canonical parser).
  const candidates = [];
  const textByPath = new Map(); // winner-body derivation reads from here, never disk
  const fmByPath = new Map();   // winner-edge derivation reads from here, never disk
  for (const { rel, buf } of raws) {
    const text = buf.toString('utf8');
    let fm, body;
    try { [fm, body] = parseFrontmatter(text); } catch { continue; }
    fm = fm || {};
    fmByPath.set(rel, fm);
    const id = fm.id !== undefined ? String(fm.id) : basenameNoMd(rel);
    if (!isActive(fm)) continue;
    // Exclude units whose validity dimension is invalid as of now — the status
    // check alone missed a `status: active` unit with a past t_invalid, which
    // then leaked into per-turn retrieval (the read path this index feeds).
    if (isInvalidated({ id, fm, body }, now)) continue;
    // K04 (Hale's audit, 2026-07-16): the cache staleness check in loadFreshIndex
    // is byte-only (source_sig, a content hash) — it never re-fires just because
    // calendar time passed, so a unit included here as valid (t_invalid in the
    // future) silently keeps serving as valid past its own t_invalid date if no
    // file's bytes change in the meantime. Track the earliest such date so the
    // loader can force a regenerate once `now` reaches it, independent of content
    // hashing — anti-resurrection needs to be time-aware, not just byte-aware.
    if (fm.t_invalid && /^\d{4}-\d{2}-\d{2}/.test(String(fm.t_invalid))) {
      const iv = String(fm.t_invalid).slice(0, 10);
      if (!nextInvalidationAt || iv < nextInvalidationAt) nextInvalidationAt = iv;
    }
    textByPath.set(rel, text);
    candidates.push({
      id,
      path: rel,
      type: String(fm.type || ''),
      tier: authorityTier(fm, rel),
      summary: truncate(deriveSummary(body || '')),
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
  const index = {
    count: units.length,
    generated: '',
    source_sig,
    next_invalidation_at: nextInvalidationAt, // K04: forces a regenerate at this date even if bytes are unchanged
    degraded: conflicts.length > 0,
    duplicate_conflicts: conflicts,
    units,
  };

  // BM25 body texts AND typed edges for the WINNERS, from the SAME buffers
  // (body transform identical to loadUnitBodies: frontmatter stripped, summary +
  // topics prepended). Edges ride the capture (Hale round 12): edge expansion
  // used to re-read live unit files after the id was minted — a concurrent edge
  // change altered expanded/final results under an unchanged snapshot_id.
  const bodies = [];
  const edges = {};
  for (const u of units) {
    const text = textByPath.get(u.path);
    if (text === undefined) continue;
    const body = stripGeneratedEdgesBlock(text.replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---\n?/, '').trim());
    const topics = (u.topics || []).join(' ');
    bodies.push({ id: u.id, tier: u.tier || 'canonical', text: `${u.summary}\n${topics}\n${body}`.trim() });
    edges[u.id] = extractEdges({ fm: fmByPath.get(u.path) || {} });
  }

  // Enrichment is derived, separately weighted state. Only records whose
  // content hash matches the captured source bytes participate. Its digest is
  // part of the product snapshot identity so a retrieval result can never
  // change under an unchanged snapshot id.
  const enrichments = loadValidEnrichments(storePath, index, sourceSha256ByPath);
  const capture = {
    index,
    bodies,
    edges,
    enrichments,
    source_sha256_by_path: sourceSha256ByPath,
    snapshotId: createHash('sha256').update(`${source_sig}|enrichment:${enrichments.digest}`).digest('hex'),
  };
  if (retainRaw) {
    capture.raw = Object.fromEntries(raws.map(r => [r.rel, r.buf]));
    capture.file_sha1s = fileSha1s;
  }

  // Keep the on-disk cached index current for index-only consumers (the R1
  // anti-resurrection contract: unit-summaries.json regenerates when sources
  // change). Written only when absent or stale so an unchanged store never
  // rewrites (retrieval stays cheap), and written FROM the captured bytes —
  // a write after the single read adds no TOCTOU; the file describes exactly
  // this capture. Best-effort: a read-only store still returns a valid capture.
  try {
    const libPath = join(memoriesDir, '_lib', 'unit-summaries.json');
    let cached = null;
    try { cached = JSON.parse(readFileSync(libPath, 'utf8')); } catch { /* absent/corrupt */ }
    if (!cached || cached.source_sig !== source_sig) {
      mkdirSync(join(memoriesDir, '_lib'), { recursive: true });
      atomicWriteFileSync(libPath, JSON.stringify(index, null, 2) + '\n');
    }
  } catch { /* cache refresh is a convenience; the capture itself is complete */ }

  return capture;
}

function basenameNoMd(rel) {
  const name = rel.split('/').pop() || rel;
  return name.endsWith('.md') ? name.slice(0, -3) : name;
}

export function generateSummaryIndex(storePath) {
  // One capture — the written index's source_sig describes the exact bytes its
  // records were derived from (the old version signature-walked the store a
  // second time, the same multi-walk gap captureStore exists to close).
  const out = captureStore(storePath).index;
  const libDir = join(resolve(storePath), '_memories', '_lib');
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
