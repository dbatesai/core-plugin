# Audit fixes — 2026-07-02

Four small, independent fixes from the 2026-07-01 night-drop audit of core-plugin. Each is test-first, each is its own commit, none changes a feature's intent. Landed on branch `audit-fixes-2026-07-02` off `next` for hand review — not pushed, no PR, no release.

Full audit and reasoning live in the development workshop's audit notes (iter09 master findings, iter10 build plan).

## Global constraints
- Runtime: Node.js `.mjs` only, must work on macOS and Windows.
- Must not regress the existing suite (`node --test tests/scripts/*.test.mjs`).
- Each fix: failing test first, then the change, then green, then commit.

---

## Fix 1 — one shared "is this fact still showable" check

**Problem.** When a user deletes a fact from PROJECT.md, its unit is marked with a terminal status (retired/archived/superseded). Three read paths each check only half of what "showable" means, so deleted facts leak back:
- `graph-walk.mjs` and `priority.mjs` `rankUnits` check *not invalidated* but never check *status* → a retired, canonical, freshly-dated unit (score ~0.98) surfaces and ranks first.
- `generate-summary-index.mjs` `isActive` checks *status* but never checks *invalidated* → an invalidated-but-active unit gets indexed.

**Fix.** Add a leaf-safe status helper to `unit-vocab.mjs` (which already owns `TERMINAL_STATUSES`), and make each read site check both halves.

- `unit-vocab.mjs`: add `export function isActiveStatus(fm)` → true when status is missing/empty/`active`, false when terminal.
- `graph-walk.mjs`: beside the existing `isInvalidated` suppression (line ~155), add terminal-status suppression — same suppress-and-stop-branch behavior (a deleted fact is not a gateway; its live successor is reachable via the supersedes edge directly). Track a `suppressed_retired` count alongside `suppressed_invalidated`.
- `priority.mjs` `rankUnits` (line ~449): add `.filter(u => isActiveStatus(u.fm))` beside the `!isInvalidated` filter. Import `isActiveStatus` from `./unit-vocab.mjs`.
- `generate-summary-index.mjs`: in the unit loop, skip invalidated units too (`import { isInvalidated } from './priority.mjs'`; skip when `isInvalidated(unit, new Date())`).

**Tests (T1/T2/T3).** A fixture unit with `status: retired`, `canonical: true`, `sources: [PROJECT.md]`, and a fresh `updated` date (so its score clears the 0.3 prune) must NOT appear in a `graph-walk` from a live neighbor, must NOT appear in `rankUnits`, must NOT appear in `retrieveContext`. An active unit in the same fixture MUST still appear (proves the filter isn't over-broad).

**Regression watch.** Some existing tests may assert the current (buggy) behavior that retired units surface. If one breaks *because* it asserted a retired unit is retrievable, that test encoded the bug — update it and note it. Any other breakage gets investigated, not patched over.

---

## Fix 2 — stop the per-turn hook writing into strangers' repos

**Problem.** `retrieve-context.mjs` `retrieveContext` calls `generateSummaryIndex(root)` whenever the index is missing/stale. `generateSummaryIndex` does `mkdirSync(_memories/_lib, {recursive:true})`, which creates `_memories/` from nothing. So the per-turn hook, which runs in every directory the user opens, litters `_memories/_lib/unit-summaries.json` into unrelated repos.

**Fix.** In `retrieveContext`, before regenerating: if `_memories/` does not already exist under the store root, return `[]` (no store here — nothing to retrieve, nothing to write).

**Test (T20).** Run `retrieveContext('anything', <empty-temp-dir>)` and assert the temp dir still contains zero files/dirs afterward, and the return is `[]`.

---

## Fix 3 — make the self-managed close work on Windows

**Problem.** `close-pass.mjs` `defaultSpawnFinalize` runs `spawnSync('claude', ['-p','/finalize'], {...})` with no `shell` option. On Windows the `claude` CLI is `claude.cmd`, and current Node.js (all versions with the CVE-2024-27980 fix) throws `EINVAL` when asked to spawn a `.cmd`/`.bat` without `shell: true`. So the self-managed close fails silently on every Windows session, forever re-owing.

**Fix.** Add a tiny exported pure helper `export function claudeSpawnShell(platform = process.platform) { return platform === 'win32'; }` and pass `shell: claudeSpawnShell()` in the spawn options. Args stay a fixed literal array (`['-p','/finalize']`) — no user input, so `shell: true` carries no injection risk here.

**Test.** Assert `claudeSpawnShell('win32') === true` and `claudeSpawnShell('darwin') === false`. This tests the exact function that decides the flag on the real code path — not a fake-injected spawn the way the current close tests do.

---

## Fix 4 — a hostile repo can't redirect the workspace-trust check

**Problem.** `close-pass.mjs` `isRegisteredWorkspace` reads its registry path from `process.env.CORE_CLOSE_INDEX` unconditionally. A trusted-but-hostile repo can set that variable in its own `.claude/settings.json` (confirmed: Claude Code forwards project settings env into hook subprocesses), pointing the "is this a trusted workspace?" check at a fake index — which then lets the close hook spawn a tool-enabled agent inside the repo.

**Fix.** Add an exported pure helper `export function resolveIndexPath(env = process.env)`: if `env.CORE_CLOSE_INDEX` is set AND its resolved absolute path is inside `~/.core`, honor it; otherwise ignore it and return the default `~/.core/index.json`. Use it as the default for `isRegisteredWorkspace`'s `indexPath`.

**Test.** With `CORE_CLOSE_INDEX` set to a repo-local path (e.g. `/tmp/evil/index.json`), `resolveIndexPath` returns the default `~/.core/index.json`. With it set to a path under `~/.core`, that path is honored.

---

## What this deliberately does NOT touch (deferred by decision)
The fork-check trust-model change (risks breaking legitimate copied-workspace detection), the close lock-ownership fix, the PROJECT.md lost-edit guard, moving edit-detection into a script, the ~2,000-line dead-code deletion, a repo-change entry point for memory, and the telemetry-fail-loud change (its fail-open was partly intentional). All are written up in the audit's master findings for an attended decision.
