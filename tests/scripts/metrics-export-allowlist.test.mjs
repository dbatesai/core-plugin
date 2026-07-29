import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trustedTestTmpRoot } from './trusted-test-tmp.mjs';
import {
  runPackage, enforceExportAllowlist, EXPORT_SCHEMAS,
} from '../../plugins/core/skills/core/scripts/metrics-package.mjs';
import { logEvent } from '../../plugins/core/skills/core/scripts/log-event.mjs';

// One distinctive token. If any exported byte contains it, the allowlist leaked.
const SECRET = 'HunterPlantedSecret9137';

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

function readShipped(shipped, dest) {
  if (shipped.kind === 'folder') return shipped.path;
  mkdirSync(dest, { recursive: true });
  const res = spawnSync('tar', ['-x', '-f', basename(shipped.path), '-C', dest], { cwd: dirname(shipped.path), encoding: 'utf8' });
  assert.equal(res.status, 0, `zip extracts (status=${res.status})`);
  return dest;
}

function makeProject(root) {
  const project = join(root, 'proj');
  const store = join(project, '_memories');
  mkdirSync(store, { recursive: true });
  writeFileSync(join(project, 'workspace.json'), JSON.stringify({ workspace_id: 'export-allowlist-ws' }));
  writeFileSync(join(project, 'PROJECT.md'), '# P\n');
  writeFileSync(join(store, 'dc-1.md'), '---\nid: dc-1\ntype: decision\nstatus: active\ncreated: 2026-06-01\nedges:\n  - {to: risk-1, type: cites}\n---\n\nBody.\n');
  writeFileSync(join(store, 'risk-1.md'), '---\nid: risk-1\ntype: risk\nstatus: active\ncreated: 2026-06-02\n---\n\nBody.\n');
  return project;
}

function makeHome(root) {
  const home = join(root, 'home');
  mkdirSync(join(home, '.core'), { recursive: true });
  mkdirSync(join(home, 'Desktop'), { recursive: true });
  return home;
}

test('a nested sensitive value riding a self-test row never reaches the exported bytes', () => {
  const root = mkdtempSync(join(trustedTestTmpRoot(), 'export-allowlist-a-'));
  try {
    const project = makeProject(root);
    const home = makeHome(root);
    const sessions = join(project, '_sessions', '2026-07-01');
    mkdirSync(sessions, { recursive: true });
    // The producer writes a sha256 here; the exporter accepted any string, so a
    // structured value placed on the row rode straight through.
    writeFileSync(join(sessions, 'self-test-log.jsonl'), JSON.stringify({
      kind: 'self-test-run',
      trigger: 'user-invoked',
      round: 1,
      corpus_snapshot_id: JSON.stringify({ note: { password: SECRET } }),
      goldset_sha256: `sha-${SECRET}`,
      headline: 0.8,
      per_kind_r10: { literal: 0.9 },
      trap_leak_rate: 0,
      old_vs_new_delta: null,
      old_vs_new_skipped: true,
      n_queries: 10,
      store_units: 2,
    }) + '\n');

    const result = runPackage([project, '--out', join(root, 'out'), '--home', home]);
    assert.ok(result.shipped, `package shipped (${result.error || ''})`);
    const text = readAllPackageText(readShipped(result.shipped, join(root, 'x')));
    assert.ok(!text.includes(SECRET), 'no exported byte carries the planted value');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a nested overlay field on a captured retrieval row never reaches the exported bytes', () => {
  const root = mkdtempSync(join(trustedTestTmpRoot(), 'export-allowlist-b-'));
  try {
    const project = makeProject(root);
    const home = makeHome(root);
    // The shared event door preserves arbitrary overlay fields verbatim; the
    // export boundary is what has to stop them.
    logEvent(project, 'retrieval-log.jsonl', {
      kind: 'retrieval',
      retrieval_id: 'r-1',
      tier_reached: 1,
      units_retrieved: [{ id: 'dc-1' }],
      note: { password: SECRET },
      trace: { nested: { deeper: [{ leaked: SECRET }] } },
    });

    const result = runPackage([project, '--out', join(root, 'out'), '--home', home]);
    assert.ok(result.shipped, `package shipped (${result.error || ''})`);
    const text = readAllPackageText(readShipped(result.shipped, join(root, 'x')));
    assert.ok(!text.includes(SECRET), 'no exported byte carries the planted overlay value');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('enforceExportAllowlist drops unknown fields at every depth and counts them', () => {
  const block = {
    available: true,
    _trust: 'direct',
    _trust_basis: 'store walk',
    units_total: 3,
    units_active: 2,
    by_type: { decision: 2, sneaky: 1 },
    surprise: { note: { password: SECRET } },
  };
  const { value, dropped } = enforceExportAllowlist(block, EXPORT_SCHEMAS['store-census']);
  assert.equal(value.units_total, 3);
  assert.equal(value.by_type.decision, 2);
  assert.ok(!('surprise' in value), 'unknown top-level key dropped');
  assert.ok(!JSON.stringify(value).includes(SECRET), 'nested value cannot survive its dropped parent');
  assert.ok(dropped >= 2, `unknown fields counted (got ${dropped})`);
});

test('a nested unknown under a known key is dropped without dropping its siblings', () => {
  const block = {
    available: true,
    _trust: 'direct',
    _trust_basis: 'store walk',
    units_total: 3,
    created_by_month: { '2026-06': 2, 'not-a-month': 1 },
  };
  const { value, dropped } = enforceExportAllowlist(block, EXPORT_SCHEMAS['store-census']);
  assert.equal(value.units_total, 3);
  assert.deepEqual(value.created_by_month, { '2026-06': 2 });
  assert.equal(dropped, 1);
});

test('every exported block name has a declared schema', () => {
  for (const name of ['retrieval-stats', 'hygiene-stats', 'store-census', 'validator',
    'project-md', 'maintenance', 'workspace-metrics', 'self-test', 'headline', 'manifest']) {
    assert.ok(EXPORT_SCHEMAS[name], `${name} has an export schema`);
  }
});

test('the manifest discloses how many fields the allowlist dropped', () => {
  const root = mkdtempSync(join(trustedTestTmpRoot(), 'export-allowlist-c-'));
  try {
    const project = makeProject(root);
    const home = makeHome(root);
    const sessions = join(project, '_sessions', '2026-07-01');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'self-test-log.jsonl'), JSON.stringify({
      kind: 'self-test-run', trigger: 'user-invoked', round: 1,
      corpus_snapshot_id: `bad-${SECRET}`, headline: 0.5,
    }) + '\n');
    const result = runPackage([project, '--out', join(root, 'out'), '--home', home]);
    const extracted = readShipped(result.shipped, join(root, 'x'));
    const manifest = JSON.parse(readFileSync(join(extracted, 'manifest.json'), 'utf8'));
    assert.ok(manifest.field_policy, 'manifest carries the field policy');
    assert.equal(manifest.field_policy.enforcement, 'allowlist');
    assert.ok(manifest.field_policy.dropped_fields >= 1, 'the drop is disclosed, not silent');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
