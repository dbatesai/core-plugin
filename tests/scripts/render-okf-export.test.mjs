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
const { renderOkfExport, writeOkfExport, MANIFEST_NAME, INDEX_NOTE_NAME, validateLinkDensityThreshold, recoverOrphanedBackup } =
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
  // Active units: alpha, beta, orphan = 3. With-OUTGOING-active-edge: alpha
  // only (beta's and orphan's own outgoing edges are none).
  assert.equal(manifest.link_density.active_units, 3);
  assert.equal(manifest.link_density.with_outgoing_active_edge, 1);
  assert.equal(manifest.link_density.without_outgoing_active_edge, 2);
  // Hale re-audit (correction-okf-orphan-metric-semantic-mismatch): beta
  // has no OUTGOING edge, but alpha links TO it -- a real backlink, so
  // beta must NOT count as a true graph orphan. Only dc-4-orphan (neither
  // outgoing nor incoming) is a real graph orphan. This is exactly Hale's
  // requested fixture: "B has no outgoing edge but A links to B; B must
  // not be labeled a graph orphan."
  assert.equal(manifest.link_density.true_graph_orphans, 1, 'only dc-4-orphan is a true graph orphan; dc-2-beta has a real backlink from dc-1-alpha');
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
  assert.equal(manifest.counts.exported_units, 3, 'exported_units counts real units only, not the generated index note');
});

// The generated index.md MOC — the vault's entry point (deferred-not-
// rejected in the original design spec's adversarial pass). Covers:
// presence, real content grouped by type, the isolated-notes section, that
// it's excluded from exported_units, and the collision guard.
test('renderOkfExport generates index.md grouped by type, with an isolated-notes section, and it never counts toward exported_units', () => {
  const root = fixtureStore();
  const { outputs, manifest } = renderOkfExport(root);
  assert.ok(outputs.has(INDEX_NOTE_NAME), 'the generated index note must be present in outputs');
  const index = outputs.get(INDEX_NOTE_NAME);
  assert.match(index, /^---\ntype: index\n/, 'the index note must carry type: index frontmatter to pass post-write validation');
  assert.match(index, /## decision \(2\)/);
  assert.match(index, /- \[dc-1-alpha\]\(dc-1-alpha\.md\)/);
  assert.match(index, /## observation \(1\)/);
  // dc-4-orphan has no outgoing edge and no backlink -- it must appear in
  // the isolated-notes section, same population as true_graph_orphans.
  assert.match(index, /## Isolated notes \(1\)/);
  assert.match(index, /- \[dc-4-orphan\]\(dc-4-orphan\.md\)/);
  // dc-2-beta has a real backlink (dc-1-alpha cites it) -- it must NOT be
  // listed as isolated, matching the true_graph_orphans semantics exactly.
  const isolatedSection = index.slice(index.indexOf('## Isolated notes'));
  assert.ok(!isolatedSection.includes('dc-2-beta'), 'a unit with a real backlink must not appear in the isolated-notes section');
  assert.equal(manifest.counts.exported_units, 3, 'the index note itself is not a unit and must not inflate exported_units');
  assert.equal(manifest.index_note, INDEX_NOTE_NAME);
});

test('the index note is excluded from the deterministic byte-identity guarantee by having no live timestamp in it', () => {
  const root = fixtureStore();
  const first = renderOkfExport(root).outputs.get(INDEX_NOTE_NAME);
  const second = renderOkfExport(root).outputs.get(INDEX_NOTE_NAME);
  assert.equal(first, second, 'two renders of an unchanged store must produce a byte-identical index note, same as every other exported file');
});

test('a hand-authored H1 containing markdown link syntax cannot synthesize a real link in the generated index note (Hale okf-index-truth-external-0-of-3)', () => {
  const root = mkdtempSync(join(tmpdir(), 'okf-export-injection-'));
  mkdirSync(join(root, '_memories'), { recursive: true });
  writeFileSync(join(root, '_memories', 'dc-9-spoof.md'),
    '---\nid: dc-9-spoof\ntype: decision\nstatus: active\n---\n\n# Alpha [spoof](missing.md)\n\nBody.');
  const index = renderOkfExport(root).outputs.get(INDEX_NOTE_NAME);
  assert.ok(!index.includes('[spoof](missing.md)'), 'the source H1\'s own markdown link syntax must never survive unescaped into the generated note');
  assert.match(index, /Alpha \\\[spoof\\\]\(missing\.md\)/, 'the text itself is preserved, just neutralized so it cannot render as a link');
});

test('the isolated-notes claim is scoped to unit-to-unit edges, not falsified by the index note\'s own navigation links (Hale okf-index-truth-external-0-of-3)', () => {
  const root = fixtureStore();
  const index = renderOkfExport(root).outputs.get(INDEX_NOTE_NAME);
  const isolatedSection = index.slice(index.indexOf('## Isolated notes'));
  assert.ok(!isolatedSection.includes('No outgoing or incoming links in this export'), 'the old wording was literally false once the index note itself links to every listed unit');
  assert.match(isolatedSection, /another \*unit\*/, 'the claim must be explicit that it excludes this note\'s own navigation links');
});

// Hale caught the earlier version of this: the SCAFFOLD regex (INDEX[^/]*.md,
// case-insensitive) silently drops any source unit literally named index.md
// from `units` -- including a real, frontmatter-bearing one -- before the
// index note is ever generated, with no warning. Treating that as "the
// guard is unreachable, so it's fine" was itself the defect: a real unit at
// the reserved path would just vanish. renderOkfExport() now checks the
// unfiltered snapshot for that exact collision BEFORE the SCAFFOLD filter
// runs, so it fails loud (INDEX_NOTE_NAME_COLLISION) instead of silently.
test('a real unit occupying the reserved index-note path fails closed (Hale: silent SCAFFOLD-drop was the actual defect)', () => {
  // NOT fixtureStore() -- it already plants an uppercase _memories/INDEX.md
  // scaffold file, which on a case-insensitive filesystem (default macOS
  // APFS) is the SAME file as a lowercase index.md, masking the real
  // collision this test needs to exercise. A fresh, minimal store avoids it.
  const root = mkdtempSync(join(tmpdir(), 'okf-export-collision-'));
  mkdirSync(join(root, '_memories'), { recursive: true });
  writeFileSync(join(root, '_memories', 'index.md'), '---\nid: dc-5-index-collision\ntype: decision\nstatus: active\n---\n\n# A real unit that happens to be named index.md\n');
  assert.throws(
    () => renderOkfExport(root),
    (e) => e.code === 'INDEX_NOTE_NAME_COLLISION' && e.message.includes('dc-5-index-collision'),
    'a real, frontmatter-bearing unit at the reserved index-note path must fail loud, not vanish silently into the SCAFFOLD bucket',
  );
});

test('writeOkfExport: the index note lands on disk in a real round-trip and links resolve', () => {
  const root = fixtureStore();
  const outDir = join(root, '_okf-export');
  writeOkfExport(root, outDir);
  assert.ok(existsSync(join(outDir, INDEX_NOTE_NAME)));
  const index = readFileSync(join(outDir, INDEX_NOTE_NAME), 'utf8');
  assert.match(index, /## decision \(2\)/);
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

test('a leftover tmp directory from a different (crashed) pid is swept, not just tolerated', () => {
  const root = fixtureStore();
  const outDir = join(root, '_okf-export');
  // Simulate a crashed prior run's leftover temp dir under a DIFFERENT pid.
  // Hale re-audit (34e57be): the original fix only ever cleaned up the
  // CURRENT process's own `${outDir}.tmp-${process.pid}`, so an older
  // crashed run's tmp dir survived indefinitely -- tmp dirs are always
  // disposable (real content only exists once atomically renamed into
  // outDir), so recoverOrphanedBackup now sweeps every `.tmp-*` sibling
  // unconditionally, regardless of which pid created it.
  const staleTmp = `${outDir}.tmp-999999999`;
  mkdirSync(staleTmp, { recursive: true });
  writeFileSync(join(staleTmp, 'junk.md'), 'leftover from a crashed run');
  const manifest = writeOkfExport(root, outDir);
  assert.equal(manifest.counts.exported_units, 3, 'a fresh run succeeds normally regardless of an unrelated stale tmp dir');
  assert.ok(existsSync(join(outDir, MANIFEST_NAME)), 'the real export landed');
  assert.ok(!existsSync(staleTmp), 'the stray tmp dir from a different pid must be swept, not left behind');
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

// Hale second re-audit (34e57be), finding 2: a flag present but its value
// missing (last argument, or the next token is itself another flag)
// silently exited 0 with threshold: null -- indistinguishable from the flag
// never being passed at all. Both shapes must now error loudly.
test('CLI --min-link-density with a missing value errors instead of silently disabling the gate', async () => {
  const root = fixtureStore();
  const { execFileSync } = await import('node:child_process');
  const SCRIPT = join(SCRIPTS, 'render-okf-export.mjs');

  // Flag is the last argument -- no value follows at all.
  assert.throws(() => execFileSync('node', [SCRIPT, root, '--check', '--min-link-density'], { encoding: 'utf8' }));

  // Flag's "value" slot is actually another flag.
  assert.throws(() => execFileSync('node', [SCRIPT, root, '--min-link-density', '--check'], { encoding: 'utf8' }));

  // Flag genuinely never passed -- this remains valid "no gate".
  const out = execFileSync('node', [SCRIPT, root, '--check'], { encoding: 'utf8' });
  assert.equal(JSON.parse(out).link_density.threshold, null);
});

// Hale second re-audit, finding 1: validateLinkDensityThreshold used
// Number(t) coercion, so "10" -> 10, "" -> 0, " " -> 0, true -> 1,
// false -> 0, and [] -> 0 all silently became valid numbers. The JS API
// must be strict (typeof === 'number'); only the CLI parser converts
// strings, and only via an explicit numeric-format check.
test('validateLinkDensityThreshold is strict: no type coercion, even for values Number() would accept', () => {
  for (const bad of ['10', '', ' ', true, false, [], {}, [10]]) {
    assert.throws(
      () => validateLinkDensityThreshold(bad),
      (e) => e.code === 'INVALID_LINK_DENSITY_THRESHOLD',
      `${JSON.stringify(bad)} (${typeof bad}) must be rejected by the strict JS API, not coerced`,
    );
  }
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

  // Next run: the ORDINARY production call, no special options. Hale
  // re-audit (hale--lock-test-production-mismatch, hale--48854e2-
  // production-next-run-hold): an earlier version of this test passed a
  // test-only tightened staleMs while production kept file-lock's
  // cross-project 10-minute default -- so this test proved "recoverable
  // on the next run" while the real CLI path, reproduced exactly (export,
  // hard-kill, export again with no flags), still threw LOCK_HELD for ten
  // minutes after a real crash. writeOkfExport now hardcodes staleMs: 0
  // for its own lock (pidAlive() is what actually protects a live
  // process; staleMs never did on its own), so this call IS the real
  // path -- must succeed immediately, not after any wait.
  writeOkfExport(root, outDir);
  assert.ok(existsSync(outDir), 'outDir must exist after the recovering run');
  assert.equal(readFileSync(join(outDir, 'dc-1-alpha.md'), 'utf8'), goodAlpha, 'recovered content must match the pre-crash export');
  // Hale second re-audit (34e57be): the killed child's OWN tmpDir (fully
  // written before the crash, never promoted) also survives the crash and
  // was not being swept -- "recovery consumed the backup but left
  // export.tmp-<pid>/". Every stray artifact (both the consumed backup and
  // the killed process's own leftover tmp dir) must be gone after recovery.
  const stray = readdirSync(root).filter(e => e.startsWith('_okf-export.bak-') || e.startsWith('_okf-export.tmp-'));
  assert.deepEqual(stray, [], `no stray tmp/backup artifacts may survive a completed recovery, found: ${stray.join(', ')}`);
});

// Hale second re-audit (54e4479), minimal repro 1: "Create
// outDir.tmp-${process.pid} while that PID is live, then call
// recoverOrphanedBackup(outDir). Expected: the live writer's tree remains.
// Actual: it is deleted." The unconditional sweep from the prior fix was
// unsafe under real concurrency -- a second live exporter's in-progress,
// already-validated tmp dir would be destroyed out from under it. Fixed
// with pidAlive() (file-lock.mjs): only a confirmed-dead pid's tmp dir is
// ever touched.
test('recoverOrphanedBackup never touches a live pid\'s tmp dir (Hale minimal repro 1)', () => {
  const root = fixtureStore();
  const outDir = join(root, '_okf-export');
  const liveTmp = `${outDir}.tmp-${process.pid}`; // this test's own pid — guaranteed alive
  mkdirSync(liveTmp, { recursive: true });
  writeFileSync(join(liveTmp, 'in-progress.md'), 'a concurrent writer\'s validated, not-yet-swapped tree');
  recoverOrphanedBackup(outDir);
  assert.ok(existsSync(liveTmp), 'a live pid\'s tmp dir must survive recovery, not be deleted');
  assert.equal(readFileSync(join(liveTmp, 'in-progress.md'), 'utf8'), 'a concurrent writer\'s validated, not-yet-swapped tree');
  rmSync(liveTmp, { recursive: true, force: true });
});

// Hale second re-audit, minimal repro 2: "Create a valid outDir plus
// outDir.bak-999999999, representing death after tmpDir -> outDir, then
// call recovery. Expected: the dead-owner backup is consumed. Actual: it
// remains." The prior fix returned immediately once outDir existed,
// leaving a completed-swap's own leftover backup orphaned forever.
test('recoverOrphanedBackup consumes a dead-owner backup even when outDir already exists (Hale minimal repro 2)', () => {
  const root = fixtureStore();
  const outDir = join(root, '_okf-export');
  writeOkfExport(root, outDir);
  const deadBak = `${outDir}.bak-999999999`; // not a real pid on any real machine
  mkdirSync(deadBak, { recursive: true });
  writeFileSync(join(deadBak, 'stale.md'), 'leftover from a completed swap whose cleanup never ran');
  recoverOrphanedBackup(outDir);
  assert.ok(!existsSync(deadBak), 'a dead-owner backup must be consumed even when outDir already exists and looks healthy');
  assert.ok(existsSync(outDir), 'outDir itself must be untouched');
});

// Hale re-audit (hale--exporter-lock-stale-default): "when outDir is
// absent and any live-owner backup exists, do not restore an older dead
// backup beside it; the live owner has the active transaction." A live
// backup means that pid's swap is actively in flight -- restoring a
// different, dead backup out from under it would be a real correctness
// bug, not a hypothetical one.
test('recoverOrphanedBackup defers entirely when a live-owner backup exists, even alongside a dead one', () => {
  const root = fixtureStore();
  const outDir = join(root, '_okf-export');
  const liveBak = `${outDir}.bak-${process.pid}`; // this test's own pid — guaranteed alive
  const deadBak = `${outDir}.bak-999999999`;
  mkdirSync(liveBak, { recursive: true });
  writeFileSync(join(liveBak, 'live.md'), 'the live owner\'s active transaction');
  mkdirSync(deadBak, { recursive: true });
  writeFileSync(join(deadBak, 'dead.md'), 'an unrelated older dead backup');
  try {
    const result = recoverOrphanedBackup(outDir);
    assert.equal(result.recovered, false);
    assert.ok(!existsSync(outDir), 'outDir must stay absent — recovery must not proceed while a live owner is active');
    assert.ok(existsSync(liveBak), 'the live owner\'s backup must be untouched');
  } finally {
    rmSync(liveBak, { recursive: true, force: true });
    rmSync(deadBak, { recursive: true, force: true });
  }
});

// Hale live-exporter-diff-concurrency-stop: a concurrent negative control
// with a GENUINELY different pid, not just the two isolated minimal repros
// above (which correctly use this test's own pid, per Hale's literal repro
// instructions, but that means writeOkfExport's own "clear my own prior
// attempt's leftover" self-cleanup would legitimately also touch a
// same-pid fixture -- self-cleanup of your own past leftover is correct
// and unrelated to this fix; the real concurrency question is a DIFFERENT
// live pid). Spawns a real long-running child holding its own tmp dir
// under its own real pid, confirms a competing writeOkfExport in THIS
// process leaves it untouched, then cleans the child up.
test('a live concurrent writer (a real, different pid) survives a competing writeOkfExport call', async () => {
  const root = fixtureStore();
  const outDir = join(root, '_okf-export');
  const { spawn } = await import('node:child_process');
  const child = spawn('node', ['-e', `
    const { mkdirSync, writeFileSync } = require('fs');
    const dir = ${JSON.stringify(outDir)} + '.tmp-' + process.pid;
    mkdirSync(dir, { recursive: true });
    writeFileSync(dir + '/in-progress.md', 'concurrent writer content');
    process.stdout.write(dir + '\\n');
    setInterval(() => {}, 1000); // stay alive until killed
  `], { stdio: ['ignore', 'pipe', 'ignore'] });

  const childTmpDir = await new Promise((resolvePromise) => {
    child.stdout.once('data', (buf) => resolvePromise(buf.toString().trim()));
  });
  try {
    assert.ok(existsSync(childTmpDir), 'the child must have created its live tmp dir before we proceed');
    writeOkfExport(root, outDir);
    assert.ok(existsSync(childTmpDir), 'a competing writeOkfExport must never delete another LIVE process\'s in-progress tree');
    assert.equal(readFileSync(join(childTmpDir, 'in-progress.md'), 'utf8'), 'concurrent writer content');
  } finally {
    child.kill('SIGKILL');
    rmSync(childTmpDir, { recursive: true, force: true });
  }
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

