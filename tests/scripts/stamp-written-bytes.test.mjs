// A writer's stamp claims only the bytes it wrote. If someone edits the file between the write and the
// stamp, the stamp is refused, the previous baseline stays, and the edit reads as the user's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordProjectMdWrite, classifyProjectMdChange } from '../../plugins/core/skills/core/scripts/hot-section.mjs';
import { stampCreatedBaseline } from '../../plugins/core/skills/core/scripts/lifecycle-detect.mjs';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'stamp-written-'));
  const project = join(root, 'project');
  mkdirSync(join(project, '_memories'), { recursive: true });
  const pm = join(project, 'PROJECT.md');
  writeFileSync(pm, '# Project\n\n## What & Why\n\nversion zero\n');
  recordProjectMdWrite(pm, { now: '2026-10-01T00:00:00Z' });
  const cachePath = join(project, '_memories', '_lib', 'state-cache.json');
  const entry = (p) => JSON.parse(readFileSync(cachePath, 'utf8')).files[p];
  return { root, project, pm, entry };
}

test('agent writes A, user changes it to B before the stamp: refused, baseline kept, B reads as a user edit', () => {
  const { root, pm, entry } = setup();
  try {
    const before = entry(pm);
    const A = '# Project\n\n## What & Why\n\nversion A (agent)\n';
    const B = '# Project\n\n## What & Why\n\nversion B (user correction)\n';
    writeFileSync(pm, A);
    writeFileSync(pm, B); // the user's edit lands before the agent's stamp
    const out = recordProjectMdWrite(pm, { now: '2026-10-02T00:00:00Z', written: A });
    assert.equal(out.stamped, false);
    assert.equal(out.reason, 'changed-since-write');
    assert.deepEqual(entry(pm), before, 'the previous baseline is untouched');
    assert.equal(classifyProjectMdChange(entry(pm), B), 'outside-changed', "B surfaces as the user's edit");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('when the file still holds the written bytes, the stamp lands and names CORE', () => {
  const { root, pm, entry } = setup();
  try {
    const before = entry(pm);
    const A = '# Project\n\n## What & Why\n\nversion A (agent)\n';
    writeFileSync(pm, A);
    const out = recordProjectMdWrite(pm, { now: '2026-10-02T00:00:00Z', written: A });
    assert.notEqual(out.stamped, false);
    assert.notEqual(entry(pm).last_hash, before.last_hash);
    assert.equal(classifyProjectMdChange(entry(pm), A), 'hot-block-only');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an unreadable file never matches written bytes, even when the writer wrote an empty string', () => {
  const { root, pm, entry } = setup();
  try {
    const before = entry(pm);
    rmSync(pm); // the read after the write fails
    const out = recordProjectMdWrite(pm, { now: '2026-10-02T00:00:00Z', written: '' });
    assert.equal(out.stamped, false);
    assert.equal(out.reason, 'unreadable-after-write');
    assert.deepEqual(entry(pm), before, 'the previous baseline is untouched');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a file that really holds the empty string written is still stamped (a read that succeeds is not a read failure)', () => {
  const { root, pm } = setup();
  try {
    writeFileSync(pm, '');
    const out = recordProjectMdWrite(pm, { now: '2026-10-02T00:00:00Z', written: '' });
    assert.notEqual(out.stamped, false);
    assert.notEqual(out.reason, 'unreadable-after-write');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a creation baseline is refused when the file changed after it was created', () => {
  const { root, project, entry } = setup();
  try {
    const unit = join(project, '_memories', 'obs-x.md');
    const written = '---\nid: obs-x\ntype: observation\nstatus: active\n---\nagent text\n';
    writeFileSync(unit, written.replace('agent text', 'user text'));
    const out = stampCreatedBaseline(project, unit, { kind: 'unit', written });
    assert.equal(out.stamped, false);
    assert.equal(out.reason, 'changed-since-write');
    assert.equal(entry(unit), undefined, 'no baseline is recorded for bytes CORE did not write');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('without written bytes (the explicit adoption command), the current bytes are adopted as before', () => {
  const { root, project, entry } = setup();
  try {
    const unit = join(project, '_memories', 'obs-y.md');
    writeFileSync(unit, '---\nid: obs-y\ntype: observation\nstatus: active\n---\nexisting text\n');
    const out = stampCreatedBaseline(project, unit, { kind: 'unit' });
    assert.notEqual(out.stamped, false);
    assert.ok(existsSync(unit) && entry(unit), 'adopted');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
