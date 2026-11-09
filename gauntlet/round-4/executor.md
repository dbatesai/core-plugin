# Round 4 — Executor (D3 v4)

I walked `v4-d3.md` from step 0.1 onward as if I were building it. I checked facts with read-only commands only: `git ls-remote origin` (`next` exists at `d23c9f9`), `gh api …/compare/main...next` (98 files; the nine added test files match 9.5's count), `claude --version` (2.1.321), Node 22, the CORE 3 source, and the docs `plugin-evals.md`, `skills.md`, `headless.md` and `agent-sdk/typescript.md` at code.claude.com.

Steps 0.1–0.4 run as written. 0.2's numbers were reproduced last round. 9.5's rebase recipe matches what `next` actually adds.

**First step where I get stuck: 2.3.** The record test's init check needs "exactly the arm's … skills", but every Claude Code session lists its bundled skills (R4-EX-07). I would have to stop the build or rewrite the check after seeing data. **The first hard stop that needs a person is 4.5:** v3's decorator refuses every file in a copied store, so the fifth fixture cannot be built (R4-EX-01).

---

### R4-EX-01  —  major
- **Artifact:** D3
- **Location:** Step 4.5 Do, "In the `../core-v3` worktree (0.2), copy one `tests/fixtures/` store to a temp project, run v3's own `plugins/core/skills/core/scripts/decorate-graph.mjs` on it"; If it fails, "v3's decorator will not run in the worktree → ask the maintainer … `[human]`"
- **What is wrong:** This is the H17 fix for R3-EX-04, and it cannot work. v3's decorator refuses to write any memory that has no stamp in v3's state cache. A store freshly copied from `tests/fixtures/` has no cache, so every memory goes to `needs_reconciliation`. No `CORE:BEGIN_EDGES` block is written, and the script exits 1. The decorator *runs*, so the step's own fallback ("will not run") does not literally apply. The only route left is the `[human]` one, in a step labelled `[agent]`.
- **What breaks if we ship it as-is:** The zero-context agent stops at 4.5 and waits for a maintainer to supply a real v3 project. If no one answers, migrate's marker-stripping (steps 3 and 4) goes untested, which is exactly the gap R3-EX-04 was meant to close.
- **Suggested fix:** Name the v3 call that makes the store decoratable, for example v3's own adopt or stamp-baseline flow (`lifecycle-detect.mjs stampCreatedBaseline`) run on each file first. Or allow the agent to write well-formed BEGIN/END pairs by hand from the `EDGES_BEGIN`/`EDGES_END` constants, and say that the byte-exact Accept still holds.
- **Evidence:** `plugins/core/skills/core/scripts/lifecycle-core.mjs:101-105` (`if (!cachedStamp) … return { proceed: false, classification: 'no-baseline' …}`); `decorate-graph.mjs:253-256` (refused units are pushed to `needsReconciliation`), `:379` (exit 1 when any need reconciliation); `protocols/data-storage.md:530`: "A file with NO prior cache entry always refuses too".

### R4-EX-02  —  major
- **Artifact:** D3
- **Location:** Step 4.5, "add a `PROJECT.md` with the `<!-- CORE:` marker lines v3 writes (their form is in v3's `unit-vocab.mjs`)" and migrate step 4, "In `PROJECT.md`, remove lines starting with `<!-- CORE:`"; step 1.2 §10, a v3 store is "a `PROJECT.md` line starting `<!-- CORE:`"
- **What is wrong:** v3 never writes a `<!-- CORE:` line into `PROJECT.md`. Its `PROJECT.md` markers are `<!-- HOT-SECTION:BEGIN -->` and `<!-- HOT-SECTION:END -->`, around a generated `## Right now` block. `unit-vocab.mjs` holds only the two edge markers, which go in memory files. So three things built on this sign are wrong. The v3 detection sign in 1.2 never fires. Migrate step 4 removes nothing from a real v3 `PROJECT.md`. And the 4.5 fixture tells the agent to copy a marker form that does not exist.
- **What breaks if we ship it as-is:** After `migrate --apply`, a real v3 project keeps v3's generated hot section and its markers inside the file v4 calls the user's own (rule 4). The session-start hook then injects that stale synthesis into every session. The Accept, "`PROJECT.md` keeps every line but the marker lines", passes on a hand-made fixture that matches no real v3 project.
- **Suggested fix:** Use `<!-- HOT-SECTION:BEGIN -->`/`END` as the `PROJECT.md` sign and as what migrate strips, and say whether the text between them is kept or dropped. Build the fixture's `PROJECT.md` with v3's `hot-section.mjs apply`.
- **Evidence:** `plugins/core/skills/core/scripts/hot-section.mjs:38-39`; `unit-vocab.mjs:92-93` (only `CORE:BEGIN_EDGES`/`END_EDGES`); `grep -rhoE "<!-- ?CORE:[A-Za-z_-]+" plugins/core/skills/core/scripts/` → only the two edge markers.

### R4-EX-03  —  major
- **Artifact:** D3
- **Location:** Step 9.4, the v3 comparison: "to each copied `case.yaml`'s `execution.env` add `CORE_TEST_ACCOUNT_HOME: "<H>"` and `NODE_OPTIONS: "--import …"`"
- **What is wrong:** This is the H17 fix for R3-FC-08, and the runner rejects it. `env` keys must match `EVAL_[A-Z0-9_]*`. Any other key fails the run. Both keys are outside that pattern, so every v3 run errors before Claude starts.
- **What breaks if we ship it as-is:** Every v3 run errors, so `v3-recall` never appears and the gate reads "v3 comparison: not measured" on every build. Requirement 7's comparison against a prior version never produces a number, and the plan gives no route that could make it produce one. The $15 cap is spent on runs that cannot score.
- **Suggested fix:** Pass the values as `EVAL_CORE_TEST_ACCOUNT_HOME` and set the redirection inside v3's hook wrapper in the worktree copy. Or seed `<H>` and point v3's hooks at it through a flag in the copied `hooks.json`, since hooks run outside the sandbox and need no environment variable.
- **Evidence:** plugin-evals.md:533, `env`: "Keys must match `EVAL_[A-Z0-9_]*`; any other key fails the run." case.yaml fields: "`env` go[es] under `execution:`".

### R4-EX-04  —  major
- **Artifact:** D3
- **Location:** Step 2.3 Do 1, "`package-layer1.mjs --arm layer1` and `--arm kit`", then Do 3, "After the preflight (0.6): `claude plugin eval dist/core-layer1 …`"; 0.6, "`build-eval-fixtures.mjs` … fills `append_system_prompt` in the gated cases' `prompt.md` with the instruction block … from step 1.1's files once they exist"
- **What is wrong:** In 2.3 the packages are built (step 1) before the preflight (step 3). `build-eval-fixtures.mjs` takes no target folder, so it writes into `plugins/core/evals/` only, never into `dist/`. Its only earlier run was in 0.6, before 1.1's block existed. So the `dist/` copies hold `proactive-due/prompt.md` with no instruction block, and 0.6's old `dates.sh`.
- **What breaks if we ship it as-is:** Kill rule (b) compares layer 1 with "the kit twin: the record and the instruction block". In fact neither arm has the block, so "kit" is the files arm. The rule meant to decide whether CORE should exist gives skills a head start and labels the result "kit". The stale `TODAY` also turns "due today" into "overdue since <0.6's date>", which the `judge` rubric fails on in both arms.
- **Suggested fix:** Run the preflight first in 2.3, as 7.1 does. Give `build-eval-fixtures.mjs` an `--evals <dir>` argument, and have `package-layer1.mjs` call it on the copy. `package-layer1.test.mjs` asserts each gated `prompt.md` in `dist/` holds the three block lines.
- **Evidence:** v4-d3.md:615, :626, :910–912. Step 7.1 Run (lines 1307–1311) puts the preflight before packaging; 2.3 reverses it.

### R4-EX-05  —  major
- **Artifact:** D3
- **Location:** Step 0.6 Decide, "steps 5.4's prompt hook and the Antigravity `Stop` hook are not built … Everything else goes on"; 9.4, a shelved hook loses "its entries … its branch … its tests, and its `selftest` rows"
- **What is wrong:** This is the H17 early stop, and H4's one-hook-at-a-time shelving, without their knock-on edits. Five parts of the plan assume `prompt` rows exist:
  1. Contract F's status block still says "Each prompt brings a 'CORE recall:' line. If one is missing, recall is off: say so once" (line 384).
  2. 6.2's `hook prompt` selftest row. 9.4's "loses its rows" covers shelving, not the early stop.
  3. 3.2's honesty row for `prompt`.
  4. `env`'s `prompt_hook`, which is `fail` when a session id exists (8.1), and 8.2–8.4, whose Accepts require it `ok`.
  5. Contract E's `no-handoff`, which needs "≥ 3 `prompt` rows" (line 339).
- **What breaks if we ship it as-is:** After an early stop, `selftest` prints `sees: no` for the prompt hook, so 6.3 cannot go green and CI stays red. The agent tells the user "recall is off" in every session. The `metrics` skill reports a hook that was never built as "broken". 8.2 cannot pass. And `no-handoff` can never fire, so the catch-up (1.7) never runs. A never-closed session produces no queue item and no line at session start. That silence reads as "nothing left open".
- **Suggested fix:** Write one list, "when the prompt hook is not built or shelved", used by both 0.6 and 9.4. Drop the status-block line. Drop the selftest and honesty rows. Make `env`'s `prompt_hook` read `unknown, reason not-shipped`. Rebase `no-handoff` on `session-start` rows plus transcript size, or say in the status block "unclosed sessions: not measured".
- **Evidence:** v4-d3.md:339, :384, :630, :1067, :1162, :1350, :1357, :1434.

### R4-EX-06  —  major
- **Artifact:** D3
- **Location:** Step 9.4, "If the session-start hook is shelved, the prompt hook, `PreCompact`, and the liveness line … go too: with no status block, that line would cry wolf. Update `INSTALL.md` and `USAGE.md`"
- **What is wrong:** This is the H2/H4 shelving fix, and it removes the liveness line but keeps every other piece of prose that assumes the hooks:
  - `core` §2: "No status block → … say in one sentence what is not working" (line 687).
  - `ladder.md`'s required Codex sentence, "CORE's hooks need your approval. Type /hooks and approve them" (8.5).
  - The Codex manifest's `"hooks": "./hooks/hooks-codex.json"`, now an empty or deleted file.
  - `hook-files.test.mjs`, "parses all three", and CI's "Validate plugin manifests", which parses `plugins/core/hooks/hooks.json`.
- **What breaks if we ship it as-is:** A Layer-1-plus-script CORE, which is a likely outcome, opens every session by telling the user something is broken. That is the cry-wolf the step itself names as the reason to remove the liveness line. Codex users are told to approve hooks that do not exist. If the agent deletes the emptied hook file, CI's manifest step fails.
- **Suggested fix:** Add to the shelving list: rewrite `core` §2's no-status-block branch for a hook-less build, remove the hook sentences from `ladder.md`, drop the Codex manifest's `hooks` key, and keep `hooks/hooks.json` as `{"hooks":{}}` or remove it from the CI step.
- **Evidence:** v4-d3.md:687, :1378, :1434; `.github/workflows/ci.yml:38-50` (parses `plugins/core/hooks/hooks.json`); `plugins/core/.codex-plugin/plugin.json` `"hooks"` key.

### R4-EX-07  —  major
- **Artifact:** D3
- **Location:** Step 2.1 Do 4, "The repetition is not measured unless every stream's `system` init event lists exactly the arm's plugins and skills"; Accept, "an extra skill … marks the repetition not measured"
- **What is wrong:** The init event's `skills` list includes Claude Code's bundled skills. "Most bundled skills are available in every session", and a few depend on feature flags. The plan never says what "the arm's skills" are, or whether bundled skills count. The fake `claude` in `sessions.test.mjs` hides this until the first paid run.
- **What breaks if we ship it as-is:** At 2.3, read strictly, every repetition of every arm carries "extra" skills. The repetitions are not measured, the kill test is not measured, and by GATE.md the build stops. Read loosely, the agent defines "expected" after seeing paid data, and the leak check that H7 added stops checking anything. This is where I get stuck.
- **Suggested fix:** Write `{"disableBundledSkills": true}` into each fresh `CLAUDE_CONFIG_DIR`, or define the expected list as the builtin arm's init `skills` plus the arm's plugin skills. Freeze the choice in GATE.md before the first run.
- **Evidence:** skills.md: "Claude Code includes a set of bundled skills, such as `/doctor`, `/code-review`, `/batch`, `/debug`, `/loop`, and `/claude-api` … Most bundled skills are available in every session … To turn bundled skills off, use the `disableBundledSkills` setting." agent-sdk/typescript.md:2098, init message `skills: string[];`.

### R4-EX-08  —  major
- **Artifact:** D3
- **Location:** Step 0.6, Lantern: "295 distractors … summary `Note NNN: keep the <a> <b> as it is`, `<a>` cycling `retry provider payments support legal owner`, `<b>` cycling `cache timeout format limit header`"
- **What is wrong:** This is the H6 fix for R3-PA-02, and it is incomplete. File names are now opaque, but the content still gives the answer away. The token that identifies both recall questions, `v2`, is in the two planted memories (`Keep the v2 retry header…`, `Provider ends v2 support…`) and in none of the 295 distractors. `grep -rl v2 _memories` returns exactly those two files. In BM25, `v2` is in 2 of 300 lines, under `RARE_FRACTION`, so recall surfaces both on one term.
- **What breaks if we ship it as-is:** `recall-distractors` and `recall-past-decision` sit at the ceiling for every arm, files included. The prompt-hook rule needs `recall-distractors` "ahead by 0.2", which is unreachable, so the prompt hook is "not kept" because of how the fixture was built. The session-start hook loses one of its three ahead cases the same way. The gate is decided by the fixture, which is the problem H6 was meant to fix.
- **Suggested fix:** Make the distractors near misses on the key tokens. For example, `<a>` includes `v2`/`v3`, and a dozen distractors read like `Provider ends v1 support on 2026-03-01` or `Keep the v2 cache format`. Add an `evals-shape.test.mjs` assertion: each recall prompt's rarest content word occurs in at least 5 memory files.
- **Evidence:** v4-d3.md:619–623, contract G (line 428: "one matching term occurs in no more than `RARE_FRACTION` of lines").

### R4-EX-09  —  major
- **Artifact:** D3
- **Location:** Step 7.1 case table, "`untrusted-project-inert` | … Eval mode on, `--not-enabled` | `regex`: `not enabled`"; GATE.md `honesty_cases` lists it
- **What is wrong:** The one security case for rule 7 ("no hook passes anything … from a project that is not enabled") checks only that the words "not enabled" appear. With no `target`, a `regex` grader reads `last_message`. That needs the model to repeat the notice, and no skill tells it to. The check also never asks whether the hook withheld anything. A hook that prints the notice and then the full status block, the `PROJECT.md` text, and recall pointers passes, if the model mentions the notice.
- **What breaks if we ship it as-is:** A regression that leaks project text in un-enabled folders passes a gate case named "inert". The case can also fail on a correct build when the model just answers the question, and one judge-free miss fails the release by GATE.md's pass rule. Rule 7 is met on paper.
- **Suggested fix:** Grade on `trace` with `match: not_contains` for `--- PROJECT.md ---`, `CORE recall:`, and `session hook ran`, plus a `regex` on `trace` for the notice. Drop the `last_message` check.
- **Evidence:** plugin-evals.md:565, `last_message`: "This is the default". v4-d3.md:1304, :611; rule 7, line 82.

### R4-EX-10  —  minor
- **Artifact:** D3
- **Location:** Step 2.1 Do 2, full arm: "`core.mjs enable add --temp --project <folder>` (removed at the end)"; step 8.2, "`node <repo>/plugins/core/scripts/core.mjs enable add --temp --project <temp>`"
- **What is wrong:** Neither call sets eval mode. So `coreDir` is `os.userInfo().homedir/.core`, the maintainer's real home. The record test's full arm, 6 to 9 repetitions of 15 sessions, writes `projects.json`, creates the real `install-id`, and may write `noticed.json`. No `real-home-guard` wraps it. This is what decision 16 and the Alternatives entry "Enabling eval runs through the real enabled list. It writes the maintainer's home from a test" say must not happen.
- **What breaks if we ship it as-is:** Every `sessions.mjs` run edits the maintainer's real enabled list. A run killed at the cost cap leaves `temp` entries until the next `enable` write. On a clean CI-like machine, the first run creates a real `install-id` from a test.
- **Suggested fix:** Run the full arm with `EVAL_CORE_ENABLE=1`. Its `CLAUDE_CONFIG_DIR`, and so the plugin data folder, and the project are already under `os.tmpdir()`. Wrap `sessions.mjs` in `real-home-guard.mjs snapshot`/`check`.
- **Evidence:** v4-d3.md decision 15–16 (lines 120–121), Alternatives line 1469, :891, :1356.

### R4-EX-11  —  minor
- **Artifact:** D3
- **Location:** Step 3.2, "For each non-hook command with `expects: true` … Assert: healthy → exit 0"; step 8.1 `env` (no command-status rule)
- **What is wrong:** `env` has `expects: true`, so the honesty test needs it to exit 0 on a healthy temp project. On a CI runner, `native_eval` (`claude --version`) fails, and with no session id the session rows are `unknown`. 4.4 says how `check --project` rolls its checks up into a status: any fail → `fail`, else any unknown → `unknown`. 8.1 gives `env` no such rule. If the agent copies 4.4's rule, `env` exits 1 or 3 on every healthy CI run. If it always returns `ok`, the honesty row's "input deleted → 1 or 3" has nothing to bite on.
- **What breaks if we ship it as-is:** The agent has to invent `env`'s status rule. One choice turns CI red with no permitted fix ("fix the command, never the test"). The other makes `env` a command that is always `ok`, which the honesty test exists to forbid.
- **Suggested fix:** State it in 8.1. `env` is `ok` when it read the enabled list and the receipts folder; capability outcomes go in `data` only. Its needed input for 3.2 is `_core/`.
- **Evidence:** v4-d3.md:938, :979 (4.4's roll-up rule), :1334–1351.

### R4-EX-12  —  minor
- **Artifact:** D3
- **Location:** Step 5.2 Accept, "It asserts: … no query ever returns a `forbidden` id … Held-out results are reported, not asserted"
- **What is wrong:** "No query ever" covers the 20 held-out queries, so held-out results are asserted after all. If a held-out query returns a forbidden id, the agent can only pass by tuning on the held-out set, which step 4 forbids, or by special-casing, which the If-it-fails forbids.
- **What breaks if we ship it as-is:** Either the held-out set becomes a tuning set and its precision figure stops being "the honest measure", or 5.2 lands in `BLOCKED-WITH-FALLBACK` on a scorer that works. The build log cannot tell which happened.
- **Suggested fix:** "No tuning query returns a `forbidden` id; forbidden hits on the held-out set are counted and reported."
- **Evidence:** v4-d3.md:1054–1056.

### R4-EX-13  —  minor
- **Artifact:** D3
- **Location:** Step 8.2 Accept, "the agent's own `env` ran and named `CLAUDE_CODE_SESSION_ID` as its source"
- **What is wrong:** Whether `env` names `CLAUDE_CODE_SESSION_ID` or `--sid` depends on whether the agent passed `--sid`. The plan pushes it toward passing it. Contract K: "The agent passes both from the status block". `finalize`: "the id comes from the status block's `sid=`". The status block prints `sid=`.
- **What breaks if we ship it as-is:** On a working build, an agent that copies `sid=` from the status block makes 8.2 fail. The agent then goes looking in the general procedure for a defect that does not exist, or edits skill prose to stop it passing ids.
- **Suggested fix:** Accept either source, as long as the id equals the one in the `claude -p` JSON. Or tell the agent in the prompt not to pass `--sid`.
- **Evidence:** v4-d3.md:377, :498, :793, :1357.

### R4-EX-14  —  minor
- **Artifact:** D3
- **Location:** Step 1.2, "`reference/ladder.md` (filled in 8.5)"; `core` §2, "No status block → read `reference/ladder.md`"; 8.5 Accept, "Behaviour: eval case `honesty-no-hooks` passes"
- **What is wrong:** `ladder.md` is empty when it is measured: in the kill test (2.3), where every Layer 1 session has no status block and is sent to it, and in 7.1, where `honesty-no-hooks` is run. It is written only in 8.5, after both. 8.5's Accept names an eval case but no run, cap, or results file. So it can only be met by reusing 7.1's result, which measured the empty file.
- **What breaks if we ship it as-is:** The shipped Layer 1 is not the one that passed the kill test. The honesty gate in 9.4 reads results for prose that no longer ships. The release record says `honesty-no-hooks` passed on text it never saw.
- **Suggested fix:** Write `ladder.md` in 1.2 from D2 §5, the rung table that 8.5 transcribes, and keep 8.5 for wording after the live checks. Or add a capped rerun of `honesty-no-hooks` after 8.5, with its own `--json`.
- **Evidence:** v4-d3.md:674, :687, :1384.

---

Sound: 9.5's rebase cleanup matches what `origin/next` adds (seven test files under `tests/scripts/`, two under `tests/helpers/`, checked through the GitHub compare API). 0.3's `verify-release-identity.mjs` import fix is enough: the script imports nothing else that 0.3 deletes.

critical 0 · major 9 · minor 5 · taste 0
