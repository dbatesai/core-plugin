import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { escapeCell, buildIndex } from '../../plugins/core/skills/core/scripts/generate-risks-index.mjs';

test('escapeCell escapes pipes and backslashes and flattens newlines', () => {
  assert.equal(escapeCell('A | B'), 'A \\| B');
  assert.equal(escapeCell('back\\slash'), 'back\\\\slash');
  assert.equal(escapeCell('x\r\ny'), 'x y');
  assert.equal(escapeCell(undefined), '');
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
