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
 * Read-only guarantee: the store is read through loadSnapshot (the exact
 * read path decorate-graph.mjs uses). No unit file is ever written. (The
 * canonical loader may refresh its own derived cache at
 * `_memories/_lib/unit-summaries.json` when absent/stale — that is the
 * loader's documented behavior on EVERY read path, not a content write.)
 *
 * CLI:
 *   node render-browse-artifact.mjs <project-dir> --out <path>
 *        [--scope active|all-including-archive] [--exclude-topic <t>]...
 *        [--no-metrics] [--home <dir>]
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
 * --out, bad --scope, --out inside _memories/, bad record-mode input);
 * 1 fatal failure (including fail-closed producer identity).
 */
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadSnapshot, stripGeneratedEdgesBlock, deriveSummary } from './generate-summary-index.mjs';
import { parseFrontmatter, extractEdges } from './priority.mjs';
import { gatherMetrics } from './metrics-check.mjs';
import { truthfulProducerIdentity } from './artifact-provenance.mjs';
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
function walkAllUnitFiles(memoriesDir) {
  const out = [];
  const walkDir = (dir, relPrefix) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
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
 * collectUnits — the embed population. Default scope is EXACTLY the
 * loadSnapshot active population (archived excluded by path, retired/
 * superseded excluded by status, invalidated excluded by t_invalid — same
 * filtering decoration uses). `all-including-archive` adds every other unit
 * file (archive/ + terminal-status units) as clearly-marked supplements
 * without changing the active population or the snapshot id.
 */
export function collectUnits(projectDir, { scope = 'active', excludeTopics = [] } = {}) {
  const root = resolve(projectDir);
  const cap = loadSnapshot(root, { captureBodies: true, retainRaw: true });
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
    const { body } = parsed;
    units.push({
      id: u.id, path: u.path, type: u.type || '', status: u.status || 'active',
      topics: u.topics || [], updated: u.updated || '',
      title: deriveSummary(body) || u.id,
      body,
      edges: cap.edges[u.id] || [],
      population: 'active',
    });
    seenIds.add(u.id);
  }

  let supplementalCount = 0;
  if (scope === 'all-including-archive') {
    for (const f of walkAllUnitFiles(join(root, '_memories'))) {
      if (activePaths.has(f.rel)) continue;
      let text;
      try { text = readFileSync(f.full, 'utf8'); }
      catch (e) { unreadable.push({ path: f.rel, reason: String(e && e.code || e).slice(0, 120) }); continue; }
      const parsed = displayBody(text);
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

  return {
    units: kept,
    snapshotId: cap.snapshotId,
    activeCount: kept.filter((u) => u.population === 'active').length,
    supplementalCount: supplementalCount === 0 ? 0 : kept.filter((u) => u.population !== 'active').length,
    excludedByTopic,
    unreadable,
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

export function buildArtifactHtml({ units, meta }) {
  const data = inlineJson({ units });
  const m = meta;
  const shaShort = m.producer.source_sha ? String(m.producer.source_sha).slice(0, 12) : 'unknown-sha';
  const metricsBlock = m.metrics && m.metrics.available
    ? `<pre class="metrics-report">${escapeHtml(m.metrics.report)}</pre>
<p class="metrics-note">Rendered verbatim by the canonical <code>metrics-check.mjs</code> renderer at generation time (${escapeHtml(m.generatedAt)}) — four separate evidence classes, each with its own honest trust label. This is part of the same point-in-time snapshot as everything else on this page.</p>`
    : `<p class="metrics-note">Memory-health metrics were not gathered for this snapshot: ${escapeHtml((m.metrics && m.metrics.reason) || 'unknown reason')}. Run <code>/metrics</code> in a terminal for the live check.</p>`;

  return `<title>CORE Memory — ${escapeHtml(m.projectName)}</title>
<style>
  :root {
    --bg: #f8f7f4; --panel: #ffffff; --ink: #1f2430; --muted: #5b6472;
    --line: #d9d5cc; --accent: #7c5cff; --accent-ink: #4a34b8;
    --banner-bg: #8a2d0b; --banner-stripe: #6f2408; --banner-ink: #ffffff;
    --code-bg: #efede8;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14161c; --panel: #1d2129; --ink: #e8e6e1; --muted: #9aa3b2;
      --line: #333947; --accent: #a08cff; --accent-ink: #c4b8ff;
      --banner-bg: #7a2607; --banner-stripe: #5e1d05; --banner-ink: #ffe9de;
      --code-bg: #262b36;
    }
  }
  :root[data-theme="dark"] {
    --bg: #14161c; --panel: #1d2129; --ink: #e8e6e1; --muted: #9aa3b2;
    --line: #333947; --accent: #a08cff; --accent-ink: #c4b8ff;
    --banner-bg: #7a2607; --banner-stripe: #5e1d05; --banner-ink: #ffe9de;
    --code-bg: #262b36;
  }
  :root[data-theme="light"] {
    --bg: #f8f7f4; --panel: #ffffff; --ink: #1f2430; --muted: #5b6472;
    --line: #d9d5cc; --accent: #7c5cff; --accent-ink: #4a34b8;
    --banner-bg: #8a2d0b; --banner-stripe: #6f2408; --banner-ink: #ffffff;
    --code-bg: #efede8;
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
  main { max-width: 1200px; margin: 0 auto; padding: 1.2rem; }
  h1 { font-size: 1.5rem; margin: 0.6rem 0 0.2rem; }
  h2 { font-size: 1.15rem; margin: 2rem 0 0.6rem; border-bottom: 1px solid var(--line); padding-bottom: 0.3rem; }
  .subtitle { color: var(--muted); margin: 0 0 1rem; }
  .graph-wrap { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; position: relative; }
  .graph-wrap svg { display: block; width: 100%; height: 58vh; min-height: 340px; cursor: grab; touch-action: none; }
  .graph-hint { position: absolute; right: 0.7rem; top: 0.6rem; font-size: 0.75rem; color: var(--muted);
    background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 0.15rem 0.55rem; opacity: 0.9; }
  .legend { display: flex; flex-wrap: wrap; gap: 0.45rem 1rem; padding: 0.6rem 0.8rem; border-top: 1px solid var(--line); font-size: 0.8rem; }
  .legend span::before { content: ""; display: inline-block; width: 0.7em; height: 0.7em; border-radius: 50%; margin-right: 0.35em; background: var(--dot, var(--muted)); }
  .browser { display: grid; grid-template-columns: minmax(240px, 1fr) minmax(0, 2fr); gap: 1rem; align-items: start; }
  @media (max-width: 800px) { .browser { grid-template-columns: 1fr; } }
  .unit-list { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; max-height: 70vh; overflow: auto; }
  .unit-list input { width: 100%; border: 0; border-bottom: 1px solid var(--line); background: transparent; color: var(--ink);
    padding: 0.6rem 0.8rem; font: inherit; position: sticky; top: 0; background: var(--panel); outline: none; }
  .unit-list ul { list-style: none; margin: 0; padding: 0.3rem 0; }
  .unit-list li { padding: 0.35rem 0.8rem; cursor: pointer; border-left: 3px solid transparent; }
  .unit-list li:hover { background: var(--code-bg); }
  .unit-list li.sel { border-left-color: var(--accent); background: var(--code-bg); }
  .unit-list .uid { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.78rem; overflow-wrap: anywhere; }
  .unit-list .utitle { font-size: 0.82rem; color: var(--muted); overflow-wrap: anywhere; }
  .type-head { padding: 0.5rem 0.8rem 0.15rem; font-size: 0.72rem; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.07em; color: var(--muted); }
  .reader { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 1rem 1.2rem; min-height: 12rem; }
  .reader .placeholder { color: var(--muted); }
  .badges { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0.4rem 0 0.8rem; }
  .badge { font-size: 0.72rem; padding: 0.1rem 0.55rem; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
  .badge.status-archived, .badge.status-retired, .badge.status-superseded { border-color: var(--banner-bg); color: var(--banner-ink); background: var(--banner-bg); }
  .reader h3 { margin: 0; font-size: 1.2rem; }
  .reader .unit-id { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.8rem; color: var(--muted); overflow-wrap: anywhere; }
  .edges, .backlinks { margin: 0.8rem 0; font-size: 0.86rem; }
  .edges b, .backlinks b { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
  a.ulink { color: var(--accent-ink); cursor: pointer; text-decoration: underline; overflow-wrap: anywhere; }
  .body-md { border-top: 1px solid var(--line); margin-top: 0.8rem; padding-top: 0.8rem; overflow-x: auto; }
  .body-md h4 { margin: 1rem 0 0.4rem; }
  .body-md pre { background: var(--code-bg); padding: 0.6rem 0.8rem; border-radius: 8px; overflow-x: auto; font-size: 0.82rem; }
  .body-md code { background: var(--code-bg); border-radius: 4px; padding: 0.05rem 0.3rem; font-size: 0.85em;
    font-family: ui-monospace, Menlo, Consolas, monospace; }
  .body-md pre code { background: none; padding: 0; }
  .metrics-report { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 1rem;
    overflow-x: auto; font-size: 0.8rem; line-height: 1.45; font-family: ui-monospace, Menlo, Consolas, monospace; }
  .metrics-note { color: var(--muted); font-size: 0.85rem; }
  footer { color: var(--muted); font-size: 0.8rem; margin: 2.5rem 0 1rem; text-align: center; }
</style>
<div class="snapshot-banner">
  <div class="headline">POINT-IN-TIME SNAPSHOT &mdash; READ-ONLY</div>
  <div class="provenance">generated ${escapeHtml(m.generatedAt)} &middot; ${escapeHtml(m.producer.plugin || 'core')} v${escapeHtml(m.producer.plugin_version || 'unknown')} (${escapeHtml(shaShort)}) &middot; store snapshot ${escapeHtml(String(m.snapshotId).slice(0, 12))} &middot; ${escapeHtml(m.scopeDesc)} &middot; ${m.unitCount} units</div>
</div>
<main>
  <h1>CORE Memory — ${escapeHtml(m.projectName)}</h1>
  <p class="subtitle">What CORE knows in this project's memory store, frozen at the moment in the banner above. Nothing here is live, and nothing here can be edited — <code>PROJECT.md</code> and the store itself remain the only writing surfaces.</p>

  <h2>Graph</h2>
  <div class="graph-wrap">
    <svg id="graph" role="img" aria-label="Unit graph"></svg>
    <div class="graph-hint">drag to pan &middot; scroll to zoom &middot; click a node to read</div>
    <div class="legend" id="legend"></div>
  </div>

  <h2>Units</h2>
  <div class="browser">
    <div class="unit-list">
      <input id="filter" type="search" placeholder="Filter by id, title, or topic&hellip;" aria-label="Filter units">
      <ul id="list"></ul>
    </div>
    <div class="reader" id="reader"><p class="placeholder">Click a node or a list entry to read the full unit.</p></div>
  </div>

  <h2>Memory health</h2>
  ${metricsBlock}

  <footer>Full snapshot id ${escapeHtml(m.snapshotId)} &middot; self-contained page, zero external resources.</footer>
</main>
<script type="application/json" id="core-data">${data}</script>
<script>
(function () {
  'use strict';
  var DATA = JSON.parse(document.getElementById('core-data').textContent);
  var units = DATA.units;
  var byId = {};
  units.forEach(function (u) { byId[u.id] = u; });
  var backlinks = {};
  units.forEach(function (u) {
    (u.edges || []).forEach(function (e) {
      if (!backlinks[e.target]) backlinks[e.target] = [];
      backlinks[e.target].push({ from: u.id, type: e.type });
    });
  });

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

  // ---- unit list ----
  var listEl = document.getElementById('list');
  var selected = null;
  function renderList(filter) {
    var f = (filter || '').toLowerCase();
    var byType = {};
    units.forEach(function (u) {
      var hay = (u.id + ' ' + u.title + ' ' + (u.topics || []).join(' ')).toLowerCase();
      if (f && hay.indexOf(f) === -1) return;
      var t = u.type || 'untyped';
      (byType[t] = byType[t] || []).push(u);
    });
    var html = '';
    Object.keys(byType).sort().forEach(function (t) {
      html += '<li class="type-head">' + esc(t) + ' (' + byType[t].length + ')</li>';
      byType[t].forEach(function (u) {
        html += '<li data-unit="' + esc(u.id) + '"' + (u.id === selected ? ' class="sel"' : '') + '>' +
          '<div class="uid">' + esc(u.id) + '</div><div class="utitle">' + esc(u.title) + '</div></li>';
      });
    });
    listEl.innerHTML = html || '<li class="type-head">no units match</li>';
  }
  document.getElementById('filter').addEventListener('input', function (e) { renderList(e.target.value); });
  listEl.addEventListener('click', function (e) {
    var li = e.target.closest('li[data-unit]');
    if (li) select(li.getAttribute('data-unit'));
  });

  // ---- reader ----
  var readerEl = document.getElementById('reader');
  function unitLink(id, label) {
    if (byId[id]) return '<a class="ulink" data-unit="' + esc(id) + '">' + esc(label || id) + '</a>';
    return esc(label || id) + ' <span class="badge">not in this snapshot</span>';
  }
  function select(id) {
    var u = byId[id];
    if (!u) return;
    selected = id;
    var edges = (u.edges || []).map(function (e) {
      return '<li>' + esc(e.type) + ' &rarr; ' + unitLink(e.target) + '</li>';
    }).join('');
    var bl = (backlinks[id] || []).map(function (b) {
      return '<li>' + unitLink(b.from) + ' &mdash; ' + esc(b.type) + '</li>';
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
      '<div class="edges"><b>Edges</b><ul>' + (edges || '<li>none</li>') + '</ul></div>' +
      '<div class="backlinks"><b>Backlinks</b><ul>' + (bl || '<li>none</li>') + '</ul></div>' +
      '<div class="body-md">' + mdToHtml(u.body || '(empty body)') + '</div>';
    renderList(document.getElementById('filter').value);
    highlightNode(id);
  }
  readerEl.addEventListener('click', function (e) {
    var a = e.target.closest('a.ulink');
    if (a) select(a.getAttribute('data-unit'));
  });

  // ---- graph: tiny force layout + pan/zoom, all inline ----
  var PALETTE = ['#7c5cff', '#2f9e78', '#d97706', '#dc4b6b', '#2b7fd9', '#8a8f2c', '#b04ad9', '#5b6472'];
  var types = [];
  units.forEach(function (u) { var t = u.type || 'untyped'; if (types.indexOf(t) === -1) types.push(t); });
  types.sort();
  function colorFor(type) { return PALETTE[types.indexOf(type || 'untyped') % PALETTE.length]; }

  var W = 1200, H = 760;
  var nodes = units.map(function (u, i) {
    var a = (i / units.length) * Math.PI * 2;
    var r = Math.min(W, H) * 0.35 * (0.55 + 0.45 * ((i * 2654435761 % 1000) / 1000));
    return { id: u.id, type: u.type || 'untyped', x: W / 2 + r * Math.cos(a), y: H / 2 + r * Math.sin(a), deg: 0 };
  });
  var nodeIx = {};
  nodes.forEach(function (n, i) { nodeIx[n.id] = i; });
  var links = [];
  units.forEach(function (u) {
    (u.edges || []).forEach(function (e) {
      if (nodeIx[e.target] === undefined) return;
      links.push({ s: nodeIx[u.id], t: nodeIx[e.target] });
      nodes[nodeIx[u.id]].deg++; nodes[nodeIx[e.target]].deg++;
    });
  });
  var iterations = units.length > 250 ? 120 : 220;
  for (var it = 0; it < iterations; it++) {
    var cool = 1 - it / iterations;
    for (var i = 0; i < nodes.length; i++) {
      var a = nodes[i];
      for (var j = i + 1; j < nodes.length; j++) {
        var b = nodes[j];
        var dx = a.x - b.x, dy = a.y - b.y;
        var d2 = dx * dx + dy * dy + 0.01;
        if (d2 > 90000) continue;
        var f = 2600 / d2 * cool;
        var d = Math.sqrt(d2);
        a.x += dx / d * f; a.y += dy / d * f;
        b.x -= dx / d * f; b.y -= dy / d * f;
      }
    }
    links.forEach(function (l) {
      var a = nodes[l.s], b = nodes[l.t];
      var dx = b.x - a.x, dy = b.y - a.y;
      var d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      var f = (d - 80) * 0.02 * cool;
      a.x += dx / d * f; a.y += dy / d * f;
      b.x -= dx / d * f; b.y -= dy / d * f;
    });
    nodes.forEach(function (n) {
      n.x += (W / 2 - n.x) * 0.004 * cool;
      n.y += (H / 2 - n.y) * 0.004 * cool;
    });
  }

  // SVG built as markup inside the existing <svg> element so the namespace is
  // inherited from the parser — deliberately no createElementNS, so the page
  // contains no namespace URI string and the zero-external-reference guarantee
  // is grep-absolute over the whole chrome.
  var svg = document.getElementById('graph');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  var r1 = function (v) { return Math.round(v * 10) / 10; };
  var parts = ['<g id="gv">'];
  links.forEach(function (l) {
    parts.push('<line x1="' + r1(nodes[l.s].x) + '" y1="' + r1(nodes[l.s].y) +
      '" x2="' + r1(nodes[l.t].x) + '" y2="' + r1(nodes[l.t].y) +
      '" stroke="currentColor" stroke-opacity="0.18"></line>');
  });
  nodes.forEach(function (n) {
    parts.push('<circle data-unit="' + esc(n.id) + '" cx="' + r1(n.x) + '" cy="' + r1(n.y) +
      '" r="' + r1(Math.min(4 + n.deg * 1.2, 14)) + '" fill="' + colorFor(n.type) +
      '" style="cursor:pointer"><title>' + esc(n.id) + '</title></circle>');
  });
  parts.push('</g>');
  svg.innerHTML = parts.join('');
  var g = svg.querySelector('#gv');
  var circleByid = {};
  svg.querySelectorAll('circle[data-unit]').forEach(function (c) {
    circleByid[c.getAttribute('data-unit')] = c;
  });
  var lastHighlight = null;
  function highlightNode(id) {
    if (lastHighlight) { lastHighlight.setAttribute('stroke', 'none'); }
    var c = circleByid[id];
    if (c) { c.setAttribute('stroke', 'currentColor'); c.setAttribute('stroke-width', '3'); lastHighlight = c; }
  }

  var view = { x: 0, y: 0, k: 1 };
  function applyView() { g.setAttribute('transform', 'translate(' + view.x + ',' + view.y + ') scale(' + view.k + ')'); }
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

  var legend = document.getElementById('legend');
  legend.innerHTML = types.map(function (t) {
    return '<span style="--dot:' + colorFor(t) + '">' + esc(t) + '</span>';
  }).join('');

  renderList('');
})();
</script>
`;
}

// ============================================================
// Orchestration — generate, manifest, receipt.
// ============================================================

export async function renderBrowseArtifact(projectDir, {
  outPath,
  scope = 'active',
  excludeTopics = [],
  home = homedir(),
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

  let metrics;
  if (metricsProvider === null) {
    metrics = { available: false, reason: 'skipped by --no-metrics for this generation' };
  } else {
    try {
      const m = await metricsProvider(root);
      metrics = { available: true, report: m.report, mechanics_status: m.mechanics?.status ?? null };
    } catch (e) {
      metrics = { available: false, reason: String(e && e.message || e).slice(0, 200) };
    }
  }

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
  const { workspaceId, receiptDir, receiptPath } = generationReceiptLocation({ home, projectDir: root, generatedAt });

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
  const opts = { excludeTopics: [], scope: 'active', outPath: null, home: null, noMetrics: false };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') { opts.outPath = argv[++i]; }
    else if (a === '--scope') { opts.scope = argv[++i]; }
    else if (a === '--exclude-topic') { opts.excludeTopics.push(argv[++i]); }
    else if (a === '--home') { opts.home = argv[++i]; }
    else if (a === '--no-metrics') { opts.noMetrics = true; }
    else if (a.startsWith('--')) { throw Object.assign(new Error(`unknown option ${a}`), { code: 'BAD_OPTION' }); }
    else positionals.push(a);
  }
  opts.projectDir = positionals[0] || process.cwd();
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
    });
    process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
    if (!receiptWritten) {
      process.stderr.write(`render-browse-artifact: WROTE the HTML but the local receipt failed (${manifest.receipt_error}) — the audit trail for this generation is missing; do not publish until a receipt lands.\n`);
      return 1;
    }
    return 0;
  } catch (e) {
    if (e.code === 'OUT_REQUIRED' || e.code === 'BAD_SCOPE' || e.code === 'OUT_IN_STORE') {
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
