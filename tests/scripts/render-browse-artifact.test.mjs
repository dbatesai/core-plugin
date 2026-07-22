/**
 * render-browse-artifact — the memory-browse artifact generator.
 * Covers the disclosure-boundary guarantees the 2026-07-22 design spec makes
 * hard requirements (Hale's conditions 2/4/6/7 as enforced in code):
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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'scripts');
const {
  renderBrowseArtifact, collectUnits, buildArtifactHtml, SENSITIVITY_WARNING,
  BROWSE_MANIFEST_SCHEMA_VERSION,
} = await import(pathToFileURL(join(SCRIPTS, 'render-browse-artifact.mjs')).href);
const { loadSnapshot } = await import(pathToFileURL(join(SCRIPTS, 'generate-summary-index.mjs')).href);
const CLI_PATH = join(SCRIPTS, 'render-browse-artifact.mjs');

// Stub metrics provider: tests never run the live subprocess probe suite —
// the metrics object only needs the fields the page consumes.
const stubMetrics = async () => ({ report: 'STUB METRICS REPORT (four evidence classes)', mechanics: { status: 'WORKING' } });

function fixtureProject({ workspace = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'browse-artifact-'));
  const mem = join(root, '_memories');
  mkdirSync(join(mem, 'archive'), { recursive: true });
  writeFileSync(join(mem, 'dc-1-alpha.md'),
    `---\nid: dc-1-alpha\ntype: decision\nstatus: active\ntopics: [alpha, shared]\nupdated: 2026-07-01\nedges:\n  - type: cites\n    target: obs-2-beta\n  - type: supersedes\n    target: risk-3-retired\n---\n\n# DC-1 — Alpha decision\n\nBody citing an external source at https://example.com/spec for reference.\n\n- point one\n- point two\n`);
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

test('embeds active units with bodies, edges, and snapshot provenance header', async () => {
  const { root, home } = fixtureProject();
  try {
    const { manifest, html } = await generate(root, home);
    const { json } = extractDataBlock(html);
    const ids = json.units.map((u) => u.id).sort();
    assert.deepEqual(ids, ['dc-1-alpha', 'obs-2-beta', 'topic-4-secret']);
    const dc1 = json.units.find((u) => u.id === 'dc-1-alpha');
    assert.match(dc1.body, /external source at https:\/\/example\.com\/spec/, 'full body embedded');
    assert.deepEqual(dc1.edges.map((e) => e.target).sort(), ['obs-2-beta', 'risk-3-retired']);
    assert.equal(dc1.title, 'DC-1 — Alpha decision');
    // Provenance banner (condition 6 + Antigravity's aggressive-styling refinement)
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

test('generated chrome carries zero external references; unit-body URLs survive only as embedded data', async () => {
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

test('default scope excludes archived and retired units (same filtering as decoration)', async () => {
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

test('--scope all-including-archive embeds archived + retired units, marked non-active', async () => {
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

test('--exclude-topic removes matching units and counts them in the manifest', async () => {
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

test('preflight manifest matches the embedded content and the actual bytes on disk', async () => {
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

test('writes a local receipt under the workspace with content identical to the manifest', async () => {
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

test('no workspace.json → receipt still written to the flagged fallback location', async () => {
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

test('generation never writes to _memories/ — store byte-identical before and after', async () => {
  const { root, mem, home } = fixtureProject();
  try {
    // Warm the loader's derived cache first (its documented behavior on every
    // read path), so the comparison below covers EVERY byte including _lib.
    loadSnapshot(root, { captureBodies: true });
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

test('CLI: stdout is exactly one JSON manifest with the stable shape', () => {
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
