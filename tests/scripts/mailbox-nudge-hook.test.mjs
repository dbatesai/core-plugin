/**
 * mailbox-nudge-hook.test.mjs — the UserPromptSubmit companion hook that
 * surfaces a project's own _mailbox/ unread count on every turn. Isolated
 * from retrieve-context-hook.mjs entirely (own file, own subprocess).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNudge } from '../../plugins/core/skills/core/hooks/mailbox-nudge-hook.mjs';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'hooks', 'mailbox-nudge-hook.mjs');

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'mbox-nudge-proj-'));
  mkdirSync(join(dir, '_memories'), { recursive: true }); // CORE marker → a real project
  return dir;
}

function plantMessage(projectDir, name) {
  mkdirSync(join(projectDir, '_mailbox'), { recursive: true });
  writeFileSync(join(projectDir, '_mailbox', name), '---\nfrom: Hale\ntopic: test\ndate: 2026-07-20\n---\nbody\n');
}

const run = (payload) => execFileSync('node', [HOOK], {
  input: JSON.stringify(payload),
  encoding: 'utf8',
});

test('buildNudge: zero count produces no output', () => {
  assert.equal(buildNudge(0), '');
});

test('buildNudge: singular vs plural wording', () => {
  assert.match(buildNudge(1), /1 unread message in _mailbox\//);
  assert.match(buildNudge(3), /3 unread messages in _mailbox\//);
});

test('subprocess: no _mailbox/ dir → silent (the common no-op case)', () => {
  const dir = project();
  try {
    const out = run({ cwd: dir });
    assert.equal(out, '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('subprocess: unread messages present → nudge with correct count', () => {
  const dir = project();
  try {
    plantMessage(dir, 'hale--finding--2026-07-20.md');
    plantMessage(dir, 'antigravity--reply--2026-07-20.md');
    const out = run({ cwd: dir });
    assert.match(out, /2 unread messages in _mailbox\//);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('subprocess: archived messages are never counted', () => {
  const dir = project();
  try {
    plantMessage(dir, 'hale--finding--2026-07-20.md');
    mkdirSync(join(dir, '_mailbox', 'archive'), { recursive: true });
    writeFileSync(join(dir, '_mailbox', 'archive', 'old--topic--2026-07-01.md'), 'archived body');
    const out = run({ cwd: dir });
    assert.match(out, /1 unread message in _mailbox\//, 'only the unarchived message counts');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('subprocess: malformed stdin JSON fails open, never throws or blocks', () => {
  const out = execFileSync('node', [HOOK], { input: 'not json{{{', encoding: 'utf8' });
  assert.equal(out, ''); // falls back to process.cwd(), which has no _mailbox/ in the test runner
});

test('subprocess: empty stdin fails open', () => {
  const out = execFileSync('node', [HOOK], { input: '', encoding: 'utf8' });
  assert.equal(out, '');
});

test('subprocess: a missing cwd on disk fails open rather than crashing', () => {
  const out = run({ cwd: '/definitely/does/not/exist/anywhere' });
  assert.equal(out, '');
});
