// Restore continuity: adoption keeps the original manifest as inert history, carries typed
// descriptive data (notes, name, created, session refs), and lets the same restore's second
// harness be adopted after the first registers the root — and nothing else on a registered root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, realpathSync, cpSync, existsSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { registerProject } from '../../plugins/core/skills/core/scripts/index-registry.mjs';
import { readManifest, updateManifest, adoptionCandidate, adoptForeignState, localRootKey } from '../../plugins/core/skills/core/scripts/project-state.mjs';

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
  const originals = Object.fromEntries(['claude-code', 'codex'].map(h => [h, readFileSync(join(original, '_core', h, 'workspace.json'))]));
  const coreB = s.home('homeB');
  const restored = join(s.base, 'New', 'Garden');
  cpSync(original, restored, { recursive: true });
  rmSync(original, { recursive: true, force: true });
  return { coreB, restored, ids, originals };
}

const archived = (root, h) => {
  const dir = join(root, '_core', h, 'superseded');
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
    rmSync(join(restored, '_core', 'codex'), { recursive: true, force: true });
    const elsewhere = join(s.base, 'Elsewhere', 'Garden');
    mkdirSync(elsewhere, { recursive: true });
    registerProject(coreC, elsewhere);
    updateManifest({ root: elsewhere, harness: 'codex', coreDir: coreC, fields: { agent_notes: 'from install C' } });
    cpSync(join(elsewhere, '_core', 'codex'), join(restored, '_core', 'codex'), { recursive: true });
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

test('the second-harness offer is bound to the stamp that arrived with the restore, not to a copyable install id', () => {
  const s = sandbox();
  try {
    const { coreB, restored } = restoredTwoHarness(s);
    assert.equal(adoptForeignState({ root: restored, harness: 'claude-code', coreDir: coreB, decision: 'yes' }).status, 'adopted');
    // install A (same install id) writes fresh codex state elsewhere; it is planted over the restored codex state
    const coreA = join(s.base, 'homeA', '.core');
    const other = join(s.base, 'Other', 'Garden');
    mkdirSync(other, { recursive: true });
    registerProject(coreA, other);
    updateManifest({ root: other, harness: 'codex', coreDir: coreA, fields: { agent_notes: 'planted later' } });
    rmSync(join(restored, '_core', 'codex'), { recursive: true, force: true });
    cpSync(join(other, '_core', 'codex'), join(restored, '_core', 'codex'), { recursive: true });
    assert.equal(adoptionCandidate({ root: restored, harness: 'codex', coreDir: coreB }), null, 'same install id, different stamp bytes: not offered');
  } finally { s.cleanup(); }
});

test('a symlinked manifest is not archived (named) and its target bytes never enter the project; a linked superseded/ holds adoption', () => {
  const s = sandbox();
  try {
    const { coreB, restored } = restoredTwoHarness(s);
    if (process.platform !== 'win32') {   // an unprivileged Windows user can't create a file symlink
    const secret = join(s.base, 'secret.json');
    writeFileSync(secret, JSON.stringify({ agent_name: 'PRIVATE-KEY-MATERIAL', agent_notes: 'PRIVATE-KEY-MATERIAL', project_id: 'stolen' }));
    const m = join(restored, '_core', 'claude-code', 'workspace.json');
    rmSync(m); symlinkSync(secret, m);
    const r = adoptForeignState({ root: restored, harness: 'claude-code', coreDir: coreB, decision: 'yes' });
    assert.ok(r.not_archived.includes('workspace.json'), JSON.stringify(r));
    const signed = readManifest({ root: restored, harness: 'claude-code', coreDir: coreB }) || {};
    assert.doesNotMatch(JSON.stringify(signed), /PRIVATE-KEY-MATERIAL|stolen/, 'the link target never reaches the signed manifest');
    const dir = join(restored, '_core', 'claude-code', 'superseded');
    for (const sub of readdirSync(dir)) for (const f of readdirSync(join(dir, sub))) assert.doesNotMatch(readFileSync(join(dir, sub, f), 'utf8'), /PRIVATE-KEY-MATERIAL/);
    }

    const s2 = sandbox();
    try {
      const t = restoredTwoHarness(s2);
      const outside = join(s2.base, 'outside');
      mkdirSync(outside);
      symlinkSync(outside, join(t.restored, '_core', 'codex', 'superseded'), process.platform === 'win32' ? 'junction' : 'dir');
      const r2 = adoptForeignState({ root: t.restored, harness: 'codex', coreDir: t.coreB, decision: 'yes' });
      assert.equal(r2.status, 'held');
      assert.deepEqual(readdirSync(outside), [], 'nothing written through the link');
    } finally { s2.cleanup(); }
  } finally { s.cleanup(); }
});

test('a failure before the commit (sibling record unwritable) leaves both harnesses adoptable on retry, with their notes', () => {
  const s = sandbox();
  try {
    const { coreB, restored } = restoredTwoHarness(s);
    const record = join(coreB, 'local', localRootKey(restored), 'adopted-sibling-stamps');
    mkdirSync(record, { recursive: true });                       // a directory where the record goes: the append fails
    assert.throws(() => adoptForeignState({ root: restored, harness: 'claude-code', coreDir: coreB, decision: 'yes' }));
    rmSync(record, { recursive: true });
    for (const h of ['claude-code', 'codex']) {
      assert.equal(adoptForeignState({ root: restored, harness: h, coreDir: coreB, decision: 'yes' }).status, 'adopted', h);
      assert.equal(readManifest({ root: restored, harness: h, coreDir: coreB }).agent_notes, NOTES[h]);
    }
  } finally { s.cleanup(); }
});

test('a failure after the stamp is committed (signature sidecar obstructed) is resumed from the archived original', () => {
  const s = sandbox();
  try {
    const { coreB, restored } = restoredTwoHarness(s);
    const sidecar = join(restored, '_core', 'claude-code', 'workspace.json.mac');
    rmSync(sidecar, { force: true }); mkdirSync(sidecar);
    assert.throws(() => adoptForeignState({ root: restored, harness: 'claude-code', coreDir: coreB, decision: 'yes' }));
    rmSync(sidecar, { recursive: true });
    assert.ok(adoptionCandidate({ root: restored, harness: 'claude-code', coreDir: coreB })?.resume, 'still offered, as a resume');
    const r = adoptForeignState({ root: restored, harness: 'claude-code', coreDir: coreB, decision: 'yes' });
    assert.equal(r.status, 'adopted');
    assert.equal(r.resumed, true);
    assert.equal(readManifest({ root: restored, harness: 'claude-code', coreDir: coreB }).agent_notes, NOTES['claude-code'], 'notes readable, no manual repair');
    assert.equal(adoptionCandidate({ root: restored, harness: 'claude-code', coreDir: coreB }), null, 'finished: not offered again');
    assert.equal(adoptForeignState({ root: restored, harness: 'codex', coreDir: coreB, decision: 'yes' }).status, 'adopted', 'the other harness too');
  } finally { s.cleanup(); }
});

test('planted adopted-* links under superseded/ are never written through; the archive is a fresh real folder', () => {
  const s = sandbox();
  try {
    const { coreB, restored, originals } = restoredTwoHarness(s);
    const outside = join(s.base, 'outside');
    mkdirSync(outside);
    const sup = join(restored, '_core', 'claude-code', 'superseded');
    mkdirSync(sup);
    for (let i = 0; i < 5; i++) symlinkSync(outside, join(sup, `adopted-2026-10-04T13-00-00-00${i}Z`), process.platform === 'win32' ? 'junction' : 'dir');
    const r = adoptForeignState({ root: restored, harness: 'claude-code', coreDir: coreB, decision: 'yes' });
    assert.equal(r.status, 'adopted');
    assert.deepEqual(readdirSync(outside), [], 'nothing written through a planted link');
    assert.ok(readFileSync(join(r.archived, 'workspace.json')).equals(originals['claude-code']), 'the original archived byte for byte');
  } finally { s.cleanup(); }
});

test('a transient read error on the archived original holds the resume with its plan kept; the retry restores the notes', () => {
  const s = sandbox();
  try {
    const { coreB, restored } = restoredTwoHarness(s);
    const sidecar = join(restored, '_core', 'claude-code', 'workspace.json.mac');
    rmSync(sidecar, { force: true }); mkdirSync(sidecar);
    assert.throws(() => adoptForeignState({ root: restored, harness: 'claude-code', coreDir: coreB, decision: 'yes' }));
    rmSync(sidecar, { recursive: true });
    const real = fs.readFileSync;
    let failed = false;
    fs.readFileSync = function (p, ...a) {
      if (!failed && /[\\/]superseded[\\/]adopted-[^\\/]+[\\/]workspace\.json$/.test(String(p))) { failed = true; throw Object.assign(new Error('transient'), { code: 'EIO' }); }
      return real.call(this, p, ...a);
    };
    syncBuiltinESMExports();
    let r;
    try { r = adoptForeignState({ root: restored, harness: 'claude-code', coreDir: coreB, decision: 'yes' }); }
    finally { fs.readFileSync = real; syncBuiltinESMExports(); }
    assert.equal(failed, true, 'the fault fired');
    assert.equal(r.status, 'held');
    assert.match(r.reason, /^archived-original-unusable:EIO/);
    assert.ok(adoptionCandidate({ root: restored, harness: 'claude-code', coreDir: coreB })?.resume, 'the plan is kept: still a resume');
    const r2 = adoptForeignState({ root: restored, harness: 'claude-code', coreDir: coreB, decision: 'yes' });
    assert.equal(r2.status, 'adopted');
    assert.equal(r2.resumed, true);
    assert.equal(readManifest({ root: restored, harness: 'claude-code', coreDir: coreB }).agent_notes, NOTES['claude-code']);
    assert.equal(adoptionCandidate({ root: restored, harness: 'claude-code', coreDir: coreB }), null, 'only now is the plan removed');
    assert.equal(adoptForeignState({ root: restored, harness: 'codex', coreDir: coreB, decision: 'yes' }).status, 'adopted');
    assert.equal(readManifest({ root: restored, harness: 'codex', coreDir: coreB }).agent_notes, NOTES.codex);
  } finally { s.cleanup(); }
});

test('a transient read error on the foreign manifest holds a fresh adoption without setting the manifest aside', () => {
  const s = sandbox();
  try {
    const { coreB, restored } = restoredTwoHarness(s);
    const real = fs.readFileSync;
    let failed = false;
    fs.readFileSync = function (p, ...a) {
      if (!failed && /[\\/]_core[\\/]claude-code[\\/]workspace\.json$/.test(String(p))) { failed = true; throw Object.assign(new Error('transient'), { code: 'EIO' }); }
      return real.call(this, p, ...a);
    };
    syncBuiltinESMExports();
    let r;
    try { r = adoptForeignState({ root: restored, harness: 'claude-code', coreDir: coreB, decision: 'yes' }); }
    finally { fs.readFileSync = real; syncBuiltinESMExports(); }
    assert.equal(r.status, 'held');
    assert.ok(existsSync(join(restored, '_core', 'claude-code', 'workspace.json')), 'not set aside as unparseable');
    assert.equal(adoptForeignState({ root: restored, harness: 'claude-code', coreDir: coreB, decision: 'yes' }).status, 'adopted');
    assert.equal(readManifest({ root: restored, harness: 'claude-code', coreDir: coreB }).agent_notes, NOTES['claude-code']);
  } finally { s.cleanup(); }
});
