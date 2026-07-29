/**
 * render-metrics-artifact — the /metrics artifact-page generator.
 * Covers:
 *   - page structure from the approved 2026-07-22 prototype: four
 *     plain-question sections, trust-tag legend, snapshot banner, both theme
 *     token blocks, reduced-motion-respecting gauges, hatched empty states;
 *   - plain-language guarantee: no bare metric jargon in the page chrome;
 *   - zero external references (same grep standard as the browse generator;
 *     this page additionally carries no <script> at all);
 *   - state variants: no-gold-set honesty, rejected-row explanation,
 *     calibrated-classifier wording, degraded machinery, no-store, absent
 *     telemetry/recognition;
 *   - CLI contract: --out required, --json-in replay path, manifest shape
 *     (content_class aggregates-only), generation receipt;
 *   - shared helpers: truthful provenance (artifact-provenance.mjs) and the
 *     generalized publish receipts (artifact-receipts.mjs) — with a
 *     self-contained snapshot identity copied into the
 *     publish receipt, and published-private refusing to record without a
 *     consent record (--consent-by + --consent-mechanism), for BOTH kinds.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'scripts');
const {
  renderMetricsArtifact, buildMetricsArtifactHtml, sanitizeForEmbed,
  METRICS_ARTIFACT_MANIFEST_SCHEMA_VERSION, METRICS_ARTIFACT_CONTENT_CLASS, METRICS_ARTIFACT_CONTENT_NOTE,
} = await import(pathToFileURL(join(SCRIPTS, 'render-metrics-artifact.mjs')).href);
const { truthfulProducerIdentity } = await import(pathToFileURL(join(SCRIPTS, 'artifact-provenance.mjs')).href);
const { publishReceiptPathFor, artifactContentDigest } = await import(pathToFileURL(join(SCRIPTS, 'artifact-receipts.mjs')).href);
const CLI_PATH = join(SCRIPTS, 'render-metrics-artifact.mjs');

// Fix 9 makes the shared provenance helper FAIL CLOSED on a dirty
// plugin tree — HEAD no longer names the executing bytes. So the real-render
// tests below only get a source_sha (and can render) when the tree is clean; on
// a dirty working tree the renderer correctly refuses. Detect the state once so
// the provenance-dependent tests assert the RIGHT contract either way.
function pluginTreeIsClean() {
  try {
    const out = execFileSync('git', ['-C', SCRIPTS, 'status', '--porcelain', '--',
      join(SCRIPTS, '..', '..', '..')], { encoding: 'utf8' });
    return out.trim().length === 0;
  } catch { return false; } // not a git checkout ⇒ no source_sha anyway
}
const TREE_CLEAN = pluginTreeIsClean();

// A valid hand-built generation receipt (full schema: kind, schema_version,
// generated_at, artifact_sha256) so receipt tests are independent of the
// renderer / tree state.
function writeGenerationReceipt(genPath, { kind = 'core-metrics-artifact-preflight', html = '<html>hi</html>', overrides = {} } = {}) {
  writeFileSync(genPath, JSON.stringify({
    kind,
    schema_version: '1.0.0',
    generated_at: '2026-07-23T00:00:00.000Z',
    artifact_sha256: artifactContentDigest(html),
    ...overrides,
  }));
  return artifactContentDigest(html);
}

// ---------------------------------------------------------------------------
// Canonical four-class fixture — the exact shape gatherMetrics()/--json emits.
// ---------------------------------------------------------------------------

function canonicalMetrics(mutate = () => {}) {
  const m = {
    schema_version: '1.0.0',
    producer: { script: 'metrics-check.mjs', plugin: 'core', plugin_version: '3.13.1', source_sha: 'd'.repeat(40) },
    generated_at: '2026-07-22T20:00:00.000Z',
    project: '/tmp/fixture-project',
    mechanics: {
      status: 'WORKING',
      probe: {
        validate: { pass: true, exit: 0 },
        retrieve: { pass: true, evidence: 'probe-live-fact' },
        suppress_retired: { pass: true, evidence: 'zero output (retired never indexed)' },
        round_trip: true,
      },
      store: {
        present: true,
        schema: { exit: 0, pass: 290, warn: 0, fail: 0 },
        integrity: { exit: 0, pass: 290, warn: 0, fail: 0 },
        warning_triage: { informational: 0, routine_upkeep: 0, attention: 0, attention_items: [] },
        census: { active: 285, retired: 1, archived: 0, superseded: 3, other: 1, total: 290 },
        retrieval_log: { files: 37, rows: 277 },
      },
      telemetry: {
        available: true, days: 37, retrievalEvents: 277,
        rejected: { current: { count: 0, by_code: {} }, legacy: { count: 0, by_code: {} }, other: { count: 0, by_code: {} }, total: 0 },
        t1Pct: 99, t2Pct: 1, t3Pct: 0,
        topEscalationTopic: 'agent-config', topEscalationRate: 100,
      },
    },
    regression: {
      gold: { available: true, n: 22, storeUnits: 290, context3_r3: 15 / 22, ranking_r10: 18 / 22, bm25_r10: 18 / 22 },
    },
    readiness: {
      recognition_signal: { text: 'rec-fail-tier-0: 3/6 turns today (50%) vs 7-day avg 21% ↑ [PROVISIONAL]', age_hours: 1 },
      calibration: { available: true, labeled_count: 0, min_needed: 100, is_calibrated: false, overall_precision: null, notes: '' },
    },
    caveats: [],
  };
  mutate(m);
  return m;
}

const PRODUCER = {
  script: 'render-metrics-artifact.mjs', plugin: 'core', plugin_version: '3.13.1',
  source_sha: 'a'.repeat(40), source_sha_from: 'git',
};

function page(mutate) {
  return buildMetricsArtifactHtml(canonicalMetrics(mutate), { projectName: 'fixture-project', producer: PRODUCER });
}

// The chrome = everything except the embedded raw-data <pre> (the one place
// machine field names legitimately appear, clearly labeled as machine data).
function chromeOf(html) {
  return html.replace(/<pre class="mono">[\s\S]*?<\/pre>/, '');
}

function fixtureProject({ workspace = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'metrics-artifact-'));
  if (workspace) writeFileSync(join(root, 'workspace.json'), JSON.stringify({ workspace_id: 'metrics-test-ws' }));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return { root, home };
}

// ---------- structure (the prototype is the spec) ----------

test('page carries the four plain-question sections, legend, banner, verdict, and both theme blocks', () => {
  const html = page();
  assert.match(html, /1 &middot; Does the machinery work\?/);
  assert.match(html, /2 &middot; How good is the memory search\?/);
  assert.match(html, /3 &middot; Can we trust CORE's self-measurements\?/);
  assert.doesNotMatch(html, /Does any of this actually help you\?/, 'benefit section removed per DC-129');
  assert.match(html, /How to read the colored tags on each line/);
  assert.match(html, /SNAPSHOT &mdash; DOES NOT UPDATE ITSELF/);
  assert.match(html, /Ask the agent to republish for fresh numbers\./);
  assert.match(html, /The storage machinery works\./, 'mechanics verdict, plainly scoped');
  assert.match(html, /Search quality and real usefulness are judged separately below\./);
  // Theme system: system preference + explicit override in both directions.
  assert.match(html, /@media \(prefers-color-scheme: dark\)/);
  assert.match(html, /:root\[data-theme="dark"\]/);
  assert.match(html, /:root\[data-theme="light"\]/);
  // Reduced motion respected: the only animation is opt-in via no-preference.
  assert.match(html, /@media \(prefers-reduced-motion:no-preference\)/);
  // Trust tags on rows.
  assert.match(html, /<span class="chip good">proven-live<\/span>/);
  assert.match(html, /<span class="chip prov">provisional<\/span>/);
});

test('gauges render from the data; empty states render hatched, never as a zero bar', () => {
  const html = page();
  // Quiz gauge: 15/22 = 68% accent bar.
  assert.match(html, /<i class="a" style="width:68%">/);
  // Round-trip pass: full good bar. Recognition estimate: 50% warn bar.
  assert.match(html, /<i class="g" style="width:100%">/);
  assert.match(html, /<i class="w" style="width:50%">/);
  // Hatched empty state: calibration at 0 labeled.
  assert.ok((html.match(/<div class="gauge empty"><\/div>/g) || []).length >= 1, 'hatched empty gauge present');
});

test('every number is explained in its sentence; no bare metric jargon in the chrome', () => {
  const chrome = chromeOf(page());
  // The prototype's explained renderings.
  assert.match(chrome, /15 of 22<\/span> quiz questions \(68%\)/);
  assert.match(chrome, /each with a known correct memory as its answer/);
  assert.match(chrome, /Widening to the top 10 results/);
  assert.match(chrome, /answered without checking its memory when it probably should have/);
  assert.match(chrome, /a human needs to hand-check 100 of its judgments/);
  assert.match(chrome, /answered by the fast first-pass search/);
  assert.match(chrome, /every record is well-formed — none were malformed or thrown out/);
  // Banned insider vocabulary (David's explicit plain-language correction).
  for (const banned of ['R@3', 'R@10', 'Recall', 'rec-fail', 'bm25', 'BM25', 'tier-0', 'Tier 2', 'gold set', 'gold-set', 'context3', 'calibration pool']) {
    assert.ok(!chrome.includes(banned), `chrome must not contain bare jargon '${banned}'`);
  }
});

test('zero external references; no JavaScript at all', () => {
  const html = page();
  assert.doesNotMatch(html, /https?:\/\//, 'no http(s) URL anywhere');
  assert.doesNotMatch(html, /<link[\s>]/i, 'no <link> elements');
  assert.doesNotMatch(html, /@import/i, 'no CSS imports');
  assert.doesNotMatch(html, /url\(/i, 'no CSS url() references');
  assert.doesNotMatch(html, /\bsrc\s*=/i, 'no src= attributes');
  assert.doesNotMatch(html, /fetch\s*\(/, 'no fetch calls');
  assert.doesNotMatch(html, /XMLHttpRequest|WebSocket|EventSource/, 'no network APIs');
  assert.doesNotMatch(html, /<script/i, 'static page — no script elements at all');
  assert.doesNotMatch(html, /@font-face/i, 'no font loading');
});

test('raw-data block embeds the canonical object minus report text and unit-id lists', () => {
  const metrics = canonicalMetrics((m) => {
    m.report = 'TERMINAL RENDER TEXT MUST NOT EMBED';
    m.mechanics.store.warning_triage.attention = 2;
    m.mechanics.store.warning_triage.attention_items = ['stale-edge: [dc-9-secret-unit-id]', 'bad-status: [obs-8-x]'];
    m.caveats = ['2 warning(s) need a look: stale-edge: [dc-9-secret-unit-id]'];
  });
  const clean = sanitizeForEmbed(metrics);
  assert.equal(clean.report, undefined, 'terminal report text omitted');
  assert.equal(clean.mechanics.store.warning_triage.attention_items, undefined, 'unit-id list omitted');
  assert.equal(clean.mechanics.store.warning_triage.attention_items_omitted, 2, 'count kept in its place');
  assert.ok(!JSON.stringify(clean).includes('dc-9-secret-unit-id'), 'no unit id survives into the embed');
  const html = buildMetricsArtifactHtml(metrics, { projectName: 'p', producer: PRODUCER });
  assert.ok(!html.includes('MUST NOT EMBED'));
  assert.ok(!html.includes('dc-9-secret-unit-id'));
  assert.match(html, /&quot;schema_version&quot;/, 'canonical object otherwise embedded');
});

// ---------- state variants ----------

test('no-gold-set project renders its honest-absence sentence with a hatched gauge', () => {
  const html = page((m) => {
    m.regression.gold = { available: false, reason: 'no _tests/retrieval-gold-set.json in this project — nothing exercises Recall@K here yet' };
  });
  assert.match(html, /Never measured for this project\./);
  assert.match(html, /doesn't have that answer key yet/);
  const chrome = chromeOf(html);
  assert.ok(!chrome.includes('Recall@K'), 'raw reason jargon never rendered for the absence state');
  const quizSection = html.split('2 &middot; How good is the memory search?')[1].split('<section>')[0];
  assert.match(quizSection, /gauge empty/, 'absence renders hatched, not a zero bar');
});

test('a failed quiz run says so plainly instead of pretending absence', () => {
  const html = page((m) => {
    m.regression.gold = { available: false, reason: 'gold-set harness run failed: ENOENT boom' };
  });
  assert.match(html, /The quiz could not be run this time\./);
  assert.match(html, /running it failed, so no measurement happened/);
});

test('nonzero rejected count renders its plain-language explanation', () => {
  const html = page((m) => {
    m.mechanics.telemetry.rejected = {
      current: { count: 1, by_code: { 'invalid-tier': 1 } },
      legacy: { count: 2, by_code: { 'missing-field': 2 } },
      other: { count: 0, by_code: {} }, total: 3,
    };
  });
  assert.match(html, /threw out <b class="num">3<\/b> records whose format was broken/);
  assert.match(html, /1 in the current record format, 2 in an older record format/);
  assert.match(html, /broken records are counted, never silently ignored/);
});

test('all-rejected telemetry is reported as broken record-keeping, not as absence', () => {
  const html = page((m) => {
    m.mechanics.telemetry = {
      available: false,
      reason: 'no VALID retrieval events recorded — 2 row(s) rejected (current-schema: invalid-tier: 2)',
      rejected: { current: { count: 2, by_code: { 'invalid-tier': 2 } }, legacy: { count: 0, by_code: {} }, other: { count: 0, by_code: {} }, total: 2 },
    };
  });
  assert.match(html, /Lookup records exist, but every one of them is broken\./);
  assert.match(html, /different from having no records at all/);
});

test('calibrated-classifier state renders the verified wording in BOTH readiness rows', () => {
  const html = page((m) => {
    m.readiness.calibration = { available: true, labeled_count: 120, min_needed: 100, is_calibrated: true, overall_precision: 0.874, notes: '' };
  });
  assert.match(html, /The grader has passed its verification: a human hand-checked <span class="num">120<\/span> of its judgments/);
  assert.match(html, /the human reviewer agreed with it <b class="num">87%<\/b> of the time/);
  assert.match(html, /has passed its human verification \(next line\), so the number carries real weight/);
  assert.ok(!html.includes('smoke alarm'), 'uncalibrated caveat gone once verified');
  assert.ok(!html.includes('stays officially unverified'), 'unverified wording gone once verified');
});

test('partial calibration pool renders progress with the unverified caveat intact', () => {
  const html = page((m) => {
    m.readiness.calibration = { available: true, labeled_count: 22, min_needed: 100, is_calibrated: false, overall_precision: null, notes: '' };
  });
  assert.match(html, /hand-checked <span class="num">22 of the 100<\/span> grader judgments/);
  assert.match(html, /stays officially unverified/);
  assert.match(html, /<i class="a" style="width:22%">/);
  assert.match(html, /treat this as a smoke alarm, not a diagnosis/);
});

test('DEGRADED machinery leads with what broke, in a red verdict', () => {
  const html = page((m) => {
    m.mechanics.status = 'DEGRADED';
    m.mechanics.probe.round_trip = false;
    m.mechanics.probe.retrieve = { pass: false, evidence: '' };
  });
  assert.match(html, /class="verdict crit"/);
  assert.match(html, /The storage machinery has a real problem\./);
  assert.match(html, /searching could not find the memory again/);
  assert.match(html, /no other number on this page can be trusted/);
  assert.match(html, /<i class="c" style="width:100%">/, 'failure renders a full crit bar, not a low score');
});

test('no-store project renders the honest no-store verdict and row', () => {
  const html = page((m) => {
    m.mechanics.status = 'MACHINERY-WORKING-NO-STORE';
    m.mechanics.store = { present: false };
    m.mechanics.telemetry = { available: false, reason: 'no retrieval events recorded for this project yet' };
    m.regression.gold = { available: false, reason: 'no _tests/retrieval-gold-set.json in this project — nothing exercises Recall@K here yet' };
    m.readiness.recognition_signal = null;
  });
  assert.match(html, /The machinery works, but this project has no memory store yet\./);
  assert.match(html, /No memory store exists in this project yet\./);
  assert.match(html, /No lookup records yet\./);
  assert.match(html, /No estimate yet\./);
});

test('memory files needing attention render counts, warn gauge, and census tiles', () => {
  const html = page((m) => {
    m.mechanics.status = 'WORKING-WITH-CAVEATS';
    m.mechanics.store.warning_triage.attention = 3;
  });
  assert.match(html, /3 of 290 memory files need attention\./);
  assert.match(html, /the other 287 passed everything/);
  assert.match(html, /class="verdict warn"/);
  assert.match(html, /3 stored memories failed a consistency check/);
  assert.match(html, /<div class="t">in use<\/div><div class="v">285<\/div>/);
  assert.match(html, /<div class="t">replaced by newer<\/div><div class="v">3<\/div>/);
});

// ---------- CLI: --json-in replay path + manifest contract ----------

test('ACCEPTANCE (real pipeline): render-metrics --json-in consumes the ACTUAL metrics-check --json producer output', (t) => {
  if (!TREE_CLEAN) { t.skip('plugin tree dirty — renderer fails closed by design (fix 9); exercised on a clean tree'); return; }
  const METRICS_CHECK = join(SCRIPTS, 'metrics-check.mjs');
  const { root, home } = fixtureProject();
  try {
    mkdirSync(join(root, '_memories'), { recursive: true });
    // 1. The REAL producer: metrics-check --json. Its stdout must be exactly
    //    one JSON document (fix 8) — save it verbatim, no hand-editing.
    const produced = execFileSync('node', [METRICS_CHECK, root, '--json'], { encoding: 'utf8', timeout: 120000 });
    assert.doesNotThrow(() => JSON.parse(produced), 'the producer stdout is a single JSON document');
    const capturedPath = join(root, 'captured-metrics.json');
    writeFileSync(capturedPath, produced);
    // 2. The renderer consumes that exact producer output through --json-in.
    const out = join(root, 'out', 'from-real-json.html');
    const res = spawnSync(process.execPath, [CLI_PATH, root, '--out', out, '--json-in', capturedPath, '--home', home], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    const manifest = JSON.parse(res.stdout);
    assert.equal(manifest.data_source, 'json-in');
    assert.ok(existsSync(out), 'the page rendered from the real producer output');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI --json-in: renders from a pre-captured canonical object; manifest is aggregates-only and receipted', (t) => {
  if (!TREE_CLEAN) { t.skip('plugin tree dirty — renderer fails closed by design (fix 9); exercised on a clean tree'); return; }
  const { root, home } = fixtureProject();
  try {
    const dataPath = join(root, 'metrics.json');
    writeFileSync(dataPath, JSON.stringify(canonicalMetrics()));
    const out = join(root, 'out', 'metrics.html');
    const res = spawnSync(process.execPath, [CLI_PATH, root, '--out', out, '--json-in', dataPath, '--home', home], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    const manifest = JSON.parse(res.stdout);
    assert.equal(manifest.kind, 'core-metrics-artifact-preflight');
    assert.equal(manifest.schema_version, METRICS_ARTIFACT_MANIFEST_SCHEMA_VERSION);
    assert.equal(manifest.content_class, 'aggregates-only');
    assert.equal(manifest.content_class, METRICS_ARTIFACT_CONTENT_CLASS);
    assert.equal(manifest.content_note, METRICS_ARTIFACT_CONTENT_NOTE);
    assert.equal(manifest.data_source, 'json-in');
    assert.equal(manifest.data_generated_at, '2026-07-22T20:00:00.000Z');
    assert.equal(manifest.workspace_id, 'metrics-test-ws');
    assert.equal(manifest.receipt_fallback, false);
    // Lighter than browse — deliberately no unit-count/sensitivity machinery.
    assert.ok(!('unit_count' in manifest), 'no unit-count machinery');
    assert.ok(!('sensitivity_warning' in manifest), 'no sensitivity machinery');
    const onDisk = readFileSync(out);
    assert.equal(manifest.total_bytes, onDisk.length, 'total_bytes == real file size');
    assert.match(onDisk.toString('utf8'), /1 &middot; Does the machinery work\?/);
    // Generation receipt written under the workspace, content == manifest.
    assert.ok(manifest.receipt_path.startsWith(join(home, '.core', 'workspaces', 'metrics-test-ws', 'artifact-receipts')));
    assert.deepEqual(JSON.parse(readFileSync(manifest.receipt_path, 'utf8')), manifest);
    // Truthful renderer identity, distinct from the data producer.
    assert.equal(manifest.producer.script, 'render-metrics-artifact.mjs');
    assert.equal(manifest.data_producer.script, 'metrics-check.mjs');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI usage errors: missing --out, malformed --json-in, --out inside the store', (t) => {
  if (!TREE_CLEAN) { t.skip('plugin tree dirty — malformed --json-in check runs after the fail-closed provenance gate (fix 9); exercised on a clean tree'); return; }
  const { root, home } = fixtureProject();
  try {
    mkdirSync(join(root, '_memories'), { recursive: true });
    const noOut = spawnSync(process.execPath, [CLI_PATH, root, '--home', home], { encoding: 'utf8' });
    assert.equal(noOut.status, 2);
    assert.match(noOut.stderr, /--out/);

    const badJson = join(root, 'bad.json');
    writeFileSync(badJson, JSON.stringify({ hello: 'not canonical' }));
    const bad = spawnSync(process.execPath,
      [CLI_PATH, root, '--out', join(root, 'out', 'x.html'), '--json-in', badJson, '--home', home], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /not a canonical metrics object/);
    assert.ok(!existsSync(join(root, 'out', 'x.html')), 'nothing written on a refused input');

    const dataPath = join(root, 'metrics.json');
    writeFileSync(dataPath, JSON.stringify(canonicalMetrics()));
    const inStore = spawnSync(process.execPath,
      [CLI_PATH, root, '--out', join(root, '_memories', 'x.html'), '--json-in', dataPath, '--home', home], { encoding: 'utf8' });
    assert.equal(inStore.status, 2);
    assert.match(inStore.stderr, /refusing --out inside the memory store/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- live path (real gatherMetrics against a tiny store) ----------

test('CLI live path: real gatherMetrics run produces a truthful manifest and page', (t) => {
  if (!TREE_CLEAN) { t.skip('plugin tree dirty — renderer fails closed by design (fix 9); exercised on a clean tree'); return; }
  const { root, home } = fixtureProject();
  try {
    const mem = join(root, '_memories');
    mkdirSync(mem, { recursive: true });
    writeFileSync(join(mem, 'obs-1-fixture.md'),
      '---\nid: obs-1-fixture\ntype: observation\nstatus: active\ncreated: 2026-01-01\nupdated: 2026-01-01\nlast-reviewed: 2026-01-01\ntopics: [fixture]\nconfidence-level: sourced\nedges: []\n---\n\n# obs-1-fixture\n\nA fixture fact.\n');
    const out = join(root, 'out', 'live.html');
    const res = spawnSync(process.execPath, [CLI_PATH, root, '--out', out, '--home', home], { encoding: 'utf8', timeout: 120000 });
    assert.equal(res.status, 0, res.stderr);
    const manifest = JSON.parse(res.stdout);
    assert.equal(manifest.data_source, 'live');
    assert.ok(manifest.mechanics_status, 'mechanics status recorded');
    assert.ok(manifest.data_generated_at, 'data timestamp from the live gather');
    const html = readFileSync(out, 'utf8');
    assert.match(html, /Passed, demonstrated just now\./, 'live round-trip proof rendered');
    assert.doesNotMatch(html, /Does any of this actually help you\?/, 'benefit section stays gone on a live run (DC-129)');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- shared provenance helper ----------

test('truthfulProducerIdentity: in a CLEAN git checkout, the SHA is the real HEAD and the script name is the caller\'s', async (t) => {
  let head;
  try {
    head = execFileSync('git', ['-C', SCRIPTS, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    t.skip('not running from a git checkout');
    return;
  }
  const id = truthfulProducerIdentity('some-generator.mjs');
  assert.equal(id.script, 'some-generator.mjs');
  if (TREE_CLEAN) {
    assert.equal(id.source_sha, head, 'clean tree ⇒ real HEAD');
    assert.equal(id.source_sha_from, 'git');
  } else {
    // Fix 9: a dirty tree must fail closed — HEAD does not name the executing bytes.
    assert.equal(id.source_sha, null, 'dirty tree ⇒ no clean HEAD stamp (fail closed)');
    assert.equal(id.source_sha_from, null);
  }
});

test('ACCEPTANCE (dirty-tree provenance): pluginTreeDirty is true on a modified tracked file and false when committed, and identity fails closed while dirty', async () => {
  const { execFileSync: exec } = await import('node:child_process');
  const { pluginTreeDirty } = await import(pathToFileURL(join(SCRIPTS, 'artifact-provenance.mjs')).href);
  // Controlled fixture: a throwaway git repo with a plugin-root-shaped subtree.
  const repo = mkdtempSync(join(tmpdir(), 'prov-dirty-'));
  try {
    const pluginRoot = join(repo, 'plugins', 'core');
    const scriptsDir = join(pluginRoot, 'skills', 'core', 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    const tracked = join(scriptsDir, 'x.mjs');
    writeFileSync(tracked, 'export const a = 1;\n');
    const git = (...args) => exec('git', ['-C', repo, ...args], { stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    git('add', '-A'); git('commit', '-q', '-m', 'init');
    // Clean: no changes under the plugin root.
    assert.equal(pluginTreeDirty(repo, pluginRoot), false, 'a committed tree is not dirty');
    // Dirty: modify a tracked file under the plugin root.
    writeFileSync(tracked, 'export const a = 2;\n');
    assert.equal(pluginTreeDirty(repo, pluginRoot), true, 'a modified tracked file makes the tree dirty');
    // Dirty: an untracked file under the plugin root also counts.
    git('checkout', '--', 'plugins');
    writeFileSync(join(scriptsDir, 'untracked.mjs'), 'x\n');
    assert.equal(pluginTreeDirty(repo, pluginRoot), true, 'an untracked file under the plugin root makes the tree dirty');
  } finally { rmSync(repo, { recursive: true, force: true }); }
  // And end-to-end: on THIS repo, identity fails closed iff the tree is dirty.
  const id = truthfulProducerIdentity('some-generator.mjs');
  if (!TREE_CLEAN) assert.equal(id.source_sha, null, 'dirty working tree ⇒ identity fails closed');
});

test('renderer producer in the page footer names the generating script and the live SHA source (clean tree)', async (t) => {
  try {
    execFileSync('git', ['-C', SCRIPTS, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  } catch { t.skip('not running from a git checkout'); return; }
  if (!TREE_CLEAN) { t.skip('plugin tree is dirty — renderer fails closed by design (fix 9); exercised on a clean tree'); return; }
  const head = execFileSync('git', ['-C', SCRIPTS, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const { root, home } = fixtureProject();
  try {
    const dataPath = join(root, 'metrics.json');
    writeFileSync(dataPath, JSON.stringify(canonicalMetrics()));
    const { manifest, html } = await renderMetricsArtifact(root, { outPath: join(root, 'out', 'v.html'), jsonIn: dataPath, home });
    assert.equal(manifest.producer.source_sha, head, 'renderer identity is the REAL current tree HEAD');
    assert.equal(manifest.producer.source_sha_from, 'git');
    assert.ok(html.includes(head.slice(0, 12)), 'page footer carries the real tree SHA');
    assert.match(html, /read live from the source checkout/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- shared publish receipts (both kinds through one helper) ----------

async function generateMetricsReceipt() {
  const { root, home } = fixtureProject();
  const dataPath = join(root, 'metrics.json');
  writeFileSync(dataPath, JSON.stringify(canonicalMetrics()));
  const { manifest } = await renderMetricsArtifact(root, { outPath: join(root, 'out', 'v.html'), jsonIn: dataPath, home });
  return { root, home, genPath: manifest.receipt_path };
}

test('--record-publish on a metrics generation receipt lands kind core-metrics-artifact-publish, self-contained', async (t) => {
  if (!TREE_CLEAN) { t.skip('plugin tree dirty — real render is fail-closed by design (fix 9); receipt behavior also covered tree-independently by the item-7 acceptance tests'); return; }
  const { root, genPath } = await generateMetricsReceipt();
  try {
    const res = spawnSync(process.execPath, [CLI_PATH, '--record-publish',
      '--generation-receipt', genPath, '--status', 'published-private',
      '--artifact-url', 'https://claude.ai/code/artifact/test-1111',
      '--private-verified-evidence', 'gallery shows private; share menu never opened',
      '--consent-by', 'David', '--consent-mechanism', 'explicit yes on the rendered preflight manifest'],
      { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    const receiptPath = publishReceiptPathFor(genPath);
    // Self-containment: delete the generation receipt,
    // the publish receipt must still carry the snapshot identity on its own.
    unlinkSync(genPath);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    assert.equal(receipt.kind, 'core-metrics-artifact-publish');
    assert.equal(receipt.publish_status, 'published-private');
    assert.equal(receipt.data_generated_at, '2026-07-22T20:00:00.000Z', 'data-gathering instant copied into the receipt');
    assert.ok(receipt.generation_generated_at, 'generation instant copied into the receipt');
    assert.equal(receipt.snapshot_id, null, 'metrics pages have no store snapshot — recorded honestly as null');
    assert.equal(receipt.consent.granted_by, 'David');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('published-private REFUSES to record without a consent record (--consent-by + --consent-mechanism)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'receipts-consent-'));
  const genPath = join(dir, 'gen.json');
  try {
    writeGenerationReceipt(genPath);
    const res = spawnSync(process.execPath, [CLI_PATH, '--record-publish',
      '--generation-receipt', genPath, '--status', 'published-private',
      '--private-verified-evidence', 'gallery shows private'],
      { encoding: 'utf8' });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /--consent-by and --consent-mechanism/);
    assert.ok(!existsSync(publishReceiptPathFor(genPath)), 'refusal writes nothing');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('browse-kind publish receipt copies snapshot_id from the generation receipt (self-contained after deletion)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'receipts-snapshot-'));
  const genPath = join(dir, '2026-07-22T21-00-00-000Z.json');
  try {
    writeGenerationReceipt(genPath, {
      kind: 'core-memory-browse-preflight',
      overrides: { generated_at: '2026-07-22T21:00:00.000Z', snapshot_id: 'snap-abc123def456' },
    });
    const res = spawnSync(process.execPath, [CLI_PATH, '--record-publish',
      '--generation-receipt', genPath, '--status', 'published-private',
      '--artifact-url', 'https://claude.ai/code/artifact/browse-1',
      '--private-verified-evidence', 'verified private in gallery',
      '--consent-by', 'David', '--consent-mechanism', 'explicit yes on the rendered preflight manifest'],
      { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    unlinkSync(genPath);
    const receipt = JSON.parse(readFileSync(publishReceiptPathFor(genPath), 'utf8'));
    assert.equal(receipt.kind, 'core-memory-browse-publish', 'kind mapped from the generation kind');
    assert.equal(receipt.snapshot_id, 'snap-abc123def456', 'snapshot id survives on its own');
    assert.equal(receipt.generation_generated_at, '2026-07-22T21:00:00.000Z');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('declined outcomes record without consent flags; unknown generation kinds are refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'receipts-declined-'));
  const genPath = join(dir, 'gen.json');
  try {
    writeGenerationReceipt(genPath);
    const declined = spawnSync(process.execPath, [CLI_PATH, '--record-publish',
      '--generation-receipt', genPath, '--status', 'declined'], { encoding: 'utf8' });
    assert.equal(declined.status, 0, declined.stderr);
    const receipt = JSON.parse(readFileSync(publishReceiptPathFor(genPath), 'utf8'));
    assert.equal(receipt.publish_status, 'declined');
    assert.equal(receipt.published_at, null);

    const bogusPath = join(dir, 'bogus.json');
    writeFileSync(bogusPath, JSON.stringify({ kind: 'not-a-real-kind' }));
    const bogus = spawnSync(process.execPath, [CLI_PATH, '--record-publish',
      '--generation-receipt', bogusPath, '--status', 'declined'], { encoding: 'utf8' });
    assert.equal(bogus.status, 2);
    assert.match(bogus.stderr, /not a generation receipt/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--record-revocation stamps revoked_at on a PUBLISHED-PRIVATE receipt, then refuses a double revoke', () => {
  const dir = mkdtempSync(join(tmpdir(), 'receipts-revoke-'));
  const genPath = join(dir, '2026-07-23T02-00-00-000Z.json');
  try {
    writeGenerationReceipt(genPath);
    const pub = spawnSync(process.execPath, [CLI_PATH, '--record-publish',
      '--generation-receipt', genPath, '--status', 'published-private',
      '--artifact-url', 'https://claude.ai/code/artifact/rev-1',
      '--private-verified-evidence', 'gallery shows private',
      '--consent-by', 'David', '--consent-mechanism', 'explicit yes'], { encoding: 'utf8' });
    assert.equal(pub.status, 0, pub.stderr);
    const p = publishReceiptPathFor(genPath);
    const res = spawnSync(process.execPath, [CLI_PATH, '--record-revocation', p], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(JSON.parse(readFileSync(p, 'utf8')).revoked_at);
    const again = spawnSync(process.execPath, [CLI_PATH, '--record-revocation', p], { encoding: 'utf8' });
    assert.equal(again.status, 2);
    assert.match(again.stderr, /already revoked/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- ACCEPTANCE: receipt hardening ----------

test('ACCEPTANCE (receipt hardening): a forged generation receipt with no content digest is REFUSED (full schema, not just kind)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'receipts-forged-'));
  try {
    // A blob with a VALID kind but no content digest — the old check passed on
    // kind alone; full-schema validation refuses it.
    const noDigest = join(dir, 'no-digest.json');
    writeFileSync(noDigest, JSON.stringify({
      kind: 'core-metrics-artifact-preflight', schema_version: '1.0.0', generated_at: '2026-07-23T00:00:00.000Z',
    }));
    const res = spawnSync(process.execPath, [CLI_PATH, '--record-publish',
      '--generation-receipt', noDigest, '--status', 'published-private',
      '--artifact-url', 'https://claude.ai/code/artifact/x',
      '--private-verified-evidence', 'ev', '--consent-by', 'D', '--consent-mechanism', 'm'],
      { encoding: 'utf8' });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /artifact_sha256/, 'a receipt with no content digest cannot bind a publish');
    assert.ok(!existsSync(publishReceiptPathFor(noDigest)));

    // And a kind-only blob is refused too (fails on the first missing field).
    const kindOnly = join(dir, 'kind-only.json');
    writeFileSync(kindOnly, JSON.stringify({ kind: 'core-metrics-artifact-preflight' }));
    const res2 = spawnSync(process.execPath, [CLI_PATH, '--record-publish',
      '--generation-receipt', kindOnly, '--status', 'declined'], { encoding: 'utf8' });
    assert.equal(res2.status, 2);
    assert.match(res2.stderr, /schema_version|generation receipt/, 'a kind-only blob is not a valid generation receipt');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ACCEPTANCE (receipt hardening): the artifact content digest is copied into the publish receipt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'receipts-digest-'));
  const genPath = join(dir, 'gen.json');
  try {
    const digest = writeGenerationReceipt(genPath, { html: '<html>exact bytes</html>' });
    const res = spawnSync(process.execPath, [CLI_PATH, '--record-publish',
      '--generation-receipt', genPath, '--status', 'published-private',
      '--artifact-url', 'https://claude.ai/code/artifact/d',
      '--private-verified-evidence', 'ev', '--consent-by', 'D', '--consent-mechanism', 'm'],
      { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    const receipt = JSON.parse(readFileSync(publishReceiptPathFor(genPath), 'utf8'));
    assert.equal(receipt.artifact_sha256, digest, 'the exact-byte identity binds the publish to the content');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ACCEPTANCE (receipt hardening): published-private REFUSES a null artifact_url', () => {
  const dir = mkdtempSync(join(tmpdir(), 'receipts-nourl-'));
  const genPath = join(dir, 'gen.json');
  try {
    writeGenerationReceipt(genPath);
    const res = spawnSync(process.execPath, [CLI_PATH, '--record-publish',
      '--generation-receipt', genPath, '--status', 'published-private',
      '--private-verified-evidence', 'ev', '--consent-by', 'D', '--consent-mechanism', 'm'],
      { encoding: 'utf8' });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /--artifact-url/, 'a private publish that names no hosted URL is not published-private');
    assert.ok(!existsSync(publishReceiptPathFor(genPath)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ACCEPTANCE (receipt hardening): a declined/failed receipt can NEVER be marked revoked', () => {
  for (const status of ['declined', 'failed']) {
    const dir = mkdtempSync(join(tmpdir(), `receipts-${status}-`));
    const genPath = join(dir, 'gen.json');
    try {
      writeGenerationReceipt(genPath);
      const rec = spawnSync(process.execPath, [CLI_PATH, '--record-publish',
        '--generation-receipt', genPath, '--status', status], { encoding: 'utf8' });
      assert.equal(rec.status, 0, rec.stderr);
      const p = publishReceiptPathFor(genPath);
      const rev = spawnSync(process.execPath, [CLI_PATH, '--record-revocation', p], { encoding: 'utf8' });
      assert.equal(rev.status, 2, `revoking a ${status} record must be refused`);
      assert.match(rev.stderr, /only a 'published-private' record can be revoked/);
      assert.equal(JSON.parse(readFileSync(p, 'utf8')).revoked_at, null, 'no revocation stamp on a non-published record');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

// ---------- no-workspace fallback ----------

test('no workspace.json: receipt lands in the flagged fallback location', async (t) => {
  if (!TREE_CLEAN) { t.skip('plugin tree dirty — renderer fails closed by design (fix 9); exercised on a clean tree'); return; }
  const { root, home } = fixtureProject({ workspace: false });
  try {
    const dataPath = join(root, 'metrics.json');
    writeFileSync(dataPath, JSON.stringify(canonicalMetrics()));
    const { manifest, receiptWritten } = await renderMetricsArtifact(root, { outPath: join(root, 'out', 'v.html'), jsonIn: dataPath, home });
    assert.equal(receiptWritten, true);
    assert.equal(manifest.receipt_fallback, true);
    assert.equal(manifest.workspace_id, null);
    assert.ok(manifest.receipt_path.startsWith(join(home, '.core', 'artifact-receipts')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('sanitizeForEmbed: an unknown top-level field never reaches the embed, and the drop is disclosed', async () => {
  const { sanitizeForEmbed } = await import('../../plugins/core/skills/core/scripts/render-metrics-artifact.mjs');
  const out = sanitizeForEmbed({
    generated_at: 't', producer: {}, mechanics: {},
    smuggled_note: { password: 'PlantedSecret4471' },
  });
  const bytes = JSON.stringify(out);
  assert.ok(!bytes.includes('PlantedSecret4471'), 'unknown fields are dropped, not embedded');
  assert.equal(out.embed_fields_omitted, 1, 'the drop count is disclosed');
});

test('AUD-105: a nested planted secret inside a known section never reaches the embed', async () => {
  const { sanitizeForEmbed } = await import('../../plugins/core/skills/core/scripts/render-metrics-artifact.mjs');
  const out = sanitizeForEmbed({
    schema_version: '1.0.0', generated_at: 't', producer: {},
    mechanics: { status: 'WORKING', smuggled_note: { password: 'NestedPlant7731' } },
  });
  const bytes = JSON.stringify(out);
  assert.ok(!bytes.includes('NestedPlant7731'), 'nested unknown keys inside known sections are dropped');
  assert.ok(bytes.includes('WORKING'), 'known nested keys survive');
});
