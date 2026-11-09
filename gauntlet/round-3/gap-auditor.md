# Round 3 — Gap auditor

Reviewed: `gauntlet/v3-d1.md`, `v3-d2.md`, `v3-d3.md`, `v3-d4.md` against `gauntlet/contract.md` and `gauntlet/reviewer-brief.md`. Before writing I read the reviewer files in `round-1/` and `round-2/` (not `defence.md`) and the D4 Part 3 ledger and fix codes G1–G27. Nothing below repeats an earlier finding. Where a round-2 fix is broken or incomplete, the finding cites the earlier ID and fix code.

One local command was run, in the scratchpad, to check how `git status --porcelain` counts (R3-GA-03).

## Coverage

| Item | Verdict | Findings |
|---|---|---|
| R1 Native across harnesses and OSes | Delivered on paper (D2 §5 OS table) | — |
| R2 Native-first, per thing built | Partial: the eval fixture scripts and test tools have no row | GA-15 |
| R3 Ladder-down, no silent rung | Delivered for hooks; the out-of-session rung can still be silent | GA-08 |
| R4 Minimal | Partial: 42 shell scripts ship inside the plugin, outside every budget | GA-15 |
| R5 Measurement in the first phase | On paper: the test that can cancel CORE runs after Layer 2 is built | GA-12 |
| R6 Security: read, write, run, untrusted, unattended | Partial: the write table, the unattended rule, and the "never run project content" rule are each false somewhere | GA-05, GA-06, GA-07 |
| R7 Metrics plus blind comparison | Partial: the layer 1 arm cannot be measured, and "not measured" ships | GA-01, GA-02, GA-10, GA-11 |
| R8 Self-audit, incl. instruments reading nothing | Partial: two instruments report success or closure over nothing | GA-03, GA-04, GA-13 |
| R9 Voice | Delivered | — |
| Defect class killed | No: five places where "could not measure" or "did nothing" reads as fine | GA-01, GA-03, GA-04, GA-08, GA-09 |
| G1–G27 carried out | Mostly. Broken or incomplete: G3, G7, G11, G13, G18, G19, G20, G27; D4's own descriptions of G4, G10, G11 do not match v3 | GA-02, GA-04–GA-07, GA-10–GA-15 |

---

## Findings

### R3-GA-01  —  critical
- **Artifact:** D3 (and D1)
- **Location:** D3 9.4, "The verdict": four branches only — "Layer 1 fails", "Built-in beats layer 1", "Layer 2 fails", "All met". GATE.md (0.6): "An arm with 2 or more such runs … is 'not measured' there; then the gate is 'not measured'." D3 9.5: the pull request "lists: the verdict; gates met; gates not measured". D1 short version and §8: "Its five skills must beat plain files, and its code must beat the skills, or that part does not ship."
- **What is wrong:** The verdict has no branch for a gate that is "not measured". Only "fails" removes a layer: "Layer 2 fails → … replace `plugins/core/` with `dist/core-layer1/`". A gate that could not be measured matches none of the four branches, so nothing is removed, and 9.5 opens the pull request with both layers and a line listing "gates not measured". D1 says the opposite: a layer ships only if it *beats* the one below. D4 Part 1 item 1 says a builder without a paid account reports "not measured" for every result that decides whether CORE should exist. Under D3 that builder ships everything. Step 9.4 also has no **Accept** line, the only step in D3 without one, so nothing checks that a verdict was written before 9.5 runs.
- **What breaks if we ship it as-is:** The defect class at the top level. "We could not measure whether Layer 2 helps" ends in the same release as "Layer 2 helps". 1,800 lines of hooks and script ship unproven, which is exactly what the kill test exists to stop.
- **Suggested fix:** Add a fifth branch: any keep-rule "not measured" → that layer is treated as not kept (Layer 2 shelved, or stop before 9.5 for Layer 1), and a person decides. Give 9.4 an Accept: `docs/build-log.md` holds one verdict line naming each GATE.md rule as met, not met, or not measured.
- **Evidence:** `v3-d3.md:537` (not-measured rule), `:1264–1271` (verdict branches), `:1277` (9.5 description); awk over D3 step headings: 9.4 is the only step with `Accept` count 0; `v3-d1.md:15`, `:206`; `v3-d4.md:21`.

### R3-GA-02  —  critical
- **Artifact:** D3
- **Location:** D3 7.5: `package-layer1.mjs` copies "`evals/`, with that line dropped from every appended block". D3 7.6, case `canary`: "`regex` on `trace`: `CORE: session hook ran` (`arm: with-only`). Any failed run → every with-plugin score in that results file is 'not measured: enabling failed'." Run 3: `claude plugin eval dist/core-layer1 … --ablation none`. Accept: "`canary` passed in every run".
- **What is wrong:** This is the G1 fix colliding with the G6 fix. The layer 1 package has no hooks by design, so nothing ever prints `CORE: session hook ran`. `canary` is copied into it, fails in every run, and by its own rule voids every with-plugin score in `results-layer1.json`. With `--ablation none`, every score in that file is a with-plugin score. So the layer 1 arm is "not measured" on every gated case, every time, and the 7.6 Accept ("canary passed in every run") can never pass. If an executor drops `canary` from the layer 1 run to get past this, nothing else proves the layer 1 package loaded: the `enabled-check` grader is trivially passed when no hook exists, and 7.6 has no equivalent of 7.7's check of the stream's `system` init plugin list. A layer 1 run with no skills loaded then scores as the files arm, and full beats it easily.
- **What breaks if we ship it as-is:** The Keep-Layer-2 gate is "not measured" on every build. Combined with R3-GA-01, Layer 2 ships unmeasured every time. Or, if the executor improvises, Layer 2 is measured against an arm that may not have loaded.
- **Suggested fix:** Give the layer 1 package its own canary: a `regex` on `trace` that a CORE skill was loaded (the `Skill` tool called with a `core:` name, or the init event listing `core`), and drop the hook canary from `dist/core-layer1/evals/`. Assert both in the package test.
- **Evidence:** `v3-d3.md:1038`, `:1106`, `:1137` (run 3), `:1142`.

### R3-GA-03  —  critical
- **Artifact:** D3 (and D2)
- **Location:** D3 5.2 `finalize` §4–5: "Run `git status --porcelain _memories _summaries PROJECT.md` and count the lines … One closing line built from that count — never your own." Contract K "Without the script": "Count writes with `git status --porcelain …`". D2 §2: "Closed. 1 memory written (…), 1 archived (…)."
- **What is wrong:** This is the G20 fix (replace `verify` with `git status`). `git status` reports what is uncommitted, not what this session wrote. Three ways it counts wrong. (1) Changes left uncommitted by earlier sessions, or by the user, are counted as this session's writes. A user who does not commit after every session sees "3 written" in a session that wrote nothing. (2) An untracked folder collapses to one line. A fresh `_memories/` that was never committed shows as `?? _memories/` however many files it holds, so the count is 1 every session until the first commit. (3) An archive by plain `mv` shows as ` D` plus `?? _memories/archive/`, so "1 written, 1 archived" cannot be read from the lines at all. Run here: three files written in a new `_memories/` gave one line, `?? _memories/`; the next session, writing nothing, still counted 1; one write plus one `mv` archive gave three lines.
- **What breaks if we ship it as-is:** The close line reports writes that did not happen in this session. That is the fifth reported defect, "a finished session is reported as owing work", inverted: an unfinished session is reported as having written. The honesty rule "counts come from disk" is met to the letter and broken in meaning.
- **Suggested fix:** Count against a snapshot: the session-start receipt (or, without the script, the first step of `finalize`) records `git status --porcelain --untracked-files=all` and `HEAD`. The close count is the difference from that snapshot, with `--untracked-files=all`. With no snapshot, say "not measured".
- **Evidence:** `v3-d3.md:457`, `:887–888`; `v3-d2.md:144–146`; `v3-d4.md:449` (G20); scratchpad run, git 2.43.0: `?? _memories/` (3 files); count `1` with no new writes; ` D _memories/dc-1.md`, `?? _memories/archive/`, `?? _memories/dc-4.md`.

### R3-GA-04  —  critical
- **Artifact:** D3 (and D2)
- **Location:** D3 5.3 step 3–4: "For each older unclosed session, append `not caught up: <sid>`. … Run `close --sid <sid> --summary _core/inbox.md` for each of them." And: "No usable `tp`, or the file is gone → append 'transcript not available' for that session, close it." D2 §6: "One record per state: a session is closed when one receipt says so." D3 7.4: "`handoff_coverage` | sessions with a `close` row ÷ sessions".
- **What is wrong:** This is the G18 fix (R2-PR-07). The catch-up writes a `close` receipt for every unclosed session, including the ones it never read. `close` accepts `_core/inbox.md` because it "changed in the last 10 minutes" — it just got the line "not caught up". Contract H has no field that tells a catch-up close from a real one. So a session whose decisions were lost is recorded as closed, by the one record CORE says decides it. `handoff_coverage` and D2's "sessions … closed" count it as handed off.
- **What breaks if we ship it as-is:** CORE 3's third defect returns in CORE 4: "a close marker says 'closed' over an empty list of completed steps". The metric meant to show that sessions are being closed rises exactly when sessions are being lost.
- **Suggested fix:** Give `close` a `--kind <finalize|caught-up|lost>` field in the receipt. `handoff_coverage` counts only `finalize`; `metrics` reports caught-up and lost sessions as their own rows. The queue still drops them from `no-handoff`.
- **Evidence:** `v3-d3.md:898–903`, `:1009`; `v3-d3.md:438` (close contract: "changed in the last 10 minutes"); `v3-d2.md:241`, `:257`; `v3-d4.md:447` (G18).

### R3-GA-05  —  critical
- **Artifact:** D3 (and D2)
- **Location:** D3 contract K, "Finding the script": "The status block's `script:` line. Without a block: `scripts/core.mjs`, two folders above the skill's `SKILL.md`." D3 decision 30 and `copy-skills`: the five skills copied into `<project>/.agents/skills/`. D2 §9, Run: "Never: Anything from project content." D3 2.5 `skills-stamp`: warns only when the stamp "is older than this script's version".
- **What is wrong:** This is the G27 fix. In the plugin, two folders above `skills/core/SKILL.md` is the plugin root, so the path is CORE's own script. In the committed copy, two folders above `.agents/skills/core/SKILL.md` is `.agents/`, so the path is `<project>/.agents/scripts/core.mjs`: a file any committer can add. The copy is used exactly when there is no status block — on the Skills only rung, which D2 §5 says covers Codex after every CORE update and every machine without the plugin. CORE's own unmodified skill then tells the agent to `node` a script from the repository. People approve about 93% of prompts (D2 §9), and this one is labelled CORE. Separately, the copy itself is project content that runs without enabling, and the only check on it compares a version string, so an edited `remember` with a current stamp passes as CORE.
- **What breaks if we ship it as-is:** The enabled gate, D2 §9's main defence against a planted repository, is bypassed by the feature added to close the cloud-session gap. A cloned repository can run code through CORE's own instructions. The security claim "never run anything from project content" is false.
- **Suggested fix:** In the copy, never resolve a script by relative path: run a script only from the status block's `script:` line, else use the no-script steps. Make `skills-stamp` compare file hashes against the installed CORE's skills, and fail on a mismatch.
- **Evidence:** `v3-d3.md:450`, `:446`, `:102` (decision 30), `:626`; `v3-d2.md:203`, `:354`, `:371`.

### R3-GA-06  —  major
- **Artifact:** D2 / D3
- **Location:** D2 §9, Write: "In an enabled project: `_memories/`, `_summaries/`, `_sources/`, `_core/`, `PROJECT.md`." D2 §9: "Otherwise the hooks stay silent: no pointers, no receipt, no `_core/`." D3 contract K: "Only hooks consult the enabled list." Contract H: "Agent-side rows (`close`, `check`)". D3 1.2: `append` creates `_core/`.
- **What is wrong:** After G2, skills run in every project and the script's agent-side commands never check the enabled list. So in a project that was never enabled, `remember` writes `_memories/`, `finalize` writes `_summaries/` and `PROJECT.md`, `check --project` runs its write probe and writes a `check` receipt, and `close` writes a `close` receipt. Both create `_core/`. The security table says all of these happen only in an enabled project. The 3.3 test asserts "not enabled → … no `_core/`" for the hook, and the next agent-side command creates it.
- **What breaks if we ship it as-is:** Requirement 6 is met only on paper. A reviewer reads "enabled" as the write boundary, but it is only the boundary for hook output. A user who declined to enable a cloned repository finds receipts and a `_core/` folder written there.
- **Suggested fix:** Rewrite the Write row as two rows: hooks (enabled projects only) and skills and agent-side commands (any project the agent works in). Either make `close` and `check` skip receipts when the project is not enabled, or say they write them.
- **Evidence:** `v3-d2.md:353`, `:360`; `v3-d3.md:393`, `:448`, `:569`, `:683`.

### R3-GA-07  —  major
- **Artifact:** D2 / D3 / D4
- **Location:** D3 4.4 `pulse` §6: "**Unattended** — with the argument `unattended`: do (1) and (2), append proposals to `_core/inbox.md`". §2 is "Refresh stale sources". D3 decision 23: "Such runs write proposals to `_core/inbox.md` only." D2 §9: "`/core:pulse unattended`, which writes only proposals". D4 Part 2 Q15: "writes proposals only". D3 6.2 `sources.md`: "on Codex and Antigravity start a general helper with the text of `refresh.md`".
- **What is wrong:** R2-GA-05 raised that unattended runs refresh sources and write digests of outside tool text with no person watching. G13 added the `unattended` word, but `pulse` still runs the refresh in that mode. So a scheduled run calls MCP tools, reads untrusted outside text, and writes `_sources/*.md`, while three documents say it writes only proposals. On Codex and Antigravity the refresh helper is a general helper, not `core-refresh`, so it keeps a shell. The guard case `pulse-unattended-no-writes` matches only `_memories|PROJECT\.md`, so it passes.
- **What breaks if we ship it as-is:** The unattended rule in requirement 6 is false as written. The riskiest unattended action — reading outside text with a shell available and no one present — is the one left on.
- **Suggested fix:** In §6, do (1) only; list stale sources as proposals in `_core/inbox.md` for the next attended run. Widen the eval's `input_match` to `_memories|PROJECT\.md|_sources` and add `mock_calls` `list_issues` `max: 0`.
- **Evidence:** `v3-d3.md:95` (decision 23), `:805`, `:810`, `:937`, `:1112` (case row); `v3-d2.md:375`; `v3-d4.md:83`, `:442` (G13); `round-2/gap-auditor.md` R2-GA-05.

### R3-GA-08  —  major
- **Artifact:** D3 (and D2)
- **Location:** D3 4.4 `pulse` §3: "Speak only if a `now` item has not been said this session; otherwise say nothing." §1: "Run `queue`. Without the script, read the `by-when` dates yourself". D3 4.5 prompt: "If nothing qualifies, say 'nothing due as of <that date>'." Case `pulse-silent-when-nothing`.
- **What is wrong:** `pulse` has a rule for a missing script and a rule for a `now` item. It has none for `queue` returning `unknown` or `fail` (for example `_memories/` unreadable in a scheduled checkout). In that case no `now` item exists, so §3 says say nothing. The 4.5 prompt asks for "nothing due as of …", but it hands control to the skill first, and the skill's own rule, enforced by an eval, is silence. No case runs `pulse` with `queue` returning `unknown`.
- **What breaks if we ship it as-is:** The out-of-session check — the only way CORE speaks while the laptop is shut — returns the same output for "nothing is due" and "I could not read the queue". The user learns to trust a blank report. This is the defect class on the rung D2 sells for Thursday evening.
- **Suggested fix:** Add to `pulse` §3: if `queue` is not `ok`, always say one line, "could not check what is due: <reason>". In unattended mode always end with "nothing due as of <date>" or that line. Add a `pulse-queue-unknown` case.
- **Evidence:** `v3-d3.md:805–807`, `:821`, `:1110`; `v3-d2.md:154`.

### R3-GA-09  —  major
- **Artifact:** D2 / D3
- **Location:** D2 §5 OS table, Codex on Windows: "Until the Windows sandbox is set up, writes fail and close counts show zero." D2 §9: "Skipped writes still show as zero, since counts come from disk; Antigravity's headless mode skips unapproved calls and still exits as a success." D3 Rule 1: "`unknown` is never shown as success, zero, or blank."
- **What is wrong:** D2 presents a zero count as the safety net for failed or skipped writes. A zero from disk is the same zero a session that had nothing worth writing produces. `finalize` builds its closing line "from that count — never your own", so when the agent tried three writes and all failed, the user reads "0 written", which looks like a quiet session. Without the script there is no `close` call to fail. Rule 1 forbids exactly this, and the plan states it as designed behaviour on two harnesses.
- **What breaks if we ship it as-is:** On Codex for Windows before sandbox setup, and in Antigravity headless runs, every lost write reads as "nothing to record". "Could not write" is confusable with "nothing to write".
- **Suggested fix:** `finalize` compares the writes it attempted this session (its own Write and `mv` calls) with the disk count; any shortfall is "broken: N writes did not land". Run `check --project`'s write probe first when the script is present, and say "broken" if it fails.
- **Evidence:** `v3-d2.md:212`, `:375`; `v3-d3.md:45`, `:888`.

### R3-GA-10  —  major
- **Artifact:** D3 (and D2, D4)
- **Location:** D3 0.6 fixture: "295 distractors `dc-20260801-note-NNN` … summary `Note NNN: keep the <a> <b> as it is`, `<a>` cycling 6 words, `<b>` cycling 5 words … The store holds 300 memory files." D3 3.2: "Build Lantern (300 memories) … Ten ask for a fact held in one memory without using its summary's words." D2 §7: "60 queries over a 300-memory synthetic store".
- **What is wrong:** This is the G19 fix (R2-PR-13), and it is met on paper. The "300-memory store" is Lantern. It holds four real memories in `_memories/` (the fifth is in `archive/`, outside the index) and 295 copies of 30 templates. Each template repeats about ten times, differing only in its number, on one date. The 10 held-out paraphrase queries and 10 tuning paraphrase queries must each target "a fact held in one memory", so they either ask about the same four facts again and again or target a distractor whose nine twins score the same. For those, the `expected` id is arbitrary and precision at 3 measures the tie-break rule (newer date, then id).
- **What breaks if we ship it as-is:** The threshold that decides every pointer CORE shows is tuned on four facts. The reported precision and recall "by kind" look like a measurement over 60 queries but carry about four facts of information. A real store of 300 distinct memories behaves differently, and nothing will show it.
- **Suggested fix:** Build the gold-set store separately from Lantern: 300 distinct memories written by a fresh helper from a seeded topic list, with at least 40 distinct real facts, and require every `expected` id to be unique among lines with the same summary.
- **Evidence:** `v3-d3.md:540–545`, `:671–677`; `v3-d2.md:324`; `v3-d4.md:448` (G19).

### R3-GA-11  —  major
- **Artifact:** D1 / D2 / D3
- **Location:** D3 7.7: records "**files written**; **unplanted memories**; **duplicates** …; **stale copies**". GATE.md: "Keep Layer 1 only if … layer 1's probe hits exceed files' by at least 1"; "Built-in: if … built-in's probe hits exceed layer 1's". D1 §7 risk row: "The record test counts planted facts written, plus junk and duplicates, and publishes the numbers."
- **What is wrong:** R2-PR-05 said the record test rewarded an arm that writes everything. G7 added the counts, but no rule reads them. All three record-test rules use probe hits only. An arm that writes every sentence of every session gets the same or better hits, and its junk, duplicates and stale copies decide nothing. The same applies to the built-in comparison: D2 §4 names auto memory's duplicate of a replaced decision as a known harm, and the "use the built-ins" rule ignores it.
- **What breaks if we ship it as-is:** Kill test 1 can keep Layer 1 because it over-writes, and kill test 2 can recommend built-in memory that keeps stale decisions live. The counts are published but cannot change the verdict, so the fix is instrumentation that reads something and decides nothing.
- **Suggested fix:** Freeze in GATE.md a second condition for each record-test rule: stale copies and duplicates not above the compared arm's, and unplanted memories at most a stated number per session.
- **Evidence:** `v3-d3.md:533–534`, `:1157`; `v3-d2.md:183`, `:289`; `v3-d1.md:196`; `v3-d4.md:436` (G7).

### R3-GA-12  —  major
- **Artifact:** D3 (and D1)
- **Location:** D1 §8 kill test 1: "Otherwise: use the kit and the built-ins; do not build CORE." D3 GATE.md: the same words. D3 phase order: phases 1–3 build the receipts, store, index, queue, enabled list, recall and all three hook files; the five skills are written in 4.3–5.3; the layer 1 record test runs in 7.7.
- **What is wrong:** The test that can cancel CORE, layer 1 against files, runs only in 7.7, after all of Layer 2 is written. Layer 1 needs no script (G2), so it could be written and record-tested right after 0.6. Requirement 5 is met by the headroom run in 0.6, which measures files against nothing and says nothing about whether CORE's skills help. "Do not build CORE" is therefore a decision made after CORE is built.
- **What breaks if we ship it as-is:** If Layer 1 loses, the build has already spent phases 1–3 and most of 7. The pressure to reinterpret a lost kill test is highest exactly when the most work has been done. G3's "Layer 1 is on trial" is a trial held after the sentence.
- **Suggested fix:** Move 4.3–5.3 (prose only, with their no-script sections) and the layer 1, files, and built-in arms of 7.7 to a new phase 1, right after 0.6. Build Layer 2 only if kill test 1 passes.
- **Evidence:** `v3-d1.md:219`; `v3-d3.md:533`, `:555–753` (phases 1–3), `:759–905` (skills), `:1145` (7.7); `v3-d4.md:432` (G3).

### R3-GA-13  —  major
- **Artifact:** D2 / D3
- **Location:** D2 §1: "If last session had prompts but no prompt-hook receipt, it adds 'prompt hook did not run last session'." D3 contract F: the line fires when "this machine's previous session on this harness has a `session-start` row and no `prompt` row." D3 7.4: `silent_sessions` = "a `session-start` row and no `prompt` row"; the `metrics` skill: "A silent session in the window … makes the second answer 'not measured'".
- **What is wrong:** This is the G11 fix for R2-GA-04. D2's condition cannot be computed: if the prompt hook did not run, no receipt shows that the session had prompts. D3 replaces it with "a start row and no prompt row", which is also true of any session opened and closed without a prompt — a session opened by mistake, or one where the user only ran local commands such as `/hooks` or `/exit`. Each one makes the next session open with "the prompt hook did not run last session" and makes `metrics` answer "not measured" for "is it pointing to memories" for 14 days.
- **What breaks if we ship it as-is:** A false "broken" at session start and a near-permanent "not measured" in `metrics`. D1 §3 names the harm: health reports that are often wrong teach the user to stop reading them. Then a real dead prompt hook is ignored.
- **Suggested fix:** Count a session as silent only when the harness's transcript, read from the start receipt's `tp`, holds at least one user message. Where it cannot be read, say "not measured" for that session alone, not for the window. Correct D2's sentence to the rule actually used.
- **Evidence:** `v3-d2.md:107`; `v3-d3.md:349`, `:1011`, `:1030`; `v3-d4.md:440` (G11).

### R3-GA-14  —  minor
- **Artifact:** D4
- **Location:** Fix codes, round 2: G4 "ahead of layer 1 by one score step or more … no gated case is behind by more than one step"; G10 "Setup writes it into `CLAUDE.md` when one exists, else `AGENTS.md`"; G11 "if receipts show prompts last session but no prompt-hook receipt". Part 2 Q3: "closed promises, questions, and risks 30 days after they close". Q14: "The refresh helper has no tool on today's list that runs a command."
- **What is wrong:** D4's description of what v3 did does not match v3. G4: D1, D2 and GATE.md freeze 0.2, which is two score steps on a two-grader case (steps of 0.1). G10: v3 writes the block into both files, not one or the other. G11: see R3-GA-13. Q3: a retired risk moves to `archive/` at once (contract C), not 30 days later. Q14: true only on Claude Code; Codex and Antigravity use a general helper.
- **What breaks if we ship it as-is:** G23 made D4 the stand-alone record. A reader checking whether a fix landed reads a different gate threshold, a different block placement, and a stronger security claim than the plan contains.
- **Suggested fix:** Rewrite G4, G10, G11, Q3 and Q14 to state what v3 does, with the step number.
- **Evidence:** `v3-d4.md:71`, `:82`, `:433`, `:439`, `:440`; `v3-d3.md:98` (decision 26), `:531`, `:265` (contract C closing); `v3-d2.md:277`.

### R3-GA-15  —  minor
- **Artifact:** D3
- **Location:** D3 Budget: "Shipped JavaScript (`plugins/core/scripts/**/*.mjs`) | 1,800 lines"; "All shipped prose (`plugins/core/**/*.md`, evals excluded)". "Why each thing exists" table. D3 7.6: every case has `fixture.sh`; shared `evals/_fixture/build.sh`. 7.5: the layer 1 package copies `evals/`; its test checks "no hook file, no `.mjs`". D4 G20: "Rows added for … the fixtures".
- **What is wrong:** 31 cases plus 10 twins give 41 `fixture.sh` files, plus `build.sh`, all under `plugins/core/evals/`, so they ship inside the plugin and inside the "no code" Layer 1 package. No budget row counts them, `check --plugin` does not measure them, and the native-first table has no row for them or for the six `tests/tools/*.mjs` scripts, though G20 says a fixtures row was added. Requirement 4 asks for a budget that holds and a reason for each script.
- **What breaks if we ship it as-is:** The plugin that claims 1,800 lines ships 42 more scripts that no check counts, and D1's "Layer 1 needs no code" is false of the package actually built. Requirement 4 is met only for the part that was measured.
- **Suggested fix:** Add a budget row for `plugins/core/evals/**` (files and lines) checked by `check --plugin`, strip `evals/` from `dist/core-layer1/` after the layer 1 run, and add native-first rows for the fixture scripts and the six test tools.
- **Evidence:** `v3-d3.md:108–131`, `:137–140`, `:1038`, `:1074`; `v3-d1.md:23`, `:110`; `v3-d4.md:449` (G20).

---

Sound: the three-word result contract (A), the planted-answer selftest (7.2), and the per-run `error` and init-event checks in 7.7 are well specified and match across D2 and D3.

critical 5 · major 8 · minor 2 · taste 0
