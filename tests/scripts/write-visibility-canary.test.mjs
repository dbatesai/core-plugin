import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  upsertCanaryLine, generateToken, CANARY_TAG,
} from '../../plugins/core/skills/core/scripts/write-visibility-canary.mjs';

const MEMORY = [
  '## Recent activity',
  '',
  '- a memory line',
  '',
].join('\n');

function canaryLines(content) {
  return content.split('\n').filter((l) => l.startsWith(CANARY_TAG));
}

test('upsertCanaryLine inserts the canary at the top of content that lacks it', () => {
  const token = 'vcan-0123456789abcdef';
  const out = upsertCanaryLine(MEMORY, token);
  assert.ok(out.startsWith(`${CANARY_TAG} ${token}`), 'canary is the first line');
  assert.match(out, new RegExp(`VISIBILITY-CANARY-ECHO: ${token}`), 'echo instruction included');
  assert.ok(out.includes('- a memory line'), 'existing content preserved');
  assert.equal(canaryLines(out).length, 1);
});

test('a second upsert replaces the existing token rather than duplicating the line', () => {
  const first = upsertCanaryLine(MEMORY, 'vcan-aaaaaaaaaaaaaaaa');
  const second = upsertCanaryLine(first, 'vcan-bbbbbbbbbbbbbbbb');
  assert.equal(canaryLines(second).length, 1, 'never accumulates canary lines');
  assert.ok(second.includes('vcan-bbbbbbbbbbbbbbbb'));
  assert.ok(!second.includes('vcan-aaaaaaaaaaaaaaaa'), 'old token gone');
  assert.ok(second.includes('- a memory line'), 'memory content survives');
});

test('the legacy HTML-comment canary form is also replaced on upsert', () => {
  const legacy = `<!-- ${CANARY_TAG} vcan-oldoldoldoldold1 -->\n\n${MEMORY}`;
  const out = upsertCanaryLine(legacy, 'vcan-cccccccccccccccc');
  assert.ok(!out.includes('vcan-oldoldoldoldold1'), 'legacy comment line stripped');
  assert.equal(canaryLines(out).length, 1);
});

test('generateToken returns vcan-<hex> and differs across calls', () => {
  const a = generateToken();
  const b = generateToken();
  assert.match(a, /^vcan-[0-9a-f]{16}$/);
  assert.match(b, /^vcan-[0-9a-f]{16}$/);
  assert.notEqual(a, b);
});
