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

import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, lstatSync, renameSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSnapshot } from './generate-summary-index.mjs';

export const GENERATOR_VERSION = '0.1.0';
// Hale correction 6: pin the exact upstream revision the conformance claim is
// made against. okf/SPEC.md @ GoogleCloudPlatform/knowledge-catalog.
export const OKF_SPEC_PIN = 'ee67a5ca27044ebe7c38385f5b6cffc2305a9c1a'; // 2026-06-12, v0.1 Draft
export const MANIFEST_NAME = 'okf-export-manifest.json';

// Allow-list per spec: knowledge units only — INDEX-*/README/MEMORY are store
// scaffolding, not OKF documents (validate.mjs skip-list honored).
const SCAFFOLD = /(^|\/)(INDEX[^/]*|README|MEMORY)\.md$/i;

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
 * renderOkfExport — build the export in memory (no disk writes). Exposed so
 * tests and --check can inspect the manifest/outputs without touching disk.
 */
export function renderOkfExport(projectDir) {
  // ── 1. One atomic validated snapshot (correction 3: no raw store walk) ──
  const cap = loadSnapshot(projectDir, { captureBodies: true, retainRaw: true });
  const units = cap.index.units.filter(u => !SCAFFOLD.test(u.path)); // active-only, invalidation-filtered, dup-resolved, sorted
  const activeById = new Map(units.map(u => [u.id, u]));

  // ── 2. Project each unit: raw bytes + generated `## Related` block ──────
  const warnings = [];
  if (cap.index.degraded) {
    warnings.push(`store DEGRADED: duplicate ids ${JSON.stringify(cap.index.duplicate_conflicts)}`);
  }
  let edgesRendered = 0, edgesFiltered = 0, unitsWithActiveEdge = 0;
  const outputs = new Map();        // rel path -> content
  const generatedLinks = new Map(); // rel path -> [resolved target rel paths]
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
    }
    generatedLinks.set(u.path, linkTargets);
    if (kept.length > 0) {
      unitsWithActiveEdge++;
      edgesRendered += kept.length;
      text = text.trimEnd() + `\n\n## Related\n${kept.join('\n')}\n`;
    }
    outputs.set(u.path, text);
  }

  // Omissions ledger: every candidate file the capture saw but the export drops.
  const omitted = Object.keys(cap.raw || {}).filter(rel => !outputs.has(rel)).sort();

  // ── 3. Link-density gate (correction 7: measured, threshold David-unratified) ─
  const density = {
    active_units: units.length,
    with_active_edge: unitsWithActiveEdge,
    pct_with_active_edge: units.length ? Math.round((unitsWithActiveEdge / units.length) * 1000) / 10 : 0,
    orphans: units.length - unitsWithActiveEdge,
    threshold: null, // David ratifies before this is called ship-ready
  };

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
  };

  return { manifest, outputs, generatedLinks };
}

/**
 * writeOkfExport — validate-then-swap write of a renderOkfExport() result to
 * disk. Refuses a non-generated existing directory (never overwrites hand-
 * authored content); writes to a temp dir, validates every generated link
 * resolves, then atomically swaps into place.
 */
export function writeOkfExport(projectDir, outDir) {
  const { manifest, outputs, generatedLinks } = renderOkfExport(projectDir);

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
  let invalid = 0;
  for (const rel of outputs.keys()) {
    const written = readFileSync(join(tmpDir, ...rel.split('/')), 'utf8');
    if (!/^---\n[\s\S]*?\ntype:\s*\S+/m.test(written.slice(0, 2000))) { invalid++; continue; }
    for (const target of generatedLinks.get(rel) || []) {
      if (!existsSync(join(tmpDir, ...target.split('/')))) { invalid++; break; }
    }
  }
  if (invalid > 0) {
    throw Object.assign(new Error(`${invalid} exported file(s) failed post-write validation — export aborted, temp kept at ${tmpDir}`), { code: 'POST_WRITE_VALIDATION_FAILED', tmpDir });
  }
  rmSync(outDir, { recursive: true, force: true });
  renameSync(tmpDir, outDir);
  return manifest;
}

function usage() {
  process.stderr.write('usage: node render-okf-export.mjs <project-dir> [--out <dir>] [--check]\n');
  return 2;
}

function main(argv) {
  const projectDir = resolve(argv.find(a => !a.startsWith('--')) || '.');
  const outFlag = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : null;
  const checkOnly = argv.includes('--check');
  if (!existsSync(join(projectDir, '_memories'))) return usage();
  const outDir = resolve(outFlag || join(projectDir, '_okf-export'));

  if (checkOnly) {
    const { manifest } = renderOkfExport(projectDir);
    process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
    return 0;
  }

  let manifest;
  try {
    manifest = writeOkfExport(projectDir, outDir);
  } catch (e) {
    process.stderr.write(`FATAL: ${e.message}\n`);
    return 2;
  }
  const { counts, link_density: density, warnings } = manifest;
  process.stdout.write(`exported ${counts.exported_units} units → ${outDir}\n`);
  process.stdout.write(`snapshot ${manifest.snapshot_id.slice(0, 12)}… | edges rendered ${counts.edges_rendered}, filtered ${counts.edges_filtered_inactive_or_external} | omitted ${counts.omitted_files} file(s)\n`);
  process.stdout.write(`link density: ${density.pct_with_active_edge}% of active units carry ≥1 active edge (${density.orphans} orphans) — threshold unratified, David's call\n`);
  if (warnings.length) process.stdout.write(`warnings: ${warnings.length} (see manifest)\n`);
  return 0;
}

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
