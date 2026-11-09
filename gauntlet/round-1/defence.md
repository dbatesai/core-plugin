# Round 1 — defence

Seven reviewers, each a fresh agent given only the file paths and `reviewer-brief.md`. 146 findings: **critical 14 · major 81 · minor 50 · taste 1**.

**Status line:** Round 1 — 146 findings, 141 accepted, 5 rebutted in part (one partial rebuttal was disputed and overturned by the judge; none rejected outright).

Every accepted finding maps to one of the fixes below. The fix list is what v2 implements.

## The fixes

| Code | Fix applied in v2 |
|---|---|
| **F1** | Every hook call that reaches a CORE project writes one receipt, including "ran, matched nothing" (`hits: 0`). Receipts rotate (30 days, pruned at session start). `metrics` reports the age of the newest receipt and flags "no receipts since <time>" when a session has a start row and no prompt rows. Prompt rows log the ids they pointed to. |
| **F2** | Selftest plants a **positive** known answer for every instrument (recall must return a planted active memory, and must not return the retired one), and each instrument's planted item is listed explicitly. |
| **F3** | The dead-hook warning no longer rests on the skill description staying in context. The `AGENTS.md` block becomes part of the standard install, and its last line says: "If no line starting with `CORE:` appeared at the start of this session, tell the user CORE's hooks are not running." Where neither the hook nor the block runs, the plan says plainly that a dead CORE is silent. |
| **F4** | No harness tells CORE whether a person is present. The rule is narrowed to what can be enforced: runs CORE itself schedules carry the word `unattended` as the skill argument, and in those runs CORE writes proposals only. Other headless runs are treated as the user's own. Count-from-disk still catches claimed-but-skipped writes. |
| **F5** | Cloud sessions move to the files-only rung: plugins may not load there, and a fresh machine has an empty enabled list. "Tell me what's due while my laptop is closed" uses the harnesses' own schedulers — Claude Code cloud and Desktop scheduled tasks, Codex app scheduled tasks, Antigravity Automations — with a short documented prompt that reads the record. No CORE code. |
| **F6** | Eval redesign. (a) A **convention arm**: the files plus the `AGENTS.md` block, no plugin — the honest runner-up. (b) The gate is plugin vs convention on cases the convention could win; `brief-budget` is reported, not gated. (c) Write cases include an unlabeled mid-task decision. (d) Cases grant `Bash(node *)` so skills can run the script. (e) Eval runs are enabled without writing the real home: `EVAL_CORE_ENABLE=1` is honored only when both the project and the plugin data folder sit inside the OS temp folder. (f) A tiny test-only plugin declares the `tracker` MCP server so its mocks load. (g) `--trust-plugin`, `--no-publish`, results outside the plugin folder, an exact `case.yaml` template, the fixture path fixed (two levels up), secret and injection graders rewritten to check tool inputs, five runs per arm on gated cases, the watcher marked "not measurable by the eval runner". (h) Step 0.6 measures the plain and convention arms with the same tool grants as the full suite. (i) The v3 comparison copies the cases into the v3 worktree, skips CORE 4's enable step there, and records "not measured" if v3 cannot start. |
| **F7** | Archiving is a proposal, never automatic. Never proposed: decisions in force, principles, premises, people, open risks, open questions. A candidate must be unchanged (`updated` field) **and** not pointed to by any prompt receipt for 90 days. The user approves the list. |
| **F8** | Recall is tuned and measured on a real gold set: 30 queries over the fixture stores (10 literal, 10 paraphrase, 10 negative), 20 for tuning and 10 held out; precision and recall at 3 are reported. `pointer_rate` replaces `recall_rate` and is described as "how often a pointer was offered", not correctness. |
| **F9** | D4 Part 1 rewritten against the actual plan (step 0.6 exists; `/schedule` is offered). |
| **F10** | D3 mechanics: use the existing `v3.20.1` tag (it peels to `79b526b`); `node --test` with a file glob; port `bm25` and frontmatter parsing freshly instead of moving files with dead imports; create folders before moving; `finish()` takes `expects` per command; warnings ride inside `ok`; every step labeled `[agent]`, `[paid]`, `[human]`, or `[live install]`; every step has "If it fails"; Phase 9 deliverable line; branch from `main`, rebase on `next` before the pull request; Codex manifest `interface` fields rewritten; `migrate` archives units whose `t_invalid` is past. |
| **F11** | Two layers. **Layer 1, the convention:** the file layout, five skills, and the `AGENTS.md` block — works on every harness with no script. **Layer 2, the wiring:** hooks, watcher, and `core.mjs` — kept only while it beats Layer 1 in the gate. Requirement 4's "justify every script" is answered by a table: each command, why prose cannot do it, why the harness cannot. |
| **F12** | Readability: rungs get names (Full, Hooked, Skills only, Files only, None); eval arms get names (plugin, convention, files, nothing); the five jobs defined on first use; "trust" split into **enabled** (projects), `said_by` (memories), `origin` (sources); one line maps ok/fail/unknown to working/broken/not measured; grader types defined; "+0.3" given its scale; the watcher story made explicit; numbers made consistent; tag legend fixed; verdict re-led; tables trimmed. |
| **F13** | Factual corrections as listed per finding. |
| **F14** | `env` never borrows another session's receipt: without a session id the hook rows are `unknown`, with the newest receipts listed as evidence. Node is checked from the hook's side (the version is logged in the session-start receipt). Watcher rows count as announcements. Codex live check starts a fresh session after approving hooks. |
| **F15** | Security: the catch-up reads a transcript path only from this machine's own receipts file and only if it ends in `.jsonl`; an un-enabled project gets no receipt and no `_core/`; the security table lists every program the script spawns; the refresh helper uses `disallowedTools: Bash, PowerShell, Edit` so it keeps MCP but has no shell; people notes stay factual. |
| **F16** | Git hygiene: `INDEX.md` is git-ignored and rebuilt locally; memory ids use the date (`dc-20261109-retry-header-v3`), not a counter; the index signature normalizes line endings. |

## Dispositions

Severity as the reviewer gave it. "Accepted" means the fix is in v2. Every row was decided by the drafting agent; partial rebuttals were sent back to their reviewers (see below).

### Executor (D3)

| ID | Sev | Decision | Fix / reason |
|---|---|---|---|
| R1-EX-01 | crit | Accepted | F10 — use the existing tag; accept either commit in the check |
| R1-EX-02 | maj | Accepted | F10 — file glob |
| R1-EX-03 | maj | Accepted | F10 — port, do not move |
| R1-EX-04 | maj | Accepted | F10 — new parser handles `edges` |
| R1-EX-05 | min | Accepted | F10 |
| R1-EX-06 | maj | Accepted | F10 — step 0.4 split and clarified |
| R1-EX-07 | crit | Accepted | F1 |
| R1-EX-08 | maj | Accepted | F10 — `expects` per command |
| R1-EX-09 | maj | Accepted | F10 — the three commands named and exempted |
| R1-EX-10 | maj | Accepted | F10 — prose steps say their test runs in 7.6; rule 9 scoped to code |
| R1-EX-11 | maj | Accepted | F6h |
| R1-EX-12 | maj | Accepted | F6d |
| R1-EX-13 | maj | Accepted | F6e |
| R1-EX-14 | maj | Accepted | F6g |
| R1-EX-15 | maj | Accepted | F6g |
| R1-EX-16 | crit | Accepted | F6i |
| R1-EX-17 | maj | Accepted | F2 |
| R1-EX-18 | maj | Accepted | Budget split: skill listing via `plugin details`; injected bytes measured by test |
| R1-EX-19 | maj | Accepted | F4 |
| R1-EX-20 | maj | Accepted | F10 |
| R1-EX-21 | maj | Accepted | F8 |
| R1-EX-22 | maj | Accepted | F10 — step labels |
| R1-EX-23 | min | Accepted | Wrapper `tests/tools/prose-check.mjs` |
| R1-EX-24 | min | Accepted | Two-way check scoped to skills, hooks, monitors |
| R1-EX-25 | min | Accepted | F6g |
| R1-EX-26 | min | Accepted | F15 |
| R1-EX-27 | min | Accepted | F13 — 34, one regex |
| R1-EX-28 | min | Accepted | F10 |
| R1-EX-29 | min | Accepted | F10 |
| R1-EX-30 | min | Accepted | F10 |
| R1-EX-31 | min | Accepted | F10 |
| R1-EX-32 | min | Accepted | Every blind case ends with the sentence; `blind.mjs` strips memory ids |
| R1-EX-33 | min | Accepted | F6g |

### Fact-checker

| ID | Sev | Decision | Fix / reason |
|---|---|---|---|
| R1-FC-01 | crit | Accepted | F3 |
| R1-FC-02 | maj | Accepted | F6g — watcher not measurable in eval; measured only in the live check |
| R1-FC-03 | maj | Accepted | F6d, F6e |
| R1-FC-04 | maj | Accepted | F13 — the CORE 3 test was the automatic close, which never calls a model |
| R1-FC-05 | maj | Accepted | F5 |
| R1-FC-06 | maj | Accepted | D3 step 9.4 walks the 29-item keep list and records each as kept, replaced, or dropped |
| R1-FC-07 | min | Accepted | F13 — Google's sample uses a root manifest and ships no hooks |
| R1-FC-08 | min | Accepted | F13 — "changed often", with changelog dates |
| R1-FC-09 | min | Accepted | Hedge restored: plugin hooks in the App and IDE are implied, not stated |
| R1-FC-10 | min | Accepted | Hedges restored |
| R1-FC-11 | min | Accepted | Pointer-vs-body argument rests on safety, not on the Chroma study |
| R1-FC-12 | min | Accepted | F13 |
| R1-FC-13 | min | Accepted | F13 |
| R1-FC-14 | min | Accepted | F13 |
| R1-FC-15 | min | Accepted | F13 |
| R1-FC-16 | min | Accepted | F13 |
| R1-FC-17 | min | Accepted | F13 — four new fields, `owner` among them |
| R1-FC-18 | min | Accepted | F13 — `claude plugin eval` is generally available |
| R1-FC-19 | min | Accepted | as R1-EX-32 |
| R1-FC-20 | min | Accepted | F6g |

### Gap auditor

| ID | Sev | Decision | Fix / reason |
|---|---|---|---|
| R1-GA-01 | crit | Accepted | F1 |
| R1-GA-02 | crit | Accepted | F2 |
| R1-GA-03 | maj | Accepted | F3 |
| R1-GA-04 | maj | Accepted | F5 |
| R1-GA-05 | maj | Accepted | F1 |
| R1-GA-06 | maj | Accepted | F4 |
| R1-GA-07 | maj | Accepted | F6e |
| R1-GA-08 | maj | Accepted | F6f |
| R1-GA-09 | maj | Accepted | F6h |
| R1-GA-10 | maj | Accepted | F10 |
| R1-GA-11 | maj | Accepted | F11 — justification table |
| R1-GA-12 | maj | Accepted | F11 — same table answers "does the harness do it" per built thing |
| R1-GA-13 | maj | Accepted | Ladder gains OS notes per capability |
| R1-GA-14 | maj | Accepted | F16 |
| R1-GA-15 | maj | Accepted | F15 |
| R1-GA-16 | maj | Accepted | D1 table scores CORE 4 Remember as "instructions + close pass" |
| R1-GA-17 | maj | Accepted | F5 |
| R1-GA-18 | maj | Accepted | F6c |
| R1-GA-19 | maj | Accepted | Verdict states the gate is measured on Claude Code only |
| R1-GA-20 | min | Accepted | Snoozes for non-memory items live in `_core/snooze.json` |
| R1-GA-21 | min | Accepted | F10 |
| R1-GA-22 | min | Accepted | Runner-up row added to D1 §6 |
| R1-GA-23 | min | Accepted | F14 |
| R1-GA-24 | min | Accepted | F15 |
| R1-GA-25 | min | **Accepted in part** | See partial rebuttals |
| R1-GA-26 | min | Accepted | F12 |
| R1-GA-27 | min | Accepted | Ledger gains judge column and stop condition |

### Harness auditor

| ID | Sev | Decision | Fix / reason |
|---|---|---|---|
| R1-HA-01 | crit | Accepted | F1 |
| R1-HA-02 | crit | Accepted | F14 |
| R1-HA-03 | crit | Accepted | F15 — `disallowedTools` keeps MCP; docs: "inherit the subagent's tool pool except…" |
| R1-HA-04 | crit | Accepted | F4 |
| R1-HA-05 | maj | Accepted | F3 |
| R1-HA-06 | maj | Accepted | Hooks are exempt from the result line; their tests check exit 0 and the receipt |
| R1-HA-07 | maj | Accepted | F5 |
| R1-HA-08 | maj | Accepted | F6d |
| R1-HA-09 | maj | Accepted | F6g |
| R1-HA-10 | maj | Accepted | F6g |
| R1-HA-11 | maj | Accepted | Ladder: watcher on Windows may need Git Bash; unverified |
| R1-HA-12 | maj | Accepted | F14 |
| R1-HA-13 | maj | Accepted | Named limitation: on Codex with the Windows elevated sandbox, enabling a project needs one command run outside the sandbox |
| R1-HA-14 | maj | Accepted | F3 — Files-only says it through the `AGENTS.md` block; None says nothing, stated plainly |
| R1-HA-15 | min | Accepted | F6f |
| R1-HA-16 | min | Accepted | Antigravity "new item" line sent as `systemMessage` |
| R1-HA-17 | min | Accepted | F14 |
| R1-HA-18 | min | Accepted | F6e |
| R1-HA-19 | min | Accepted | F14 |

### Practitioner

| ID | Sev | Decision | Fix / reason |
|---|---|---|---|
| R1-PR-01 | crit | Accepted | F6a, F6b |
| R1-PR-02 | crit | Accepted | F7 |
| R1-PR-03 | maj | Accepted | F6a; built-in auto memory stated as not measured |
| R1-PR-04 | maj | Accepted | F6g; gate described as directional, per-case spread reported |
| R1-PR-05 | maj | Accepted | F6c |
| R1-PR-06 | maj | Accepted | Catch-up only for a session idle 2 hours with 3 or more prompts; `no-handoff` is `soon`; tail read bounded by bytes |
| R1-PR-07 | maj | Accepted | `check --project` adds `two-live` (a replaced memory still active) and a near-duplicate warning |
| R1-PR-08 | maj | Accepted | F8 |
| R1-PR-09 | maj | Accepted | Token figure includes the `core` skill body |
| R1-PR-10 | maj | Accepted | An item announced in the last 4 hours on this machine is counted, not repeated; snoozes counted in `metrics` |
| R1-PR-11 | maj | Accepted | F16 |
| R1-PR-12 | maj | Accepted | `core` skill handles "set up CORE here" |
| R1-PR-13 | maj | **Accepted in part** | See partial rebuttals |
| R1-PR-14 | maj | Accepted | Division of labour: project facts in the record, personal preferences in auto memory; the skill says so |
| R1-PR-15 | maj | Accepted | F1 |
| R1-PR-16 | min | Accepted | F9 |
| R1-PR-17 | min | Accepted | F6e |

### Premise attacker

| ID | Sev | Decision | Fix / reason |
|---|---|---|---|
| R1-PA-01 | crit | Accepted | F6a, F11 |
| R1-PA-02 | crit | Accepted | F6b |
| R1-PA-03 | maj | **Accepted after judge ruling** | Rebuttal disputed; judge upheld the finding (`judge-PA-03.md`). Fix: D3 step 7.7, a scripted multi-session record test feeding the gate |
| R1-PA-04 | maj | Accepted | F11 |
| R1-PA-05 | maj | Accepted | The study is applied to both; the arms measure it |
| R1-PA-06 | maj | Accepted | F5 |
| R1-PA-07 | maj | Accepted | F5 |
| R1-PA-08 | maj | Accepted | Runner-up row added |
| R1-PA-09 | maj | Accepted | F11 |
| R1-PA-10 | maj | **Accepted in part** | See partial rebuttals |
| R1-PA-11 | maj | Accepted | F13 |

### Reader

| ID | Sev | Decision | Fix / reason |
|---|---|---|---|
| R1-RD-01 | maj | **Accepted in part** | See partial rebuttals |
| R1-RD-02 | maj | Accepted | F12 |
| R1-RD-03 | maj | Accepted | F12 |
| R1-RD-04 | maj | Accepted | F12 |
| R1-RD-05 | maj | Accepted | F12 |
| R1-RD-06 | maj | Accepted | F12 |
| R1-RD-07 | maj | Accepted | F9 |
| R1-RD-08 | maj | Accepted | F12 |
| R1-RD-09 | maj | Accepted | F12 |
| R1-RD-10 | min | Accepted | F13 |
| R1-RD-11 | min | Accepted | F12 |
| R1-RD-12 | min | Accepted | F12 |
| R1-RD-13 | min | Accepted | F12 |
| R1-RD-14 | min | Accepted | Contract A's rules renamed "result rules 1–3" |
| R1-RD-15 | min | Accepted | F10 |
| R1-RD-16 | min | Accepted | F12 — one ladder table |
| R1-RD-17 | min | Accepted | Session story fixed |
| R1-RD-18 | min | Accepted | F12 |
| R1-RD-19 | taste | **Accepted in part** | See partial rebuttals |

## Partial rebuttals

Each was sent to the reviewer who raised it. A dispute goes to a fresh judge.

| ID | What is accepted | What is rebutted, and why |
|---|---|---|
| R1-PA-03 *(overturned)* | The gated cases start from a hand-written record, so they measure recall from a record, not the quality of a record built over months. That limit is now stated in D1 and D2. | Adding a multi-session write-quality test to the eval suite is rebutted: the runner executes one session per case, so a months-long record cannot be grown inside it. The on-project blind check (D2) is the measure for that, and is labeled "a direction, not a score". |
| R1-PA-10 | The verdict now carries a cost test: if the wiring needs its line budget raised, or fails the gate, Layer 2 is dropped. | A measured maintenance-hours test is rebutted: nothing in the plan can observe the owner's time. The line budget, enforced by `check --plugin`, is the cost control that can be measured. |
| R1-PR-13 | The `remember` skill now forbids opinions about people and says to record what someone committed to, not what they are like. Enabling a project tells the user once that `_memories/` is meant to be committed and holds what they say about people. | A separate git-ignored private-memory folder is rebutted: it is a second store with its own rules, which the plan exists to avoid. CORE never runs `git add`; whether to commit `_memories/` stays the user's call. |
| R1-GA-25 | `check --plugin` cannot find contradictions between instruction files. The plan now says so, names `/doctor prompt-audit` on Claude Code, and states "not measured" on Codex and Antigravity. | Building a contradiction finder into CORE is rebutted: it needs a model call, and the harness's own audit does it on one harness already. |
| R1-RD-01 | Rungs and eval arms get names instead of letters. | D3's contract letters stay: D3 is for an executing agent, the letters are defined once in a table of contents, and every use now reads "contract A", never a bare letter. |
| R1-RD-19 | Each document's first screen now lists its sections. | Moving term definitions above the summary is rebutted: the summary must come first for a skimming reader, and each term is defined in the sentence where it first matters. |

## Responses to the partial rebuttals

| ID | Reviewer's reply | Judge | Outcome |
|---|---|---|---|
| R1-PA-03 | DISPUTE — asked for ~10 scripted sessions per arm outside the runner, not a months-long test inside it | Fresh judge: **finding upheld** | Accepted in full; D3 step 7.7 added |
| R1-PA-10 | ACCEPT | — | Rebuttal stands |
| R1-PR-13 | ACCEPT | — | Rebuttal stands |
| R1-GA-25 | ACCEPT (notes voice drift is unchecked on any harness; not disputed) | — | Rebuttal stands |
| R1-RD-01 | ACCEPT | — | Rebuttal stands |
| R1-RD-19 | ACCEPT | — | Rebuttal stands |
