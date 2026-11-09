# Round 4: practitioner review of v4

Mandate: would this memory design and its evaluation work, and can the measurements tell "helps" from noise? I read D1–D4 v4, every round 1–3 reviewer file, and the D4 Part 3 ledger, fix codes H1–H18 included. Probabilities below come from exact binomial sums and simulations of 40,000 trials, written as a best case: runs independent and graders independent. Real runs share a fixture, so they are correlated and the true error rates are worse.

Short answer: the kill test now compares the right arms. It still mostly cannot say yes to a Layer 1 that works. Two of its three legs measure things Layer 1 is built to lose: an Interact case Layer 1 has no instruction for, and copy counters that count Layer 1's own handoff notes as stale. The hook gates have the opposite fault. Their veto rules let real harm through about half the time. That breaks the plan's own claim that low power "can only make CORE lose".

---

### R4-PR-01  —  critical
- **Artifact:** D3 (and D1 §8, D2 §7)
- **Location:** D3 0.6 GATE.md, kill test (b): "on `proactive-due` it is ahead of the kit twin … by 0.2"; D3 1.2 `core` section 2: "No status block → read `reference/ladder.md` and `PROJECT.md`, say in one sentence what is not working, and before answering about the past run `recall`"; D3 1.2 Files: "`reference/ladder.md` (filled in 8.5)"; D1 §8: "it beats **kit** on recall probes and on being told what is due".
- **What is wrong:** This is the H1 fix for R3-PA-10 ("no existence test measures Interact"), and it measures nothing that separates the two arms. In the kill eval, layer 1 has no hooks and no script, so it has no status block. The `core` skill's no-status-block branch says to read `ladder.md` and `PROJECT.md` and to search the record before answering about the past. It never says to look for what is due. The no-script due-date step lives only in `pulse` section 1, and `pulse` fires on a schedule or when the user asks about the queue. `proactive-due` asks for a README edit. The due date sits in the frontmatter of one file among 300 (`dc-20261020-058`, `by-when: $TODAY`). Neither arm has an instruction that leads it there. Both arms read the same `PROJECT.md` through the block, and its "Next" line already contains the word "retention". So the expected gap between layer 1 and the kit twin is about zero. On top of that, `ladder.md`, the file the branch tells layer 1 to read, is not written until step 8.5, six phases after the kill test runs.
- **What breaks if we ship it as-is:** Kill test (b) needs a 0.2 lead, and the expected lead is zero. With 10 runs per arm and an equal true rate, layer 1 clears +0.2 only 12–25% of the time. So the existence test kills CORE about four times in five because of a missing sentence in a skill, not because Interact fails. D1's verdict, "use the kit", would rest on a case where Layer 1 was never told to do the job being scored.
- **Suggested fix:** Before GATE.md is frozen, add to `core` section 2's no-status-block branch: "list active memories whose `by-when` is within 24 hours (search `^by-when:` in `_memories/`) and say the dates were read by the model". Write `ladder.md` in phase 1, or drop the reference from the branch until 8.5.
- **Evidence:** v4-d3.md:579, 687, 674, 719 (`pulse` holds the only no-script due step), 714 (`pulse` description), 1275 (`proactive-due` prompt and graders), 617 and 620 (the fixture's `PROJECT.md` and the due item). Binomial: X, Y ~ Bin(10, p); P(X − Y ≥ 2) = 0.25 at p = 0.5 and 0.12 at p = 0.9.

### R4-PR-02  —  critical
- **Artifact:** D3 (and D2 §7, D1 §7 risk row)
- **Location:** D3 2.1, "**duplicates** (one fact live in two or more files, auto memory included); **stale copies** (the session-2 decision's old form live outside `archive/`, auto memory included)", where facts are found by "the key's regexes over the folder outside `_core/`"; GATE.md kill test (a), "and no more stale or duplicate copies".
- **What is wrong:** This is the H7 fix for R3-GA-11 and R2-PR-05. The counters score Layer 1's own required outputs as defects. Three cases:
  1. **The handoff note.** `finalize` must write `_summaries/summary-…md` with a "Done" heading. Session 2 (the decision) and session 4 (the person) end with "wrap up", so the decision and the person are restated in a handoff note beside their memory files. That is one fact in two files outside `archive/`: a duplicate, by definition, in every repetition.
  2. **The stale note.** Session 2's handoff note says what was decided in session 2. After the session-7 reversal, that note still holds the old form, outside `archive/`. Handoff notes are history and are never edited, so every layer 1 repetition carries at least one stale copy.
  3. **The rejected option.** `remember` rule 6 says a decision records "the option not taken and why". The session-7 memory must therefore say "Not chosen: keep the session-2 choice". The old-form regex matches that line in the correct, superseding memory. A regex cannot tell "we keep X" from "we rejected X".

  The kit arm has no `finalize` and no decision format, so it writes fewer of these lines. `PROJECT.md`'s "Now" and "Next", which `finalize` updates, add more duplicates for layer 1.
- **What breaks if we ship it as-is:** The leg "no more stale or duplicate copies" fails layer 1 almost every time it follows its own skills. Since a single leg can kill CORE, the existence test answers "do not ship CORE" because Layer 1 wrote handoff notes and recorded rejected options, the two habits D1 §4 names as CORE's judgment. That is a measurement reporting a defect where the design worked as specified.
- **Suggested fix:** Count copies only in `_memories/` outside `archive/` and in auto memory. Exclude `_summaries/` and `PROJECT.md`. Decide "stale" with the blind grader ("does this file state the old decision as current?"), not a regex. Before the first run, run the counters on a hand-built ideal layer 1 store and require 0.
- **Evidence:** v4-d3.md:895, 579, 766 ("Decision: the option not taken and why"), 792 (headings "Resume here", "Done", "Open"), 887 (even sessions wrap up), 302 (contract C example body "Not chosen: …").

### R4-PR-03  —  major
- **Artifact:** D2, D3
- **Location:** D2 §7, "no more stale or duplicate copies. One margin for every record-test rule."; GATE.md kill test (a) and "Both hooks"; GATE.md JSON `"record": {"reps": 6, "margin_probes": 1, …}` (no margin for copies).
- **What is wrong:** This is a broken part of H7, whose text says "one margin for every rule". The probe leg has a margin and an interval. The two copy legs have neither: any higher mean over six repetitions fails. With identical true behaviour in both arms:
  - stale copies at 0 or 1 per repetition, p = 0.3: P(layer 1 > kit) = 0.376;
  - duplicates averaging 2 per repetition (12 over six): P(layer 1 > kit) = 0.459;
  - either leg fails: 1 − 0.624 × 0.541 = **0.66**.

  The probe leg alone, simulated (5 probes per repetition, need mean ≥ 1 and a paired t interval above zero), passes 29% at a true gain of exactly one probe (0.8 against 0.6), and 63% at 1.5 probes. Multiplied together: a Layer 1 that is truly 1.5 probes better and truly equal on copies passes about **21%** of the time. At the stated margin it passes about **10%**.
- **What breaks if we ship it as-is:** In four of five worlds where Layer 1 truly helps, the kill test reads "not kept", and the plan stops before writing a line of code. So "not kept" carries almost no information, and every later re-run "at every minor harness release" flips on noise. The same zero-margin legs sit inside the hooks' rule 4.
- **Suggested fix:** Give the copy legs the probe leg's form: fail only if layer 1 has at least 1 more copy per repetition on average **and** the paired interval for that excess sits above zero. Or report the copy counts and do not rule on them.
- **Evidence:** v4-d2.md:315; v4-d3.md:579, 582, 609; v4-d4.md H7 ("one margin for every rule"). Computation: Bin(6, 0.3) against Bin(6, 0.3), and Poisson(12) against Poisson(12); simulation of the probe leg with t = 2.571.

### R4-PR-04  —  major
- **Artifact:** D1, D2, D3
- **Location:** D1 §8, "a gap whose interval includes zero counts as not kept, so too few runs can only make CORE lose"; D2 §7 (same); D3 Alternatives, "Six with a paired interval … can only make CORE lose, never win"; GATE.md "Both hooks … full trails layer 1 by the margin"; the eval rule "neither non-inferiority case behind by more than 0.2".
- **What is wrong:** The R3-PR-06 rebuttal stood on this sentence. It is true only for the rules that need evidence of a gain. It is false for every rule that needs evidence of harm. Those rules are point estimates with no interval, so low power lets harm through:
  - Record test, rule 4: if full truly trails layer 1 by exactly the margin (1 probe), the observed mean trails by 1 or more only **50%** of the time. A hook that costs one recalled fact in five is kept half the time.
  - Eval non-inferiority, 10 runs, baseline 0.7: a true loss of 0.2 is vetoed 41% of the time (kept **59%**). A true loss of 0.3 is kept **40%**. Both hooks' non-inferiority checks (`recall-paraphrase`, `null-rename`) have this form.
- **What breaks if we ship it as-is:** The plan tells the reader its error runs only toward CORE losing, and it does not. A prompt hook whose "search yourself" line makes paraphrase answers worse (R3-PR-08's mechanism) ships 40–60% of the time. The plan's chosen direction of error is real for the gain rules and reversed for the harm rules.
- **Suggested fix:** Write every harm check as a true non-inferiority test: kept only if the lower 95% bound of (with − without) is above −margin. Then low power makes the hook lose here too, and the sentence in D1, D2, and D3 becomes true.
- **Evidence:** v4-d1.md:233; v4-d2.md:309, 321; v4-d3.md:580–582, 1461; round-3/practitioner.md R3-PR-06; v4-d4.md R3-PR-06 rebuttal. Simulation, Bin(10, p) means.

### R4-PR-05  —  major
- **Artifact:** D3 (and D2 §7)
- **Location:** GATE.md JSON `"prompt_hook": {"ahead": ["recall-distractors"], …}`; `"early_stop": {"cases": [three recall cases], "files_at_least": 0.9}`; 0.6, "The `-files` twins give **files**"; 7.1, "a `-files` twin with no block".
- **What is wrong:** These are the H4 and H17 fixes. The prompt hook is now kept or shelved on one case, `recall-distractors`. It is compared with full, recall off, which has the instruction block ("look in _memories/"), `Grep`, and the brief in context. The answer sits in the only file whose summary holds both "v2" and "support". None of the 295 distractors contains "v2". So `grep -ril "v2"` returns two files, and that arm sits near the ceiling. R3-PR-05 showed this for literal recall, and H4 moved the whole prompt-hook decision onto exactly that case. Arithmetic at 10 runs:
  - baseline 0.9: a perfect hook (1.0) clears +0.2 **26%** of the time, and no hook at all **12%**;
  - baseline 0.5: no hook clears it **25%** of the time.

  The early stop that should catch the ceiling is measured on the `-files` twin, which has no block and no instruction to look anywhere. It can score far below 0.9 while the arm the hook must actually beat scores 0.95, so the stop does not fire.
- **What breaks if we ship it as-is:** The prompt hook, the Antigravity turn marker, and their tests get built and paid for, and the decision on them is close to a coin weighted against them. The result cannot tell a hook that works from none. "Prompt hook: not kept" will be read as evidence against word-matching recall when it is evidence about the fixture.
- **Suggested fix:** Measure headroom with a `-block` twin (record plus block, no skills) and stop when it scores 0.9 or more. Judge the prompt hook on at least two recall cases where that twin scored 0.7 or less, frozen from the headroom run. If none qualifies, write "prompt hook: not measurable on this fixture", which is not kept.
- **Evidence:** v4-d3.md:598, 608, 623 (distractor vocabulary: no "v2"), 628, 1268, 1273; round-3/practitioner.md R3-PR-05; v4-d4.md H4, H17.

### R4-PR-06  —  major
- **Artifact:** D3 (and D2 §7)
- **Location:** GATE.md, "**Session-start hook.** Full, recall off, against layer 1: at least 2 of the 3 ahead cases ahead by 0.2, a mean gap over the three of 0.2"; JSON `"ahead_cases": ["recall-distractors", "proactive-due", "brief-budget"]`.
- **What is wrong:** H5 (for R3-PR-05) took the zero-gap cases out of the mean. H4 then reused the same three ahead cases for the session-start hook, and that put a zero-gap case back in. With `recall: off` the session-start hook adds the status block and the brief. The risk in `recall-distractors` has no `by-when`, so it is not in the queue, and `PROJECT.md` does not mention it. The hook has no mechanism there. The two cases left, `proactive-due` and `brief-budget`, both turn on one planted item (`dc-20261020-058`, due today) and share the grader `mentions-due: retention`. So "2 of 3" is one observation scored twice, and the mean over three demands an average lift of 0.3 on those two. Simulated, with a true lift of +0.3 on both: passes **51%**. The same lift with headroom on all three cases would pass 80%.
- **What breaks if we ship it as-is:** The session-start hook, the one part of Layer 2 that delivers Interact, is shelved about half the time when it truly helps. When it is kept, the evidence is one fixture item, not the hook's other claims (the handoff line, the fork lines, the brief after compaction).
- **Suggested fix:** Give the session-start hook its own ahead list from cases where it has a mechanism, with distinct planted items: `proactive-due`, `brief-budget`, `resume-from-handoff`. Freeze that list in GATE.md before the first run.
- **Evidence:** v4-d3.md:580, 595, 600–603 (scored graders), 620–621 (the risk has no `by-when`), 1273–1276; v4-d4.md H4, H5.

### R4-PR-07  —  major
- **Artifact:** D3
- **Location:** 2.1, "Repetitions interleave: repetition 1 of every arm, then repetition 2"; 7.2, "Same model and script as 2.3, so `cells.mjs` pairs full's repetition i with layer 1's repetition i from `docs/sessions-kill.json`"; 2.1 records only "the model".
- **What is wrong:** Interleaving exists to cancel drift between arms. Step 7.2 then pairs full, run after phases 3–6, with layer 1 runs made before phase 3, days or weeks earlier. Claude Code ships several releases a week. Auto memory's policy, the system prompt, and `-p --resume` behaviour can change between them, and every arm has auto memory on. `--model` pins only the model id. The record files store no `claude --version`, and `cells.mjs` checks model ids for eval files only. Pairing repetition i with repetition i also buys nothing: the two share no seed, fixture state, or time.
- **What breaks if we ship it as-is:** Rule 4 (full against layer 1 on the record test) measures hooks plus harness drift. A change in auto memory between the two dates can veto both hooks, or hide real harm, and the build log records it as the hooks' effect.
- **Suggested fix:** In 7.2, run `--arms full,layer1` together, interleaved, and pair only within that file. Record `claude --version` per repetition, and mark a pair not measured when the versions differ.
- **Evidence:** v4-d3.md:889, 895 ("the model"), 903 (model check for eval files only), 1321.

### R4-PR-08  —  major
- **Artifact:** D3 (and D2 §2, §7)
- **Location:** 2.1, "After each unclosed session, move every receipt `t` back 3 hours"; facts "found only in `_core/inbox.md`" reported apart; turn 3 is "Then wrap up the session." or "Thanks, that's all for now."; `core` section 2, "Proposals in `_core/inbox.md` → offer them … each yes goes through `remember`"; contract E `no-handoff`, "newest row older than 2 hours"; 1.7, "Take the newest unclosed session only".
- **What is wrong:** This is the H7 fix for R3-PR-07, which asked for scripted "yes" turns. The catch-up now fires, but the test cannot see whether it helps, for two reasons.
  1. **No yes is ever given.** Proposals sit in the inbox, so a catch-up fact can never reach `_memories/`, where the probes and the prompt hook look. Full pays for the helper run and the offer turns, and its probe score can only stay the same or fall.
  2. **The time shift makes coverage up.** Each unclosed session is followed by a 3-hour jump, so every one becomes `no-handoff` and gets read. Real work comes in bursts, with sessions less than 2 hours apart. Then the previous session is not yet `no-handoff` when the next one starts. Later only the newest is read, and the rest are closed `skipped`. Six quit sessions in a day give one catch-up and five skips (83% unread), while the test shows 100% read.
- **What breaks if we ship it as-is:** D2 says the three turns exist "so the catch-up can fire". The record test reports a catch-up coverage that real use will not reach, and a catch-up benefit fixed at zero. Rule 4 then charges full for the catch-up's cost with no way to credit it.
- **Suggested fix:** Open each next session in every arm with a scripted "Yes to all CORE proposals", so the inbox path can land, and count those facts. Add a burst schedule (sessions 30 minutes apart, one 3-hour gap) and report the share of unclosed sessions actually read next to the share skipped.
- **Evidence:** v4-d3.md:339, 687, 804–807, 887, 893, 895; v4-d2.md:168–170, 302; round-3/practitioner.md R3-PR-07.

### R4-PR-09  —  major
- **Artifact:** D3 (and D2 §2, §6)
- **Location:** 4.7, "`data.written` lists ids in `_memories/` … that are new or whose size or mtime changed" since `_core/snap-<sid>.json`; 1.6 step 5, "Count the writes you attempted … Fewer on disk than attempted → 'broken: N writes did not land'"; D2 §6, "Counts come from disk, beside the writes attempted".
- **What is wrong:** This is the H9 fix for R3-GA-03 and R3-RD-05. The snapshot is taken when this session starts. Anything another session writes in the same project afterwards is counted as this session's write. Two sessions open on one project is the normal case for this user (R1-PR-10 described several sessions at once). Scenario: session A tries 2 writes, one silently fails. Session B, in another terminal, writes 1 memory. At A's close the disk shows 2 new files, A attempted 2, and the line reads "Closed. 2 written; 2 writes attempted." The failed write is hidden, and B's memory is reported as A's. The comparison is by count, never by id.
- **What breaks if we ship it as-is:** The one check built to catch "claimed writes that did not land" reports success over a write that did not land. That is the plan's defect class.
- **Suggested fix:** Compare by path. Every path the agent attempted that is absent from disk is "did not land". Every path on disk that was not attempted is listed as "also written by another session" and kept out of this session's count.
- **Evidence:** v4-d3.md:794, 1030; v4-d2.md:160–164, 258; round-1/practitioner.md R1-PR-10.

### R4-PR-10  —  major
- **Artifact:** D3
- **Location:** 0.6, "Caps assume about $0.25 per run, an estimate … Exit 2 means the cost cap stopped it: log the cases that never started as not measured; do not rerun"; 2.3 step 3, `dist/core-layer1 … --tag kill … --max-cost-usd 5`; 7.1 runs 3 and 4, `--tag gated … --max-cost-usd 15`; run 1, `--tag gated --tag suite … --max-cost-usd 35`.
- **What is wrong:** The caps on the deciding runs equal the estimate, with no margin.
  - Kill eval, layer 1: `proactive-due` and `canary-layer1`, both tagged `kill`, 10 runs each: 20 × $0.25 = **$5.00** against a $5 cap.
  - Recall off: five gated cases plus `canary`, 60 runs = **$15.00** against $15. Layer 1: five plus `canary-layer1` = **$15.00** against $15.
  - Full: 60 gated runs plus about 23 suite cases × 3 = about 129 runs = $32.25 against $35.

  Every gated fixture holds 300 memory files and allows 30 turns. A run that greps and opens a few files can easily cost more than $0.25.
- **What breaks if we ship it as-is:** One cent over the estimate stops the run. The cases not yet started are "not measured", reruns are forbidden, and a not-run canary can void the whole file. By GATE.md, a not-measured kill test stops the build ("Do not ship CORE"), and not-measured hooks are shelved. CORE can be cancelled by a budget line, and the report will say "not measured" where it should say "under-budgeted".
- **Suggested fix:** Set each deciding cap to at least twice the estimate. Or first run one case once per arm, log the real cost, and set the caps from that before the gated runs. Allow one logged rerun of not-started cases with a higher cap.
- **Evidence:** v4-d3.md:627, 912, 915, 1236 (runs: 10 for gated), 1279 (`canary-layer1` tagged `gated`, `kill`), 1308–1311.

### R4-PR-11  —  major
- **Artifact:** D3 (and D2 §7)
- **Location:** 9.4 gate table, "Against v3 | … v4's mean is not more than 0.1 below v3's, and the blind judge does not prefer v3 on more cases than v4"; 0.6, GATE.md's JSON block (no v3 key); 9.4 Accept, "one verdict line per GATE.md rule".
- **What is wrong:** The one comparison against a prior version has no frozen number and no outcome. Its 0.1 margin and its blind-judge rule are not in GATE.md, so they are not frozen before the first run, and `cells.mjs` never rules on them. The verdict list says what happens to Layer 1 and to each hook, and nothing about a v4 that loses to v3. The margin is also smaller than the noise. Two of the four cases run 3 times (`recall-past-decision` and `finalize-handoff` are not gated), two run 10 times. The standard error of the mean difference is up to about 0.165, so at true parity the gate fails about **27%** of the time.
- **What breaks if we ship it as-is:** A v4 measured as worse than v3 still ships, because nothing says what to do. Or the executing agent improvises a branch after seeing the numbers, which is the moving goalpost the frozen gate exists to prevent. Requirement 7's "against a prior version" becomes a number that is printed and then ignored.
- **Suggested fix:** Put the v3 rule in GATE.md's JSON before any run, with an outcome: "v3 ahead beyond the margin, with a paired interval above zero → 9.4 is `BLOCKED` for a person to decide". Use a margin that clears the noise, or report the comparison and do not gate on it.
- **Evidence:** v4-d3.md:586–612 (the JSON keys), 1236, 1272, 1297, 1424, 1431–1437; v4-d2.md:325–327.

### R4-PR-12  —  minor
- **Artifact:** D3
- **Location:** 2.1 step 5, "A blind grader — a fresh `claude -p` in an empty folder, no tools, given only the probe, the key's answer, and the arm's answer — replies PASS or FAIL."
- **What is wrong:** R3-PR-06 asked for the runner's 2-of-3 judge vote on probes. The rebuttal covered only the number of repetitions, and the vote was neither applied nor rebutted. Each probe still gets one judge call. The grader's model is not named either: `--model` is given for the sessions, not for the grader, and GATE.md's `judge_model` is used only by the eval. Between 2.3 and 7.2 the grader can be a different default model.
- **What breaks if we ship it as-is:** Judge flips add variance to a five-probe score whose interval already decides CORE's existence. A change in the default model between the kill test and the full arm moves rule 4 with no change in CORE.
- **Suggested fix:** Run the grader with GATE.md's `judge_model` and take 2 of 3 votes per probe.
- **Evidence:** v4-d3.md:586, 894; round-3/practitioner.md R3-PR-06; v4-d4.md R3-PR-06 rebuttal.

### R4-PR-13  —  minor
- **Artifact:** D3 1.9 (and D2 §7 "On your own project")
- **Location:** `blind-check.md`, "the user marks each still true or not. That mark is the answer key … A memory marked false counts against the record. Report the tally, the share marked true".
- **What is wrong:** This is the H17 fix for R3-PR-10 and R2-PR-20, and the comparison is still settled by construction. Each question is written from one memory. The with-record helper answers from that memory. The without-record helper is told there is no record, and the facts in question are, by `remember`'s own test, ones the code does not show. So a memory marked true makes the record win, and one marked false makes it lose. The tally is the share marked true, printed a second time.
- **What breaks if we ship it as-is:** `metrics` shows the owner "the record won 9 of 10, a direction" when all it has learned is that 9 of 10 memories are still true. The check can never show that the record fails to help on a true memory, for example by making the agent answer worse.
- **Suggested fix:** Report it as what it is: "store accuracy: N of 10 still true". Or give the without-record helper the code and git log, and count only memories marked true, so the tally can come out against the record.
- **Evidence:** v4-d3.md:762 ("Usually no: what the code or git history shows"), 862; v4-d2.md:331.

### R4-PR-14  —  minor
- **Artifact:** D3 contract E and F (and D2 §3)
- **Location:** Contract E, "`due` … `by-when` is past or within `now_hours` → `now`" and "`deferred` | An active `open-question` has `deferrals` ≥ 2 → `soon`"; contract F, "At most 3 `now` and 3 `soon` items".
- **What is wrong:** Nothing merges queue items by id. An open question that is put off twice and due today makes two items: `due/now` and `deferred/soon`. The status block names it under "Needs you now" and again under "Soon". The gated fixture's key item, `dc-20261020-058` (`deferrals: 2`, `by-when: $TODAY`), is exactly this case, so every gated eval run sees the duplicate. The 5.3 test plants "two `now` and two `soon` items" with different ids, so it cannot catch it.
- **What breaks if we ship it as-is:** Focus's promise, "an item raised this session is not raised again", fails at the very first line of a session. The most urgent item is listed twice and takes two of the six slots. In `brief-budget`, the judge's "8 lines or fewer" depends on whether the agent repeats it.
- **Suggested fix:** Merge queue items by id. Keep the highest level and join the reasons ("due today; put off twice"). Add that case to 4.6's test.
- **Evidence:** v4-d3.md:334–336, 391, 620, 1062 (5.3 Accept), 1276; v4-d2.md:187.

---

Sound and worth keeping: arms interleaved within a run; the kit (not files) as the named fallback; one fixed list of scored graders across arms; receipts that record `how` a session closed; status by folder.

critical 2 · major 9 · minor 3 · taste 0
