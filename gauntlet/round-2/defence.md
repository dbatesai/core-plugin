# Round 2 — defence

Seven fresh reviewers, each given only the file paths and `reviewer-brief.md`. 129 findings: **critical 17 · major 81 · minor 30 · taste 1**.

**Status line:** Round 2 — 129 findings, 129 accepted, 0 rebutted (one partial rebuttal was disputed by its reviewer with evidence and withdrawn before judging).

Round 2 found that several round-1 fixes were made on paper. The biggest: the convention arm never had the five skills, so no test ever measured Layer 1, and Layer 1 could not run without the script anyway. Every accepted finding maps to one fix below. The fix list is what v3 implements.

## The fixes

| Code | Fix applied in v3 |
|---|---|
| G1 | **Layer 1 becomes a real, testable thing.** `tests/tools/package-layer1.mjs` builds `dist/core-layer1/`: a plugin holding only the five skills and the block text. No hooks, no monitor, no script. The test arms are renamed: **full** (the plugin), **layer 1** (that package plus the block), **files** (the record, no CORE text), **nothing**. "Convention" is retired as a word. Both with-CORE arms get the block through `append_system_prompt`. |
| G2 | **Skills work without the script.** Every skill step that calls `core.mjs` says what to do when the script is missing: read `_memories/` with the harness's own search, write one file, move a replaced file to `archive/`. `INDEX.md` is optional. Skills are not gated by the enabled list; only hooks are. The Layer-1 block has no dead-hook line. |
| G3 | **Layer 1 is on trial too.** 7.7 compares layer 1 against files and against Claude Code's built-in memory. If layer 1 does not beat files on the record test, the verdict is "use the kit and the built-ins; do not build CORE". D1's verdict states this. |
| G4 | **The gate is rebuilt.** Five gated cases (adds `recall-paraphrase` and the null case). Full passes only if: at least 3 of 5 gated cases are ahead of layer 1 by one score step or more, the mean gap is at least 0.2, no gated case is behind by more than one step, **and** the record test is not worse. All numbers are frozen in step 0.6 in `evals/GATE.md` with their reason. The first run is never used to set them. |
| G5 | **Eval mechanics fixed.** Template gains `allowed_tools: [Read, Glob, Grep, Skill, Agent]` and `max_turns: 30`; `plugins: ["../.."]`; shared mock at `plugins/core/evals/mocks/tracker/list_issues.md`; the injection case has its own `mocks/` and a scored `mock_calls` check. Two run commands: the normal one grants `Write,Edit,Bash(node *),Bash(mv *)`; the no-write one (for `honesty-no-hooks`, `finalize-counts-from-disk`) grants none. Every run's `error` field is read: an errored run is "not measured", and an arm with 2 or more errored runs of 5 is "not measured". A preflight checks `bwrap` and `socat` on Linux. Dates in fixtures are written by `tests/tools/build-eval-fixtures.mjs` just before each run. Every grader the legend uses is defined, including `focus` and `arm`. |
| G6 | **Enabling in eval runs is proved, not assumed.** Hook commands reference `${CLAUDE_PLUGIN_DATA}` so the folder exists. `isEnabled` creates it before taking its real path and compares against both `os.tmpdir()` and `$TMPDIR`. A `canary` case and a `not_contains: not enabled on this machine` grader on every gated case make a silent fallback fail. In eval runs the machine id comes from the plugin data folder, not the real home. Agent-side commands take `--project` and `--core-dir` from the status block, never from `HOME`. |
| G7 | **The record test is isolated and counts the right things.** Each arm runs under its own temp `CLAUDE_CONFIG_DIR`. Before session 1, a check proves auto memory is on for the built-in arm and off elsewhere. The model is pinned and recorded per run. Five of ten sessions end without "wrap up", so the close pass and catch-up are measured. Junk files, duplicates, and stale copies are counted next to hits. An answer key is written before session 1, and probes are graded against it by a grader that cannot read `_memories/`. Tokens and cost are recorded per arm, helper runs included. A null case (a task where memory does not matter) is added. A 25-turn session with `/compact` at turn 18 is added; if `-p` does not honour `/compact`, that row says "compaction not measured". |
| G8 | **Things can close.** Promises, questions, and risks take `status: done`, `answered`, or `retired`. A closed item leaves the queue. `pulse` proposes archiving it 30 days later. `check --project` warns when `PROJECT.md` names a memory that is archived or replaced. Memories gain an optional `source:` line (file, ticket, or link). |
| G9 | **Handoff notes get read.** The status block shows the newest note's "Resume here" line. Notes are named `summary-YYYYMMDD-HHMM-<machine4>.md`. The block names up to three `soon` items, not just a count. |
| G10 | **The block reaches the model.** Setup writes it near the top of `AGENTS.md`, and of `CLAUDE.md` too when one exists (Codex and Antigravity do not read `CLAUDE.md`). `check --project` warns when the two copies differ. D2 states the floors: Claude Code reads `AGENTS.md` only without `CLAUDE.md` and from 2.1.277; Codex skips `AGENTS.md` in an untrusted project and cuts at 32 KiB. |
| G11 | **Liveness is observed, not assumed.** The status line says "session hook ran", not "hooks ok". The prompt hook always prints one short line (`CORE recall: 0 matches`). The block tells the agent: no such line means recall is off; say so. At session start, if receipts show prompts last session but no prompt-hook receipt, the block says "prompt hook did not run last session". `honesty-no-hooks` gets the block by `append_system_prompt`. |
| G12 | **Refresh helper denylist widened.** Adds `Monitor`, `WebFetch`, `WebSearch`, `Skill`, `SendMessage`, `Agent`, `CronCreate`. The claim becomes "has no tool on today's list that runs a command"; `check --plugin` fails if the helper file lacks any listed name. |
| G13 | **Scheduling made true.** The schedule prompts and the `/loop` suggestion pass `/core:pulse unattended`. Each route states its condition: cloud tasks read pushed commits only; Desktop tasks need the app open and the machine awake; Codex tasks need the ChatGPT app running and are not in the CLI; Antigravity has `/schedule` in-session and Automations. |
| G14 | **The watcher is removed.** It reached the user only at their next message, which the prompt hook already does. This deletes the monitor file, `watch`, its version conditions, and its unverified idle behaviour. FOCUS is delivered at session start, on each prompt, and by scheduled `pulse`. |
| G15 | **Session id and project resolution.** Agent-side commands on Claude Code use `CLAUDE_CODE_SESSION_ID`. A hook's needed input is defined (session id, cwd, event). `--project` wins over stdin `cwd`; tests cover the stdin path. Antigravity `PreInvocation` dedups on a hash of trajectory id plus turn count, not prompt text, and checks every `workspacePaths` entry. |
| G16 | **Receipts last long enough and never race.** Files are `receipts-<harness>-YYYY-MM.jsonl`, appended only, deleted whole after 120 days. A 90-day archive proposal needs 90 days of receipts; otherwise it says "not measured yet" (a fresh clone proposes nothing for 90 days, stated). |
| G17 | **Forks are caught.** `check --project` fails when two live memories replace the same target, and asks the user which wins. |
| G18 | **Catch-up proposes, never writes.** The catch-up helper's output goes to `_core/inbox.md` (not committed). The next session start offers it. Nothing reaches `_memories/` without the agent's normal write path. |
| G19 | **Gold set made meaningful.** 60 queries over a 300-memory synthetic store; 20 held out, written by a separate fresh agent before thresholds are set. Scores are reported by kind only where a kind has 10 or more queries. |
| G20 | **Native-first table covers everything built.** Rows added for the five skills, three hook files, the block, the fixtures, and the receipts. `verify` is dropped: `finalize` uses `git status --porcelain` and says "not measured" outside Git. The `index` row is corrected (auto memory keeps an index for its own store, not a committed per-project one). Dates: the script computes them; the scheduled path runs the script through `pulse`. |
| G21 | **Ladder gets an OS column.** Per capability, per OS, including Antigravity's terminal sandbox, which hides the plugin folder and `~/.core` from agent-side commands on macOS and Linux. Under that sandbox agent-side commands drop to Layer 1 behaviour, and the status block says so. |
| G22 | **D1 for a cold reader.** One verdict line, used on the first screen and in §8. "Arm" defined where first used. The kill test is a short numbered list with its numbers. Claude Code Projects scored as a competitor. "Partial" defined in a one-line legend. Penfield named as a vendor. The fifth defect cites its reproduction. "Enabled" defined at first use. |
| G23 | **D4 stands alone.** The fix-code tables for both rounds and every rebuttal's reason are in D4. Part 1 is ranked, top three marked. Headline counts reconcile. Undefined terms removed. |
| G24 | **Executor mechanics.** 0.1 copies the four plan files and the evidence into `docs/plan/` on `v4` and names the source branch. 0.3's Accept can fail. Tests are listed with `find`, so Node 20 works. `ci.yml` adds `v4` and `pull_request`; the two kept steps are `continue-on-error` until 3.5 and 4.3; Accept is "passes except steps flagged in `docs/build-log.md`". After the rebase onto `next`, delete the nine v3 test files it adds. The `sk-` pattern needs a left boundary. 5.2 gets an offline Accept; the prose check moves to 7.6 with a v4 fixture. 7.2 uses `runSelftest({ instruments })`, injection not monkey-patching. `selftest` uses a temp core dir. `cli-entry.mjs` is ported, not moved. 3.3 and 3.4 come after 4.1's queue. Step labels and `expects` lines corrected. |
| G25 | **Every step has "If it fails".** The 21 missing ones are written, specific where the general rule does not fit (4.5, 5.3, 9.x). |
| G26 | **Text fixes.** Listed per finding below. |
| G27 | **Layer 1 travels with the repo for Codex and Antigravity.** Setup offers to commit one copy of the five skills to `.agents/skills/`, stamped with CORE's version. Codex and Antigravity read that folder; Claude Code gets the skills from the plugin. `check --project` warns when the stamp is older than the installed CORE. The block gains one line carrying the write test. The rung table's "Files only" row names the full loss. Known cost: on Codex or Antigravity with the plugin also installed, the same skill text is listed twice. |

## Dispositions

| ID | Sev | Decision | Fix / reason |
|---|---|---|---|
| R2-RD-01 | maj | Accepted | G22 — one verdict line |
| R2-RD-02 | maj | Accepted | G1 — arms renamed; "the kit" used for one thing only |
| R2-RD-03 | maj | Accepted | G22 — kill test as numbered list; "arm" defined |
| R2-RD-04 | maj | Accepted | G7, G22 — the built-in arm named in D1 |
| R2-RD-05 | maj | Accepted | G14 — watcher removed |
| R2-RD-06 | maj | Accepted | G14 — only `core` handles the new-item line |
| R2-RD-07 | maj | Accepted | G5 — legend defines every grader word |
| R2-RD-08 | maj | Accepted | G23 |
| R2-RD-09 | maj | Accepted | G23 |
| R2-RD-10 | min | Accepted | G23 — ranked Part 1, reconciled counts |
| R2-RD-11 | min | Accepted | G23 — undefined terms removed |
| R2-RD-12 | min | Accepted | G26 — `unmeasured` keys renamed `unknown` |
| R2-RD-13 | min | Accepted | G26 — D2 §4 keeps only the "How" column and points at D1 |
| R2-RD-14 | min | Accepted | G26 — Basis reads "Estimate; measured in 7.6" |
| R2-RD-15 | min | Accepted | G26 — D2's clean quote used in D1 |
| R2-RD-16 | min | Accepted | G26 — v3 in the summary |
| R2-RD-17 | min | Accepted | G26 — rule 6 states "in enabled projects" |
| R2-RD-18 | min | Accepted | G22 — "enabled" defined at first use |
| R2-RD-19 | taste | Accepted | G26 — heading "Four days with CORE"; days named |
| R2-PA-01 | crit | Accepted | G1 |
| R2-PA-02 | crit | Accepted | G4 |
| R2-PA-03 | crit | Accepted | G4 — AND, not OR; G1 — the layer 1 arm has `remember` too |
| R2-PA-04 | crit | Accepted | G2 |
| R2-PA-05 | maj | Accepted (rebuttal withdrawn) | G27 — see below |
| R2-PA-06 | maj | Accepted | G3 |
| R2-PA-07 | maj | Accepted | G7 |
| R2-PA-08 | maj | Accepted | G22 — Projects scored |
| R2-PA-09 | maj | Accepted | G20 |
| R2-PA-10 | maj | Accepted | G14 |
| R2-PA-11 | maj | Accepted | G4 — `recall-paraphrase` gated |
| R2-PA-12 | maj | Accepted | G7 — 25-turn compaction session; D1 says a fail on short runs "shelves" Layer 2 on a branch, not deletes |
| R2-GA-01 | crit | Accepted | G1 |
| R2-GA-02 | crit | Accepted | G2 |
| R2-GA-03 | crit | Accepted | G10 |
| R2-GA-04 | crit | Accepted | G11 |
| R2-GA-05 | maj | Accepted | G13 |
| R2-GA-06 | maj | Accepted | G13 |
| R2-GA-07 | maj | Accepted | G21 |
| R2-GA-08 | maj | Accepted | G20 |
| R2-GA-09 | maj | Accepted | G9 |
| R2-GA-10 | maj | Accepted | G6 |
| R2-GA-11 | maj | Accepted | G6 |
| R2-GA-12 | maj | Accepted | G23 |
| R2-GA-13 | min | Accepted | G25 |
| R2-GA-14 | min | Accepted | G26 — dependency table adds the version floors and helper agents |
| R2-GA-15 | min | Accepted | G22 — "Partial" legend |
| R2-PR-01 | crit | Accepted | G1 |
| R2-PR-02 | crit | Accepted | G7 |
| R2-PR-03 | maj | Accepted | G4; fixture adds 255 distractors with shared words |
| R2-PR-04 | maj | Accepted | G4 |
| R2-PR-05 | maj | Accepted | G7 |
| R2-PR-06 | maj | Accepted | G7 |
| R2-PR-07 | maj | Accepted | G18 |
| R2-PR-08 | maj | Accepted | G7 |
| R2-PR-09 | maj | Accepted | G8 |
| R2-PR-10 | maj | Accepted | G26 — 4-hour window in the basis table ("one reminder per working block; a guess, tuned by `metrics`"); dates shown as weekday + date |
| R2-PR-11 | maj | Accepted | G16 |
| R2-PR-12 | maj | Accepted | G8; D4 Q9 rewritten |
| R2-PR-13 | maj | Accepted | G19 |
| R2-PR-14 | maj | Accepted | G17 |
| R2-PR-15 | maj | Accepted | G9 names; G17 |
| R2-PR-16 | maj | Accepted | G16 |
| R2-PR-17 | maj | Accepted | G9 |
| R2-PR-18 | maj | Accepted | G8 |
| R2-PR-19 | maj | Accepted | G26 — D2 states the overlap; setup offers `autoMemoryEnabled: false` for the project, default no; 7.7 counts duplicates across both |
| R2-PR-20 | maj | Accepted | G7 — answer key and blind grader |
| R2-PR-21 | min | Accepted | G26 — in a folder with `_memories/` that is not enabled, the session hook says one line once per project per machine |
| R2-PR-22 | min | Accepted | G7 |
| R2-PR-23 | min | Accepted | G8 — `source:` |
| R2-HA-01 | crit | Accepted | G5 |
| R2-HA-02 | crit | Accepted | G12 |
| R2-HA-03 | maj | Accepted | G10 |
| R2-HA-04 | maj | Accepted | G11 |
| R2-HA-05 | maj | Accepted | G21 |
| R2-HA-06 | maj | Accepted | G6 |
| R2-HA-07 | maj | Accepted | G6 |
| R2-HA-08 | maj | Accepted | G14 — no monitor |
| R2-HA-09 | maj | Accepted | G14 — no monitor |
| R2-HA-10 | maj | Accepted | G15 |
| R2-HA-11 | maj | Accepted | G13 |
| R2-HA-12 | maj | Accepted | G13 |
| R2-HA-13 | min | Accepted | G15 |
| R2-HA-14 | min | Accepted | G26 — prompts from `/loop`, subagents, and other sessions counted as user prompts; metrics note says so |
| R2-HA-15 | min | Accepted | G26 — `HOME` reason restated as CORE 3's threat model; current Claude Code drops `HOME` from project settings |
| R2-FC-01 | crit | Accepted | G5 |
| R2-FC-02 | crit | Accepted | G5 |
| R2-FC-03 | maj | Accepted | G5 — two run commands |
| R2-FC-04 | maj | Accepted | G12 |
| R2-FC-05 | maj | Accepted | G6 |
| R2-FC-06 | maj | Accepted | G6 |
| R2-FC-07 | maj | Accepted | G7 |
| R2-FC-08 | maj | Accepted | G5 — the v3 comparison runs at `max_turns: 60` |
| R2-FC-09 | maj | Accepted | G13 |
| R2-FC-10 | min | Accepted | G22 |
| R2-FC-11 | min | Accepted | G22 |
| R2-FC-12 | min | Accepted | G26 — score granularity stated per case |
| R2-FC-13 | min | Accepted | G26 — each listed tag repointed |
| R2-FC-14 | min | Accepted | G26 |
| R2-EX-01 | crit | Accepted | G5 |
| R2-EX-02 | crit | Accepted | G5 |
| R2-EX-03 | crit | Accepted | G24 |
| R2-EX-04 | maj | Accepted | G24 |
| R2-EX-05 | maj | Accepted | G24 |
| R2-EX-06 | maj | Accepted | G24 |
| R2-EX-07 | maj | Accepted | G24 |
| R2-EX-08 | maj | Accepted | G24 |
| R2-EX-09 | maj | Accepted | G24 |
| R2-EX-10 | maj | Accepted | G26 — prose count covers every shipped `.md` and hook file |
| R2-EX-11 | maj | Accepted | G24 |
| R2-EX-12 | maj | Accepted | G24 |
| R2-EX-13 | maj | Accepted | G5 |
| R2-EX-14 | maj | Accepted | G5 |
| R2-EX-15 | maj | Accepted | G6 |
| R2-EX-16 | maj | Accepted | G9 |
| R2-EX-17 | maj | Accepted | G5 — the three remaining graders rewritten |
| R2-EX-18 | maj | Accepted | G5 |
| R2-EX-19 | maj | Accepted | G6 |
| R2-EX-20 | maj | Accepted | G5 |
| R2-EX-21 | maj | Accepted | G15 |
| R2-EX-22 | maj | Accepted | G24 |
| R2-EX-23 | maj | Accepted | G24 |
| R2-EX-24 | maj | Accepted | G24 |
| R2-EX-25 | min | Accepted | G24 |
| R2-EX-26 | min | Accepted | G19 |
| R2-EX-27 | min | Accepted | G15; watcher gone; `check` takes `--harness` |
| R2-EX-28 | min | Accepted | G15 |
| R2-EX-29 | min | Accepted | G5 — `Bash(mv *)` granted |
| R2-EX-30 | min | Accepted | G11 |
| R2-EX-31 | min | Accepted | G4 — D2 states the same gate as D3 |

## Partial rebuttals

### R2-PA-05 — ship Layer 1 as committed repo skills

**Agreed:** without the plugin, the floor is three lines. D1 and D2 understate that loss, and cloud sessions are where it bites.

**Not agreed:** copying the five skills into every repository. It makes two copies per repo (`.agents/skills/` and `.claude/skills/`), on every repo, and nothing updates them when CORE changes. Symlinks need developer mode on Windows. On Claude Code the agent would see both the plugin's `core:remember` and the repo's `remember`, two write rules that can disagree. Requirement 4 asks for less, not a copy per project.

**Done instead:** (1) The rung table's "Files only" row names the full loss: no write rule, no replace rule, no close. (2) The block gains one line carrying the write test, so even the floor has a write rule. (3) On Claude Code, setup offers to add CORE to the project's `.claude/settings.json` through the native plugin settings, so cloud sessions on that repo install it. This is marked unverified until step 8.2. (4) Skills no longer need the enabled list (G2), so a cloud session with the plugin gets Layer 1 in full.

## Responses to the partial rebuttals

| ID | Reviewer response |
|---|---|
| R2-PA-05 | **Disputed.** Claude Code Projects docs list "Plugins enabled in `.claude/settings.json`" as "Not loaded" in cloud threads, so fix (3) fails where the loss bites; and it does nothing for Codex or Antigravity. Proposed one copy in `.agents/skills/` only, version-stamped. **Outcome:** the evidence is decisive on fix (3) and the narrower copy answers the drift and conflict objections. Rebuttal withdrawn; finding accepted as G27. No judge needed. |
