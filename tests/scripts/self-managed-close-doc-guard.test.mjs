import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

// Structural guards for self-managed maintenance (spec 2026-06-29). These assert the
// load-bearing invariants the adversarial pass caught survive future prose edits — they
// are documentation, but documentation the whole correctness argument rests on.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = join(REPO_ROOT, 'plugins', 'core');
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

test('close hook spawns the DETERMINISTIC per-session close, NOT raw claude -p', () => {
  // Regression guard for the 2026-06-30 finding: a headless LLM narrated a close it never
  // marked. The hook must spawn a deterministic runner, never `claude -p` directly — that
  // would put the marker back at LLM discretion.
  //
  // The subcommand changed from `run` (broad, whole-store) to `process-request` (one exact
  // session) in the finalize redesign. The invariant is unchanged and now stronger: the
  // spawned path makes zero model calls at all.
  const hook = read('skills', 'core', 'hooks', 'close-pass-hook.mjs');
  assert.match(hook, /close-pass\.mjs/, 'hook must invoke close-pass.mjs');
  assert.match(hook, /'process-request'|"process-request"/, 'hook must spawn the per-session close');
  assert.match(hook, /'--session'|"--session"/, 'hook must pass the exact session through to the runner');
  assert.ok(!/spawn\(\s*['"]claude['"]/.test(hook), 'hook must NOT spawn claude directly — the runner owns that');
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

  // The hook no longer participates in this invariant. Under the finalize redesign it
  // makes an exact-session enqueue decision and knows nothing about the op list — which
  // is the point: the op list was the surface that made every close broad. The
  // single-source rule still binds the two readers that do consume it.
  const hook = read('skills', 'core', 'hooks', 'close-pass-hook.mjs');
  assert.ok(!/const CLOSE_OPS\s*=\s*\[/.test(hook), 'the hook must never define its own op list');

  assert.ok(read('skills', 'core', 'protocols', 'startup.md').includes(opsCsv),
    'startup.md detect --ops must match CLOSE_OPS exactly');
  assert.ok(read('skills', 'finalize', 'SKILL.md').includes(opsCsv),
    'finalize SKILL.md begin --ops must match CLOSE_OPS exactly');
});

// Graph decoration (`/export-obsidian` retired 2026-07-22 — see CHANGELOG) is
// now wired into the automatic maintenance passes the same way demote-moves
// and compact-project are: a tracked close op the LLM half of /finalize (and
// the on-demand /process-memory pass) actually invokes and records, not just
// a string sitting in an array. close-pass.mjs itself never calls the
// decorator directly — like every other judgment op except maintenance-run,
// execution is the agent's job per finalize/SKILL.md; this only guards that
// the wiring instructions are actually present, not silently dropped.
test('decorate-graph: tracked as a real close op (STORE_DERIVED + CLOSE_OPS), not a phantom string', async () => {
  const mod = await import('../../plugins/core/skills/core/scripts/close-pass.mjs');
  assert.ok(mod.CLOSE_OPS.includes('decorate-graph'), 'CLOSE_OPS must list decorate-graph');
  assert.equal(mod.isStoreDerived('decorate-graph'), true,
    'decorate-graph rewrites unit files, so it must re-owe on a post-close store change like demote-moves/compact-project/check-units');
});

test('decorate-graph: finalize/SKILL.md actually invokes the script and records the op', () => {
  const f = read('skills', 'finalize', 'SKILL.md');
  assert.match(f, /node \$\{CORE_ROOT\}\/skills\/core\/scripts\/decorate-graph\.mjs <project>/,
    'finalize must run decorate-graph.mjs, not just mention it');
  assert.match(f, /Record op `decorate-graph`/, 'the decoration sub-step must record its op like its siblings');
});

test('decorate-graph: process-memory/SKILL.md actually invokes the script', () => {
  const p = read('skills', 'process-memory', 'SKILL.md');
  assert.match(p, /node "\$\{CORE_ROOT\}\/skills\/core\/scripts\/decorate-graph\.mjs" "<project>"/,
    'process-memory must run decorate-graph.mjs as part of its hygiene sequence, not just describe it');
});

test('export-obsidian: fully retired — no shipped skill, no lingering command references in the shipped docs', () => {
  assert.ok(!existsSync(join(ROOT, 'skills', 'export-obsidian')),
    'the export-obsidian skill directory must be gone');
  for (const doc of ['README.md', 'USAGE.md', 'INSTALL.md']) {
    const src = readFileSync(join(REPO_ROOT, doc), 'utf8');
    assert.ok(!src.includes('export-obsidian'), `${doc} must not reference the retired /export-obsidian command`);
  }
});

// The 2026-07-22 direct-verification backstop (David's direction: startup must ensure all
// data is indexed and processed, not just infer it from close-pass bookkeeping). These guard
// the same "op is really wired, not a phantom string" invariant as the decorate-graph tests
// above, applied to the new unconditional startup step rather than the close-time wiring.
test('startup: decoration + index refresh backstop runs for real (not --dry-run/--check), guarded like every script call', () => {
  const s = read('skills', 'core', 'protocols', 'startup.md');
  assert.match(s, /node "\$\{CORE_ROOT\}\/skills\/core\/scripts\/decorate-graph\.mjs" <project> \\/,
    'startup must invoke decorate-graph.mjs directly, not just describe it');
  assert.match(s, /node "\$\{CORE_ROOT\}\/skills\/core\/scripts\/maintenance-run\.mjs" <project> --json \\/,
    'startup must invoke maintenance-run.mjs directly, not just describe it');

  const backstop = s.indexOf('Decoration + index refresh backstop');
  assert.ok(backstop > 0, 'the backstop step must exist');
  const block = s.slice(backstop, backstop + 1500);
  assert.ok(!/decorate-graph\.mjs[^\n]*--dry-run/.test(block), 'decoration must run for real, never --dry-run, at startup');
  assert.ok(!/decorate-graph\.mjs[^\n]*--check/.test(block), 'decoration must run for real, never --check, at startup');
  assert.match(block, /\[ -n "\$CORE_ROOT" \] && \[ -d "\$CORE_ROOT\/skills\/core\/scripts" \] &&/,
    'the decoration/index calls must be guarded exactly like every other script call in this file');
});

test("startup: the backstop step runs AFTER edit-detection and before startup catch-up (Hale's authorship-ordering finding, 2026-07-22)", () => {
  // Was: 'the backstop step sits right after the integrity probe and before the
  // retrieval ladder' — that WAS the bug. Hale's repro (mailbox
  // "723c24a-authorship-ordering-repro", 2026-07-22): running decoration before
  // edit-detection ever read the pre-decoration bytes let decorate-graph
  // preserve a between-session user edit's BYTES while unconditionally
  // stamping a fresh baseline over it — so edit-detection, once it finally
  // ran, could never observe that the edit had happened at all (classified
  // 'edges-block-only' instead of 'outside-changed'). The doc-level fix is
  // ordering: edit-detection must classify the files the retrieval ladder
  // just read BEFORE this backstop's decoration/maintenance calls get a
  // chance to rewrite and re-stamp them. (The writers also refuse this in
  // code now regardless of call order — see decorate-graph.mjs/
  // hot-section.mjs's needs_reconciliation gate — but the doc order must not
  // contradict that belt-and-suspenders story either.)
  const s = read('skills', 'core', 'protocols', 'startup.md');
  const integrity = s.indexOf('Integrity probe before loading');
  const ladder = s.indexOf('The v2 load uses the retrieval ladder');
  const editDetection = s.indexOf('Run edit-detection on the files you read');
  const backstop = s.indexOf('Decoration + index refresh backstop');
  const catchUp = s.indexOf('## Startup catch-up');
  assert.ok(integrity > 0 && ladder > 0 && editDetection > 0 && backstop > 0 && catchUp > 0, 'all five anchors must exist');
  assert.ok(ladder > integrity, 'the retrieval ladder reads files after the integrity probe');
  assert.ok(editDetection > ladder, 'edit-detection classifies the files the retrieval ladder just read');
  assert.ok(backstop > editDetection,
    'the backstop must run AFTER edit-detection has classified the pre-decoration bytes — never before');
  assert.ok(backstop < catchUp, 'the backstop must still run before (and independent of) the close-pass catch-up bookkeeping');
});

test('startup: the backstop is framed as unconditional and independent of close-pass bookkeeping, not a duplicate of it', () => {
  const s = read('skills', 'core', 'protocols', 'startup.md');
  const backstop = s.indexOf('Decoration + index refresh backstop');
  const catchUp = s.indexOf('## Startup catch-up');
  const block = s.slice(backstop, catchUp);
  assert.match(block, /unconditionally/, 'must state the step runs unconditionally');
  assert.match(block, /independent of whatever the close-pass ledger believes happened/i,
    'must state independence from close-pass bookkeeping explicitly');
  assert.match(block, /backstop, not a replacement/, 'must state this is additive to, not a replacement for, /finalize and /process-memory wiring');
  assert.match(block, /feedback_readiness_only_escalations/, 'must narrate per the only-escalate convention, not routine housekeeping');
});

test('startup: maintenance-run.mjs is the real index-regeneration entry point (matches /finalize\'s own "folded into maintenance-run" convention)', async () => {
  // Guards against reinventing raw generate-*-index.mjs calls in the new step when the
  // codebase already has one canonical, signature-gated bundling entry point for this.
  const { runMaintenance } = await import('../../plugins/core/skills/core/scripts/maintenance-run.mjs');
  assert.equal(typeof runMaintenance, 'function', 'maintenance-run.mjs must export runMaintenance');
  const f = read('skills', 'finalize', 'SKILL.md');
  assert.match(f, /folded into `maintenance-run`/, 'finalize must still treat maintenance-run as the single index-regen entry point');
});

test('codex: the exit-hook drop names startup-catch-up as the equivalent', () => {
  const c = read('skills', 'core', 'harnesses', 'codex.md');
  assert.match(c, /close-pass/i, 'codex adapter must carry the close-pass drop');
  assert.match(c, /startup catch-up/i, 'the drop must name startup catch-up as the equivalent');
});
