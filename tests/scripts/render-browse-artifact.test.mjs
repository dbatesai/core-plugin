/**
 * render-browse-artifact — the memory-browse artifact generator.
 * Covers the disclosure-boundary guarantees the design spec makes
 * hard requirements (conditions 2/4/6/7 as enforced in code):
 *   - embedded units + snapshot provenance header present in the HTML;
 *   - ZERO external references in the generated chrome (the only URLs in the
 *     whole file are inside unit body text, embedded as data);
 *   - scope filtering (archived/retired excluded by default; explicit
 *     all-including-archive includes them; --exclude-topic honored);
 *   - preflight manifest counts match the embedded content and byte size;
 *   - local receipt written with the same content;
 *   - read-only: the store is byte-identical before/after generation;
 *   - CLI contract: --out required, manifest JSON shape stable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, cpSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, basename, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { symlinkSync, realpathSync } from 'node:fs';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'scripts');
const {
  renderBrowseArtifact, SENSITIVITY_WARNING, collectUnits,
  BROWSE_MANIFEST_SCHEMA_VERSION, producerIdentity, publishReceiptPathFor,
  buildArtifactHtml, computeGraph, computeDefaultFocus,
  resolveMetricsForRender,
} = await import(pathToFileURL(join(SCRIPTS, 'render-browse-artifact.mjs')).href);
const { loadSnapshot } = await import(pathToFileURL(join(SCRIPTS, 'generate-summary-index.mjs')).href);
const CLI_PATH = join(SCRIPTS, 'render-browse-artifact.mjs');

// Fix 9: the shared provenance helper fails closed on a dirty
// plugin tree — so real renders only produce a source_sha (and only succeed)
// when the working tree is clean. Detect state once; render-dependent tests
// assert the right contract either way (skip-with-reason when dirty, since the
// renderer correctly refuses). On a clean checkout (CI, post-commit) they run.
function pluginTreeIsClean() {
  try {
    return execFileSync('git', ['-C', SCRIPTS, 'status', '--porcelain', '--',
      join(SCRIPTS, '..', '..', '..')], { encoding: 'utf8' }).trim().length === 0;
  } catch { return false; }
}
const TREE_CLEAN = pluginTreeIsClean();
// A render-dependent test: needs a clean plugin tree (the renderer fails closed
// without a real SHA). On a dirty tree it HARD-FAILS with a named reason — the
// failing run IS the refusal. A skip here reads as green while asserting
// nothing, which is exactly how dirty-tree regressions ship.
const DIRTY_TREE_REFUSAL =
  'REFUSED: plugin tree is dirty, so this behavior assertion cannot execute '
  + '(fix 9 fail-closed provenance). Commit or stash the plugin tree and re-run '
  + '— a skipped-green result here proves nothing.';
const rtest = (name, fn) => test(name, TREE_CLEAN ? fn : () => { assert.fail(DIRTY_TREE_REFUSAL); });

// Stub metrics provider: tests never run the live subprocess probe suite —
// the metrics object only needs the fields the page consumes.
const stubMetrics = async () => ({ report: 'STUB METRICS REPORT (four evidence classes)', mechanics: { status: 'WORKING' } });

function fixtureProject({ workspace = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'browse-artifact-'));
  const mem = join(root, '_memories');
  mkdirSync(join(mem, 'archive'), { recursive: true });
  writeFileSync(join(mem, 'dc-1-alpha.md'),
    `---\nid: dc-1-alpha\ntype: decision\nstatus: active\ntopics: [alpha, shared]\nupdated: 2026-07-01\nedges:\n  - type: cites\n    target: obs-2-beta\n  - type: supersedes\n    target: risk-3-retired\n---\n\n# DC-1-alpha — Alpha decision\n\nBody citing an external source at https://example.com/spec for reference.\n\n- point one\n- point two\n`);
  writeFileSync(join(mem, 'obs-2-beta.md'),
    '---\nid: obs-2-beta\ntype: observation\nstatus: active\ntopics: [beta]\nupdated: 2026-07-02\n---\n\n# OBS-2 — Beta observation\n\nPlain body.\n');
  writeFileSync(join(mem, 'topic-4-secret.md'),
    '---\nid: topic-4-secret\ntype: topic\nstatus: active\ntopics: [confidential-client]\n---\n\n# Secret topic unit\n\nSensitive.\n');
  writeFileSync(join(mem, 'risk-3-retired.md'),
    '---\nid: risk-3-retired\ntype: risk\nstatus: retired\ntopics: [alpha]\n---\n\n# RISK-3 — Retired\n\nRetired body.\n');
  writeFileSync(join(mem, 'archive', 'old-note.md'),
    '---\nid: old-note\ntype: observation\nstatus: archived\ntopics: [beta]\n---\n\n# Archived note\n\nArchived body.\n');
  writeFileSync(join(mem, 'INDEX.md'), '# scaffolding — must never be embedded');
  if (workspace) {
    writeFileSync(join(root, 'workspace.json'), JSON.stringify({ workspace_id: 'browse-test-ws' }));
  }
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return { root, mem, home };
}

function extractDataBlock(html) {
  const m = html.match(/<script type="application\/json" id="core-data">([\s\S]*?)<\/script>/);
  assert.ok(m, 'embedded data block present');
  return { json: JSON.parse(m[1]), raw: m[0], data: m[1] };
}

async function generate(root, home, opts = {}) {
  const outPath = join(root, 'out', 'view.html');
  const res = await renderBrowseArtifact(root, {
    outPath, home, metricsProvider: stubMetrics, ...opts,
  });
  return { ...res, outPath };
}

// ---------- embedding + provenance ----------

rtest('embeds active units with bodies, edges, and snapshot provenance header', async () => {
  const { root, home } = fixtureProject();
  try {
    const { manifest, html } = await generate(root, home);
    const { json } = extractDataBlock(html);
    const ids = json.units.map((u) => u.id).sort();
    assert.deepEqual(ids, ['dc-1-alpha', 'obs-2-beta', 'topic-4-secret']);
    const dc1 = json.units.find((u) => u.id === 'dc-1-alpha');
    assert.match(dc1.body, /external source at https:\/\/example\.com\/spec/, 'full body embedded');
    assert.deepEqual(dc1.edges.map((e) => e.target).sort(), ['obs-2-beta', 'risk-3-retired']);
    assert.equal(dc1.title, 'DC-1-alpha — Alpha decision');
    // Provenance banner (condition 6)
    assert.match(html, /POINT-IN-TIME SNAPSHOT &mdash; READ-ONLY/);
    assert.ok(html.includes(manifest.generated_at), 'generated-at timestamp in the page');
    assert.ok(html.includes(manifest.snapshot_id.slice(0, 12)), 'snapshot id in the banner');
    assert.ok(html.includes(manifest.snapshot_id), 'full snapshot id in the page');
    assert.ok(manifest.producer.plugin_version && html.includes(`v${manifest.producer.plugin_version}`),
      'producer plugin version in the banner');
    if (manifest.producer.source_sha) {
      assert.ok(html.includes(manifest.producer.source_sha.slice(0, 12)), 'producer source_sha in the banner');
    }
    // Scaffolding and metrics stub
    assert.ok(!html.includes('must never be embedded'), 'INDEX scaffolding excluded');
    assert.match(html, /STUB METRICS REPORT/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- zero external references ----------

rtest('generated chrome carries zero external references; unit-body URLs survive only as embedded data', async () => {
  const { root, home } = fixtureProject();
  try {
    const { html } = await generate(root, home);
    const { raw, data } = extractDataBlock(html);
    // The unit body's URL is IN the data (that's the allowed exception)…
    assert.match(data, /https:\/\/example\.com\/spec/);
    // …and the chrome (everything that is not the data block) has none of the
    // shapes that could reach the network under a strict CSP.
    const chrome = html.replace(raw, '');
    assert.doesNotMatch(chrome, /https?:\/\//, 'no http(s) URL anywhere in chrome');
    assert.doesNotMatch(chrome, /<link[\s>]/i, 'no <link> elements');
    assert.doesNotMatch(chrome, /@import/i, 'no CSS imports');
    assert.doesNotMatch(chrome, /url\(/i, 'no CSS url() references');
    assert.doesNotMatch(chrome, /\bsrc\s*=/i, 'no src= attributes');
    assert.doesNotMatch(chrome, /fetch\s*\(/, 'no fetch calls');
    assert.doesNotMatch(chrome, /XMLHttpRequest|WebSocket|EventSource/, 'no network APIs');
    assert.doesNotMatch(chrome, /import\s*\(/, 'no dynamic imports');
    assert.doesNotMatch(chrome, /@font-face/i, 'no font loading');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- scope filtering ----------

rtest('default scope excludes archived and retired units (same filtering as decoration)', async () => {
  const { root, home } = fixtureProject();
  try {
    const { html, manifest } = await generate(root, home);
    const { json } = extractDataBlock(html);
    const ids = json.units.map((u) => u.id);
    assert.ok(!ids.includes('risk-3-retired'), 'retired excluded by status');
    assert.ok(!ids.includes('old-note'), 'archived excluded by path');
    assert.ok(!html.includes('Retired body.'), 'retired body absent from the whole file');
    assert.ok(!html.includes('Archived body.'), 'archived body absent from the whole file');
    assert.equal(manifest.scope.mode, 'active');
    assert.equal(manifest.supplemental_count, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

rtest('--scope all-including-archive embeds archived + retired units, marked non-active', async () => {
  const { root, home } = fixtureProject();
  try {
    const { html, manifest } = await generate(root, home, { scope: 'all-including-archive' });
    const { json } = extractDataBlock(html);
    const byId = Object.fromEntries(json.units.map((u) => [u.id, u]));
    assert.ok(byId['risk-3-retired'], 'retired unit included');
    assert.equal(byId['risk-3-retired'].status, 'retired');
    assert.ok(byId['old-note'], 'archived unit included');
    assert.equal(byId['old-note'].population, 'archive');
    assert.equal(manifest.unit_count, 5);
    assert.equal(manifest.supplemental_count, 2);
    assert.equal(manifest.scope.mode, 'all-including-archive');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

rtest('--exclude-topic removes matching units and counts them in the manifest', async () => {
  const { root, home } = fixtureProject();
  try {
    const { html, manifest } = await generate(root, home, { excludeTopics: ['Confidential-Client'] });
    const { json } = extractDataBlock(html);
    assert.ok(!json.units.some((u) => u.id === 'topic-4-secret'), 'excluded-topic unit absent');
    assert.ok(!html.includes('Sensitive.'), 'excluded body absent from the whole file');
    assert.equal(manifest.excluded_by_topic_count, 1);
    assert.deepEqual(manifest.scope.excluded_topics, ['Confidential-Client']);
    assert.equal(manifest.unit_count, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- manifest ↔ content agreement ----------

rtest('preflight manifest matches the embedded content and the actual bytes on disk', async () => {
  const { root, home } = fixtureProject();
  try {
    const { manifest, html, outPath } = await generate(root, home);
    const { json } = extractDataBlock(html);
    assert.equal(manifest.unit_count, json.units.length, 'unit_count == embedded units');
    assert.equal(manifest.active_count, json.units.length);
    const onDisk = readFileSync(outPath);
    assert.equal(manifest.total_bytes, onDisk.length, 'total_bytes == real file size');
    assert.equal(onDisk.toString('utf8'), html);
    assert.equal(manifest.sensitivity_warning, SENSITIVITY_WARNING, 'fixed sensitivity string, verbatim');
    assert.equal(manifest.schema_version, BROWSE_MANIFEST_SCHEMA_VERSION);
    assert.equal(manifest.kind, 'core-memory-browse-preflight');
    const cap = loadSnapshot(root, { captureBodies: true });
    assert.equal(manifest.snapshot_id, cap.snapshotId, 'manifest snapshot id is the store snapshot id');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- receipt ----------

rtest('writes a local receipt under the workspace with content identical to the manifest', async () => {
  const { root, home } = fixtureProject();
  try {
    const { manifest, receiptWritten } = await generate(root, home);
    assert.equal(receiptWritten, true);
    assert.equal(manifest.receipt_fallback, false);
    assert.ok(manifest.receipt_path.startsWith(join(home, '.core', 'workspaces', 'browse-test-ws', 'artifact-receipts')),
      'receipt lands in the workspace artifact-receipts dir');
    const receipt = JSON.parse(readFileSync(manifest.receipt_path, 'utf8'));
    assert.deepEqual(receipt, manifest, 'receipt content == manifest content');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

rtest('no workspace.json → receipt still written to the flagged fallback location', async () => {
  const { root, home } = fixtureProject({ workspace: false });
  try {
    const { manifest, receiptWritten } = await generate(root, home);
    assert.equal(receiptWritten, true);
    assert.equal(manifest.receipt_fallback, true);
    assert.equal(manifest.workspace_id, null);
    assert.ok(manifest.receipt_path.startsWith(join(home, '.core', 'artifact-receipts')));
    assert.ok(existsSync(manifest.receipt_path));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- read-only guarantee ----------

function snapshotBytes(dir) {
  const out = new Map();
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full, rel + e.name + '/');
      else out.set(rel + e.name, readFileSync(full));
    }
  };
  walk(dir, '');
  return out;
}

rtest('generation never writes to _memories/ — store byte-identical before and after, from COLD', async () => {
  const { root, mem, home } = fixtureProject();
  try {
    // Deliberately COLD: no cache warm-up. A warmed cache here would hide a
    // first-render `_lib/` write — the exact violation the read-only promise
    // forbids — so the comparison starts from the store's pristine state.
    const before = snapshotBytes(mem);
    await generate(root, home, { scope: 'all-including-archive' });
    await generate(root, home); // second run, default scope
    const after = snapshotBytes(mem);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no files added or removed');
    for (const [rel, buf] of before) {
      assert.ok(after.get(rel).equals(buf), `byte-identical: ${rel}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('refuses an --out path inside the memory store', async () => {
  const { root, mem, home } = fixtureProject();
  try {
    await assert.rejects(
      () => renderBrowseArtifact(root, { outPath: join(mem, 'view.html'), home, metricsProvider: stubMetrics }),
      (e) => e.code === 'OUT_IN_STORE');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- CLI contract ----------

test('CLI: --out is required — errors without it, writes nothing', () => {
  const { root } = fixtureProject();
  try {
    const res = spawnSync(process.execPath, [CLI_PATH, root, '--no-metrics'], { encoding: 'utf8' });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /--out/);
    assert.ok(!existsSync(join(root, 'out')), 'no output written');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- cold-store read-only + scoped identity ----------

test('cold store: collectUnits never materializes the derived _lib cache (read-only includes the FIRST read)', () => {
  const { root, mem } = fixtureProject();
  try {
    assert.equal(existsSync(join(mem, '_lib')), false, 'fixture starts cold');
    collectUnits(root);
    assert.equal(existsSync(join(mem, '_lib')), false,
      'the skill promises the whole flow never writes the store — a cold first render included');
    collectUnits(root, { scope: 'all-including-archive' });
    assert.equal(existsSync(join(mem, '_lib')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('scoped identity: an archive-only edit changes the all-including-archive id and never the active id', () => {
  const { root, mem } = fixtureProject();
  try {
    const activeBefore = collectUnits(root).snapshotId;
    const archiveBefore = collectUnits(root, { scope: 'all-including-archive' });
    assert.notEqual(archiveBefore.snapshotId, activeBefore,
      'the archive-including view has its own identity over its own population');
    assert.equal(archiveBefore.activeSnapshotId, activeBefore,
      'activeSnapshotId carries the plain store id for baseline matching');

    writeFileSync(join(mem, 'archive', 'old-note.md'),
      '---\nid: old-note\ntype: observation\nstatus: archived\ntopics: [beta]\n---\n\n# Archived note\n\nArchive bytes CHANGED.\n');

    assert.equal(collectUnits(root).snapshotId, activeBefore,
      'active scope must not see archive-only changes');
    assert.notEqual(collectUnits(root, { scope: 'all-including-archive' }).snapshotId, archiveBefore.snapshotId,
      'the published identity must cover every included source byte');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('exclusion-aware identity: the id covers exactly the kept population — excluded edits never change it, kept edits always do', () => {
  const { root, mem } = fixtureProject();
  try {
    const whole = collectUnits(root);
    const excludedBefore = collectUnits(root, { excludeTopics: ['confidential-client'] });
    assert.notEqual(excludedBefore.snapshotId, whole.snapshotId,
      'different rendered populations must not share one snapshot id');

    // Direction 1: an edit wholly inside the excluded topic must NOT move the
    // excluded view's identity (no wake, no republish of an identical page).
    writeFileSync(join(mem, 'topic-4-secret.md'),
      '---\nid: topic-4-secret\ntype: topic\nstatus: active\ntopics: [confidential-client]\n---\n\n# Secret topic unit\n\nSensitive v2.\n');
    const excludedAfterSecretEdit = collectUnits(root, { excludeTopics: ['confidential-client'] });
    assert.equal(excludedAfterSecretEdit.snapshotId, excludedBefore.snapshotId,
      'an edit wholly outside the rendered population must not force a republish');

    // Direction 2: an edit to a KEPT unit must move it.
    writeFileSync(join(mem, 'obs-2-beta.md'),
      '---\nid: obs-2-beta\ntype: observation\nstatus: active\ntopics: [beta]\nupdated: 2026-07-02\n---\n\n# OBS-2 — Beta observation\n\nKept body CHANGED.\n');
    assert.notEqual(collectUnits(root, { excludeTopics: ['confidential-client'] }).snapshotId,
      excludedBefore.snapshotId,
      'a kept unit\'s edit is exactly what the identity must track');

    // No exclusions → the legacy id, verbatim: existing receipts stay comparable.
    assert.equal(collectUnits(root).activeSnapshotId, collectUnits(root).snapshotId);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- CLI flag contract ----------

test('CLI: --no-metrics together with --metrics-cache is refused loudly (exit 2), nothing rendered', () => {
  const { root, home } = fixtureProject();
  try {
    const res = spawnSync(process.execPath,
      [CLI_PATH, root, '--out', join(root, 'out', 'v.html'), '--no-metrics', '--metrics-cache', join(root, 'cache.json'), '--home', home],
      { encoding: 'utf8' });
    assert.equal(res.status, 2, `stderr: ${res.stderr}`);
    assert.match(res.stderr, /contradicts/);
    assert.ok(!existsSync(join(root, 'out')), 'no output written on the refused contradiction');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

rtest('CLI: a COLD-store render leaves the store byte-identical, including _lib absence — no flag needed, no mode exists', async () => {
  const { root, mem, home } = fixtureProject();
  try {
    assert.equal(existsSync(join(mem, '_lib')), false, 'fixture starts cold — no derived cache');
    const before = snapshotBytes(mem);
    const res = spawnSync(process.execPath,
      [CLI_PATH, root, '--out', join(root, 'out', 'v.html'), '--no-metrics', '--home', home],
      { encoding: 'utf8' });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.equal(existsSync(join(mem, '_lib')), false,
      'a cold first render must not materialize _memories/_lib');
    const after = snapshotBytes(mem);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
    for (const [rel, buf] of before) assert.ok(after.get(rel).equals(buf), `byte-identical: ${rel}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- the live-mode prose contract the recipes must keep ----------

const MEMORY_VIEW_SKILL = join(SCRIPTS, '..', '..', 'memory-view', 'SKILL.md');

test('live recipe: never pairs --no-metrics with --metrics-cache (the CLI refuses the pair; the recipe must not teach it)', () => {
  const live = readFileSync(MEMORY_VIEW_SKILL, 'utf8');
  const section = live.slice(live.indexOf('## Live mode'));
  assert.ok(section.length > 0, 'Live mode section exists');
  assert.doesNotMatch(section, /--no-metrics[\s\S]{0,120}--metrics-cache/,
    'the documented refresh command must carry the cache flag alone');
  assert.match(section, /--metrics-cache/, 'the cached health block is still part of the recipe');
});

test('live recipe: persists scope and exclusions in the loop-state record and re-applies them each refresh', () => {
  const live = readFileSync(MEMORY_VIEW_SKILL, 'utf8');
  const section = live.slice(live.indexOf('## Live mode'));
  assert.match(section, /persist[^.\n]*(scope|excluded)|same[^.\n]*scope/i);
  assert.match(section, /--scope|excluded_topics/);
  assert.match(section, /memory-view-live\.json/, 'the record has one named home under the workspace');
  assert.match(section, /--write-live-state/, 'the record is written through the atomic CLI door');
  assert.match(section, /--live-state/, 'the watcher arms from the record');
  assert.match(section, /retry_at|--retry-at/, 'budget deferral persists its retry moment');
  assert.match(section, /run_in_background|background task/, 'the wake door is the harness background-task exit');
  assert.match(section, /can outlive a dead session/,
    'teardown honesty: the orphan possibility is stated, not papered over with an unproven guarantee');
  assert.match(section, /"event":"orphaned"|orphaned/, 'the orphan self-check door is documented');
  assert.match(section, /grant_basis|--grant-basis/, 'the standing grant is persisted in the record');
  assert.match(section, /future republishes/i, 'the grant is prospective and bounded');
  assert.match(section, /stop live mode before sensitive or third-party content/i,
    'the stop-before-the-boundary rule is stated');
});

test('CLI: rejects an unknown --scope', () => {
  const { root, home } = fixtureProject();
  try {
    const res = spawnSync(process.execPath,
      [CLI_PATH, root, '--out', join(root, 'out', 'v.html'), '--scope', 'everything', '--no-metrics', '--home', home],
      { encoding: 'utf8' });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /unknown --scope/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- producer identity (condition 6 — truthfulness falsifier) ----------

test('falsifier: in a CLEAN git checkout the emitted source SHA equals git rev-parse HEAD and never the manifest stamp; a DIRTY tree fails closed (fix 9)', async (t) => {
  let head;
  try {
    head = execFileSync('git', ['-C', SCRIPTS, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    t.skip('not running from a git checkout — falsifier only applies to source checkouts');
    return;
  }
  const identity = producerIdentity();
  const manifestSha = JSON.parse(
    readFileSync(join(SCRIPTS, '..', '..', '..', '.claude-plugin', 'plugin.json'), 'utf8')).source_sha;
  if (!TREE_CLEAN) {
    // Fix 9: a dirty plugin tree must fail closed — no clean HEAD stamp, and NOT
    // a silent fallback to the release-stamped manifest value.
    assert.equal(identity.source_sha, null, 'dirty tree ⇒ no source_sha');
    assert.equal(identity.source_sha_from, null);
    return;
  }
  assert.equal(identity.source_sha, head, 'emitted source SHA is the REAL current tree HEAD');
  assert.equal(identity.source_sha_from, 'git');
  if (manifestSha && manifestSha !== head) {
    assert.notEqual(identity.source_sha, manifestSha,
      'must not silently fall back to the older release-stamped manifest value');
  }
  // …and the rendered page + manifest carry the real SHA, not the stamp.
  const { root, home } = fixtureProject();
  try {
    const { html, manifest } = await generate(root, home);
    assert.equal(manifest.producer.source_sha, head);
    assert.ok(html.includes(head.slice(0, 12)), 'banner carries the real tree SHA');
    if (manifestSha && manifestSha !== head) {
      assert.ok(!html.includes(manifestSha.slice(0, 12)), 'stale stamped SHA absent from the page');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('installed tree (no .git): stamped manifest identity used; no SHA at all: fail closed, nothing rendered', async () => {
  // Copy the whole plugin tree (plugins/core) outside any git repo — tmpdir.
  const pluginCopy = mkdtempSync(join(tmpdir(), 'browse-plugin-copy-'));
  const { root, home } = fixtureProject();
  const cli = join(pluginCopy, 'skills', 'core', 'scripts', 'render-browse-artifact.mjs');
  const manifestPath = join(pluginCopy, '.claude-plugin', 'plugin.json');
  try {
    cpSync(join(SCRIPTS, '..', '..', '..'), pluginCopy, { recursive: true });
    // Phase 1: manifest carries source_sha → manifest identity, honestly labeled.
    const out1 = join(root, 'out', 'installed.html');
    const res1 = spawnSync(process.execPath, [cli, root, '--out', out1, '--no-metrics', '--home', home],
      { encoding: 'utf8' });
    assert.equal(res1.status, 0, res1.stderr);
    const m1 = JSON.parse(res1.stdout);
    const stamped = JSON.parse(readFileSync(manifestPath, 'utf8')).source_sha;
    assert.ok(stamped, 'fixture precondition: plugin.json carries a stamped source_sha');
    assert.equal(m1.producer.source_sha, stamped, 'installed tree uses the stamped manifest identity');
    assert.equal(m1.producer.source_sha_from, 'manifest');
    assert.ok(readFileSync(out1, 'utf8').includes(stamped.slice(0, 12)));
    // Phase 2: strip the stamp → neither git nor manifest → fail closed.
    const pj = JSON.parse(readFileSync(manifestPath, 'utf8'));
    delete pj.source_sha;
    writeFileSync(manifestPath, JSON.stringify(pj, null, 2));
    const out2 = join(root, 'out', 'no-identity.html');
    const res2 = spawnSync(process.execPath, [cli, root, '--out', out2, '--no-metrics', '--home', home],
      { encoding: 'utf8' });
    assert.notEqual(res2.status, 0, 'nonzero exit when no SHA can be established');
    assert.match(res2.stderr, /cannot establish producer identity/);
    assert.ok(!existsSync(out2), 'no page written');
    assert.equal(res2.stdout.trim(), '', 'no manifest printed');
    assert.doesNotMatch(res2.stdout + res2.stderr, /unknown-sha/, 'no unknown-sha render');
  } finally {
    rmSync(pluginCopy, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------- post-publish receipt ----------

rtest('--record-publish published-private: atomic linked receipt with consent + privacy evidence', async () => {
  const { root, home } = fixtureProject();
  try {
    const { manifest } = await generate(root, home);
    const genPath = manifest.receipt_path;
    const args = [CLI_PATH, '--record-publish',
      '--generation-receipt', genPath, '--status', 'published-private',
      '--artifact-url', 'https://claude.ai/code/artifact/test-0000',
      '--private-verified-evidence', 'gallery shows private; share menu never opened',
      '--consent-by', 'the-project-owner', '--consent-mechanism', 'explicit yes on the rendered preflight manifest'];
    const res = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.publish_receipt_path, publishReceiptPathFor(genPath));
    assert.ok(out.publish_receipt_path.endsWith('.publish.json'), 'lands beside the generation receipt');
    const receipt = JSON.parse(readFileSync(out.publish_receipt_path, 'utf8'));
    assert.equal(receipt.kind, 'core-memory-browse-publish');
    assert.equal(receipt.generation_receipt, basename(genPath), 'linked to the generation receipt by name');
    assert.equal(receipt.publish_status, 'published-private');
    assert.ok(receipt.published_at, 'published_at set');
    assert.equal(receipt.artifact_url, 'https://claude.ai/code/artifact/test-0000');
    assert.equal(receipt.private_verified.evidence, 'gallery shows private; share menu never opened');
    assert.ok(receipt.private_verified.at);
    assert.equal(receipt.consent.granted_by, 'the-project-owner');
    assert.equal(receipt.revoked_at, null);
    // Atomic write leaves no temp residue beside the receipts.
    assert.ok(!readdirSync(dirname(genPath)).some((f) => f.includes('.tmp-')), 'no temp files left behind');
    // One outcome per generation: a second record is refused.
    const res2 = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(res2.status, 2);
    assert.match(res2.stderr, /already exists/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

rtest('--record-publish declined and failed leave records too; published_at and verification stay null', async () => {
  const { root, home } = fixtureProject();
  try {
    const gen1 = (await generate(root, home, { now: () => new Date('2026-07-22T01:00:00.000Z') })).manifest.receipt_path;
    const gen2 = (await generate(root, home, { now: () => new Date('2026-07-22T02:00:00.000Z') })).manifest.receipt_path;
    for (const [genPath, status] of [[gen1, 'declined'], [gen2, 'failed']]) {
      const res = spawnSync(process.execPath, [CLI_PATH, '--record-publish',
        '--generation-receipt', genPath, '--status', status], { encoding: 'utf8' });
      assert.equal(res.status, 0, res.stderr);
      const receipt = JSON.parse(readFileSync(publishReceiptPathFor(genPath), 'utf8'));
      assert.equal(receipt.publish_status, status);
      assert.equal(receipt.published_at, null, `${status}: nothing went up`);
      assert.equal(receipt.private_verified, null);
      assert.equal(receipt.artifact_url, null);
      assert.ok(receipt.recorded_at, 'the decision itself is timestamped');
      assert.equal(receipt.generation_receipt, basename(genPath));
      assert.equal(receipt.revoked_at, null);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

rtest('--record-publish refusals: missing evidence for published-private, bad status, bad generation receipt', async () => {
  const { root, home } = fixtureProject();
  try {
    const { manifest } = await generate(root, home);
    const genPath = manifest.receipt_path;
    const noEvidence = spawnSync(process.execPath, [CLI_PATH, '--record-publish',
      '--generation-receipt', genPath, '--status', 'published-private'], { encoding: 'utf8' });
    assert.equal(noEvidence.status, 2);
    assert.match(noEvidence.stderr, /private-verified-evidence/);
    assert.ok(!existsSync(publishReceiptPathFor(genPath)), 'refusal writes nothing');
    const badStatus = spawnSync(process.execPath, [CLI_PATH, '--record-publish',
      '--generation-receipt', genPath, '--status', 'published'], { encoding: 'utf8' });
    assert.equal(badStatus.status, 2);
    assert.match(badStatus.stderr, /--status must be one of/);
    const badGen = spawnSync(process.execPath, [CLI_PATH, '--record-publish',
      '--generation-receipt', join(root, 'nope.json'), '--status', 'declined'], { encoding: 'utf8' });
    assert.equal(badGen.status, 2);
    assert.match(badGen.stderr, /cannot read generation receipt/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('--record-revocation stamps revoked_at and preserves a manually-authored receipt (extra fields intact)', () => {
  // Fixture mirrors the shape of the real hand-written first publish receipt
  // (2026-07-22T22-41-34-360Z.publish.json) including its extra fields —
  // schema compatibility means the manual record stays a valid citizen.
  const dir = mkdtempSync(join(tmpdir(), 'browse-revoke-'));
  const p = join(dir, '2026-07-22T22-41-34-360Z.publish.json');
  try {
    writeFileSync(p, JSON.stringify({
      kind: 'core-memory-browse-publish',
      schema_version: '1.0.0',
      generation_receipt: '2026-07-22T22-41-34-360Z.json',
      publish_status: 'published-private',
      published_at: '2026-07-22T22:47:00Z',
      artifact_url: 'https://claude.ai/code/artifact/614ae328-0cb8-4c4a-95fe-d4a798f21a00',
      consent: { granted_by: 'the-project-owner', granted_at: '2026-07-22T22:46:00Z', mechanism: 'explicit yes on the rendered preflight manifest' },
      private_verified: { at: '2026-07-22T22:47:00Z', evidence: 'publish tool confirms artifacts are private unless shared' },
      known_defect_at_publish: 'stale producer sha at publish time',
      revoked_at: null,
      note: 'manually authored by the operator',
    }, null, 2));
    const res = spawnSync(process.execPath, [CLI_PATH, '--record-revocation', p], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    const receipt = JSON.parse(readFileSync(p, 'utf8'));
    assert.ok(receipt.revoked_at, 'revoked_at stamped');
    assert.equal(receipt.known_defect_at_publish, 'stale producer sha at publish time', 'manual extra field preserved');
    assert.equal(receipt.note, 'manually authored by the operator');
    assert.equal(receipt.publish_status, 'published-private', 'original outcome untouched');
    // Double revocation is refused.
    const res2 = spawnSync(process.execPath, [CLI_PATH, '--record-revocation', p], { encoding: 'utf8' });
    assert.equal(res2.status, 2);
    assert.match(res2.stderr, /already revoked/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- graph interaction (pointer-capture click regression guard) ----------

rtest('node selection survives pointer capture: pointerup-threshold path present, dead svg click binding gone', async () => {
  const { root, home } = fixtureProject();
  try {
    const { html } = await generate(root, home);
    // Pointer capture retargets derived click events to the SVG root, so an
    // svg 'click' selection binding can never see the circle — it must not exist.
    assert.ok(!html.includes("svg.addEventListener('click'"), 'no svg click-selection binding');
    // Selection now rides pointerup with a small movement threshold, using
    // the ORIGINAL pointerdown target.
    assert.match(html, /dragging\.moved < 5/, 'movement threshold present');
    assert.match(html, /dragging\.target/, 'original pointerdown target used for selection');
    assert.match(html, /closest\('circle\[data-unit\]'\)/, 'circle lookup still present');
    // The list pane keeps its plain container click binding (no capture there).
    assert.ok(html.includes("listEl.addEventListener('click'"), 'list pane click binding intact');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

rtest('CLI: stdout is exactly one JSON manifest with the stable shape', () => {
  const { root, home } = fixtureProject();
  try {
    const out = join(root, 'out', 'v.html');
    const res = spawnSync(process.execPath,
      [CLI_PATH, root, '--out', out, '--no-metrics', '--home', home, '--exclude-topic', 'beta'],
      { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    const manifest = JSON.parse(res.stdout);
    for (const key of ['kind', 'schema_version', 'generated_at', 'producer', 'project', 'workspace_id',
      'snapshot_id', 'scope', 'unit_count', 'active_count', 'supplemental_count',
      'excluded_by_topic_count', 'total_bytes', 'metrics_included', 'out_path',
      'receipt_path', 'receipt_fallback', 'sensitivity_warning']) {
      assert.ok(key in manifest, `manifest key ${key}`);
    }
    assert.equal(manifest.metrics_included, false, '--no-metrics reflected honestly');
    assert.equal(manifest.excluded_by_topic_count, 1);
    assert.equal(manifest.unit_count, 2);
    assert.ok(existsSync(out));
    const html = readFileSync(out, 'utf8');
    assert.match(html, /metrics were not gathered/i, 'page carries the honest metrics-absence line');
    assert.ok(existsSync(manifest.receipt_path), 'receipt written by the CLI run');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const { generationReceiptLocation } = await import(pathToFileURL(join(SCRIPTS, 'artifact-receipts.mjs')).href);

test('a project-controlled workspace id cannot redirect the receipt out of the operational root', () => {
  const home = mkdtempSync(join(tmpdir(), 'receipt-home-'));
  const project = mkdtempSync(join(tmpdir(), 'receipt-project-'));
  const attempt = ['..', '..', '..', 'tmp', 'stolen'].join('/');
  writeFileSync(join(project, 'workspace.json'), JSON.stringify({ workspace_id: attempt }));

  const loc = generationReceiptLocation({ home, projectDir: project, generatedAt: '2026-07-28T00:00:00Z' });
  assert.equal(loc.workspaceId, null, 'a traversal id is not a workspace id');
  assert.equal(loc.receiptDir, join(home, '.core', 'artifact-receipts'),
    'it falls back to the flagged location, never to a project-chosen path');
  assert.ok(loc.receiptPath.startsWith(join(home, '.core') + sep), 'and the receipt stays under the operational root');

  writeFileSync(join(project, 'workspace.json'), JSON.stringify({ workspace_id: 'legit-id' }));
  const ok = generationReceiptLocation({ home, projectDir: project, generatedAt: '2026-07-28T00:00:00Z' });
  assert.equal(ok.workspaceId, 'legit-id');
  assert.equal(ok.receiptDir, join(home, '.core', 'workspaces', 'legit-id', 'artifact-receipts'));

  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

// ============================================================
// Artifact + receipt as one transaction; canonical output containment;
// structural loss disclosed rather than absorbed.
// ============================================================

const { publishArtifactWithReceipt, resolveArtifactDestination, artifactContentDigest } =
  await import(pathToFileURL(join(SCRIPTS, 'artifact-receipts.mjs')).href);

function publishFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'publish-tx-'));
  const outPath = join(dir, 'out', 'page.html');
  const receiptDir = join(dir, 'receipts');
  const html = '<h1>page</h1>';
  const manifest = { kind: 'core-memory-browse-preflight', artifact_sha256: artifactContentDigest(html) };
  return { dir, outPath, receiptDir, receiptPath: join(receiptDir, 'r.json'), html, manifest };
}

test('a mutation between the artifact write and the receipt aborts publication', () => {
  const f = publishFixture();
  assert.throws(
    () => publishArtifactWithReceipt({
      ...f,
      // Something else replaces the destination inside the window the
      // verification exists to close.
      afterWrite: (p) => writeFileSync(p, '<h1>not the page you rendered</h1>'),
    }),
    (e) => e.code === 'ARTIFACT_MUTATED',
    'a receipt must never describe bytes other than the ones that were rendered',
  );
  assert.equal(existsSync(f.outPath), false, 'and the mutated artifact is not left behind to be published');
  assert.equal(existsSync(f.receiptPath), false, 'no receipt is written for content that failed verification');
  rmSync(f.dir, { recursive: true, force: true });
});

test('an unwritable receipt location takes the artifact with it', () => {
  const f = publishFixture();
  writeFileSync(f.receiptDir, 'a file where the receipt directory should be');
  assert.throws(
    () => publishArtifactWithReceipt(f),
    (e) => e.code === 'RECEIPT_PREFLIGHT_FAILED',
    'the receipt location is proven before the artifact lands',
  );
  assert.equal(existsSync(f.outPath), false, 'nothing publishable is left without an audit trail');
  rmSync(f.dir, { recursive: true, force: true });
});

test('the happy path writes both and binds the receipt to the exact bytes', () => {
  const f = publishFixture();
  const r = publishArtifactWithReceipt(f);
  assert.equal(readFileSync(f.outPath, 'utf8'), f.html);
  assert.equal(JSON.parse(readFileSync(f.receiptPath, 'utf8')).artifact_sha256, r.artifact_sha256);
  assert.equal(r.artifact_sha256, artifactContentDigest(f.html));
  rmSync(f.dir, { recursive: true, force: true });
});

test('output containment is judged on the real path, not the spelling', () => {
  const dir = mkdtempSync(join(tmpdir(), 'out-contain-'));
  const store = join(dir, 'project', '_memories');
  mkdirSync(store, { recursive: true });
  const outside = join(dir, 'elsewhere');
  mkdirSync(outside, { recursive: true });

  // A lexical check on this spelling sees a path outside the store; the link
  // resolves into it.
  const linked = join(outside, 'looks-fine.html');
  try { symlinkSync(join(store, 'stolen.html'), linked); }
  catch { rmSync(dir, { recursive: true, force: true }); return; }

  assert.throws(() => resolveArtifactDestination(linked, { forbiddenRoot: store }),
    (e) => e.code === 'OUT_IS_SYMLINK', 'an artifact is written to a real path, never through a link');

  const linkedDir = join(outside, 'shortcut');
  symlinkSync(store, linkedDir);
  assert.throws(() => resolveArtifactDestination(join(linkedDir, 'page.html'), { forbiddenRoot: store }),
    (e) => e.code === 'OUT_IN_STORE', 'a linked PARENT resolves into the store and is refused there');

  assert.equal(resolveArtifactDestination(join(outside, 'real.html'), { forbiddenRoot: store }),
    join(realpathSync(outside), 'real.html'), 'an ordinary destination outside the store is fine, canonicalized');
  rmSync(dir, { recursive: true, force: true });
});

test('a truncated unit is named as unreadable, never embedded as a blank one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'structural-loss-'));
  const mem = join(dir, '_memories');
  mkdirSync(join(mem, 'archive'), { recursive: true });
  writeFileSync(join(mem, 'good.md'),
    '---\nid: good\ntype: decision\nstatus: active\ncreated: 2026-07-01\nupdated: 2026-07-01\n---\n\nA readable unit.\n');
  // Opening fence, no closing one — the lenient parser would hand back empty
  // metadata and let the archive path invent an id and a status for it.
  writeFileSync(join(mem, 'archive', 'truncated.md'), '---\nid: truncated\ntype: decision\nstatus: retired\n');

  const collected = collectUnits(dir, { scope: 'all-including-archive' });
  assert.equal(collected.unreadable.length, 1, 'the damaged file is counted');
  assert.equal(collected.unreadable[0].path, 'archive/truncated.md');
  assert.match(collected.unreadable[0].reason, /never closed/);
  assert.equal(collected.units.some((u) => u.id === 'truncated'), false,
    'and it is not embedded as an apparently valid empty unit');
  rmSync(dir, { recursive: true, force: true });
});

// ============================================================
// Obsidian-grade browse experience — local/focus graph, properties panel,
// interactive filters, edge-type styling. Chrome-safety (zero external refs)
// and the pointer-capture selection contract are already covered above;
// these assert the new behavior actually shipped, not just that nothing broke.
// ============================================================

test('collectUnits carries every frontmatter field as properties — not just the curated badge subset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'properties-'));
  const mem = join(dir, '_memories');
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, 'dc-1-props.md'),
    '---\nid: dc-1-props\ntype: decision\nstatus: active\nupdated: 2026-07-01\ncustom_field: a value only in frontmatter\n---\n\nBody.\n');
  const collected = collectUnits(dir);
  const u = collected.units.find((x) => x.id === 'dc-1-props');
  assert.ok(u.properties, 'properties field present');
  assert.equal(u.properties.custom_field, 'a value only in frontmatter',
    'a field with no dedicated badge/column still reaches the page via properties');
  assert.equal(u.properties.id, 'dc-1-props');
  rmSync(dir, { recursive: true, force: true });
});

// The v2 front-end tests below assert against the generated page's actual
// structure and data (the data island, the baked markup, the generated rule
// set) — not implementation spelling. They build the page through the
// exported buildArtifactHtml with a fixed meta, so they run on any tree
// (producer identity is not involved) and stay red-capable under mutation.

function buildFixturePage(root, metaOverrides = {}, collectOpts = {}) {
  const collected = collectUnits(root, collectOpts);
  const html = buildArtifactHtml({
    units: collected.units,
    meta: {
      projectName: 'fixture',
      generatedAt: '2026-07-30T12:00:00.000Z',
      producer: { plugin: 'core', plugin_version: '0.0.0', source_sha: 'f'.repeat(40) },
      snapshotId: collected.snapshotId,
      scopeDesc: 'scope: active',
      unitCount: collected.units.length,
      metrics: { available: false, reason: 'stubbed for this UI test' },
      ...metaOverrides,
    },
  });
  return { html, collected };
}

// ---------- precomputed layout (v2: build-time, deterministic) ----------

test('layout determinism: two separate render processes produce byte-identical coordinate blocks, one 0.1px-rounded pair per unit', () => {
  const { root } = fixtureProject();
  try {
    const script = [
      `const m = await import(${JSON.stringify(pathToFileURL(CLI_PATH).href)});`,
      `const c = m.collectUnits(${JSON.stringify(root)});`,
      'const g = m.computeGraph(c.units);',
      'process.stdout.write(JSON.stringify(m.layoutForceGrid(c.units, g.edges, g.deg)));',
    ].join('\n');
    const run = () => spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    const a = run(), b = run();
    assert.equal(a.status, 0, a.stderr);
    assert.equal(b.status, 0, b.stderr);
    assert.ok(a.stdout.length > 2, 'coordinate block is non-empty');
    assert.equal(a.stdout, b.stdout, 'two renders of the same store: byte-identical coordinates');
    const layout = JSON.parse(a.stdout);
    const ids = collectUnits(root).units.map((u) => u.id).sort();
    assert.deepEqual(Object.keys(layout).sort(), ids, 'every unit has coordinates');
    for (const [id, xy] of Object.entries(layout)) {
      assert.equal(xy.length, 2, `${id}: [x, y]`);
      for (const v of xy) {
        assert.equal(Math.round(v * 10), v * 10, `${id}: coordinate ${v} rounded to 0.1px`);
      }
    }
    // …and the shipped page embeds exactly these coordinates in its island.
    const { html } = buildFixturePage(root);
    const { json } = extractDataBlock(html);
    assert.deepEqual(json.layout, layout, 'page data island carries the same precomputed layout');
    assert.ok(!html.includes('function layoutForce('), 'no in-page force simulation shipped');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- local subgraph default (DOI-ranked, capped, global reachable) ----------

test('the shipped default view is the DOI local subgraph of the most-recently-updated unit, capped at 40, with global one visible click away', () => {
  const { root } = fixtureProject();
  try {
    const { html } = buildFixturePage(root);
    const { json } = extractDataBlock(html);
    // obs-2-beta carries the latest `updated` in the fixture.
    assert.ok(json.defaultFocus, 'default focus shipped in the data island');
    assert.equal(json.defaultFocus.id, 'obs-2-beta', 'centered on the most-recently-updated unit');
    assert.ok(json.defaultFocus.ids.includes('obs-2-beta'), 'center is in its own neighborhood');
    assert.ok(json.defaultFocus.ids.length <= 40, 'neighborhood capped at 40');
    const unitIds = new Set(json.units.map((u) => u.id));
    for (const id of json.defaultFocus.ids) assert.ok(unitIds.has(id), `neighborhood id ${id} is a real unit`);
    // The static markup opens in focus mode; Global stays one click away.
    assert.match(html, /data-mode="focus" class="on" aria-pressed="true"/, 'focus is the shipped default mode');
    assert.doesNotMatch(html, /<button type="button" data-mode="focus"[^>]*disabled/, 'focus control is live at open');
    assert.match(html, /data-mode="global" aria-pressed="false"/, 'global mode present, one click away');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('DOI ranking caps a hub neighborhood at exactly 40 where a plain 1-hop ball would exceed it', () => {
  const units = [{ id: 'hub', type: 'topic', status: 'active', updated: '2026-07-09', edges: [], topics: [] }];
  for (let i = 0; i < 60; i++) {
    units.push({
      id: `leaf-${String(i).padStart(2, '0')}`, type: 'observation', status: 'active', updated: '',
      edges: [{ type: 'cites', target: 'hub' }], topics: [],
    });
  }
  const { edges, deg } = computeGraph(units);
  const focus = computeDefaultFocus(units, edges, deg);
  assert.equal(focus.id, 'hub', 'most-recently-updated unit is the center');
  assert.equal(focus.ids.length, 40, 'a 60-neighbor hub is ranked down to the 40 cap');
  assert.equal(focus.ids[0], 'hub', 'the center ranks first (hop 0)');
});

// ---------- ghost context: fade, never hide ----------

test('focus dims the rest of the store as ghost context — opacity fade at global positions, never removal', () => {
  const { root } = fixtureProject();
  try {
    const { html } = buildFixturePage(root);
    const { raw } = extractDataBlock(html);
    const chrome = html.replace(raw, '');
    const dimRule = chrome.match(/\.node\.dim[^{]*\{([^}]*)\}/);
    assert.ok(dimRule, 'a dim rule exists for out-of-neighborhood nodes');
    assert.match(dimRule[1], /opacity/, 'ghost context fades via opacity (GPU path)');
    assert.doesNotMatch(dimRule[1], /display\s*:\s*none/, 'ghost context is never display:none — fade, not hide');
    assert.match(chrome, /classList\.toggle\('dim'/, 'dimming is a class toggle, not a rebuild');
    // Ghost nodes keep their global positions: there is exactly ONE position
    // source in the client — the precomputed layout from the data island.
    assert.match(chrome, /DATA\.layout/, 'the island layout is the position source');
    assert.ok(!chrome.includes('function layoutForce('), 'no second layout to move ghosts elsewhere');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- class-toggle filters (fixed rule set, no rebuild) ----------

test('filter chips are baked with pressed state and hide through a small fixed class rule set — one rule per type + one per status', () => {
  const { root } = fixtureProject();
  try {
    const { html, collected } = buildFixturePage(root);
    const { raw } = extractDataBlock(html);
    const chrome = html.replace(raw, '');
    const types = [...new Set(collected.units.map((u) => u.type || 'untyped'))].sort();
    const statuses = [...new Set(collected.units.map((u) => u.status || 'active'))].sort();
    for (const t of types) {
      assert.match(chrome, new RegExp(`<button type="button" class="chip" aria-pressed="true" data-type="${t}"`),
        `a baked chip exists for type ${t}`);
    }
    for (const s of statuses) {
      assert.match(chrome, new RegExp(`data-status="${s}"`), `a baked chip exists for status ${s}`);
    }
    // The rule set is CLASSES on the container — exactly one hide rule per
    // type + one per status, nothing per-node, no attribute selectors, no :has().
    const hideRules = chrome.match(/#graph\.hide-\S+ \.\S+ \{ display: none; \}/g) || [];
    assert.equal(hideRules.length, types.length + statuses.length,
      'the hide rule set is exactly one class rule per type + one per status');
    assert.doesNotMatch(chrome, /#graph[^{]*\[data-/, 'no attribute-selector hide rules');
    assert.doesNotMatch(chrome, /#graph[^{}]*:has\(/, 'no :has() selector anchored on the container');
    assert.match(chrome, /svg\.classList\.toggle\('hide-' \+/, 'chips toggle one container class');
    assert.match(chrome, /setAttribute\('aria-pressed', String\(/, 'chips expose pressed-state changes');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the graph and list DOM are built exactly once — filters and mode changes toggle classes, markup is never rebuilt', () => {
  const { root } = fixtureProject();
  try {
    const { html } = buildFixturePage(root);
    const { raw } = extractDataBlock(html);
    const chrome = html.replace(raw, '');
    assert.equal((chrome.match(/svg\.innerHTML/g) || []).length, 1,
      'exactly one svg.innerHTML assignment: the one-time build');
    assert.equal((chrome.match(/listEl\.innerHTML/g) || []).length, 1,
      'exactly one listEl.innerHTML assignment: the one-time build');
    assert.equal((chrome.match(/buildGraph\(\);/g) || []).length, 1,
      'the graph build runs once, at init — never from a filter or mode handler');
    // The list filter debounces keystrokes and toggles a hidden class per row.
    assert.match(chrome, /setTimeout\(function \(\) \{ applyListFilter\(filterEl\.value\); \}, 100\)/,
      'list filter debounced at 100ms');
    assert.match(chrome, /r\.el\.classList\.toggle\('hidden'/, 'rows hide via class, not re-serialization');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- responsive + long-list rendering ----------

test('responsive chrome keeps the mobile browse loop reachable; long lists render lazily via content-visibility', () => {
  const { root } = fixtureProject();
  try {
    const { html } = buildFixturePage(root);
    const { raw } = extractDataBlock(html);
    const chrome = html.replace(raw, '');
    assert.match(chrome, /\.edge-legend svg\s*\{[^}]*min-height:\s*0/s,
      'edge legend SVGs must override the graph SVG minimum height');
    assert.match(chrome, /@media \(max-width: 860px\)[\s\S]*?\.sidebar\s*\{[^}]*max-height:\s*52vh !important/,
      'the mobile unit list stays bounded instead of expanding every unit before the graph');
    assert.match(chrome, /footer\s*\{[^}]*overflow-wrap:\s*anywhere/s,
      'the snapshot id cannot force horizontal overflow');
    const rowRule = chrome.match(/\.sidebar li\.row \{[^}]*\}/s);
    assert.ok(rowRule, 'row rule present');
    assert.match(rowRule[0], /content-visibility:\s*auto/, 'off-screen rows skip rendering');
    assert.match(rowRule[0], /contain-intrinsic-size:/, 'skipped rows keep an intrinsic size (honest scrollbar)');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- age badge (staleness honesty: age, never staleness) ----------

test('age badge: ISO datetime baked at build, relative age via Intl on visibilitychange, negative clamp, lastModified banned', () => {
  const { root } = fixtureProject();
  try {
    const { html } = buildFixturePage(root);
    assert.ok(html.includes('<time id="gen-time" datetime="2026-07-30T12:00:00.000Z">'),
      'the time element carries the exact build stamp as machine-readable datetime');
    const { raw } = extractDataBlock(html);
    const chrome = html.replace(raw, '');
    assert.match(chrome, /Intl\.RelativeTimeFormat/, 'relative age renders viewer-local with zero dependencies');
    assert.match(chrome, /visibilitychange/, 'age recomputes when a backgrounded tab refocuses');
    assert.match(chrome, /reload for the latest/, 'graduated copy past 24h names the action');
    assert.match(chrome, /generated just now/, 'negative clock-skew deltas clamp to "just now"');
    // The eternally-fresh trap: the spec makes the document's lastModified
    // return the CURRENT time when unknown. It must be named (banned in a
    // comment) and never read.
    assert.match(chrome, /lastModified/, 'the ban on lastModified is written down where the age code lives');
    assert.doesNotMatch(chrome, /document\.lastModified/, 'lastModified is never actually read');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- metrics decoupling (--metrics-cache) ----------

test('metrics cache: a live run writes the cache; a present cache is embedded verbatim with its own stamp and the provider never runs', async () => {
  const { root } = fixtureProject();
  try {
    const cachePath = join(root, 'ops', 'metrics-cache.json');
    const live = async () => ({ report: 'LIVE REPORT ALPHA — planted by the test', mechanics: { status: 'WORKING' } });
    const first = await resolveMetricsForRender(root, {
      metricsProvider: live, metricsCachePath: cachePath, generatedAt: '2026-07-30T10:00:00.000Z',
    });
    assert.equal(first.available, true);
    assert.equal(first.cached, false, 'no cache yet: the live provider ran');
    const written = JSON.parse(readFileSync(cachePath, 'utf8'));
    assert.equal(written.report, 'LIVE REPORT ALPHA — planted by the test', 'live block written to the cache');
    assert.equal(written.generated_at, '2026-07-30T10:00:00.000Z', 'cache carries its own timestamp');
    // Second run: cache present ⇒ embedded verbatim, provider must not run.
    const second = await resolveMetricsForRender(root, {
      metricsProvider: async () => { throw new Error('live metrics must not run when the cache exists'); },
      metricsCachePath: cachePath, generatedAt: '2026-07-30T11:00:00.000Z',
    });
    assert.equal(second.available, true);
    assert.equal(second.cached, true);
    assert.equal(second.report, 'LIVE REPORT ALPHA — planted by the test', 'cached block verbatim');
    assert.equal(second.as_of, '2026-07-30T10:00:00.000Z', 'labeled with the CACHE timestamp, not this run');
    // The page labels a carried-forward block with the cache's own stamp.
    const { html } = buildFixturePage(root, { metrics: second });
    assert.ok(html.includes('LIVE REPORT ALPHA'), 'cached report embedded');
    assert.match(html, /Metrics as of 2026-07-30T10:00:00\.000Z/, 'the "metrics as of" label carries the cache stamp');
    // --no-metrics wins over the cache.
    const skipped = await resolveMetricsForRender(root, { metricsProvider: null, metricsCachePath: cachePath });
    assert.equal(skipped.available, false);
    assert.match(skipped.reason, /--no-metrics/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a --metrics-cache path inside _memories/ is refused — the store stays read-only', async () => {
  const { root, mem, home } = fixtureProject();
  try {
    await assert.rejects(
      () => renderBrowseArtifact(root, {
        outPath: join(root, 'out', 'view.html'), home, metricsProvider: stubMetrics,
        metricsCachePath: join(mem, 'cache.json'),
      }),
      (e) => e.code === 'CACHE_IN_STORE');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

rtest('CLI: --metrics-cache with a pre-seeded cache embeds it, reports metrics_source cache, and never runs live metrics', () => {
  const { root, home } = fixtureProject();
  try {
    const cachePath = join(root, 'ops', 'metrics-cache.json');
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({
      kind: 'core-memory-metrics-cache',
      generated_at: '2026-07-29T00:00:00.000Z',
      report: 'CACHED REPORT BRAVO — seeded by the test',
      mechanics_status: 'WORKING',
    }, null, 2));
    const out = join(root, 'out', 'v.html');
    // No --no-metrics here: with the cache present, the live 2s proof must
    // not run — the fast completion IS the decoupling working.
    const res = spawnSync(process.execPath,
      [CLI_PATH, root, '--out', out, '--home', home, '--metrics-cache', cachePath],
      { encoding: 'utf8', timeout: 30000 });
    assert.equal(res.status, 0, res.stderr);
    const manifest = JSON.parse(res.stdout);
    assert.equal(manifest.metrics_included, true);
    assert.equal(manifest.metrics_source, 'cache');
    assert.equal(manifest.metrics_as_of, '2026-07-29T00:00:00.000Z');
    const html = readFileSync(out, 'utf8');
    assert.ok(html.includes('CACHED REPORT BRAVO'), 'cached block embedded by the CLI path');
    assert.match(html, /Metrics as of 2026-07-29T00:00:00\.000Z/, 'labeled with the cache stamp');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
