import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runMaintenance } from '../../plugins/core/skills/core/scripts/maintenance-run.mjs';
import { hashText } from '../../plugins/core/skills/core/scripts/state-cache.mjs';

const MAINT_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'scripts', 'maintenance-run.mjs');

// Isolated HOME so the state-cache global-prune step never touches the real
// developer ~/.core during tests (mirrors decorate-graph.test.mjs / hot-section.test.mjs).
function testHome(root) {
  const home = join(root, 'home');
  mkdirSync(join(home, '.core'), { recursive: true });
  return home;
}

// DC-110 M1: mechanical maintenance is signature-gated (regen only when units changed),
// narrated (never silent), and ledger-recorded (the cadence data for the M2 observe step).

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'core-maint-'));
  mkdirSync(join(root, '_memories'), { recursive: true });
  return root;
}
function writeUnit(root, id, { type = 'observation', status, title, mtime } = {}) {
  const fm = ['---', `id: ${id}`, `type: ${type}`];
  if (status) fm.push(`status: ${status}`);
  fm.push('---', '', `# ${title || id}`, '');
  const p = join(root, '_memories', `${id}.md`);
  writeFileSync(p, fm.join('\n'));
  if (mtime) utimesSync(p, mtime, mtime);
  return p;
}

test('first run regenerates indexes, writes the ledger, and narrates what ran', () => {
  const root = makeProject();
  writeUnit(root, 'dc-1-foo', { type: 'decision', title: 'A decision', mtime: 1000 });
  writeUnit(root, 'risk-1-bar', { type: 'risk', title: 'A risk', mtime: 1000 });
  const res = runMaintenance(root, { now: '2026-06-28T00:00:00Z' });
  assert.ok(res.unitsChanged, 'first run sees changes');
  assert.ok(existsSync(join(root, '_memories', 'INDEX-decisions.md')));
  assert.ok(existsSync(join(root, '_memories', 'INDEX-risks.md')));
  assert.ok(existsSync(join(root, '_memories', '_lib', 'unit-summaries.json')));
  const ledger = JSON.parse(readFileSync(join(root, '_memories', '_maintenance-state.json'), 'utf8'));
  assert.strictEqual(ledger.last_run, '2026-06-28T00:00:00Z');
  assert.ok(ledger.last_sig.length > 0);
  assert.strictEqual(ledger.ops['decisions-index'].run_count, 1);
  assert.match(res.narration, /Kept memory current/);
});

test('an unchanged store is a no-op: no regen, narrates "already current"', () => {
  const root = makeProject();
  writeUnit(root, 'dc-1-foo', { type: 'decision', title: 'A decision', mtime: 1000 });
  runMaintenance(root, { now: '2026-06-28T00:00:00Z' });
  const idxPath = join(root, '_memories', 'INDEX-decisions.md');
  const firstMtime = statSync(idxPath).mtimeMs;
  const res = runMaintenance(root, { now: '2026-06-28T01:00:00Z' });
  assert.strictEqual(res.unitsChanged, false);
  assert.strictEqual(statSync(idxPath).mtimeMs, firstMtime, 'index not rewritten when nothing changed');
  assert.match(res.narration, /already current/);
});

test('a changed unit re-triggers regeneration', () => {
  const root = makeProject();
  writeUnit(root, 'dc-1-foo', { type: 'decision', title: 'A decision', mtime: 1000 });
  runMaintenance(root, { now: '2026-06-28T00:00:00Z' });
  writeUnit(root, 'dc-2-new', { type: 'decision', title: 'Another decision', mtime: 2000 });
  const res = runMaintenance(root, { now: '2026-06-28T02:00:00Z' });
  assert.ok(res.unitsChanged, 'new unit retriggers');
  const ledger = JSON.parse(readFileSync(join(root, '_memories', '_maintenance-state.json'), 'utf8'));
  assert.strictEqual(ledger.ops['decisions-index'].run_count, 2);
});

test('ghost duplicates are cleaned, and the run is reported', () => {
  const root = makeProject();
  writeUnit(root, 'dc-1-foo', { type: 'decision', title: 'A decision', mtime: 1000 });
  // Exact-duplicate ghost.
  const orig = readFileSync(join(root, '_memories', 'dc-1-foo.md'), 'utf8');
  writeFileSync(join(root, '_memories', 'dc-1-foo 2.md'), orig);
  const res = runMaintenance(root, { now: '2026-06-28T00:00:00Z' });
  assert.ok(!existsSync(join(root, '_memories', 'dc-1-foo 2.md')), 'identical ghost removed');
  assert.ok(res.ranOps.includes('ghost-cleanup'));
  assert.match(res.narration, /ghost/);
});

test('a differing ghost is NOT removed (verification-before-delete)', () => {
  const root = makeProject();
  writeUnit(root, 'dc-1-foo', { type: 'decision', title: 'A decision', mtime: 1000 });
  writeFileSync(join(root, '_memories', 'dc-1-foo 2.md'), 'genuinely different content');
  runMaintenance(root, { now: '2026-06-28T00:00:00Z' });
  assert.ok(existsSync(join(root, '_memories', 'dc-1-foo 2.md')), 'differing ghost preserved for human review');
});

test('PROJECT.md over the soft cap is surfaced as a note', () => {
  const root = makeProject();
  writeUnit(root, 'dc-1-foo', { type: 'decision', title: 'A decision', mtime: 1000 });
  writeFileSync(join(root, 'PROJECT.md'), 'x'.repeat(71000));
  const res = runMaintenance(root, { now: '2026-06-28T00:00:00Z' });
  assert.ok(res.notes.some(n => /over the .* soft cap/.test(n)), 'over-cap surfaced');
  assert.match(res.narration, /Heads up/);
});

test('dry-run does not write the ledger or indexes', () => {
  const root = makeProject();
  writeUnit(root, 'dc-1-foo', { type: 'decision', title: 'A decision', mtime: 1000 });
  const res = runMaintenance(root, { apply: false, now: '2026-06-28T00:00:00Z' });
  assert.ok(!existsSync(join(root, '_memories', '_maintenance-state.json')), 'no ledger on dry-run');
  assert.ok(!existsSync(join(root, '_memories', 'INDEX-decisions.md')), 'no index on dry-run');
  assert.ok(res.ranOps.length > 0, 'still reports what it would do');
});

// ---- state-cache stamping (Hale's finding, 2026-07-22): maintenance-run
// writes INDEX-decisions.md, INDEX-risks.md, and the summary index on the
// user's behalf — those writes must be stamped in code, same pattern as
// decorate-graph.mjs and hot-section.mjs, so edit-detection never
// misclassifies them as a between-session user edit. ----

test('runMaintenance stamps the state cache for every generated file it writes, with the correct new hash', () => {
  const root = makeProject();
  const home = testHome(root);
  writeUnit(root, 'dc-1-foo', { type: 'decision', title: 'A decision', mtime: 1000 });
  writeUnit(root, 'risk-1-bar', { type: 'risk', title: 'A risk', mtime: 1000 });
  runMaintenance(root, { now: '2026-06-28T00:00:00Z', home });

  const cachePath = join(root, '_memories', '_lib', 'state-cache.json');
  const cache = JSON.parse(readFileSync(cachePath, 'utf8'));

  const decisionsPath = join(root, '_memories', 'INDEX-decisions.md');
  const risksPath = join(root, '_memories', 'INDEX-risks.md');
  const summaryPath = join(root, '_memories', '_lib', 'unit-summaries.json');

  for (const p of [decisionsPath, risksPath, summaryPath]) {
    const entry = cache.files[p];
    assert.ok(entry, `${p} has a state-cache entry after runMaintenance`);
    assert.equal(entry.last_written_by, 'maintenance-run', `${p} stamped as CORE-authored`);
    assert.equal(entry.last_written, '2026-06-28T00:00:00Z');
    assert.equal(entry.last_hash, hashText(readFileSync(p, 'utf8')), `${p} cached hash matches the actual on-disk bytes`);
  }
});

test('an unchanged store does not re-stamp the state cache (no regen ran, nothing to stamp)', () => {
  const root = makeProject();
  const home = testHome(root);
  writeUnit(root, 'dc-1-foo', { type: 'decision', title: 'A decision', mtime: 1000 });
  runMaintenance(root, { now: '2026-06-28T00:00:00Z', home });
  const cachePath = join(root, '_memories', '_lib', 'state-cache.json');
  const firstStamp = JSON.parse(readFileSync(cachePath, 'utf8')).files[join(root, '_memories', 'INDEX-decisions.md')].last_written;

  const res = runMaintenance(root, { now: '2026-06-28T01:00:00Z', home });
  assert.strictEqual(res.unitsChanged, false, 'sanity: nothing changed, so no regen ran');
  const secondStamp = JSON.parse(readFileSync(cachePath, 'utf8')).files[join(root, '_memories', 'INDEX-decisions.md')].last_written;
  assert.equal(secondStamp, firstStamp, 'the cache entry is untouched when the underlying file was never rewritten');
});

test('dry-run does not write the state cache either', () => {
  const root = makeProject();
  const home = testHome(root);
  writeUnit(root, 'dc-1-foo', { type: 'decision', title: 'A decision', mtime: 1000 });
  runMaintenance(root, { apply: false, now: '2026-06-28T00:00:00Z', home });
  assert.ok(!existsSync(join(root, '_memories', '_lib', 'state-cache.json')), 'dry run must not stamp — nothing was actually written');
});

// ---- rich-context retention (opt-in stream), wired into the op sequence ----

function plantRichContext(root, dateName) {
  const dir = join(root, '_metrics', 'rich-context');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${dateName}.jsonl`);
  writeFileSync(file, JSON.stringify({ kind: 'rich-context', schema_version: '1.0.0', query_text: 'q' }) + '\n');
  return file;
}

test('maintenance retention: dry-run reports old rich-context files but deletes nothing', () => {
  const root = makeProject();
  const home = testHome(root);
  writeUnit(root, 'dc-1-foo', { type: 'decision', title: 'A decision', mtime: 1000 });
  const oldFile = plantRichContext(root, '2020-01-01');
  const res = runMaintenance(root, { apply: false, now: '2026-06-28T00:00:00Z', home });
  assert.ok(res.notes.some((n) => /rich-context retention \(dry-run\).*would be deleted/.test(n)), 'dry-run surfaces the pending deletion');
  assert.ok(existsSync(oldFile), 'dry-run deletes nothing');
});

test('maintenance retention: apply deletes old rich-context rows, keeps recent, narrates it', () => {
  const root = makeProject();
  const home = testHome(root);
  writeUnit(root, 'dc-1-foo', { type: 'decision', title: 'A decision', mtime: 1000 });
  const oldFile = plantRichContext(root, '2020-01-01');
  const recentFile = plantRichContext(root, '2099-01-01');
  const res = runMaintenance(root, { apply: true, now: '2026-06-28T00:00:00Z', home });
  assert.ok(!existsSync(oldFile), 'old rich-context row deleted');
  assert.ok(existsSync(recentFile), 'recent rich-context row kept');
  assert.ok(res.notes.some((n) => /rich-context retention: deleted 1 row file/.test(n)), 'the deletion is narrated with a proof count');
});

test('--purge-rich-context CLI removes the whole stream dir and nothing else', () => {
  const root = makeProject();
  writeUnit(root, 'dc-1-foo', { type: 'decision', title: 'A decision', mtime: 1000 });
  const richDir = join(root, '_metrics', 'rich-context');
  plantRichContext(root, '2026-06-01');
  // dry-run first: reports, deletes nothing
  const dry = execFileSync(process.execPath, [MAINT_SCRIPT, root, '--purge-rich-context', '--dry-run'], { encoding: 'utf8' });
  assert.match(dry, /Would purge/);
  assert.ok(existsSync(richDir), 'dry-run purge deletes nothing');
  // real purge
  const out = execFileSync(process.execPath, [MAINT_SCRIPT, root, '--purge-rich-context'], { encoding: 'utf8' });
  assert.match(out, /Purged the rich-context capture stream/);
  assert.ok(!existsSync(richDir), 'stream dir removed');
  assert.ok(existsSync(join(root, '_memories')), 'memory store untouched');
});
