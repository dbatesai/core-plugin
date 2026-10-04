// Restore continuity: adoption keeps the original manifest as inert history, carries typed
// descriptive data (notes, name, created, session refs), and lets the same restore's second
// harness be adopted after the first registers the root — and nothing else on a registered root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, realpathSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerProject } from '../../plugins/core/skills/core/scripts/index-registry.mjs';
import { readManifest, updateManifest, adoptionCandidate, adoptForeignState } from '../../plugins/core/skills/core/scripts/project-state.mjs';

const NOTES = { 'claude-code': 'Prefers plain voice. Watch the Q3 budget thread.', codex: 'Runs the review seat; reads _outputs first.' };

function sandbox() {
  const base = realpathSync(realpathSync.native(mkdtempSync(join(tmpdir(), 'adopt-cont-'))));
  const home = (n) => { const h = join(base, n); mkdirSync(join(h, '.core'), { recursive: true }); return join(h, '.core'); };
  return { base, home, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** One project worked through both harnesses under install A, restored at a new path under install B. */
function restoredTwoHarness(s, extra = {}) {
  const coreA = s.home('homeA');
  const original = join(s.base, 'Old', 'Garden');
  mkdirSync(original, { recursive: true });
  registerProject(coreA, original);
  const ids = {};
  for (const h of ['claude-code', 'codex']) {
    ids[h] = updateManifest({ root: original, harness: h, coreDir: coreA, fields: {
      agent_name: 'Wren', name: 'Garden', created: '2026-05-01', agent_notes: NOTES[h],
      session_log_refs: [`${original}/_sessions/2026-09-20/log.md`], ...(extra[h] || {}) } }).project_id;
  }
  const originals = Object.fromEntries(['claude-code', 'codex'].map(h => [h, readFileSync(join(original, '.core', h, 'workspace.json'))]));
  const coreB = s.home('homeB');
  const restored = join(s.base, 'New', 'Garden');
  cpSync(original, restored, { recursive: true });
  rmSync(original, { recursive: true, force: true });
  return { coreB, restored, ids, originals };
}

const archived = (root, h) => {
  const dir = join(root, '.core', h, 'superseded');
  const sub = readdirSync(dir).filter(n => n.startsWith('adopted-'));
  assert.equal(sub.length, 1, `${h}: exactly one adoption archive`);
  return readFileSync(join(dir, sub[0], 'workspace.json'));
};

for (const order of [['codex', 'claude-code'], ['claude-code', 'codex']]) {
  test(`both harnesses of one restore are adopted (${order.join(' then ')}), notes kept, originals archived byte-identical`, () => {
    const s = sandbox();
    try {
      const { coreB, restored, ids, originals } = restoredTwoHarness(s);
      for (const h of order) {
        assert.ok(adoptionCandidate({ root: restored, harness: h, coreDir: coreB }), `${h} is offered`);
        const r = adoptForeignState({ root: restored, harness: h, coreDir: coreB, decision: 'yes' });
        assert.equal(r.status, 'adopted', h);
        assert.deepEqual(r.not_imported, []);
      }
      for (const h of order) {
        const m = readManifest({ root: restored, harness: h, coreDir: coreB });
        assert.equal(m.project_id, ids[h], `${h}: its own project id is preserved`);
        assert.equal(m.agent_notes, NOTES[h], `${h}: notes carried`);
        assert.equal(m.name, 'Garden');
        assert.equal(m.created, '2026-05-01');
        assert.equal(m.session_log_refs.length, 1);
        assert.ok(archived(restored, h).equals(originals[h]), `${h}: original manifest archived byte for byte`);
        assert.equal(adoptionCandidate({ root: restored, harness: h, coreDir: coreB }), null, `${h}: adopted once, never offered again`);
      }
    } finally { s.cleanup(); }
  });
}

test('on a registered root, foreign state from a different install is not a candidate', () => {
  const s = sandbox();
  try {
    const { coreB, restored } = restoredTwoHarness(s);
    assert.equal(adoptForeignState({ root: restored, harness: 'claude-code', coreDir: coreB, decision: 'yes' }).status, 'adopted');
    // a third install writes this project's codex state (a synced folder another machine is using)
    const coreC = s.home('homeC');
    rmSync(join(restored, '.core', 'codex'), { recursive: true, force: true });
    const elsewhere = join(s.base, 'Elsewhere', 'Garden');
    mkdirSync(elsewhere, { recursive: true });
    registerProject(coreC, elsewhere);
    updateManifest({ root: elsewhere, harness: 'codex', coreDir: coreC, fields: { agent_notes: 'from install C' } });
    cpSync(join(elsewhere, '.core', 'codex'), join(restored, '.core', 'codex'), { recursive: true });
    assert.equal(adoptionCandidate({ root: restored, harness: 'codex', coreDir: coreB }), null);
    assert.equal(adoptForeignState({ root: restored, harness: 'codex', coreDir: coreB, decision: 'yes' }).status, 'not-a-candidate');
  } finally { s.cleanup(); }
});

test('a hostile manifest: controls unchanged, extra keys only in the archive, wrong-typed data named and not coerced', () => {
  const s = sandbox();
  try {
    const bad = { agent_notes: 42, created: 'yesterday', name: 'x\u0007y', session_log_refs: 'not-a-list', metrics_enabled: true, trusted_exec: 'rm -rf ~' };
    const { coreB, restored } = restoredTwoHarness(s, { 'claude-code': bad });
    const r = adoptForeignState({ root: restored, harness: 'claude-code', coreDir: coreB, decision: 'yes' });
    assert.equal(r.status, 'adopted');
    assert.deepEqual(r.not_imported.sort(), ['agent_notes', 'created', 'name', 'session_log_refs']);
    const m = readManifest({ root: restored, harness: 'claude-code', coreDir: coreB });
    for (const k of ['agent_notes', 'created', 'name', 'session_log_refs', 'trusted_exec']) assert.equal(k in m, false, `${k} not in the signed manifest`);
    assert.equal(m.metrics_enabled, undefined, 'an opt-in never travels');
    assert.match(archived(restored, 'claude-code').toString(), /trusted_exec/, 'the original survives, inert, in the archive');
  } finally { s.cleanup(); }
});
