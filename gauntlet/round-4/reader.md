# Round 4 — Reader

Reviewed: `v4-d1.md`, `v4-d2.md`, `v4-d3.md`, `v4-d4.md`. Mandate: requirement 9 (plain speech, short sentences, a distracted reader) and whether each document does its job for its reader. Earlier reader files (rounds 1–3) and D4 Part 3 were read first. No finding below repeats one; broken fixes cite the earlier ID.

---

### R4-RD-01  —  major
- **Artifact:** D2, D4 (against D3)
- **Location:** D2 §2 "runs the plain scheduled prompt (D3 step 4.5)"; D2 §7 "About 25 cases … (D3 step 7.6)", "five probes ask about them (D3 step 7.7)", Basis table "Match threshold | D3 step 3.2", "Estimate; measured in D3 step 7.6"; D4 Part 2 Q6 "measured in step 7.6", Q8 "Recorded per arm in step 7.6".
- **What is wrong:** v4 renumbered D3's steps (H3), but D2 and D4 still cite v3 numbers. D3 has no step 7.6 or 7.7 at all. Two of the old numbers now point at the wrong step: v4 step 4.5 is "Migrating a v3 project", not the scheduled prompt (now 1.4); v4 step 3.2 is "One guard for every command", not recall tuning (now 5.2). D3's escape hatch, "Other documents may cite either number", makes this worse, because 3.2 and 4.5 exist in both numberings with different meanings. The reader cannot tell which one is meant.
- **What breaks if we ship it as-is:** A reader who follows D2's pointer for the laptop-shut prompt lands on the migration step. A reader who checks how the match threshold is set reads the CLI guard. A reader looking up how session-start cost is measured finds no step. These are the links a sceptical reader uses to check D2's claims, and four of the eight fail.
- **Suggested fix:** Change D2 and D4 to v4 numbers (4.5→1.4, 7.6→7.1, 7.7→2.1/7.2, 3.2→5.2). Delete "Other documents may cite either number" from D3.
- **Evidence:** `v4-d2.md:172, 293, 302, 338, 340`; `v4-d4.md:82, 84`; `v4-d3.md:28` ("Other documents may cite either number"), `:32–42` (mapping table), `:730` (1.4), `:935` (3.2), `:1003` (4.5), `:1047` (5.2); `grep -n '^### 7\.' v4-d3.md` lists only 7.1 and 7.2.

### R4-RD-02  —  major
- **Artifact:** D1, D2, D3, D4
- **Location:** D1 §8 "**The kill test.** … 1. Layer 1 ships only if … 5. The script's self-audit commands … ship whenever Layer 1 ships"; D1 "What was not verified": "which kill test 4 counts as not kept"; D2 §7 "The gate" rules 1–4; D3 0.6 "**Kill test (Layer 1), step 2.3.**"; D4 H1 "Kill test 2 is folded in".
- **What is wrong:** "Kill test" means three different things. In D1 it is a numbered list of five rules, one per part, and item 5 is not a test (the script ships with Layer 1 without being tested). In D3 "the kill test" is only the Layer 1 rule (step 2.3, Phase 2's title), and the hook rules are "the hooks' gate". D2 numbers the same rules 1–4 differently: D1's #4 is "a rule that cannot be measured counts as not kept", D2's #4 is "neither hook is kept if full trails layer 1". So D1's own "kill test 4" points to a different rule from D2's rule 4. D4's H1 says "Kill test 2 is folded in", yet D1 still has a kill test 2, now about the session-start hook.
- **What breaks if we ship it as-is:** The kill test is the verdict's core. A reader moving from D1 to D2 to D3 gets three different lists under one name. A reader who reads "kill test 2 is folded in" in D4 will think the session-start hook's test was dropped. The re-run rule ("re-run the kill tests") is unclear: does it cover the hooks or not?
- **Suggested fix:** Keep "kill test" for the Layer 1 rule only, as D3 does. Call the rest "the hook rules". Number them the same way in D1 and D2, drop D1's item 5 from the list, and reword H1 to "the old built-in rule is folded in".
- **Evidence:** `v4-d1.md:223–229, 258`; `v4-d2.md:318–323`; `v4-d3.md:579, 879, 1421, 1436`; `v4-d4.md:575`.

### R4-RD-03  —  major
- **Artifact:** D1, D2, D4 (against D3)
- **Location:** D1 §8 kill test 1: "on the ten-session record test, it beats **kit** on recall probes and on being told what is due, by a fixed margin, with a paired interval over 6 repetitions that excludes zero"; D2 §7 arms table "**Kit** | … | Record"; D2 gate rule 1 "and on `proactive-due` by 0.2 against a kit twin"; D4 Part 2 Q10 "an eval with seven arms".
- **What is wrong:** The rule that decides whether CORE exists is stated three ways. D1 puts both parts on the record test, with auto memory on, under a paired interval, at "a fixed margin" it never gives. D3 (0.6, 2.3) puts the "told what is due" part in an eval case, `proactive-due`, at 0.2, with auto memory off and no interval. D2 gives D3's version in its rules, but its own arms table says kit runs in the record test only. The eval arm count also differs: D1 lists five eval arms, D3 adds a kit twin (six), D4 says seven. D1's "a fixed margin" is the vague wording R2-RD-03 objected to ("clearly keeps the better record"); the fix moved the number to D2 and left D1 without it. Smaller drift: D2's prompt-hook rule leaves out `null-rename`, which D3's GATE.md includes.
- **What breaks if we ship it as-is:** D1 is the only document most readers open, and it misstates the one rule that can retire CORE. It names the wrong test, the wrong auto-memory condition, and no number. A reader cannot check the verdict against D2 or D3 without finding the gap themselves.
- **Suggested fix:** In D1, write the rule as D3 freezes it: "on the record test, at least 1 more probe of 5, with an interval above zero; and on the `proactive-due` eval case, 0.2 ahead of the kit twin". Mark kit as "Record; eval twin for `proactive-due`" in D2's table, and give one arm count everywhere.
- **Evidence:** `v4-d1.md:221, 225`; `v4-d2.md:279–287, 318, 320`; `v4-d3.md:579, 581, 912` ("In these runs auto memory is off in both arms"); `v4-d4.md:86`.

### R4-RD-04  —  major
- **Artifact:** D1, D2, D3, D4
- **Location:** D2 §1 "**The `AGENTS.md` block**, added with your yes. It keeps that name wherever it sits, apart from the hooks' **status block**; "the block" below always means this one"; D2 §1 "**A fourth line**"; D3 "the *instruction block* is the three lines of step 1.1. Skill prose never says a bare "block""; D3 1.1 "The liveness line"; D1 "A three-line block"; D4 Part 1 §6 and Q20 "the per-machine line".
- **What is wrong:** This is a broken fix of R3-RD-01 (H18: "'Status block' vs 'the `AGENTS.md` block' named apart"). The two texts CORE adds now have one official name per document. The three lines are "the `AGENTS.md` block" (D2), the "instruction block" (D3), and the "three-line block" (D1, D4). The extra line is the "fourth line" (D2), the "liveness line" (D3), and the "per-machine line" (D4). D2's name is wrong for two of three harnesses, since on Claude Code and Antigravity the text sits in `.claude/rules/core.md` and `.agents/rules/core.md`. "Fourth line" suggests line 4 of the block, but it lives in a different file. D2's defining sentence does not parse: "keeps that name wherever it sits, apart from the hooks' status block" reads as if the block sits apart from the status block. The two documents also give different wording for the line itself: D3's starts "In a project with a _memories/ folder:"; D2's does not.
- **What breaks if we ship it as-is:** A reader who learns "the `AGENTS.md` block" in D2 then looks for it in `AGENTS.md` on Claude Code and does not find it. An agent going from D2 to D3 meets "liveness line" with no link to "fourth line". The H18 fix was meant to end this kind of drift.
- **Suggested fix:** Use D3's names everywhere: "instruction block" and "liveness line". Replace D2's sentence with "D3 calls these three lines the *instruction block*". Quote D3's exact liveness-line text in D2.
- **Evidence:** `v4-d1.md:23, 108`; `v4-d2.md:72, 86`; `v4-d3.md:56, 652–654`; `v4-d4.md:41, 96`.

### R4-RD-05  —  major
- **Artifact:** D4
- **Location:** Part 3, Round 3 table, column "What was wrong (first sentence)": "R3-RD-04 | This is a broken fix of R1-GA-04 and G13."; "R3-GA-04 | This is the G18 fix (R2-PR-07)."; "R3-GA-05 | This is the G27 fix."; "R3-RD-07 | D1, D2 and D3's `GATE.md` all say 0.2."; Location cell "D3 (and D2 §7, D1 "What ".
- **What is wrong:** This is a broken fix of R2-RD-09 ("A ledger row cannot be read on its own"). Round 3's rows take the first sentence of each finding, and for at least 23 of the 97 rows that sentence only says which earlier fix broke, or quotes the evidence. It does not say what is wrong. R3-RD-07's cell states the plan's text, not the problem. Location cells are cut mid-word. The fix cell is a bare code such as H18, which bundles twelve unrelated edits. D4 still claims "Part 3 can be read without opening any other file".
- **What breaks if we ship it as-is:** A reader of the ledger, the only place D4 says what round 3 found, cannot learn the problem behind about a quarter of round 3's rows, including four of its 16 critical findings (R3-GA-03, -04, -05, R3-PR-01), without opening `round-3/*.md`. That is the failure R2-RD-09 was accepted to remove.
- **Suggested fix:** Write each "What was wrong" cell as one plain sentence naming the problem, not its history ("finalize counted the whole working tree, not this session"). Do not cut Location cells.
- **Evidence:** `v4-d4.md:9` (the claim), `:413` (column heading), `:418, 426, 430, 442–445, 450, 453, 456–457, 460, 462, 464–469`; `awk -F'|' 'NR>=415&&NR<=512{print $6}' v4-d4.md | grep -c 'fix'` matches 23 rows.

### R4-RD-06  —  minor
- **Artifact:** D1
- **Location:** "The short version": "**Verdict: rebuild CORE for its owner's own use … Each part ships only if it beats the thing below it. The test of whether CORE should exist runs before any hook or script is written.**"
- **What is wrong:** The first screen gives a verdict that rests on "the thing below it" without saying what that is. It never names the kit, which is what Layer 1 must beat. It never says what happens if CORE loses: "Do not ship CORE: use the kit and the harness built-ins." Both appear only in §6 and §8, about 200 lines down. D2's "In one minute" does say it ("Layer 1 must first beat **the kit** … or CORE does not ship"). D1, the document meant to carry the verdict, does not.
- **What breaks if we ship it as-is:** A reader who stops after the first screen comes away with "rebuild CORE". They miss that the plan's first paid step can end in "do not ship; use the kit", and they cannot tell what CORE is being tested against.
- **Suggested fix:** Add one sentence to the short version: "First, Layer 1 must beat *the kit*: built-in memory plus the same three lines. If it does not, CORE does not ship and the kit is the answer."
- **Evidence:** `v4-d1.md:15, 212`; `v4-d2.md:21`; `v4-d3.md:915`.

### R4-RD-07  —  minor
- **Artifact:** D2, D4, D1 (against D3)
- **Location:** D2 §7 "Ten would be 1,200 paid calls on one person's account; six is 720"; D2 alternatives "Ten record-test repetitions. 1,200 paid calls"; D4 Part 1 §1 "The record test (about 720 calls)"; D4 R3-PR-06 rebuttal; D3 2.3 "about 41 calls per arm per repetition, 738 in all".
- **What is wrong:** D2 and D4 count only the 30 session calls per arm per repetition. D3 counts 41: 30 session turns, 5 probes, 5 graders, and 1 control. By D3's count, three arms alone cost 738 calls, not 720 for all four. Adding the full arm (7.2) gives about 984, and the `--long` run comes on top. At ten repetitions the total is about 1,640, not 1,200. D2 also says "Ten sessions … Each has three turns" and then "One 25-turn session compacts at turn 18". This reads as part of the same ten, but it is a separate `--long` run on two arms, three repetitions.
- **What breaks if we ship it as-is:** The rebuttal of R3-PR-06 rests on cost, and the cost it gives is about a third too low. The maintainer budgets for 720 calls and spends about 1,000 or more. A reader cannot rebuild the record test's shape from D2.
- **Suggested fix:** Use D3's figure everywhere: "about 41 calls per arm per repetition; four arms × six repetitions ≈ 1,000 calls, plus the long run". Call the 25-turn session "a separate long run (full and layer 1, three repetitions)".
- **Evidence:** `v4-d2.md:302, 307, 309, 434`; `v4-d4.md:21, 644`; `v4-d3.md:911, 1321`.

### R4-RD-08  —  minor
- **Artifact:** D2 (against D3)
- **Location:** D2 §7 "About 25 cases cover the jobs, honesty, and security"; D2 §9 "an id, a date, a summary cut to 160 characters".
- **What is wrong:** D2 restates two D3 figures that have drifted. D3 7.1 lists 31 cases plus two canaries, not about 25. D3 contract D cuts the index line, which is where pointer summaries come from, to 120 characters. 160 is the status block's cut (contract F). D2 gives 160 for the pointers, which are the security-relevant output.
- **What breaks if we ship it as-is:** A reader sizing the eval's cost from D2 undercounts by a fifth. A reader checking the security claim ("pointers, never bodies") against the code finds a different limit and cannot tell which document is right.
- **Suggested fix:** D2: "31 cases", and "a summary cut to 120 characters (160 in the status block)".
- **Evidence:** `v4-d2.md:293, 378`; `v4-d3.md:324, 391`; `sed -n 1268,1305p v4-d3.md | grep -c '^  | \`'` gives 33 rows, including `canary` and `canary-layer1`.

### R4-RD-09  —  minor
- **Artifact:** D3, D2, D4
- **Location:** D3 contract C "**Archiving, the one rule.** Done promises and answered questions are proposed for archive 30 days after they close. A retired risk moves to `archive/` at once. Open questions, active risks, decisions, principles, and people are never proposed."; contract J `"archive_after_days": 90`; step 1.3 item 4 "(b) `observation`, `review-finding`, and `explainer` memories older than `archive_after_days` … say "the 90-day check is not measured yet"".
- **What is wrong:** This is a broken fix of R3-RD-02 (H18: "One archive rule in every place"). There are still two rules. Contract C, labelled "the one rule", leaves out the second rule (observations, review findings, explainers, 90 days unpointed), which `pulse` applies under "by contract C's archive rule". The setting `archive_after_days` defaults to 90 and governs only that second rule. Its name suggests it sets the 30-day rule, which is hard-coded. The user-facing message hard-codes "90-day", so it is wrong once the setting changes. D2 and D4 Q3 call the same types "observations, review notes, and explainers"; the type is `review-finding`.
- **What breaks if we ship it as-is:** An agent writing `remember` or `check` from contract C alone never builds the second rule. A user who sets `archive_after_days: 30` expecting faster archiving of closed promises changes nothing they can see, and then reads a message that still says "90-day".
- **Suggested fix:** Head contract C's bullet "Archiving: two rules" and state both. Rename the setting `stale_note_days`. Print its value, not "90", in the message.
- **Evidence:** `v4-d3.md:309, 475, 722`; `v4-d2.md:54, 201`; `v4-d4.md:79`.

### R4-RD-10  —  minor
- **Artifact:** D4
- **Location:** Part 1 §9: "Each machine needs its own "use CORE here"."
- **What is wrong:** This is a broken fix of R3-RD-14 (H18: ""Enable CORE here" is the one phrase for the opt-in"). D4's own case against the plan uses the phrase R3-RD-14 named as appearing in no skill or notice. D1, D2, and D3 all say "enable CORE here".
- **What breaks if we ship it as-is:** A reader who takes the phrase from D4 types "use CORE here". The `core` skill's description and section 10 respond to "set up or enable CORE", so the opt-in may not start, and the user decides the enabling story does not work.
- **Suggested fix:** Change it to "enable CORE here".
- **Evidence:** `v4-d4.md:53, 592`; `v4-d3.md:680, 695`.

### R4-RD-11  —  minor
- **Artifact:** D1 (against D2, D3)
- **Location:** D1 §4 Layer 2: "A prompt hook offers up to three memory pointers per prompt (per model call on Antigravity, where CORE marks each turn's start [antigravity §6])."
- **What is wrong:** The H13 fix (R3-HA-01) made Antigravity recall run once per turn. Only the first `PreInvocation` after a turn's start runs recall; later calls answer `{}`. D1's parenthesis says the opposite: pointers "per model call on Antigravity". The clause about marking each turn's start is the fix, but the sentence still claims the old behaviour.
- **What breaks if we ship it as-is:** A D1 reader concludes CORE floods Antigravity with pointers on every model call, against D1's own Focus job ("say little"). That is the cost R3-HA-01 was raised about, now stated as the design.
- **Suggested fix:** "…up to three memory pointers per prompt (on Antigravity, once per turn: CORE marks where each turn starts)."
- **Evidence:** `v4-d1.md:117`; `v4-d2.md:99`; `v4-d3.md:412`.

### R4-RD-12  —  minor
- **Artifact:** D1, D2, D3
- **Location:** D2 §7 rule 2: "The session-start hook is kept only if full, recall off beats layer 1 on the eval."; D1 §8 "Arms: full, **full, recall off** (session-start hook only), layer 1, …"; D3 uses `recall-off`, "Full, recall off", and "full, recall off".
- **What is wrong:** One arm's name contains a comma, and it is used inside comma lists and in "only if" sentences. Without bold, D2's rule parses as "kept only if full; recall off beats layer 1". D1's arm list reads as six arms, two of them "full". D3 spells it two ways (`recall-off` 17 times, "full, recall off" 4 times).
- **What breaks if we ship it as-is:** These are the gate rules a reader uses to decide whether a hook ships. A distracted reader misparses D2's rule 2. In D1's list they count the wrong number of arms, which adds to the count drift in R4-RD-03.
- **Suggested fix:** Rename the arm `start-only` (or "recall off") in all four documents, with no comma.
- **Evidence:** `v4-d2.md:284, 319, 320`; `v4-d1.md:221, 226, 227`; `grep -c 'recall-off' v4-d3.md`.

### R4-RD-13  —  minor
- **Artifact:** D4 (against D3)
- **Location:** H1: "**kit** (auto memory on, plus the same three-line block in `CLAUDE.md` and `AGENTS.md`, no skills)"; H18: "D4's fix-code text matches what v3/v4 does."
- **What is wrong:** D3 2.1 puts the kit's block in `.claude/rules/core.md`. D3's alternatives reject "The block in `AGENTS.md` and `CLAUDE.md`" by name. D4's definition of the arm that can retire CORE describes the rejected placement, in the same table that claims its text now matches v4 (the fix for R3-GA-14).
- **What breaks if we ship it as-is:** A reader auditing kill-test fairness from D4 (Part 1 §12 invites this) checks the wrong file. They may conclude the kit is handicapped, since `CLAUDE.local.md` can hide `AGENTS.md`, when it is not.
- **Suggested fix:** H1: "the same block in `.claude/rules/core.md`".
- **Evidence:** `v4-d4.md:575, 592`; `v4-d3.md:891, 1462`.

### R4-RD-14  —  minor
- **Artifact:** D2
- **Location:** §5 "How CORE knows": "On Claude Code, agent-side commands read `CLAUDE_CODE_SESSION_ID`, the hooks' id: in an enabled project, no session-start receipt for it makes `env` say **broken**."; rung table "on Claude Code, `env` says **broken**".
- **What is wrong:** `env` is the ladder's only reporting tool, and D2 never says what it is. §1 lists the script's commands as "`check`, `selftest`, `metrics`, `migrate`, and `queue`", without `env`. "Agent-side commands" is also new here. The sentence packs an environment variable, a definition after a colon, a condition, and an outcome into one line.
- **What breaks if we ship it as-is:** In the section that answers requirement 3 ("how you are told"), the reader is told that a command they have never heard of says "broken", with no hint of when it runs or who sees it. They cannot tell whether a user on the Skills-only rung is ever told.
- **Suggested fix:** In §1 add "`env`: reports which rung this session is on". Split the sentence: "On Claude Code, the agent's commands know the session id. If the hooks left no start receipt for it, `env` says broken."
- **Evidence:** `v4-d2.md:92, 210, 219`.

### R4-RD-15  —  taste
- **Artifact:** D2
- **Location:** §5 rung table, row **Skills only**, column "When you are here": "Hooks not running: Codex hooks unapproved (reset on every CORE update [G 4.2]); no Node; harness below its floor (§10); `CORE_DISABLE=1`; not enabled here; hooks shelved (§7); only the committed `.agents/skills/`; Claude Code cloud with the skills on your claude.ai account; a Projects thread with CORE added in Project settings > Plugins, where hooks do not run [research-claude-code §8]".
- **What is wrong:** One cell holds nine conditions, two citations, and two section pointers. The "How you are told" cell next to it holds four more conditions. This is the table a reader scans to find their own situation, and it cannot be scanned.
- **What breaks if we ship it as-is:** A reader on Codex after an update, the commonest drop, has to read a 70-word cell to learn they are on this rung. The table's job, telling someone at a glance what they lost, is done by prose crammed into cells.
- **Suggested fix:** Put the nine causes in a bulleted list under the table, each with how the user is told, and leave the row cell as "Hooks not running (see list)".
- **Evidence:** `v4-d2.md:219`.

---

Sound: D1's first screen now states one verdict in plain words. D2's "In one minute" defines every term it uses before §1. D3's label and failure-procedure sections read cleanly.

critical 0 · major 5 · minor 9 · taste 1
