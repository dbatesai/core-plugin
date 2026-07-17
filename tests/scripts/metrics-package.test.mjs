import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  runPackage, loadOrCreateSalt, makeSeal, storeCensus, retrievalStats,
  buildLeakPatterns, leakScanDir,
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
  const res = spawnSync('tar', ['-x', '-f', zipPath, '-C', dest], { encoding: 'utf8' });
  assert.equal(res.status, 0, 'zip extracts');
  return dest;
}

test('package never contains planted names, paths, topics, or raw unit ids', () => {
  const root = mkdtempSync(join(tmpdir(), 'mp-test-'));
  try {
    const home = makeFixtureHome(root);
    const project = makeFixtureProject(root, { plant: true });
    const result = runPackage([project, '--home', home, '--out', join(root, 'out')]);
    assert.ok(!result.error, `no fatal error: ${result.error}`);
    assert.equal(result.shipped.kind, 'zip');
    const text = readAllPackageText(extractZip(result.shipped.path, join(root, 'x')));
    for (const tripwire of [PLANT_NAME, PLANT_PATH, PLANT_TOPIC, 'plantedusr', 'dc-1-linked', 'fixture-ws-alpha', home]) {
      assert.ok(!text.includes(tripwire), `tripwire must not appear: ${tripwire}`);
    }
    // and the stats themselves are real: 2 events, 1 miss, tier histogram present
    assert.match(text, /"events": 2/);
    assert.match(text, /"misses": 1/);
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

test('orphan rate counts active units only; archived orphans excluded', () => {
  const root = mkdtempSync(join(tmpdir(), 'mp-census-'));
  try {
    const project = makeFixtureProject(root, { plant: false });
    const census = storeCensus(project);
    assert.equal(census.available, true);
    assert.equal(census.units_total, 4);
    assert.equal(census.units_active, 3);
    assert.equal(census.orphans, 1, 'only the active orphan counts');
    assert.equal(census.orphan_rate, 0.333);
  } finally { rmSync(root, { recursive: true, force: true }); }
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
    const day = stats.days['2026-07-01'];
    assert.equal(day.events, 2);
    assert.deepEqual(day.tiers, { 1: 1, 3: 1 });
    assert.equal(day.suppressed.retired, 1);
    assert.equal(stats.top_retrieved_units.length, 1);
    assert.match(stats.top_retrieved_units[0].unit, /^unit-[0-9a-f]{12}$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
