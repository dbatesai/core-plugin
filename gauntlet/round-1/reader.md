# Round 1 — Reader review of v1 (D1–D4)

Mandate: defend the reader's attention. The reader is distracted, skimming, and was never told what CORE is. D3 is judged as an agent would read it.

---

### R1-RD-01  —  major
- **Artifact:** D2, D3, D4
- **Location:** D2 §5 "The rungs, named" (`A — Full` … `E — No file access`); D2 §7 four-cell table (`A — CORE as you use it`, `D — CORE on its first day`); D2 §10 "If it is missing": "Rung D", "Rung C"; D3 Contracts A–K and contract E row `index-stale`: "See D"; D3 step 0.6 "these scores are **B** … and **C**"; D4 Part 2 Q12 "Cell C in D2 §7".
- **What is wrong:** The same letters name three unrelated things: ladder rungs A–E, eval cells A–D, and D3 contracts A–K. Worse, they overlap in opposite directions. Rung D is "files only, no plugin". Cell D is "plugin on, no files". Rung C is "skills only"; cell C is "nothing at all". D2 uses rungs in §5, cells in §7, then rungs again in §10, with no word saying which system a bare "D" belongs to. The cell grid is also lettered out of reading order (D sits top-right, C bottom-right).
- **What breaks if we ship it as-is:** A skimmer reading "Rung D" in §10 two screens after "D — CORE on its first day" in §7 gets the meaning backwards. An agent in D3 reading "See D" in the queue table can go to D2, rung D, cell D, or contract D. A reader of D4 Q12 has to open D2 §7 to decode "Cell C". The letters cost more attention than they save.
- **Suggested fix:** Drop the letters for rungs and cells and use the names already there ("Full", "Hooked", "Skills only", "Files only", "No files"; "plugin + record", "files alone", "nothing", "plugin, empty store"). Write "plugin minus files alone" instead of "A − B". In D3, write "contract D (`INDEX.md`)" every time. The result is shorter, because each letter currently needs a gloss.
- **Evidence:** v1-d2.md:178–182, 230–237, 325–326; v1-d3.md:269, 490, 917; v1-d4.md:80.

### R1-RD-02  —  major
- **Artifact:** D1
- **Location:** §8 "The verdict": "**Does CORE deserve a place in the market?** … **no.**" then "**Does something else replace CORE for our use?** **No, not today.**"
- **What is wrong:** The verdict is the one thing D1 exists to deliver, and its bold text reads "no … No". The first "no" means "CORE should not be a product". The second "No" means "keep CORE". A skimmer who reads only the bold sees two refusals and concludes CORE should die. The actual position ("keep CORE, cut it to a twentieth, make it prove itself") comes only in the third paragraph. "Our use" is also undefined. D1 never says who "we" are until this point, and then only as "one person, three harnesses".
- **What breaks if we ship it as-is:** The contract requires a reader to be able to "state … the verdict". A distracted reader states the opposite one. The question/answer format turns a clear position into a puzzle.
- **Suggested fix:** Open §8 with the position as one bold sentence: "Keep CORE, for one user, at a twentieth of its size. Delete the code if it does not beat plain files in the blind test." Then give the two reasons as plain sentences without bold yes/no answers. Say once, early in D1, that CORE has one user, its maintainer.
- **Evidence:** v1-d1.md:216–220.

### R1-RD-03  —  major
- **Artifact:** D1
- **Location:** §1, "Meanwhile, of the five jobs CORE is meant to do, only one is enforced by code today", and the table that follows; §6 comparison table columns "Remember | Recall | Interact | Update | Focus".
- **What is wrong:** D1 never says what the five jobs are. They first appear as table row labels. "Interact" and "Update" are opaque. A cold reader takes "Update" to mean "update memories", when it means "refresh outside data such as issue trackers through MCP". "Focus" could mean anything. D3 defines all five in five clear bullets ("What you are building"), but D1, the document for the cold reader, does not.
- **What breaks if we ship it as-is:** Half of D1's feature-for-feature table (five of ten columns) is unreadable to its intended reader. "claude-mem: Update — No" looks like a claim that claude-mem cannot edit its own memories, which is not what it says.
- **Suggested fix:** Put each job's meaning in its row label in the §1 table, for example "Update (refresh outside data)" and "Focus (say little, at the right moment)". The §6 header then needs nothing more. This adds about twenty words and no new section.
- **Evidence:** v1-d1.md:67–75, 164; compare v1-d3.md:28–34.

### R1-RD-04  —  major
- **Artifact:** D3 (and D2 §9)
- **Location:** D3 decision 14 "The trust list stays at `~/.core/projects.json`"; command `trust <add|remove|list>`; contract C `trust` is "`user` … `agent` … or `external`"; contract I "`trust` is `internal` or `external`"; D2 §9 "Nothing runs until you enable the project", "Every memory records who it came from".
- **What is wrong:** "Trust" means three different things in D3. (1) A project is on the enabled list (`trust add`, `isTrusted`, "trusted project"). (2) A memory field records who said it, with values user/agent/external. (3) A source field has a different value set, internal/external. D2 and the user-facing hook text call (1) "enabled", so the user and the code use different words for the same act.
- **What breaks if we ship it as-is:** An agent writing a memory from a source with `trust: internal` has no rule for which memory `trust` value to use, and may copy `internal`. `check --project`'s `types` check does not cover `trust`, so the bad value goes unflagged. An agent reading "on a trusted project only" (Phase 3 deliverable) may check the memory field rather than the list. A user who says "enable CORE here" meets docs and code that say `trust add`.
- **Suggested fix:** Name the project list for what the user does: "enabled list", command `enable`/`disable`. Rename the memory field to `from` (D2 already says "who it came from"). Use one value set (`user`, `agent`, `external`) for both memories and sources. That is three renames and no new text.
- **Evidence:** v1-d3.md:87, 229, 239, 383, 408, 592; v1-d2.md:292, 303.

### R1-RD-05  —  major
- **Artifact:** D1, D2, D3
- **Location:** D1 §4 "**working**, **broken**, or **not measured**"; D3 rule 1 "`ok`, `fail`, or `unknown`"; D3 step 7.4 `{"unmeasured": "<reason>"}`; contract E `data.unmeasured`; step 0.5 "mark the other cells 'not verified'"; D2 §6 "**Three exit codes.** 0 … 1 … 3" vs D3 contract A, which has four (2 = bad arguments).
- **What is wrong:** The plan's central idea is that "I could not measure this" is a first-class answer. That answer has five spellings: not measured, unknown, unmeasured, could not measure, not verified. No single line says that `ok` is said as "working", `fail` as "broken", and `unknown` as "not measured". The agent has to infer it from step 5.2's last sentence. D2 tells the reader there are three exit codes when D3 has four.
- **What breaks if we ship it as-is:** An implementer or auditor who searches for `unknown` to make sure nothing hides it misses every `unmeasured` key. That is the exact blind spot the defect class lives in. A skill author may show the user `unknown` or `fail` word for word, which breaks the three-word speech rule.
- **Suggested fix:** Add one line to D3 rule 1: "Say `ok` as working, `fail` as broken, `unknown` as not measured." Rename the `unmeasured` keys to `unknown`. In D2 §6, say "Exit 3 means could not measure" and drop the count "three".
- **Evidence:** v1-d1.md:121; v1-d2.md:202, 268; v1-d3.md:46, 175–180, 274, 472, 798, 883.

### R1-RD-06  —  major
- **Artifact:** D3
- **Location:** Step 7.6 eval table ("`regex not_contains` on `trace`", "`llm` with `focus: trace`", "`regex` on `mock_calls`", "`tool_used` … `input_match` … `min: 0`, `max: 0`", "marked `arm: with-only`") and "If one case cannot be expressed with the six grader types".
- **What is wrong:** D3 promises "This document is all you need". Yet the 22-case table, the specification for about 90 files, is written in a grader shorthand D3 never defines. "The six grader types" are never listed. `not_contains` looks like a grader but is not one of the six. Whether "on `files`" or "on `trace`" are real target names is not said. The `case.yaml` and `graders/*.md` file formats are never shown, and the vendor page that defines them is not linked.
- **What breaks if we ship it as-is:** A zero-context agent either stops to research `claude plugin eval` (the "asking" D3 is meant to prevent) or invents a grader syntax that the runner rejects or silently ignores. A grader that is silently ignored is a test that passes while checking nothing.
- **Suggested fix:** Before the table, add a six-line legend: the six types (`regex`, `tool_used`, `tool_order`, `file_exists`, `llm`, `baseline`), how "not_contains", "on X" and "arm" map to real grader fields, one complete example `graders/*.md`, and the doc URL. Pay for it by deleting the "Tests" column. The case names already say which job each case tests.
- **Evidence:** v1-d3.md:11, 926–956; grounding.md:236 lists the six types, and `not_contains` is not among them.

### R1-RD-07  —  major
- **Artifact:** D4
- **Location:** Part 1 item 2: "the gate sits at the end of nine phases. The plain-files baseline could be measured in a day, before anything is built, and v1 of the build plan does not do that." Item 5: "Antigravity has `/schedule` … The plan declines all four."
- **What is wrong:** D4 attacks a plan that is not the one in D1–D3. D3 step 0.6 measures the plain-files baseline before any hook or skill is built, and stops the build if files alone already pass. D3's own "Alternatives" section names "Build first, measure last" as rejected. D2 §5 and D3 step 4.4 both offer the Antigravity `/schedule` route. Item 5 also uses "sidecars", "`/goal`", and "a sleep tool" with no explanation.
- **What breaks if we ship it as-is:** A reader who trusts the critic log comes away believing the plan's biggest flaw is one it has already fixed, and misses the real weaknesses of step 0.6. For example, 0.6 needs a working `claude` install and falls back to "not measured". A critic log that is wrong about the plan teaches the reader to skip the critic log.
- **Suggested fix:** Rewrite item 2 to attack step 0.6 as written, and correct item 5 to "the plan offers `/schedule` only as a suggestion the user must act on". Cut the unexplained tool names, or give each a two-word gloss.
- **Evidence:** v1-d4.md:21, 33; v1-d3.md:474–495, 746, 1069; v1-d2.md:168.

### R1-RD-08  —  major
- **Artifact:** D1, D2, D3
- **Location:** D2 §7 "Release bar for A − B | +0.3 or more … Below this the gap is within run-to-run noise for a 20-case suite"; D3 step 9.4 "With three runs per arm, a difference smaller than about 0.1 on one case is noise"; D1 §8 "If the plugin does not clearly beat the files alone".
- **What is wrong:** D1's verdict rests on "clearly beat". D2 turns that into "+0.3" without ever saying what it is 0.3 of: a 0–1 pass rate, points, or a fraction of something else. The scale shows up only in D3 (0.9, 1.0). The two documents also give contradictory reasons for the number. D2 says 0.3 is the noise floor for the whole suite. D3 says noise is about 0.1 for a single case. A suite mean is less noisy than a single case, so those two claims cannot both hold.
- **What breaks if we ship it as-is:** The reader cannot tell whether the kill test is strict or lenient, and that test is the whole verdict. The person deciding at step 9.4 meets two different rationales and cannot tell which one to revise after the first run.
- **Suggested fix:** In D2, write "+0.3 on a 0-to-1 pass rate (30 points)". Give one rationale, in one place, and have D1 point to it. Delete the other rationale.
- **Evidence:** v1-d1.md:220; v1-d2.md:261; v1-d3.md:493, 1049.

### R1-RD-09  —  major
- **Artifact:** D2
- **Location:** §2 "**You go quiet for an hour.** The watcher ticks. … The watcher prints one line. The agent holds it until you finish what you are doing, then says:"; §3 "Something comes due while you work | One sentence, at your next pause".
- **What is wrong:** This is the one moment that shows "Interact", the job D1 sells as CORE 4's difference from the plain kit ("anything that speaks up during a session"). The story contradicts itself. You are quiet, so there is nothing to "finish". The reader cannot tell whether the agent speaks without you typing or waits for your next message. "At your next pause" in §3 is just as ambiguous. Yet D1 §6's whole distinction ("Yes on Claude Code; next-prompt elsewhere") depends on that answer.
- **What breaks if we ship it as-is:** A reader cannot say what Claude Code users get that Codex users do not. If the true answer is "it waits for your next message", D1's comparison table overstates Interact on Claude Code.
- **Suggested fix:** Replace the sentence with the actual behavior, for example "Claude Code hands the line to the agent, which speaks up without you typing" or "The line waits; the agent says it when you next type". Use the same phrase in §3.
- **Evidence:** v1-d2.md:102–104, 123; v1-d1.md:176, 190.

### R1-RD-10  —  minor
- **Artifact:** D1, D2, D3
- **Location:** D1 §1 "Five defects … one defect in five costumes … seventeen more places"; D1 §5 "Each of the six ways a CORE 3 check lies"; D2 §6 "six ways … seventeen more places"; D1 §1 table "Settings switches | 34 names | [G 2.1]"; D3 decision 16 "v3 has 35 switches [G 2.1]".
- **What is wrong:** The same quantities are stated as different numbers. A reader is told about five defects, then six ways, then seventeen places, with no sentence relating them. The switch count is 34 in D1 and 35 in D3, and both cite G 2.1, which says 35. (The 34 comes from a narrower grep in D3 step 0.2. Both counts are right for their own command, but neither document says so.)
- **What breaks if we ship it as-is:** A careful reader stops trusting the numbers. A skimmer quotes the wrong one. In a plan whose subject is honest counting, mismatched counts are expensive.
- **Suggested fix:** Pick 34, the number D3's own acceptance test checks, and fix D3 decision 16 and the D1 citation to match. In D1 §1, add one clause: "five reported defects, which fall into six patterns; an audit found seventeen more instances".
- **Evidence:** grounding.md:54 ("35 distinct `CORE_*` names"); `grep -rhoE '\bCORE_[A-Z0-9_]+' plugins/core --include=*.mjs --include=*.md --include=*.json | sort -u | wc -l` → 34; `grep -rhoE "CORE_[A-Z][A-Z0-9_]+" plugins/core | sort -u | wc -l` → 35; v1-d1.md:52, 57, 65, 154; v1-d3.md:89, 439.

### R1-RD-11  —  minor
- **Artifact:** D1, D2
- **Location:** D1 header "Tags like `[runtime §4]` point to a section of the matching research file in this folder"; tags `[memory-layers-b, summary 14]`, `[competitors, finding 3]`, `[competitors §A]`, `[memory-layers-b, verdict]`.
- **What is wrong:** The legend points the reader to the wrong files. `runtime` and `evaluation` are `source-*.md`, not research files. The tags also use four formats (`§N`, `summary N`, `finding N`, `verdict`). At least one points to the wrong place: `[competitors, finding 3]` (the "five silent months" claim) lands on summary item 3, which is about Conductor. The claim is actually in §B item 8.
- **What breaks if we ship it as-is:** The reader who checks a claim, the one reader the tags exist for, lands on the wrong text or a missing file and gives up. D1 carries 34 tags, so each broken one costs attention for nothing.
- **Suggested fix:** Make the legend one line per prefix and file, use one format (`[file §section]`), and fix the competitors tag to `[competitors §B.8]`.
- **Evidence:** `ls gauntlet/` shows `source-runtime.md`, `source-evaluation.md` and no `research-runtime.md`; research-competitors.md:9 (summary 3 = Conductor), :429 (§B item 8 = silent failures); v1-d1.md:7, 184.

### R1-RD-12  —  minor
- **Artifact:** D1
- **Location:** §7 risk table "The fixture stores, the gold sets, and the prose checker are kept and reused. The audit's list of 29 practices worth keeping [evaluation §8] is the checklist."; §7 "CORE 3's four-tier retrieval"; §1 table "Steps in one ordinary session | 58"; §1 "Update | A registration form with nothing behind it."
- **What is wrong:** D1 is written for a reader who has never seen CORE, yet it uses CORE-internal terms with no explanation: fixture stores, gold sets, prose checker, four-tier retrieval, "steps" (tool calls? prompts?), and "a registration form" (for what?).
- **What breaks if we ship it as-is:** The reader skips the risk row that answers "won't the rewrite lose CORE 3's lessons?", which is one of the strongest objections to the plan. They also cannot tell what "58 steps" measures, so the number does no work.
- **Suggested fix:** Say each in plain words, for example "CORE 3's test projects, its lists of right answers, and its text checker are kept", "58 tool calls, 49 of them at startup", "a way to list a data source, but nothing that fetches it". Drop "four-tier" and say "CORE 3's ranked search".
- **Evidence:** v1-d1.md:51, 74, 198, 205.

### R1-RD-13  —  minor
- **Artifact:** D2
- **Location:** §4 table, "What CORE adds": "supersede-don't-overwrite, the tombstone rule", "the put-off ladder", "the 'speak at a boundary, once' rule".
- **What is wrong:** These are internal nicknames that appear nowhere else in D2 and are never defined. "The put-off ladder" collides with "The ladder" (the environment rungs) one section later. The same idea is called "speak at a boundary" here, "Speak at a pause, once" in D1, and "at your next pause" in §3.
- **What breaks if we ship it as-is:** The reader has to guess that "tombstone" means "a retired fact stays retired" and "put-off ladder" means "after two deferrals, say what it blocks; after three, record it as a risk". Many will take the put-off ladder to be part of the environment ladder.
- **Suggested fix:** Replace each nickname with the plain phrase D2 already uses elsewhere ("replace, don't overwrite", "a retired fact stays retired", "escalate a question put off twice", "speak at a pause, once"). The text gets no longer.
- **Evidence:** v1-d2.md:137, 139; v1-d1.md:129.

### R1-RD-14  —  minor
- **Artifact:** D3
- **Location:** Step 7.2 "an instrument that returns `ok` when blinded is a rule-1 bug"; step 0.6 "these scores are **B** (files alone) … and **C** (nothing)"; step 9.5 "the four cells from step 0.6 and from the final run".
- **What is wrong:** D3 has two numbered rule lists: "Rules that never bend" 1–10, and R1–R3 in contract A. "Rule 1" (three outcomes) and "R1" (read nothing → not ok) are both plausible readings in 7.2. Cell letters appear in 0.6 but are defined only in 7.5, nine phases later, and D3 tells the agent it need not read D2 §7. Step 0.6 runs with an empty plugin and so produces two cells, not four, yet 9.5 asks for "the four cells from step 0.6".
- **What breaks if we ship it as-is:** An agent hunting for two cells that 0.6 never produced will either stop to ask or fill the gap. Filling a missing measurement with a plausible number is the defect class this plan exists to kill.
- **Suggested fix:** In 7.2, write "an R1 bug (contract A)". In 0.6, write "files-alone and no-record scores" instead of letters. In 9.5, write "the two baseline scores from step 0.6 and the four cells from the final run".
- **Evidence:** v1-d3.md:46, 186, 490, 873, 917, 1056.

### R1-RD-15  —  minor
- **Artifact:** D3
- **Location:** Step 9.5 "Open a pull request into `next`."; decision 1 "Work on a new branch `v4`, cut from `main`."
- **What is wrong:** `next` appears for the first time in the last step and is never explained. The plan branches from `main` and never says why the PR goes to a different branch, or what to do if `next` does not exist. It does not exist on the remote in this checkout.
- **What breaks if we ship it as-is:** The zero-context agent reaches the final step, finds no `next` branch, and must either ask (the thing D3 exists to prevent) or guess: open the PR to `main`, or create `next`. Either guess may skip the version check, which compares against the PR's target branch.
- **Suggested fix:** Add `next` to decision 1: what it is, that the PR targets it, and the fallback if it is missing (for example "create it from `main`, note it in the build log").
- **Evidence:** `git branch -a` → only `main` and the session branch; .github/workflows/ci.yml:5 and version-check.yml:5 list `branches: [main, next]`; version-check.yml:52–64.

### R1-RD-16  —  minor
- **Artifact:** D2
- **Location:** §5 "The ladder" capability table and "The rungs, named" table; legend "**doc** means … **report** means a third party tested it".
- **What is wrong:** Two overlapping tables answer the same question ("what do I lose here?"), and the useful one comes second. The first table puts a proof marker in every cell ("(doc)", "(doc: source)"). The legend defines "report", which no cell uses, and does not define "doc: source", which most Codex cells use. The Codex cell for "Brief at session start" runs to four lines. The fact a Codex user most needs, re-approving hooks after every update, is buried mid-cell.
- **What breaks if we ship it as-is:** Requirement 3 asks for a table that names exactly what the user loses at each rung. A skimmer reaches the answer only after wading through the denser table and may stop there.
- **Suggested fix:** Put the rungs table first. Move the proof markers out of the cells into one sentence ("Claude Code and Antigravity rows are from vendor docs; Codex rows from its source at 0.167.0"). That cuts the capability table by about a third.
- **Evidence:** v1-d2.md:160–184.

### R1-RD-17  —  minor
- **Artifact:** D2
- **Location:** §2 "**You ask a question.** 'Why did we drop the v2 retry header?'" (pointer shows dc-14: "Keep the v2 retry header for now"), then "**You make a decision.** … 'move to the v3 format.'"; and "Closed. 2 memories written (dc-31, risk-09)".
- **What is wrong:** The worked session has continuity errors. The user asks why the v2 header was *dropped* before the decision that drops it, and the memory returned says *keep* it. The closing line counts `risk-09` as written this session, but nothing in the story writes it. `risk-09` is a pre-existing file in the §1 tree.
- **What breaks if we ship it as-is:** The walkthrough is the part a skimmer actually reads. The reader trips on the contradiction and loses the thread. The counting error lands on the exact line meant to show "counts from disk".
- **Suggested fix:** Change the question to "Why did we keep the v2 retry header?" (as D3's eval case does). Make the close line "1 memory written (dc-31), 1 archived (dc-14)".
- **Evidence:** v1-d2.md:35, 89–100, 110; v1-d3.md:931.

### R1-RD-18  —  minor
- **Artifact:** D1
- **Location:** §6 comparison table (ten columns × ten rows), e.g. "Partial: Claude Code yes, on one machine; Codex off by default; Antigravity none", "No: background server, a model call per tool use".
- **What is wrong:** The table mixes verdicts with long qualifiers inside cells. At ten columns it wraps on any screen, and a skimmer cannot scan a column for Yes/No. The three numbered points under it do the real work, and the table mostly delays them.
- **What breaks if we ship it as-is:** The feature-for-feature comparison the contract requires is the part of D1 least likely to be read. Readers skip from the heading to "Three things stand out".
- **Suggested fix:** Cut each cell to Yes / Partial / No. Move the five or six qualifiers that matter (for example claude-mem's server, mem0's cloud key) into the "Three things stand out" points or into footnotes. The table shrinks, and nothing is lost.
- **Evidence:** v1-d1.md:164–176.

### R1-RD-19  —  taste
- **Artifact:** D2
- **Location:** "In one minute": the three layers use "skills", "hooks" and "watcher", then the next paragraph defines them ("A few terms…").
- **What is wrong:** The terms are defined after first use, and the first screen does not say what else the document covers (ladder, measurement, security), so a reader looking for one of those does not know to scroll.
- **What breaks if we ship it as-is:** A cold reader reads the layer list without knowing what a skill or hook is. A reader looking for the security design does not know it is §9.
- **Suggested fix:** Move the terms line above the layer list. Replace the separator line with one sentence naming the sections the reader most likely came for. No net length.
- **Evidence:** v1-d2.md:13–21.

---

Sound: the voice is mostly plain and short. Hedge words are nearly absent (one "likely", one "perhaps" across D1, D2 and D4). D1's "The short version" and D3's "How to use this document" both do their job on the first screen.

critical 0 · major 9 · minor 9 · taste 1
