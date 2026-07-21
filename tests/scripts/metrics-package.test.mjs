import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { trustedTestTmpRoot } from './trusted-test-tmp.mjs';
import {
  runPackage, loadOrCreateSalt, makeSeal, storeCensus, retrievalStats,
  buildLeakPatterns, leakScanDir, verifyZipMagic, zipStaging,
} from '../../plugins/core/skills/core/scripts/metrics-package.mjs';

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
    // Diagnostic-only addition (2026-07-17): a pre-existing Windows-only failure
    // here has always reported a bare 'folder' !== 'zip' with the underlying
    // zipStaging() failure reason discarded. Surfacing it so the NEXT
    // Windows CI run names the real tar failure instead of leaving it unknown.
    assert.equal(result.shipped.kind, 'zip', `shipped=${JSON.stringify(result.shipped)}`);
    const text = readAllPackageText(extractZip(result.shipped.path, join(root, 'x')));
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
    writeFileSync(join(classified, '2026-07-01.jsonl'), `${JSON.stringify({ state: 'tier-0-win', provisional: true })}\n`);
    writeFileSync(join(classified, '2026-07-08.jsonl'), `${JSON.stringify({ state: 'rec-fail-tier-0', provisional: false })}\n`);
    const result = runPackage([project, '--home', home, '--out', join(root, 'out')]);
    const extracted = extractZip(result.shipped.path, join(root, 'x'));
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
    const text = readAllPackageText(extractZip(result.shipped.path, join(root, 'x')));
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
