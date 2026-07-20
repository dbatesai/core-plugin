import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { escapeCell, buildIndex, truncate, SUMMARY_MAX } from '../../plugins/core/skills/core/scripts/generate-risks-index.mjs';

test('M9: INDEX-risks.md is written atomically (crash-safety, consistent with the decisions index)', () => {
  const src = readFileSync(fileURLToPath(new URL('../../plugins/core/skills/core/scripts/generate-risks-index.mjs', import.meta.url)), 'utf8');
  assert.match(src, /from '\.\/fs-atomic\.mjs'/, 'imports the atomic writer');
  assert.match(src, /atomicWriteFileSync\(indexPath/, 'index written atomically');
  assert.doesNotMatch(src, /\bwriteFileSync\(indexPath/, 'no bare write of the index');
});

test('escapeCell escapes pipes and backslashes and flattens newlines', () => {
  assert.equal(escapeCell('A | B'), 'A \\| B');
  assert.equal(escapeCell('back\\slash'), 'back\\\\slash');
  assert.equal(escapeCell('x\r\ny'), 'x y');
  assert.equal(escapeCell(undefined), '');
});

// Independent review, 2026-07-19: this local truncate() was a hand-duplicated
// copy of the surrogate-splitting bug fixed in generate-summary-index.mjs —
// now delegates to the shared text-truncate.mjs helper.
test('truncate() never orphans a UTF-16 surrogate pair (astral characters, e.g. emoji)', () => {
  const emoji = '🎯'.repeat(SUMMARY_MAX);
  const out = truncate(emoji, SUMMARY_MAX);
  assert.ok(!out.includes('�'), 'no lone-surrogate replacement character');
  assert.ok(!Buffer.from(out, 'utf8').toString('utf8').includes('�'), 'round-trips clean through UTF-8 bytes too');
});

function scratchMemories(units) {
  const dir = mkdtempSync(join(tmpdir(), 'risk-idx-'));
  const mem = join(dir, '_memories');
  mkdirSync(mem, { recursive: true });
  for (const [fname, content] of Object.entries(units)) {
    writeFileSync(join(mem, fname), content);
  }
  return mem;
}

test('M12: a risk H1 containing a pipe renders one well-formed, escaped table row', () => {
  const mem = scratchMemories({
    'risk-9-piped.md': '---\nid: risk-9\nstatus: open\ndate: 2026-06-02\n---\n\n# R-9: convergence on A | B infrastructure\n',
  });
  try {
    const md = buildIndex(mem);
    const row = md.split('\n').find((l) => l.includes('risk-9'));
    assert.ok(row, 'the risk-9 row is present');
    assert.match(row, /convergence on A \\\| B infrastructure/, 'the title pipe is escaped');
    const unescaped = (row.match(/(?<!\\)\|/g) || []).length;
    assert.equal(unescaped, 5, 'exactly 5 structural pipes — the title pipe did not add a column');
  } finally { rmSync(join(mem, '..'), { recursive: true, force: true }); }
});
