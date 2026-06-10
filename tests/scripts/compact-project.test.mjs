import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  compactDecisions, loadUnits, main, DECISIONS_HEADER,
} from '../../plugins/core/skills/core/scripts/compact-project.mjs';

const UNIT = `---
id: dc-12-pick-the-store
type: decision
status: active
created: 2026-05-01
updated: 2026-05-01
---

# DC-12: Pick the store

Full decision body lives here.
`;

const FULL_ENTRY =
  '- `2026-05-01` — **DC-12: Pick the store.** We compared three storage layouts ' +
  'and picked the flat one because it is simplest to validate and ships today.';

function project(entry) {
  const dir = mkdtempSync(join(tmpdir(), 'compact-project-'));
  mkdirSync(join(dir, '_memories'), { recursive: true });
  writeFileSync(join(dir, '_memories', 'dc-12-pick-the-store.md'), UNIT);
  writeFileSync(join(dir, 'PROJECT.md'), [
    '# Test Project', '',
    '## Decisions', '',
    DECISIONS_HEADER, '',
    entry, '',
    '**Risks (live):**', '',
    '- none', '',
  ].join('\n'));
  return dir;
}

test('--check reports size and never writes', () => {
  const dir = project(FULL_ENTRY);
  try {
    const before = readFileSync(join(dir, 'PROJECT.md'), 'utf8');
    const code = main([dir, '--check']);
    assert.equal(code, 0);
    assert.equal(readFileSync(join(dir, 'PROJECT.md'), 'utf8'), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('compactDecisions replaces a full entry with a unit-pointer stub', () => {
  const dir = project(FULL_ENTRY);
  try {
    const units = loadUnits(join(dir, '_memories'));
    const text = readFileSync(join(dir, 'PROJECT.md'), 'utf8');
    const { text: out, stats } = compactDecisions(text, units);
    assert.equal(stats.compacted, 1);
    assert.equal(stats.skipped, 0);
    assert.match(out, /— \*\*DC-12: Pick the store\*\* → `_memories\/dc-12-pick-the-store\.md`/);
    assert.ok(!out.includes('three storage layouts'), 'full body removed from PROJECT.md');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('compaction is idempotent — second pass skips the stub unchanged', () => {
  const dir = project(FULL_ENTRY);
  try {
    const units = loadUnits(join(dir, '_memories'));
    const text = readFileSync(join(dir, 'PROJECT.md'), 'utf8');
    const first = compactDecisions(text, units);
    const second = compactDecisions(first.text, units);
    assert.equal(second.stats.compacted, 0);
    assert.equal(second.stats.skipped, 1);
    assert.equal(second.text, first.text);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('entry with no matching unit is left intact and counted missing', () => {
  const entry = '- `2026-05-02` — **DC-99: Ghost decision.** Body text long enough to not be a stub, with no unit on disk to point at.';
  const dir = project(entry);
  try {
    const units = loadUnits(join(dir, '_memories'));
    const text = readFileSync(join(dir, 'PROJECT.md'), 'utf8');
    const { text: out, stats } = compactDecisions(text, units);
    assert.equal(stats.missing, 1);
    assert.ok(out.includes('Ghost decision'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('main() writes the compacted file and exits 0', () => {
  const dir = project(FULL_ENTRY);
  try {
    const code = main([dir]);
    assert.equal(code, 0);
    const after = readFileSync(join(dir, 'PROJECT.md'), 'utf8');
    assert.match(after, /→ `_memories\/dc-12-pick-the-store\.md`/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function captureStdout(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { fn(); } finally { console.log = orig; }
  return lines.join('\n');
}

test('MEM-012: --check names the §Decisions-only scope and the sibling scripts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'compact-'));
  try {
    mkdirSync(join(dir, '_memories'), { recursive: true });
    writeFileSync(join(dir, 'PROJECT.md'),
      '# P\n\n## Decisions & Risks\n\n**Decisions (dated, append-only):**\n');
    const out = captureStdout(() => main([dir, '--check']));
    assert.match(out, /bytes/, 'size report still present');
    assert.match(out, /§Decisions ONLY/, 'scope stated where the caller reads it');
    assert.match(out, /demote-moves\.mjs/, '§Moves owner named');
    assert.match(out, /demote-state-narrative\.mjs/, '§State owner named');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
