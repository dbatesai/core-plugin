import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { trustedTestTmpRoot } from './trusted-test-tmp.mjs';
import {
  runPackage, loadOrCreateSalt, makeSeal, storeCensus, retrievalStats,
  buildLeakPatterns, leakScanDir, verifyZipMagic, zipStaging, workspaceMetrics, selfTestStats,
} from '../../plugins/core/skills/core/scripts/metrics-package.mjs';
import { CLASSIFIER_VERSION, PROXY_VERSION, CLASSIFIED_SCHEMA_VERSION } from '../../plugins/core/skills/core/scripts/classify-turns.mjs';

// Planted tripwires — distinctive strings that MUST NOT survive into any package byte.
const PLANT_NAME = 'ZephyrCorpMeltdown';
const PLANT_PATH = '/Users/plantedusr/secret-client-files';
const PLANT_TOPIC = 'zephyr-acquisition-diligence';

function makeFixtureProject(root, { plant = true } = {}) {
  const project = join(root, 'proj');
  const store = join(project, '_memories');
  mkdirSync(store, { recursive: true });
  writeFileSync(join(project, 'workspace.json'), JSON.stringify({ workspace_id: 'fixture-ws-alpha' }));
  writeFileSync(join(project, 'PROJECT.md'), '# P\n');
  const unit = (id, extra, body) => writeFileSync(join(store, `${id}.md`), `---\nid: ${id}\n${extra}---\n\n${body}\n`);
  unit('dc-1-linked', 'type: decision\nstatus: active\ncreated: 2026-06-01\nedges:\n  - {to: risk-1-linked, type: cites}\n', plant ? `Decision about ${PLANT_NAME} at ${PLANT_PATH}.` : 'Decision body.');
  unit('risk-1-linked', 'type: risk\nstatus: active\ncreated: 2026-06-02\n', 'Risk body.');
  unit('obs-1-orphan', 'type: observation\nstatus: active\ncreated: 2026-06-03\n', 'Orphan observation.');
  unit('obs-2-archived-orphan', 'type: observation\nstatus: archived\ncreated: 2026-05-01\n', 'Archived orphan.');
  const sessions = join(project, '_sessions', '2026-07-01');
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, 'retrieval-log.jsonl'), [
    JSON.stringify({ kind: 'retrieval', ts: '2026-07-01T10:00:00Z', intent_topics: plant ? [PLANT_TOPIC] : ['a'], tier_reached: 1, units_retrieved: [{ id: 'dc-1-linked', tier: 1 }], dip_back_count: 0, candidate_count: 8, selected_count: 2, retired_suppressed_count: 1, stale_suppressed_count: 0, native_memory_suppressed_count: 0 }),
    JSON.stringify({ kind: 'retrieval', ts: '2026-07-01T10:20:00Z', intent_topics: ['a2'], tier_reached: 1, units_retrieved: [{ id: 'dc-1-linked', tier: 1 }], dip_back_count: 0, candidate_count: 8, selected_count: 1 }),
    JSON.stringify({ kind: 'retrieval', ts: '2026-07-01T10:40:00Z', intent_topics: ['a3'], tier_reached: 1, units_retrieved: [{ id: 'dc-1-linked', tier: 1 }], dip_back_count: 0, candidate_count: 8, selected_count: 1 }),
    JSON.stringify({ kind: 'retrieval', ts: '2026-07-01T11:00:00Z', intent_topics: ['b'], tier_reached: 3, result: 'miss', units_retrieved: [], dip_back_count: 1, candidate_count: 12, selected_count: 0 }),
  ].join('\n') + '\n');
  writeFileSync(join(sessions, 'hygiene-log.jsonl'), JSON.stringify({ ts: '2026-07-01T12:00:00Z', kind: 'demote-moves', demoted: 3 }) + '\n');
  return project;
}

function makeFixtureHome(root) {
  const home = join(root, 'home');
  mkdirSync(join(home, '.core'), { recursive: true });
  mkdirSync(join(home, 'Desktop'), { recursive: true });
  return home;
}

function readAllPackageText(dir) {
  let text = '';
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else text += readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return text;
}

function extractZip(zipPath, dest) {
  mkdirSync(dest, { recursive: true });
  // Same fix as zipStaging() in the product code (2026-07-18): a Windows
  // drive-letter path passed to -f gets parsed as tar's remote host:path
  // syntax. Run with zipPath's directory as cwd, pass only its basename to
  // -f. Confirmed via live CI this was the exact remaining cause after the
  // product-side create fix landed -- the create step started succeeding,
  // and this helper's own absolute-path extract call was the only thing
  // still failing.
  const res = spawnSync('tar', ['-x', '-f', basename(zipPath), '-C', dest], { cwd: dirname(zipPath), encoding: 'utf8' });
  assert.equal(res.status, 0, `zip extracts (status=${res.status}, error=${res.error?.message || 'none'}, stderr=${JSON.stringify(res.stderr)})`);
  return dest;
}

// readShippedPackage — CI-runner honesty (2026-07-21): some CI runners' `tar`
// silently emits a plain tar for a `.zip` destination. zipStaging()'s own
// magic-byte check correctly refuses that as a fake zip and runPackage()
// falls back to shipping a real, already-unpacked folder instead
// (`shipped.kind === 'folder'`) -- exactly the behavior Meridian's fix
// exists to guarantee. A test asserting `shipped.kind === 'zip'` unconditionally
// was itself asserting this box's tar is trustworthy, which isn't always true
// and isn't the product's contract. Both outcomes ship real, readable content;
// only the container differs.
function readShippedPackage(shipped, dest) {
  if (shipped.kind === 'folder') return shipped.path; // already a real, unpacked directory
  return extractZip(shipped.path, dest);
}

// ---------- verifyZipMagic / zipStaging: silent tar-as-zip corruption (Meridian, 2026-07-20) ----------
//
// Live Windows-box finding: GNU tar (first on PATH via Git Bash/MSYS2 on her machine)
// has no ZIP support behind `-a`, so for a `.zip` filename it silently emits an
// uncompressed TAR wearing a .zip extension, exit 0 -- and the old `tar -t` + manifest
// listing check couldn't tell the difference, because GNU tar happily lists its own
// tar output. zipStaging() returned ok:true for a file that is not actually a zip.
// Confirmed against her actual repro: the mislabeled file's first bytes were
// `2e 2f` ("./", a tar header), not `50 4b` (zip magic).

test('verifyZipMagic: rejects a plain-tar-wearing-a-zip-extension file (GNU tar\'s exact failure mode)', () => {
  const root = mkdtempSync(join(tmpdir(), 'mp-zipmagic-'));
  try {
    const fakeZip = join(root, 'fake.zip');
    // Meridian's exact confirmed bytes for the corrupted case: a tar header starts "./".
    writeFileSync(fakeZip, Buffer.from('./manifest.json\x00\x00\x00garbage-tar-bytes'));
    const result = verifyZipMagic(fakeZip);
    assert.equal(result.ok, false, 'a mislabeled tar must not be certified as a real zip');
    assert.match(result.reason, /not a real zip/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('verifyZipMagic: accepts a file with real zip local-file-header magic bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'mp-zipmagic-'));
  try {
    const realZip = join(root, 'real.zip');
    writeFileSync(realZip, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]));
    const result = verifyZipMagic(realZip);
    assert.equal(result.ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('verifyZipMagic: a missing/unreadable file fails closed with a clear reason, not a thrown error', () => {
  const result = verifyZipMagic(join(tmpdir(), 'definitely-does-not-exist-' + Date.now(), 'x.zip'));
  assert.equal(result.ok, false);
  assert.match(result.reason, /cannot read/);
});

test('zipStaging: the real local tar on this box produces a file that passes the magic-byte check too (end-to-end sanity)', () => {
  const root = mkdtempSync(join(tmpdir(), 'mp-zipstaging-'));
  try {
    const stage = join(root, 'stage');
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, 'manifest.json'), '{}');
    const dest = join(root, 'out.zip');
    const result = zipStaging(stage, dest);
    // A CI runner whose `tar` can't produce a real zip is refused correctly, not a defect —
    // runPackage() falls back to shipping a folder in that case (see readShippedPackage).
    if (!result.ok) return;
    assert.equal(result.ok, true, `real tar on this box should produce a genuine zip: ${result.reason || ''}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('package never contains planted names, paths, topics, or raw unit ids', () => {
  const root = mkdtempSync(join(tmpdir(), 'mp-test-'));
  try {
    const home = makeFixtureHome(root);
    const project = makeFixtureProject(root, { plant: true });
    const result = runPackage([project, '--home', home, '--out', join(root, 'out')]);
    assert.ok(!result.error, `no fatal error: ${result.error}`);
    const text = readAllPackageText(readShippedPackage(result.shipped, join(root, 'x')));
    for (const tripwire of [PLANT_NAME, PLANT_PATH, PLANT_TOPIC, 'plantedusr', 'dc-1-linked', 'fixture-ws-alpha', home]) {
      assert.ok(!text.includes(tripwire), `tripwire must not appear: ${tripwire}`);
    }
    // and the stats themselves are real: 4 events, 1 miss, tier histogram present
    assert.match(text, /"events": 4/);
    assert.match(text, /"misses": 1/);
    // ranking suppressed below the population floor (3 active units < 50)
    assert.match(text, /"top_retrieved_units": \[\]/);
    assert.match(text, /population below 50 active units/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('share artifact projects local daily telemetry to weekly-only blocks and reports', () => {
  const root = mkdtempSync(join(tmpdir(), 'mp-weekly-'));
  try {
    const home = makeFixtureHome(root);
    const project = makeFixtureProject(root, { plant: false });
    const secondWeek = join(project, '_sessions', '2026-07-08');
    mkdirSync(secondWeek, { recursive: true });
    writeFileSync(join(secondWeek, 'retrieval-log.jsonl'), `${JSON.stringify({ kind: 'retrieval', tier_reached: 1, dip_back_count: 0 })}\n`);
    writeFileSync(join(secondWeek, 'hygiene-log.jsonl'), `${JSON.stringify({ kind: 'maintenance-run' })}\n`);
    const classified = join(home, '.core', 'workspaces', 'fixture-ws-alpha', 'metrics', 'classified');
    mkdirSync(classified, { recursive: true });
    // Current-instrument stamps: the cohort gate (Hale 2026-07-22) only
    // aggregates rows produced by the running (schema, classifier, proxy).
    const stamp = { schema_version: CLASSIFIED_SCHEMA_VERSION, classifier_version: CLASSIFIER_VERSION, proxy_version: PROXY_VERSION };
    writeFileSync(join(classified, '2026-07-01.jsonl'), `${JSON.stringify({ ...stamp, state: 'tier-0-win', provisional: true })}\n`);
    writeFileSync(join(classified, '2026-07-08.jsonl'), `${JSON.stringify({ ...stamp, state: 'rec-fail-tier-0', provisional: false })}\n`);
    const result = runPackage([project, '--home', home, '--out', join(root, 'out')]);
    const extracted = readShippedPackage(result.shipped, join(root, 'x'));
    const projectDir = join(extracted, 'projects', readdirSync(join(extracted, 'projects'))[0]);
    const retrieval = JSON.parse(readFileSync(join(projectDir, 'retrieval-stats.json'), 'utf8'));
    const hygiene = JSON.parse(readFileSync(join(projectDir, 'hygiene-stats.json'), 'utf8'));
    const workspace = JSON.parse(readFileSync(join(projectDir, 'workspace-metrics.json'), 'utf8'));
    const report = readFileSync(join(extracted, 'report.html'), 'utf8');

    assert.equal(retrieval.days, undefined, 'exact daily retrieval vectors stay local');
    assert.equal(hygiene.days, undefined, 'exact daily hygiene vectors stay local');
    assert.equal(workspace.recognition.days, undefined, 'exact daily recognition vectors stay local');
    assert.equal(retrieval.weeks['2026-06-29'].events, 4);
    assert.equal(hygiene.weeks['2026-06-29'].ops['demote-moves'], 1);
    assert.equal(workspace.recognition.weeks['2026-06-29'].turns, 1);
    assert.equal(workspace.recognition.weeks['2026-06-29'].provisional_share, 1);
    assert.match(report, /per week/i);
    assert.doesNotMatch(report, /per day/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pseudonyms are stable under one salt and rotate when the salt is deleted', () => {
  const root = mkdtempSync(join(tmpdir(), 'mp-salt-'));
  try {
    const home = makeFixtureHome(root);
    const { salt: s1 } = loadOrCreateSalt(join(home, '.core'));
    const { salt: s1again } = loadOrCreateSalt(join(home, '.core'));
    assert.equal(s1, s1again, 'salt persists');
    const label1 = makeSeal(s1)('project', 'fixture-ws-alpha');
    assert.match(label1, /^project-[0-9a-f]{12}$/);
    rmSync(join(home, '.core', 'metrics-package-salt'));
    const { salt: s2 } = loadOrCreateSalt(join(home, '.core'));
    assert.notEqual(makeSeal(s2)('project', 'fixture-ws-alpha'), label1, 'deleting the salt rotates pseudonyms');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('orphan rate counts active units only; archived orphans excluded; small cells suppressed', () => {
  const root = mkdtempSync(join(tmpdir(), 'mp-census-'));
  try {
    const project = makeFixtureProject(root, { plant: false });
    const census = storeCensus(project);
    assert.equal(census.available, true);
    assert.equal(census.units_total, 4);
    assert.equal(census.units_active, 3);
    assert.equal(census.orphans, 1, 'only the active orphan counts');
    assert.equal(census.orphan_rate, 0.333);
    // histogram cells under k=3 fold into the suppressed aggregate (decision:1, risk:1)
    assert.equal(census.by_type.decision, undefined, 'small cell suppressed');
    assert.ok(census.by_type.suppressed && census.by_type.suppressed.k === 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('per-turn hook emits the canonical retrieval event from the product path', () => {
  const root = mkdtempSync(join(tmpdir(), 'mp-hook-'));
  // Rooted under ~/.core (D1 fix, 2026-07-18): os.tmpdir() no longer qualifies
  // for CORE_HOOKS_LOG_FILE — declared outside try so finally can clean it up.
  const hooksLogDir = mkdtempSync(join(trustedTestTmpRoot(), 'mp-hook-log-'));
  try {
    const project = makeFixtureProject(root, { plant: false });
    const hook = join(import.meta.dirname, '..', '..', 'plugins', 'core', 'skills', 'core', 'hooks', 'retrieve-context-hook.mjs');
    // Isolate the hook test log (Hale audit, 2026-07-17) — default
    // ~/.core/hooks-log.jsonl is a real machine-wide file, not a test fixture.
    const hooksLog = join(hooksLogDir, 'hooks-log.jsonl');
    const res = spawnSync(process.execPath, [hook], {
      encoding: 'utf8',
      input: JSON.stringify({ prompt: 'linked decision risk', cwd: project }),
      env: { ...process.env, CORE_RETRIEVAL_STORE: project, CORE_HOOKS_LOG_FILE: hooksLog },
    });
    assert.equal(res.status, 0, `hook exits clean: ${res.stderr}`);
    const logs = readdirSync(join(project, '_sessions'));
    const todayDir = logs.find(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && existsSync(join(project, '_sessions', d, 'retrieval-log.jsonl')) && d !== '2026-07-01');
    assert.ok(todayDir, 'a retrieval-log row landed under today\'s session dir');
    const rows = readFileSync(join(project, '_sessions', todayDir, 'retrieval-log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const evt = rows.find(r => r.trigger === 'per-turn-hook');
    assert.ok(evt, 'canonical per-turn-hook event written by the product path');
    assert.equal(evt.kind, 'retrieval');
    assert.ok(Number.isInteger(evt.candidate_count));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(hooksLogDir, { recursive: true, force: true }); }
});

test('missing sources emit available:false blocks, run stays exit 1 not a crash', () => {
  const root = mkdtempSync(join(tmpdir(), 'mp-avail-'));
  try {
    const home = makeFixtureHome(root);
    const project = join(root, 'bare');
    mkdirSync(join(project, '_memories'), { recursive: true });
    writeFileSync(join(project, '_memories', 'dc-1.md'), '---\nid: dc-1\ntype: decision\nstatus: active\n---\nBody.\n');
    const result = runPackage([project, '--home', home, '--out', join(root, 'out')]);
    assert.ok(!result.error);
    assert.equal(result.exit, 1, 'partial coverage exits 1');
    const text = readAllPackageText(readShippedPackage(result.shipped, join(root, 'x')));
    assert.match(text, /"available": false/);
    assert.match(text, /no retrieval-log\.jsonl/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('--all packages the healthy project and records the broken one in coverage', () => {
  const root = mkdtempSync(join(tmpdir(), 'mp-all-'));
  try {
    const home = makeFixtureHome(root);
    const good = makeFixtureProject(root);
    const broken = join(root, 'broken');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, '_memories'), 'a file where a directory should be');
    writeFileSync(join(home, '.core', 'index.json'), JSON.stringify([
      { id: 'fixture-ws-alpha', path: good },
      { id: 'broken-ws', path: broken },
    ]));
    const result = runPackage(['--all', '--home', home, '--out', join(root, 'out')]);
    assert.ok(!result.error, `no fatal error: ${result.error}`);
    assert.equal(result.exit, 1);
    const covered = result.coverage.filter(c => c.available).length;
    assert.equal(covered, 1, 'one healthy project packaged');
    assert.equal(result.coverage.length, 2, 'broken project recorded, not dropped');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('leak scan catches identifiers, paths, and path shapes in staged bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'mp-scan-'));
  try {
    const staged = join(root, 'staged');
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(staged, 'a.json'), '{"note":"data for zephyrproj here"}');
    writeFileSync(join(staged, 'b.json'), '{"p":"/Users/someone/x"}');
    const patterns = buildLeakPatterns({
      home: join(root, 'home'),
      projectDirs: [join(root, 'zephyrproj')],
      indexEntries: [{ id: 'zephyrproj', path: join(root, 'zephyrproj') }],
    });
    const hits = leakScanDir(staged, patterns);
    assert.ok(hits.some(h => h.kind === 'identifier' && h.pattern === 'zephyrproj'), 'identifier caught');
    assert.ok(hits.some(h => h.kind === 'path-shape'), 'path shape caught');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('end-to-end abort: a package that would contain a registered identifier ships nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'mp-abort-'));
  try {
    const home = makeFixtureHome(root);
    // Register a workspace whose id equals a fixed string that WILL appear in
    // package output ("direct" occurs in every _trust label), proving the scan
    // really reads staged bytes and fails closed — even on a false positive,
    // the failure direction is abort-and-explain, never ship-and-hope.
    writeFileSync(join(home, '.core', 'index.json'), JSON.stringify([{ id: 'direct', path: join(root, 'nowhere') }]));
    const project = makeFixtureProject(root);
    const result = runPackage([project, '--home', home, '--out', join(root, 'out')]);
    assert.equal(result.exit, 2, 'aborts on leak hit');
    assert.ok(result.error && /LEAKAGE/.test(result.error));
    assert.ok(!existsSync(join(root, 'out')) || readdirSync(join(root, 'out')).length === 0, 'nothing shipped');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('retrieval stats aggregate tiers, suppression, and pseudonymized top units', () => {
  const root = mkdtempSync(join(tmpdir(), 'mp-retr-'));
  try {
    const project = makeFixtureProject(root, { plant: false });
    const seal = makeSeal('feedcafefeedcafe');
    const stats = retrievalStats(project, seal);
    assert.equal(stats.available, true);
    assert.equal(stats._trust, 'proxy', 'retrieval corpus labeled proxy, not direct');
    const day = stats.days['2026-07-01'];
    assert.equal(day.events, 4);
    assert.deepEqual(day.tiers, { 1: 3, 3: 1 });
    assert.equal(day.suppressed.retired, 1);
    assert.equal(stats.top_retrieved_units.length, 1, 'unit with 3 retrievals clears the count floor');
    assert.match(stats.top_retrieved_units[0].unit, /^unit-[0-9a-f]{12}$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('retrieval stats join outcome rows by retrieval_id without counting them as retrievals', () => {
  const root = mkdtempSync(join(tmpdir(), 'mp-outcome-'));
  try {
    const project = makeFixtureProject(root, { plant: false });
    const file = join(project, '_sessions', '2026-07-01', 'retrieval-log.jsonl');
    const baseRows = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    baseRows[0].retrieval_id = 'retrieval-1';
    writeFileSync(file, `${baseRows.map(row => JSON.stringify(row)).join('\n')}\n${JSON.stringify({ kind: 'retrieval-outcome', retrieval_id: 'retrieval-1', usefulness_outcome: 'useful', evidence_kind: 'user-confirmed' })}\n${JSON.stringify({ kind: 'retrieval-outcome', retrieval_id: 'orphan', usefulness_outcome: 'miss', evidence_kind: 'agent-judgment' })}\n`);

    const stats = retrievalStats(project, makeSeal('feedcafefeedcafe'));
    assert.equal(stats.totals.events, 4, 'outcome rows are not retrieval events');
    assert.deepEqual(stats.days['2026-07-01'].outcomes, { useful: 1 });
    assert.deepEqual(stats.outcome_coverage, {
      eligible_retrieval_rows: 1,
      joined_outcome_rows: 1,
      orphan_outcome_rows: 1,
      duplicate_outcome_rows: 0,
      rate: 1,
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('separate-log outcomes join by authority: conflict at equal authority resolves unknown; unknown never in denominators', async () => {
  const { retrievalStats, makeSeal } = await import('../../plugins/core/skills/core/scripts/metrics-package.mjs');
  const root = mkdtempSync(join(tmpdir(), 'mp-sep-join-'));
  try {
    const sess = join(root, '_sessions', '2026-07-17');
    mkdirSync(sess, { recursive: true });
    writeFileSync(join(sess, 'retrieval-log.jsonl'), [
      JSON.stringify({ kind: 'retrieval', ts: '2026-07-17T01:00:00Z', retrieval_id: 'r-1', intent_topics: ['a'], tier_reached: 1, escalation_path: [1], units_retrieved: [{ id: 'u1', tier: 1 }] }),
      JSON.stringify({ kind: 'retrieval', ts: '2026-07-17T01:10:00Z', retrieval_id: 'r-2', intent_topics: ['b'], tier_reached: 1, escalation_path: [1], units_retrieved: [{ id: 'u1', tier: 1 }] }),
    ].join('\n') + '\n');
    writeFileSync(join(sess, 'outcome-log.jsonl'), [
      // r-1: weak automatic unknown FIRST, then stronger user-confirmed useful — stronger evidence must win (never first-row-wins)
      JSON.stringify({ kind: 'retrieval-outcome', retrieval_id: 'r-1', usefulness_outcome: 'unknown', evidence_authority: 'unobservable' }),
      JSON.stringify({ kind: 'retrieval-outcome', retrieval_id: 'r-1', usefulness_outcome: 'useful', evidence_authority: 'user-confirmed' }),
      // r-2: equal-authority conflict — resolves to unknown, which never enters a denominator
      JSON.stringify({ kind: 'retrieval-outcome', retrieval_id: 'r-2', usefulness_outcome: 'useful', evidence_authority: 'agent-attribution' }),
      JSON.stringify({ kind: 'retrieval-outcome', retrieval_id: 'r-2', usefulness_outcome: 'miss', evidence_authority: 'agent-attribution' }),
    ].join('\n') + '\n');
    const stats = retrievalStats(root, makeSeal('cafe'.repeat(8)));
    const day = stats.days['2026-07-17'];
    assert.deepEqual(day.outcomes, { useful: 1 }, 'stronger evidence wins r-1; r-2 conflict resolves unknown and stays out of denominators');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('workspace recognition dedupes replayed classified rows before counting, and ships numeric dedupe stats', () => {
  const root = mkdtempSync(join(tmpdir(), 'mp-dedupe-'));
  try {
    const home = join(root, 'home');
    const clsDir = join(home, '.core', 'workspaces', 'ws-dedupe', 'metrics', 'classified');
    mkdirSync(clsDir, { recursive: true });
    const ident = (over = {}) => ({
      schema_version: '1.0.0', classifier_version: '0.3.0', proxy_version: 2,
      harness: 'claude-code', provisional: true, session_id: 'sess-pkg', ...over,
    });
    const lines = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    // 07-01: a 2-turn session (current instrument), plus one out-of-cohort
    // 0.2.0 row. 07-08: the same two turns replayed identically at a catch-up,
    // a genuinely-new turn2, and a same-instrument contradiction on turn3.
    writeFileSync(join(clsDir, '2026-07-01.jsonl'), lines([
      ident({ turn_idx: 0, state: 'tier-0-win' }),
      ident({ turn_idx: 1, state: 'rec-fail-tier-0' }),
      ident({ turn_idx: 9, classifier_version: '0.2.0', state: 'tier-1-3-win' }), // out of cohort → gap
    ]));
    writeFileSync(join(clsDir, '2026-07-08.jsonl'), lines([
      ident({ turn_idx: 0, state: 'tier-0-win' }), // pure replay of 07-01 turn0
      ident({ turn_idx: 1, state: 'rec-fail-tier-0' }), // pure replay of 07-01 turn1
      ident({ turn_idx: 2, state: 'tier-0-win' }), // genuinely new turn, first seen 07-08
      ident({ turn_idx: 3, state: 'tier-0-win' }), // turn3: contradiction ...
      ident({ turn_idx: 3, state: 'rec-fail-tier-0' }), // ... excluded, counted as a conflict
    ]));
    const w = workspaceMetrics(home, 'ws-dedupe');
    assert.equal(w.recognition.available, true);
    const totalTurns = Object.values(w.recognition.days).reduce((n, d) => n + d.turns, 0);
    assert.equal(totalTurns, 3, 'replays collapse; turn3 is a conflict (excluded); 3 aggregateable turns remain');
    // IMMUTABLE OBSERVATION DAY: the replayed turns stay on their earliest day.
    assert.equal(w.recognition.days['2026-07-01'].turns, 2, 'replayed turns stay on their earliest observation day');
    assert.deepEqual(w.recognition.days['2026-07-01'].states, { 'tier-0-win': 1, 'rec-fail-tier-0': 1 });
    assert.equal(w.recognition.days['2026-07-08'].turns, 1, 'only the genuinely-new turn is first-observed 07-08');
    assert.deepEqual(w.recognition.days['2026-07-08'].states, { 'tier-0-win': 1 });
    assert.deepEqual(w.recognition.replay_dedupe, {
      rows_read: 7, rows_kept: 3, replays_dropped: 2, superseded_dropped: 0, conflicts: 1, unkeyed_kept: 0,
    }, 'dedupe stats ship as plain numbers; the conflict is counted, never a winner');
    assert.deepEqual(w.recognition.instrument_cohort, {
      schema_version: '1.0.0', classifier_version: '0.3.0', proxy_version: 2,
    }, 'the cohort the counts aggregate is stated');
    assert.deepEqual(w.recognition.coverage_gap, {
      rows_excluded: 1, versions: { 'schema=1.0.0 classifier=0.2.0 proxy=2': 1 },
    }, 'the out-of-cohort 0.2.0 row is an explicit gap');
    assert.equal(w.recognition.day_attribution, 'observation-day', 'attribution policy is stamped, not implicit');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("workspace recognition: Hale's mixed-instrument falsifier — an old-instrument survivor lands in the coverage gap, never the counts", () => {
  const root = mkdtempSync(join(tmpdir(), 'mp-cohort-'));
  try {
    const home = join(root, 'home');
    const clsDir = join(home, '.core', 'workspaces', 'ws-cohort', 'metrics', 'classified');
    mkdirSync(clsDir, { recursive: true });
    const ident = (over = {}) => ({
      schema_version: '1.0.0', classifier_version: '0.3.0', proxy_version: 2,
      harness: 'claude-code', provisional: true, session_id: 'sess-cohort', ...over,
    });
    writeFileSync(join(clsDir, '2026-07-08.jsonl'), [
      // 0.2.0-only observation: no newer counterpart, survives dedupe — must NOT be counted.
      JSON.stringify(ident({ turn_idx: 0, classifier_version: '0.2.0', state: 'tier-0-win' })),
      JSON.stringify(ident({ turn_idx: 1, state: 'rec-fail-tier-0' })),
    ].join('\n') + '\n');
    const w = workspaceMetrics(home, 'ws-cohort');
    assert.equal(w.recognition.available, true);
    assert.equal(w.recognition.days['2026-07-08'].turns, 1, 'only the current-cohort row counts');
    assert.deepEqual(w.recognition.days['2026-07-08'].states, { 'rec-fail-tier-0': 1 });
    assert.equal(w.recognition.replay_dedupe.rows_kept, 1, 'cohort-first: only the in-cohort row reaches dedupe');
    assert.deepEqual(w.recognition.coverage_gap, {
      rows_excluded: 1,
      versions: { 'schema=1.0.0 classifier=0.2.0 proxy=2': 1 },
    }, 'the excluded instrument is named and counted');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ACCEPTANCE Hale-2026-07-23 item 6 (package availability): an old-only store reports UNAVAILABLE-with-a-coverage-gap, never available-with-zero-turns', () => {
  const root = mkdtempSync(join(tmpdir(), 'mp-oldonly-'));
  try {
    const home = join(root, 'home');
    const clsDir = join(home, '.core', 'workspaces', 'ws-oldonly', 'metrics', 'classified');
    mkdirSync(clsDir, { recursive: true });
    // Every row is a retired 0.2.0 instrument — nothing in the current cohort.
    writeFileSync(join(clsDir, '2026-07-08.jsonl'), [
      JSON.stringify({ schema_version: '1.0.0', classifier_version: '0.2.0', proxy_version: 2, harness: 'claude-code', session_id: 'sess-old', turn_idx: 0, state: 'tier-0-win' }),
      JSON.stringify({ schema_version: '1.0.0', classifier_version: '0.2.0', proxy_version: 2, harness: 'claude-code', session_id: 'sess-old', turn_idx: 1, state: 'rec-fail-tier-0' }),
    ].join('\n') + '\n');
    const w = workspaceMetrics(home, 'ws-oldonly');
    assert.equal(w.recognition.available, false, 'no aggregateable cohort rows ⇒ unavailable, not available-with-zero-turns');
    assert.match(w.recognition.reason, /no in-cohort classified rows/);
    assert.deepEqual(w.recognition.days, {}, 'no day carries a phantom turns:0 entry');
    assert.deepEqual(w.recognition.coverage_gap, {
      rows_excluded: 2, versions: { 'schema=1.0.0 classifier=0.2.0 proxy=2': 2 },
    }, 'the coverage gap stays visible even when unavailable');
    assert.deepEqual(w.recognition.instrument_cohort, {
      schema_version: '1.0.0', classifier_version: '0.3.0', proxy_version: 2,
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── self-test results reaching the export package (holistic-redesign §3b/§5) ──

test('selfTestStats: unavailable with no log; whitelist-folds an unrecognized trigger and per-kind key', () => {
  const root = mkdtempSync(join(tmpdir(), 'mp-selftest-'));
  try {
    const project = join(root, 'proj');
    mkdirSync(join(project, '_memories'), { recursive: true });
    const absent = selfTestStats(project);
    assert.equal(absent.available, false);
    assert.match(absent.reason, /no self-test-log\.jsonl/);

    const sessions = join(project, '_sessions', '2026-07-24');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'self-test-log.jsonl'), [
      JSON.stringify({
        ts: '2026-07-24T10:00:00Z', kind: 'self-test-run', trigger: 'user-invoked', round: 1,
        corpus_snapshot_id: 'abc123', goldset_sha256: 'deadbeef',
        headline_arm: 'ranking', headline_k: 10, headline: 0.8,
        per_kind_r10: { literal: 1, category: 0.5, 'not-a-real-kind': 0.9 },
        trap_leak_rate: 0.25, old_vs_new_delta: 0.1, old_vs_new_skipped: false,
        n_queries: 12, store_units: 200,
      }),
      JSON.stringify({
        ts: '2026-07-24T11:00:00Z', kind: 'self-test-run', trigger: 'some-untrusted-value', round: 2,
        headline: 0.85, trap_leak_rate: 0, old_vs_new_skipped: true,
      }),
    ].join('\n') + '\n');

    const present = selfTestStats(project);
    assert.equal(present.available, true);
    assert.equal(present.runs_total, 2);
    assert.equal(present.rounds_seen, 2);
    assert.equal(present.latest_round, 2);
    assert.equal(present.latest_trigger, 'other', 'an unrecognized trigger folds to other, never passed through raw');
    assert.equal(present.latest_headline, 0.85);
    assert.equal(present.latest_trap_leak_rate, 0);

    const day = present.days['2026-07-24'];
    assert.equal(day.length, 2);
    assert.equal(day[0].trigger, 'user-invoked');
    assert.deepEqual(day[0].per_kind_r10, { literal: 1, category: 0.5 }, 'an unrecognized per-kind key is dropped, not passed through verbatim');
    assert.equal(day[0].corpus_snapshot_id, 'abc123');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('end-to-end: self-test results reach the package headline, a trap-leak flag, and both reports', () => {
  const root = mkdtempSync(join(tmpdir(), 'mp-selftest-e2e-'));
  try {
    const home = makeFixtureHome(root);
    const project = makeFixtureProject(root, { plant: false });
    const sessions = join(project, '_sessions', '2026-07-01');
    writeFileSync(join(sessions, 'self-test-log.jsonl'), JSON.stringify({
      ts: '2026-07-01T13:00:00Z', kind: 'self-test-run', trigger: 'auto-regrade', round: 3,
      corpus_snapshot_id: 'snap-xyz', goldset_sha256: 'gold-xyz',
      headline_arm: 'ranking', headline_k: 10, headline: 0.75,
      per_kind_r10: { literal: 1, value: 0.5 },
      trap_leak_rate: 0.5, old_vs_new_delta: null, old_vs_new_skipped: true,
      n_queries: 8, store_units: 40,
    }) + '\n');

    const result = runPackage([project, '--home', home, '--out', join(root, 'out')]);
    assert.ok(!result.error, `no fatal error: ${result.error}`);
    const extracted = readShippedPackage(result.shipped, join(root, 'x'));
    const projectDir = join(extracted, 'projects', readdirSync(join(extracted, 'projects'))[0]);

    const selfTest = JSON.parse(readFileSync(join(projectDir, 'self-test.json'), 'utf8'));
    assert.equal(selfTest.available, true);
    assert.equal(selfTest.latest_round, 3);
    assert.equal(selfTest.latest_headline, 0.75);
    assert.equal(selfTest.latest_trap_leak_rate, 0.5);

    const headline = JSON.parse(readFileSync(join(projectDir, 'headline.json'), 'utf8'));
    assert.equal(headline.self_test_latest_headline, 0.75);
    assert.equal(headline.self_test_latest_trap_leak_rate, 0.5);
    assert.ok(headline.flags.some(f => f.code === 'self-test-trap-leak'), 'a leaked trap raises a flag');

    const reportMd = readFileSync(join(extracted, 'REPORT.md'), 'utf8');
    assert.match(reportMd, /Self-test.*round 3.*auto-regrade/i);
    const reportHtml = readFileSync(join(extracted, 'report.html'), 'utf8');
    assert.match(reportHtml, /self-test headline/i);
    assert.match(reportHtml, /Round 3/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('project with no self-test round: package still ships, self-test.json is honestly unavailable, no flag raised', () => {
  const root = mkdtempSync(join(tmpdir(), 'mp-selftest-absent-'));
  try {
    const home = makeFixtureHome(root);
    const project = makeFixtureProject(root, { plant: false });
    const result = runPackage([project, '--home', home, '--out', join(root, 'out')]);
    assert.ok(!result.error, `no fatal error: ${result.error}`);
    const extracted = readShippedPackage(result.shipped, join(root, 'x'));
    const projectDir = join(extracted, 'projects', readdirSync(join(extracted, 'projects'))[0]);
    const selfTest = JSON.parse(readFileSync(join(projectDir, 'self-test.json'), 'utf8'));
    assert.equal(selfTest.available, false);
    assert.match(selfTest.reason, /no self-test-log\.jsonl/);
    const headline = JSON.parse(readFileSync(join(projectDir, 'headline.json'), 'utf8'));
    assert.equal(headline.self_test_latest_headline, undefined);
    assert.ok(!headline.flags.some(f => f.code === 'self-test-trap-leak'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
