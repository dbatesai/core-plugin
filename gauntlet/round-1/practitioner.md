# Round 1 — Practitioner review of v1

Reviewer mandate: I build agent memory systems for a living. Would I sign this off? I read D1–D4 v1 and checked their claims against `research-literature.md`, `research-memory-layers-a/b.md`, `grounding.md`, `source-evaluation.md`, and the fixtures in `tests/fixtures/`.

Short answer: not as written. The record format and the honesty rules are sound. The parts that decide whether memory *works over months* — decay, deduplication, the write path, and the test that is supposed to kill the plugin if it is useless — are either wrong or measured in a way that cannot fail.

---

### R1-PR-01  —  critical
- **Artifact:** D3 (steps 0.6, 7.6, 9.4); D2 §7; D1 §8
- **Location:** D3 9.4, "mean A − B of +0.3 or more across the four **T** cases"; D3 0.6, "If every plain-case score is 0.9 or higher, **stop**"; D1 §8, "The proof is one number."
- **What is wrong:** The four **T** cases are `recall-past-decision`, `recall-distractors`, `brief-budget`, and `proactive-due`. The Lantern fixture has no code, only a README, a brief, and 45 small memory files. A plain agent asked "Why did we keep the v2 retry header?" will grep `retry header`, find `dc-14`, and answer. So the two recall cases will sit near 1.0 in arm B, and A − B there will be about zero. The other two cases test whether the agent repeats a line the hook injected ("Needs you now: … data-retention …"). Arm B was never told to surface due items, so it scores near 0 on `proactive-due` and low on `brief-budget`. Arm A scores near 1 because the hook put the answer in context. Mean A − B lands around +0.4 to +0.5 from those two cases alone. The gate passes by construction. The same arithmetic defeats the step 0.6 early stop: `proactive-due` keeps the plain score under 0.9, so "plain files already pass" can never fire.
- **What breaks if we ship it as-is:** The one number D1 says decides whether CORE should exist will report "the plugin earns its keep" while measuring only that the model echoes injected text. Recall, the job the plan says matters most, could add nothing and the gate would still pass. This is the defect class the plan exists to kill, moved into the eval: a check that reports success while not measuring the thing it names.
- **Suggested fix:** Gate per job, not on a mean across jobs: recall A − B, focus A − B and interact A − B each reported and each with its own bar. Give recall cases a fixture where grep is hard: a real code tree with thousands of files and a few hundred memories, and questions phrased with no words shared with the summary. Make the step 0.6 stop rule per job too.
- **Evidence:** D3 lines 478–494 (fixture and stop rule), 932–935 (T cases and graders), 1042 (gate). Literature §7: "Verify the no-memory arm really has no memory" and "Test both the cases where a behavior should occur and where it shouldn't."

### R1-PR-02  —  critical
- **Artifact:** D3 (step 4.4, contract J, contract H); D2 §11; D4 Part 2 Q3, Q18
- **Location:** D3 4.4, "for active memories not changed in `archive_after_days`, not pinned, with no `by-when` in the future, and not named in `PROJECT.md`, move them to `archive/`"; contract J `"archive_after_days": 90`; D2 §1, "Nothing reads the archive unless you ask about history."
- **What is wrong:** The decay rule archives a memory because nobody *edited* it for 90 days. A decision that is still in force is exactly the memory nobody edits. So is a person record ("Alex owns payments") or a principle. Once archived it leaves the index, so the prompt hook can never point to it, and the brief does not hold it. The plan has no signal for "this memory was recalled or relied on": contract H gives `prompt` rows `hits` and `ph` only, no ids. D4 Q18 says receipts log memory ids; contract H says they do not. "Not changed" is also undefined: the `updated` field or the file's mtime? A fresh `git clone` resets every mtime, so the same store archives everything on one machine and nothing on another. Finally, the archive now mixes "still true but quiet" (`archived`) with "false" (`retired`, `superseded`), so the "status by location" rule no longer tells a reader which archived facts are true.
- **What breaks if we ship it as-is:** D1's first problem is "It re-proposes the option you already rejected." On a project that runs for months — D1's stated use — most decisions are older than 90 days. CORE will archive them, stop recalling them, and the agent will re-propose the rejected option. The core promise fails for the core use, and the only sign is a count in a pulse line.
- **Suggested fix:** Do not decay `decision`, `person`, `principle`, or `risk` by age at all; archive them only when superseded or retired. For other types, prune by "last verified or last recalled" and log recalled ids in `prompt` receipts so that date exists. Define "changed" as the `updated` field, never mtime.
- **Evidence:** D3 lines 360, 390, 746; D4 line 86. Literature §4 design rule: "Do not build a decay formula. Prune by 'last verified' date, in the open, with a log." MemoryBank: "this is an exploratory and highly simplified memory updating model."

### R1-PR-03  —  major
- **Artifact:** D1 (Alternatives table, §6); D2 §7; D3 7.6
- **Location:** D1, "Use the harness built-ins only … This is the baseline CORE 4 must beat in its own test."; D2 §7 four-cell table.
- **What is wrong:** No cell contains the harness's built-in memory or the AGENTS.md pattern. `claude plugin eval` runs in a temporary home where "memory … and skills are absent", so Claude Code's auto memory is off in every arm. Cell B is "files with no instructions at all". D1's own runner-up, the "pragmatic kit", is AGENTS.md plus built-in memory. The plan even ships that competitor: the three-line `AGENTS.md` block in step 3.6, which is rung D. It is never an arm.
- **What breaks if we ship it as-is:** The test cannot answer the question a buyer asks: "does the plugin beat AGENTS.md plus auto memory?" A plain agent told in three lines to read `PROJECT.md` and mention anything due would likely pass `brief-budget` and `proactive-due` too. Without that arm, CORE's measured gain is a gain over a strawman, and D1's verdict rests on it.
- **Suggested fix:** Make the B arm "record plus the step 3.6 AGENTS.md block" (fixture-written, plugin off). Add a manual or scripted arm with Claude Code auto memory seeded with the same facts, or state plainly in D1 that the built-in baseline is not measured.
- **Evidence:** grounding.md §4.1, plugin-evals: "Your user settings, hooks, `CLAUDE.md` files, MCP servers, other installed plugins, memory, and skills are absent." D3 lines 664–672 (the AGENTS.md block). D1 line 237.

### R1-PR-04  —  major
- **Artifact:** D2 §7 ("Numbers with a stated basis", "Against the old version"); D3 7.5, 9.4
- **Location:** D2, "+0.3 … Below this the gap is within run-to-run noise for a 20-case suite"; D3 7.5, "takes each side's final message from the first with-plugin run".
- **What is wrong:** The sample is far too small for the claims made on it, and the noise claim has no calculation behind it. The gate uses four cases, three runs per arm, binary graders, so each case score is 0, ⅓, ⅔, or 1. All four cases share one fixture, so they are not independent. No paired difference, interval, or n is reported. The v3 comparison is worse: four cases, one sample per side, and a case counts only when two orderings agree, so the realistic outcome is "2 ties, 1–1" — no information. Blinding strips lines that say "CORE" but not length or style; v3's answers recite status and are longer, which a judge can spot, and LLM judges prefer longer answers more than 90% of the time. The judge is unspecified, so it is likely the same model family as the agent. D4 Q13 admits there is no human calibration.
- **What breaks if we ship it as-is:** A pass or fail on the release gate will be decided by one or two runs flipping. The maintainer will read noise as a verdict, in either direction, on the decision D1 says is the whole case for CORE.
- **Suggested fix:** Run at least 10 trials per arm per case, report the paired difference per case with a 90% interval, and call any interval that crosses zero "no difference shown". For the blind v3 pack, use all runs, cap or equalize answer length, and have a person label 20 judge decisions once to get the judge's true-positive and true-negative rates.
- **Evidence:** Literature §7: "Report n, the paired difference, and an interval"; "clustered standard errors on popular evals can be over three times as large as naive standard errors"; "Both claude-v1 and gpt-3.5 preferred the longer response more than 90% of the time"; the inference that "blinding hides the label, not the style". D3 lines 918, 1042–1044.

### R1-PR-05  —  major
- **Artifact:** D3 7.6 (`remember-*` cases), 5.1; D1 §7 risk table
- **Location:** `remember-decision` prompt: "Decision: move the retry header to the v3 format now. We considered waiting until January and rejected it…"; D1, "The eval measures how often a planted decision gets written. The number is published."
- **What is wrong:** Every write case hands the agent a labeled decision as the whole message, often with "Record that". That is the easiest possible write. Real decisions arrive mid-task, unlabeled: "fine, use v3, and fix the test." The `remember` skill fires only if the model chooses to load it in the middle of coding work, which is the exact moment CORE 3's own notes say writes get suppressed. No case tests that.
- **What breaks if we ship it as-is:** The published "write rate" will be an upper bound that real use never reaches. The plan's only answer to "remembering rests on the agent's judgment" (D2 §11) is to measure the miss rate, and this design measures the wrong miss rate. Users will trust a store that is missing most of its decisions.
- **Suggested fix:** Add twins of `remember-decision` and `remember-supersede` where the decision is one clause inside a Write-granted coding task, and report the write rate for both forms side by side with at least 10 runs each.
- **Evidence:** D3 lines 941–942; grounding.md §2.7 ("obligations that live only in prose get executed ~40% of the time"); D4 Part 1 item 3.

### R1-PR-06  —  major
- **Artifact:** D3 contract E (`no-handoff`), 5.2, 5.3; D2 §2
- **Location:** Contract E, "`no-handoff` | The receipts show an earlier session on this machine with `prompt` rows and no `close` row | `now`"; 5.3, "Read the last 300 lines."
- **What is wrong:** Three problems in one mechanism. (1) Close happens only when the user says "wrap up". Most sessions just end. So nearly every session start will carry a `now` item and spawn a catch-up helper. The catch-up becomes the main write path, not a fallback. (2) "Last 300 lines" of a coding-session transcript can be a few minutes of tool output. Decisions made in the first hour of a four-hour session are never seen. (3) A session still running in another terminal also has `prompt` rows and no `close` row. The new session will read its live transcript, write memories from it, and run `close` on it. The plan also does not say which unclosed sessions are caught up when there are many.
- **What breaks if we ship it as-is:** Every morning opens with "the last session was not closed" plus a helper-agent run, which users will learn to ignore. Early-session decisions are lost. Two open sessions will write duplicate memories and close each other.
- **Suggested fix:** Treat a session as unclosed only if its last receipt is older than a set idle time (say 2 hours) and it had at least one write-worthy event; catch up only the most recent one and mark the rest "not caught up". Have the helper read the whole transcript filtered to user and assistant text, not the last 300 raw lines.
- **Evidence:** D3 lines 267, 804 (5.3), 787 (close needs the summary written in the last 10 minutes). Literature §5: "Summaries lose specifics."

### R1-PR-07  —  major
- **Artifact:** D3 5.1 (section 4), 2.5; D4 Part 2 Q2
- **Location:** `remember` section 4, "search `INDEX.md` and `archive/` for the same subject. Same fact → update… Fact replaced → write the new file with a `supersedes` edge and move the old one to `archive/`"
- **What is wrong:** Deduplication depends entirely on the agent finding the old memory by word search over one-line summaries that the agent itself wrote in different words in an earlier session. Nothing checks the result afterwards. If the agent adds a `supersedes` edge but forgets the move, both files stay active with `status: active`, and `check --project` passes: `location` checks status against folder, and `links` only checks the target exists. Two sessions writing at once (see R1-PR-06) will each miss the other's new file and fork the fact.
- **What breaks if we ship it as-is:** The store accumulates two live versions of the same fact. The literature names that as the worst failure: "retrieval surfaces stale and fresh values side by side … it produces a confidently wrong action." The recall hook will hand the agent both.
- **Suggested fix:** Add a `check --project` rule: the target of any `supersedes` edge must be in `archive/`. Have `pulse` list, once a week, pairs of active memories of the same type that share a topic and score above a BM25 overlap threshold, and ask the user which to keep.
- **Evidence:** D3 lines 551–563 (checks), 774 (remember section 4). Literature §4: MERIT quotes above; design rule "Never leave two live versions of a fact for search to find."

### R1-PR-08  —  major
- **Artifact:** D2 §7 ("Numbers with a stated basis"); D3 contract G, 3.2, 7.4; D4 Q5
- **Location:** D2, "Pointers per prompt | 3 | … Tuned against the kept gold sets; frozen after."; D3 3.2, "tune the two threshold numbers against … every other `_tests-goldset.json` under `tests/fixtures/`"; 7.4, "`recall_rate` | `prompt` rows with `hits > 0` ÷ `prompt` rows".
- **What is wrong:** There is exactly one gold file in the repository and it holds one query ("gateway placement") over a five-file store. There is no other `_tests-goldset.json`. Two thresholds cannot be tuned on one query, and the same query is then the acceptance test, so there is no held-out set. Precision and recall are never measured anywhere in the plan. The "two different prompt terms" pass rule will fire on ordinary coding prompts, which are full of words like "fix", "test", "header", "error". The only recall metric shipped, `recall_rate`, is a firing rate: a noisier matcher scores *higher*. It also counts prompts that are not the user's, since Claude Code fires `UserPromptSubmit` on scheduled-task firings and background-subagent reports.
- **What breaks if we ship it as-is:** D2 claims "every number in CORE 4 says where it came from"; this one has no basis. In use, the hook will inject near-miss pointers on many prompts — the literature's worst case for distraction — and `metrics` will report the rising hit rate as recall working.
- **Suggested fix:** Build a gold set of at least 50 queries over the Lantern fixture plus a few hundred realistic memories, with expected and forbidden ids and paraphrased queries; hold out half. Report recall@3 and precision@3 from `recall`. Replace `recall_rate` with "pointers whose file the agent then opened", or drop it and say recall quality is not measured in the field.
- **Evidence:** `find tests/fixtures -name '*gold*json'` returns one file; its content is `{ "queries": [ { "id": "s1", "query": "gateway placement", … } ] }`. source-evaluation.md line 506: "The tier-safety gold set is one query." grounding.md §4.1: `UserPromptSubmit` "also fires on scheduled-task firings and background-subagent reports." Literature §2: "the retriever's highest-scoring documents that are not directly relevant to the query … negatively impact the effectiveness of the LLM"; §7: "agents act on a correctly retrieved value only 55% of the time".

### R1-PR-09  —  major
- **Artifact:** D1 §4 size table; D4 Q8; D3 9.4
- **Location:** D1, "Read at session start | … | about 2,000 (the brief and one block)"; D4 Q8, "Estimated at 2,000–3,000 tokens … **Not measured.**"
- **What is wrong:** The 2,000-token figure counts the brief and the block only. The `core` skill's description tells the agent to use it "at the start of work in a project", so its body (up to 150 lines, roughly 1,500–2,500 tokens) loads every session too. Each prompt can add up to 1,000 bytes of pointers that stay in context for the rest of the session. The catch-up helper (R1-PR-06) and the stale-source refresh helper run at many session starts. None of this is in any gate. No eval case is an ordinary coding task where memory is irrelevant, so the plugin's tax on normal work is never measured.
- **What breaks if we ship it as-is:** The headline "32,000 → 2,000 tokens" comparison is off by a factor of two or more, and a plugin that adds cost and distraction to every task while helping a few will pass every gate. The literature shows exactly this pattern for always-loaded context: about 20% more cost and no reliable gain.
- **Suggested fix:** Add three or four null cases (a refactor, a test fix) with no memory relevance; gate on "no worse score and no more than X% more tokens with the plugin". Record tokens per arm from the eval result and report them next to A − B. Restate D1's number as "brief + block + core skill".
- **Evidence:** D3 line 711 (`core` description), contract F prompt cap 1,000 bytes, 5.3 and 6.2 helpers. Literature §7: "leading to a significant (p-value < 0.001%) cost increase of 20% and 23% on average"; "What matters is total tokens to complete a task, not tokens per request."

### R1-PR-10  —  major
- **Artifact:** D2 §2–3; D3 4.3 (section 3), contract E, 7.6
- **Location:** D3 4.3, "Never repeat an item in the same session unless it changed."; D2 §2, "The tracker digest is three days old, so I am refreshing it now."
- **What is wrong:** Repeat suppression is per session. A commitment due Friday is a `now` item from Thursday on and leads the brief in *every* session until it is done. Developers open many sessions a day, often several at once, each with its own watcher. Snooze happens only when the user says "not now". The D2 walk-through also has the agent start a tracker refresh, unasked, before the user's task. Nothing measures whether announcements are acted on, ignored, or snoozed: `announce` rows record what was said, never what happened next. The only interact eval rewards speaking up; no case checks that a second session the same day stays quiet.
- **What breaks if we ship it as-is:** The speak-up feature becomes the noise users learn to skip. The study the plan cites found that more frequent suggestions cut preference by half, and that empty or repeated check-ins led users to ignore about half of all proactive signals — including the real ones.
- **Suggested fix:** Announce each item at most once per day across all sessions on the machine (record it in receipts and check before speaking). Never start a refresh at session start unless the user asked or the source is marked `critical`. Add a `metrics` row "announced → snoozed / acted on / ignored", and an eval case where the item was announced earlier today and the reply must not repeat it.
- **Evidence:** D3 lines 718–719, 935 (`proactive-due`). Literature §8: "reducing participant preference for the proactive assistant over baseline by half"; "This led users to ignore around 50% of the proactive agent signals"; design rule "Count your own messages. Track how many are acted on, ignored, or dismissed."

### R1-PR-11  —  major
- **Artifact:** D3 decision 12, contract D; D2 §11; D4 Q16
- **Location:** Decision 12, "`_memories/INDEX.md` is a generated whole file, committed to git"; contract D header "signature: … · count: 42 · at: …"; D2 §11, "Two agents writing the same memory at the same instant: last one wins."
- **What is wrong:** The plan treats concurrency as two writers at one instant. The common case for this user — laptop, cloud sessions, three harnesses, branches — is two copies of the store that merge in git. `INDEX.md` is committed and its first line holds a signature, a count, and a timestamp that change on every write. Any two branches that each add a memory will conflict on `INDEX.md`, every time. Memory ids carry a running number (`dc-31`) with no rule for how the next number is chosen, so two branches will both create `dc-32-…`. `PROJECT.md`'s "Now" and "Next" lines will conflict for the same reason.
- **What breaks if we ship it as-is:** Every merge of parallel work produces a conflict in a generated file the user was told never to edit, and duplicate ids that `check --project` then fails on. Users will resolve by taking one side, silently dropping the other side's memories from the index.
- **Suggested fix:** Ignore `INDEX.md` in git and rebuild it at session start (the hook already does when stale; rung D agents can list `_memories/`). Make new ids unique without coordination: type, date, and slug (`dc-2026-11-09-retry-header-v3`), never a counter.
- **Evidence:** D3 lines 85, 244–252, 217. Literature §4: "agents had overwritten one another's work" "41 of 57 facts survived."

### R1-PR-12  —  major
- **Artifact:** D3 contract F, contract K, 3.1, 4.3 (section 10); D2 §5 rung B; D4 Q7
- **Location:** Contract F, "In a folder that is not a CORE project (no `PROJECT.md` and no `_memories/`): say nothing."; D4 Q7, "Enabling a project is one sentence."; D2 rung B, "Claude Code headless or cloud".
- **What is wrong:** There is no path to start CORE on a new project. The hooks stay silent without `PROJECT.md` or `_memories/`. The `core` skill triggers only in a project that already has both. Section 10 covers enabling a folder that *already has* memory. No command in contract K creates the record. Separately, the trust list lives in `~/.core/` on the machine. A cloud session starts in a fresh container, so its trust list is empty every time: every cloud session opens with "not enabled on this machine", and scheduled cloud runs are inert. The four-cell D cell ("CORE on its first day") uses a fixture with no `PROJECT.md`, so the plugin is inert there too and D equals C; cold start is never measured.
- **What breaks if we ship it as-is:** A new user installs CORE and nothing happens, with no message — a silent rung the plan says cannot exist. A user who works in cloud sessions, a use D1 names, must re-enable every session. D4's cold-start answer is false.
- **Suggested fix:** Add an explicit "start CORE here" flow in the `core` skill that writes a starter `PROJECT.md` and `_memories/` and runs `trust add`, and have the session-start hook say one line in a git repo with no record ("CORE is installed; say 'start CORE here' to use it"). Say in D2 that cloud sessions need a project-scoped trust mechanism, or list cloud as rung C.
- **Evidence:** D3 lines 298, 393–413 (contract K has no init), 726 (section 10). grounding.md §4.1: cloud routines use a "fresh clone, no local files". D3 0.6, "With `--norecord` it writes only `README.md`."

### R1-PR-13  —  major
- **Artifact:** D1 §4; D3 5.1 (sections 2–3)
- **Location:** D1, "Readable, editable, committed with the code."; `remember` "Never write — secrets, tokens, passwords; raw text from outside sources; guesses about a person's motives…"
- **What is wrong:** The write policy refuses secrets and motive-guesses, and nothing else. But CORE's stated content is people, promises, risks, and legal deadlines ("Legal needs our data-retention answer", "who promised what"). These go into `_memories/`, which is committed with the code by default. Nothing asks whether the repository is public or shared with a team, and nothing marks a memory as private.
- **What breaks if we ship it as-is:** Notes about colleagues, legal exposure, and vendor risk get pushed to a shared or public remote as a side effect of normal use. Git history makes that permanent; deleting the file later does not undo it.
- **Suggested fix:** At enable time, ask once whether `_memories/` is committed or local-only, and write a `.gitignore` entry on "local". In the `remember` skill, never write `person` notes about anyone other than ownership and contact role, and never record a judgment about a named person.
- **Evidence:** D1 line 117; D3 lines 772–773; D3 contract C example (line 224) has `people: [alex]`, `owner: david`.

### R1-PR-14  —  major
- **Artifact:** D2 §4, §11; D1 §6 comparison table
- **Location:** D1, "Claude Code's is on by default but stays on one machine and one harness."
- **What is wrong:** On Claude Code, rung A, the built-in auto memory is on by default and saves exactly CORE's content: type `project` is "ongoing work, deadlines, and decisions". The plan never says how the two coexist. Both will record the same decision in two places, in different words, and only CORE's copy gets superseded when the decision changes.
- **What breaks if we ship it as-is:** After the first changed decision, the agent sees the old value in auto memory (loaded at every session start, up to 200 lines) and the new value in CORE's brief or pointer. That is two live versions of one fact across two systems, and Claude Code's own docs say the model "may pick one arbitrarily".
- **Suggested fix:** Decide and state it: either the enabling flow tells the user to turn auto memory off for CORE projects, or CORE's `remember` skill also updates the auto-memory entry when it supersedes. Add an eval case seeded with a conflicting auto-memory note.
- **Evidence:** grounding.md §4.1: auto memory "already saves project facts: type `project` is 'ongoing work, deadlines, and decisions…'"; "The first 200 lines of `MEMORY.md` … are loaded at the start of every conversation." Literature §4: "if two instructions contradict each other, Claude may pick one arbitrarily".

### R1-PR-15  —  major
- **Artifact:** D3 contract H, 1.2, 3.4, 3.5, 7.4; D2 §7
- **Location:** 3.4, "Read at most the last 200 lines of this machine's receipts file"; 7.4, "`sessions` | distinct `sid` in receipts"; "`hook_coverage` | sessions with a `session-start` row ÷ sessions".
- **What is wrong:** Receipts never rotate. The watcher alone writes six rows per hour per open session. The queue's `no-handoff` rule and `metrics` read receipts with no window set for the queue. The perf test measures a 500-memory store and ignores receipt size. At thousands of sessions the session-start hook (10 s timeout) and prompt hook (5 s) will slow. When the harness kills a hook on timeout, it writes no receipt and its output is dropped. Because `sessions` is counted *from* receipts, a session whose hooks died is not in the denominator, and `hook_coverage` stays at 100%. The "last 200 lines" window is shared by every concurrent session and watcher on the machine, so a session's own `announce` row can scroll out and the item gets announced again.
- **What breaks if we ship it as-is:** At scale, recall silently stops and the metric meant to catch dead hooks reports full coverage. That is the defect class the plan exists to kill, inside its own heartbeat. D4 Part 1 item 10 sees part of this (clones have no receipts) but not the denominator.
- **Suggested fix:** Have every hook append a `start` row as its first act and a result row at the end; count sessions from `start` rows and report starts with no result as broken. Rotate receipts monthly and read only the last N days in hooks. Add receipt size (100,000 rows) to `perf.test.mjs`. Look up announcements by `sid`, not by tail position.
- **Evidence:** D3 lines 360, 618, 699 (watch receipt every tick), 887–889. grounding.md §4.1: "a timed-out hook's output is discarded and 'the prompt still reaches Claude without that context'".

### R1-PR-16  —  minor
- **Artifact:** D4 Part 1 item 2
- **Location:** "The plain-files baseline could be measured in a day, before anything is built, and v1 of the build plan does not do that."
- **What is wrong:** D3 step 0.6 does exactly that: it measures cells B and C with a skeleton plugin before phase 1. D4 attacks a plan that no longer exists, and misses the real problem with step 0.6 (R1-PR-01).
- **What breaks if we ship it as-is:** A reader of the critic log is told the main risk is unaddressed when it is addressed, and is not told that the fix cannot fire. The log loses credibility as the place to find real weaknesses.
- **Suggested fix:** Replace item 2 with the R1-PR-01 problem, or delete it.
- **Evidence:** D4 line 19–21; D3 lines 474–494.

### R1-PR-17  —  minor
- **Artifact:** D3 7.6, contract K
- **Location:** 7.6, "each `fixture.sh` also runs `node <plugin>/scripts/core.mjs trust add --temp --project .`"; contract K, "`--core-dir` exists so tests never touch the real home."
- **What is wrong:** The trust list is found from the OS account record, not `HOME`, by design. So inside an eval run's temporary home, `trust add` writes to the real `~/.core/projects.json` of whoever runs the suite. The developer's real trust entries are also live during the eval.
- **What breaks if we ship it as-is:** Every eval run edits the maintainer's real trust list, which the plan says tests must never do, and a run is not isolated from the machine it runs on.
- **Suggested fix:** Have `fixture.sh` pass `--core-dir <workspace>/.core-test` and let the hooks read a core dir named in the fixture's `_core/config.json` only when an eval flag is set, or accept and document the write.
- **Evidence:** D3 lines 413, 927; decision 15.

---

**What is sound, in one line:** the record format, supersede-don't-overwrite, pointers instead of bodies, three exit codes with a known-answer self-test, speaking only at boundaries, and no per-turn extraction all match what the literature supports.

critical 2 · major 13 · minor 2 · taste 0
