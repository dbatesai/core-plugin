#!/usr/bin/env node
/**
 * render-browse-artifact.mjs — generate ONE self-contained HTML page from a
 * project's `_memories/` store, for explicit, user-confirmed publication as a
 * private hosted artifact (the `/memory-view` skill owns the publish flow;
 * THIS SCRIPT NEVER UPLOADS ANYTHING — it generates a local file, prints a
 * preflight manifest, and writes a local receipt; that is the whole job).
 *
 * The disclosure conditions THIS script enforces in code:
 *
 *   - Condition 2 (preflight manifest): stdout is exactly one JSON object —
 *     unit count, byte count, scopes, snapshot id, and a fixed sensitivity
 *     warning — for the agent to show the user BEFORE any publish.
 *   - Condition 4 (audit trail): TWO receipts, distinct in kind. The
 *     preflight-GENERATION receipt (this manifest, written before consent)
 *     lands under `~/.core/workspaces/<workspace_id>/artifact-receipts/` and
 *     records what was generated and offered — never what went up. The
 *     POST-PUBLISH receipt (`--record-publish`) is written after the consent/
 *     publish step resolves and records the actual outcome — declined,
 *     failed, or published-private with privacy-verification evidence — as
 *     `<generation-receipt>.publish.json` beside it; `--record-revocation`
 *     later stamps `revoked_at` on it.
 *   - Condition 6 (snapshot provenance): the page header carries an
 *     unmissable "POINT-IN-TIME SNAPSHOT — READ-ONLY" banner with the
 *     generated-at timestamp, truthful producer identity (in a git source
 *     checkout: the REAL `git rev-parse HEAD` of the tree this script runs
 *     from; in an installed tree: the stamped manifest identity; neither →
 *     fail closed, never an unknown-sha render), and the store snapshot id.
 *   - Condition 7 (content minimization): `--scope active` (default) embeds
 *     active units only — the same loadSnapshot population decoration uses;
 *     `--scope all-including-archive` must be chosen explicitly;
 *     `--exclude-topic <t>` (repeatable) trims further. Never an
 *     unconditional whole-store dump.
 *   - CSP hard requirement: the page references ZERO external resources —
 *     no CDN, no fonts, no fetch/XHR/WebSocket, no remote images. All CSS
 *     and JS are inline; the only URLs anywhere in the file are whatever the
 *     unit bodies themselves happen to contain (embedded as data, and
 *     rendered as plain text, never as chrome-generated hrefs).
 *
 * Read-only guarantee — UNCONDITIONAL: the store is read through
 * loadSnapshot (the exact read path decorate-graph.mjs uses) with the
 * derived-cache refresh disabled, so no byte under `_memories/` is ever
 * written — no unit file, and not `_lib/unit-summaries.json` either, even
 * on a cold store where the cache does not exist yet. The skill promises
 * the whole flow never writes the store; a first-render cache write would
 * break that promise exactly once, on the coldest run. One invariant, no
 * mode, no flag — there is deliberately no way to turn cache writes on
 * from this generator.
 *
 * Snapshot identity is SCOPED to the rendered population: active scope
 * reports the store snapshot id unchanged (existing receipts stay
 * comparable); all-including-archive extends that id over the supplemental
 * (archive/ + terminal-status) bytes the page embeds, so an archive-only
 * edit changes the identity of the view that actually shows it — and only
 * that view. The watcher compares the same producer's id for the same
 * scope (see memory-view-watch.mjs).
 *
 * CLI:
 *   node render-browse-artifact.mjs <project-dir> --out <path>
 *        [--scope active|all-including-archive] [--exclude-topic <t>]...
 *        [--no-metrics] [--metrics-cache <path>] [--home <dir>]
 *
 *   --metrics-cache decouples the ~2s live metrics proof from the render hot
 *   path (the watch loop's need): when the cache file EXISTS its block is
 *   embedded verbatim, labeled with the cache's own "metrics as of" stamp;
 *   when it does not exist the live gatherMetrics() runs as usual and its
 *   block + timestamp are written to the cache path for the next run. Without
 *   the flag, behavior is exactly the pre-cache default. Passing
 *   --metrics-cache together with --no-metrics is refused (exit 2): the two
 *   contradict — one promises a carried-forward health block, the other
 *   drops it — and a silent winner already misled a documented recipe once.
 *   The cache path must not live inside _memories/ (the store stays
 *   read-only to this generator).
 *
 *   node render-browse-artifact.mjs --record-publish
 *        --generation-receipt <path> --status declined|failed|published-private
 *        [--artifact-url <url>] [--private-verified-evidence <s>]
 *        [--consent-by <who>] [--consent-mechanism <s>] [--note <s>]
 *
 *   node render-browse-artifact.mjs --record-revocation <publish-receipt-path>
 *
 *   --out is REQUIRED — there is deliberately no default output location.
 *   --home is a test-isolation override for the receipt root (defaults to
 *   the real home directory); the fixture suites use it so a test run never
 *   touches the developer's ~/.core.
 *
 * Exit codes: 0 success (manifest/receipt printed); 2 usage error (missing
 * --out, bad --scope, --out inside _memories/, --no-metrics together with
 * --metrics-cache, bad record-mode input);
 * 1 fatal failure (including fail-closed producer identity).
 */
import { readFileSync, readdirSync, realpathSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, basename, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { loadSnapshot, stripGeneratedEdgesBlock, deriveSummary } from './generate-summary-index.mjs';
import { parseFrontmatter, extractEdges } from './priority.mjs';
import { gatherMetrics } from './metrics-check.mjs';
import { truthfulProducerIdentity } from './artifact-provenance.mjs';
import { requireTrustedHome } from './trusted-home.mjs';
import {
  PUBLISH_RECEIPT_SCHEMA_VERSION, PUBLISH_STATUSES, publishReceiptPathFor,
  recordPublishOutcome, recordRevocation, runRecordCli, generationReceiptLocation,
  artifactContentDigest, publishArtifactWithReceipt, resolveArtifactDestination,
} from './artifact-receipts.mjs';

export const BROWSE_MANIFEST_SCHEMA_VERSION = '1.0.0';
// Re-exported so existing consumers (skill docs, tests) keep one import site;
// the implementations live in the shared artifact-receipts.mjs (also consumed
// by the metrics artifact generator).
export { PUBLISH_RECEIPT_SCHEMA_VERSION, PUBLISH_STATUSES, publishReceiptPathFor, recordPublishOutcome, recordRevocation };

// Fixed sensitivity warning — one string, stable across
// runs, so the skill can relay it verbatim and tests can assert it exactly.
export const SENSITIVITY_WARNING =
  'SENSITIVITY: this file embeds the FULL BODIES of the memory units counted above — real project ' +
  'content, not anonymized. Publishing uploads that content to a hosted service. State the unit ' +
  'count, byte count, and scope in the conversation when publishing — every publish is narrated, ' +
  'receipted, and private by default. Content carrying another party\'s data, or anything the user ' +
  'has flagged sensitive, still needs an explicit go-ahead before it goes up.';

/**
 * Truthful producer identity:
 * real git HEAD in a source checkout (tracked-file guarded), stamped manifest
 * identity in an installed tree, fail closed with neither. The implementation
 * lives in the shared artifact-provenance.mjs (shared with the
 * metrics artifact generator); this wrapper stamps
 * this generator's own script name into the identity.
 */
export function producerIdentity() {
  return truthfulProducerIdentity('render-browse-artifact.mjs');
}

// ============================================================
// Store reading — active scope via loadSnapshot (decoration's read path),
// archive/retired supplement only when the caller explicitly asked for it.
// ============================================================

/**
 * Parse a unit for display. A parse failure is reported, never converted into
 * an empty-but-valid-looking unit: the page claims to be a complete
 * point-in-time snapshot, and a silently blank entry is content the user
 * approved publishing without ever seeing it was missing.
 */
function displayBody(rawText) {
  const text = String(rawText).replace(/\r\n/g, '\n');
  // The canonical parser is lenient by design: an opening fence with no closing
  // one yields empty metadata and the raw text as body, which downstream
  // becomes a unit with invented id and status. That is the structural loss the
  // page must disclose, so it is detected here.
  if (text.startsWith('---\n') && text.indexOf('\n---', 4) === -1) {
    return { fm: {}, body: '', unreadable: 'frontmatter fence opened but never closed' };
  }
  let fm = null, body = '';
  try { [fm, body] = parseFrontmatter(text); }
  catch (e) { return { fm: {}, body: '', unreadable: String(e && e.message || e).slice(0, 120) }; }
  return { fm: fm || {}, body: stripGeneratedEdgesBlock(String(body || '')).trim(), unreadable: null };
}

// Recursive walk of _memories/ INCLUDING archive/ (used only for
// --scope all-including-archive). Same file filter as the canonical walk
// (*.md, not `_`-prefixed, not INDEX*); dirs starting with `_` are skipped.
function walkAllUnitFiles(memoriesDir, onIoError = null) {
  const out = [];
  const walkDir = (dir, relPrefix) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch (e) {
      // ENOENT = vanished mid-walk (normal); anything else is an I/O failure
      // the identity consumer must see (an unreadable tree is not an empty one).
      if (onIoError && e?.code !== 'ENOENT') onIoError(relPrefix || '.', e);
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!e.name.startsWith('_')) walkDir(join(dir, e.name), relPrefix + e.name + '/');
        continue;
      }
      if (!e.isFile()) continue;
      if (!e.name.endsWith('.md') || e.name.startsWith('_') || e.name.startsWith('INDEX')) continue;
      out.push({ rel: relPrefix + e.name, full: join(dir, e.name) });
    }
  };
  walkDir(memoriesDir, '');
  return out;
}

/**
 * collectUnits — the embed population AND the published identity. Default
 * scope is EXACTLY the loadSnapshot active population (archived excluded by
 * path, retired/superseded excluded by status, invalidated excluded by
 * t_invalid — same filtering decoration uses). `all-including-archive` adds
 * every other unit file (archive/ + terminal-status units) as clearly-marked
 * supplements — and the returned snapshotId then covers the RENDERED
 * population: the active store id extended over the exact supplemental bytes
 * read for the page, so an archive-only edit changes the identity of an
 * archive-including view and never an active one. Active scope returns the
 * plain store snapshot id, so existing receipts stay comparable.
 * activeSnapshotId always carries the plain store id for callers that must
 * match an unlabeled baseline against both scoped ids (the watcher).
 *
 * Topic exclusions PARTICIPATE in the identity: with exclusions the id is
 * derived from the kept source population (rel:sha1 of every kept unit's
 * bytes) plus the normalized exclusion list, so it covers exactly the bytes
 * the page would embed — an edit wholly inside an excluded topic does not
 * change the id (no wake, no spent budget for an identical page), and two
 * populations that differ by an exclusion never share one id. With no
 * exclusions the legacy scoped id is preserved verbatim, so existing
 * receipts stay comparable. Ids are only comparable under the same
 * scope + exclusion list — the live loop re-applies both from its record.
 *
 * Read-only, unconditionally: the snapshot load never refreshes the
 * derived `_lib/` cache (refreshCache:false, not an option) — the skill
 * promises the WHOLE flow never writes the store, including a cold first
 * render.
 */
export function collectUnits(projectDir, { scope = 'active', excludeTopics = [] } = {}) {
  const root = resolve(projectDir);
  const cap = loadSnapshot(root, { captureBodies: true, retainRaw: true, refreshCache: false });
  const excluded = new Set(excludeTopics.map((t) => String(t).toLowerCase()));

  const units = [];
  const activePaths = new Set();
  const seenIds = new Set();
  // Files that could not be parsed. They are named rather than embedded blank,
  // so the preflight the user approves states what is missing.
  const unreadable = [];
  for (const u of cap.index.units) {
    activePaths.add(u.path);
    const raw = cap.raw?.[u.path];
    if (raw === undefined) { unreadable.push({ path: u.path, reason: 'not readable from the store snapshot' }); continue; }
    const parsed = displayBody(raw.toString('utf8'));
    if (parsed.unreadable) { unreadable.push({ path: u.path, reason: parsed.unreadable }); continue; }
    const { fm, body } = parsed;
    units.push({
      id: u.id, path: u.path, type: u.type || '', status: u.status || 'active',
      topics: u.topics || [], updated: u.updated || '',
      title: deriveSummary(body) || u.id,
      body,
      edges: cap.edges[u.id] || [],
      population: 'active',
      // Every frontmatter field as parsed — the "see every element of the
      // file" properties panel reads this, not the curated subset above.
      properties: fm || {},
    });
    seenIds.add(u.id);
  }

  let supplementalCount = 0;
  // Supplemental identity input: rel:sha1 over the exact bytes read for the
  // page (same shape captureStore's source_sig uses; one read per file, so
  // the scoped id always identifies the bytes actually embedded).
  const supplementalSig = [];
  // per-file sha1 of every included unit's source bytes — the exclusion-aware
  // identity below derives from exactly these.
  const sha1ByPath = { ...(cap.file_sha1s || {}) };
  // I/O failures during the read (surfaced by the capture, plus any hit while
  // walking supplements). ENOENT rename races excluded — see captureStore.
  const readErrors = [...(cap.readErrors || [])];
  if (scope === 'all-including-archive') {
    for (const f of walkAllUnitFiles(join(root, '_memories'), (rel, e) => readErrors.push({ path: rel, code: String((e && e.code) || e) }))) {
      if (activePaths.has(f.rel)) continue;
      let buf;
      try { buf = readFileSync(f.full); }
      catch (e) {
        unreadable.push({ path: f.rel, reason: String(e && e.code || e).slice(0, 120) });
        if (e?.code !== 'ENOENT') readErrors.push({ path: f.rel, code: String((e && e.code) || e) });
        continue;
      }
      sha1ByPath[f.rel] = createHash('sha1').update(buf).digest('hex');
      supplementalSig.push(`${f.rel}:${sha1ByPath[f.rel]}`);
      const parsed = displayBody(buf.toString('utf8'));
      if (parsed.unreadable) { unreadable.push({ path: f.rel, reason: parsed.unreadable }); continue; }
      const { fm, body } = parsed;
      let id = fm.id !== undefined ? String(fm.id) : basename(f.rel, '.md');
      if (seenIds.has(id)) id = `${id}@${f.rel}`; // active copy keeps the plain id
      seenIds.add(id);
      const status = fm.status ? String(fm.status) : (f.rel.startsWith('archive/') ? 'archived' : 'unknown');
      units.push({
        id, path: f.rel, type: String(fm.type || ''), status,
        topics: Array.isArray(fm.topics) ? fm.topics.map(String) : (fm.topics ? [String(fm.topics)] : []),
        updated: fm.updated ? String(fm.updated).slice(0, 10) : '',
        title: deriveSummary(body) || id,
        body,
        edges: extractEdges({ fm }),
        population: f.rel.startsWith('archive/') ? 'archive' : 'non-active',
        properties: fm || {},
      });
      supplementalCount++;
    }
  }

  let excludedByTopic = 0;
  const kept = units.filter((u) => {
    const hit = (u.topics || []).some((t) => excluded.has(String(t).toLowerCase()));
    if (hit) excludedByTopic++;
    return !hit;
  });
  kept.sort((a, b) => a.id.localeCompare(b.id));

  // Scoped identity (no exclusions): active → the store snapshot id verbatim;
  // all-including-archive → sha256 over that id plus the sorted supplemental
  // signature, extending the identity to every included source byte.
  let snapshotId = scope === 'all-including-archive'
    ? createHash('sha256').update(`${cap.snapshotId}|scope:all-including-archive|${supplementalSig.sort().join('|')}`).digest('hex')
    : cap.snapshotId;
  // Exclusion-aware identity: with exclusions the id covers exactly the KEPT
  // population (rel:sha1 per kept unit) plus the normalized exclusion list —
  // an excluded unit's edit cannot change it, and adding/removing an
  // exclusion always does (see the doc comment above).
  const exclusionsNorm = [...excluded].sort();
  if (exclusionsNorm.length > 0) {
    const keptSig = kept.map((u) => `${u.path}:${sha1ByPath[u.path] || ''}`).sort().join('|');
    snapshotId = createHash('sha256')
      .update(`scope:${scope}|exclude:${exclusionsNorm.join(',')}|${keptSig}`)
      .digest('hex');
  }

  return {
    units: kept,
    snapshotId,
    activeSnapshotId: cap.snapshotId,
    activeCount: kept.filter((u) => u.population === 'active').length,
    supplementalCount: supplementalCount === 0 ? 0 : kept.filter((u) => u.population !== 'active').length,
    excludedByTopic,
    unreadable,
    readErrors,
  };
}

// ============================================================
// HTML generation — fully self-contained; zero external references in the
// generated chrome by construction (no <link>, no @import, no url(), no
// src=, no fetch — grep-assertable, and asserted in the test suite).
// ============================================================

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inlineJson(data) {
  // < prevents `</script>` breakout from unit body content; U+2028/2029
  // keep the block valid if a body ever carries JS line separators.
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// ============================================================
// Graph model + build-time layout. v2: the force layout runs HERE, at build
// time, and ships as coordinates in the data island — the page never runs a
// simulation. Same store, same picture, byte for byte, zero layout cost at
// every open (v1 recomputed an O(n²) layout in the browser on every open:
// 149ms desktop / ~3-5x that on phones at 552 units, and quadratic beyond).
// ============================================================

export const GRAPH_W = 1200;
export const GRAPH_H = 760;

// Single source for the visual vocabulary — interpolated into the client
// script below so build-side markup (chips, legend) and client-side rendering
// (circle fills, edge tags) can never disagree.
const PALETTE = ['#7c5cff', '#2f9e78', '#d97706', '#dc4b6b', '#2b7fd9', '#8a8f2c', '#b04ad9', '#5b6472'];
const EDGE_STYLE = {
  cites: { stroke: 'currentColor', op: 0.22, dash: '', width: 1.2 },
  supersedes: { stroke: '#dc4b6b', op: 0.75, dash: '5,3', width: 1.4 },
  'depends-on': { stroke: 'var(--accent)', op: 0.8, dash: '', width: 1.4 },
  refines: { stroke: '#2f9e78', op: 0.7, dash: '1,3', width: 1.3 },
  amends: { stroke: '#2f9e78', op: 0.7, dash: '1,3', width: 1.3 },
};
const EDGE_DEFAULT = { stroke: 'currentColor', op: 0.28, dash: '', width: 1.1 };
const edgeStyleFor = (type) => EDGE_STYLE[type] || EDGE_DEFAULT;

/** Resolvable edges (both endpoints in the snapshot) + degree per unit. */
export function computeGraph(units) {
  const ids = new Set(units.map((u) => u.id));
  const edges = [];
  const deg = {};
  for (const u of units) {
    for (const e of u.edges || []) {
      if (!ids.has(e.target)) continue;
      edges.push({ s: u.id, t: e.target, type: e.type });
      deg[u.id] = (deg[u.id] || 0) + 1;
      deg[e.target] = (deg[e.target] || 0) + 1;
    }
  }
  return { edges, deg };
}

/**
 * Fruchterman–Reingold layout, GRID VARIANT (the 1991 paper, p.1138):
 * repulsion is computed only between nodes within radius 2k, found through a
 * uniform cell grid with 2k-sided cells — Θ(|V|+|E|) per iteration instead of
 * the naive Θ(|V|²), which retires the quadratic cliff permanently.
 * k = C·sqrt(area/|V|). Repulsion is (deg+1)-weighted (ForceAtlas2's rule:
 * proportional to the product of the two nodes' degrees plus one) so the
 * store's many low-degree observation leaves spread away from hubs; the
 * product is normalized by the mean weight squared so force magnitudes stay
 * calibrated to one temperature schedule regardless of the degree profile.
 * Cooling is two-phase quench-then-simmer (same paper): a fast linear quench,
 * then a constant low simmer that refines without reshuffling.
 * Seeded with the deterministic radial placement v1 used. No randomness
 * anywhere and a fully deterministic iteration order, so two builds of the
 * same store produce byte-identical coordinates.
 */
export function layoutForceGrid(units, edges, deg, {
  W = GRAPH_W, H = GRAPH_H, iterations = 200,
} = {}) {
  const n = units.length;
  const layout = {};
  if (!n) return layout;
  const cx = W / 2, cy = H / 2, spread = Math.min(W, H) * 0.35;
  const ids = units.map((u) => u.id);
  const index = new Map();
  ids.forEach((id, i) => index.set(id, i));
  const X = new Float64Array(n), Y = new Float64Array(n);
  const DX = new Float64Array(n), DY = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = spread * (0.5 + 0.5 * ((i * 2654435761 % 1000) / 1000));
    X[i] = cx + r * Math.cos(a);
    Y[i] = cy + r * Math.sin(a);
  }
  const k = 0.85 * Math.sqrt((W * H) / n);
  const k2 = k * k;
  const radius = 2 * k, radius2 = radius * radius;
  const w = new Float64Array(n);
  let wSum = 0;
  for (let i = 0; i < n; i++) { w[i] = (deg[ids[i]] || 0) + 1; wSum += w[i]; }
  const wMean = wSum / n;
  const wNorm = wMean * wMean;
  const eS = new Int32Array(edges.length), eT = new Int32Array(edges.length);
  edges.forEach((e, i) => { eS[i] = index.get(e.s); eT[i] = index.get(e.t); });
  const cols = Math.max(1, Math.ceil(W / radius)), rows = Math.max(1, Math.ceil(H / radius));
  const head = new Int32Array(cols * rows);
  const next = new Int32Array(n);
  const cellOf = new Int32Array(n);
  const quench = Math.max(1, Math.floor(iterations * 0.6));
  const tMax = Math.min(W, H) / 8;
  const tMin = Math.max(1.5, k * 0.06);
  for (let it = 0; it < iterations; it++) {
    const t = it < quench ? tMax + (tMin - tMax) * (it / quench) : tMin;
    DX.fill(0); DY.fill(0);
    head.fill(-1);
    for (let i = 0; i < n; i++) {
      const gx = Math.min(cols - 1, Math.max(0, Math.floor(X[i] / radius)));
      const gy = Math.min(rows - 1, Math.max(0, Math.floor(Y[i] / radius)));
      const c = gy * cols + gx;
      cellOf[i] = c;
      next[i] = head[c];
      head[c] = i;
    }
    for (let i = 0; i < n; i++) {
      const gx = cellOf[i] % cols, gy = (cellOf[i] - gx) / cols;
      for (let oy = -1; oy <= 1; oy++) {
        const ny = gy + oy;
        if (ny < 0 || ny >= rows) continue;
        for (let ox = -1; ox <= 1; ox++) {
          const nx = gx + ox;
          if (nx < 0 || nx >= cols) continue;
          for (let j = head[ny * cols + nx]; j !== -1; j = next[j]) {
            if (j >= i) continue; // each pair exactly once
            let dx = X[i] - X[j], dy = Y[i] - Y[j];
            let d2 = dx * dx + dy * dy;
            if (d2 > radius2) continue;
            if (d2 < 0.01) { dx = 0.011 * ((i - j) % 5 + 1); dy = 0.007; d2 = dx * dx + dy * dy; }
            const d = Math.sqrt(d2);
            const f = (k2 / d) * ((w[i] * w[j]) / wNorm);
            const fx = (dx / d) * f, fy = (dy / d) * f;
            DX[i] += fx; DY[i] += fy;
            DX[j] -= fx; DY[j] -= fy;
          }
        }
      }
    }
    for (let e = 0; e < eS.length; e++) {
      const a = eS[e], b = eT[e];
      const dx = X[b] - X[a], dy = Y[b] - Y[a];
      const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const f = ((d * d) / k) * 0.5;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      DX[a] += fx; DY[a] += fy;
      DX[b] -= fx; DY[b] -= fy;
    }
    for (let i = 0; i < n; i++) {
      // mild center gravity keeps disconnected components on the canvas
      DX[i] += (cx - X[i]) * 0.012;
      DY[i] += (cy - Y[i]) * 0.012;
      const len = Math.sqrt(DX[i] * DX[i] + DY[i] * DY[i]);
      if (len > 0) {
        const step = Math.min(len, t);
        X[i] += (DX[i] / len) * step;
        Y[i] += (DY[i] / len) * step;
      }
      X[i] = Math.min(W - 12, Math.max(12, X[i]));
      Y[i] = Math.min(H - 12, Math.max(12, Y[i]));
    }
  }
  // 0.1px rounding: the precision the SVG needs, ~35KB for a 550-unit store.
  const r1 = (v) => (Math.round(v * 10) / 10) || 0;
  for (let i = 0; i < n; i++) layout[ids[i]] = [r1(X[i]), r1(Y[i])];
  return layout;
}

/**
 * The page's default view: the DOI-ranked neighborhood of the most-recently-
 * updated unit. interest = importance − hop distance (Furnas 1986), with
 * importance = degree normalized to the graph's max. Ranked and capped at
 * `cap` nodes — on a hub, a plain 1-hop cutoff is its own hairball; ranking
 * degrades gracefully. Returns null for an empty store.
 */
export function computeDefaultFocus(units, edges, deg, cap = 40) {
  if (!units.length) return null;
  let focus = units[0];
  for (const u of units) {
    const a = String(u.updated || ''), b = String(focus.updated || '');
    if (a > b || (a === b && u.id < focus.id)) focus = u;
  }
  const adj = {};
  for (const e of edges) {
    (adj[e.s] = adj[e.s] || []).push(e.t);
    (adj[e.t] = adj[e.t] || []).push(e.s);
  }
  const hops = { [focus.id]: 0 };
  const q = [focus.id];
  let qi = 0;
  while (qi < q.length) {
    const cur = q[qi++];
    if (hops[cur] >= 6) continue;
    for (const nb of adj[cur] || []) {
      if (!(nb in hops)) { hops[nb] = hops[cur] + 1; q.push(nb); }
    }
  }
  let maxDeg = 1;
  for (const id in deg) if (deg[id] > maxDeg) maxDeg = deg[id];
  const cand = Object.keys(hops);
  cand.sort((a, b) => {
    const ia = (deg[a] || 0) / maxDeg - hops[a];
    const ib = (deg[b] || 0) / maxDeg - hops[b];
    if (ib !== ia) return ib - ia;
    if (hops[a] !== hops[b]) return hops[a] - hops[b];
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const ids = cand.slice(0, cap);
  if (!ids.includes(focus.id)) { ids.pop(); ids.unshift(focus.id); }
  return { id: focus.id, ids };
}

export function buildArtifactHtml({ units, meta }) {
  const { edges, deg } = computeGraph(units);
  const layout = layoutForceGrid(units, edges, deg);
  const defaultFocus = computeDefaultFocus(units, edges, deg);
  const data = inlineJson({ units, layout, defaultFocus });
  const m = meta;
  const shaShort = m.producer.source_sha ? String(m.producer.source_sha).slice(0, 12) : 'unknown-sha';
  const metricsBlock = m.metrics && m.metrics.available
    ? `<pre class="metrics-report">${escapeHtml(m.metrics.report)}</pre>
${m.metrics.cached
    ? `<p class="metrics-note">Metrics as of ${escapeHtml(m.metrics.as_of || 'an earlier run')} &mdash; carried forward verbatim from the last full metrics run; the snapshot above is newer than this health block. Four separate evidence classes, each with its own honest trust label.</p>`
    : `<p class="metrics-note">Rendered verbatim by the canonical <code>metrics-check.mjs</code> renderer at generation time (${escapeHtml(m.generatedAt)}) &mdash; four separate evidence classes, each with its own honest trust label. This is part of the same point-in-time snapshot as everything else on this page.</p>`}`
    : `<p class="metrics-note">Memory-health metrics were not gathered for this snapshot: ${escapeHtml((m.metrics && m.metrics.reason) || 'unknown reason')}. Run <code>/metrics</code> in a terminal for the live check.</p>`;

  // Types/statuses are known at build time, so the filter chips, the edge
  // legend, and the per-class hide rules are baked as static markup/CSS.
  // Class tokens are positional (t0, t1, … / s0, s1, …) against the SORTED
  // type/status lists — CSS-safe regardless of what frontmatter contains.
  const types = [];
  units.forEach((u) => { const t = u.type || 'untyped'; if (!types.includes(t)) types.push(t); });
  types.sort();
  const statuses = [];
  units.forEach((u) => { const s = u.status || 'active'; if (!statuses.includes(s)) statuses.push(s); });
  statuses.sort();
  const colorFor = (t) => PALETTE[types.indexOf(t || 'untyped') % PALETTE.length];
  const filterRules = [
    ...types.map((t, i) => `  #graph.hide-t${i} .t${i} { display: none; }`),
    ...statuses.map((s, i) => `  #graph.hide-s${i} .s${i} { display: none; }`),
  ].join('\n');
  const typeChips = types.map((t, i) =>
    `<button type="button" class="chip" aria-pressed="true" data-type="${escapeHtml(t)}" data-cls="t${i}" style="--dot:${colorFor(t)}">${escapeHtml(t)}</button>`).join('');
  const statusChips = statuses.map((s, i) =>
    `<button type="button" class="chip" aria-pressed="true" data-status="${escapeHtml(s)}" data-cls="s${i}" style="--dot:var(--muted)">${escapeHtml(s)}</button>`).join('');
  const edgeTypesPresent = [];
  edges.forEach((e) => { if (!edgeTypesPresent.includes(e.type)) edgeTypesPresent.push(e.type); });
  const edgeLegend = edgeTypesPresent.sort().map((t) => {
    const st = edgeStyleFor(t);
    return `<span class="edge-legend"><svg><line x1="1" y1="4" x2="25" y2="4" stroke="${st.stroke}" stroke-opacity="${st.op}" stroke-width="${st.width}" stroke-dasharray="${escapeHtml(st.dash)}"></line></svg>${escapeHtml(t)}</span>`;
  }).join('');
  // Local subgraph is the shipped default whenever the store is non-empty;
  // the Global view stays one visible click away.
  const focusBtnAttrs = defaultFocus ? ' class="on" aria-pressed="true"' : ' aria-pressed="false" disabled';
  const globalBtnAttrs = defaultFocus ? ' aria-pressed="false"' : ' class="on" aria-pressed="true"';

  return `<title>CORE Memory — ${escapeHtml(m.projectName)}</title>
<style>
  :root {
    --bg: #f8f7f4; --panel: #ffffff; --ink: #1f2430; --muted: #5b6472;
    --line: #d9d5cc; --accent: #7c5cff; --accent-ink: #4a34b8;
    --banner-bg: #8a2d0b; --banner-stripe: #6f2408; --banner-ink: #ffffff;
    --code-bg: #efede8; --node-dim: 0.12; --chip-bg: #efede8; --shadow: 0 1px 2px rgba(20,16,10,0.04), 0 6px 20px rgba(20,16,10,0.06);
    --font-display: ui-serif, Georgia, "Iowan Old Style", "Times New Roman", serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14161c; --panel: #1d2129; --ink: #e8e6e1; --muted: #9aa3b2;
      --line: #333947; --accent: #a08cff; --accent-ink: #c4b8ff;
      --banner-bg: #7a2607; --banner-stripe: #5e1d05; --banner-ink: #ffe9de;
      --code-bg: #262b36; --chip-bg: #262b36; --shadow: 0 1px 2px rgba(0,0,0,0.3), 0 8px 24px rgba(0,0,0,0.35);
    }
  }
  :root[data-theme="dark"] {
    --bg: #14161c; --panel: #1d2129; --ink: #e8e6e1; --muted: #9aa3b2;
    --line: #333947; --accent: #a08cff; --accent-ink: #c4b8ff;
    --banner-bg: #7a2607; --banner-stripe: #5e1d05; --banner-ink: #ffe9de;
    --code-bg: #262b36; --chip-bg: #262b36; --shadow: 0 1px 2px rgba(0,0,0,0.3), 0 8px 24px rgba(0,0,0,0.35);
  }
  :root[data-theme="light"] {
    --bg: #f8f7f4; --panel: #ffffff; --ink: #1f2430; --muted: #5b6472;
    --line: #d9d5cc; --accent: #7c5cff; --accent-ink: #4a34b8;
    --banner-bg: #8a2d0b; --banner-stripe: #6f2408; --banner-ink: #ffffff;
    --code-bg: #efede8; --chip-bg: #efede8; --shadow: 0 1px 2px rgba(20,16,10,0.04), 0 6px 20px rgba(20,16,10,0.06);
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  .snapshot-banner { position: sticky; top: 0; z-index: 60;
    background: repeating-linear-gradient(45deg, var(--banner-bg), var(--banner-bg) 14px, var(--banner-stripe) 14px, var(--banner-stripe) 28px);
    color: var(--banner-ink); padding: 0.9rem 1.2rem; text-align: center;
    border-bottom: 3px solid var(--banner-stripe); }
  .snapshot-banner .headline { font-size: 1.25rem; font-weight: 800; letter-spacing: 0.08em; }
  .snapshot-banner .provenance { margin-top: 0.35rem; font-size: 0.82rem; opacity: 0.95;
    font-family: ui-monospace, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
  .snapshot-banner .age-badge { margin-top: 0.3rem; font-size: 0.85rem; font-weight: 700; letter-spacing: 0.02em; }
  main { max-width: 1320px; margin: 0 auto; padding: 1.2rem; }
  h1 { font-family: var(--font-display); font-weight: 600; font-size: 1.6rem; margin: 0.6rem 0 0.15rem; letter-spacing: -0.01em; }
  h2.eyebrow { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.12em;
    color: var(--muted); margin: 2rem 0 0.6rem; border-bottom: 1px solid var(--line); padding-bottom: 0.45rem; }
  .subtitle { color: var(--muted); margin: 0 0 1.1rem; max-width: 62ch; }
  .hidden { display: none; }

  /* ---- shell: sidebar + main column, Obsidian-style ---- */
  .shell { display: grid; grid-template-columns: 280px 1fr; gap: 1.1rem; align-items: start; }
  @media (max-width: 860px) { .shell { grid-template-columns: 1fr; } .sidebar { position: static !important; max-height: 52vh !important; } }
  .sidebar { position: sticky; top: 4.2rem; background: var(--panel); border: 1px solid var(--line);
    border-radius: 12px; box-shadow: var(--shadow); max-height: calc(100vh - 5.5rem); display: flex; flex-direction: column; overflow: hidden; }
  .sidebar input { width: 100%; border: 0; border-bottom: 1px solid var(--line); background: transparent; color: var(--ink);
    padding: 0.7rem 0.9rem; font: inherit; outline: none; flex: none; }
  .sidebar input:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .sidebar ul { list-style: none; margin: 0; padding: 0.3rem 0; overflow: auto; }
  /* content-visibility skips rendering for off-screen rows while keeping them
     findable in-page and present in the accessibility tree (unlike a virtual
     scroller); contain-intrinsic-size keeps the scrollbar honest. */
  .sidebar li.row { padding: 0.4rem 0.9rem; cursor: pointer; border-left: 3px solid transparent;
    content-visibility: auto; contain-intrinsic-size: auto 44px; }
  .sidebar li.row:hover { background: var(--code-bg); }
  .sidebar li.row.sel { border-left-color: var(--accent); background: var(--code-bg); }
  .sidebar li.row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .sidebar .uid { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.76rem; overflow-wrap: anywhere; color: var(--ink); }
  .sidebar .utitle { font-size: 0.8rem; color: var(--muted); overflow-wrap: anywhere; }
  .type-head { padding: 0.55rem 0.9rem 0.15rem; font-size: 0.7rem; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--muted); background: var(--panel); position: sticky; top: 0; }

  .main-col { min-width: 0; }

  /* ---- graph panel ---- */
  .graph-wrap { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); overflow: hidden; position: relative; }
  .graph-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; flex-wrap: wrap;
    padding: 0.6rem 0.8rem; border-bottom: 1px solid var(--line); }
  .mode-toggle { display: inline-flex; border: 1px solid var(--line); border-radius: 999px; overflow: hidden; }
  .mode-toggle button { border: 0; background: transparent; color: var(--muted); font: inherit; font-size: 0.78rem;
    padding: 0.3rem 0.8rem; cursor: pointer; }
  .mode-toggle button.on { background: var(--accent); color: #fff; }
  .mode-toggle button:disabled { opacity: 0.4; cursor: not-allowed; }
  .mode-toggle button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .chipset { display: flex; flex-wrap: wrap; gap: 0.35rem; }
  .chip { font-size: 0.72rem; padding: 0.18rem 0.6rem; border-radius: 999px; border: 1px solid var(--line);
    background: var(--chip-bg); color: var(--ink); cursor: pointer; opacity: 1; transition: opacity 0.12s ease; }
  .chip::before { content: ""; display: inline-block; width: 0.6em; height: 0.6em; border-radius: 50%; margin-right: 0.4em;
    background: var(--dot, var(--muted)); vertical-align: -0.05em; }
  .chip.off { opacity: 0.35; text-decoration: line-through; }
  .chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  @media (prefers-reduced-motion: reduce) { .chip { transition: none; } }
  .graph-wrap svg { display: block; width: 100%; height: 60vh; min-height: 360px; cursor: grab; touch-action: none; }
  .graph-hint { position: absolute; right: 0.7rem; top: 3.4rem; font-size: 0.72rem; color: var(--muted);
    background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 0.15rem 0.55rem; opacity: 0.9; pointer-events: none; }
  .legend-row { display: flex; flex-wrap: wrap; gap: 0.5rem 1.1rem; padding: 0.6rem 0.8rem; border-top: 1px solid var(--line); font-size: 0.78rem; }
  .legend-group b { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin-right: 0.5rem; }
  .edge-legend { display: inline-flex; align-items: center; gap: 0.3rem; margin-right: 0.9rem; color: var(--muted); }
  .edge-legend svg { width: 26px; height: 8px; min-height: 0; overflow: visible; cursor: default; touch-action: auto; }
  /* Ghost context and filter dimming both ride opacity (GPU-accelerated) —
     dimmed content fades, it is never removed from view. */
  .node.dim, .link.dim { opacity: var(--node-dim); }
  .node.hl { stroke: currentColor; stroke-width: 2; }
  .link.hl { stroke-opacity: 1; }
  .node.selring { stroke: currentColor; stroke-width: 3; }
  /* Filter chips toggle ONE class per chip on the SVG container; this small
     FIXED rule set (one class per unit type + one per status) does the hiding.
     Classes, not attribute selectors (measured up to 10x faster), and no
     :has() on the container (the documented invalidation anti-pattern). The
     graph DOM itself is built once and never rebuilt on a filter click. */
${filterRules}

  /* ---- reader ---- */
  .reader { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow);
    padding: 1.1rem 1.3rem; min-height: 12rem; margin-top: 1.1rem; }
  .reader .placeholder { color: var(--muted); }
  .badges { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0.4rem 0 0.9rem; }
  .badge { font-size: 0.72rem; padding: 0.1rem 0.55rem; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
  .badge.status-archived, .badge.status-retired, .badge.status-superseded { border-color: var(--banner-bg); color: var(--banner-ink); background: var(--banner-bg); }
  .reader h3 { font-family: var(--font-display); font-weight: 600; margin: 0; font-size: 1.35rem; letter-spacing: -0.01em; }
  .reader .unit-id { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.8rem; color: var(--muted); overflow-wrap: anywhere; margin-top: 0.15rem; }
  .props { display: grid; grid-template-columns: max-content 1fr; gap: 0.35rem 1rem; margin: 0.7rem 0 0.9rem;
    padding: 0.7rem 0.9rem; background: var(--code-bg); border-radius: 8px; font-size: 0.84rem; }
  .props dt { color: var(--muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; align-self: baseline; padding-top: 0.15rem; }
  .props dd { margin: 0; overflow-wrap: anywhere; }
  .props .pchip { display: inline-block; font-size: 0.78rem; background: var(--panel); border: 1px solid var(--line);
    border-radius: 999px; padding: 0.02rem 0.55rem; margin: 0.05rem 0.25rem 0.05rem 0; }
  .edges, .backlinks { margin: 0.9rem 0; font-size: 0.86rem; }
  .edges b, .backlinks b { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); }
  .edges ul, .backlinks ul { margin: 0.35rem 0 0; padding-left: 1.1rem; }
  .edge-type-tag { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.74rem; padding: 0 0.35rem;
    border-radius: 4px; color: #fff; margin-right: 0.3rem; }
  a.ulink { color: var(--accent-ink); cursor: pointer; text-decoration: underline; overflow-wrap: anywhere; }
  a.ulink:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .body-md { border-top: 1px solid var(--line); margin-top: 0.9rem; padding-top: 0.9rem; overflow-x: auto;
    content-visibility: auto; contain-intrinsic-size: auto 480px; }
  .body-md h4 { margin: 1rem 0 0.4rem; }
  .body-md pre { background: var(--code-bg); padding: 0.6rem 0.8rem; border-radius: 8px; overflow-x: auto; font-size: 0.82rem; }
  .body-md code { background: var(--code-bg); border-radius: 4px; padding: 0.05rem 0.3rem; font-size: 0.85em;
    font-family: ui-monospace, Menlo, Consolas, monospace; }
  .body-md pre code { background: none; padding: 0; }
  .metrics-report { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 1rem;
    overflow-x: auto; font-size: 0.8rem; line-height: 1.45; font-family: ui-monospace, Menlo, Consolas, monospace; }
  .metrics-note { color: var(--muted); font-size: 0.85rem; }
  footer { color: var(--muted); font-size: 0.8rem; margin: 2.5rem 0 1rem; text-align: center; overflow-wrap: anywhere; }
</style>
<div class="snapshot-banner">
  <div class="headline">POINT-IN-TIME SNAPSHOT &mdash; READ-ONLY</div>
  <div class="provenance">generated <time id="gen-time" datetime="${escapeHtml(m.generatedAt)}">${escapeHtml(m.generatedAt)}</time> &middot; ${escapeHtml(m.producer.plugin || 'core')} v${escapeHtml(m.producer.plugin_version || 'unknown')} (${escapeHtml(shaShort)}) &middot; store snapshot ${escapeHtml(String(m.snapshotId).slice(0, 12))} &middot; ${escapeHtml(m.scopeDesc)} &middot; ${m.unitCount} units</div>
  <div class="age-badge" id="age-badge"></div>
</div>
<main>
  <h1>CORE Memory — ${escapeHtml(m.projectName)}</h1>
  <p class="subtitle">What CORE knows in this project's memory store, frozen at the moment in the banner above. Nothing here is live, and nothing here can be edited — <code>PROJECT.md</code> and the store itself remain the only writing surfaces.</p>

  <div class="shell">
    <nav class="sidebar" aria-label="Units">
      <input id="filter" type="search" placeholder="Filter by id, title, or topic&hellip;" aria-label="Filter units">
      <ul id="list"></ul>
    </nav>
    <div class="main-col">
      <h2 class="eyebrow">Graph</h2>
      <div class="graph-wrap">
        <div class="graph-toolbar">
          <div class="mode-toggle" id="modeToggle" role="group" aria-label="Graph mode">
            <button type="button" data-mode="global"${globalBtnAttrs}>Global</button>
            <button type="button" data-mode="focus"${focusBtnAttrs}>Focus</button>
          </div>
          <div class="chipset" id="typeFilters" aria-label="Filter by type">${typeChips}</div>
        </div>
        <div style="position:relative">
          <svg id="graph" role="img" aria-label="Unit graph"></svg>
          <div class="graph-hint">drag to pan &middot; scroll to zoom &middot; click a node to focus</div>
        </div>
        <div class="legend-row">
          <div class="legend-group" id="statusFilters"><b>Status</b>${statusChips}</div>
          <div class="legend-group" id="edgeLegend"><b>Edges</b>${edgeLegend}</div>
        </div>
      </div>

      <div class="reader" id="reader"><p class="placeholder">Click a node or a list entry to read the full unit — its properties, body, edges, and the graph's local neighborhood all come with it.</p></div>

      <h2 class="eyebrow">Memory health</h2>
      ${metricsBlock}
    </div>
  </div>

  <footer>Full snapshot id ${escapeHtml(m.snapshotId)} &middot; self-contained page, zero external resources.</footer>
</main>
<script type="application/json" id="core-data">${data}</script>
<script>
(function () {
  'use strict';
  var DATA = JSON.parse(document.getElementById('core-data').textContent);
  var units = DATA.units;
  // Positions are PRECOMPUTED at build time (deterministic Fruchterman-Reingold
  // grid variant) and shipped in the data island; the page runs no simulation.
  var LAYOUT = DATA.layout || {};
  var DEFAULT_FOCUS = DATA.defaultFocus || null;
  var byId = {};
  units.forEach(function (u) { byId[u.id] = u; });
  var backlinks = {};
  units.forEach(function (u) {
    (u.edges || []).forEach(function (e) {
      if (!backlinks[e.target]) backlinks[e.target] = [];
      backlinks[e.target].push({ from: u.id, type: e.type });
    });
  });
  // Adjacency (both directions) for neighborhood + hover computation.
  var adj = {};
  function link2(a, b) { (adj[a] = adj[a] || []).push(b); (adj[b] = adj[b] || []).push(a); }
  units.forEach(function (u) { (u.edges || []).forEach(function (e) { if (byId[e.target]) link2(u.id, e.target); }); });

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---- minimal markdown rendering (headings, lists, fences, inline marks,
  // [[wikilinks]] to in-page units; [text](url) renders as PLAIN TEXT with
  // the url shown — the chrome never generates an external href). ----
  function inline(s) {
    var out = esc(s);
    out = out.replace(/\`([^\`]+)\`/g, function (_, c) { return '<code>' + c + '</code>'; });
    out = out.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
    out = out.replace(/\\[\\[([^\\]|]+)(?:\\|[^\\]]*)?\\]\\]/g, function (_, id) {
      id = id.trim();
      if (byId[id]) return '<a class="ulink" data-unit="' + esc(id) + '">' + esc(id) + '</a>';
      return '[[' + esc(id) + ']]';
    });
    out = out.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, function (_, t, u) { return t + ' (' + u + ')'; });
    return out;
  }
  function mdToHtml(md) {
    var lines = String(md).split('\\n');
    var html = [], para = [], list = null, fence = null;
    function flushPara() { if (para.length) { html.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } }
    function flushList() { if (list) { html.push('<ul>' + list.join('') + '</ul>'); list = null; } }
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (fence !== null) {
        if (/^\`\`\`/.test(ln)) { html.push('<pre><code>' + esc(fence.join('\\n')) + '</code></pre>'); fence = null; }
        else fence.push(ln);
        continue;
      }
      if (/^\`\`\`/.test(ln)) { flushPara(); flushList(); fence = []; continue; }
      var h = ln.match(/^(#{1,6})\\s+(.*)$/);
      if (h) { flushPara(); flushList(); html.push('<h4>' + inline(h[2]) + '</h4>'); continue; }
      var li = ln.match(/^\\s*[-*]\\s+(.*)$/);
      if (li) { flushPara(); if (!list) list = []; list.push('<li>' + inline(li[1]) + '</li>'); continue; }
      if (!ln.trim()) { flushPara(); flushList(); continue; }
      para.push(ln.trim());
    }
    if (fence !== null) html.push('<pre><code>' + esc(fence.join('\\n')) + '</code></pre>');
    flushPara(); flushList();
    return html.join('\\n');
  }

  // ---- build-time constants injected by the generator (single source) ----
  var PALETTE = ${JSON.stringify(PALETTE)};
  var types = ${JSON.stringify(types)};
  var statuses = ${JSON.stringify(statuses)};
  var EDGE_STYLE = ${JSON.stringify(EDGE_STYLE)};
  var EDGE_DEFAULT = ${JSON.stringify(EDGE_DEFAULT)};
  function edgeStyle(type) { return EDGE_STYLE[type] || EDGE_DEFAULT; }
  function colorFor(type) { return PALETTE[types.indexOf(type || 'untyped') % PALETTE.length]; }
  var typeCls = {}; types.forEach(function (t, i) { typeCls[t] = 't' + i; });
  var statusCls = {}; statuses.forEach(function (s, i) { statusCls[s] = 's' + i; });

  var W = ${GRAPH_W}, H = ${GRAPH_H};
  var globalEdges = [];
  var deg = {};
  units.forEach(function (u) {
    (u.edges || []).forEach(function (e) {
      if (!byId[e.target]) return;
      globalEdges.push({ s: u.id, t: e.target, type: e.type });
      deg[u.id] = (deg[u.id] || 0) + 1; deg[e.target] = (deg[e.target] || 0) + 1;
    });
  });
  var maxDeg = 1;
  units.forEach(function (u) { if ((deg[u.id] || 0) > maxDeg) maxDeg = deg[u.id]; });
  var globalPos = {};
  Object.keys(LAYOUT).forEach(function (id) { globalPos[id] = { x: LAYOUT[id][0], y: LAYOUT[id][1] }; });

  // ---- unit list: DOM built ONCE; the filter input toggles a hidden class
  // per row (debounced), never re-serializing innerHTML per keystroke. ----
  var listEl = document.getElementById('list');
  var selected = null;
  var rowById = {};
  var listGroups = [];
  function buildList() {
    var byType = {};
    units.forEach(function (u) {
      var t = u.type || 'untyped';
      (byType[t] = byType[t] || []).push(u);
    });
    var html = '';
    Object.keys(byType).sort().forEach(function (t) {
      html += '<li class="type-head">' + esc(t) + ' (<span>' + byType[t].length + '</span>)</li>';
      byType[t].forEach(function (u) {
        html += '<li class="row" tabindex="0" role="button" data-unit="' + esc(u.id) + '">' +
          '<div class="uid">' + esc(u.id) + '</div><div class="utitle">' + esc(u.title) + '</div></li>';
      });
    });
    html += '<li class="type-head hidden" id="no-match">no units match</li>';
    listEl.innerHTML = html;
    var current = null;
    listEl.querySelectorAll('li').forEach(function (li) {
      if (li.id === 'no-match') return;
      if (li.classList.contains('type-head')) {
        current = { head: li, count: li.querySelector('span'), rows: [] };
        listGroups.push(current);
        return;
      }
      var id = li.getAttribute('data-unit');
      var u = byId[id];
      rowById[id] = li;
      current.rows.push({ el: li, hay: (u.id + ' ' + u.title + ' ' + (u.topics || []).join(' ')).toLowerCase() });
    });
  }
  function applyListFilter(filter) {
    var f = (filter || '').toLowerCase();
    var total = 0;
    listGroups.forEach(function (g) {
      var vis = 0;
      g.rows.forEach(function (r) {
        var show = !f || r.hay.indexOf(f) !== -1;
        r.el.classList.toggle('hidden', !show);
        if (show) vis++;
      });
      g.head.classList.toggle('hidden', vis === 0);
      g.count.textContent = String(vis);
      total += vis;
    });
    document.getElementById('no-match').classList.toggle('hidden', total !== 0);
  }
  var filterEl = document.getElementById('filter');
  var filterTimer = null;
  filterEl.addEventListener('input', function () {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(function () { applyListFilter(filterEl.value); }, 100);
  });
  listEl.addEventListener('click', function (e) {
    var li = e.target.closest('li[data-unit]');
    if (li) select(li.getAttribute('data-unit'));
  });
  listEl.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var li = e.target.closest('li[data-unit]');
    if (li) { e.preventDefault(); select(li.getAttribute('data-unit')); }
  });
  function markSelected(id) {
    if (selected && rowById[selected]) rowById[selected].classList.remove('sel');
    if (rowById[id]) rowById[id].classList.add('sel');
  }

  // ---- properties panel: every frontmatter field, 'edges' excluded (it has
  // its own linked section below — a raw dump beside it would just be noise). ----
  var PROP_ORDER = ['id', 'type', 'status', 'updated', 'created', 'topics'];
  function renderProperties(props) {
    if (!props) return '';
    var keys = Object.keys(props).filter(function (k) { return k !== 'edges' && k !== 'body'; });
    keys.sort(function (a, b) {
      var ia = PROP_ORDER.indexOf(a), ib = PROP_ORDER.indexOf(b);
      if (ia === -1) ia = 99; if (ib === -1) ib = 99;
      return ia !== ib ? ia - ib : a.localeCompare(b);
    });
    if (!keys.length) return '';
    var rows = keys.map(function (k) {
      var v = props[k];
      var vhtml;
      if (Array.isArray(v)) {
        vhtml = v.length ? v.map(function (x) { return '<span class="pchip">' + esc(typeof x === 'object' ? JSON.stringify(x) : x) + '</span>'; }).join(' ') : '<em>(empty)</em>';
      } else if (v && typeof v === 'object') {
        vhtml = esc(JSON.stringify(v));
      } else {
        vhtml = esc(String(v));
      }
      return '<dt>' + esc(k) + '</dt><dd>' + vhtml + '</dd>';
    }).join('');
    return '<dl class="props">' + rows + '</dl>';
  }

  // ---- reader ----
  var readerEl = document.getElementById('reader');
  function unitLink(id, label) {
    if (byId[id]) return '<a class="ulink" data-unit="' + esc(id) + '">' + esc(label || id) + '</a>';
    return esc(label || id) + ' <span class="badge">not in this snapshot</span>';
  }
  function select(id) {
    var u = byId[id];
    if (!u) return;
    markSelected(id);
    selected = id;
    var edges = (u.edges || []).map(function (e) {
      var st = edgeStyle(e.type);
      return '<li><span class="edge-type-tag" style="background:' + (st.stroke === 'currentColor' ? 'var(--muted)' : st.stroke) + '">' + esc(e.type) + '</span>' + unitLink(e.target) + '</li>';
    }).join('');
    var bl = (backlinks[id] || []).map(function (b) {
      var st = edgeStyle(b.type);
      return '<li><span class="edge-type-tag" style="background:' + (st.stroke === 'currentColor' ? 'var(--muted)' : st.stroke) + '">' + esc(b.type) + '</span>' + unitLink(b.from) + '</li>';
    }).join('');
    readerEl.innerHTML =
      '<h3>' + esc(u.title) + '</h3>' +
      '<div class="unit-id">' + esc(u.id) + ' &middot; ' + esc(u.path) + '</div>' +
      '<div class="badges">' +
        '<span class="badge">' + esc(u.type || 'untyped') + '</span>' +
        '<span class="badge status-' + esc(u.status) + '">' + esc(u.status) + '</span>' +
        (u.updated ? '<span class="badge">updated ' + esc(u.updated) + '</span>' : '') +
        (u.topics || []).map(function (t) { return '<span class="badge">' + esc(t) + '</span>'; }).join('') +
      '</div>' +
      renderProperties(u.properties) +
      '<div class="edges"><b>Edges</b><ul>' + (edges || '<li>none</li>') + '</ul></div>' +
      '<div class="backlinks"><b>Backlinks</b><ul>' + (bl || '<li>none</li>') + '</ul></div>' +
      '<div class="body-md">' + mdToHtml(u.body || '(empty body)') + '</div>';
    document.querySelector('.mode-toggle button[data-mode="focus"]').disabled = false;
    highlightNode(id);
    setMode('focus');
  }
  readerEl.addEventListener('click', function (e) {
    var a = e.target.closest('a.ulink');
    if (a) select(a.getAttribute('data-unit'));
  });

  // ---- graph: DOM built exactly ONCE from the precomputed coordinates.
  // Filters toggle classes on the SVG container (see the generated rule set
  // in the stylesheet); focus/global dim via class toggles; nothing below
  // ever rebuilds this markup — which is also why keyboard focus survives
  // every filter and mode change by construction. ----
  var svg = document.getElementById('graph');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  var r1 = function (v) { return Math.round(v * 10) / 10; };
  var g = null, circleByid = {}, lineRecs = [], linesByNode = {};
  var view = { x: 0, y: 0, k: 1 };
  function applyView() { g.setAttribute('transform', 'translate(' + view.x + ',' + view.y + ') scale(' + view.k + ')'); }

  function buildGraph() {
    var parts = ['<g id="gv">'];
    globalEdges.forEach(function (l) {
      var a = globalPos[l.s], b = globalPos[l.t];
      if (!a || !b) return;
      var st = edgeStyle(l.type);
      var su = byId[l.s], tu = byId[l.t];
      var cls = ['link',
        typeCls[su.type || 'untyped'], statusCls[su.status || 'active'],
        typeCls[tu.type || 'untyped'], statusCls[tu.status || 'active']]
        .filter(function (c, i, arr) { return c && arr.indexOf(c) === i; }).join(' ');
      parts.push('<line class="' + cls + '" data-s="' + esc(l.s) + '" data-t="' + esc(l.t) +
        '" x1="' + r1(a.x) + '" y1="' + r1(a.y) +
        '" x2="' + r1(b.x) + '" y2="' + r1(b.y) + '" stroke="' + st.stroke + '" stroke-width="' + st.width +
        '" stroke-dasharray="' + esc(st.dash) + '" stroke-opacity="' + st.op + '"></line>');
    });
    units.forEach(function (u) {
      var p = globalPos[u.id];
      if (!p) return;
      var rad = Math.min(4 + (deg[u.id] || 0) * 1.2, 14);
      var cls = 'node ' + typeCls[u.type || 'untyped'] + ' ' + statusCls[u.status || 'active'];
      parts.push('<circle class="' + cls + '" tabindex="0" role="button" aria-label="' + esc(u.id) + '" data-unit="' + esc(u.id) + '" cx="' + r1(p.x) + '" cy="' + r1(p.y) +
        '" r="' + r1(rad) + '" fill="' + colorFor(u.type) +
        '" style="cursor:pointer"><title>' + esc(u.id) + '</title></circle>');
    });
    parts.push('</g>');
    svg.innerHTML = parts.join('');
    g = svg.querySelector('#gv');
    circleByid = {}; lineRecs = []; linesByNode = {};
    svg.querySelectorAll('circle[data-unit]').forEach(function (c) { circleByid[c.getAttribute('data-unit')] = c; });
    svg.querySelectorAll('line.link').forEach(function (el) {
      var s = el.getAttribute('data-s'), t = el.getAttribute('data-t');
      lineRecs.push({ el: el, s: s, t: t });
      (linesByNode[s] = linesByNode[s] || []).push(el);
      (linesByNode[t] = linesByNode[t] || []).push(el);
    });
    applyView();
  }

  // ---- mode: global (full-store overview) vs focus (a DOI-ranked local
  // neighborhood). Focus is the shipped default, opened on the most-recently-
  // updated unit; Global stays one visible click away. ----
  var mode = ${JSON.stringify(defaultFocus ? 'focus' : 'global')};
  var focusIds = null;
  // DOI neighborhood: interest = importance - hop distance (Furnas 1986),
  // importance = degree normalized to the graph's max. Ranked, capped at 40 —
  // on a hub a plain 1-hop cutoff is its own hairball; ranking degrades
  // gracefully.
  function neighborhoodOf(id) {
    var hops = {}; hops[id] = 0;
    var q = [id], qi = 0;
    while (qi < q.length) {
      var cur = q[qi++];
      if (hops[cur] >= 6) continue;
      (adj[cur] || []).forEach(function (nb) {
        if (hops[nb] === undefined) { hops[nb] = hops[cur] + 1; q.push(nb); }
      });
    }
    var cand = Object.keys(hops);
    cand.sort(function (a, b) {
      var ia = (deg[a] || 0) / maxDeg - hops[a], ib = (deg[b] || 0) / maxDeg - hops[b];
      if (ib !== ia) return ib - ia;
      if (hops[a] !== hops[b]) return hops[a] - hops[b];
      return a < b ? -1 : a > b ? 1 : 0;
    });
    var ids = cand.slice(0, 40);
    if (ids.indexOf(id) === -1) { ids.pop(); ids.unshift(id); }
    return ids;
  }
  function computeFocus(id) {
    var ids = (DEFAULT_FOCUS && DEFAULT_FOCUS.id === id && DEFAULT_FOCUS.ids) ? DEFAULT_FOCUS.ids : neighborhoodOf(id);
    focusIds = {};
    ids.forEach(function (i) { focusIds[i] = true; });
  }
  // Ghost context: out-of-neighborhood nodes stay visible at their GLOBAL
  // positions, dimmed with opacity — faded, never hidden, so the reader keeps
  // their bearings in the whole store.
  function applyDim() {
    units.forEach(function (u) {
      var c = circleByid[u.id];
      if (c) c.classList.toggle('dim', !!(focusIds && !focusIds[u.id]));
    });
    lineRecs.forEach(function (l) {
      l.el.classList.toggle('dim', !!(focusIds && !(focusIds[l.s] && focusIds[l.t])));
    });
  }
  function zoomToFocus() {
    if (!focusIds) { view = { x: 0, y: 0, k: 1 }; applyView(); return; }
    var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9, any = false;
    Object.keys(focusIds).forEach(function (id) {
      var p = globalPos[id];
      if (!p) return;
      any = true;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    });
    if (!any) { view = { x: 0, y: 0, k: 1 }; applyView(); return; }
    var pad = 70;
    var bw = (maxX - minX) + pad * 2, bh = (maxY - minY) + pad * 2;
    var k2 = Math.max(0.4, Math.min(2.5, Math.min(W / bw, H / bh)));
    var mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
    view = { x: W / 2 - mx * k2, y: H / 2 - my * k2, k: k2 };
    applyView();
  }
  function setMode(next) {
    if (next === 'focus' && !selected && !(DEFAULT_FOCUS && DEFAULT_FOCUS.id)) return;
    mode = next;
    document.querySelectorAll('.mode-toggle button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-mode') === mode);
      b.setAttribute('aria-pressed', String(b.getAttribute('data-mode') === mode));
    });
    if (mode === 'focus') computeFocus(selected || DEFAULT_FOCUS.id);
    else focusIds = null;
    applyDim();
    zoomToFocus();
  }
  document.getElementById('modeToggle').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-mode]');
    if (b && !b.disabled) setMode(b.getAttribute('data-mode'));
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && mode === 'focus') setMode('global');
  });

  // ---- filter chips: ONE class toggled on the SVG container per chip; the
  // fixed generated rule set in the stylesheet does the hiding. No DOM
  // rebuild, no attribute-selector hot path. ----
  function wireChips(containerId, attr) {
    document.getElementById(containerId).addEventListener('click', function (e) {
      var b = e.target.closest('button[' + attr + ']');
      if (!b) return;
      var on = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('off', !on);
      svg.classList.toggle('hide-' + b.getAttribute('data-cls'), !on);
    });
  }
  wireChips('typeFilters', 'data-type');
  wireChips('statusFilters', 'data-status');

  // ---- hover highlight through the precomputed adjacency: O(degree). ----
  var hovered = [];
  function clearHover() { hovered.forEach(function (el) { el.classList.remove('hl'); }); hovered = []; }
  svg.addEventListener('pointerover', function (e) {
    var c = e.target.closest && e.target.closest('circle[data-unit]');
    if (!c) return;
    clearHover();
    var id = c.getAttribute('data-unit');
    var mark = function (el) { if (el) { el.classList.add('hl'); hovered.push(el); } };
    mark(c);
    (adj[id] || []).forEach(function (nb) { mark(circleByid[nb]); });
    (linesByNode[id] || []).forEach(mark);
  });
  svg.addEventListener('pointerout', function (e) {
    var c = e.target.closest && e.target.closest('circle[data-unit]');
    if (c) clearHover();
  });

  var lastHighlight = null;
  function highlightNode(id) {
    if (lastHighlight) lastHighlight.classList.remove('selring');
    var c = circleByid[id];
    if (c) { c.classList.add('selring'); lastHighlight = c; }
  }

  // Click-to-select vs drag-to-pan: setPointerCapture (needed for smooth pan)
  // makes the browser retarget the derived click event to the capturing SVG
  // root, so a plain 'click' listener never sees the circle — selection would
  // silently never fire. Instead: remember the ORIGINAL pointerdown target
  // and treat a low-movement pointerdown→pointerup as the click.
  var dragging = null;
  svg.addEventListener('pointerdown', function (e) {
    dragging = { px: e.clientX, py: e.clientY, ox: view.x, oy: view.y,
      target: e.target, moved: 0 };
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    dragging.moved = Math.max(dragging.moved,
      Math.abs(e.clientX - dragging.px) + Math.abs(e.clientY - dragging.py));
    var scale = W / svg.getBoundingClientRect().width;
    view.x = dragging.ox + (e.clientX - dragging.px) * scale;
    view.y = dragging.oy + (e.clientY - dragging.py) * scale;
    applyView();
  });
  svg.addEventListener('pointerup', function () {
    if (dragging && dragging.moved < 5) {
      var t = dragging.target;
      var c = t && t.closest && t.closest('circle[data-unit]');
      if (c) select(c.getAttribute('data-unit'));
    }
    dragging = null;
  });
  svg.addEventListener('wheel', function (e) {
    e.preventDefault();
    var rect = svg.getBoundingClientRect();
    var mx = (e.clientX - rect.left) * (W / rect.width);
    var my = (e.clientY - rect.top) * (H / rect.height);
    var factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    var k2 = Math.max(0.2, Math.min(8, view.k * factor));
    view.x = mx - (mx - view.x) * (k2 / view.k);
    view.y = my - (my - view.y) * (k2 / view.k);
    view.k = k2;
    applyView();
  }, { passive: false });
  svg.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var c = e.target.closest && e.target.closest('circle[data-unit]');
    if (c) { e.preventDefault(); select(c.getAttribute('data-unit')); }
  });

  // ---- age badge: the page can always know its AGE, never its staleness. ----
  // BANNED: reading the document's lastModified property for this. The HTML
  // spec requires it to return the CURRENT date and time whenever the real
  // modification date is unknown — so a dynamically served page reading it
  // computes an age of zero and reports itself eternally fresh (the
  // eternally-fresh trap). The ONLY age source is the datetime baked into the
  // time element at build.
  var timeEl = document.getElementById('gen-time');
  var ageEl = document.getElementById('age-badge');
  function updateAge() {
    if (!timeEl || !ageEl) return;
    var built = Date.parse(timeEl.getAttribute('datetime'));
    if (isNaN(built)) return;
    var delta = Date.now() - built;
    var txt;
    if (delta < -60000) {
      // clock skew beyond plausible: never render a negative age
      txt = 'generated just now (device clock looks wrong)';
    } else if (delta < 45000) {
      txt = 'generated just now';
    } else {
      var rtf = null;
      try { rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }); } catch (err) { rtf = null; }
      var mins = Math.round(delta / 60000);
      var rel;
      if (mins < 90) rel = rtf ? rtf.format(-mins, 'minute') : mins + ' minutes ago';
      else if (mins < 36 * 60) rel = rtf ? rtf.format(-Math.round(mins / 60), 'hour') : Math.round(mins / 60) + ' hours ago';
      else rel = rtf ? rtf.format(-Math.round(mins / 1440), 'day') : Math.round(mins / 1440) + ' days ago';
      txt = 'generated ' + rel;
      if (delta > 86400000) txt += ' — reload for the latest';
    }
    ageEl.textContent = txt;
  }
  // visibilitychange is the one legitimate no-network hook: a backgrounded
  // tab recomputes its displayed age on refocus, without polling.
  document.addEventListener('visibilitychange', function () { if (!document.hidden) updateAge(); });

  // ---- init: build once, then open on the local neighborhood ----
  buildGraph();
  buildList();
  applyListFilter('');
  updateAge();
  if (DEFAULT_FOCUS && byId[DEFAULT_FOCUS.id]) {
    select(DEFAULT_FOCUS.id);
  } else {
    setMode('global');
  }
})();
</script>
`;
}

// ============================================================
// Orchestration — generate, manifest, receipt.
// ============================================================

/**
 * Metrics for the page, decoupled from the render hot path. Three outcomes:
 *   - metricsProvider === null (--no-metrics): honest absence, cache untouched.
 *   - a metricsCachePath whose file EXISTS: the cached block is embedded
 *     verbatim, labeled with the cache's OWN timestamp ("metrics as of") —
 *     gatherMetrics() never runs. An unreadable/invalid cache falls through
 *     to a live run, which rewrites it.
 *   - otherwise: the live provider runs (current default-door behavior), and
 *     when a cache path was named, the block + timestamp are written there
 *     (sibling-tmp atomic write) so a watch loop can reuse them. A cache
 *     write failure never blocks the render — the page still carries the
 *     live block; the failure is narrated on stderr.
 */
export async function resolveMetricsForRender(root, {
  metricsProvider, metricsCachePath = null, generatedAt,
} = {}) {
  if (metricsProvider === null) {
    return { available: false, reason: 'skipped by --no-metrics for this generation' };
  }
  if (metricsCachePath && existsSync(metricsCachePath)) {
    try {
      const cache = JSON.parse(readFileSync(metricsCachePath, 'utf8'));
      if (cache && typeof cache.report === 'string' && cache.generated_at) {
        return {
          available: true, report: cache.report,
          mechanics_status: cache.mechanics_status ?? null,
          cached: true, as_of: String(cache.generated_at),
        };
      }
    } catch { /* unreadable cache: fall through to a live run, which rewrites it */ }
  }
  try {
    const m = await metricsProvider(root);
    if (metricsCachePath) {
      try {
        mkdirSync(dirname(metricsCachePath), { recursive: true });
        atomicWriteFileSync(metricsCachePath, JSON.stringify({
          kind: 'core-memory-metrics-cache',
          generated_at: generatedAt,
          report: m.report,
          mechanics_status: m.mechanics?.status ?? null,
        }, null, 2) + '\n');
      } catch (e) {
        process.stderr.write(`render-browse-artifact: metrics cache write failed (${e && e.message}) — the page still carries the live metrics\n`);
      }
    }
    return {
      available: true, report: m.report,
      mechanics_status: m.mechanics?.status ?? null,
      cached: false, as_of: generatedAt,
    };
  } catch (e) {
    return { available: false, reason: String(e && e.message || e).slice(0, 200) };
  }
}

export async function renderBrowseArtifact(projectDir, {
  outPath,
  scope = 'active',
  excludeTopics = [],
  home = null,
  metricsCachePath = null,
  now = () => new Date(),
  // Injectable for tests (and skippable via CLI --no-metrics): defaults to the
  // real canonical gatherer. Fails open into an honest absence line — a
  // metrics hiccup must not block the browse snapshot.
  metricsProvider = (dir) => gatherMetrics(dir),
  // Injection point for the mutation window between the artifact write and the
  // post-write verification.
  onArtifactWritten = null,
} = {}) {
  const root = resolve(projectDir);
  if (!outPath) throw Object.assign(new Error('--out <path> is required — there is no default output location'), { code: 'OUT_REQUIRED' });
  const memoriesRoot = join(root, '_memories');
  // Canonical containment, and the destination is claimed before the store is
  // read: a linked --out is rejected on its real target, not its spelling.
  const outAbs = resolveArtifactDestination(outPath, { forbiddenRoot: memoriesRoot });
  if (scope !== 'active' && scope !== 'all-including-archive') {
    throw Object.assign(new Error(`unknown --scope '${scope}' (valid: active, all-including-archive)`), { code: 'BAD_SCOPE' });
  }
  let metricsCacheAbs = null;
  if (metricsCachePath) {
    metricsCacheAbs = resolve(metricsCachePath);
    // Same read-only-store discipline as --out: the cache is operational
    // state, never store content.
    if (metricsCacheAbs === memoriesRoot || metricsCacheAbs.startsWith(memoriesRoot + sep)) {
      throw Object.assign(new Error(
        '--metrics-cache must not resolve inside _memories/ — the store is read-only to this generator'), { code: 'CACHE_IN_STORE' });
    }
  }

  // Fail closed on producer identity BEFORE reading the store or writing
  // anything: a page whose provenance cannot be established must never be
  // rendered for publish.
  const producer = producerIdentity();
  if (!producer.source_sha) {
    throw Object.assign(new Error(
      'cannot establish producer identity: not a git source checkout and the plugin manifest carries no source_sha — ' +
      'failing closed rather than rendering a page with unknown provenance'), { code: 'NO_SOURCE_SHA' });
  }

  const generatedAt = now().toISOString();
  const collected = collectUnits(root, { scope, excludeTopics });

  const metrics = await resolveMetricsForRender(root, {
    metricsProvider, metricsCachePath: metricsCacheAbs, generatedAt,
  });

  const scopeDesc = `scope: ${scope}` + (excludeTopics.length ? ` (excluding topics: ${excludeTopics.join(', ')})` : '');
  const html = buildArtifactHtml({
    units: collected.units,
    meta: {
      projectName: basename(root),
      generatedAt,
      producer,
      snapshotId: collected.snapshotId,
      scopeDesc,
      unitCount: collected.units.length,
      metrics,
    },
  });

  // No workspace.json → the flagged fallback location; the audit trail is kept anyway.
  const { workspaceId, receiptDir, receiptPath } = generationReceiptLocation({
    // The receipt is the audit trail; its root comes from the OS-account home
    // unless a caller names one explicitly (test isolation, --home).
    home: home || requireTrustedHome(), projectDir: root, generatedAt,
  });

  const manifest = {
    kind: 'core-memory-browse-preflight',
    schema_version: BROWSE_MANIFEST_SCHEMA_VERSION,
    generated_at: generatedAt,
    producer,
    project: root,
    workspace_id: workspaceId,
    snapshot_id: collected.snapshotId,
    scope: { mode: scope, excluded_topics: excludeTopics.slice() },
    unit_count: collected.units.length,
    active_count: collected.activeCount,
    supplemental_count: collected.supplementalCount,
    excluded_by_topic_count: collected.excludedByTopic,
    // Structural loss is disclosed, not absorbed: a file that could not be
    // parsed is named here rather than embedded as a blank unit, so the count
    // above is never read as "the whole store".
    unreadable_count: collected.unreadable.length,
    unreadable_paths: collected.unreadable.map((u) => u.path),
    total_bytes: Buffer.byteLength(html),
    // Exact-byte identity of the generated page — the publish receipt copies
    // this and binds the publish to these specific bytes.
    artifact_sha256: artifactContentDigest(html),
    metrics_included: metrics.available,
    // Where the health block came from: 'live' (gatherMetrics ran), 'cache'
    // (carried forward from the last full run, stamped with its own time),
    // or 'none'. metrics_as_of is that stamp.
    metrics_source: metrics.available ? (metrics.cached ? 'cache' : 'live') : 'none',
    metrics_as_of: metrics.available ? metrics.as_of : null,
    out_path: outAbs,
    receipt_path: receiptPath,
    receipt_fallback: workspaceId === null,
    sensitivity_warning: SENSITIVITY_WARNING,
  };

  // One transaction: the bytes are placed, read back, and proven to be the
  // rendered bytes before the receipt that describes them is written; a receipt
  // that cannot land takes the artifact with it rather than leaving something
  // publishable with no audit trail.
  publishArtifactWithReceipt({
    outPath: outAbs, html, receiptDir, receiptPath, manifest,
    forbiddenRoot: memoriesRoot, afterWrite: onArtifactWritten,
  });

  return { manifest, html, receiptWritten: true };
}

// ============================================================
// Post-publish receipt — separate from
// the preflight-generation receipt above. The generation receipt records what
// was generated and offered; the publish receipt is the audit trail of what
// actually happened at the consent/publish boundary — including declined and
// failed outcomes, so a "no" leaves a record too. Implementation shared with
// every artifact generator via artifact-receipts.mjs (kind mapping:
// core-memory-browse-preflight -> core-memory-browse-publish); re-exported
// above so this module stays the browse flow's single import site.
// ============================================================

// ---------- CLI ----------

function parseArgs(argv) {
  const opts = { excludeTopics: [], scope: 'active', outPath: null, home: null, noMetrics: false, metricsCache: null };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') { opts.outPath = argv[++i]; }
    else if (a === '--scope') { opts.scope = argv[++i]; }
    else if (a === '--exclude-topic') { opts.excludeTopics.push(argv[++i]); }
    else if (a === '--home') { opts.home = argv[++i]; }
    else if (a === '--no-metrics') { opts.noMetrics = true; }
    else if (a === '--metrics-cache') { opts.metricsCache = argv[++i]; }
    else if (a.startsWith('--')) { throw Object.assign(new Error(`unknown option ${a}`), { code: 'BAD_OPTION' }); }
    else positionals.push(a);
  }
  opts.projectDir = positionals[0] || process.cwd();
  if (opts.noMetrics && opts.metricsCache) {
    // Refuse the contradiction loudly instead of letting one flag silently
    // win: --metrics-cache promises a carried-forward health block and
    // --no-metrics drops the health block entirely. A documented recipe
    // carried both for a while and every refresh silently lost its cached
    // health section.
    throw Object.assign(new Error(
      '--metrics-cache contradicts --no-metrics (one carries the cached health block forward, the other drops the health section) — pass exactly one'), { code: 'METRICS_FLAG_CONFLICT' });
  }
  return opts;
}

async function main(argv) {
  if (argv.includes('--record-publish') || argv.includes('--record-revocation')) {
    return runRecordCli(argv, { label: 'render-browse-artifact' });
  }
  let opts;
  try { opts = parseArgs(argv); } catch (e) {
    process.stderr.write(`render-browse-artifact: ${e.message}\n`);
    return 2;
  }
  try {
    const { manifest, receiptWritten } = await renderBrowseArtifact(opts.projectDir, {
      outPath: opts.outPath,
      scope: opts.scope,
      excludeTopics: opts.excludeTopics,
      ...(opts.home ? { home: opts.home } : {}),
      ...(opts.noMetrics ? { metricsProvider: null } : {}),
      ...(opts.metricsCache ? { metricsCachePath: opts.metricsCache } : {}),
    });
    process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
    if (!receiptWritten) {
      process.stderr.write(`render-browse-artifact: WROTE the HTML but the local receipt failed (${manifest.receipt_error}) — the audit trail for this generation is missing; do not publish until a receipt lands.\n`);
      return 1;
    }
    return 0;
  } catch (e) {
    if (e.code === 'OUT_REQUIRED' || e.code === 'BAD_SCOPE' || e.code === 'OUT_IN_STORE' || e.code === 'CACHE_IN_STORE') {
      process.stderr.write(`render-browse-artifact: ${e.message}\n`);
      return 2;
    }
    if (e.code === 'NO_SOURCE_SHA') {
      // Fail closed for publish: no HTML was written, no manifest printed.
      process.stderr.write(`render-browse-artifact: ${e.message}\n`);
      return 1;
    }
    process.stderr.write(`render-browse-artifact: failed — ${e.stack || e}\n`);
    return 1;
  }
}

// Entry check compares REAL paths on both sides: Node realpaths the main
// module (import.meta.url is /private/var/... on macOS) while argv[1] may be
// the symlinked spelling (/var/folders/...). A naive string compare silently
// skips main() and exits 0 having done nothing — a lying instrument.
const _cliEntry = (() => {
  try {
    const self = fileURLToPath(import.meta.url);
    const invoked = resolve(process.argv[1] || '');
    if (self === invoked) return true;
    try { return self === realpathSync(invoked); } catch { return false; }
  } catch { return false; }
})();
if (_cliEntry) {
  process.exit(await main(process.argv.slice(2)));
}
