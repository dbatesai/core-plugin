import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { KINDS, escapeCell, buildIndex, truncate, SUMMARY_MAX, main } from '../../plugins/core/skills/core/scripts/generate-unit-index.mjs';

const SCRIPT = fileURLToPath(new URL('../../plugins/core/skills/core/scripts/generate-unit-index.mjs', import.meta.url));

test('the kind table names both unit families with their index file', () => {
  assert.deepEqual(Object.keys(KINDS).sort(), ['decisions', 'risks']);
  assert.equal(KINDS.decisions.index, 'INDEX-decisions.md');
  assert.equal(KINDS.risks.index, 'INDEX-risks.md');
});

test('the index is written atomically (a crash mid-write must not yield a false-drift index)', () => {
  const src = readFileSync(SCRIPT, 'utf8');
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
  assert.equal(escapeCell('x\r\ny'), 'x y');
  assert.equal(escapeCell(null), '');
  assert.equal(escapeCell(undefined), '');
});

// Independent review, 2026-07-19: the per-script truncate() copies carried the
// surrogate-splitting bug fixed in generate-summary-index.mjs — now one shared
// helper. Direct regression coverage so this export can't regress to a local copy.
test('truncate() never orphans a UTF-16 surrogate pair (astral characters, e.g. emoji)', () => {
  const emoji = '🎯'.repeat(SUMMARY_MAX);
  const out = truncate(emoji, SUMMARY_MAX);
  assert.ok(!out.includes('�'), 'no lone-surrogate replacement character');
  assert.ok(!Buffer.from(out, 'utf8').toString('utf8').includes('�'), 'round-trips clean through UTF-8 bytes too');
});

function scratchMemories(units) {
  const dir = mkdtempSync(join(tmpdir(), 'unit-idx-'));
  const mem = join(dir, '_memories');
  mkdirSync(mem, { recursive: true });
  for (const [fname, content] of Object.entries(units)) writeFileSync(join(mem, fname), content);
  return mem;
}

test('a decision H1 containing a pipe renders one well-formed, escaped table row', () => {
  const mem = scratchMemories({ 'dc-99-piped.md': '---\nid: dc-99-ghost\nstatus: accepted\ndate: 2026-06-02\n---\n\n# DC-99-ghost: choose A | B over C\n' });
  try {
    const md = buildIndex(mem, 'decisions');
    const row = md.split('\n').find((l) => l.includes('dc-99-ghost'));
    assert.ok(row, 'the dc-99-ghost row is present');
    assert.match(row, /choose A \\\| B over C/, 'the title pipe is escaped');
    const unescaped = (row.match(/(?<!\\)\|/g) || []).length;
    assert.equal(unescaped, 5, 'exactly 5 structural pipes — the title pipe did not add a column');
  } finally { rmSync(join(mem, '..'), { recursive: true, force: true }); }
});

test('a risk H1 containing a pipe renders one well-formed, escaped table row', () => {
  const mem = scratchMemories({ 'risk-9-piped.md': '---\nid: risk-9\nstatus: open\ndate: 2026-06-02\n---\n\n# R-9: convergence on A | B infrastructure\n' });
  try {
    const md = buildIndex(mem, 'risks');
    const row = md.split('\n').find((l) => l.includes('risk-9'));
    assert.ok(row, 'the risk-9 row is present');
    assert.match(row, /convergence on A \\\| B infrastructure/, 'the title pipe is escaped');
    assert.equal((row.match(/(?<!\\)\|/g) || []).length, 5, 'exactly 5 structural pipes');
  } finally { rmSync(join(mem, '..'), { recursive: true, force: true }); }
});

test('each kind indexes only its own family, numeric ids first then named, and names its own regenerate command', () => {
  const mem = scratchMemories({
    'dc-2-b.md': '---\nid: dc-2-b\nstatus: active\n---\n\n# Second decision\n',
    'dc-10-a.md': '---\nid: dc-10-a\nstatus: active\n---\n\n# Tenth decision\n',
    'dc-named.md': '---\nid: dc-named\nstatus: active\n---\n\n# Named decision\n',
    'risk-3-x.md': '---\nid: risk-3-x\nstatus: open\n---\n\n# Third risk\n',
    'obs-1-not-indexed.md': '---\nid: obs-1\n---\n\n# An observation\n',
  });
  try {
    const d = buildIndex(mem, 'decisions'); const r = buildIndex(mem, 'risks');
    assert.match(d, /^# Decisions Index/); assert.match(d, /\*\*3 decisions indexed\.\*\*/);
    assert.ok(d.indexOf('dc-2-b') < d.indexOf('dc-10-a') && d.indexOf('dc-10-a') < d.indexOf('dc-named'), 'numeric by number, then named');
    assert.ok(!d.includes('risk-3-x') && !d.includes('obs-1'), 'decisions index carries only decisions');
    assert.match(r, /^# Risks Index/); assert.match(r, /\*\*1 risks indexed\.\*\*/); assert.ok(r.includes('risk-3-x') && !r.includes('dc-2-b'));
    assert.match(d, /generate-unit-index\.mjs --kind decisions/); assert.match(r, /generate-unit-index\.mjs --kind risks/);
    assert.throws(() => buildIndex(mem, 'people'), /unknown kind "people"/);
  } finally { rmSync(join(mem, '..'), { recursive: true, force: true }); }
});

test('CLI: --kind is required and names the choices; --store <project> writes the right index file', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 2); assert.match(r.stderr, /--kind decisions\|risks/);
  const mem = scratchMemories({ 'risk-1-a.md': '---\nid: risk-1-a\nstatus: open\n---\n\n# A risk\n' });
  try {
    const project = join(mem, '..');
    assert.equal(main(['--kind', 'risks', '--store', project]), 0);
    assert.ok(existsSync(join(mem, 'INDEX-risks.md')), 'INDEX-risks.md written under _memories');
    assert.ok(!existsSync(join(mem, 'INDEX-decisions.md')), 'only the requested kind is written');
  } finally { rmSync(join(mem, '..'), { recursive: true, force: true }); }
});
