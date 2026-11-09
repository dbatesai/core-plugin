# Round 3 — Executor (D3 v3)

I walked `v3-d3.md` from step 0.1 onward as if building it. I checked facts with read-only commands: `git ls-remote origin`, `claude --version` (2.1.321), `claude plugin eval --help`, `claude --plugin-dir plugins/core plugin details core`, Node 22, the CORE 3 source, the fixture stores, and `https://code.claude.com/docs/en/plugin-evals.md`.

Steps 0.1 to 0.3 run as written. The 0.2 baseline numbers reproduce exactly (100 / 34313 / 606815 / 126923 / 34). The 0.3 Accept chain now fails when it should: `verify-release-identity.mjs --help` exits 2.

**First step where I get stuck: 7.2.** Its planted items contradict each other (R3-EX-06). The step forbids changing a planted item, so I cannot finish it without asking.

---

### R3-EX-01  —  minor
- **Artifact:** D3
- **Location:** Step 0.4 Accept, "all four version fields read `4.0.0`"; step 9.3, "All four version fields `4.0.0` … checked the way `version-check.yml` checks them"
- **What is wrong:** There are five version fields after 0.4, not four: the Claude manifest, the Codex manifest, the new Antigravity manifest, and `marketplace.json`'s `metadata.version` and `plugins[0].version`. `version-check.yml` checks four of them, and the Antigravity manifest is not one. So "the four" means different sets in 0.4 and 9.3, and 9.3's Accept never looks at the Antigravity version.
- **What breaks if we ship it as-is:** A 4.0.1 bump that misses `.antigravity-plugin/plugin.json` passes 9.3 and `version-check.yml`. Only `check --plugin` catches it, and only if someone runs it before the tag.
- **Suggested fix:** Say "all five version fields" and list them. Add the Antigravity manifest to `version-check.yml` in 0.5.
- **Evidence:** `.github/workflows/version-check.yml` reads `plugins/core/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (`.plugins[0].version`, `.metadata.version`), and `plugins/core/.codex-plugin/plugin.json`. Nothing else.

### R3-EX-02  —  major
- **Artifact:** D3
- **Location:** Step 0.6 Do and Accept; step 7.6 Run 1–3 and Accept, "the three runs finish"; `--max-cost-usd 15` / `60` / `40`
- **What is wrong:** The runner exits 1 whenever any case scores below `--threshold`. The default threshold is 1.0, and D3 never sets one. So every eval command in D3 exits 1, even on a healthy run. Exit 2 means the cost ceiling stopped the run partway, with `partial: true` in the JSON. No "If it fails" handles exit 1 or exit 2. The caps also have no stated basis. Run 1 starts about 306 runs: (5 gated × 5 + 10 twins × 5 + 26 others × 3) × 2 arms. At $60 that is about $0.20 per run, with a 300-file fixture and up to 30 turns. Step 0.6 is 100 runs for $15. About 75 of run 1's runs are never read by `cells.mjs`: the gated cases' without-arm and the twins' with-arm.
- **What breaks if we ship it as-is:** The agent cannot tell "finished" from "failed". If it treats exit 1 as failure, it goes into the general procedure on every run. If it ignores exit codes, a cap hit drops the cases that come later in case order without notice. `cells.mjs` then prints "not measured" because of budget, not because of anything CORE did. A retry spends the money again.
- **Suggested fix:** Pass `--threshold 0` to every eval command. Accept = exit 0 and `partial` absent. On exit 2, record the cases that never started and stop; do not rerun. Run gated cases with `--ablation none` and the twins in their own run, so no arm is wasted.
- **Evidence:** plugin-evals.md, Command options: "`--threshold <0..1>` | `1.0` | … Any case below it makes the command exit 1". Run evals in CI: "2 | Partial run: the `--max-cost-usd` ceiling was hit … written with `partial: true`".

### R3-EX-03  —  critical
- **Artifact:** D3
- **Location:** Step 1.1, "a table with one row per contract K command (rows are added as each command is built)"; Accept, "the test passes"
- **What is wrong:** When 1.1 is done, no contract K command exists yet; 0.4 built only the dispatcher. The table is empty, so the test passes with nothing in it. No later step adds a row. `tests/honesty.test.mjs` appears once in all of D3 (line 561). The Files list or Accept of 2.3, 2.5, 2.6, 3.0, 3.2, 3.3, 3.4, 5.2, 7.4, and 8.1 never names it. An agent that follows each step's Files list finishes the build with an empty honesty table that passes.
- **What breaks if we ship it as-is:** Phase 1's deliverable, "no command can say `ok` when it read nothing", is backed by a test that checks nothing and reports green. That is the defect class this plan exists to kill, inside the guard meant to kill it. The 1.1 "bite" proof uses a fake command, so it only proves the table works when someone fills it.
- **Suggested fix:** Build the rows from `core.mjs`'s dispatch table. The test fails when a command with `expects: true` has no fixture row. Then a new command without a honesty row turns CI red.
- **Evidence:** `grep -n "honesty.test" gauntlet/v3-d3.md` → only line 561.

### R3-EX-04  —  major
- **Artifact:** D3
- **Location:** Step 2.6 Accept, "each of the four fixture stores, copied to a temp folder and migrated, then passes … no file contains `CORE:BEGIN_EDGES`"
- **What is wrong:** None of the four fixture stores has the inputs for migrate's steps 3, 4, 5, and 7. No memory has a `CORE:BEGIN_EDGES` block, no store has a `PROJECT.md` with `<!-- CORE:` lines, and none has `_lib/`, `_validation/`, `_close-marker.json`, `_close.lock`, `_sources/*.yaml`, or `_summaries/`. So "no file contains `CORE:BEGIN_EDGES`" is true before migrate runs. Only steps 1 and 2 (move `retired` to the archive, and `t_invalid`) are exercised. Also, a copy in a temp folder is not a git repository, so `--apply` refuses unless `--no-git` is passed, and the Accept does not say to pass it.
- **What breaks if we ship it as-is:** The transformations most likely to damage a real v3 store go untested. Those are cutting the generated block out of a memory and stripping markers from `PROJECT.md`. A migrate that deletes the body under a half-matched marker, or every line of `PROJECT.md`, passes 2.6 and runs `--apply` on the user's real store.
- **Suggested fix:** Add a fifth fixture, copied from a real decorated v3 project: memories with `CORE:BEGIN_EDGES` blocks, one with only a begin marker, a `PROJECT.md` with `<!-- CORE:` lines, and `_lib/`. Assert byte-exact output on it. Name `--no-git` in the Accept.
- **Evidence:** `find tests/fixtures -name _lib -o -name _validation -o -name PROJECT.md` → nothing. `grep -l BEGIN_EDGES tests/fixtures -r` → nothing. `decorate-graph.mjs` is what writes the block in real v3 stores.

### R3-EX-05  —  major
- **Artifact:** D3
- **Location:** Step 4.3 §10, "A v3 store (`_memories/_lib/` exists) → `migrate`"
- **What is wrong:** `_memories/_lib/` is CORE 3's local cache. CORE 3 writes `_lib/.gitignore` containing `*`, which also ignores that file itself. CORE 3 also refuses to run if git tracks anything there. So `_lib/` exists only on machines where CORE 3 ran. It is missing on a fresh clone, a teammate's machine, or a cloud session.
- **What breaks if we ship it as-is:** On any clone of a v3 project, the `core` skill does not see a v3 store and offers no migrate. Enabling goes ahead, and `INDEX.md` lists every v3 `retired` and `superseded` memory still sitting in `_memories/`. Recall then points at those retired decisions. Separately, `check --project` fails `location` with no route to fix it.
- **Suggested fix:** Detect v3 from committed signs. Any memory with `CORE:BEGIN_EDGES`, a `PROJECT.md` line starting `<!-- CORE:`, `_memories/observations/`, or a `retired`/`superseded` file outside `archive/`. Any one of these means v3.
- **Evidence:** `plugins/core/skills/core/scripts/store-ignores.mjs:131` writes `HEADER + '*\n'` to `_lib/.gitignore`. Line 147: `refuse('cache-tracked', 'git tracks files in it')`.

### R3-EX-06  —  major
- **Artifact:** D3
- **Location:** Step 7.2 table, rows "Memory `risk-20261015-zebra-gate-deadline`", "Four memory files | `index` | count is 4", "Enabled project; stdin with a matching prompt | `hook prompt` | … `hits: 1`"; If it fails, "Never weaken a planted item"
- **What is wrong:** Contract G scores a line on its id, summary, and topics. It splits on non-letters. The planted risk id `risk-20261015-zebra-gate-deadline` gives the terms `zebra` and `gate`. The selftest prompt is "zebra gate fridays". Two terms match, and `MIN_TERMS` starts at 2. So the risk line passes too, `hits` is 2, and the planted check "hits: 1" fails. Whether it passes depends on what 3.2 tunes `MIN_TERMS` to, so a later retune can break or fix the selftest. "Four memory files" also clashes with the table: it plants five memories in `_memories/` (zebra, the open question, the `sk-` memory, the risk, the missing-edge memory), unless two of them are meant to be one file. The table does not say so.
- **What breaks if we ship it as-is:** `core.mjs selftest` prints `sees: no` for the prompt hook on a working build. The agent may not weaken a planted item and has no other route, so 7.2, and 7.3's "CI green", cannot pass. This is where I stop and have to ask.
- **Suggested fix:** Rename the risk memory so it shares no word with the zebra prompt (for example `risk-20261015-provider-deadline`). Say which planted rows share a file, and state the index count that follows.
- **Evidence:** v3-d3.md:981, 984, 985; contract G, "A line passes when at least `MIN_TERMS` different prompt terms match it … start at 2".

### R3-EX-07  —  critical
- **Artifact:** D3
- **Location:** Step 7.5, `package-layer1.mjs` copies "`evals/`, with that line dropped from every appended block"; 7.6 `canary` row, "Any failed run → every with-plugin score in that results file is 'not measured: enabling failed'"; 7.6 Accept, "`canary` passed in every run"
- **What is wrong:** The Layer 1 package copies every case, `canary` included. `canary` passes only if `CORE: session hook ran` is in the trace. Layer 1 has no hooks, so `canary` fails in every Layer 1 run. By D3's own rule, every Layer 1 score is then "not measured". There is a second problem in run 1. `canary`'s only grader is `arm: with-only`, and when every grader in a case is excluded, the runner scores them normally in both arms. So `canary` also fails in every without-plugin run of `results-v4.json`, and "any failed run" covers those too.
- **What breaks if we ship it as-is:** The layer 1 arm is never measured. Every "Keep Layer 2" rule reads "not measured", the gate is "not measured" on every build, and 7.6's Accept can never pass. Requirement 7's comparison against a prior layer gives no number, however good or bad v4 is.
- **Suggested fix:** Have `package-layer1.mjs` delete `evals/canary/`. Restrict the canary rule to with-arm runs of the full plugin's results file.
- **Evidence:** v3-d3.md:1038, 1106, 1142. plugin-evals.md, "Score against the no-plugin baseline": "Every grader excluded: if every grader in a case is in the excluded set, they're scored normally instead."

### R3-EX-08  —  major
- **Artifact:** D3
- **Location:** Step 7.5, "`cells.mjs --full <results-v4.json> --layer1 <results-layer1.json> --gate <GATE.md>` … then each GATE.md rule as met, not met, or not measured"; step 0.6, GATE.md rules "each with a one-line reason"
- **What is wrong:** GATE.md is specified as prose. `cells.mjs` has to judge its rules, but D3 gives no machine-readable format for them. So the agent has to choose: parse English, or hard-code the numbers in `cells.mjs`, which leaves GATE.md as decoration that can drift from the code. Several rules also need 7.7 data: Keep Layer 2 (4), Keep Layer 1, and Built-in. `cells.mjs` takes no `--sessions` input, and at 7.6 `docs/sessions-v4.json` does not exist yet. 9.4 then names "`cells.mjs`; `docs/sessions-v4.json`" as the source for those gates, without saying how the two are joined.
- **What breaks if we ship it as-is:** The frozen-gate guarantee ("never changed") rests on code the agent improvises, after the results exist. The verdict rules that depend on 7.7 can only print "not measured", or be judged by hand in 9.4. In both cases the "frozen before data" rule is not enforced by anything.
- **Suggested fix:** Make GATE.md hold a fenced JSON block of thresholds that `cells.mjs` reads, and commit it in 0.6. Give `cells.mjs` a `--sessions docs/sessions-v4.json` flag, and run it again in 9.4.
- **Evidence:** v3-d3.md:530–537, 1039, 1139, 1258.

### R3-EX-09  —  major
- **Artifact:** D3
- **Location:** Step 7.6 grader legend, "`tool_order` | `tools`", "`file_exists` | `glob`, optional `exists: false`", "`llm` | `rubric`, optional `focus`"
- **What is wrong:** The legend names keys the runner does not use. `file_exists` takes `path`, not `glob`. `tool_order` takes `before` and `after`, not `tools`. An `llm` grader's rubric is its `criteria`, which in the `.md` layout is the file body. But D3 also says each grader file has "a one-line note" as its body, so the note would become the criteria.
- **What breaks if we ship it as-is:** `setup-new-project` is graded only by `file_exists`. Written from the legend, its grader has no `path`, so it cannot match and the case scores 0 on every build. Every `llm` grader written with a `rubric:` key and a note as body is judged against the note ("The answer gives the reason…"), not the "PASS if … FAIL otherwise" rubric D3 wrote.
- **Suggested fix:** Correct the three rows. For `llm` graders, state that the PASS/FAIL rubric is the file body and there is no separate note.
- **Evidence:** plugin-evals.md, Grader types: "`tool_order` | `before`, `after`"; "`file_exists` | `path`, `exists`"; "`llm` | `criteria`, `focus` | … In the `.md` layout the file body is the criteria".

### R3-EX-10  —  major
- **Artifact:** D3
- **Location:** Step 7.6, `remember-no-resurrection`: "`tool_used` `Write`, `input_match: '(?i)redis'`, `max: 0`"
- **What is wrong:** This is the fix suggested in R2-EX-17 and accepted, and it does not work. The runner's patterns are JavaScript regexes. JavaScript has no inline `(?i)`, and `new RegExp('(?i)redis')` throws "Invalid group".
- **What breaks if we ship it as-is:** The resurrection guard either stops the case from loading or never matches. If it never matches, a Write of "Redis streams" as the queue decision goes undetected, and the case passes on its `llm` grader alone. Either way, the one test of the anti-resurrection rule (decision 11) reports a result that does not reflect what the agent did.
- **Suggested fix:** Use `input_match: '[Rr][Ee][Dd][Ii][Ss]'`, or a plain `redis|Redis`. Add a line to the legend: "JavaScript regex; no inline flags".
- **Evidence:** `node -e "new RegExp('(?i)redis')"` → `Invalid regular expression: /(?i)redis/: Invalid group`. plugin-evals.md troubleshooting: "regexes use JavaScript syntax, so put `i` in `flags` rather than writing `(?i)`".

### R3-EX-11  —  major
- **Artifact:** D3
- **Location:** Step 7.6 Run 1 and 3 versus GATE.md (0.6); 7.6, "Where a skill should fire, add a `tool_used: Skill` grader (an indicator only in two-arm runs)"
- **What is wrong:** The full arm is scored in a two-arm run. There, the runner removes `tool_used: Skill` graders, `mock_calls` graders on plugin-declared servers, and `with-only` graders from the score. The layer 1 arm is scored with `--ablation none`, where nothing is removed. `cells.mjs` strips only `enabled-check`. So any gated case with a Skill grader has a layer 1 score that counts a grader the full score does not. The step sizes GATE.md relies on (0.2 for one grader, 0.1 for two) also differ between the two arms.
- **What breaks if we ship it as-is:** "full − layer 1", the number that decides whether Layer 2 ships, subtracts two scores computed under different rules. A Skill grader that layer 1 passes lowers the difference. One that layer 1 fails raises it. The gate can then flip on how the scores were computed, not on what the agent did.
- **Suggested fix:** `cells.mjs` recomputes both arms from per-grader results, using one fixed list of scored graders per case, written into GATE.md in 0.6. Or say gated cases carry no Skill grader.
- **Evidence:** plugin-evals.md: "under `--ablation none` nothing is excluded, so the same suite can produce a different absolute score in the two modes."

### R3-EX-12  —  major
- **Artifact:** D3
- **Location:** Step 7.6 Run 2, "`--case honesty-no-hooks --case finalize-counts-from-disk`"; 9.4, "`--case recall-past-decision --case recall-distractors --case brief-budget --case finalize-handoff`"; 0.6, "`--case '*-files' --case '*-norecord'`"
- **What is wrong:** The CLI declares `--case <glob>` as a single value. `--tag <tag...>` is the one marked "(repeatable)". With a single-value option, the last flag wins. D3 lists this as "not verified", but only 0.6 has a fallback. Run 2 would run `finalize-counts-from-disk` only. The v3 comparison would run `finalize-handoff` only. 0.6 would run only the `-norecord` twins.
- **What breaks if we ship it as-is:** `honesty-no-hooks` is "read from this file only", so it has no result, and 8.5's Accept ("eval case `honesty-no-hooks` passes") cannot pass. The "Against v3" gate compares one case of four, without saying so. In 0.6, the `-files` Accept check ("a `Read` call on `_memories/`") fails for a reason the agent cannot see.
- **Suggested fix:** Tag cases (`tags: [nowrite]`, `[v3]`, `[twin]`) and select them with `--tag`, which repeats. Or run one command per case, with its own `--json` file, and say how the files are merged.
- **Evidence:** `claude plugin eval --help`: "`--case <glob>` Filter cases by name glob" versus "`--tag <tag...>` Filter cases by tag (repeatable)". v3-d3.md:1136, 1262, 548, 1300.

### R3-EX-13  —  minor
- **Artifact:** D3
- **Location:** Step 7.6 `untrusted-project-inert`, "without `EVAL_CORE_ENABLE`"; decision 16, "so a test never touches the real home"; contract B, "`noticed.json`"
- **What is wrong:** Without `EVAL_CORE_ENABLE` there is no eval mode, so the core folder is the real `~/.core`. Eval hooks run outside the sandbox, as the user. So every with-plugin run of this case writes that run's temporary workspace path into the maintainer's real `~/.core/noticed.json`. It creates the folder if it is missing. Nothing ever prunes `noticed.json`; only `temp` entries in `projects.json` are dropped. The same happens in every case whenever eval mode's temp-folder condition fails. This is a gap in the R1-EX-13 fix: eval mode protects enabled cases only.
- **What breaks if we ship it as-is:** Each eval run leaves dead temporary paths in the maintainer's home, which is the thing decision 16 says cannot happen. The 3.1 guard (`real-home-guard` around an eval-mode hook) never covers this path, and no guard wraps the paid eval runs.
- **Suggested fix:** Run this case with `EVAL_CORE_ENABLE` set and the project made to fail the condition: data folder set, project outside the temp folder. Or give eval runs a test-only `EVAL_CORE_HOME`. Wrap every paid run in `real-home-guard snapshot`/`check`.
- **Evidence:** v3-d3.md:88 (decision 16), 237, 329, 1131. plugin-evals.md: hooks "run outside the agent's sandbox".

### R3-EX-14  —  critical
- **Artifact:** D3
- **Location:** Step 7.7 Do item 4, "Each session: `claude -p "<prompt>" …`. … After each unclosed session, move every receipt `t` back 3 hours"; contract E `no-handoff`, "a session with ≥ 3 `prompt` rows"; 7.7 records facts "found only in `_core/inbox.md`"
- **What is wrong:** This is the fix for R2-PR-06, and it does not work. Each 7.7 session is one `claude -p` call with one prompt. That fires `UserPromptSubmit` once and writes one `prompt` row. `no-handoff` needs three or more, so it never fires. The 3-hour back-dating has no effect, the catch-up never runs, and the "found only in `_core/inbox.md`" count can only ever be 0.
- **What breaks if we ship it as-is:** 7.7 reports a catch-up count of 0 for every arm, as a number, not as "not measured". That reads as "the catch-up found nothing" while the catch-up never ran: the defect class itself, in the release evidence. The write path D2 says most real sessions depend on stays unmeasured, and still looks measured.
- **Suggested fix:** Give each 7.7 session three or more turns (`-p`, then `--resume <id>` twice). Or report the inbox split as "not measured" when no `no-handoff` item appeared in the next session's status block. Assert this in `sessions.test.mjs`.
- **Evidence:** v3-d3.md:295, 1155. Ledger row R2-PR-06 "Accepted | G7".

### R3-EX-15  —  major
- **Artifact:** D3
- **Location:** Step 9.4 gate table, "Honesty and security cases | 1.0 each | `docs/results-v4.json`, `docs/results-v4-nowrite.json`"
- **What is wrong:** No list says which cases count as "honesty and security". At least eight cases are plausible: `honesty-unknown-not-ok`, `honesty-no-hooks`, `remember-no-secret`, `remember-ignores-injection`, `update-ignores-injected-tool-text`, `untrusted-project-inert`, `pulse-unattended-no-writes`, `finalize-counts-from-disk`. Perhaps `remember-no-resurrection` too. "1.0 each" across 3 runs, with `llm` graders voting two of three, means a single judge flip fails the release. The plan does not say whether that is intended. GATE.md, which freezes the other rules, does not hold this one.
- **What breaks if we ship it as-is:** The agent at 9.4 chooses the set after seeing the scores. That is the "numbers chosen after the results" problem the plan rejects in its Alternatives. Whichever set it chooses, a person reading the pull request cannot check it against anything frozen.
- **Suggested fix:** List the cases by name in GATE.md in 0.6, with their pass rule. For example: every free grader passes in every run, and `llm` graders pass in at least 2 of 3 runs.
- **Evidence:** v3-d3.md:1256. The words "honesty and security" appear nowhere else in D3 as a set of cases.

---

Sound: the 0.2 baseline numbers, the 0.3 Accept chain, and the `secrets` look-behind now behave as the plan says. I checked all three.

critical 3 · major 10 · minor 2 · taste 0
