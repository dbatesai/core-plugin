#!/usr/bin/env node
// render-okf-export.mjs — Obsidian-readable, OKF v0.1-draft-conformant projection
// of a CORE unit store. Ported into the plugin 2026-07-19 (David's build
// directive 2026-07-15 named this port for after the v3.12.0 sequenced batch,
// which has since shipped) from the workshop prototype at
// CORE/scripts/render-okf-export.mjs.
//
// Design source: docs/specs/2026-07-13-okf-obsidian-compatible-projection.md
// (revised minimum-viable design) + Hale's seven corrections
// (core-codex/_outputs/2026-07-14/hale-okf-obsidian-projection-review.md).
//
// Guarantees (exactly these, per Hale correction 4 — narrowed claim):
//   "No retired unit documents and no generated edges to retired/invalid
//   targets appear in the projection." Active unit BODIES may still mention
//   retired facts in prose — body-content policy is explicitly out of scope.
//
// Export-only: the live store is NEVER mutated (adversarial-pass finding 1).
// Built from ONE validated atomic snapshot (Hale correction 3): loadSnapshot
// with captureBodies is the plugin's own single-read capture — id, index,
// bodies, and edges derive from the same buffers, so the manifest's
// snapshot_id pins the exact bytes projected. No new store-walking code.
//
// CLI:
//   node render-okf-export.mjs <project-dir> [--out <dir>] [--check]

import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, lstatSync, renameSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, basename, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSnapshot } from './generate-summary-index.mjs';
import { pidAlive, withFileLock } from './file-lock.mjs';

export const GENERATOR_VERSION = '0.1.0';
export const INDEX_NOTE_NAME = 'index.md';
// Hale correction 6: pin the exact upstream revision the conformance claim is
// made against. okf/SPEC.md @ GoogleCloudPlatform/knowledge-catalog.
export const OKF_SPEC_PIN = 'ee67a5ca27044ebe7c38385f5b6cffc2305a9c1a'; // 2026-06-12, v0.1 Draft
export const MANIFEST_NAME = 'okf-export-manifest.json';

// Allow-list per spec: knowledge units only — INDEX-*/README/MEMORY are store
// scaffolding, not OKF documents (validate.mjs skip-list honored).
const SCAFFOLD = /(^|\/)(INDEX[^/]*|README|MEMORY|log)\.md$/i;

// Neutralizes markdown link/emphasis syntax in hand-authored text (e.g. a
// source unit's own H1) before it's spliced into a file that's supposed to
// be entirely generated and pre-validated. Backslash-escaping is enough for
// CommonMark/Obsidian to render the characters literally instead of parsing
// them as syntax.
const escapeMdText = (s) => s.replace(/[[\]\\]/g, '\\$&');

/**
 * ensureGitignored — idempotent append, same pattern as mailbox.mjs's
 * ensureGitignored. Only fires when outDir resolves to a direct child of
 * projectDir (the default `<project>/_okf-export` case); an explicit
 * out-of-project --out is left alone.
 */
function ensureGitignored(projectDir, outDir) {
  const rel = relative(resolve(projectDir), resolve(outDir));
  if (!rel || rel.startsWith('..') || rel.includes('/')) return; // not a direct child — leave it alone
  const gi = join(projectDir, '.gitignore');
  let cur = '';
  try { cur = readFileSync(gi, 'utf8'); } catch { /* none yet */ }
  const pattern = new RegExp(`^${rel}\\/?\\s*$`, 'm');
  if (pattern.test(cur)) return;
  const add = (cur && !cur.endsWith('\n') ? '\n' : '') + `${rel}/\n`;
  try { writeFileSync(gi, cur + add); } catch { /* read-only tree — best effort */ }
}

/**
 * validateLinkDensityThreshold — the JS API contract. STRICT: only an
 * actual `number` (finite, in [0,100]) or null/undefined ("no gate")
 * are accepted. Hale's second re-audit (34e57be) found the first version
 * used `Number(t)` coercion, so `"10"`, `""`, `" "`, `true`, `false`, and
 * `[]` all silently converted to valid numbers instead of being rejected
 * -- a caller could pass a string and never know it wasn't a number. No
 * coercion of any kind here; string parsing is a CLI-only concern, done
 * explicitly and separately by parseLinkDensityThresholdArg below.
 */
export function validateLinkDensityThreshold(t) {
  if (t === null || t === undefined) return null;
  if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > 100) {
    throw Object.assign(
      new Error(`link density threshold must be a finite number in [0,100], got ${JSON.stringify(t)} (${typeof t})`),
      { code: 'INVALID_LINK_DENSITY_THRESHOLD' },
    );
  }
  return t;
}

/**
 * parseLinkDensityThresholdArg — the ONLY place a CLI string is allowed to
 * become a number. `raw` is `undefined` when the --min-link-density flag
 * was never passed at all (valid: "no gate"). Hale's second re-audit also
 * found that a flag passed with no following value silently disabled the
 * gate (exit 0, threshold: null) -- indistinguishable from "flag never
 * given". `sawFlag` disambiguates: when the flag WAS present but its value
 * is missing or non-numeric, that's a caller error, not silent no-gate.
 */
export function parseLinkDensityThresholdArg(raw, sawFlag) {
  if (!sawFlag) return null;
  // Hale re-audit (54e4479): the original regex was more restrictive than
  // the grammar needs to be (rejected ".5" and "1e2", both valid numeric
  // literals) with no stated intent to narrow the format. Trim, reject
  // blank, then let Number() + the already-strict validator do the real
  // work -- Number('abc') is NaN and validateLinkDensityThreshold already
  // rejects non-finite values, so no separate format check duplicates that.
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) {
    throw Object.assign(
      new Error(`--min-link-density requires a numeric value, got ${JSON.stringify(raw)}`),
      { code: 'INVALID_LINK_DENSITY_THRESHOLD' },
    );
  }
  return validateLinkDensityThreshold(Number(trimmed));
}

/**
 * renderIndexNote — a generated `index.md` MOC (map-of-content), the vault's
 * entry point. Named in the original design spec's adversarial-pass finding
 * 6 as deferred, not rejected: "OKF ceremony... until a real OKF consumer
 * appears." A real Obsidian viewer landing on ~450 alphabetically-sorted,
 * id-named files with no starting point is exactly the "does this feel
 * trustworthy" gap this closes — a browse-by-type list plus an explicit
 * isolated-notes section, generated fresh every export, never hand-edited.
 *
 * Pure function of the same in-memory data renderOkfExport already computed
 * (units, per-unit outgoing link targets, which units have a real backlink)
 * — no new store read, no new walk.
 *
 * @param {Array<{id, path, type, status, summary}>} units
 * @param {Map<string, string[]>} generatedLinks  unit path -> outgoing target paths
 * @param {Set<string>} hasIncomingActiveEdge      unit paths with >=1 real backlink
 * @param {object} density  the same density block renderOkfExport computes
 * @param {string} snapshotId
 */
export function renderIndexNote(units, generatedLinks, hasIncomingActiveEdge, density, snapshotId) {
  const byType = new Map();
  for (const u of units) {
    const type = u.type || 'untyped';
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(u);
  }
  const sortedTypes = [...byType.keys()].sort();

  const lines = [];
  lines.push('---');
  // type: index (not a real OKF unit type) satisfies writeOkfExport's own
  // post-write validation, which requires non-empty type: frontmatter on
  // every exported file -- this note is vault furniture, not a knowledge
  // unit, but the validator doesn't distinguish and shouldn't need to.
  //
  // Deliberately NO wall-clock generated_at here (unlike the manifest,
  // which is a separate file outside the byte-identity guarantee): this
  // note is part of `outputs`, and the existing "deterministic reruns are
  // byte-identical" test covers everything in `outputs` -- a live
  // timestamp baked into the body would make that guarantee false on this
  // one file alone. snapshot_id is already the content-derived, genuinely
  // deterministic answer to "what store state does this reflect."
  lines.push('type: index');
  lines.push('generator: render-okf-export.mjs');
  lines.push(`snapshot_id: ${snapshotId}`);
  lines.push('---');
  lines.push('');
  lines.push('# CORE memory export');
  lines.push('');
  lines.push(`${units.length} units, ${density.with_outgoing_active_edge} with at least one outgoing link (${density.pct_with_outgoing_active_edge}%). This note is regenerated every export — edits here are lost on the next run.`);
  lines.push('');

  for (const type of sortedTypes) {
    const inType = byType.get(type).slice().sort((a, b) => a.id.localeCompare(b.id));
    lines.push(`## ${type} (${inType.length})`);
    lines.push('');
    for (const u of inType) {
      // Hale (okf-index-truth-external-0-of-3): u.summary is the source
      // unit's own H1 text, hand-authored and unvalidated -- copying it
      // verbatim can synthesize a real markdown link (e.g. a body literally
      // titled `# Alpha [spoof](missing.md)`) inside a file readers expect
      // to be fully generated and trustworthy. Escape link/emphasis syntax
      // so summary text can never render as a link this note didn't intend.
      const summary = u.summary ? ` — ${escapeMdText(u.summary)}` : '';
      lines.push(`- [${u.id}](${u.path})${summary}`);
    }
    lines.push('');
  }

  const isolated = units
    .filter((u) => !generatedLinks.get(u.path)?.length && !hasIncomingActiveEdge.has(u.path))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (isolated.length > 0) {
    lines.push(`## Isolated notes (${isolated.length})`);
    lines.push('');
    // Hale (okf-index-truth-external-0-of-3): this note itself links to
    // every unit listed above, so "no incoming links" would be false read
    // literally against the whole export -- scope the claim to unit-to-unit
    // edges (the actual graph-orphan population), not this note's own
    // navigation links.
    lines.push('No links to or from another *unit* in this export (this index note\'s own navigation links above don\'t count) — isolated in graph view once this note is excluded.');
    lines.push('');
    for (const u of isolated) lines.push(`- [${u.id}](${u.path})`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * renderOkfExport — build the export in memory (no disk writes). Exposed so
 * tests and --check can inspect the manifest/outputs without touching disk.
 */
export function renderOkfExport(projectDir, { linkDensityThreshold = null } = {}) {
  const threshold = validateLinkDensityThreshold(linkDensityThreshold);
  // ── 1. One atomic validated snapshot (correction 3: no raw store walk) ──
  const cap = loadSnapshot(projectDir, { captureBodies: true, retainRaw: true });
  // Hale (okf-index-truth-external-0-of-3): checking for this collision
  // AFTER the SCAFFOLD filter (as the code originally did, down at step 4)
  // never fires -- SCAFFOLD already silently drops any INDEX*.md-named
  // active unit right here, before that later check ever sees it. A real,
  // frontmatter-bearing unit at exactly the reserved index-note path would
  // vanish from the export with no warning and no error. Check the
  // unfiltered snapshot first, so a genuine collision fails loud instead of
  // being silently absorbed into the same bucket as INDEX-*/README/MEMORY
  // scaffolding (which staying silent is still correct for).
  const indexNameCollision = cap.index.units.find(u => u.path.toLowerCase() === INDEX_NOTE_NAME);
  if (indexNameCollision) {
    throw Object.assign(
      new Error(`a real unit ("${indexNameCollision.id}" at ${indexNameCollision.path}) occupies the reserved index-note path ${INDEX_NOTE_NAME} at the export root — rename the source unit or move it out of the root, don't let it collide with the generated index`),
      { code: 'INDEX_NOTE_NAME_COLLISION' },
    );
  }
  const units = cap.index.units.filter(u => !SCAFFOLD.test(u.path)); // active-only, invalidation-filtered, dup-resolved, sorted
  const activeById = new Map(units.map(u => [u.id, u]));

  // ── 2. Project each unit: raw bytes + generated `## Related` block ──────
  const warnings = [];
  if (cap.index.degraded) {
    warnings.push(`store DEGRADED: duplicate ids ${JSON.stringify(cap.index.duplicate_conflicts)}`);
  }
  let edgesRendered = 0, edgesFiltered = 0, unitsWithOutgoingActiveEdge = 0;
  const outputs = new Map();        // rel path -> content
  const generatedLinks = new Map(); // rel path -> [resolved target rel paths]
  // Hale re-audit (correction-okf-orphan-metric-semantic-mismatch): a unit
  // targeted by another unit's kept edge (a backlink) is NOT a graph
  // orphan even with zero outgoing edges of its own -- check-units.mjs's
  // canonical definition requires BOTH outgoing and incoming to be absent.
  // Track incoming hits across the whole pass so the true-orphan count can
  // be computed after the loop, not conflated with "has no outgoing link."
  const hasIncomingActiveEdge = new Set(); // unit path -> targeted by >=1 kept edge
  for (const u of units) {
    const raw = cap.raw?.[u.path];
    if (raw === undefined) { warnings.push(`no raw buffer for ${u.path} — skipped`); continue; }
    if (outputs.has(u.path)) { throw Object.assign(new Error(`duplicate output path ${u.path}`), { code: 'DUPLICATE_OUTPUT_PATH' }); }
    let text = raw.toString('utf8');

    // OKF conformance: non-empty `type` required on every non-reserved file.
    if (!u.type) warnings.push(`unit ${u.id} has empty type — not OKF-conformant as exported`);

    // Deterministic edge order (correction 3); active targets only (correction 4).
    const kept = [];
    const linkTargets = [];
    for (const e of [...(cap.edges[u.id] || [])].sort((a, b) =>
      a.type.localeCompare(b.type) || a.target.localeCompare(b.target))) {
      const target = activeById.get(e.target);
      if (!target) { edgesFiltered++; continue; } // retired/invalid/missing/external
      const rel = posix.relative(posix.dirname(u.path), target.path);
      kept.push(`- [${e.type}: ${target.id}](${rel})`);
      linkTargets.push(target.path);
      hasIncomingActiveEdge.add(target.path);
    }
    generatedLinks.set(u.path, linkTargets);
    if (kept.length > 0) {
      unitsWithOutgoingActiveEdge++;
      edgesRendered += kept.length;
      text = text.trimEnd() + `\n\n## Related\n${kept.join('\n')}\n`;
    }
    outputs.set(u.path, text);
  }
  const trueGraphOrphans = units.filter(u =>
    !generatedLinks.get(u.path)?.length && !hasIncomingActiveEdge.has(u.path)).length;

  // Omissions ledger: every candidate file the capture saw but the export drops.
  const omitted = Object.keys(cap.raw || {}).filter(rel => !outputs.has(rel)).sort();

  // ── 3. Link-density gate (correction 7: measured, threshold David-unratified) ─
  // Hale re-audit finding (4d7c65e): compare the unrounded ratio, not the
  // display-rounded percentage — rounding first could pass a gate the raw
  // ratio actually fails (or vice versa) right at the boundary.
  //
  // Hale re-audit (correction-okf-orphan-metric-semantic-mismatch): the
  // gate itself (outgoing-link density) is unchanged, but the field names
  // and CLI wording used to say "orphans" for "no OUTGOING active edge" --
  // check-units.mjs's canonical orphan definition requires BOTH outgoing
  // AND incoming (backlink) to be absent. Renamed the outgoing-only fields
  // explicitly and added true_graph_orphans as its own, correctly-labeled
  // count using the same both-outgoing-and-incoming-absent rule.
  //
  // Population scope, stated explicitly to avoid a second false alarm:
  // true_graph_orphans is computed over the SAME population this export
  // actually contains -- canonical units AND observations/<YYYY-MM>/ --
  // because that is what a person will actually see as connected or
  // disconnected when browsing the exported vault in Obsidian.
  // check-units.mjs's own DEFAULT run (no --include-observations) scopes
  // to top-level canonical units only, by design (iterActiveUnits skips
  // every subdirectory unless that flag is passed) -- a materially
  // smaller population. The two numbers answer different questions and
  // are not directly comparable, and the gap is NOT population alone
  // (Hale, hale--f07549f-orphan-metric-pass correction): against the same
  // live store, check-units --include-observations reports 113 orphans
  // against its own 446-unit population, versus this export's 131 against
  // 441. check-units treats any outgoing edge or backlink as connectivity,
  // full stop; this export only counts an edge as connecting if its
  // target survives the export's own active/internal filtering (dangling,
  // missing, and external-store targets are dropped before counting) --
  // a stricter, export-scoped notion of "connected." So the 113-vs-131
  // difference comes from both a smaller population AND a looser
  // connectivity rule on check-units's side, not population alone.
  const rawPct = units.length ? (unitsWithOutgoingActiveEdge / units.length) * 100 : 0;
  const density = {
    active_units: units.length,
    with_outgoing_active_edge: unitsWithOutgoingActiveEdge,
    without_outgoing_active_edge: units.length - unitsWithOutgoingActiveEdge,
    pct_with_outgoing_active_edge: Math.round(rawPct * 10) / 10,
    true_graph_orphans: trueGraphOrphans,
    threshold,
  };
  if (threshold !== null && rawPct < threshold) {
    throw Object.assign(new Error(`Outgoing-link density ${density.pct_with_outgoing_active_edge}% is below threshold ${threshold}%`), { code: 'LINK_DENSITY_FAILED' });
  }

  const manifest = {
    generator: 'render-okf-export.mjs',
    generator_version: GENERATOR_VERSION,
    generated_at: new Date().toISOString(),
    snapshot_id: cap.snapshotId,
    okf_claim: `Obsidian-readable, OKF v0.1-draft conformant at pinned revision ${OKF_SPEC_PIN}`,
    anti_resurrection_claim: 'no retired unit documents or generated edges in the projection; active-unit body prose is out of scope',
    counts: {
      exported_units: outputs.size,
      edges_rendered: edgesRendered,
      edges_filtered_inactive_or_external: edgesFiltered,
      omitted_files: omitted.length,
    },
    omitted,
    link_density: density,
    warnings,
    index_note: INDEX_NOTE_NAME,
  };

  // ── 4. Generated index note — the vault's entry point. Added to outputs
  // AFTER the manifest so exported_units counts real units only; the note
  // itself is named separately (manifest.index_note) rather than folded in.
  // The real collision catch is upstream now (indexNameCollision, above) --
  // this one is a second, cheap backstop in case outputs ever ends up with
  // that key through some path other than cap.index.units.
  if (outputs.has(INDEX_NOTE_NAME)) {
    throw Object.assign(
      new Error(`a real unit already occupies ${INDEX_NOTE_NAME} at the export root — refusing to overwrite it with the generated index note`),
      { code: 'INDEX_NOTE_NAME_COLLISION' },
    );
  }
  outputs.set(INDEX_NOTE_NAME, renderIndexNote(units, generatedLinks, hasIncomingActiveEdge, density, cap.snapshotId));

  return { manifest, outputs, generatedLinks };
}

/**
 * recoverOrphanedBackup — Hale re-audit finding (4d7c65e, then 54e4479):
 * a real process death after `renameSync(outDir, bakDir)` but before
 * `renameSync(tmpDir, outDir)` never reaches the catch/finally, so outDir
 * is left absent and `${outDir}.bak-<dead-pid>` is orphaned with no code
 * to discover it.
 *
 * The first fix swept every `.tmp-<pid>` unconditionally -- Hale's second
 * re-audit demonstrated this is unsafe under real concurrency: a second
 * live exporter's in-progress `.tmp-<pid>` (a validated tree not yet
 * swapped in) would be deleted out from under it. "Every tmp is always
 * disposable" is false while another process still owns that pid.
 *
 * Fixed with `pidAlive()` (file-lock.mjs, the project's own hardened
 * liveness primitive — no second ad hoc implementation): a `.tmp-<pid>`
 * or `.bak-<pid>` is only ever touched when that pid is confirmed dead.
 * Covers all four transaction states:
 *   - outDir absent + one DEAD-owner backup: restore it (the crash window
 *     this function exists for).
 *   - outDir absent + a LIVE-owner backup: another process is actively
 *     finishing that exact transaction right now -- leave it alone.
 *   - outDir present + a DEAD-owner backup: an earlier run's swap already
 *     completed but died before its own cleanup -- safe to remove.
 *   - outDir present + a LIVE-owner backup: mid-transaction elsewhere --
 *     leave it alone.
 *   - more than one DEAD-owner backup: ambiguous (which crash, which
 *     generation) -- fail closed rather than guess.
 *
 * writeOkfExport (below) also serializes its whole transaction under the
 * project's file lock, so in practice two writers never race for the same
 * outDir concurrently at all — this function's own pid-awareness is
 * defense in depth for direct callers, not the only safety net.
 */
export function recoverOrphanedBackup(outDir) {
  const parent = dirname(outDir);
  const base = basename(outDir);
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let entries;
  try { entries = readdirSync(parent); } catch { entries = []; }

  const tmpPattern = new RegExp(`^${escaped}\\.tmp-(\\d+)$`);
  for (const e of entries) {
    const m = e.match(tmpPattern);
    if (m && !pidAlive(Number(m[1]))) rmSync(join(parent, e), { recursive: true, force: true });
  }

  const bakPattern = new RegExp(`^${escaped}\\.bak-(\\d+)$`);
  const baks = entries.filter(e => bakPattern.test(e));
  const liveBaks = baks.filter(e => pidAlive(Number(e.match(bakPattern)[1])));
  const deadBaks = baks.filter(e => !pidAlive(Number(e.match(bakPattern)[1])));

  if (existsSync(outDir)) {
    for (const e of deadBaks) rmSync(join(parent, e), { recursive: true, force: true });
    return { recovered: false };
  }

  // Hale re-audit (hale--exporter-lock-stale-default): a live-owner backup
  // means that pid's transaction is actively in flight right now -- it is
  // the authority on this outDir, not an older dead backup that happens to
  // also be lying around. Restoring the dead one out from under a live
  // owner's active transaction would be a real correctness bug, not a
  // theoretical one. Defer entirely rather than guess which backup wins.
  if (liveBaks.length > 0) return { recovered: false };

  if (deadBaks.length === 0) return { recovered: false };
  if (deadBaks.length > 1) {
    throw Object.assign(
      new Error(`${deadBaks.length} ambiguous dead-owner backup directories found for ${outDir} (${deadBaks.join(', ')}) — refusing to auto-recover; resolve manually`),
      { code: 'AMBIGUOUS_BACKUP_RECOVERY', candidates: deadBaks },
    );
  }
  renameSync(join(parent, deadBaks[0]), outDir);
  return { recovered: true, from: deadBaks[0] };
}

/**
 * writeOkfExport — validate-then-swap write of a renderOkfExport() result to
 * disk. Refuses a non-generated existing directory (never overwrites hand-
 * authored content); writes to a temp dir, validates every generated link
 * resolves, then atomically swaps into place. Recovers a prior crash's
 * orphaned backup before doing anything else (see recoverOrphanedBackup).
 *
 * The whole transaction (recovery through the swap) runs under the
 * project's own file lock (file-lock.mjs, the K12-hardened generation-
 * based mutex already used elsewhere in the plugin) — Hale's re-audit
 * (54e4479) demonstrated that without real serialization, two concurrent
 * exporters could race on the same outDir regardless of how careful the
 * pid-liveness checks inside a single call are. A crashed prior holder's
 * lock is detected as stale and taken over by the existing mechanism; no
 * new liveness logic was written for that case.
 *
 * Uses staleMs: 0 for this lock specifically (Hale re-audit,
 * hale--lock-test-production-mismatch and hale--48854e2-production-next-
 * run-hold: the earlier version kept file-lock's cross-project 10-minute
 * default here on a mistaken safety theory, and a test-only lockOptions
 * seam tightened staleMs only in tests -- so the committed test proved
 * "recoverable on the next run" while the real CLI path, reproduced
 * exactly, still threw LOCK_HELD for ten minutes after a real crash.
 * staleMs never protects a live process on its own: file-lock's own
 * staleness rule is age > staleMs AND !pidAlive(pid) -- both conditions,
 * always. A live or suspended-then-revived owner is never stolen from
 * regardless of staleMs; zero only makes a CONFIRMED-DEAD owner's lock
 * reclaimable immediately instead of after an arbitrary wait. There is no
 * safety reason to delay recovering from a death this transaction can
 * already prove happened, so production and tests now use the exact same
 * call with no configurable seam between them.
 */
export function writeOkfExport(projectDir, outDir, { linkDensityThreshold = null } = {}) {
  return withFileLock(`${outDir}.lock`, () => {
    recoverOrphanedBackup(outDir);
    const { manifest, outputs, generatedLinks } = renderOkfExport(projectDir, { linkDensityThreshold });

    // The design spec calls this "a throwaway gitignored _okf-export/" — never
    // implemented in the prototype. Only auto-gitignore when the export lands
    // INSIDE the project (the default case); an explicit --out elsewhere is the
    // user's own choice of location and not this script's concern.
    ensureGitignored(projectDir, outDir);

    // Refuse symlinked or non-generated output (correction 3: no overwrite primitive).
    if (existsSync(outDir)) {
      if (lstatSync(outDir).isSymbolicLink()) {
        throw Object.assign(new Error(`${outDir} is a symlink — refusing`), { code: 'REFUSE_SYMLINK' });
      }
      if (!existsSync(join(outDir, MANIFEST_NAME))) {
        throw Object.assign(new Error(`${outDir} exists and has no ${MANIFEST_NAME} — not a generated export, refusing to replace`), { code: 'REFUSE_NON_GENERATED' });
      }
    }
    const tmpDir = `${outDir}.tmp-${process.pid}`;
    rmSync(tmpDir, { recursive: true, force: true });
    for (const [rel, content] of outputs) {
      const fpath = join(tmpDir, ...rel.split('/'));
      mkdirSync(dirname(fpath), { recursive: true });
      writeFileSync(fpath, content);
    }
    writeFileSync(join(tmpDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n');

    // Validate the written tree: parseable frontmatter with non-empty type, and every
    // GENERATED Related link resolves to an exported file. Hand-authored body links are
    // deliberately NOT validated — OKF requires broken links be tolerated, and prose may
    // legitimately cite paths outside the bundle (or literal example syntax).
    //
    // Found while completing the OKF test suite, 2026-07-19: `type:\s*\S+` used
    // \s (which matches newlines) between the colon and the required non-empty
    // value, so `type:\n status: active` — an EMPTY type immediately followed by
    // the next YAML key — matched anyway, treating "status" as if it were the
    // type's value. [ \t]* (no \n) keeps the required value on the type line
    // itself, so a genuinely empty type is correctly caught as non-conformant.
    let invalid = 0;
    for (const rel of outputs.keys()) {
      const written = readFileSync(join(tmpDir, ...rel.split('/')), 'utf8');
      if (!/^---\r?\n[\s\S]*?^type:[ \t]*\S/m.test(written.slice(0, 2000))) { invalid++; continue; }
      for (const target of generatedLinks.get(rel) || []) {
        if (!existsSync(join(tmpDir, ...target.split('/')))) { invalid++; break; }
      }
    }
    if (invalid > 0) {
      throw Object.assign(new Error(`${invalid} exported file(s) failed post-write validation — export aborted, temp kept at ${tmpDir}`), { code: 'POST_WRITE_VALIDATION_FAILED', tmpDir });
    }
    const bakDir = `${outDir}.bak-${process.pid}`;
    let swapFailed = false;
    if (existsSync(outDir)) renameSync(outDir, bakDir);
    // Test-only: simulate a real process death (not a catchable JS throw) in
    // exactly the crash window recoverOrphanedBackup() exists to close. A test
    // spawns a child with this set, expects it to be killed by its exit code
    // (never reaching the try/catch/finally below), then calls writeOkfExport
    // again in-process and asserts the backup was restored automatically.
    // The child's own lock is left held-but-stale on disk; the recovering
    // call's withFileLock detects the dead pid and takes over normally.
    if (process.env.FAULT_INJECT_HARD_KILL === '1') process.exit(1);
    try {
      if (process.env.FAULT_INJECT_SWAP_CRASH === '1') throw new Error('Simulated swap crash');
      renameSync(tmpDir, outDir);
    } catch (e) {
      swapFailed = true;
      if (existsSync(bakDir)) renameSync(bakDir, outDir); // restore backup
      throw Object.assign(new Error(`Swap failed, backup restored: ${e.message}`), { code: 'SWAP_FAILED', cause: e });
    } finally {
      if (!swapFailed && existsSync(bakDir)) rmSync(bakDir, { recursive: true, force: true });
    }
    return manifest;
  }, { staleMs: 0 });
}

function usage() {
  process.stderr.write('usage: node render-okf-export.mjs <project-dir> [--out <dir>] [--check] [--min-link-density <pct>]\n');
  return 2;
}

function main(argv) {
  const projectDir = resolve(argv.find(a => !a.startsWith('--')) || '.');
  const outFlag = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : null;
  const checkOnly = argv.includes('--check');
  const sawDensityFlag = argv.includes('--min-link-density');
  // Hale re-audit (34e57be): the value slot can be out of bounds (flag is
  // the last argument) or accidentally grab the NEXT flag as its value
  // (`--min-link-density --check`) -- either must be treated as "flag
  // present, value missing", not silently coerced to a real value.
  const densityIdx = sawDensityFlag ? argv.indexOf('--min-link-density') + 1 : -1;
  const densityRaw = (densityIdx >= 0 && densityIdx < argv.length && !argv[densityIdx].startsWith('--'))
    ? argv[densityIdx] : undefined;
  if (!existsSync(join(projectDir, '_memories'))) return usage();
  const outDir = resolve(outFlag || join(projectDir, '_okf-export'));

  let linkDensityThreshold;
  try {
    linkDensityThreshold = parseLinkDensityThresholdArg(densityRaw, sawDensityFlag);
  } catch (e) {
    process.stderr.write(`FATAL: ${e.message}\n`);
    return 2;
  }

  if (checkOnly) {
    const { manifest } = renderOkfExport(projectDir, { linkDensityThreshold });
    process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
    return 0;
  }

  let manifest;
  try {
    manifest = writeOkfExport(projectDir, outDir, { linkDensityThreshold });
  } catch (e) {
    process.stderr.write(`FATAL: ${e.message}\n`);
    return 2;
  }
  const { counts, link_density: density, warnings } = manifest;
  process.stdout.write(`exported ${counts.exported_units} units → ${outDir}\n`);
  process.stdout.write(`index note: ${manifest.index_note} (vault entry point, not counted in exported_units)\n`);
  process.stdout.write(`snapshot ${manifest.snapshot_id.slice(0, 12)}… | edges rendered ${counts.edges_rendered}, filtered ${counts.edges_filtered_inactive_or_external} | omitted ${counts.omitted_files} file(s)\n`);
  process.stdout.write(`outgoing-link density: ${density.pct_with_outgoing_active_edge}% of active units carry ≥1 outgoing active edge (${density.without_outgoing_active_edge} with none — not the same as graph orphans) — true graph orphans (no outgoing AND no incoming edge, within this export's own population of canonical units + observations): ${density.true_graph_orphans} — threshold unratified, David's call\n`);
  if (warnings.length) process.stdout.write(`warnings: ${warnings.length} (see manifest)\n`);
  return 0;
}

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
