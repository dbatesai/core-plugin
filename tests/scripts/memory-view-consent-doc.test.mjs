import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

// One consent contract, stated identically on every user-facing surface.
// The memory-view skill ships two consent modes: per-publish confirmation by
// default, and an explicit PROSPECTIVE standing authorization (user-granted,
// recorded, scoped to the user's own data on their own account, revocable)
// under which publishes — including live mode's republishes — narrate and
// proceed while the grant remains valid. The public docs must describe that
// same contract, not a stricter or looser one.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(REPO_ROOT, ...p), 'utf8');

test('memory-view SKILL.md documents both consent modes with scope and revocation', () => {
  const skill = read('plugins', 'core', 'skills', 'memory-view', 'SKILL.md');
  assert.match(skill, /standing authorization/i, 'the standing-authorization mode must be documented');
  assert.match(skill, /default is ask-first/i, 'per-publish confirmation must be the documented default');
  assert.match(skill, /revocable any time|revocable at any time/i, 'the grant must be documented as revocable');
  assert.match(skill, /prospective and bounded/i, 'live mode must document the grant as prospective and bounded');
});

test('public docs describe the same contract the skill ships — no per-publish-only overclaim', () => {
  for (const doc of ['USAGE.md', 'INSTALL.md']) {
    const text = read(doc);
    assert.doesNotMatch(text, /there is no standing consent/i,
      `${doc} must not deny the standing-authorization mode the skill ships`);
    assert.doesNotMatch(text, /published? [^\n]*only after you confirm|never automatic/i,
      `${doc} must not claim publishes are exclusively per-publish-confirmed`);
    assert.match(text, /standing authorization/i,
      `${doc} must document the standing-authorization mode alongside the confirm-by-default mode`);
  }
});

test('public docs keep the default and the boundary: explicit yes absent a grant, never scheduled or startup-run', () => {
  const usage = read('USAGE.md');
  assert.match(usage, /explicit yes/i, 'USAGE.md must state the per-publish default');
  assert.match(usage, /never runs at startup, at session close, or on a schedule/i,
    'USAGE.md must keep the no-automatic-trigger boundary');
});
