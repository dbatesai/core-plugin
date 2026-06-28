import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlatFrontmatter } from '../../plugins/core/skills/core/scripts/frontmatter-flat.mjs';
import { parseFrontmatter } from '../../plugins/core/skills/core/scripts/priority.mjs';

test('parses top-level key: value pairs, strips quotes, returns [fm, body]', () => {
  const [fm, body] = parseFlatFrontmatter('---\nid: dc-99\nstatus: "accepted"\n---\n\n# Title\nbody text\n');
  assert.equal(fm.id, 'dc-99');
  assert.equal(fm.status, 'accepted', 'surrounding quotes stripped');
  assert.match(body, /^# Title/);
});

test('flat by design: keeps values as strings (no coercion), skips nested lines', () => {
  const [fm] = parseFlatFrontmatter('---\npriority: 5\nflag: true\ntopics:\n  - a\n  - b\n---\n');
  assert.strictEqual(fm.priority, '5', 'numbers stay strings — the index/demote consumers expect that');
  assert.strictEqual(fm.flag, 'true', 'booleans stay strings');
  assert.ok(!('topics' in fm), 'an empty-value key opening a nested list is dropped (flat parser)');
});

test('CRLF-tolerant and drops empty values + comments', () => {
  const [fm] = parseFlatFrontmatter('---\r\nid: r-9\r\nempty:\r\n# comment: ignored\r\n---\r\nbody\r\n');
  assert.equal(fm.id, 'r-9');
  assert.ok(!('empty' in fm), 'empty value dropped');
  assert.ok(!('# comment' in fm) && !('comment' in fm), 'comment line skipped');
});

test('no frontmatter → empty map + original text as body', () => {
  const [fm, body] = parseFlatFrontmatter('just a body, no frontmatter\n');
  assert.deepEqual(fm, {});
  assert.equal(body, 'just a body, no frontmatter\n');
});

test('null/undefined input is safe', () => {
  assert.deepEqual(parseFlatFrontmatter(null), [{}, '']);
  assert.deepEqual(parseFlatFrontmatter(undefined), [{}, '']);
});

// MEM-016: priority.mjs keeps its own (nested, coercing) parser beside this
// flat one ON PURPOSE — but nothing guaranteed the two stay in agreement on
// the fields both handle. This guard parses representative unit shapes with
// BOTH parsers and asserts the top-level scalars agree, so a YAML-handling
// change to one parser that silently diverges the other fails the suite.
const REPRESENTATIVE_UNITS = [
  // plain unit with nested topics + edges (flat parser drops the nests — fine)
  '---\nid: dc-99-thing\ntype: decision\nstatus: active\ncreated: 2026-05-30\nupdated: 2026-06-01\ntopics:\n  - a\nedges:\n  - { type: cites, target: dc-1 }\n---\n\n# T\nbody\n',
  // CRLF + quoted value (Windows/OneDrive-authored)
  '---\r\nid: r-9\r\ntype: risk\r\nstatus: "accepted"\r\ncreated: 2026-01-02\r\nupdated: 2026-01-03\r\n---\r\nbody\r\n',
  // comment line + flow-style topics (flat keeps the raw string; scalar fields still agree)
  '---\nid: obs-x-2026-06-01\ntype: observation\nstatus: active\ncreated: 2026-06-01\nupdated: 2026-06-01\n# comment: ignored\ntopics: [a, b]\n---\nbody\n',
];
const CONFORMANT_SCALARS = ['id', 'type', 'status', 'created', 'updated'];

test('MEM-016: both parsers agree on top-level scalar fields across representative units', () => {
  for (const text of REPRESENTATIVE_UNITS) {
    const [flat] = parseFlatFrontmatter(text);
    const [canon] = parseFrontmatter(text);
    for (const key of CONFORMANT_SCALARS) {
      if (!(key in flat) && !(key in canon)) continue;
      assert.equal(String(canon[key]), String(flat[key]),
        `'${key}' diverged between parsers on fixture starting ${JSON.stringify(text.slice(0, 30))}`);
    }
  }
});
