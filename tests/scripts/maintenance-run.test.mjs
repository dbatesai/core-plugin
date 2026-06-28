import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMaintenance } from '../../plugins/core/skills/core/scripts/maintenance-run.mjs';

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
