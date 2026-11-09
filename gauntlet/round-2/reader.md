# Round 2 — Reader review of v2 (D1–D4)

Mandate: defend a distracted reader's attention. D3 is judged as an agent reads it, for misreading, not length. D4's ledger is judged on whether a person can find what matters in it. Round-1 findings (all seven reviewers) and the D4 ledger were read first. Where a round-1 fix is incomplete or broke something, the earlier ID is cited.

---

### R2-RD-01  —  major
- **Artifact:** D1
- **Location:** "The short version": "**The verdict: keep CORE, but as a habit first and a program second.** Ship the file layout and five short skills to everyone." Against §8: "**Keep CORE, cut it to a twentieth, and make the code earn its place.** **As a product for other people:** no."
- **What is wrong:** The first screen and §8 give the verdict in two different slogans, and they disagree on who it is for. The first screen says to ship Layer 1 "to everyone". §8 says CORE is not a product for other people, and that it is kept "for our own use — one person". "Everyone" probably means "every harness", but the words say every user. The "not a product" half of the verdict is missing from the first screen.
- **What breaks if we ship it as-is:** A skimmer who reads only the short version reports "ship CORE to everyone". A reader who reads only §8 reports "keep it for one person, not as a product". The contract requires a reader to be able to state the verdict, and the two readers state different ones. The round-1 fix for R1-RD-02 put the position first in §8 but did not carry it to the first screen.
- **Suggested fix:** Use one verdict sentence in both places, for example: "Keep CORE for its one user, at a twentieth of its size. Layer 1 ships on every harness; the code stays only while it beats Layer 1." Delete "to everyone" and the "habit/program" slogan.
- **Evidence:** v2-d1.md:15, 214–218, 222.

### R2-RD-02  —  major
- **Artifact:** D1, D2, D3
- **Location:** D1 "The short version" item 1: "**The convention.** A file layout, five short skills, and a short block for `AGENTS.md`"; D1 §4: "Layer 2 is kept only while it beats Layer 1 in the test in section 8"; D1 §8: "the convention (files plus `AGENTS.md` block, no plugin)"; D2 §7 arm table: "**Convention** | The record and the `AGENTS.md` block, no plugin — the honest runner-up"; D1 §6: "The kit is the honest runner-up."
- **What is wrong:** Two labels each name two different things. "The convention" is Layer 1, which includes the five skills. It is also the test arm, which has no skills, because skills arrive only with the plugin. "The honest runner-up" is "the kit" in D1 (AGENTS.md, built-in memory, Backlog.md, connectors, a scheduled task). In D2 it is the convention arm. So the sentence a reader takes away, "Layer 2 is kept only while it beats Layer 1", is not what the gate measures. The gate compares plugin (skills plus wiring) against files plus the block. The skills and the wiring are never separated.
- **What breaks if we ship it as-is:** A reader believes the blind test isolates the code and keeps Layer 1's skills either way. In fact a "keep Layer 2" result could come entirely from the five skills, and the plan would keep 1,800 lines of code on the skills' merit. A reader comparing D1 §6 with D2 §7 cannot tell which runner-up the plan means.
- **Suggested fix:** Rename the arm to what it holds ("files + block"). Write "plugin minus files + block" in D1, D2, and D3. State once in D1 §8 that the gate measures skills and wiring together. Keep "runner-up" for the kit only.
- **Evidence:** v2-d1.md:15, 23–24, 127, 190, 223; v2-d2.md:18–19, 234, 238; v2-d3.md:998, 1043, 1138. The same split is visible in round-1/defence.md F6(a) ("files plus the `AGENTS.md` block, no plugin") against F11 ("Layer 1 … the file layout, five skills, and the `AGENTS.md` block").

### R2-RD-03  —  major
- **Artifact:** D1
- **Location:** §8, the bullet "**Layer 2 must pass a test.** Two measurements, both on Claude Code. First, its test runner scores the same tasks under four arms … **or** if the plugin clearly keeps the better record in the second."
- **What is wrong:** The kill test is the heart of the verdict, and it is written as one 127-word bullet. It holds two measurements, four arm names, a three-part threshold, and an "or". "Arm" is never defined in D1 or D2. The decision rule comes in the fifth sentence. The second half of the rule reads "clearly keeps the better record", which is the same vague wording R1-RD-08 raised about the first half. D3 9.4 gives a number ("beats the convention's by at least 1 (of 5) on the mean, with a write rate no lower"), and D2 §7 gives no threshold for the ten-session run at all.
- **What breaks if we ship it as-is:** A distracted reader skips the bullet and cannot say what would kill Layer 2. A careful reader finds the rule strict in its first half and undefined in its second, so they cannot tell how easily Layer 2 survives. The fix for R1-RD-08 gave the first threshold a scale but left the second one vague.
- **Suggested fix:** Replace the bullet with two short lines and push the method into D2: "Layer 2 stays if it adds 0.3 (on a 0-to-1 score) over files plus the block, or if it gets at least one more of five planted facts right in a ten-session run. Otherwise it is dropped. Method: D2 §7." That is shorter than the current bullet.
- **Evidence:** v2-d1.md:223 (127 words); v2-d2.md:253–255; v2-d3.md:1138.

### R2-RD-04  —  major
- **Artifact:** D1
- **Location:** §8, "Three honest limits on that test. … And it cannot see Claude Code's built-in memory, because the test runner switches that off."
- **What is wrong:** "That test" covers both measurements just described. The second one, the ten-session run, has an arm for Claude Code's built-in memory. D2 says it "drives ten `claude -p` sessions … for three arms: the plugin, the convention, and Claude Code's built-in memory alone", and D3 7.7 builds an arm called `builtin`. D1 never mentions that arm, and tells the reader the opposite.
- **What breaks if we ship it as-is:** A reader of D1 concludes that CORE is never compared with the harness's built-in memory. Yet "Harness built-ins only" is the first alternative D1 rejects, and the question a professional would ask first. The reader either dismisses the case as untested or quotes a limit that is not true. The plan's one direct comparison with the built-in is hidden by its own summary.
- **Suggested fix:** Change the sentence to "The four-arm runner cannot see built-in memory; the ten-session run includes it as a third arm, reported but not gated."
- **Evidence:** v2-d1.md:226; v2-d2.md:255; v2-d3.md:1043.

### R2-RD-05  —  major
- **Artifact:** D2 (and D3 §4.3)
- **Location:** D2 §2: "**You go quiet.** … The watcher prints one line. The agent is idle, so it waits for your next message and opens with: …"; D2 §4 Interact: "the watcher on Claude Code; elsewhere new items ride along with your next prompt"; D2 §11: "**Between-prompt reminders exist only on Claude Code**".
- **What is wrong:** The fix for R1-RD-09 made the watcher story explicit, and what it now shows is that the watcher changes nothing here. On Claude Code the idle agent waits for your next message. That is exactly what D2 §4 says happens "elsewhere" through the prompt hook, which D3 contract F also has announce new items. The only case where the watcher helps is the one-line aside "If you had been mid-conversation…". §11 then claims a "between-prompt" reminder that §2 has just shown does not happen. D3's `core` skill says something different again: speak "when a `CORE: new item` line arrives".
- **What breaks if we ship it as-is:** A reader cannot say what a Claude Code user gets that a Codex user does not. That difference is the reason D1 §6 rates CORE 4's Interact above the kit's, and the reason the watcher is in the build at all. A reader who notices the contradiction stops trusting §11.
- **Suggested fix:** Lead the beat with the case the watcher exists for: "You are mid-task when the reminder comes due. The agent finishes its current step and mentions it, without waiting for you to type." Then state the idle case in one clause. Make §11 and D3 4.3 section 3 use the same rule.
- **Evidence:** v2-d2.md:91, 118–122, 143, 159, 349; v2-d3.md:368, 755; v2-d1.md:182.

### R2-RD-06  —  major
- **Artifact:** D3
- **Location:** Step 4.3 `core` description: "whenever a line starting with "CORE:" is in context"; section 3: "only at a boundary: … or when a `CORE: new item` line arrives"; step 4.4 `pulse` description: "Use when a "CORE: new item" line arrives"; `pulse` section (3): "speak only if a `now` item is new, otherwise say nothing".
- **What is wrong:** One watcher or prompt-hook line matches two skills, and they give opposite instructions. `core` says to raise the item. `pulse` says to run the queue, refresh stale sources through MCP, and speak only if the item is "new". "New" is not defined in `pulse`. The only definition in D3 is "not in `data.recent`". But the watcher and the prompt hook both write an `announce` receipt before the agent sees the line, so by that definition the item is never new by the time `pulse` runs.
- **What breaks if we ship it as-is:** The executing agent writes both skills as specified. At runtime, the agent that receives a reminder either loads `pulse` and stays silent, or loads both and starts a source refresh (a helper agent and MCP calls) every time a reminder fires. Either way the one moment that shows Interact goes wrong, and no test in 7.6 catches it: `proactive-due` runs headless, where neither the watcher nor the line occurs.
- **Suggested fix:** Give the `CORE: new item` line to `core` only. Delete "when a "CORE: new item" line arrives" from the `pulse` description, and define "new" in `pulse` section (3) as "not yet said in this session".
- **Evidence:** v2-d3.md:368, 737, 748, 755, 778, 782; v2-d3.md:315 (`data.recent` built from `announce` receipts).

### R2-RD-07  —  major
- **Artifact:** D3
- **Location:** Step 7.6 "**The six grader types** (from the runner's docs [G 4.1]): `regex` (a pattern found, or with `match: not_contains` absent, in a `target`: …)"; table cells "`llm` with `focus: trace`", "`llm` with `focus: last_message`", "(`arm: with-only`)"; Files: "`graders/*.md`".
- **What is wrong:** The fix for R1-RD-06 added a legend, but it is incomplete. The legend defines `match` and `target`. It does not define `focus`, which five cases use, or `arm`, which one case uses. No grader file is shown, so the agent still does not know what a `graders/*.md` file looks like: which keys, where the rubric goes, and whether one file holds one grader or several. The legend is also a single 80-word sentence with nested parentheses, and the agent has to take it apart to build about 27 cases.
- **What breaks if we ship it as-is:** The zero-context agent has to guess the grader file format and the `focus` and `arm` keys. A key the runner does not recognize may be ignored. If `arm: with-only` is ignored, `untrusted-project-inert` is graded in both arms. If `focus` is ignored, the judge is shown different text from the one the rubric assumes. A grader that is silently ignored passes while checking nothing, which is the defect class the plan exists to kill.
- **Suggested fix:** Replace the sentence with a six-row table (type, keys, example), add `focus` and `arm` to it, and show one complete grader file, such as `remember-decision`'s. To keep the length flat, cut the "Tests" column of the case table: the case names already say which job each case tests.
- **Evidence:** v2-d3.md:981–982, 1011, 1017–1019, 1023, 1030; round-1/reader.md R1-RD-06 asked for "one complete example `graders/*.md`".

### R2-RD-08  —  major
- **Artifact:** D4
- **Location:** Part 3, rows R1-PA-10, R1-PR-13, R1-GA-25, R1-RD-01, R1-RD-19: "Accepted in part | See partial rebuttals | Rebuttal accepted by reviewer".
- **What is wrong:** D4 has no section called "partial rebuttals". The pointer was copied from `round-1/defence.md`, where that section exists (defence.md:215). So the five rows where the plan pushed back on a reviewer have no reason in D4. These are the only rows that are not plain acceptances. The "How the review was run" section does not say where the rebuttals live either.
- **What breaks if we ship it as-is:** The contract requires D4 to record each finding as "accepted or rebutted, the reason". For exactly the five rebutted findings, the reason is missing. A reader who wants to know what the author refused to change, which is the most useful thing in a critic log, finds a dead pointer. Some of these matter: R1-PA-10 (the verdict had no cost test) and R1-RD-01 (contract letters kept).
- **Suggested fix:** Replace each "See partial rebuttals" with the rebuttal in one sentence, for example "Cost test added as a line-budget trigger; no base-rate kill rule". That is five sentences.
- **Evidence:** v2-d4.md:120, 134, 163, 238, 256; `grep -n "Partial rebuttals" v2-d4.md` → no heading; round-1/defence.md:215, 228.

### R2-RD-09  —  major
- **Artifact:** D4
- **Location:** Part 3 ledger, columns "What was wrong" and "Fix or reason". Examples: R1-FC-13 "Each count is wrong in its own way: | Accepted | F13"; R1-FC-16 "These claims cite the wrong place: | Accepted | F13"; R1-EX-06 "Four problems in one step. | Accepted | F10 — step 0.4 split and clarified"; R1-EX-15 "Several graders pass or fail regardless of what the agent does. | Accepted | F6g".
- **What is wrong:** A ledger row cannot be read on its own. 88 of 146 "Fix" cells are bare codes (F6g, F10, F12, F13) that are defined only in another file. One code is circular: F13 is defined as "Factual corrections as listed per finding", and the per-finding entry is "F13". So for R1-FC-13, -15, and -16, what was fixed is recorded nowhere. "What was wrong" is cut at about 150 characters, often mid-sentence. At least six rows are cut right after a colon, before the problem is named. The ledger runs 6,626 words, longer than D1, and still needs `defence.md` open beside it.
- **What breaks if we ship it as-is:** A person reading D4 cannot answer "what was wrong, and what changed?" for most rows. That is the question a ledger exists to answer. Checking whether a fix landed means opening two other files per row, so nobody does it. The extra length bought completeness on paper only.
- **Suggested fix:** Make each row one plain sentence for the problem and one for the fix. Drop the Round column (always 1), the Reviewer column (the ID already says it), and the Judge column ("—" in 140 of 146 rows). Give the one judge ruling and the five rebuttals in prose under the table. The ledger gets shorter and stands alone.
- **Evidence:** v2-d4.md:109–256; `awk` over the ledger: 88 bare-code fix cells, 140 judge cells "—"; round-1/defence.md:25 (F13 definition), :88–91.

### R2-RD-10  —  minor
- **Artifact:** D4
- **Location:** First screen ("This document does not defend the plan. Part 1 attacks…"); Part 1's twelve items; Part 3 headline: "141 accepted; 5 rebutted in part, each accepted by its reviewer; 1 partial rebuttal disputed and overturned by the judge"; Alternatives: "Six partial rebuttals were written; five stood and one was overturned."
- **What is wrong:** D4 never says what matters most. Part 1's twelve objections carry equal weight, with no ranking. The ledger is sorted by reviewer, so the 14 critical findings are spread across 146 rows. The headline counts do not add up on their face: 141 + 5 + 1 is 147, not 146, because the overturned rebuttal is also counted in the 141. The text says "5 rebutted in part" in one place and "Six partial rebuttals" in another.
- **What breaks if we ship it as-is:** A reviewer who has five minutes cannot find the plan's three weakest points or the critical findings. They scan the whole ledger or give up. The mismatched counts make a careful reader doubt the bookkeeping, in a plan whose subject is honest counting.
- **Suggested fix:** Open D4 with three lines: the strongest three objections from Part 1, and "14 critical findings in round 1; all accepted; listed first below". Sort the ledger by severity, then by ID. Write the count as "146 findings: 140 accepted, 1 accepted after the judge overturned its rebuttal, 5 rebutted in part".
- **Evidence:** v2-d4.md:7–9, 107, 109–256, 266.

### R2-RD-11  —  minor
- **Artifact:** D4
- **Location:** Part 1 item 1 "The step labels make this visible"; item 2 "'1 of 5 probes'"; item 4 "`EVAL_CORE_ENABLE` works only if the runner places the plugin data folder under the system temp folder"; item 9 "a reported crash on an injected field … the `PreInvocation` deduplication … labeled `[live install]`"; item 11 "wrapper seams".
- **What is wrong:** The Part 1 rewrite fixed R1-RD-07's factual errors but brought in new undefined terms: an environment variable, a harness event name, a D3 step label, an internal CORE 3 term ("wrapper seams"), and D3 jargon ("probes", "plugin data folder"). Part 1 is the section a skeptical reader opens first.
- **What breaks if we ship it as-is:** Items 4 and 9 are among the strongest objections in Part 1: the test may silently measure the wrong path, and Antigravity is written blind. A reader who cannot decode them skips them, so the critic log hides its own best points.
- **Suggested fix:** Say each in plain words. For item 4: "Test runs are switched on by a setting that only works if Claude Code puts its plugin data in the temp folder; if it does not, every case quietly tests 'CORE not enabled'." For item 9: "the rule that stops Antigravity's hook from firing twice per prompt". Drop "wrapper seams" or give it three words.
- **Evidence:** v2-d4.md:17, 21, 29, 49, 57; round-1/reader.md R1-RD-07.

### R2-RD-12  —  minor
- **Artifact:** D2, D3
- **Location:** D2 "In one minute": "Every check ends in one of three words, and this is the only mapping used anywhere"; D3 contract E "it goes in `data.unmeasured`"; D3 7.4 "returns each item as a value or `{"unmeasured": "<reason>"}`"; D3 7.4 table "elsewhere unmeasured".
- **What is wrong:** R1-RD-05 asked for two things: one line mapping the three outcomes, and renaming the `unmeasured` keys to `unknown`. v2 did the first and not the second. D2 then claims the mapping is the only one "used anywhere", which is not true while D3 still uses `unmeasured`. The same file has a metric called `unknown_rate` next to `unmeasured` values.
- **What breaks if we ship it as-is:** An auditor or a test that searches for `unknown` to confirm nothing hides it misses the `unmeasured` paths in `queue` and `metrics`. That is the blind spot R1-RD-05 described, and it is still open.
- **Suggested fix:** Rename `data.unmeasured` and the metrics key to `unknown` (with a reason). Delete "and this is the only mapping used anywhere" from D2.
- **Evidence:** v2-d2.md:21; v2-d3.md:316, 724, 936, 943, 948.

### R2-RD-13  —  minor
- **Artifact:** D1, D2
- **Location:** D1 §1 job table ("In CORE 3"); D1 §4 "What the harness does, and what CORE adds"; D2 §4 "How each job gets done" (columns How · Harness provides · CORE adds · CORE 3 today). D2 §4's Interact row says "'speak at a pause, once'" and its Focus row, two lines below, says "speak at a boundary".
- **What is wrong:** The five-jobs grid is printed three times. D2 §4 repeats both D1 tables cell for cell and adds a "How" column. The copies have drifted. D1 has CORE add to Recall "a one-line-per-memory index; three pointers or nothing", while D2 has "the index, the matcher, the cap, the 'information, not instructions' frame". The one table still mixes "pause" and "boundary" for the same rule, which R1-RD-13 asked to make one phrase.
- **What breaks if we ship it as-is:** A reader of both documents reads the same grid twice and has to work out whether the differences mean anything. The five-column D2 table has 40–60-word cells, so on a narrow screen it is the table most likely to be skipped. The only new content, "How", is lost in it.
- **Suggested fix:** Keep D1 §4's two-column table as the summary. Cut D2 §4 to the "How" column as five short paragraphs, and point to D1 for the rest. Use "speak at a pause, once" everywhere, including D3 4.3 section 3.
- **Evidence:** v2-d1.md:82–88, 131–138; v2-d2.md:155–161; v2-d3.md:755.

### R2-RD-14  —  minor
- **Artifact:** D2 (and D1 §4)
- **Location:** D2 §7 "Numbers with a stated basis": "Session-start cost | about 4,000 tokens | The `core` skill body, the brief, and the status block. Measured, not estimated, after the build."
- **What is wrong:** The Basis column is where a reader looks to see whether a number is real. For this number it starts "Measured", but the number is an estimate today. The sentence means "will be measured after the build". D1 §4 repeats "about 4,000" with no basis at all.
- **What breaks if we ship it as-is:** A skimmer reads the 4,000-token start cost, an 8× cut from CORE 3 and one of D1's headline gains, as measured. In a plan built to stop "not measured" from reading like "fine", the plan's own prose makes that mistake.
- **Suggested fix:** Write "Estimate. Replaced by a measured value after the build (D3 9.4)."
- **Evidence:** v2-d2.md:272; v2-d1.md:146.

### R2-RD-15  —  minor
- **Artifact:** D1
- **Location:** §5: "Claude Code will run a plugin's test cases with and without the plugin and report the difference [G 4.1] — a comparison CORE 3's changelog says "exists anywhere in this codebase" not at all [evaluation §2.8]."
- **What is wrong:** The fix for R1-FC-12 (a misquote) left a sentence that does not parse. The quote is cut so that it says the opposite of what it means, and "not at all" is tacked on after it. D2 §7 has the clean version: "its changelog says 'no matched memory-on/off comparison exists anywhere in this codebase yet'".
- **What breaks if we ship it as-is:** The reader stops on the one sentence in §5 that shows CORE 3 never measured itself. A quick reader may take the quoted words at face value: that the comparison "exists anywhere in this codebase".
- **Suggested fix:** Use D2's wording: "CORE 3 never ran that comparison; its changelog says 'no matched memory-on/off comparison exists anywhere in this codebase yet'."
- **Evidence:** v2-d1.md:160; v2-d2.md:227.

### R2-RD-16  —  minor
- **Artifact:** D3
- **Location:** Contract C example: "summary: Retry header moves to the v3 format; v2 sandbox is back up" against the body "Decided 2026-11-09 after the provider's v3 sandbox came back"; contract D repeats the summary.
- **What is wrong:** The canonical memory example contradicts itself. The story (D2 §2, the Lantern fixture, and `remember-decision`) is that the *v3* sandbox was down and came back. The summary says *v2*.
- **What breaks if we ship it as-is:** Step 5.1 tells the agent to write memory files from "contract C, with its example", and step 2.1 tests the parser against it. An agent copying the pattern learns that a summary may disagree with its body. A fixture or gold query built from the example plants a wrong fact. Because recall matches summaries only, a query about "v3 sandbox" misses this memory.
- **Suggested fix:** Change the summary to "Retry header moves to the v3 format; the v3 sandbox is back up" in contracts C and D.
- **Evidence:** v2-d3.md:266, 275, 291, 525, 814–815; v2-d2.md:112–114.

### R2-RD-17  —  minor
- **Artifact:** D3
- **Location:** "Rules that never bend" 6: "A hook always exits 0, finishes fast, and leaves a receipt." Against contract F: "**Not a CORE project** … say nothing, write nothing" and "**A CORE project not enabled here:** … No receipt, no `_core/`."
- **What is wrong:** A rule labelled "never bend" is contradicted by the contract it governs. The receipt applies only in enabled projects, a condition contract F states and rule 6 leaves out.
- **What breaks if we ship it as-is:** An agent that reads the rules first, as "How to use" tells it to, builds receipts into every hook path. In a repository that has not been enabled, that creates `_core/`, the leak R1-EX-26 closed. The tests in 3.3 catch it, but only after the agent has built it the wrong way and has to choose between a "never bend" rule and a contract.
- **Suggested fix:** Rule 6: "…and, in an enabled project, leaves a receipt."
- **Evidence:** v2-d3.md:59, 338, 340, 378.

### R2-RD-18  —  minor
- **Artifact:** D2 (and D1)
- **Location:** D2 §1 "Checks the project is enabled on this machine"; §2 "finds the project on this machine's enabled list"; §5 rung table "project enabled", "a fresh machine has no enabled list"; the explanation arrives only at §9, "Nothing runs until you enable the project". D1 mentions enabling only inside a risk-table cell.
- **What is wrong:** "Enabled" decides which rung a user is on, and it is why cloud sessions get files only. It is used six times before the reader learns what it is (a per-machine opt-in) and why it exists (a planted memory in a cloned repository). "In one minute" defines nine terms but not this one.
- **What breaks if we ship it as-is:** A cold reader reaches the rung table and cannot tell why a cloud session, with the plugin installed, sits on "Files only". The cloud limitation then looks like a bug rather than a security choice.
- **Suggested fix:** Add one clause to D2's terms line: "*Enabled*: you have said yes to CORE for this folder on this machine; until then it reads nothing (§9)."
- **Evidence:** v2-d2.md:29, 84, 99, 183, 186, 303–305; v2-d1.md:207.

### R2-RD-19  —  taste
- **Artifact:** D2
- **Location:** §2 "One session, start to finish": "It is Monday … **On Wednesday you just quit.** … On Thursday … **That evening your laptop is shut.**"
- **What is wrong:** The section headed "one session" covers three sessions and a cloud task over four days. The last two beats jump days without a break, and "that evening" could be Wednesday or Thursday.
- **What breaks if we ship it as-is:** The walkthrough is the part a skimmer actually reads. The jump from one session to several costs a re-read at the point where the never-closed-session catch-up is explained.
- **Suggested fix:** Retitle it "A week with CORE", or put the last two beats under a sub-heading "Later that week".
- **Evidence:** v2-d2.md:95–132.

---

Sound: D1 and D2 are shorter than in v1. Hedges and show-off sentences are nearly gone. D2's ok/fail/unknown table and D3's step labels do their job on the first screen.

critical 0 · major 9 · minor 9 · taste 1
