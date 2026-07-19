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

test('hooks.json: SessionEnd registers the close hook (NOT Stop — per-turn would mis-fire the heavy close)', () => {
  const h = JSON.parse(read('hooks', 'hooks.json'));
  assert.ok(h.hooks.SessionEnd, 'SessionEnd hook must be registered');
  const cmd = JSON.stringify(h.hooks.SessionEnd);
  assert.match(cmd, /close-pass-hook\.mjs/, 'SessionEnd must point at close-pass-hook.mjs');
  // The heavy self-managed close (close-pass-hook.mjs -> /finalize) must never
  // be wired to Stop — Stop fires every turn, not once per session, and
  // running a full close on every turn would be a correctness disaster. A
  // SEPARATE, lightweight Stop hook (answer-close-hook.mjs, the real
  // post-answer outcome closer per Hale's 2026-07-17 HOLD audit) is fine —
  // this guard is specifically against close-pass ending up there, not
  // against Stop ever being used for anything.
  if (h.hooks.Stop) {
    assert.doesNotMatch(JSON.stringify(h.hooks.Stop), /close-pass-hook\.mjs/, 'close-pass-hook.mjs must never be registered on Stop');
  }
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

test('close hook spawns the DETERMINISTIC envelope (close-pass.mjs run), NOT raw claude -p', () => {
  // Regression guard for the 2026-06-30 finding: a headless LLM narrated a close it never
  // marked. The hook must spawn the `run` envelope (begin/maintenance/finish guaranteed by
  // code), never `claude -p` directly — that would put the marker back at LLM discretion.
  const hook = read('skills', 'core', 'hooks', 'close-pass-hook.mjs');
  assert.match(hook, /close-pass\.mjs/, 'hook must invoke close-pass.mjs');
  assert.match(hook, /'run'|"run"/, 'hook must spawn the run envelope');
  assert.ok(!/spawn\(\s*['"]claude['"]/.test(hook), 'hook must NOT spawn claude directly — the envelope owns that');
});

test('finalize: envelope mode tells the agent the runner owns the marker (no double-run)', () => {
  const f = read('skills', 'finalize', 'SKILL.md');
  assert.match(f, /CORE_CLOSE_ENVELOPE/, 'finalize must document the envelope signal');
  assert.match(f, /runner owns/i, 'finalize must say the runner owns the marker lifecycle');
});

test('finalize: full narrative summary every close, never sourced from prior summaries', () => {
  // David 2026-07-02: the stub-only close is reversed — headless runs invisibly, so the full
  // narrative costs the user nothing. And the 2026-07-01 close copied a stale claim out of an
  // old summary, so the compose-from-current-state rule is load-bearing, not style.
  const f = read('skills', 'finalize', 'SKILL.md');
  assert.match(f, /full narrative summary/i, 'the summary must be the full narrative, not a stub');
  assert.match(f, /every close, both modes/i, 'the summary must be written on every close in both modes');
  assert.match(f, /never from prior summaries/i, 'summaries must not be composed from prior summaries');
  assert.match(f, /Record op `session-summary`/, 'the summary op must be recorded under its real name');
  assert.ok(!f.includes('summary-stub'), 'the old stub op name must be gone from finalize');
});

test('finalize: one method — envelope mode records judgment ops like a manual run', () => {
  // The unification (David 2026-07-02): mode moves the audience, never the method. The runner
  // owns begin/maintenance/finish; the agent records its judgment ops in BOTH modes, which is
  // safe because the runner spawns finalize synchronously and finishes only after it returns.
  const f = read('skills', 'finalize', 'SKILL.md');
  assert.match(f, /record each judgment op you complete exactly as in a manual run/i,
    'envelope mode must record per-op like manual — a headless close must not be opaque in the marker');
  assert.match(f, /mode moves the audience, never the method/i, 'the unification rule must be stated');
});

test('the close op list has a single source: close-pass.mjs CLOSE_OPS', async () => {
  const { CLOSE_OPS } = await import('../../plugins/core/skills/core/scripts/close-pass.mjs');
  const opsCsv = CLOSE_OPS.join(',');
  const hook = read('skills', 'core', 'hooks', 'close-pass-hook.mjs');
  assert.ok(!/const CLOSE_OPS\s*=\s*\[/.test(hook), 'the hook must import CLOSE_OPS, not redefine it');
  assert.match(hook, /CLOSE_OPS/, 'the hook must use the imported CLOSE_OPS');
  assert.ok(read('skills', 'core', 'protocols', 'startup.md').includes(opsCsv),
    'startup.md detect --ops must match CLOSE_OPS exactly');
  assert.ok(read('skills', 'finalize', 'SKILL.md').includes(opsCsv),
    'finalize SKILL.md begin --ops must match CLOSE_OPS exactly');
});

test('codex: the exit-hook drop names startup-catch-up as the equivalent', () => {
  const c = read('skills', 'core', 'harnesses', 'codex.md');
  assert.match(c, /close-pass/i, 'codex adapter must carry the close-pass drop');
  assert.match(c, /startup catch-up/i, 'the drop must name startup catch-up as the equivalent');
});
