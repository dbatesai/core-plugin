# Round 2 — Executor review of D3 (v2)

Role: a zero-context agent told to run D3 v2 from step 0.1 to 9.5 without asking anyone. I walked each step against the real repository (`HEAD` = `11cd436`, `origin/main` = `79b526b`, `origin/next` = `d23c9f9` on the remote), Node v22.23.4, Claude Code 2.1.321. Only read-only commands were run. No repository file was changed. Round-1 findings and the D4 ledger were read first; where an accepted round-1 fix is wrong or incomplete, the finding says so and cites the earlier ID.

**What reproduces.** Step 0.1's tag check now works: `git ls-remote` shows `v3.20.1^{}` at `79b526b` and `refs/heads/next` exists. Step 0.2's five numbers reproduce exactly (100 files, 34,313 lines, 606,815 bytes, 126,923 bytes, 34 switches), and `claude plugin details` prints "Always-on: ~1,437 tok". Every path step 0.3 removes exists, and the two moved files import only Node built-ins.

**First step where I get stuck: 0.5.** Pushing `v4` starts no CI run, and the Node 20 cells cannot run the quoted test glob (R2-EX-07, R2-EX-06). Before that, step 0.1 has already removed D3, D2 and the grounding file from the working tree (R2-EX-03).

---

### R2-EX-01  —  critical
- **Artifact:** D3
- **Location:** Step 7.6, "Every case's `case.yaml`" (the template has `schema_version`, `name`, `runs`, `context.scaffold_script`, `execution.env` only); step 0.6 uses the same cases.
- **What is wrong:** The template has no `allowed_tools`. The runner's default is `[]`. It grants only the read-only tools a case lists, plus the `--allow-tools` grant. So every run gets Write, Edit and `Bash(node *)`, but no `Read`, `Glob`, `Grep`, `Skill` or `Agent`.
  - The convention arm is told to "read PROJECT.md … look in `_memories/`" and has no tool to read anything.
  - No skill can fire through the `Skill` tool, so the `tool_used: Skill` indicators always fail.
  - 5.3 (catch-up), 6.2 (refresh helper) and the blind check all need `Agent`.
  - The template also has no `max_turns`. The default is 10, and hitting it "is recorded as a run error". `finalize` alone needs remember, edit `PROJECT.md`, write a summary, `verify` and `close`.
- **What breaks if we ship it as-is:** The four-arm numbers measure tool starvation, not CORE. Convention and files both score near zero, so plugin − convention looks large, and the "Keep Layer 2" gate and the 0.6 stop rule are decided by a missing YAML key. That is a measurement reporting a result it did not take.
- **Suggested fix:** Add `allowed_tools: [Read, Glob, Grep, Skill, Agent]` under `execution:` in the template, and `max_turns: 30`. Add a 0.6 check that the without-arm trace contains at least one `Read` call.
- **Evidence:** plugin-evals.md §Grant tools: "A run allows only the read-only tools the case lists in `allowed_tools` … plus whatever you grant with `--allow-tools`"; §prompt.md frontmatter: "`allowed_tools` | `[]`"; "`max_turns` | `10` | … Hitting it is recorded as a run error".

### R2-EX-02  —  critical
- **Artifact:** D3
- **Location:** Step 0.6, "If it fails: `claude` missing, below 2.1.269, or not signed in → `BLOCKED-WITH-FALLBACK`"; the 0.6 "Decide" rule; step 7.6 "If it fails"; step 9.4.
- **What is wrong:** No step reads the runner's per-run `error` field, so a run that never happened scores 0 and is read as a result.
  - Every eval command grants Bash (`"Bash(node *)"` in 0.6 and 7.6, `Bash` in the v3 run). With a Bash grant, Linux needs `bubblewrap` and `socat`, and native Windows needs WSL2. Without them the runner "refuses each run … the case shows a run error and usually scores 0".
  - This machine has neither: `which bwrap socat` prints nothing.
  - 0.6's failure path names only a missing, old or signed-out `claude`. Here `claude` 2.1.321 is present and signed in, so the step runs. Every run errors, every convention score reads 0, and "Decide" says continue: "the gap to 1.0 is the room the wiring must earn".
  - R1-EX-12 asked for the sandbox prerequisite to be stated, and R1-EX-11 and R1-EX-16 asked for the `error` field to be checked. All three were accepted. Neither fix is in v2.
- **What breaks if we ship it as-is:** The native-first check (hard requirement 2) answers "build it" because nothing could be measured. In 9.4 the same blindness lets a v3 run that errored count as "v4 not below v3". This is the defect class: "could not measure" read as a number.
- **Suggested fix:** Before any paid run, check `bwrap`/`socat` (Linux) or WSL2 (Windows), or record `BLOCKED-WITH-FALLBACK`. After every run, count `cases[].arms.*[].error != null` and report any case with an error as "not measured", never as 0.
- **Evidence:** plugin-evals.md §Grant tools (quoted above); `which bwrap socat` → empty here; D3:534–537, 1033–1036, 1142.

### R2-EX-03  —  critical
- **Artifact:** D3
- **Location:** Step 0.1, "`git checkout -b v4 origin/main`"; "How to use this document: … read its [D2's] section 5 before phase 8"; "Tags like `[G 3.1]` point to sections of `gauntlet/grounding.md`"; 8.5 "D2 §5's rung table"; 9.1 "`ARCHITECTURE.md`: D2, shortened"; 9.4 "the 29-item keep list in `gauntlet/source-evaluation.md` §8".
- **What is wrong:** `gauntlet/` is tracked only on the current branch. `git ls-tree origin/main gauntlet` prints nothing. Step 0.1's checkout therefore deletes D3 itself, D2, `grounding.md` and `source-evaluation.md` from the working tree. D3 never names the branch they live on, never says to copy them, and the target layout has no place for them.
- **What breaks if we ship it as-is:** A build spans many sessions. Any agent that resumes after 0.1, or re-reads a step, finds no plan. Phase 8, 8.5, 9.1 and 9.4 need files that are gone, and every `[G …]` citation points at nothing. A zero-context agent cannot recover without being told the old branch name, which fails the D3 acceptance test ("without asking anything").
- **Suggested fix:** In 0.1, before the checkout, copy `gauntlet/` to `../core-v4-plan/` and record the source branch and commit in `docs/build-log.md`. Point every later reference at that copy.
- **Evidence:** `git ls-tree origin/main gauntlet` → empty; `git diff --name-only origin/main HEAD` → 37 files, all under `gauntlet/`.

### R2-EX-04  —  major
- **Artifact:** D3
- **Location:** Step 0.3 Accept: "`test ! -e plugins/core/skills && … && node scripts/release/verify-release-identity.mjs --help; test $? -le 2` exits 0."
- **What is wrong:** The `;` ends the `&&` chain. Any failing `test` leaves `$?` at 1, and `test 1 -le 2` exits 0. A broken import makes `node` exit 1, which also passes. The check cannot fail.
- **What breaks if we ship it as-is:** Step 0.3 is "done" whether or not the old tree was removed, the files were moved, or the release script still imports. A failure surfaces later as an unrelated error.
- **Suggested fix:** `test ! -e plugins/core/skills && test -f … && test -f tests/prose-evals/prose-eval.mjs && { node scripts/release/verify-release-identity.mjs --help; test $? -eq 2; }`. Usage exits exactly 2.
- **Evidence:** Run on the untouched tree, where `plugins/core/skills` exists and `plugins/core/scripts/lib` does not: `exit=0`.

### R2-EX-05  —  major
- **Artifact:** D3
- **Location:** Step 0.5, "`node --test "tests/**/*.test.mjs"` (quote the glob; Node 21+ treats a folder argument as a file)" with matrix `node: [20, 24]`; decision 3 "Node.js 20 or newer".
- **What is wrong:** This is the fix for R1-EX-02, and it breaks Node 20. The test runner's glob support starts in Node 21. Node 20 takes each argument as a path, so the quoted string names a file that does not exist.
- **What breaks if we ship it as-is:** The three Node 20 cells fail on every push, so step 7.3 ("green on all six cells") and the 9.4 "Tests" gate can never be met. The agent cannot tell this failure from a real one.
- **Suggested fix:** Run `node --test` with no argument from the repo root (Node 20 and 24 both find `*.test.mjs`), or drop Node 20 from the matrix and from decision 3.
- **Evidence:** nodejs.org/docs/latest-v20.x/api/test.md §Running tests from the command line: "one or more paths can be provided … `node --test test1.js test2.mjs custom_test_dir/`". The page has no glob wording.

### R2-EX-06  —  major
- **Artifact:** D3
- **Location:** Step 0.5, "Keep the existing steps 'Validate plugin manifests are well-formed JSON', … and 'Codex marketplace path integrity'"; Accept "all six cells finish on a push".
- **What is wrong:** R1-EX-06 was accepted, but v2 fixes only one of its four parts, `continue-on-error` for `selftest` and `check --plugin`.
  - `ci.yml` still triggers on push to `main` and `next` only, so pushing `v4` runs nothing.
  - The kept "Validate plugin manifests" step parses `plugins/core/hooks/hooks.json`, which 0.3 deletes and 3.5 recreates.
  - "Codex marketplace path integrity" fails while `plugins/core/skills` is missing, from 0.3 to 4.3.
  - "Finish" is still not "pass".
- **What breaks if we ship it as-is:** The Accept cannot be observed, so the agent is stuck at 0.5 even with push rights. Once a PR opens, CI is red through phase 4 on steps the plan kept, and real regressions in that window are invisible.
- **Suggested fix:** Add `v4` to `on.push.branches`. Mark the two kept steps `continue-on-error` until 3.5 and 4.3 and log both. Make the Accept "every step passes except the ones flagged in `docs/build-log.md`".
- **Evidence:** `.github/workflows/ci.yml:3-6` (`branches: [main, next]`), `:37-47` (parses `plugins/core/hooks/hooks.json`), `:128-160` (`skills dir missing`).

### R2-EX-07  —  major
- **Artifact:** D3
- **Location:** Step 9.5, "`git rebase origin/next`; on a conflict in a file v4 deleted or rewrote, keep v4's side; then run the tests again."
- **What is wrong:** `next` is 45 commits ahead of `main`. It **adds** nine files that v4's `git rm -r tests/scripts tests/helpers` cannot have removed, because they did not exist when that commit was made. They are seven `tests/scripts/*.test.mjs` files and `tests/helpers/isolation-guard.mjs` and `links.mjs`. These replay without a conflict, and they import deleted v3 modules (`index-registry.mjs`, `project-state.mjs`, `trusted-home.mjs`). `next` also edits `CHANGELOG.md`, `USAGE.md` and `ARCHITECTURE.md`; "keep v4's side" silently drops those notes.
- **What breaks if we ship it as-is:** After the rebase, `node --test` fails on test files the agent never wrote. No conflict happened, so the step's rule does not apply, and the general procedure says "fix the code, not the test", which points at v3 modules that no longer exist. 9.5's Accept, "CI is green", is unreachable.
- **Suggested fix:** After the rebase, run `git diff --name-status --diff-filter=A <v4-before-rebase> HEAD -- tests/` and delete any v3 test it lists. For the three docs, merge `next`'s notes into the 4.0.0 entry instead of discarding them.
- **Evidence:** `gh api repos/dbatesai/core-plugin/compare/main...next` → `ahead: 45`; files with status "added" listed; `tests/scripts/repeated-move.test.mjs@next:6-8` imports `index-registry.mjs`, `migrate-workspace-state.mjs`, `project-state.mjs`.

### R2-EX-08  —  major
- **Artifact:** D3
- **Location:** Step 2.5 `secrets`, "`sk-[A-Za-z0-9_-]{20,}`"; contract C prefix "`risk`"; Lantern fixture `risk-20261015-provider-deadline`.
- **What is wrong:** The pattern has no left boundary. Every risk memory id of the form `risk-YYYYMMDD-<slug>` with a slug of 11 or more characters contains `sk-` followed by 20 or more allowed characters. It matches in the `id:` line, in every edge that targets it, and in `PROJECT.md` lines that name it. Ids such as `task-…`, `disk-…` and `ask-…` match too.
- **What breaks if we ship it as-is:** `check --project` reports `secrets: fail` on the Lantern fixture and on every real project with an ordinary risk memory. The `metrics` skill then tells the user CORE is "broken". The selftest never plants a risk memory, so it does not catch this.
- **Suggested fix:** Use `(?<![A-Za-z0-9])sk-(?:live_|proj-|ant-)?[A-Za-z0-9_-]{20,}` or similar. Add a risk-id fixture to 2.5's Accept that must not fail `secrets`.
- **Evidence:** `node -e` with the D3 regex: `"id: risk-20261015-provider-deadline"` → `true`, match `sk-20261015-provider-deadline`; `"task-20261101-migrate-the-queue"` → `true`.

### R2-EX-09  —  major
- **Artifact:** D3
- **Location:** Step 5.2 Accept: "`node tests/tools/prose-check.mjs --fixture tests/prose-evals/fixtures/finalize-summary-scenario.json --cap 150 --sections "Resume here,Done,Open" --file <the summary from a finalize-handoff run kept with --keep-temp>` prints `pass`"; label `[agent]`.
- **What is wrong:** Three problems.
  - The kept fixture plants the obligation `OQ-12`. The `finalize-handoff` prompt ("We fixed two of three bugs; the flaky auth test still fails") and the Lantern fixture never mention OQ-12, so a correct summary always fails `lost-obligation`.
  - The input is a paid eval run from step 7.6.
  - The tool is built in step 7.5. So an `[agent]` step's Accept needs a `[paid]` run and a later step.
- **What breaks if we ship it as-is:** 5.2 can never be marked done. On a machine without credentials there is no fallback. With credentials, the check fails on a correct summary, and "fix the code, never the test" sends the agent to make `finalize` write "OQ-12".
- **Suggested fix:** Ship a v4 fixture whose planted obligations match the `finalize-handoff` prompt. Move this check to 7.6, and give 5.2 an offline Accept: `close.test.mjs` plus `check --plugin` shape checks.
- **Evidence:** `tests/prose-evals/fixtures/finalize-summary-scenario.json` `planted_obligations: ["flaky auth test","OQ-12"]`. `checkProseOutput` on a v4-shaped summary with `word_cap: 150` and the three sections → `{"verdict":"fail","failures":[{"check":"lost-obligation","detail":"OQ-12"}]}`.

### R2-EX-10  —  major
- **Artifact:** D3
- **Location:** Step 7.1 `commands`, "a contract K command other than `hook` and `watch` is named in no `SKILL.md`"; `orphans`, "linked from no `SKILL.md`"; Accept "the real tree passes"; 4.3 Files "`reference/voice.md`".
- **What is wrong:** R1-EX-24 was accepted, but v2 makes the check stricter. v1 counted "any shipped `.md` or hook file"; v2 counts only `SKILL.md`.
  - The skill texts D3 specifies name no `recall`, `env`, `migrate` or `sample`. `sample` lives in `metrics/reference/blind-check.md`, `migrate` in the repo-root `INSTALL.md`, and `env` in `ladder.md` at most.
  - `skills/pulse/reference/refresh.md` is linked from `sources.md` and the agent file, not from a `SKILL.md`, so `orphans` flags it.
  - `reference/voice.md` is listed as a file to create, but no step says what it contains or links it.
- **What breaks if we ship it as-is:** `check --plugin` fails on the tree D3 describes. 7.3's CI gate goes red. "Fix the plugin, not the check" pushes the agent to pad skills with command names, against 4.3's "Sections, in order".
- **Suggested fix:** Count any shipped `.md` reachable from a `SKILL.md` for both checks. Either specify `voice.md` in one line and link it from `core/SKILL.md`, or drop it.
- **Evidence:** D3:896, 782, 875, 742; skill section lists in 4.3–5.2 and 7.4.

### R2-EX-11  —  major
- **Artifact:** D3
- **Location:** Step 7.2 Accept: "The test monkey-patches `listActive` to return an empty list and asserts `selftest` now exits non-zero".
- **What is wrong:** `lib/store.mjs` is an ES module, and its exports are read-only bindings, so a test cannot reassign `listActive`. Node 20 has no module mocking; `--experimental-test-module-mocks` arrives in Node 22. If `selftest` runs its instruments as child processes, a patch in the test process has no effect at all. The quick workaround, an environment variable that blinds the store, would be a third switch, which 7.1's `switches` check rejects.
- **What breaks if we ship it as-is:** The one test that proves the self-test can see itself go blind cannot be written as specified. The agent has to invent a dependency-injection seam, or quietly drop the assertion.
- **Suggested fix:** Make `selftest(deps = {listActive, …})` take its readers as arguments, and have the test call it in-process with a stub. Say so in 7.2.
- **Evidence:** Scratch ESM test: `store.listActive = () => []` → `TypeError: Cannot assign to read only property 'listActive' of object '[object Module]'`; `node --help` lists `--experimental-test-module-mocks` (Node 22).

### R2-EX-12  —  major
- **Artifact:** D3
- **Location:** Step 7.2, "build a throwaway project under `os.tmpdir()` … Enabled project; stdin with a matching prompt → `hook prompt`"; step 0.5 runs `node plugins/core/scripts/core.mjs selftest` between the two `real-home-guard.mjs` steps.
- **What is wrong:** R1-EX-17's third gap was accepted but not fixed. 7.2 never says how `selftest` enables its project or which core folder it uses. Without `--core-dir` the default is the real `~/.core` from the account record.
  - Enabling would write `projects.json` there.
  - Every receipt calls `machineId`, which creates `~/.core/install-id` "if missing" (contract B).
  - `EVAL_CORE_ENABLE` does not help, because CI sets no `CLAUDE_PLUGIN_DATA`.
- **What breaks if we ship it as-is:** On a fresh CI runner, `real-home-guard.mjs check` fails with "~/.core now exists" right after `selftest`, so 7.3 cannot go green. On a maintainer's machine, `selftest` adds entries to the real enabled list each run.
- **Suggested fix:** State that `selftest` creates its own temp core folder, enables the throwaway project there, and passes `--core-dir` to every instrument it runs.
- **Evidence:** `scripts/release/real-home-guard.mjs:22-40, 55-63` (snapshots `userInfo().homedir/.core`; reports "~/.core now exists"); D3:255, 397, 512.

### R2-EX-13  —  major
- **Artifact:** D3
- **Location:** Step 7.6, "…plus `plugins: ["..", "../_tracker-plugin"]` for the update cases."
- **What is wrong:** `plugins` paths are relative to the case directory. From `plugins/core/evals/<case>/`, `..` is `plugins/core/evals`, not the plugin. The runner's own example for this layout is `["../.."]`. Setting `plugins` also replaces auto-detection.
- **What breaks if we ship it as-is:** In the four update cases, CORE does not load, or the case errors with "no plugin resolved". `update-refresh-uses-mock` and `pulse-refresh-stale` then measure Claude without CORE. `update-ignores-injected-tool-text` passes because nothing ran, and it is a security case with a 1.0 gate.
- **Suggested fix:** `plugins: ["../..", "../_tracker-plugin"]`.
- **Evidence:** plugin-evals.md §prompt.md frontmatter: "`plugins` | … relative to the case directory. Set `plugins: ["../.."]` when auto-detection doesn't find your plugin".

### R2-EX-14  —  major
- **Artifact:** D3
- **Location:** Step 7.6 Files, "`evals/_tracker-plugin/evals/mocks/tracker/list_issues.md`"; Target layout, "`evals/mocks/…`".
- **What is wrong:** D3 gives two mock locations. The runner reads suite mocks from the eval directory under test, `plugins/core/evals/mocks/<server>/`, or from a case's own `mocks/`. A mock inside the helper plugin's own `evals/` is not on either path. When no mock file is found, the server "appears … as `[not started: no mock]`" and its tools are absent.
- **What breaks if we ship it as-is:** If the agent follows the Files line, no `list_issues` tool exists. The refresh cases fail. The injection case passes because no tool output ever arrived. 6.2's Accept is then met or failed for the wrong reason.
- **Suggested fix:** Put the mock at `plugins/core/evals/mocks/tracker/list_issues.md` (the layout's location). Add a `regex` grader on `mock_calls` to `update-ignores-injected-tool-text`, so it fails when the tool never ran.
- **Evidence:** plugin-evals.md §Mock MCP servers: "Put one Markdown file per tool under `evals/mocks/<server>/<tool>.md` for the whole suite, or under a case's own `mocks/` directory"; D3:183, 981.

### R2-EX-15  —  major
- **Artifact:** D3
- **Location:** Contract H, "`<machine>`: first 8 characters of `~/.core/install-id`; `nohome` if it cannot be read or created"; 7.6 `catch-up-unclosed`, "Fixture adds `_core/receipts-nohome-claude-code.jsonl`"; Alternatives, "`EVAL_CORE_ENABLE` … does not [write the maintainer's home folder]".
- **What is wrong:** In an eval run, the plugin's hooks run outside the sandbox as the real user. Bash commands run inside it, with the home folder unreadable.
  - The session-start hook reads, or creates, the maintainer's real `~/.core/install-id` and computes the queue from that machine's receipts. It never sees the planted `receipts-nohome-…` file, so no `no-handoff` item appears.
  - The skill's `metrics` and `close` run sandboxed, resolve to `nohome`, and write their receipts to a different file from the hooks.
  - Each eval run also writes `install-id` into the real home, contrary to the Alternatives line.
- **What breaks if we ship it as-is:** `catch-up-unclosed` cannot exercise the catch-up path, and its grader passes on any summary (see R2-EX-17). In the same eval runs, hooks write their receipts under one machine id and `close` writes under another, so "this machine's receipts" means two different files in one session.
- **Suggested fix:** Have the session-start block print the core folder and machine id. Have agent-run commands take them from the block, as R1-HA-13 suggested for Codex. Plant the fixture's receipts under a machine id read from that line, or match catch-up by `sid` alone.
- **Evidence:** research-claude-code.md:270, "Claude Code runs hooks, monitors, MCP servers … [outside the sandbox]" (plugins/security.md); plugin-evals.md §Grant tools, "your home directory and Claude Code configuration are unreadable"; D3:255, 397, 1025, 1165.

### R2-EX-16  —  major
- **Artifact:** D3
- **Location:** Contract F status block, "At most 3 'now' items"; contract E, "`no-handoff` … | `soon`"; step 5.3, "When the queue lists a `no-handoff` item"; 4.3 section 2.
- **What is wrong:** The hook names only `now` items. A `no-handoff` item is `soon`, so it shows up only as a number in "queue: 2 now, 3 soon". The `core` skill's start-of-session section reads the block and never runs `queue`. So nothing tells the agent that a session went unclosed, and 5.3's trigger never fires unless the user asks.
- **What breaks if we ship it as-is:** The catch-up path, D2's answer to having no `SessionEnd` hook, is dead in normal use. The agent has to guess whether to add a `queue` call to section 2 or to raise `no-handoff` to `now`.
- **Suggested fix:** List `no-handoff` in the block under its own line ("Last session not closed: <sid>"), or tell section 2 to run `queue` when the soon count is non-zero.
- **Evidence:** D3:309, 345–354, 754, 842.

### R2-EX-17  —  major
- **Artifact:** D3
- **Location:** Step 7.6 graders: `remember-no-resurrection` "`regex not_contains` on `files`: `redis`"; `setup-consent` (only "`tool_used` `Write` and `Edit` … `max: 0`"); `catch-up-unclosed` "`regex` on `files`: `_summaries/summary-`".
- **What is wrong:** R1-EX-15 was accepted, but v2 fixed only two of its five graders.
  - `files` is still a list of created paths, not file contents. A memory named `dc-…-queue.md` that records Redis streams passes.
  - `setup-consent` still passes when the agent never offers the block at all.
  - `catch-up-unclosed` still passes on 5.3's fallback summary ("transcript is not available"), which is written when nothing was caught up.
- **What breaks if we ship it as-is:** `setup-consent` is a Security case, so the 9.4 gate "Honesty and security cases 1.0 each" can be met by doing nothing. The anti-resurrection and catch-up cases go green while the behavior is wrong.
- **Suggested fix:** Grade resurrection with `tool_used: Write` and `input_match: '(?i)redis'`, `max: 0`. Add an `llm` "PASS if it showed the block text and asked" grader to `setup-consent`. Grade catch-up on a fact planted only in `transcript.jsonl`.
- **Evidence:** plugin-evals.md §What a grader can look at: "`files` | The list of paths Claude created … Not their contents"; D3:1020, 1025, 1028.

### R2-EX-18  —  major
- **Artifact:** D3
- **Location:** Step 7.6, `finalize-counts-from-disk`, "run with `--allow-tools "Bash(node *)"` only"; Run, "`claude plugin eval plugins/core … --allow-tools Write Edit "Bash(node *)" … --json docs/results-v4.json`".
- **What is wrong:** `--allow-tools` "applies to every case in the run", and no `case.yaml` field takes a grant away. The one Run command grants Write and Edit to this case too. So the case's premise (the agent cannot write, so it must say "not measured") does not hold. A second run with a smaller grant is not specified. Its results file is not named, and `cells.mjs` and the 9.4 gates read only `docs/results-v4.json`.
- **What breaks if we ship it as-is:** Run as written, the agent can write, does write, and fails `regex: not measured|could not write`, so the honesty gate fails on a correct plugin. Run separately, the result never reaches the gate. Either way, the agent guesses.
- **Suggested fix:** Add a second Run line, `--case finalize-counts-from-disk --allow-tools "Bash(node *)" --json docs/results-v4-nowrite.json`, and name that file in the 9.4 honesty gate.
- **Evidence:** plugin-evals.md §Grant tools: "That grant applies to every case in the run"; D3:1024, 1033.

### R2-EX-19  —  major
- **Artifact:** D3
- **Location:** Step 7.6 "If it fails": "If the plugin data folder in a run is not under the temp folder, `EVAL_CORE_ENABLE` will not take effect … Detect this from `untrusted-project-inert` passing in a case that should be enabled".
- **What is wrong:** A grader belongs to one case. `untrusted-project-inert` runs with `EVAL_CORE_ENABLE` removed, so it passes in exactly the situation where enabling works too. Its result says nothing about other cases. The detection cannot be carried out as written.
- **What breaks if we ship it as-is:** The most load-bearing unverified assumption in the suite (D4 Part 1 item 4) has no working alarm. If enabling silently fails, every with-plugin run measures the "not enabled" notice path, and the gates compute plugin − convention from it. That is the defect class.
- **Suggested fix:** Give every enabled case an `arm: with-only` `regex` grader on `trace` for `CORE: hooks ok`. Treat any case where it fails as "not measured".
- **Evidence:** D3:1030, 1036; D3 decision 16; D4 Part 1 §4.

### R2-EX-20  —  major
- **Artifact:** D3
- **Location:** Step 7.6 `pulse-refresh-stale`, "`regex` on `{source: file, path: _sources/tracker.md}`: today's date"; `update-refresh-uses-mock`, "Mock answers `CORE-142: closed on <today>`".
- **What is wrong:** Grader files and mock files are static and committed. Mock substitution supports only `{{input.…}}` and `{{file:…}}`, and graders have no substitution at all. A literal date fails on every later day. The obvious workaround, a date-shaped regex, also matches the fixture's existing `fetched:` date from five days earlier.
- **What breaks if we ship it as-is:** The Update job's only proof of a refresh (6.2's Accept) either fails every day after it is written, or passes when nothing was refreshed. The agent has to pick one.
- **Suggested fix:** Have `build.sh` set `fetched:` to a fixed sentinel such as `2000-01-01T00:00:00Z`, and grade with `regex not_contains: 2000-01-01` plus `fetch_status: ok`. Drop `<today>` from the mock body.
- **Evidence:** plugin-evals.md §Mock files: "Its body is the tool result, with `{{input.<field>}}` and `{{file:fixtures/<name>}}` substitutions"; D3:531, 1013–1014.

### R2-EX-21  —  major
- **Artifact:** D3
- **Location:** Contract F project resolution ("`cwd`" / "first entry of `workspacePaths`"); contract K, "Every command takes `--project <dir>`"; 0.4, "`run` spawns `core.mjs` with `--project` and `--core-dir`"; 3.3 Accept, "corrupt stdin → exit 0, nothing said, a receipt with `status: unknown`".
- **What is wrong:** D3 never says which wins when a hook gets both `--project` and a stdin `cwd`. The helper always passes `--project`, so every hook test (3.3, 3.4, 1.1, perf) resolves the project from the flag. The stdin path that real harnesses use, including Antigravity's `workspacePaths`, is never tested. With corrupt stdin there is no project to hold the "unknown" receipt. On Antigravity the fallback `cwd` is the plugin folder, which D2 §9 says CORE never writes.
- **What breaks if we ship it as-is:** Every hook test passes while project resolution from stdin is unbuilt or wrong. The first real run, at 8.2–8.4, is where it shows. The corrupt-stdin Accept passes only because the test supplied the project.
- **Suggested fix:** Hooks ignore `--project` and resolve only from stdin. Add a `runHook(stdin)` helper with no `--project`. With unusable stdin, write no receipt and print nothing, and change 3.3's and 7.2's Accept to match.
- **Evidence:** D3:320–324, 455, 505, 651, 922; D2 §9 Write row "Never: The plugin folder".

### R2-EX-22  —  major
- **Artifact:** D3
- **Location:** Step 3.3, "compute the queue"; Accept, "enabled project with two `now` items → both named"; step 3.4, "a new `now` item → the 'new item' line once"; `lib/queue.mjs` is built in 4.1.
- **What is wrong:** R1-EX-10 was accepted with a fix for prose steps only. The code dependency remains: 3.3 and 3.4 need contract E's queue, `now` levels and `data.recent`, all of which step 4.1 builds.
- **What breaks if we ship it as-is:** The agent cannot pass 3.3 or 3.4 in order. It must build 4.1 early, without its test-first step, or stub the queue and later retest. Rule 9 ("test first") and the step order conflict, and the agent guesses which to break.
- **Suggested fix:** Move 4.1 to before 3.3, as 3.0, and leave the source rows to 6.1 as now.
- **Evidence:** D3:650–651, 657, 720–724.

### R2-EX-23  —  major
- **Artifact:** D3
- **Location:** Step 8.2 label `[paid]` ("in an **interactive** session … add a memory due yesterday from another terminal, wait 11 minutes, and confirm the agent raises it"); step 8.4 label `[live install]` ("Never drive `agy` from Claude Code or Codex").
- **What is wrong:** R1-EX-22 was accepted as "step labels", but two labels are still wrong.
  - 8.2's watcher check needs a person to run an interactive TUI session and watch it for 11 minutes. Monitors do not start under `-p`, so the agent cannot drive this itself.
  - 8.4 forbids the executing agent, which is Claude Code or Codex, from running `agy`, yet it carries no `[human]` label, unlike 8.3.
- **What breaks if we ship it as-is:** An agent with credentials and an `agy` install starts 8.4 and either breaks Google's terms or stalls. In 8.2 it marks the watcher "not verified" while thinking the step was its own to do. The final report misstates which checks need the maintainer.
- **Suggested fix:** Label 8.2's watcher half and all of 8.4 `[human]`, with the agent recording what the person reports.
- **Evidence:** D3:1077, 1087–1091; research-claude-code.md:179, "plugin monitors don't start in non-interactive mode with the `-p` flag".

### R2-EX-24  —  major
- **Artifact:** D3
- **Location:** Contract A rule 1, "unless it listed an existing, readable, empty folder, in which case it is `ok` with `data.empty: true`"; 7.4 Accept, "an empty `_core/` exits 3"; 7.4 `reading_nothing`, "any `ev` whose last 5 rows all have `read: 0`"; contract F `pre-compact` (fixed text).
- **What is wrong:** R1-EX-08 was accepted with "`expects` per command", but both of its examples survive in v2.
  - An empty `_core/` is an existing, readable, empty folder, so rule 1 says `ok` while 7.4 says exit 3.
  - `pre-compact` reads nothing by design, so every one of its rows has `read: 0`, and `reading_nothing` flags it forever.
- **What breaks if we ship it as-is:** The agent must pick between rule 1 and 7.4 with no tie-break. The instrument built to catch "instrumentation reading nothing" raises a permanent false alarm on day one, which teaches the user to ignore it.
- **Suggested fix:** Name `metrics` with no receipt files as an explicit exception to rule 1. Exclude events with `expects: false` (`pre-compact`, `announce`) from `reading_nothing`.
- **Evidence:** D3:227, 372–376, 952, 966.

### R2-EX-25  —  minor
- **Artifact:** D3
- **Location:** Step 0.3 item 2, "`git mv … cli-entry.mjs` … Both import only Node built-ins"; 7.1 `switches`.
- **What is wrong:** R1-EX-03 was accepted as "port, do not move", but v2 moves `cli-entry.mjs` unchanged. It still reads `process.env.CORE_DEBUG_CLI_ENTRY`, and it now ships under `plugins/core/scripts/lib/`.
- **What breaks if we ship it as-is:** `check --plugin` fails `switches` on a file D3 told the agent to keep as-is, and 7.3 goes red until the agent notices.
- **Suggested fix:** In 0.3, add "delete the `CORE_DEBUG_CLI_ENTRY` block from the moved copy", and check with `grep -c CORE_ plugins/core/scripts/lib/*.mjs` → 0.
- **Evidence:** `plugins/core/skills/core/scripts/cli-entry.mjs:32`.

### R2-EX-26  —  minor
- **Artifact:** D3
- **Location:** Step 3.2, "write `recall-gold.json`: 30 queries … Mark queries `q01`–`q20` as tuning and `q21`–`q30` as held out … Tune … on the tuning set only".
- **What is wrong:** This is the accepted fix for R1-EX-21, but the same agent writes the held-out queries and the thresholds, in the same step, knowing what must pass. Nothing stops it from writing easy literal queries. "Never special-case a query" does not stop choosing them.
- **What breaks if we ship it as-is:** The precision and recall written to `docs/build-log.md` look like an independent check and are not. The recall thresholds, which decide when CORE speaks, ship validated against the builder's own test.
- **Suggested fix:** Have the held-out ten written by a fresh helper agent that sees only the stores, before tuning, and commit them first. Or state in the build log that the held-out set is author-written.
- **Evidence:** D3:643–645.

### R2-EX-27  —  minor
- **Artifact:** D3
- **Location:** Contract H, "One JSON object per line in `<project>/_core/receipts-<machine>-<harness>.jsonl`"; `ev` includes `watch`, `announce`, `close`, `check`; 7.4 "`sessions` | distinct `sid`".
- **What is wrong:** Only hooks receive a session id and a harness. The watcher reads no stdin. `close` gets `--sid` but no `--harness`, and contract K gives `check` neither. So these rows have no `harness` to name their file and, except for `close`, no `sid`.
- **What breaks if we ship it as-is:** The agent guesses a file name (`-unknown.jsonl`?) and a placeholder `sid`. `metrics` then counts the placeholder as one extra "session", with no start row and no close row, which lowers `hook_coverage` and `handoff_coverage` and adds a permanent `unclosed` entry.
- **Suggested fix:** Give `watch`, `close` and `check` a `--harness` flag. Count `sessions` only from `session-start` and `prompt` rows.
- **Evidence:** D3:390–401, 444, 940–945.

### R2-EX-28  —  minor
- **Artifact:** D3
- **Location:** Step 1.1, "For each hook row, assert … a receipt row exists whose `status` is `ok` in the healthy case and not `ok` in the other two [needed input deleted; unreadable]".
- **What is wrong:** D3 never says what a hook's "needed input" is.
  - `pre-compact` prints fixed text and reads nothing, so it has no input whose loss should change its status.
  - For `session-start`, deleting both `PROJECT.md` and `_memories/` makes the folder "not a CORE project", and contract F then requires no receipt at all.
  - Making `_core/` unreadable leaves nowhere to write the receipt the test checks for.
- **What breaks if we ship it as-is:** The test cannot pass for `pre-compact` without inventing a failure, and "fix the command, never the test" pushes the agent to make `pre-compact` report `unknown` for no reason.
- **Suggested fix:** Name each hook's input in the 1.1 table (`session-start`: `PROJECT.md`; `prompt`: `INDEX.md`), and exempt `pre-compact` the way `expects: false` commands are exempt.
- **Evidence:** D3:338, 372–378, 548.

### R2-EX-29  —  minor
- **Artifact:** D3
- **Location:** 5.1 section 5, "move the old one to `archive/`"; 5.1 section 9 "Forget — move to `archive/`"; 7.6 `remember-supersede`, "`regex` on `trace`: `archive/dc-20261002-retry-header-v2`"; run grant `Write Edit "Bash(node *)"`.
- **What is wrong:** No granted tool moves or deletes a file. `mv` and `rm` are outside `Bash(node *)`, and no contract K command moves memories (decision 13: only `migrate`). The agent can only Write a copy into `archive/`, or think of `node -e "fs.renameSync(…)"`. The trace grader passes on a Write to the archive path even when the original stays active.
- **What breaks if we ship it as-is:** `remember-supersede` can pass while two copies of the fact stay live (the `two-live` fault), and `remember-no-resurrection` and `pulse` tidy are exercised in a state real users never see.
- **Suggested fix:** Grant `"Bash(mv *_memories/*)"`, or add an `archive <id>` command to contract K and the budget. Add a `regex not_contains` on the active path for `remember-supersede`.
- **Evidence:** D3:94, 814, 818, 999, 1019.

### R2-EX-30  —  minor
- **Artifact:** D3
- **Location:** Step 3.6 Accept, "The prose rule is tested by eval cases `setup-consent` and `honesty-no-hooks`"; 7.6 `honesty-no-hooks`, "with `EVAL_CORE_DISABLE: "1"` and the `--convention` fixture".
- **What is wrong:** The runner loads no project instruction files, and only the `-convention` twins append the block as a system prompt. `honesty-no-hooks` does neither, so the `AGENTS.md` dead-hook line never reaches the agent. The case can only pass through the `core` skill's own section 2. `setup-consent` checks only that `AGENTS.md` was not written.
- **What breaks if we ship it as-is:** 3.6 is accepted with no test touching the block's text. A typo in the one line D2 calls the last warning for a dead CORE ships unnoticed.
- **Suggested fix:** Set `append_system_prompt` to the block text in `honesty-no-hooks` and disable the skills for that case, so a pass proves the block works.
- **Evidence:** plugin-evals.md §How runs are isolated: "no … `CLAUDE.md` … loads"; D3:712, 998, 1027.

### R2-EX-31  —  minor
- **Artifact:** D3 vs D2
- **Location:** D3 9.4 "Keep Layer 2 | plugin − convention ≥ 0.3 … — **or** in step 7.7 the plugin's probe score beats the convention's by at least 1"; D2 §7, "Plugin minus convention … This is the gate: it must reach 0.3 … with no case worse by more than 0.1."
- **What is wrong:** D1 §8 and D3 have the "or 7.7" path, but D2 states the four-arm bar as the only gate. D2 also says "no case worse", while D3 says "no gated case below −0.1".
- **What breaks if we ship it as-is:** An agent told to read D2 §7 as the design reports Layer 2 as failed when D3 would keep it, or the reverse. Step 9.4 and the PR text then disagree with D2, which becomes `ARCHITECTURE.md` in 9.1.
- **Suggested fix:** Add the 7.7 alternative and "gated" to D2 §7's gate sentence.
- **Evidence:** v2-d2.md §7 "Does the wiring help?"; v2-d1.md §8; D3:1138.

---

Sound in one line: step 0.2's baseline reproduces exactly, and step 0.1's tag and `next` handling now matches the remote.

critical 3 · major 21 · minor 7 · taste 0
