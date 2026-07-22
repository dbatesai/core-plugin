/**
 * user-authorship-boundary.test.mjs — permanent regression coverage for Hale's
 * 2026-07-22 bounded user-authorship-boundary fix (the second pass, after the
 * first pass left two red cases). One test (or matrix) per point of the
 * 8-point proposal, plus the two originally-red repros as the anchor cases.
 *
 * Anchor repros (probe-live-dirty.mjs, the must-pass set):
 *   - hot_duplicate_markers: a duplicate BEGIN must NOT delete intervening user
 *     text — the write refuses (MALFORMED_HOT_MARKERS), user bytes survive.
 *   - compact_user_edit: an unreconciled post-baseline PROJECT.md correction
 *     must NOT be compacted away — the write refuses, the correction survives.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  applyHotSection, clearHotSection, findExistingBlock, HOT_BEGIN, HOT_END,
  recordProjectMdWrite, classifyProjectMdChange,
} from '../../plugins/core/skills/core/scripts/hot-section.mjs';
import { main as compactMain } from '../../plugins/core/skills/core/scripts/compact-project.mjs';
import { decorateStore } from '../../plugins/core/skills/core/scripts/decorate-graph.mjs';
import { stampFile, readProjectCache, hashText } from '../../plugins/core/skills/core/scripts/state-cache.mjs';
import {
  writeGuardDecision, resolveNoBaseline, readSessionInventory,
} from '../../plugins/core/skills/core/scripts/lifecycle-core.mjs';
import {
  recordSessionStart, detectStore, classifyFileLifecycle,
} from '../../plugins/core/skills/core/scripts/lifecycle-detect.mjs';

const SCRIPTS = new URL('../../plugins/core/skills/core/scripts', import.meta.url).pathname;
const NOW = '2026-07-22T00:00:00Z';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'authorship-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(join(home, '.core'), { recursive: true });
  mkdirSync(join(project, '_memories'), { recursive: true });
  return { root, home, project, pm: join(project, 'PROJECT.md') };
}

function spawnNode(codeStr) {
  return new Promise((res) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', codeStr], { timeout: 30000 });
    let stdout = '', stderr = '';
    c.stdout.on('data', d => { stdout += d; });
    c.stderr.on('data', d => { stderr += d; });
    c.on('close', (status) => res({ status, stdout, stderr }));
  });
}

// ---------------------------------------------------------------------------
// ANCHOR REPRO 1 (probe-live-dirty hot_duplicate_markers) + POINT 4 matrix:
// strict hot markers — every ambiguous shape refuses byte-identically.
// ---------------------------------------------------------------------------

test('ANCHOR/point4: duplicate hot BEGIN markers refuse the write and preserve intervening user text', () => {
  const { root, home, project, pm } = setup();
  try {
    writeFileSync(pm, `# Project\n\n${HOT_BEGIN}\nOld.\n${HOT_BEGIN}\nUSER BETWEEN DUPLICATE MARKERS.\n${HOT_END}\n\n## What & Why\n\nPurpose.\n`);
    const before = readFileSync(pm, 'utf8');
    assert.throws(
      () => applyHotSection(project, 'Replacement.', { now: NOW, home }),
      (e) => e.code === 'MALFORMED_HOT_MARKERS',
    );
    const after = readFileSync(pm, 'utf8');
    assert.equal(after, before, 'byte-identical refusal');
    assert.ok(after.includes('USER BETWEEN DUPLICATE MARKERS.'), 'user text survives');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('point4 matrix: every malformed marker shape is refused; only 0 markers or 1 ordered pair is ok', () => {
  const b = HOT_BEGIN, e = HOT_END;
  const cases = [
    { name: 'no markers',        text: 'plain text',                       ok: true,  block: false },
    { name: 'one ordered pair',  text: `x\n${b}\nhot\n${e}\ny`,             ok: true,  block: true  },
    { name: 'duplicate begin',   text: `${b}\na\n${b}\nb\n${e}`,            ok: false },
    { name: 'duplicate end',     text: `${b}\na\n${e}\nb\n${e}`,            ok: false },
    { name: 'begin only',        text: `${b}\na`,                           ok: false },
    { name: 'end only',          text: `a\n${e}`,                           ok: false },
    { name: 'end before begin',  text: `${e}\na\n${b}`,                     ok: false },
  ];
  for (const c of cases) {
    const scan = findExistingBlock(c.text);
    assert.equal(scan.ok, c.ok, `${c.name}: ok=${c.ok}`);
    if (c.ok && c.block) assert.ok(scan.block, `${c.name}: has a block`);
    if (c.ok && !c.block) assert.equal(scan.block, null, `${c.name}: no block`);
  }
});

test('point4: clearHotSection also refuses a malformed marker state', () => {
  const { root, home, project, pm } = setup();
  try {
    writeFileSync(pm, `# P\n\n${HOT_BEGIN}\na\n${HOT_BEGIN}\nUSER.\n${HOT_END}\n`);
    const before = readFileSync(pm, 'utf8');
    assert.throws(() => clearHotSection(project, { now: NOW, home }), (e) => e.code === 'MALFORMED_HOT_MARKERS');
    assert.equal(readFileSync(pm, 'utf8'), before, 'byte-identical refusal on clear');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// ANCHOR REPRO 2 (probe-live-dirty compact_user_edit) + POINT 5:
// compact-project refuses an unreconciled post-baseline PROJECT.md correction.
// ---------------------------------------------------------------------------

test('ANCHOR/point5: compact-project refuses when a post-baseline user correction diverged; the correction survives', () => {
  const { root, home, project, pm } = setup();
  try {
    writeFileSync(join(project, '_memories', 'dc-1-alpha.md'),
      `---\nid: dc-1-alpha\ntype: decision\nstatus: active\ncreated: 2026-07-01\n---\n\n# DC-1: Alpha\n\nOld canonical detail.\n`);
    writeFileSync(pm, `# Project\n\n## Decisions & Risks\n\n**Decisions (dated, append-only):**\n\n- \`2026-07-01\` — **DC-1: Alpha** USER CORRECTION NOT IN UNIT.\n\n**Risks (active):**\n\n- None.\n`);
    recordProjectMdWrite(pm, { now: NOW, home });
    // Post-baseline user edit — a real gate must notice it.
    writeFileSync(pm, readFileSync(pm, 'utf8').replace('USER CORRECTION', 'LATER USER CORRECTION'));
    const before = readFileSync(pm, 'utf8');
    const code = compactMain([project]);
    const after = readFileSync(pm, 'utf8');
    assert.equal(code, 1, 'compact exits nonzero on refusal');
    assert.equal(after, before, 'byte-identical refusal');
    assert.ok(after.includes('LATER USER CORRECTION'), 'the user correction survives');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('point5: compact-project proceeds and re-stamps on a clean baseline (no false refusal)', () => {
  const { root, home, project, pm } = setup();
  try {
    writeFileSync(join(project, '_memories', 'dc-1-alpha.md'),
      `---\nid: dc-1-alpha\ntype: decision\nstatus: active\ncreated: 2026-07-01\nupdated: 2026-07-01\n---\n\n# DC-1: Alpha\n\nCanonical body.\n`);
    writeFileSync(pm, `# Project\n\n## Decisions & Risks\n\n**Decisions (dated, append-only):**\n\n- \`2026-07-01\` — **DC-1: Alpha** a full entry long enough to not already be a stub, with a real body.\n\n**Risks (active):**\n\n- None.\n`);
    recordProjectMdWrite(pm, { now: NOW, home });
    const code = compactMain([project]);
    const after = readFileSync(pm, 'utf8');
    assert.equal(code, 0, 'compact proceeds on a clean baseline');
    assert.match(after, /→ `_memories\/dc-1-alpha\.md`/, 'entry compacted to a stub');
    // Re-stamped: the new baseline reflects the compacted content, so a follow-on
    // classify sees clean, not a false outside-changed.
    const cache = readProjectCache(project);
    const stamp = cache.files[resolve(pm)];
    assert.ok(stamp, 'compact stamped a baseline');
    assert.equal(classifyProjectMdChange(stamp, after), 'hot-block-only', 'clean baseline after compact');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// POINT 1: the lifecycle detector returns each machine-readable classification.
// ---------------------------------------------------------------------------

test('point1: detector classifies clean / generated-only / pending-edit', () => {
  const { root, home, project, pm } = setup();
  try {
    writeFileSync(pm, '# P\n\n## What & Why\n\nBody.\n');
    // clean: apply a hot section, stamp lands, nothing changes after.
    applyHotSection(project, 'First.', { now: NOW, home });
    let r = classifyFileLifecycle(project, pm, { kind: 'project' });
    assert.equal(r.classification, 'clean', 'byte-identical to baseline → clean');

    // generated-only: change ONLY inside the hot block (simulate CORE's own
    // re-synthesis landing new hot text without a stamp refresh yet).
    const cur = readFileSync(pm, 'utf8');
    const scan = findExistingBlock(cur);
    const mutated = cur.slice(0, scan.block.start) + `${HOT_BEGIN}\n## Right now\n\nDifferent hot text.\n\n*Synthesized ${NOW}*\n${HOT_END}\n\n` + cur.slice(scan.block.end);
    writeFileSync(pm, mutated);
    r = classifyFileLifecycle(project, pm, { kind: 'project' });
    assert.equal(r.classification, 'generated-only', 'only the hot block changed → generated-only');

    // pending-edit: change OUTSIDE the hot block (a user edit).
    writeFileSync(pm, mutated.replace('Body.', 'Body. USER EDIT.'));
    r = classifyFileLifecycle(project, pm, { kind: 'project' });
    assert.equal(r.classification, 'pending-edit', 'human region changed → pending-edit');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('point1: detector classifies missing, malformed, and read-only', () => {
  const { root, home, project, pm } = setup();
  try {
    // missing: baseline exists, file gone.
    stampFile(project, resolve(pm), hashText('x'), 'hot-section', { now: NOW, home, extra: { outside_hash: 'aaaa' } });
    let r = classifyFileLifecycle(project, pm, { kind: 'project' });
    assert.equal(r.classification, 'missing');

    // malformed: duplicate markers.
    writeFileSync(pm, `# P\n${HOT_BEGIN}\na\n${HOT_BEGIN}\nb\n${HOT_END}\n`);
    r = classifyFileLifecycle(project, pm, { kind: 'project' });
    assert.equal(r.classification, 'malformed');

    // read-only: unreadable (skip where perms don't bite, e.g. root).
    writeFileSync(pm, '# P\n\n## What & Why\n\nx\n');
    chmodSync(pm, 0o000);
    let readable = true;
    try { readFileSync(pm, 'utf8'); } catch { readable = false; }
    if (!readable) {
      r = classifyFileLifecycle(project, pm, { kind: 'project' });
      assert.equal(r.classification, 'read-only');
    }
    chmodSync(pm, 0o644);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// POINT 8: no-baseline distinction — created-this-session vs pre-existing.
// ---------------------------------------------------------------------------

test('point8: pre-existing-uncached is held; created-this-session proceeds; no inventory degrades permissively', () => {
  const { root, home, project } = setup();
  try {
    const mem = join(project, '_memories');
    // A user-created unit present at session start, never cached.
    const userUnit = join(mem, 'dc-user.md');
    writeFileSync(userUnit, `---\nid: dc-user\ntype: decision\nstatus: active\n---\n\n# User\n`);
    writeFileSync(join(project, 'PROJECT.md'), '# P\n\n## What & Why\n\nx\n');

    // No inventory yet → permissive (graceful degradation).
    assert.equal(resolveNoBaseline(project, userUnit, { sessionInventory: readSessionInventory(project) }).safe, true, 'no inventory → permissive');

    recordSessionStart(project, { sessionId: 's1', now: NOW });
    // A unit graduated AFTER session start.
    const newUnit = join(mem, 'dc-new.md');
    writeFileSync(newUnit, `---\nid: dc-new\ntype: decision\nstatus: active\n---\n\n# New\n`);

    const inv = readSessionInventory(project);
    assert.equal(resolveNoBaseline(project, userUnit, { sessionInventory: inv }).safe, false, 'pre-existing-uncached → held');
    assert.equal(resolveNoBaseline(project, newUnit, { sessionInventory: inv }).safe, true, 'created-this-session → safe');

    // And the detector reflects it.
    const det = detectStore(project);
    const byName = Object.fromEntries(det.files.map(f => [f.path.split('/').pop(), f]));
    assert.equal(byName['dc-user.md'].safeFirstWrite, false);
    assert.equal(byName['dc-new.md'].safeFirstWrite, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('point8: decorate-graph HOLDS a pre-existing-uncached unit but decorates a created-this-session unit', () => {
  const { root, home, project } = setup();
  try {
    const mem = join(project, '_memories');
    // Pre-existing user unit that cites a target (so decorate WOULD add a block).
    writeFileSync(join(mem, 'dc-user.md'),
      `---\nid: dc-user\ntype: decision\nstatus: active\nedges:\n  - type: cites\n    target: dc-target\n---\n\n# User\n`);
    writeFileSync(join(mem, 'dc-target.md'), `---\nid: dc-target\ntype: decision\nstatus: active\n---\n\n# Target\n`);
    writeFileSync(join(project, 'PROJECT.md'), '# P\n\n## What & Why\n\nx\n');
    recordSessionStart(project, { sessionId: 's1', now: NOW });

    // A NEW unit created this session that also cites the target.
    writeFileSync(join(mem, 'dc-new.md'),
      `---\nid: dc-new\ntype: decision\nstatus: active\nedges:\n  - type: cites\n    target: dc-target\n---\n\n# New\n`);

    const res = decorateStore(project, { now: NOW, home });
    const heldPaths = res.needs_reconciliation.map(r => r.path);
    assert.ok(heldPaths.includes('dc-user.md'), 'pre-existing-uncached unit is held, not decorated');
    const held = res.needs_reconciliation.find(r => r.path === 'dc-user.md');
    assert.equal(held.classification, 'no-baseline');
    assert.ok(res.changed.includes('dc-new.md'), 'created-this-session unit decorates normally');
    // The held unit's bytes are untouched (no edges block written).
    assert.ok(!readFileSync(join(mem, 'dc-user.md'), 'utf8').includes('## Related'), 'held unit not decorated');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// POINT 6: stamp failure surfaces as attribution-unknown/recovery-required.
// ---------------------------------------------------------------------------

test('point6: stampFiles returns attribution-unknown/recovery-required when the cache write cannot land', () => {
  const { root, home, project } = setup();
  try {
    // Make the cache directory impossible to create: put a FILE where the
    // `_lib` directory must be, so mkdirSync/atomicWrite in stampFiles fail.
    const lib = join(project, '_memories', '_lib');
    writeFileSync(lib, 'i am a file, not a directory');
    const outcome = stampFile(project, resolve(join(project, 'PROJECT.md')), hashText('x'), 'hot-section', { now: NOW, home });
    assert.equal(outcome.stamped, false, 'stamp failure is not silently reported as success');
    assert.equal(outcome.outcome, 'attribution-unknown');
    assert.equal(outcome.recovery, 'recovery-required');
    assert.ok(outcome.reason, 'a machine-readable reason is attached');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('point6: a successful stamp reports stamped:true', () => {
  const { root, home, project } = setup();
  try {
    const outcome = stampFile(project, resolve(join(project, 'PROJECT.md')), hashText('x'), 'hot-section', { now: NOW, home });
    assert.deepEqual(outcome, { stamped: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// POINT 7: one shared PROJECT.md writer lock — two concurrent DIFFERENT writers
// touching the same PROJECT.md never interleave destructively.
// ---------------------------------------------------------------------------

test('point7: concurrent compact + demote-moves on the same PROJECT.md — no interleaved corruption', async () => {
  const { root, home, project, pm } = setup();
  try {
    const mem = join(project, '_memories');
    writeFileSync(join(mem, 'dc-1-alpha.md'),
      `---\nid: dc-1-alpha\ntype: decision\nstatus: active\ncreated: 2026-07-01\nupdated: 2026-07-01\n---\n\n# DC-1: Alpha\n\nBody.\n`);
    const original = [
      '# Project', '',
      '## Moves', '',
      '- [x] **Old thing 2026-01-01** — shipped 2026-01-01.', '',
      '## Decisions & Risks', '',
      '**Decisions (dated, append-only):**', '',
      '- `2026-07-01` — **DC-1: Alpha** a full entry long enough to not be a stub, real body here.', '',
      '**Risks (active):**', '', '- None.', '',
    ].join('\n');
    writeFileSync(pm, original);

    // Compute the two clean single-writer outcomes on isolated copies. The
    // shared lock + CAS guarantee the concurrent result equals ONE of these
    // exactly — never a torn merge of both.
    const outcomeOf = (which) => {
      const d = mkdtempSync(join(tmpdir(), 'authorship-exp-'));
      mkdirSync(join(d, '_memories'), { recursive: true });
      writeFileSync(join(d, '_memories', 'dc-1-alpha.md'), readFileSync(join(mem, 'dc-1-alpha.md')));
      writeFileSync(join(d, 'PROJECT.md'), original);
      const code = [
        `import { main as compact } from ${JSON.stringify(pathToFileURL(join(SCRIPTS, 'compact-project.mjs')).href)};`,
        `import { main as demote } from ${JSON.stringify(pathToFileURL(join(SCRIPTS, 'demote-moves.mjs')).href)};`,
        which === 'compact' ? `compact([${JSON.stringify(d)}]);` : `demote([${JSON.stringify(d)}, '--today', '2026-07-22']);`,
      ].join('\n');
      return { d, code };
    };
    const expC = outcomeOf('compact');
    const expD = outcomeOf('demote');
    await spawnNode(expC.code);
    await spawnNode(expD.code);
    const expectedCompact = readFileSync(join(expC.d, 'PROJECT.md'), 'utf8');
    const expectedDemote = readFileSync(join(expD.d, 'PROJECT.md'), 'utf8');
    rmSync(expC.d, { recursive: true, force: true });
    rmSync(expD.d, { recursive: true, force: true });

    // Now run BOTH concurrently against the real store.
    const compactCode = `import { main } from ${JSON.stringify(pathToFileURL(join(SCRIPTS, 'compact-project.mjs')).href)}; process.exit(main([${JSON.stringify(project)}]));`;
    const demoteCode = `import { main } from ${JSON.stringify(pathToFileURL(join(SCRIPTS, 'demote-moves.mjs')).href)}; process.exit(main([${JSON.stringify(project)}, '--today', '2026-07-22']));`;
    await Promise.all([spawnNode(compactCode), spawnNode(demoteCode)]);

    const final = readFileSync(pm, 'utf8');
    // No torn markers / no partial temp files left behind.
    assert.equal(findExistingBlock(final).ok, true, 'markers well-formed');
    assert.ok(!readdirSync(project).some(n => n.includes('.tmp-')), 'no leftover temp file in project dir');
    assert.ok(!readdirSync(mem).some(n => n.includes('.tmp-')), 'no leftover temp file in _memories');
    // The result is exactly one clean writer's output — never a destructive interleave.
    assert.ok(
      final === expectedCompact || final === expectedDemote,
      'concurrent result equals one clean single-writer outcome (no interleave)',
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// POINT 2: writers recheck their own live preimage (CAS) even under the lock —
// a byte-identical refusal when the on-disk bytes moved since the read.
// ---------------------------------------------------------------------------

test('point2: writeGuardDecision refuses on outside-changed and no-cache-baseline-held; proceeds on clean/generated', () => {
  const stamp = { last_hash: 'h', outside_hash: 'o' };
  // Proceed on the CORE-generated-region-only classifications.
  assert.equal(writeGuardDecision({ cachedStamp: stamp, classification: 'hot-block-only', projectDir: '/x', absPath: '/x/PROJECT.md' }).proceed, true);
  assert.equal(writeGuardDecision({ cachedStamp: stamp, classification: 'edges-block-only', projectDir: '/x', absPath: '/x/u.md' }).proceed, true);
  // Refuse on a real divergence or an unprovable stamp.
  assert.equal(writeGuardDecision({ cachedStamp: stamp, classification: 'outside-changed', projectDir: '/x', absPath: '/x/PROJECT.md' }).proceed, false);
  assert.equal(writeGuardDecision({ cachedStamp: stamp, classification: 'no-baseline', projectDir: '/x', absPath: '/x/PROJECT.md' }).proceed, false);
});
