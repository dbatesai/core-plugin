/**
 * render-okf-export — Obsidian/OKF export-only projection.
 * Covers the guarantees named in its own docstring: export-only (never
 * mutates the live store), anti-resurrection (no retired documents/edges),
 * deterministic edge order, and the write-discipline refusals (symlink,
 * non-generated existing dir, post-write link validation).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'scripts');
const { renderOkfExport, writeOkfExport, MANIFEST_NAME, validateLinkDensityThreshold } =
  await import(pathToFileURL(join(SCRIPTS, 'render-okf-export.mjs')).href);

function fixtureStore() {
  const root = mkdtempSync(join(tmpdir(), 'okf-export-'));
  const mem = join(root, '_memories');
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, 'dc-1-alpha.md'),
    `---\nid: dc-1-alpha\ntype: decision\nstatus: active\nedges:\n  - type: cites\n    target: dc-2-beta\n  - type: supersedes\n    target: dc-3-retired\n---\n\n# DC-1 — Alpha\n\nBody.`);
  writeFileSync(join(mem, 'dc-2-beta.md'),
    '---\nid: dc-2-beta\ntype: decision\nstatus: active\n---\n\n# DC-2 — Beta\n\nBody.');
  writeFileSync(join(mem, 'dc-3-retired.md'),
    '---\nid: dc-3-retired\ntype: decision\nstatus: retired\n---\n\n# DC-3 — Retired\n\nMust never appear in the export.');
  writeFileSync(join(mem, 'dc-4-orphan.md'),
    '---\nid: dc-4-orphan\ntype: observation\nstatus: active\n---\n\n# DC-4 — No edges\n\nBody.');
  writeFileSync(join(mem, 'INDEX.md'), '# scaffolding — must be excluded');
  writeFileSync(join(mem, 'MEMORY.md'), '# scaffolding — must be excluded');
  return root;
}

test('export-only: renderOkfExport never writes to the live store', () => {
  const root = fixtureStore();
  const before = readFileSync(join(root, '_memories', 'dc-1-alpha.md'), 'utf8');
  renderOkfExport(root);
  const after = readFileSync(join(root, '_memories', 'dc-1-alpha.md'), 'utf8');
  assert.equal(before, after, 'the source unit must be byte-identical after a render pass');
});

test('anti-resurrection: no retired unit is exported, and edges to a retired target are filtered', () => {
  const root = fixtureStore();
  const { outputs, manifest } = renderOkfExport(root);
  assert.ok(!outputs.has('dc-3-retired.md'), 'a retired unit must never appear in the projection');
  const alpha = outputs.get('dc-1-alpha.md');
  // The raw frontmatter (untouched, per the narrowed guarantee — body prose
  // and the original edges: YAML are out of scope) still literally contains
  // the string "dc-3-retired" as inert YAML data; that's expected and not a
  // resurrection, since it isn't a markdown link and creates no graph edge in
  // Obsidian/OKF. The actual guarantee is about the GENERATED Related block.
  const related = alpha.slice(alpha.indexOf('## Related'));
  assert.ok(!related.includes('](dc-3-retired.md)'), 'the generated Related block must not link to a retired target');
  assert.ok(related.includes('](dc-2-beta.md)'), 'a live edge to an active target must still render');
  assert.equal(manifest.counts.edges_filtered_inactive_or_external, 1, 'exactly the retired-target edge is filtered');
});

test('scaffolding files (INDEX, MEMORY, README) are excluded from the export', () => {
  const root = fixtureStore();
  const { outputs } = renderOkfExport(root);
  assert.ok(!outputs.has('INDEX.md'));
  assert.ok(!outputs.has('MEMORY.md'));
});

test('an orphan unit (no active edges) gets no Related block, not an empty one', () => {
  const root = fixtureStore();
  const { outputs } = renderOkfExport(root);
  const orphan = outputs.get('dc-4-orphan.md');
  assert.ok(!orphan.includes('## Related'), 'zero active edges must produce no Related section at all');
});

test('link density is measured honestly, with an unratified threshold', () => {
  const root = fixtureStore();
  const { manifest } = renderOkfExport(root);
  // Active units: alpha, beta, orphan = 3. With-active-edge: alpha only (beta's
  // and orphan's own outgoing edges are none) — but beta IS a target, not a
  // source, so density counts units that themselves carry an outgoing active edge.
  assert.equal(manifest.link_density.active_units, 3);
  assert.equal(manifest.link_density.with_active_edge, 1);
  assert.equal(manifest.link_density.threshold, null, 'the threshold must stay unratified, not silently defaulted');
});

test('writeOkfExport: full round-trip lands on disk, manifest included, generated links resolve', () => {
  const root = fixtureStore();
  const outDir = join(root, '_okf-export');
  const manifest = writeOkfExport(root, outDir);
  assert.ok(existsSync(join(outDir, MANIFEST_NAME)));
  assert.ok(existsSync(join(outDir, 'dc-1-alpha.md')));
  assert.ok(!existsSync(join(outDir, 'dc-3-retired.md')), 'retired unit must not land on disk either');
  const written = readFileSync(join(outDir, 'dc-1-alpha.md'), 'utf8');
  assert.match(written, /## Related/);
  assert.equal(manifest.counts.exported_units, 3);
});

test('writeOkfExport is idempotent-safe: re-running against its own prior output replaces cleanly', () => {
  const root = fixtureStore();
  const outDir = join(root, '_okf-export');
  writeOkfExport(root, outDir);
  const second = writeOkfExport(root, outDir); // must not refuse — it's a generated dir with the manifest present
  assert.ok(existsSync(join(outDir, MANIFEST_NAME)));
  assert.equal(second.counts.exported_units, 3);
});

test('writeOkfExport auto-gitignores the default (project-local) export directory', () => {
  const root = fixtureStore();
  writeOkfExport(root, join(root, '_okf-export'));
  const gi = readFileSync(join(root, '.gitignore'), 'utf8');
  assert.match(gi, /^_okf-export\/?\s*$/m);
});

test('writeOkfExport does NOT touch .gitignore when --out points outside the project', () => {
  const root = fixtureStore();
  const outsideParent = mkdtempSync(join(tmpdir(), 'okf-outside-'));
  const outside = join(outsideParent, 'export'); // does not exist yet — a fresh --out target
  writeOkfExport(root, outside);
  assert.ok(!existsSync(join(root, '.gitignore')), 'an out-of-project destination is the user\'s own choice, not auto-ignored');
  rmSync(outsideParent, { recursive: true, force: true });
});

test('writeOkfExport refuses a symlinked output target', () => {
  const root = fixtureStore();
  const realDir = mkdtempSync(join(tmpdir(), 'okf-real-'));
  const outDir = join(root, '_okf-export-link');
  symlinkSync(realDir, outDir);
  assert.throws(() => writeOkfExport(root, outDir), (e) => e.code === 'REFUSE_SYMLINK');
  rmSync(realDir, { recursive: true, force: true });
});

test('writeOkfExport refuses to replace a pre-existing directory that is NOT a generated export', () => {
  const root = fixtureStore();
  const outDir = join(root, 'hand-authored-dir');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'my-notes.md'), 'do not delete me');
  assert.throws(() => writeOkfExport(root, outDir), (e) => e.code === 'REFUSE_NON_GENERATED');
  assert.ok(existsSync(join(outDir, 'my-notes.md')), 'the hand-authored file must survive the refused write attempt');
});

test('CLI --check prints the manifest without writing anything to disk', async () => {
  const { execFileSync } = await import('node:child_process');
  const root = fixtureStore();
  const out = execFileSync(process.execPath, [join(SCRIPTS, 'render-okf-export.mjs'), root, '--check'], { encoding: 'utf8' });
  const manifest = JSON.parse(out);
  assert.equal(manifest.counts.exported_units, 3);
  assert.ok(!existsSync(join(root, '_okf-export')), '--check must never write the export directory');
});

test('CLI full run writes the export and prints the landing path', async () => {
  const { execFileSync } = await import('node:child_process');
  const root = fixtureStore();
  const out = execFileSync(process.execPath, [join(SCRIPTS, 'render-okf-export.mjs'), root], { encoding: 'utf8' });
  assert.match(out, /exported 3 units/);
  assert.ok(existsSync(join(root, '_okf-export', MANIFEST_NAME)));
});

test('CLI usage error on a directory with no _memories/', async () => {
  const { execFileSync } = await import('node:child_process');
  const notAStore = mkdtempSync(join(tmpdir(), 'okf-notastore-'));
  assert.throws(() => execFileSync(process.execPath, [join(SCRIPTS, 'render-okf-export.mjs'), notAStore], { encoding: 'utf8' }),
    (e) => e.status === 2);
});

// ── Additional coverage against Hale's explicit verification list
// (core-codex/_outputs/2026-07-14/hale-okf-obsidian-projection-review.md
// §"Verification required before build approval"), 2026-07-19 — the original
// 14 tests covered anti-resurrection, scaffolding exclusion, orphans, link
// density, the write refusals, and the CLI, but not: nested paths, a target
// that never existed (vs. retired), deterministic byte-identical reruns,
// stale-file cleanup on a source change, atomic rollback on a validation
// failure, isolation from source mutation after the snapshot is taken, the
// pinned OKF conformance rules themselves, and Obsidian-resolvable link paths
// across subdirectories.

function nestedFixtureStore() {
  const root = mkdtempSync(join(tmpdir(), 'okf-nested-'));
  const mem = join(root, '_memories');
  mkdirSync(join(mem, 'observations', '2026-07'), { recursive: true });
  writeFileSync(join(mem, 'dc-1-root.md'),
    '---\nid: dc-1-root\ntype: decision\nstatus: active\nedges:\n  - type: cites\n    target: obs-nested\n---\n\n# DC-1 — Root\n\nBody.');
  writeFileSync(join(mem, 'observations', '2026-07', 'obs-nested.md'),
    '---\nid: obs-nested\ntype: observation\nstatus: active\nedges:\n  - type: cites\n    target: dc-1-root\n---\n\n# Nested observation\n\nBody.');
  return root;
}

test('nested units (e.g. observations/<YYYY-MM>/) export with their directory structure and cross-level links resolve', () => {
  const root = nestedFixtureStore();
  const { outputs } = renderOkfExport(root);
  assert.ok(outputs.has('observations/2026-07/obs-nested.md'), 'the nested unit keeps its real relative path, not a flattened id');
  const rootDoc = outputs.get('dc-1-root.md');
  assert.match(rootDoc, /\]\(observations\/2026-07\/obs-nested\.md\)/, 'a root-level unit links DOWN into the nested path correctly');
  const nestedDoc = outputs.get('observations/2026-07/obs-nested.md');
  assert.match(nestedDoc, /\]\(\.\.\/\.\.\/dc-1-root\.md\)/, 'a nested unit links UP to a root-level target with a correct relative ../.. path');
});

test('writeOkfExport: nested cross-level links are byte-verified to resolve on disk (Obsidian/OKF path resolution)', () => {
  const root = nestedFixtureStore();
  const outDir = join(root, '_okf-export');
  writeOkfExport(root, outDir);
  const rootDoc = readFileSync(join(outDir, 'dc-1-root.md'), 'utf8');
  const m = rootDoc.match(/\]\(([^)]+)\)/);
  assert.ok(m, 'a generated link is present');
  assert.ok(existsSync(join(dirname(join(outDir, 'dc-1-root.md')), m[1])), 'the relative link target actually exists on disk from the referring file\'s own directory — exactly how Obsidian/OKF resolve a markdown path link');
});

test('an edge to a target id that never existed is filtered exactly like a retired target (missing vs. retired share the same safe path)', () => {
  const root = fixtureStore();
  writeFileSync(join(root, '_memories', 'dc-5-dangling.md'),
    '---\nid: dc-5-dangling\ntype: decision\nstatus: active\nedges:\n  - type: cites\n    target: dc-999-never-existed\n---\n\n# DC-5\n\nBody.');
  const { outputs, manifest } = renderOkfExport(root);
  const doc = outputs.get('dc-5-dangling.md');
  assert.ok(!doc.includes('## Related'), 'a unit whose only edge targets a nonexistent id gets no Related block at all');
  assert.equal(manifest.counts.edges_filtered_inactive_or_external, 2, 'both the retired-target edge (fixture) and the never-existed target are counted as filtered');
});

test('deterministic reruns are byte-identical, not just non-throwing (same source, two full renders)', () => {
  const root = fixtureStore();
  const first = renderOkfExport(root);
  const second = renderOkfExport(root);
  assert.deepEqual([...first.outputs.entries()].sort(), [...second.outputs.entries()].sort(),
    'two renders of an unchanged store must produce byte-identical output per file, not merely the same file set');
  assert.equal(first.manifest.snapshot_id, second.manifest.snapshot_id, 'the content-derived snapshot id is stable across reruns of unchanged source');
});

test('a stale file from a prior export is removed when the source unit disappears (retirement) before the next run', () => {
  const root = fixtureStore();
  const outDir = join(root, '_okf-export');
  writeOkfExport(root, outDir);
  assert.ok(existsSync(join(outDir, 'dc-4-orphan.md')), 'sanity: the first run exported the orphan unit');
  // Retire the unit between runs — this is the "stale prior export" case Hale named:
  // the second run must not leave dc-4-orphan.md behind from the first run.
  writeFileSync(join(root, '_memories', 'dc-4-orphan.md'),
    '---\nid: dc-4-orphan\ntype: observation\nstatus: retired\n---\n\n# DC-4 — No edges\n\nBody.');
  writeOkfExport(root, outDir);
  assert.ok(!existsSync(join(outDir, 'dc-4-orphan.md')), 'a unit retired between runs must not survive as a stale file in the regenerated export');
});

test('a leftover tmp directory from a different pid does not block or corrupt a fresh export (own-pid-only cleanup)', () => {
  const root = fixtureStore();
  const outDir = join(root, '_okf-export');
  // Simulate a crashed prior run's leftover temp dir under a DIFFERENT pid —
  // writeOkfExport only ever rmSync's its OWN `${outDir}.tmp-${process.pid}`.
  const staleTmp = `${outDir}.tmp-999999999`;
  mkdirSync(staleTmp, { recursive: true });
  writeFileSync(join(staleTmp, 'junk.md'), 'leftover from a crashed run');
  const manifest = writeOkfExport(root, outDir);
  assert.equal(manifest.counts.exported_units, 3, 'a fresh run succeeds normally regardless of an unrelated stale tmp dir');
  assert.ok(existsSync(join(outDir, MANIFEST_NAME)), 'the real export landed');
  rmSync(staleTmp, { recursive: true, force: true });
});

test('a post-write validation failure rolls back atomically — the prior good export is left untouched, never partially overwritten', () => {
  const root = fixtureStore();
  const outDir = join(root, '_okf-export');
  const goodManifest = writeOkfExport(root, outDir);
  const goodAlpha = readFileSync(join(outDir, 'dc-1-alpha.md'), 'utf8');
  // Introduce a unit with an empty `type:` — renderOkfExport still exports it
  // (it only warns), but writeOkfExport's own post-write conformance check
  // (parseable frontmatter with a NON-EMPTY type) must catch it and abort
  // before the swap, per the "validate the temp dir, then atomically swap"
  // contract — a real failure here must never partially clobber outDir.
  writeFileSync(join(root, '_memories', 'dc-6-bad-type.md'),
    '---\nid: dc-6-bad-type\ntype:\nstatus: active\n---\n\n# DC-6\n\nBody.');
  assert.throws(() => writeOkfExport(root, outDir), (e) => e.code === 'POST_WRITE_VALIDATION_FAILED');
  assert.equal(readFileSync(join(outDir, 'dc-1-alpha.md'), 'utf8'), goodAlpha, 'the previously-written good export must survive a failed subsequent write untouched');
  assert.equal(readFileSync(join(outDir, MANIFEST_NAME), 'utf8'), JSON.stringify(goodManifest, null, 2) + '\n', 'the manifest from the last GOOD write is still what\'s on disk');
});

test('renderOkfExport output is captured by value at call time — mutating source files afterward cannot retroactively change an already-returned result', () => {
  const root = fixtureStore();
  const { outputs } = renderOkfExport(root);
  const before = outputs.get('dc-1-alpha.md');
  // Mutate the live source AFTER the snapshot was captured and returned.
  writeFileSync(join(root, '_memories', 'dc-1-alpha.md'),
    '---\nid: dc-1-alpha\ntype: decision\nstatus: active\n---\n\n# DC-1 — MUTATED AFTER SNAPSHOT\n\nThis must not appear in the already-returned outputs.');
  assert.equal(outputs.get('dc-1-alpha.md'), before, 'the already-returned outputs map holds captured bytes, not a live re-read of the source file');
});

test('OKF v0.1-draft conformance: every exported file has parseable frontmatter with a non-empty type, and unknown frontmatter keys are tolerated', () => {
  const root = fixtureStore();
  // An unknown/custom frontmatter key (an OKF/Obsidian "extra property") must
  // survive the export untouched — OKF v0.1 explicitly tolerates unknown fields.
  writeFileSync(join(root, '_memories', 'dc-7-extra-field.md'),
    '---\nid: dc-7-extra-field\ntype: decision\nstatus: active\nsome_custom_wrapper_field: whatever-a-downstream-tool-wants\n---\n\n# DC-7\n\nBody.');
  const outDir = join(root, '_okf-export');
  writeOkfExport(root, outDir);
  for (const name of ['dc-1-alpha.md', 'dc-2-beta.md', 'dc-4-orphan.md', 'dc-7-extra-field.md']) {
    const text = readFileSync(join(outDir, name), 'utf8');
    assert.match(text, /^---\n[\s\S]*?\ntype:\s*\S+/, `${name} must have parseable frontmatter with a non-empty type — the entire OKF v0.1-draft conformance bar`);
  }
  const extra = readFileSync(join(outDir, 'dc-7-extra-field.md'), 'utf8');
  assert.match(extra, /some_custom_wrapper_field: whatever-a-downstream-tool-wants/, 'an unknown frontmatter key must be tolerated (passed through), not stripped or rejected');
});

test('OKF v0.1-draft conformance: a hand-authored broken link in body prose is tolerated, never validated or rejected (only GENERATED links are checked)', () => {
  const root = fixtureStore();
  writeFileSync(join(root, '_memories', 'dc-8-broken-link.md'),
    '---\nid: dc-8-broken-link\ntype: decision\nstatus: active\n---\n\n# DC-8\n\nSee [this thing](does-not-exist-anywhere.md) for context.');
  const outDir = join(root, '_okf-export');
  const manifest = writeOkfExport(root, outDir); // must NOT throw — OKF requires broken links be tolerated
  assert.ok(existsSync(join(outDir, 'dc-8-broken-link.md')));
  assert.equal(manifest.counts.exported_units, 4);
  const text = readFileSync(join(outDir, 'dc-8-broken-link.md'), 'utf8');
  assert.match(text, /does-not-exist-anywhere\.md/, 'the hand-authored broken link is preserved as-is, not stripped or "fixed"');
});

// Antigravity's review, 2026-07-19: does a cyclic edge relationship in the
// memory graph make the export traverse infinitely? renderOkfExport's edge
// rendering is a single FLAT pass — for each unit, it renders exactly that
// unit's own outgoing frontmatter edges as one line each (render-okf-export.mjs,
// the main units loop). It never follows a rendered edge to walk the graph
// further, so there is no recursion into the edge structure at all — a cycle
// is structurally incapable of causing unbounded work here, unlike a real
// graph-walk (e.g. Tier-2 edge-walk retrieval, which is recursive and needs
// its own hop limit). This test proves it directly rather than by inspection:
// a real A<->B cycle exports cleanly, fast, with exactly the expected two
// cross-links, and completion itself is the proof against a runaway loop.
test('a cyclic edge relationship (A cites B, B cites A back) exports cleanly — no infinite loop, exactly one link each way', () => {
  const root = mkdtempSync(join(tmpdir(), 'okf-cycle-'));
  const mem = join(root, '_memories');
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, 'dc-a.md'),
    '---\nid: dc-a\ntype: decision\nstatus: active\nedges:\n  - type: cites\n    target: dc-b\n---\n\n# A\n\nCites B.');
  writeFileSync(join(mem, 'dc-b.md'),
    '---\nid: dc-b\ntype: decision\nstatus: active\nedges:\n  - type: cites\n    target: dc-a\n---\n\n# B\n\nCites A back — a real cycle.');
  const start = Date.now();
  const { outputs, manifest } = renderOkfExport(root);
  assert.ok(Date.now() - start < 5000, 'a two-node cycle must complete near-instantly, not hang or loop');
  const a = outputs.get('dc-a.md');
  const b = outputs.get('dc-b.md');
  assert.equal((a.match(/\]\(dc-b\.md\)/g) || []).length, 1, 'A links to B exactly once, not repeated by a cycle walk');
  assert.equal((b.match(/\]\(dc-a\.md\)/g) || []).length, 1, 'B links to A exactly once, not repeated by a cycle walk');
  assert.equal(manifest.counts.edges_rendered, 2, 'exactly the two direct edges, nothing amplified by the cycle');
});

test('log.md is excluded from the export per OKF v0.1 draft section 7', () => {
  const root = fixtureStore();
  writeFileSync(join(root, '_memories', 'log.md'), '# OKF section 7 reserved file');
  const { outputs } = renderOkfExport(root);
  assert.ok(!outputs.has('log.md'), 'log.md must be excluded');
});

test('link density threshold is executable and caller-supplied', () => {
  const root = fixtureStore();
  assert.throws(() => renderOkfExport(root, { linkDensityThreshold: 99.9 }), (e) => e.code === 'LINK_DENSITY_FAILED');
  const { manifest } = renderOkfExport(root, { linkDensityThreshold: 10.0 });
  assert.equal(manifest.link_density.threshold, 10.0);
});

// Hale re-audit (4d7c65e): direct execution accepted -1, NaN, and "abc" as
// thresholds with no rejection. Each of these must be refused loudly, not
// silently coerced or accepted.
test('link density threshold rejects out-of-range and non-numeric values', () => {
  const root = fixtureStore();
  for (const bad of [-1, 101, NaN, 'abc', Infinity, -Infinity]) {
    assert.throws(
      () => renderOkfExport(root, { linkDensityThreshold: bad }),
      (e) => e.code === 'INVALID_LINK_DENSITY_THRESHOLD',
      `threshold ${JSON.stringify(bad)} must be rejected, not silently accepted`,
    );
  }
  // Boundary values are valid *inputs*, not off-by-one rejected -- tested
  // against validateLinkDensityThreshold directly so a legitimately-failing
  // gate (100% threshold against real fixture density) isn't confused with
  // an invalid-input rejection; renderOkfExport's actual gate behavior is
  // covered by the existing "threshold is executable" test above.
  assert.doesNotThrow(() => validateLinkDensityThreshold(0));
  assert.doesNotThrow(() => validateLinkDensityThreshold(100));
  // null/undefined mean "no gate" — must stay valid (the default, report-only path).
  assert.doesNotThrow(() => validateLinkDensityThreshold(null));
  assert.doesNotThrow(() => validateLinkDensityThreshold(undefined));
});

// Hale re-audit: "today only JavaScript callers can use it" — the gate must
// be reachable from the actual CLI/skill entry point, not just the JS API.
test('CLI --min-link-density exposes the gate and rejects an invalid value with a clear exit', async () => {
  const root = fixtureStore();
  const { execFileSync } = await import('node:child_process');
  const SCRIPT = join(SCRIPTS, 'render-okf-export.mjs');

  // Invalid value -> non-zero exit, no export written.
  assert.throws(() => execFileSync('node', [SCRIPT, root, '--check', '--min-link-density', 'abc'], { encoding: 'utf8' }));

  // Valid, failing threshold -> non-zero exit (LINK_DENSITY_FAILED via CLI path).
  assert.throws(() => execFileSync('node', [SCRIPT, root, '--check', '--min-link-density', '99.9'], { encoding: 'utf8' }));

  // Valid, passing threshold -> succeeds, manifest reflects the caller-supplied value.
  const out = execFileSync('node', [SCRIPT, root, '--check', '--min-link-density', '10'], { encoding: 'utf8' });
  const manifest = JSON.parse(out);
  assert.equal(manifest.link_density.threshold, 10);
});

test('writeOkfExport swap survives a caught in-process exception (existing exception-rollback path)', () => {
  const root = fixtureStore();
  const outDir = join(root, '_okf-export');
  writeOkfExport(root, outDir); // write good export
  const goodAlpha = readFileSync(join(outDir, 'dc-1-alpha.md'), 'utf8');

  process.env.FAULT_INJECT_SWAP_CRASH = '1';
  try {
    writeOkfExport(root, outDir);
    assert.fail('should have thrown SWAP_FAILED');
  } catch (e) {
    assert.equal(e.code, 'SWAP_FAILED');
  } finally {
    delete process.env.FAULT_INJECT_SWAP_CRASH;
  }

  assert.equal(readFileSync(join(outDir, 'dc-1-alpha.md'), 'utf8'), goodAlpha, 'backup must be restored');
});

// Hale re-audit (4d7c65e): "FAULT_INJECT_SWAP_CRASH throws inside the same
// process, so the catch restores the backup. A real process death after
// renameSync(outDir, bakDir) never reaches catch." This test kills a REAL
// child process at exactly that window (process.exit, not a thrown JS
// error — the child never reaches its own try/catch/finally), then proves
// the NEXT writeOkfExport call in a fresh process recovers automatically.
test('writeOkfExport recovers a real killed-process crash on the next run (not just a caught exception)', async () => {
  const root = fixtureStore();
  const outDir = join(root, '_okf-export');
  writeOkfExport(root, outDir); // write good export
  const goodAlpha = readFileSync(join(outDir, 'dc-1-alpha.md'), 'utf8');

  const { spawnSync } = await import('node:child_process');
  const SCRIPT = join(SCRIPTS, 'render-okf-export.mjs');
  const killed = spawnSync('node', [SCRIPT, root, '--out', outDir], {
    env: { ...process.env, FAULT_INJECT_HARD_KILL: '1' },
    encoding: 'utf8',
  });
  assert.notEqual(killed.status, 0, 'the child must have died before completing the export');

  // Crash window: outDir renamed away, tmpDir never renamed in. outDir must
  // be absent and exactly one orphaned backup must exist right now.
  assert.ok(!existsSync(outDir), 'outDir must be absent immediately after the simulated crash');
  const { readdirSync } = await import('node:fs');
  const orphans = readdirSync(root).filter(e => e.startsWith('_okf-export.bak-'));
  assert.equal(orphans.length, 1, 'exactly one orphaned backup must exist post-crash');

  // Next run (fresh, in-process, no fault flag) must recover automatically
  // and produce a correct export, not error out or silently lose data.
  writeOkfExport(root, outDir);
  assert.ok(existsSync(outDir), 'outDir must exist after the recovering run');
  assert.equal(readFileSync(join(outDir, 'dc-1-alpha.md'), 'utf8'), goodAlpha, 'recovered content must match the pre-crash export');
  assert.equal(readdirSync(root).filter(e => e.startsWith('_okf-export.bak-')).length, 0, 'the recovered backup directory must be consumed, not left behind');
});

test('multiple ambiguous orphaned backups fail closed instead of guessing', async () => {
  const root = fixtureStore();
  const outDir = join(root, '_okf-export');
  writeOkfExport(root, outDir);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(`${outDir}.bak-11111`, { recursive: true });
  mkdirSync(`${outDir}.bak-22222`, { recursive: true });
  assert.throws(
    () => writeOkfExport(root, outDir),
    (e) => e.code === 'AMBIGUOUS_BACKUP_RECOVERY',
    'two candidate backups must never be auto-resolved by guessing',
  );
});

