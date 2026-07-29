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
// A render-dependent test: runs only when the tree is clean (renderer needs a
// real SHA), otherwise skips with the fail-closed reason.
const rtest = (name, fn) => test(name, TREE_CLEAN ? {} : { skip: 'plugin tree dirty — renderer fails closed by design (fix 9); exercised on a clean tree' }, fn);

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
    assert.equal(dc1.title, 'DC-1 — Alpha decision');
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

rtest('generation never writes to _memories/ — store byte-identical before and after', async () => {
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
