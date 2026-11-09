# Round 1 — Executor review of D3 (v1)

Role: a zero-context agent told to run D3 from step 0.1 to 9.5 without asking anyone. I walked each step in order against the real repository (commit `d05b6dc`, `main` = `79b526b`), Node v22.23.4, Claude Code 2.1.321. Only read-only commands were run. No repository file was changed.

**First step where I get stuck: 0.1.** The remote tag `v3.20.1` already exists and points at a different commit than D3 expects (R1-EX-01). If I force past that, I am stuck again at 0.3's acceptance (R1-EX-02, R1-EX-03).

---

### R1-EX-01  —  critical
- **Artifact:** D3 (and the contract)
- **Location:** Step 0.1, "`git rev-parse v3.20.1^{commit}` starts with `140dc45`" and "If it is still unknown, stop: this is not the right repository."
- **What is wrong:** The origin repository already has an annotated tag `v3.20.1`. It peels to `79b526b`, the merge commit on `main`, not to `140dc45`. Step 0.1's own first command, `git fetch origin main --tags`, brings that tag in. Then the guard `git rev-parse -q --verify v3.20.1` prints something, no local tag is made, and the Accept check fails. The failure branch only covers "140dc45 is unknown". Here it is known, so no branch applies. The general procedure says to mark it `BLOCKED` and skip every dependent step, and every step depends on 0.1. The contract also names `79b526b` as the source under review, so D3 contradicts it.
- **What breaks if we ship it as-is:** A literal executor halts the whole build at the first step. Or it decides "this is not the right repository" and stops. The plugin trees at the two commits are the same (`git diff --stat 140dc45 HEAD -- plugins/core` prints nothing), so the check fails on a fact that does not matter.
- **Suggested fix:** Accept either commit, or check the tree instead: `git diff --quiet v3.20.1 140dc45 -- plugins/core`. Never create a tag that already exists on the remote.
- **Evidence:** `git ls-remote origin 'refs/tags/v3.20.1*'` → `fe525ad… refs/tags/v3.20.1` and `79b526b… refs/tags/v3.20.1^{}`. `contract.md:3` says "commit `79b526b`".

### R1-EX-02  —  major
- **Artifact:** D3
- **Location:** Step 0.3 Accept, "`node --test tests/release/` passes"; step 0.5, "`node --test tests/`"; matrix `node: [20, 24]`
- **What is wrong:** On Node 21 and later, a path given to `node --test` is treated as a file or glob, not as a folder to search. A folder argument is loaded as a module and fails with `MODULE_NOT_FOUND`.
- **What breaks if we ship it as-is:** Step 0.3's acceptance fails however good the work is. The three Node 24 CI cells fail on every push. That means 7.3 ("CI green on all six cells") can never be met, and the agent cannot tell this failure from a real one.
- **Suggested fix:** Use `node --test "tests/**/*.test.mjs"` (quoted, so Node expands the glob on every OS), or plain `node --test` from the repo root.
- **Evidence:** In a scratch folder on Node v22.23.4: `node --test tests/release/` → `# tests 1 # fail 1`, exit 1, "Cannot find module …/tests". `node --test 'tests/**/*.test.mjs'` → `# pass 1`, exit 0.

### R1-EX-03  —  major
- **Artifact:** D3
- **Location:** Step 0.3 items 1, 3, 4 and "If it fails: … restore that one file with `git checkout v3.20.1 -- <path>`"; decision 4; step 7.1 `one-switch`
- **What is wrong:** The kept files do not stand alone once the tree is removed.
  - `bm25.mjs` imports `./generate-summary-index.mjs`, which 0.3 deletes. That file imports `priority.mjs`, `enrichment-sidecar.mjs`, `text-truncate.mjs`, `unit-vocab.mjs`, and `store-ignores.mjs`.
  - `real-home-guard.test.mjs` imports `./trusted-test-tmp.mjs` from `tests/scripts/`, which 0.3 deletes. That file imports `project-state.mjs` and `trusted-home.mjs`, and `project-state.mjs` pulls in six more v3 modules.
  - `cli-entry.mjs` reads `CORE_DEBUG_CLI_ENTRY`, and `bm25.mjs` reads `CORE_TEST_STORE`. Step 7.1's `one-switch` check fails on both.
  - 0.3's Accept never imports the moved lib files, so the broken `bm25.mjs` passes Phase 0 and only fails at 3.2. The fallback "restore that one file" never settles: each restored file needs more removed files.
- **What breaks if we ship it as-is:** `node --test tests/release/` fails on the real-home-guard test, and the fallback re-imports a chain of v3 code into the "new" tree. Recall fails at import time in phase 3. `check --plugin` fails in 7.1 on files D3 told the agent to keep.
- **Suggested fix:** Say plainly that `bm25.mjs` is ported (only the tokenizer and scorer kept, no imports). Inline `symlinkCapable` into the moved test. Strip both `CORE_*` reads from the kept files in 0.3. Add `node -e "import('./plugins/core/scripts/lib/bm25.mjs')"` to 0.3's Accept.
- **Evidence:** `plugins/core/skills/core/scripts/bm25.mjs:35-36,118`; `cli-entry.mjs:32`; `tests/scripts/real-home-guard.test.mjs:10`; `tests/scripts/trusted-test-tmp.mjs:15,17`; `project-state.mjs:30-38`.

### R1-EX-04  —  major
- **Artifact:** D3
- **Location:** Step 0.3 item 1 (`frontmatter-flat.mjs` → `frontmatter.mjs`); step 2.1, "start from the ported v3 file. It must parse … the `edges` block list of inline maps … returns `{data, body}`"
- **What is wrong:** The kept file is the wrong parser. Its header says it is deliberately flat, drops "ALL indented lines: `edges:` blocks, multi-line `topics:`/`sources:` lists", and that callers needing edges "MUST use parseFrontmatter from priority.mjs". `priority.mjs` is deleted in 0.3. The kept file returns `[fm, body]`, not `{data, body}`.
- **What breaks if we ship it as-is:** At 2.1 the agent must either write a nested parser from scratch, with no guidance, or restore `priority.mjs` and its imports against the rules. If it extends the flat parser, it inherits a parser documented to lose edge data "silently (no error, no warning)". That is the defect class.
- **Suggested fix:** Keep the right source. Either name `priority.mjs`'s `parseFrontmatter` as the port source, or say 2.1 writes a new parser and drop `frontmatter-flat.mjs` from 0.3.
- **Evidence:** `plugins/core/skills/core/scripts/frontmatter-flat.mjs:15-22,29`.

### R1-EX-05  —  minor
- **Artifact:** D3
- **Location:** Step 0.3 item 1, "`git mv` these four files into `plugins/core/scripts/lib/`"
- **What is wrong:** `plugins/core/scripts/lib/` does not exist. `git mv` into a destination folder that does not exist fails. Item 3 says "(create the folder)" for `tests/release/`, but item 1 says nothing.
- **What breaks if we ship it as-is:** The first command of 0.3 errors. A literal agent hits a failure with no step-specific fallback.
- **Suggested fix:** Add `mkdir -p plugins/core/scripts/lib` before item 1.
- **Evidence:** `ls plugins/core` → `.claude-plugin .codex-plugin .gitignore LICENSE hooks skills`.

### R1-EX-06  —  major
- **Artifact:** D3
- **Location:** Step 0.5, "Keep, unchanged, the existing steps named 'Validate plugin manifests…', … 'Codex marketplace path integrity'" and Accept, "push the branch. All six matrix cells finish"; step 7.3
- **What is wrong:** Four problems in one step.
  - The CI workflow runs on `push` to `main` and `next` and on `pull_request` only. Pushing `v4` starts nothing.
  - "Validate plugin manifests" parses `plugins/core/hooks/hooks.json`, which 0.3 deleted and 3.5 recreates.
  - "Codex marketplace path integrity" fails when `plugins/core/skills` is missing, which it is from 0.3 until 4.3.
  - "Finish" is not "pass", so the Accept is met by a red run.
- **What breaks if we ship it as-is:** The step's acceptance cannot be observed. Even with a PR open, CI is red from phase 0 through phase 4 on steps the plan marked as kept unchanged, so a real regression in that window is invisible. Step 7.3's "green on all six cells" has no defined trigger.
- **Suggested fix:** Add `v4` to `on.push.branches`. Mark the two kept steps `continue-on-error` until 3.5 and 4.3. Make the Accept "every step passes except the ones flagged in `docs/build-log.md`".
- **Evidence:** `.github/workflows/ci.yml:3-6, 37-47, 128-160`.

### R1-EX-07  —  critical
- **Artifact:** D3 (contradicts D2)
- **Location:** Contract F, "Every hook call that says something, or that fails, appends one receipt row" (D3:339); step 7.4 `recall_rate`, `hook_coverage`, `sessions`; step 8.1 `prompt_hook`; step 8.2 `-p "Say only: ok"`; contract F Antigravity dedupe; contract E `no-handoff`. D2 §5: "Every hook and every watcher tick leaves one line in a receipts file."
- **What is wrong:** The metrics count receipt rows, but rows exist only when a hook spoke or failed. So the numbers are fixed by how they are built, not by what happened.
  - A prompt hook that matched nothing writes no row. So `recall_rate` (rows with hits ÷ rows) is close to 100% by construction.
  - A session whose hooks never fired writes no rows at all, so it is not in `sessions`. `hook_coverage` is therefore close to 100% by construction too.
  - Step 8.2 sends "Say only: ok", which matches no memory. No `prompt` row is written, so `env` reports `prompt_hook: unknown`, and 8.2's Accept ("`prompt_hook` … `ok`") can never pass.
  - The Antigravity duplicate check looks for an earlier `prompt` row with the same `ph`. A silent first call left none, so the check never fires.
  - `no-handoff` needs "prompt rows", so a session whose prompts all matched nothing is never caught as unclosed.
  - D2 promises the opposite: every hook leaves a receipt.
- **What breaks if we ship it as-is:** `metrics` reports high recall and full hook coverage when recall finds nothing and hooks are dead. That is instrumentation reporting success while doing nothing, the defect the plan exists to kill. The 8.2 live check fails on a working install, and the agent has no way to tell that from a real failure.
- **Suggested fix:** Write one receipt per hook call, including silent ones (`hits: 0`). Define `sessions` from a source independent of hooks, or report `hook_coverage` as `unmeasured` when only hook rows exist. Make 8.2 send a prompt that matches a fixture memory.
- **Evidence:** D3:339, D3 step 7.4 table (lines 887-896), D3:987; D2 §5 "How CORE detects its environment".

### R1-EX-08  —  major
- **Artifact:** D3
- **Location:** Contract A R1 and step 0.4, "`finish` with `status: 'ok', read: 0` and no `data.empty` produces `unknown`"; step 7.4 Accept, "with an empty `_core/` it asserts exit 3"; step 7.4 `reading_nothing`
- **What is wrong:** `finish()` cannot know whether a command "expects input". It forces every `read: 0` result to `unknown`. Several commands legitimately read nothing:
  - `hook pre-compact` prints fixed text.
  - `sample --coin N` reads nothing.
  - `trust add` on a new machine has no list to read.
  
  Step 7.4 also turns R1's own exception around: an empty `_core/` is "exists, listed, truly empty", which R1 says is `ok`, yet 7.4 requires exit 3.
- **What breaks if we ship it as-is:** Every `pre-compact` receipt is `unknown`, so `unknown_rate` for it is 100%. `reading_nothing` flags `pre-compact` permanently, so users learn to ignore that flag. `sample --coin` exits 3 and the blind check in `blind-check.md` stops at step 4. The agent must pick between R1 and 7.4 with no rule for which wins.
- **Suggested fix:** Let each command declare `expectsInput` to `finish()`. State that "no receipts" is `unknown` as an explicit exception to R1.
- **Evidence:** D3:186, D3 step 0.4 Accept, D3:910.

### R1-EX-09  —  major
- **Artifact:** D3
- **Location:** Step 1.1, "lists every command in contract K … deleted or unreadable → exit 1 or 3, never 0" and "Do not add an exception to the test"; contract A, "`hook` commands … always exit 0"; step 4.2, `watch` "exits at once with status `ok` … in a folder that is not a trusted CORE project"; step 3.1, "A missing or unparseable list means nothing is trusted"
- **What is wrong:** The honesty table requires a non-zero exit on missing input for every contract K command. Three commands are specified to exit 0 in that case:
  - `hook` always exits 0, by rule 6.
  - `watch` returns `ok` idle when there is no trusted project.
  - `trust list` and `trust add` treat a missing list as empty, which is normal on a new machine.
  
  The step forbids the exception it needs.
- **What breaks if we ship it as-is:** The test cannot pass without breaking another contract. An executor following "fix the command, not the test" will make hooks exit non-zero, and rule 6 says that blocks users. Or it will break `trust add` on first use.
- **Suggested fix:** Name the exempt rows in 1.1. Hooks are checked through the `status` field of their receipt, not their exit code. `watch` and `trust` are checked through `data`.
- **Evidence:** D3 steps 1.1, 3.1, 4.2; contract A last paragraph.

### R1-EX-10  —  major
- **Artifact:** D3
- **Location:** Steps 2.5, 3.3, 3.4, 4.1, 6.1, and the Accept lines of 3.6, 4.3, 4.4, 5.1, 5.2, 5.3, 6.2, 8.5
- **What is wrong:** Many steps need work from later steps, or have no test they can run when they are done.
  - 3.3 must "compute the queue", and its test needs "two `now` items", but the queue is built in 4.1.
  - 4.1's test needs "one temp project per row of contract E", including `stale-source` and `never-fetched`, but sources are read in 6.1.
  - 2.5's Accept needs `migrate --apply` from 2.6.
  - Every skill step is accepted only by eval cases written in 7.6. Its fallback when there are no credentials, `evals-shape.test.mjs`, only checks that the case folders exist.
- **What breaks if we ship it as-is:** The agent cannot finish 3.3, 4.1, or 2.5 in order, and must guess whether to build ahead or stub. Phases 3.6 through 6.2 contain all five skills, and none of them is checked by anything when its step ends. On a machine without paid eval credentials, the skills are "accepted" by a file-shape test, which passes trivially.
- **Suggested fix:** Move the queue (4.1) and `listSources` (6.1) before 3.3. For each skill step, give a deterministic Accept that runs at that step: `check --plugin` heading and length checks, plus `prose-eval` against a canned output.
- **Evidence:** D3 steps cited. The 7.6 fallback is at D3 step 7.6, "If it fails".

### R1-EX-11  —  major
- **Artifact:** D3
- **Location:** Step 0.6, "`--ablation none` … these scores are **B** … for the plain cases" and the stop rule "If every plain-case score is 0.9 or higher, **stop**"; line 489, "`fixture.sh` is one line that calls `build.sh`", against step 7.6, "each `fixture.sh` also runs `… core.mjs trust add`"
- **What is wrong:** The headroom number is biased low by how it is run.
  - With `--ablation none` the run has one arm, so `tool_used: Skill` graders are scored. Step 7.6 says every case where a skill should fire has one, and the skeleton has no skills, so they always fail.
  - `proactive-due` is a **W** case, but the 0.6 command grants no `--allow-tools Write Edit`, so the typo fix cannot happen and its `llm` grader fails.
  - If the agent writes `fixture.sh` as 7.6 specifies, `trust` is an unknown command at 0.6. It exits 2, the scaffold fails, and every run scores 0.
  - Step 0.6 and step 7.6 also disagree about what `fixture.sh` contains.
- **What breaks if we ship it as-is:** The one gate built to answer "do plain files already do the job?" is tilted toward "continue". With the 7.6 fixture it reads 0 for runs where the files were never written. The plan's native-first check (hard requirement 2) then rests on an artifact. It also cannot be compared with the B measured in 9.4, where Skill graders are excluded.
- **Suggested fix:** Run 0.6 with `--allow-tools Write Edit` and with no `tool_used: Skill` graders in the cases yet. State that `fixture.sh` gains the `trust add` line only in 7.6. Check `cases[].arms.with[].error` and treat any `scaffold failed` as not measured.
- **Evidence:** `plugin-evals.md` (code.claude.com): "In a two-arm run, some graders are reported with `scored: false` … Any grader you mark `arm: with-only`"; "If the script exits non-zero … that run scores 0 with a `scaffold failed` error".

### R1-EX-12  —  major
- **Artifact:** D3
- **Location:** Step 7.6, "Cases marked **W** need `--allow-tools Write Edit`" (Bash is never granted); skills in 4.4 (1), 5.1 (9), 5.2 (4), 5.3, 7.4 (1), which all "run the script"
- **What is wrong:** Every skill reaches CORE's checks by running `node core.mjs …`, which needs Bash. No eval case grants Bash. So in the eval, the agent cannot run `queue`, `index`, `verify`, `close`, `check`, `metrics`, or `selftest`. Several cases then pass for the wrong reason:
  - `honesty-unknown-not-ok` expects "not measured". The agent says it because it could not run the script, not because it found `_core` is a file.
  - `finalize-counts-from-disk` passes the same way.
  - `catch-up-unclosed` falls back to "transcript not available" and still writes a summary, which is all its grader checks.
  
  If Bash is granted, the runner's sandbox needs `bubblewrap` and `socat` on Linux and WSL2 on Windows, and it makes the home folder unreadable. Then `trust` and `install-id` cannot be read from inside the agent's commands.
- **What breaks if we ship it as-is:** The suite measures rung C ("skills only", with no script access) while the gates in 9.4 report it as CORE's effect. The honesty cases go green because nothing could be measured. That is the confusion the contract forbids.
- **Suggested fix:** Grant `Bash(node *core.mjs*)` in every case where a skill runs the script, and state the sandbox prerequisite. Or add a grader to each honesty case: `tool_used: Bash` with `input_match: core\.mjs` and `min: 1`.
- **Evidence:** `plugin-evals.md`: "When you grant `Bash` in any form, every command runs under Claude Code's OS-level sandbox … your home directory and Claude Code configuration are unreadable"; "Native Windows has no backend, so run shell-granting suites under WSL2; on Linux, install `bubblewrap` and `socat` first."

### R1-EX-13  —  major
- **Artifact:** D3
- **Location:** Step 7.6, "each `fixture.sh` also runs `node <plugin>/scripts/core.mjs trust add --temp --project .`"; contract K, "`--core-dir` exists so tests never touch the real home"; decision 15
- **What is wrong:** The scaffold runs with `HOME` set to a temporary folder, but CORE ignores `HOME` and reads `os.userInfo().homedir`. So every scaffold run, in both arms and in every case, appends to the operator's real `~/.core/projects.json` and creates `~/.core/install-id` there. Several things follow:
  - The plan's own rule that tests never touch the real home is broken.
  - The CI `real-home-guard` would flag this if evals ran in CI.
  - `untrusted-project-inert` depends on whatever the operator's real list holds.
  - `catch-up-unclosed` must plant a `receipts-<machine>-…jsonl` file, but the machine id is the first 8 characters of the operator's real `install-id`, which the fixture cannot know in advance.
- **What breaks if we ship it as-is:** Running the suite edits the user's trust list on every run. `no-handoff` in `catch-up-unclosed` reads a receipts file named for a machine that does not exist, so the case tests the fallback path.
- **Suggested fix:** Accept an `EVAL_CORE_DIR` variable in eval runs only (the runner passes `EVAL_*`), and keep `--core-dir` for tests. Or have `queue` read every `receipts-*.jsonl` file regardless of machine.
- **Evidence:** `plugin-evals.md`: "A scaffold script starts … with … `HOME` set to the run's temporary home directory"; decision 15 (D3:88).

### R1-EX-14  —  major
- **Artifact:** D3
- **Location:** Step 7.6, "The plugin path inside `fixture.sh` is the fixture file's own folder, three levels up"; contract K, "two folders above the skill's own `SKILL.md`"
- **What is wrong:** `fixture.sh` is at `plugins/core/evals/<case>/fixture.sh`. Starting from the file's own folder, three levels up is `plugins/`, and `plugins/scripts/core.mjs` does not exist. Two levels up gives `plugins/core`. Contract K counts the same way and says "two". D3 also never says whether the runner runs the script in place or copies it, so the right base for `$0` is a guess.
- **What breaks if we ship it as-is:** If the agent follows the text literally, every scaffold exits non-zero and every run in both arms scores 0. Then A − B = 0, and step 9.4 tells the agent to stop and report that "the plugin is not earning its place". That is a false verdict produced by a path typo.
- **Suggested fix:** Give the exact line: `node "$(dirname "$0")/../../scripts/core.mjs" trust add --temp --project .`, plus a scaffold-level check that exits non-zero with a clear message if the file is missing.
- **Evidence:** Directory layout in D3 "Target layout"; D3:927.

### R1-EX-15  —  major
- **Artifact:** D3
- **Location:** Step 7.6 graders for `remember-no-secret`, `remember-ignores-injection`, `remember-no-resurrection`, `remember-decision`, `setup-consent`, `catch-up-unclosed`; step 9.4 gate "Honesty and security eval cases score 1.0 each"
- **What is wrong:** Several graders pass or fail regardless of what the agent does.
  - The `regex not_contains` on `trace` for `sk-live_9f8e` and for the injected marker string can never pass. The user prompt itself is in the trace and contains both strings.
  - `remember-no-resurrection`'s `regex not_contains` on `files: redis` checks file paths, not file contents. A new memory named `dc-41-queue.md` that records Redis streams passes.
  - `remember-decision`'s "a new path under `_memories/`" is met by `_memories/INDEX.md`, which the session-start hook creates because the Lantern fixture has no index.
  - `setup-consent` passes if the agent never makes the offer at all.
  - `catch-up-unclosed` passes on the fallback summary that 5.3 writes when nothing was caught up.
- **What breaks if we ship it as-is:** The security gate in 9.4 can never reach 1.0, so the agent either reports a failure for a correct plugin or "simplifies the grader" as the 7.6 fallback allows. Meanwhile the anti-resurrection and remember cases go green when the behaviour is wrong.
- **Suggested fix:** Use `tool_used: Write` with `input_match: sk-live_9f8e` (and the marker string), `min: 0`, `max: 0`, and `arm: both`. Grade contents with `target: {source: file, path: …}`. Add an `llm` "PASS if it proposed the block" grader to `setup-consent`. Grade `catch-up-unclosed` on a fact from the planted transcript.
- **Evidence:** `plugin-evals.md`: `trace` is "The session as JSON … A `regex` grader sees every message"; `files` is "The list of paths … Not their contents".

### R1-EX-16  —  critical
- **Artifact:** D3
- **Location:** Step 9.4, "The v3 comparison. … `claude plugin eval ../core-v3/plugins/core --eval-dir <path to the v4 evals folder>`"
- **What is wrong:** `--eval-dir` takes a "Directory name (below the plugin)", not a path, so the command does not run as written. The only working route is to copy the v4 `evals/` folder into the v3 tree. Then every `fixture.sh` calls `scripts/core.mjs trust add`, which does not exist in v3. The scaffold fails and every v3 run scores 0. Nothing in 9.4 checks the per-run `error` field.
- **What breaks if we ship it as-is:** The gate "v4's mean score is not more than 0.1 below v3's" passes against a v3 that never ran. The blind pack has no v3 final messages to compare. That is a release gate reporting success while measuring nothing, the defect class the plan exists to kill.
- **Suggested fix:** Give v3 its own fixture line that skips `trust add` when `scripts/core.mjs` is absent. State the exact copy-in command. Require 9.4 to treat any run with a non-null `cases[].arms.*[].error` as not measured.
- **Evidence:** `claude plugin eval --help`: "`--eval-dir <dir>` Directory name (below the plugin) that holds the eval cases". `git ls-files plugins/core | grep scripts/core.mjs` at v3 prints nothing.

### R1-EX-17  —  major
- **Artifact:** D3
- **Location:** Step 7.2, "**It sees:** … `recall --prompt "ZEBRA-POISON"` returns nothing; … and so on"
- **What is wrong:** Three gaps in the selftest spec.
  - Recall's "sees" check is a negative. A recall that is completely blind, because of a broken tokenizer or an empty index, also "returns nothing" and passes.
  - "And so on" leaves the "sees" item for `index`, `verify`, `hook session-start`, and `hook prompt` undefined.
  - Nothing says the selftest's hooks use a temporary `--core-dir`. Without one, `hook session-start` finds the temp project untrusted, so it cannot "see". Or, in CI, it writes `install-id` to the runner's real home and `real-home-guard check` fails.
- **What breaks if we ship it as-is:** `selftest` can print "sees: yes" for an instrument that sees nothing. That is the exact check this step exists to make impossible. The agent must invent four acceptance criteria.
- **Suggested fix:** Plant a positive recall item: an active memory with a unique word that must be returned. Name the planted item for each of the seven instruments. Run everything against a temporary core folder that selftest creates and trusts.
- **Evidence:** D3:871.

### R1-EX-18  —  major
- **Artifact:** D3 (and D2 §7 table)
- **Location:** Budget, "Always-on context cost | 400 tokens | `claude plugin details core`"; 9.4 gate "Always-on cost 400 tokens or fewer"; decision 25, "first 6,000 bytes of `PROJECT.md`"
- **What is wrong:** `claude plugin details` counts skill and agent descriptions only. It reports hooks as "harness-only — no model context cost". CORE's largest always-on cost is the session-start hook's injected block, up to 1,200 bytes plus 6,000 bytes of `PROJECT.md`, about 1,800 tokens every session. On top of that, each prompt can add up to 1,000 bytes. None of this is in the measured number.
- **What breaks if we ship it as-is:** The budget and its release gate report "400 tokens, under budget" while the real per-session load may be higher than v3's measured 1,437 tokens. A measure that cannot see the main cost reports a pass.
- **Suggested fix:** Add a budget row "hook-injected bytes per session" checked by `perf.test.mjs` on the Lantern fixture, and report both numbers in the PR.
- **Evidence:** `claude --plugin-dir plugins/core plugin details core` → "Hooks (3) SessionStart, UserPromptSubmit, SessionEnd (harness-only — no model context cost)", "Always-on: ~1,437 tok".

### R1-EX-19  —  major
- **Artifact:** D3
- **Location:** Decision 23, "Unattended runs (headless, scheduled, background) … never write to `_memories/` or `PROJECT.md`"; contract F, "If the index was stale, rebuild it first"; step 5.1 (10), "if no user is present"; step 4.4 (4) tidy "on a schedule or loop"; every eval case (a `claude -p` run)
- **What is wrong:** No mechanism is defined for knowing a run is unattended. The rule also contradicts four other parts of the plan:
  - The session-start hook writes `_memories/INDEX.md` in headless runs.
  - The pulse skill, which the plan says runs "on a schedule or loop", moves memories into `archive/`.
  - The eval runner drives every case through `claude -p`, which is headless.
  - Yet `remember-decision`, `remember-supersede`, and `finalize-handoff` require writes under `_memories/`.
- **What breaks if we ship it as-is:** Either the remember and finalize evals fail because the skill obeys decision 23, or the skill ignores decision 23 in real headless runs. The security promise is then prose with no test, and the agent must pick one.
- **Suggested fix:** Define "unattended" by a fact the hook can see, and say how the agent learns it. Exempt `INDEX.md` explicitly. Give the evals a way to mark a run as attended, or test the inbox path instead.
- **Evidence:** D3:96; D3 contract F; `plugin-evals.md`: "the agent under test runs there as a `claude -p` child process".

### R1-EX-20  —  major
- **Artifact:** D3
- **Location:** Step 2.6, `migrate --apply` "does these, in order, and nothing else", which moves only by `status`; decision 20 removes the bi-temporal fields
- **What is wrong:** In v3, an active memory whose `t_invalid` date is in the past is excluded from retrieval "the same way a retired unit is". Migrate ignores `t_invalid`, so those memories stay in `_memories/`, enter `INDEX.md`, and become recallable. The kept fixture `policy-safety-store/_memories/dc-terminal-invalid-beacon.md` is `status: active` with `t_invalid: 2026-06-01` and its body says "must never surface". 2.6's Accept does not check it.
- **What breaks if we ship it as-is:** Upgrading a v3 project brings back facts the v3 store had invalidated. That is the resurrection defect the project's own change-review prompt names as pattern 5.
- **Suggested fix:** Add a migrate rule: an active memory with `t_invalid` at or before today moves to `archive/` with `status: superseded`. Add a 2.6 assertion that `dc-terminal-invalid-beacon` ends up in `archive/`.
- **Evidence:** `plugins/core/skills/core/protocols/data-storage.md:369`; `priority.mjs:384-389`; `docs/change-review-prompt.md:25`; `tests/fixtures/policy-safety-store/_memories/dc-terminal-invalid-beacon.md:6`.

### R1-EX-21  —  major
- **Artifact:** D3
- **Location:** Step 3.2, "tune the two threshold numbers against … `tier-safety-store/_tests-goldset.json` and every other `_tests-goldset.json` under `tests/fixtures/`"
- **What is wrong:** Only one gold set exists, and it holds one query (`"gateway placement"`, expected `dc-correct`). "Every other" is empty. Two thresholds tuned on one query pass at almost any setting, and then they are "frozen".
- **What breaks if we ship it as-is:** The thresholds that decide whether recall speaks, and so drive Recall, Focus, and the `reading_nothing` signal, ship effectively untuned. The Accept passes without showing that recall works on anything but one five-file store.
- **Suggested fix:** Before tuning, require building gold queries for the other three fixture stores and the Lantern fixture (at least 20 queries in total, with `forbidden` ids), and state that minimum.
- **Evidence:** `find tests/fixtures -name '_tests-goldset.json'` → one file; its content is `{ "queries": [ { "id": "s1", "query": "gateway placement", … } ] }`.

### R1-EX-22  —  major
- **Artifact:** D3
- **Location:** "How to use this document": "This document is all you need"; steps 0.6, 7.6, 9.4 (paid runs); 8.2–8.4 (live installs); 8.3, "open `/hooks`, and approve"; 8.4, "Never drive `agy` from inside Claude Code or Codex"; 0.6, "Report this to the maintainer and wait"; 9.4, "A person decides"
- **What is wrong:** D3 never says plainly which steps an agent cannot do.
  - **Paid model runs on the user's credentials:** 0.6 (up to $10), 7.6 (up to $40), the v3 comparison, and two blind-judge passes.
  - **Interactive approval only a person can give:** Codex's `/hooks` screen.
  - **Barred for agents:** 8.4, by Google's terms, as D3 itself says. The executing agent is Claude Code or Codex.
  - **Machines on three operating systems:** 8.2.
  - **A first-run trust prompt:** D3 never passes `--trust-plugin`, so a non-interactive `claude plugin eval` stops at it.
- **What breaks if we ship it as-is:** An agent with credentials spends about $50 or more without being told to ask. An agent without a terminal hangs at the trust prompt or at `/hooks`. 8.4 can only end `BLOCKED`, and the plan reads as finishable by an agent when phase 8 and parts of 0.6 and 9.4 need a person.
- **Suggested fix:** Mark each of these steps with a "needs a person" or "spends money" tag at the top, and state the expected total cost. Add `--trust-plugin` to every eval command. Make 8.3 and 8.4 checklists for a human, with the agent recording the results.
- **Evidence:** `claude plugin eval --help`: "The first run in an untrusted plugin directory asks you to confirm (--trust-plugin answers for CI)"; D3:1001.

### R1-EX-23  —  minor
- **Artifact:** D3
- **Location:** Step 5.2 Accept, "Run `tests/prose-evals/prose-eval.mjs` against the output of `finalize-handoff`"
- **What is wrong:** `prose-eval.mjs` has no command-line entry. It only exports `checkProseOutput(fixture, text)`. The summary file lives in the run's temporary workspace, which is deleted unless `--keep-temp` is passed. The `--json` result holds graders and messages, not the file.
- **What breaks if we ship it as-is:** The command does not run as written, and the input it needs is gone by the time the agent looks for it.
- **Suggested fix:** Add a three-line wrapper in `tests/tools/`, and grade the summary text from the trace (the Write tool input) or via `--keep-temp`.
- **Evidence:** `grep -nE "process\.argv|export function" tests/prose-evals/prose-eval.mjs` → only `82:export function checkProseOutput`.

### R1-EX-24  —  minor
- **Artifact:** D3
- **Location:** Step 7.1 `commands-two-way` ("a contract K command is named in no shipped `.md` or hook file") and `orphans`; step 4.3, "these sections, in this order, and nothing else"
- **What is wrong:** No shipped `.md` is told to name `migrate`, `env`, `recall`, or `watch`. `migrate` is in the repo-root `INSTALL.md`, which is not shipped. `watch` is only in `monitors.json`, which is not a hook file. So the two-way check fails on the real tree, and the `core` skill's "nothing else" rule blocks the obvious fix. Separately, `skills/pulse/reference/refresh.md` is linked from the agent file and `sources.md`, not from a `SKILL.md`, so `orphans` flags it.
- **What breaks if we ship it as-is:** 7.1's "On the real tree, `check --plugin` exits 0" fails, and "fix the plugin, not the check" leaves the agent padding skills with command names to satisfy a lint.
- **Suggested fix:** Count `monitors.json` and repo-root docs for the two-way check, and let `orphans` follow links from any shipped `.md`.
- **Evidence:** D3 step 7.1 table; skill section lists in 4.3–5.2.

### R1-EX-25  —  minor
- **Artifact:** D3
- **Location:** Steps 0.6, 7.6, 9.4 eval commands
- **What is wrong:** `claude plugin eval` publishes its HTML report (with prompts and grader verdicts) to claude.ai by default. It writes results into `plugins/core/evals/results/`, inside the shipped plugin folder. D3 never passes `--no-publish`, and never adds `evals/results/` to `.gitignore`.
- **What breaks if we ship it as-is:** Unattended runs publish pages on the user's account without being asked. Result folders land in the plugin tree, where a Codex install re-hashes them and resets hook approval on a dev checkout. They can also be committed by accident.
- **Suggested fix:** Add `--no-publish` to each command, and add `plugins/core/evals/results/` to `.gitignore` in 0.6.
- **Evidence:** `claude plugin eval --help`: "`--publish-report` … (already the default when your account supports it)"; "`--eval-dir` … results go to `<plugin>/<dir>/results/`".

### R1-EX-26  —  minor
- **Artifact:** D3
- **Location:** Contract F, "In a CORE project that is not on the trust list: `session-start` says one line"; D3:339, "Every hook call that says something … appends one receipt row"; rule 7, "Nothing runs in a project that is not on the trust list"
- **What is wrong:** The untrusted notice "says something", so by D3:339 it writes a receipt. That creates `_core/` and `_core/.gitignore` inside a project that was never enabled. The 3.3 test checks that no `_core/` is made in a non-CORE folder, but not in an untrusted CORE folder.
- **What breaks if we ship it as-is:** Cloning someone's repo that has a `PROJECT.md` and opening a session writes files into it, against rule 7.
- **Suggested fix:** State "no receipt in an untrusted project", and add that assertion to 3.3.
- **Evidence:** D3 contract F; D3:339.

### R1-EX-27  —  minor
- **Artifact:** D3
- **Location:** Step 0.2 Accept, "`switch_names: 34`"; decision 16, "v3 has 35 switches [G 2.1]"
- **What is wrong:** The two numbers come from two different regexes. Grounding uses `CORE_[A-Z][A-Z0-9_]+` over all files and gets 35. D3 uses `\bCORE_[A-Z0-9_]+` over `.mjs`, `.md`, and `.json` and gets 34.
- **What breaks if we ship it as-is:** The PR's "budget numbers against `docs/baseline-v3.json`" will say 34 while D1, D2, and decision 16 say 35. A reviewer sees a mismatch with no explanation.
- **Suggested fix:** Use one regex and one number everywhere.
- **Evidence:** Both commands, run here: 35 and 34.

### R1-EX-28  —  minor
- **Artifact:** D3
- **Location:** Step 2.5, `brief-size` and `active-cap`, "(a warning: reported, does not fail)"; rule 1, "Every check ends as `ok`, `fail`, or `unknown`"
- **What is wrong:** A warning is a fourth outcome that the three-outcome contract does not have. D3 does not say what status a warning check carries.
- **What breaks if we ship it as-is:** The agent guesses. If it uses `ok`, the warning is invisible to the "status is fail if any failed, else unknown if any unknown" rule. If it uses `fail`, an oversized brief fails `check --project`.
- **Suggested fix:** Report warnings as `ok` with `data.warnings[]`, and say so.
- **Evidence:** D3 step 2.5 table; rules 1 and R3.

### R1-EX-29  —  minor
- **Artifact:** D3
- **Location:** Steps 3.6, 6.1, 7.3, 8.1, 8.5, 9.1, 9.2, 9.3, 9.5
- **What is wrong:** These steps have no "If it fails" line, though the contract requires "A failure procedure per step". 6.1 also has no Accept of its own; it points at 4.1's test.
- **What breaks if we ship it as-is:** The executor falls back to the general procedure, which ends in `BLOCKED` with no named fallback, for steps such as 9.5 where a fallback exists (open the PR with the gates listed as not measured).
- **Suggested fix:** Add one line each. Most can say "general procedure", but 7.3 and 9.5 need specific fallbacks.
- **Evidence:** D3 step text.

### R1-EX-30  —  minor
- **Artifact:** D3
- **Location:** Decision 1, "a new branch `v4`, cut from `main`"; step 9.5, "Open a pull request into `next`"
- **What is wrong:** `origin/next` exists at `d23c9f9`, a commit not in `main` or in this clone. A branch cut from `main` that rewrites `CHANGELOG.md`, the manifests, and the whole tree will conflict with whatever `next` holds. `version-check.yml` compares the version against `next`, not `main`.
- **What breaks if we ship it as-is:** At 9.5 the agent faces merge conflicts against code it has never seen, with no rule for how to resolve them, and a version check against an unknown base.
- **Suggested fix:** Cut `v4` from `origin/next`, or open the PR into `main`, and state which.
- **Evidence:** `git ls-remote origin refs/heads/next` → `d23c9f9…`; `git log d23c9f9` → unknown revision locally.

### R1-EX-31  —  minor
- **Artifact:** D3
- **Location:** Step 0.4, "Replace each `description` with: …"
- **What is wrong:** The Codex manifest also carries `interface.shortDescription`, `interface.longDescription`, `defaultPrompt`, and `keywords`. These advertise "seven companion utilities … /memory-view", "multi-agent", and "adversarial-review", all removed in v4. D3 changes only `description`. The Claude manifest and marketplace keep the same stale `keywords`.
- **What breaks if we ship it as-is:** Codex's plugin browser shows v4 with v3's feature list. Users look for `/refocus` and `/memory-view`, which no longer exist.
- **Suggested fix:** List each field to rewrite or delete in all three manifest files.
- **Evidence:** `plugins/core/.codex-plugin/plugin.json` `interface` block; `.claude-plugin/marketplace.json` `metadata.description`.

### R1-EX-32  —  minor
- **Artifact:** D3 vs D2
- **Location:** D2 §7: "each case ends with 'do not mention how you found the answer'", "the judge sees only the final answer", "The pack is judged twice with the order flipped". D3 7.6 and 9.4.
- **What is wrong:** In D3 only `recall-past-decision` ends with that sentence. Four `llm` graders use `focus: trace`, so the judge sees the trace, not only the final answer. The 9.4 second pass uses "a second seed", which may produce the same order rather than flipping it.
- **What breaks if we ship it as-is:** An agent building from D2's description builds a different suite from D3's table. The blind-judge agreement rule can count cases judged twice in the same order, which weakens the blindness the design claims.
- **Suggested fix:** Pick one. Most simply, make the second pack the exact flip of the first.
- **Evidence:** D2 §7 "Does CORE help?" and "Against the old version, blind"; D3:1047.

### R1-EX-33  —  minor
- **Artifact:** D3
- **Location:** Steps 0.6 and 7.6, "`case.yaml`, `fixture.sh`"; "the same four with `--norecord` added to the name"; `honesty-no-hooks`, "`env: {…}` in the prompt frontmatter"
- **What is wrong:** D3 never gives `case.yaml`'s contents. The runner requires `schema_version: "1.1"`, `name`, and `context.scaffold_script: fixture.sh`, and `case.yaml` puts `env` under `execution:`. The twin naming is also loose ("`--norecord` added to the name"), yet `cells.mjs` pairs cases by that name.
- **What breaks if we ship it as-is:** Without `context.scaffold_script`, `fixture.sh` never runs, every workspace is empty, and both arms score alike. If the twin names differ from what `cells.mjs` expects, every cell prints "not measured".
- **Suggested fix:** Give one complete `case.yaml` and the exact twin suffix (for example, `recall-past-decision-norecord`).
- **Evidence:** `plugin-evals.md`: "A `case.yaml` also needs `schema_version: "1.1"` and `name`"; "`context.scaffold_script` … runs only when you pass `--scaffold`".

---

**What held up.** The step 0.2 baseline reproduces exactly on the current tree: 100 files, 34,313 lines, 606,815 bytes, 126,923 bytes, 34 switches, and `claude plugin details` prints an always-on figure (~1,437 tok). The three release tests D3 keeps pass today (33/33) before they are moved.

critical 3 · major 18 · minor 12 · taste 0
