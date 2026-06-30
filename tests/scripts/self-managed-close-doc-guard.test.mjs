import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

// Structural guards for self-managed maintenance (spec 2026-06-29). These assert the
// load-bearing invariants the adversarial pass caught survive future prose edits — they
// are documentation, but documentation the whole correctness argument rests on.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'core');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

test('startup: catch-up runs AFTER the edit-detection block (edit-detection-first crux)', () => {
  const s = read('skills', 'core', 'protocols', 'startup.md');
  const editDetect = s.indexOf('Run edit-detection on the files you read');
  const catchUp = s.indexOf('## Startup catch-up');
  assert.ok(editDetect > 0, 'edit-detection block must exist');
  assert.ok(catchUp > 0, 'startup catch-up section must exist');
  assert.ok(catchUp > editDetect,
    'catch-up MUST come after edit-detection — a deferred render can never precede the user-edit check');
  assert.match(s.slice(catchUp, catchUp + 1600), /edit-detection runs FIRST and wins/i,
    'catch-up must explicitly state edit-detection-first');
});

test('finalize: every PROJECT.md write is edit-gated', () => {
  const f = read('skills', 'finalize', 'SKILL.md');
  assert.match(f, /every PROJECT\.md write is edit-gated/i, 'the control-surface rule must be stated');
  assert.match(f, /CORE_CLOSE_HEADLESS/, 'finalize must branch on headless mode');
  assert.match(f, /CORE_AUTO_CLOSE=0/, 'finalize must name the kill switch');
});

test('finalize: reflection Task A + Task B are both present', () => {
  const f = read('skills', 'finalize', 'SKILL.md');
  assert.match(f, /Reflection Task A/i, 'Task A (resynthesis) must be present');
  assert.match(f, /Reflection Task B/i, 'Task B (perspective) must be present');
});

test('hooks.json: SessionEnd registers the close hook (NOT Stop — per-turn would mis-fire)', () => {
  const h = JSON.parse(read('hooks', 'hooks.json'));
  assert.ok(h.hooks.SessionEnd, 'SessionEnd hook must be registered');
  assert.ok(!h.hooks.Stop, 'must NOT be a Stop hook — Stop fires every turn, not once per session');
  const cmd = JSON.stringify(h.hooks.SessionEnd);
  assert.match(cmd, /close-pass-hook\.mjs/, 'SessionEnd must point at close-pass-hook.mjs');
});

test('hooks.json: SessionStart auto-invokes /core (the front half of self-running)', () => {
  const h = JSON.parse(read('hooks', 'hooks.json'));
  assert.ok(h.hooks.SessionStart, 'SessionStart hook must be registered');
  assert.match(JSON.stringify(h.hooks.SessionStart), /session-start-hook\.mjs/,
    'SessionStart must point at session-start-hook.mjs');
});

test('session-start hook: injects the /core directive, honors the opt-out', () => {
  const hook = read('skills', 'core', 'hooks', 'session-start-hook.mjs');
  assert.match(hook, /\/core/, 'must direct the agent to invoke /core');
  assert.match(hook, /CORE_AUTOSTART/, 'must carry the opt-out env var');
});

test('close hook: recursion guard + kill switch + spawn pre-check are all wired', () => {
  const hook = read('skills', 'core', 'hooks', 'close-pass-hook.mjs');
  assert.match(hook, /CORE_CLOSE_PASS_ACTIVE/, 'recursion guard');
  assert.match(hook, /CORE_AUTO_CLOSE/, 'kill switch');
  assert.match(hook, /shouldSpawn/, 'spawn pre-check');
  assert.match(hook, /detached: true/, 'child must be detached to survive session exit');
});

test('codex: the exit-hook drop names startup-catch-up as the equivalent', () => {
  const c = read('skills', 'core', 'harnesses', 'codex.md');
  assert.match(c, /close-pass/i, 'codex adapter must carry the close-pass drop');
  assert.match(c, /startup catch-up/i, 'the drop must name startup catch-up as the equivalent');
});
