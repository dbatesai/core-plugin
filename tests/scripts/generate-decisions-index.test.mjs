import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { escapeCell, buildIndex, truncate, SUMMARY_MAX } from '../../plugins/core/skills/core/scripts/generate-decisions-index.mjs';

test('M9: INDEX-decisions.md is written atomically (a crash mid-write must not yield a false-drift index)', () => {
  const src = readFileSync(fileURLToPath(new URL('../../plugins/core/skills/core/scripts/generate-decisions-index.mjs', import.meta.url)), 'utf8');
  assert.match(src, /from '\.\/fs-atomic\.mjs'/, 'imports the atomic writer');
  assert.match(src, /atomicWriteFileSync\(indexPath/, 'index written atomically');
  assert.doesNotMatch(src, /\bwriteFileSync\(indexPath/, 'no bare write of the index');
});

test('escapeCell escapes pipes and backslashes and flattens newlines', () => {
  assert.equal(escapeCell('A | B'), 'A \\| B');
  assert.equal(escapeCell('back\\slash'), 'back\\\\slash');
  assert.equal(escapeCell('line1\nline2'), 'line1 line2');
  assert.equal(escapeCell('a\rb'), 'a b', 'a lone carriage return is flattened too');
  assert.equal(escapeCell('a\r\n\nb'), 'a b', 'runs of CR/LF collapse to one space');
  assert.equal(escapeCell(null), '');
});

// Independent review, 2026-07-19: this local truncate() was a hand-duplicated
// copy of the surrogate-splitting bug fixed in generate-summary-index.mjs —
// now delegates to the shared text-truncate.mjs helper. Direct regression
// coverage so this specific export can't silently regress back to a local copy.
test('truncate() never orphans a UTF-16 surrogate pair (astral characters, e.g. emoji)', () => {
  const emoji = '🎯'.repeat(SUMMARY_MAX);
  const out = truncate(emoji, SUMMARY_MAX);
  assert.ok(!out.includes('�'), 'no lone-surrogate replacement character');
  assert.ok(!Buffer.from(out, 'utf8').toString('utf8').includes('�'), 'round-trips clean through UTF-8 bytes too');
});

function scratchMemories(units) {
  const dir = mkdtempSync(join(tmpdir(), 'dec-idx-'));
  const mem = join(dir, '_memories');
  mkdirSync(mem, { recursive: true });
  for (const [fname, content] of Object.entries(units)) {
    writeFileSync(join(mem, fname), content);
  }
  return mem;
}

test('M12: a decision H1 containing a pipe renders one well-formed, escaped table row', () => {
  const mem = scratchMemories({
    'dc-99-piped.md': '---\nid: dc-99\nstatus: accepted\ndate: 2026-06-02\n---\n\n# DC-99: choose A | B over C\n',
  });
  try {
    const md = buildIndex(mem);
    const row = md.split('\n').find((l) => l.includes('dc-99'));
    assert.ok(row, 'the dc-99 row is present');
    // The pipe in the title must be escaped, not a raw cell separator. A correct row has
    // exactly the 4 data cells + 2 border pipes = 5 unescaped `|`; the title pipe is `\|`.
    assert.match(row, /choose A \\\| B over C/, 'the title pipe is escaped');
    const unescaped = (row.match(/(?<!\\)\|/g) || []).length;
    assert.equal(unescaped, 5, 'exactly 5 structural pipes — the title pipe did not add a column');
  } finally { rmSync(join(mem, '..'), { recursive: true, force: true }); }
});
