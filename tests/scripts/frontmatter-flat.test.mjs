import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlatFrontmatter } from '../../plugins/core/skills/core/scripts/frontmatter-flat.mjs';

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
