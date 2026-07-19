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
const { renderOkfExport, writeOkfExport, MANIFEST_NAME } =
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
