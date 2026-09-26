import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildManifest } from '../../plugins/core/skills/core/scripts/migrate-workspace-state.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '../../plugins/core/skills/core/scripts/migrate-workspace-state.mjs');

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out[p] = createHash('sha256').update(readFileSync(p)).digest('hex') + ':' + st.mtimeMs;
    }
  };
  walk(dir);
  return out;
}

/**
 * A legacy ~/.core with every shape the classifier must handle.
 */
function fixture() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'migws-')));
  const home = join(base, 'home');
  const coreDir = join(home, '.core');
  const proj = (n) => { const p = join(home, 'Projects', n); mkdirSync(p, { recursive: true }); return p; };
  const ws = (id, files = {}) => {
    const d = join(coreDir, 'workspaces', id);
    mkdirSync(d, { recursive: true });
    for (const [f, c] of Object.entries(files)) {
      mkdirSync(dirname(join(d, f)), { recursive: true });
      writeFileSync(join(d, f), c);
    }
  };
  const P = proj('Pointed');
  writeFileSync(join(P, 'workspace.json'), JSON.stringify({ workspace_id: 'dup-a2' }));
  const Q = proj('Dated');
  const R = proj('Undated');
  const S = proj('Advisor');
  const T = proj('Fielded');
  const U = proj('Unmapped');
  const index = [
    { workspace_id: 'dup-a1', path: P }, { workspace_id: 'dup-a2', path: P },
    { workspace_id: 'dup-b1', path: Q }, { workspace_id: 'dup-b2', path: Q },
    { workspace_id: 'dup-c1', path: R }, { workspace_id: 'dup-c2', path: R },
    { workspace_id: 'advisor-codex', path: S },
    { workspace_id: 'fielded', path: T },
    { workspace_id: 'unmapped', path: U },
    { workspace_id: 'gone', path: join(home, 'Projects', 'Deleted') },
  ];
  mkdirSync(coreDir, { recursive: true });
  writeFileSync(join(coreDir, 'index.json'), JSON.stringify(index, null, 2));
  ws('dup-a1', { 'workspace.json': '{}' }); ws('dup-a2', { 'workspace.json': '{}' });
  ws('dup-b1', { 'last-active': '2026-09-01T00:00:00Z\n' }); ws('dup-b2', { 'last-active': '2026-09-20T00:00:00Z\n' });
  ws('dup-c1', { 'workspace.json': '{}' }); ws('dup-c2', { 'workspace.json': '{}' });
  ws('advisor-codex', { 'workspace.json': '{"agent_name":"Orion"}' });
  ws('fielded', { 'workspace.json': '{"harness":"muse"}' });
  ws('unmapped', { 'workspace.json': '{}' });
  ws('gone', { 'workspace.json': '{}' });
  ws('stray-with-data', { 'PROJECT.md': '# real content\n', 'drafts/hot.md': 'x' });
  ws('stray-empty', { 'last-active': '2026-01-01T00:00:00Z\n', 'visibility-canary.json': '{}' });
  const table = {
    version: 1,
    entries: {
      'dup-a1': { harness: 'claude-code', evidence: 'fixture' }, 'dup-a2': { harness: 'claude-code', evidence: 'fixture' },
      'dup-b1': { harness: 'codex', evidence: 'fixture' }, 'dup-b2': { harness: 'codex', evidence: 'fixture' },
      'dup-c1': { harness: 'claude-code', evidence: 'fixture' }, 'dup-c2': { harness: 'claude-code', evidence: 'fixture' },
      'advisor-codex': { harness: 'antigravity', evidence: 'agent is a Gemini advisor despite the id' },
      gone: { harness: 'codex', evidence: 'fixture' },
    },
  };
  return { base, coreDir, table, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const byId = (m) => Object.fromEntries(m.entries.map((e) => [e.workspace_id, e]));

test('duplicates: the project pointer names the live one, the other is superseded', () => {
  const f = fixture();
  try {
    const e = byId(buildManifest({ coreDir: f.coreDir, table: f.table }));
    assert.equal(e['dup-a2'].class, 'migrate');
    assert.equal(e['dup-a1'].class, 'supersede');
    assert.match(e['dup-a1'].reason, /pointer names dup-a2/);
  } finally { f.cleanup(); }
});

test('duplicates without a pointer: newer last-active wins; with no dates at all, both are held', () => {
  const f = fixture();
  try {
    const e = byId(buildManifest({ coreDir: f.coreDir, table: f.table }));
    assert.equal(e['dup-b2'].class, 'migrate');
    assert.equal(e['dup-b1'].class, 'supersede');
    assert.equal(e['dup-c1'].class, 'hold');
    assert.equal(e['dup-c2'].class, 'hold');
    assert.match(e['dup-c1'].reason, /duplicate-no-tiebreak/);
  } finally { f.cleanup(); }
});

test('the harness comes from the table, never from the id spelling', () => {
  const f = fixture();
  try {
    const e = byId(buildManifest({ coreDir: f.coreDir, table: f.table }));
    assert.equal(e['advisor-codex'].harness, 'antigravity');
    assert.equal(e['advisor-codex'].class, 'migrate');
  } finally { f.cleanup(); }
});

test('a workspace the table predates uses its recorded harness field; with neither, it is held', () => {
  const f = fixture();
  try {
    const e = byId(buildManifest({ coreDir: f.coreDir, table: f.table }));
    assert.equal(e.fielded.harness, 'muse');
    assert.equal(e.fielded.class, 'migrate');
    assert.equal(e.unmapped.harness, 'unknown');
    assert.equal(e.unmapped.class, 'hold');
    assert.equal(e.unmapped.reason, 'harness-unknown');
  } finally { f.cleanup(); }
});

test('orphans: a gone path, an unregistered folder with data, an unregistered folder with only bookkeeping', () => {
  const f = fixture();
  try {
    const m = buildManifest({ coreDir: f.coreDir, table: f.table });
    const e = byId(m);
    assert.equal(e.gone.class, 'orphan-gone');
    assert.equal(e['stray-with-data'].class, 'orphan-unregistered');
    assert.equal(e['stray-with-data'].data_files, 2);
    assert.equal(e['stray-empty'].class, 'empty');
    const flaggedIds = m.flagged.map((x) => x.workspace_id).sort();
    assert.deepEqual(flaggedIds, ['dup-c1', 'dup-c2', 'stray-with-data', 'unmapped']);
    const total = Object.values(m.counts).reduce((a, b) => a + b, 0);
    assert.equal(total, m.entries.length);
  } finally { f.cleanup(); }
});

test('building the manifest writes nothing under ~/.core', () => {
  const f = fixture();
  try {
    const before = snapshot(f.coreDir);
    buildManifest({ coreDir: f.coreDir, table: f.table });
    assert.deepEqual(snapshot(f.coreDir), before);
  } finally { f.cleanup(); }
});

test('CLI --manifest --out writes the manifest and exits 0; a bad argument exits 2', () => {
  const f = fixture();
  try {
    const tableFile = join(f.base, 'table.json');
    writeFileSync(tableFile, JSON.stringify(f.table));
    const out = join(f.base, 'manifest.json');
    execFileSync(process.execPath, [SCRIPT, '--manifest', '--core-dir', f.coreDir, '--table', tableFile, '--out', out]);
    const m = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(m.table_version, 1);
    assert.equal(m.entries.length, 12);
    assert.throws(() => execFileSync(process.execPath, [SCRIPT, '--bogus'], { stdio: 'pipe' }), (err) => err.status === 2);
  } finally { f.cleanup(); }
});
