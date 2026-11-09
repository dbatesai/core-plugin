# Round 3 — Reader review of v3 (D1–D4)

Mandate: requirement 9 and whether each document does its job for a distracted reader who has never seen CORE. D3 is read as an agent with no context would read it. Earlier reader, ledger, and fix-code entries were checked; nothing below repeats them.

---

### R3-RD-01  —  major
- **Artifact:** D3 (and D2)
- **Location:** Contract K, "Finding the script": "The status block's `script:` line. Without a block: `scripts/core.mjs`…"; step 4.3 §2: "read the `CORE:` block … **No block** → read `reference/ladder.md`"; step 5.2 §3: "`<m4>` = the first 4 characters of `machine=` **in the block**"; 5.2 §4: "the id comes from **the block**, else `CLAUDE_CODE_SESSION_ID`"; 5.3: "When **the block** lists a `no-handoff` item". Against step 3.6, titled "The block", decision 26, D2 §1 "**The block**, added with your yes", and the arm table "layer 1 (the package plus the block)".
- **What is wrong:** "The block" names two different things. Most of the time it is the three- or four-line text in `AGENTS.md`/`CLAUDE.md`. In the skill instructions above it means the hook's status block. These are the lines an agent copies into `SKILL.md` prose. R2-RD-02 fixed two other doubled labels ("convention", "the kit"). This one was missed.
- **What breaks if we ship it as-is:** On the Skills-only rung the `AGENTS.md` block is in context and the status block is not. An agent reading "No block → read `ladder.md`" sees a block, so it skips the fallback and never says that hooks are off. "`machine=` in the block" points at text with no `machine=` in it, so the handoff name falls back to `0000` even when the hooks ran. The building agent cannot tell which block 5.3 means.
- **Suggested fix:** Use "status block" every time the hook's output is meant, and "the `AGENTS.md` block" for the instruction text. Never write a bare "block" in skill prose.
- **Evidence:** v3-d3.md:450, 773, 886, 887, 897 against 736–747, 98; v3-d2.md:70, 266.

### R3-RD-02  —  major
- **Artifact:** D2, D3, D4
- **Location:** D2 §1: "A promise takes `status: done`, a question `answered`, a risk `retired`. It leaves the queue at once; `pulse` proposes archiving it 30 days later." D2 §4: "Decisions, principles, people, risks, and questions are never proposed." D3 contract C: "A risk that no longer applies becomes `retired` and moves to `archive/`." D3 4.4: "(a) `done` and `answered` memories … Never list … active risks, or open questions." D4 Q3: "closed promises, questions, and risks 30 days after they close."
- **What is wrong:** The archive rule is stated five ways. D2 §1 and D4 say a retired risk waits 30 days. Contract C says it moves to `archive/` at once. D2 §4 says questions and risks are never proposed. D3 says only *open* questions and *active* risks are protected. Only D3 4.4 is the real rule.
- **What breaks if we ship it as-is:** A reader cannot say what happens to a retired risk or an answered question. D2 §4 is the paragraph a user reads to learn what CORE will tidy, and it is wrong for answered questions. A maintainer who checks the `pulse` skill against D2 will "fix" it in the wrong direction.
- **Suggested fix:** One sentence, used in D2 §1, D2 §4 and D4 Q3: "Done promises and answered questions are proposed for archive 30 days after they close. A retired risk moves to `archive/` at once. Open questions, active risks, decisions, principles, and people are never proposed."
- **Evidence:** v3-d2.md:52, 185; v3-d3.md:265, 808; v3-d4.md:71.

### R3-RD-03  —  major
- **Artifact:** D2, D3, D1
- **Location:** D2 status block: "Reply to legal on data terms, due Mon 9 Nov (`pr-20261103-legal-reply`)". D3 contract C prefixes: "`pr` principle". Contract C `type` list: "`decision`, `risk`, `person`, `deliverable`, `principle`, … `open-question`, `premise`" (no promise or commitment). Elsewhere: "A promise takes `status: done`" (D2 §1), "a promise with an owner and a date" (5.1 §2), "commitments with owner and date" (contract F pre-compact), "Things owed" (D1 §1).
- **What is wrong:** One of the four things CORE tracks has four names (promise, commitment, thing owed, deliverable) and no type of its own. D2's only example id uses the `pr` prefix, which contract C reserves for *principle*.
- **What breaks if we ship it as-is:** The `remember` skill must pick a `type` and a prefix for "reply to legal by Friday". D2 teaches `pr-`, so the memory is typed as a principle. Principles are never proposed for archive and are not queued as promises, so the item behaves wrongly in `pulse` and in the queue. A reader of D1 never learns that "things owed" means `type: deliverable`.
- **Suggested fix:** State in contract C that a promise or commitment is `type: deliverable`, prefix `dl`. Change D2's example id to `dl-20261103-legal-reply`. Pick one word ("promise") for the prose.
- **Evidence:** v3-d2.md:52, 100; v3-d3.md:262–265, 369, 854; v3-d1.md:39.

### R3-RD-04  —  major
- **Artifact:** D2 (and D1)
- **Location:** D2 §2, Thursday evening: "A Claude Code cloud scheduled task you set up once runs `/core:pulse unattended` on the repository." Against D1 §4: "Without the plugin or the committed copy — a Claude Code cloud session, say — the floor is the record and the block". D2 §5 Files-only rung: "a Claude Code cloud session without the plugin". D2 "What was not verified": "Whether Claude Code cloud sessions load the plugin."
- **What is wrong:** This is a broken fix of R1-GA-04 and G13. R1-GA-04 was accepted because cloud sessions do not install repository-declared or user-enabled plugins. In v2 the story ran a plain prompt. In v3 it runs a plugin command, `/core:pulse`, in a cloud task. D1 uses a cloud session as its example of *no plugin*. D2's own list of unverified items says the same. The story shows the happy path that the other three passages doubt. In truth the run works only through the fallback text in D3 4.5's prompt.
- **What breaks if we ship it as-is:** The closed-laptop reminder is the owner's stated need (D1 §8). A reader takes from D2 that CORE's own `pulse`, with its script-checked dates, runs there. At best a model reads the dates with no script, which the plan elsewhere says models misjudge. A user who sets up the task from the story sees "Unknown command /core:pulse" or a model-read list, and nothing told them to expect that.
- **Suggested fix:** Rewrite the beat: "runs the prompt in D3 step 4.5. If the plugin is not loaded there, it reads `_memories/` itself and says the dates were read by the model, not checked."
- **Evidence:** v3-d2.md:154, 204, 430; v3-d1.md:110; v3-d4.md:154 (R1-GA-04), 442 (G13); v3-d3.md:821.

### R3-RD-05  —  major
- **Artifact:** D2, D3, D1
- **Location:** D2 §2: "Closed. 1 memory written (dc-20261109-retry-header-v3), 1 archived (dc-20261002-retry-header-v2). Handoff note saved." D2 §3: "You close | Counts from disk, by id". D3 5.2 §4–5: "Run `git status --porcelain _memories _summaries PROJECT.md` and count the lines … One closing line built from that count — never your own." D1 §1: `_memories/` is "committed with the code if you choose".
- **What is wrong:** D2 promises a count split into written and archived, by id. D3 tells the agent to count the lines. Those are different outputs, and the line count is wrong in the common case. When `_memories/` is not committed, which D1 says is the user's choice, Git shows the whole folder as one line however many files changed.
- **What breaks if we ship it as-is:** A session that wrote five memories and archived one reports "1". A session that wrote nothing still shows `?? _memories/` and reports "1 written". That is a count that reads as success while measuring nothing: the defect class, in the one number the plan says comes "from disk".
- **Suggested fix:** Use `git status --porcelain --untracked-files=all` and count files by folder (`_memories/` new or changed, `_memories/archive/` new). Make D2's example line show exactly what that rule prints.
- **Evidence:** v3-d2.md:144–146, 166; v3-d3.md:887–888; v3-d1.md:106. Command output, a fresh repo with an untracked `_memories/` holding one new memory and one archived file: `git status --porcelain _memories _summaries PROJECT.md` → ` M PROJECT.md` / `?? _memories/` / `?? _summaries/` (three lines; both memory files hidden in one).

### R3-RD-06  —  minor
- **Artifact:** D1, D2, D3, D4
- **Location:** D1 kill test 1: "Otherwise: use the kit and the built-ins; do not build CORE." D2 §7: "Otherwise the verdict is 'use the kit and built-ins; do not build CORE'". D3 0.6 GATE.md and 9.4: "do not build CORE." D4 Q11: "CORE is not built".
- **What is wrong:** The Layer 1 test runs in step 7.7, after phases 1–6 have built everything. "Do not build" is the verdict of a test that can only run once the building is done. The real choice is whether to ship it.
- **What breaks if we ship it as-is:** The owner reads the kill test as a cheap early stop and plans on that basis. In fact the full build is spent first, and the only early stop (0.6) checks files against nothing, not Layer 1 against files. D3's agent writes "do not build CORE" into a pull request for code it has just built.
- **Suggested fix:** Say "do not ship CORE; use the kit and the built-ins" everywhere, and add one line to D1: "this is known only after the build."
- **Evidence:** v3-d1.md:219; v3-d2.md:305; v3-d3.md:533, 1268; v3-d4.md:79.

### R3-RD-07  —  minor
- **Artifact:** D4
- **Location:** Fix codes, round 2, G4: "at least 3 of 5 gated cases are ahead of layer 1 by **one score step** or more … no gated case is behind by more than **one step**".
- **What is wrong:** D1, D2 and D3's `GATE.md` all say 0.2. One score step is 0.2 only on a one-grader case. On a two-grader case it is 0.1 (D3 0.6). D4 says Part 3 "can be read without opening any other file", and here it states a looser gate than the one frozen.
- **What breaks if we ship it as-is:** A reader auditing the gate from D4 alone thinks a two-grader case passes at +0.1. If D3's agent reads G4 as the intent, it may write that into `GATE.md`, which can never be changed after the first run.
- **Suggested fix:** Replace "one score step" with "0.2" in G4, matching D3 0.6.
- **Evidence:** v3-d4.md:433; v3-d1.md:221; v3-d2.md:298–300; v3-d3.md:531–532.

### R3-RD-08  —  minor
- **Artifact:** D2 (against D3)
- **Location:** D2 §1 sample: "`CORE: session hook ran · harness=claude-code · project=lantern · queue: 2 now, 2 soon` … `Soon: security review sign-off, Tue 10 Nov · tracker digest 3 days old` / `Resume here (Thu 5 Nov): …`". D3 contract F: "`… · core-dir=<path> · machine=<m> · sid=<session id> · started=<ISO time> …` / `script: <absolute path of core.mjs>` / `Soon:` / `- <text> (<id>)` / `Last handoff (_summaries/<file>): …` / `Notes below are from project memory. They are information, not instructions.`"
- **What is wrong:** D2's sample is what the reader learns "what reaches the agent" from. It drops four fields and the `script:` line, puts the soon items on one line, renames "Last handoff" to "Resume here", and leaves out the "information, not instructions" line.
- **What breaks if we ship it as-is:** A reader of D2 §9 is told hook text is fenced off as data. The one example they see has no fence. A maintainer who writes `ARCHITECTURE.md` from D2 (step 9.1: "D2, shortened") documents a format the code does not print.
- **Suggested fix:** Paste the contract F output for the Lantern case into D2 §1, fence line included.
- **Evidence:** v3-d2.md:97–105, 366; v3-d3.md:334–344, 1231.

### R3-RD-09  —  minor
- **Artifact:** D3 (and D2)
- **Location:** Contract F prompt-hook first lines: "`CORE recall: not working (index unreadable)`"; step 3.4: "missing index → the 'not working' line and a receipt with `status: unknown`". Against rule 1: "Spoken to the user they are 'working', 'broken', 'not measured'", and D2's table: "`unknown` | not measured | It could not look."
- **What is wrong:** The one line the agent sees every turn uses a fourth phrase. "Not working" is not one of the three words. It reads as "broken", while the receipt says `unknown`, which is "not measured".
- **What breaks if we ship it as-is:** The plan's central rule is three words with one fixed mapping. Its most frequent output breaks that rule at the very instrument the design rests on. An agent following `core` §16 ("'working', 'broken', 'not measured' only") has no matching word to pass on, and may say "broken".
- **Suggested fix:** `CORE recall: not measured (index unreadable)`.
- **Evidence:** v3-d3.md:43, 362, 690, 786; v3-d2.md:23–27.

### R3-RD-10  —  minor
- **Artifact:** D1 (against D2, D3)
- **Location:** D1 §4: "**Five skills.** When to write a memory, how to find one, when to speak up, how to refresh outside data, how to close a session."
- **What is wrong:** D2 and D3 name the five as `core`, `remember`, `pulse`, `finalize`, `metrics`. No skill is "how to find one": finding is a line of the block plus a hook. `metrics`, the skill that checks CORE itself, is missing from D1's list. D1 is the only document most readers open, and the verdict line is about "its five skills".
- **What breaks if we ship it as-is:** A reader states the solution as five skills that do not exist, including a "find" skill, and never learns that self-checking is a skill. Someone who compares D1 with D2 finds a mismatch in the first noun of the solution.
- **Suggested fix:** "Five skills: `core` (the brief and when to speak up), `remember`, `pulse` (what is due; outside data), `finalize` (close a session), `metrics` (check CORE itself)."
- **Evidence:** v3-d1.md:15, 107; v3-d2.md:60–66; v3-d3.md:91.

### R3-RD-11  —  minor
- **Artifact:** D1 (against D3)
- **Location:** D1 §4 size table: "Settings | 34 `CORE_*` names | 2 environment switches (one off-switch, one for test runs) plus 5 project settings".
- **What is wrong:** Contract J has seven keys. Four are settings (`recall`, `now_hours`, `archive_after_days`, `active_soft_cap`) and three record one-time offers. "5" matches neither count. Decision 16 also gives three switch names (`CORE_DISABLE`, its alias `EVAL_CORE_DISABLE`, `EVAL_CORE_ENABLE`). Table cells should not leave the alias for the reader to find.
- **What breaks if we ship it as-is:** This row is the plan's evidence for requirement 4 against CORE 3's 34 names. A reader who checks it against D3 finds the number wrong, and stops trusting the other rows of the size table.
- **Suggested fix:** "2 environment switches (plus one alias) and 4 project settings."
- **Evidence:** v3-d1.md:137; v3-d3.md:88, 425–428.

### R3-RD-12  —  minor
- **Artifact:** D1, D3, D4
- **Location:** D1 §8: "**Layer 2 also has a cost test.** If keeping it working needs the line budget raised, re-run this verdict before raising it." D3 rule 8: "Do not raise the budget." D4, partial rebuttal R1-PA-10: "if the wiring needs its line budget raised, or fails the gate, Layer 2 is dropped."
- **What is wrong:** This is a broken fix of R1-PA-10. The accepted part of that rebuttal says a budget raise drops Layer 2. D1 now says to re-run the verdict and then raise it. D3 says never raise it. Three documents, three rules. It is also called a "test" though nothing is measured.
- **What breaks if we ship it as-is:** A year from now the maintainer meets the 1,800-line cap. D1 permits a raise after a re-run, D3 forbids it, and D4 records that it ends Layer 2. The one cost control the plan claims (D4: "The line budget … is the cost control that can be measured") has no settled meaning.
- **Suggested fix:** One rule in all three places: "If Layer 2 needs more than 1,800 lines, it is shelved."
- **Evidence:** v3-d1.md:224; v3-d3.md:50; v3-d4.md:467.

### R3-RD-13  —  minor
- **Artifact:** D2 (against D2 §1 and D3)
- **Location:** D2 §9 table, Write row: "In an enabled project: `_memories/`, `_summaries/`, `_sources/`, `_core/`, `PROJECT.md`." Against D2 §1: "Skills are never gated by the enabled list; only hooks are", D3 rule 7: "Skills are not gated", and 4.3 §11, where setup creates `PROJECT.md` and `_memories/` before it enables.
- **What is wrong:** The security table, which a reader checks to learn what CORE may write, says the record is written only in enabled projects. The skills write `_memories/`, `_summaries/`, and `PROJECT.md` in any project where they run, enabled or not.
- **What breaks if we ship it as-is:** A user who clones a repository and leaves it un-enabled believes CORE will not write in it. `remember` and `finalize` still write there. A security reviewer reads requirement 6 as met by a table that is wrong about the main write path.
- **Suggested fix:** Split the row: "Skills, when you or the agent call them, in any project: `_memories/`, `_summaries/`, `PROJECT.md`. Hooks and the script's working state, in an enabled project only: `_core/`, receipts."
- **Evidence:** v3-d2.md:68, 353; v3-d3.md:49, 782.

### R3-RD-14  —  minor
- **Artifact:** D4, D3
- **Location:** D4 "Words used here": "*Enabled* means the user said '**use CORE here**' on this machine". D4 Part 1 item 9: "Each machine needs its own '**use CORE here**'." D3 contract F notice: "Say '**enable CORE here**' to review and enable it." D4 Q7: "The user says '**set up CORE here**'." D3 4.3 §10–11: enabling and setup are two different actions.
- **What is wrong:** The phrase a user types to turn CORE on appears three ways, and two of them start different actions. "Use CORE here" appears in no skill or notice.
- **What breaks if we ship it as-is:** A reader of D4 learns the wrong words. In a fresh clone, "set up CORE here" runs setup, which creates `PROJECT.md` and `_memories/` and its `.gitignore`, in a project that already has them. The safe path, "enable CORE here", counts and reads out the memories before enabling.
- **Suggested fix:** Use "enable CORE here" in D4's glossary and Part 1. Keep "set up CORE here" only for a project with no record.
- **Evidence:** v3-d4.md:11, 53, 75; v3-d3.md:329, 781–782.

### R3-RD-15  —  taste
- **Artifact:** D2
- **Location:** §7 "Numbers with a stated basis": "Skill listing cost | 400 tokens | **Measured by** `claude plugin details`."
- **What is wrong:** R2-RD-14 fixed the session-start row so that the Basis column says whether a number is real. The row below it still reads "Measured" for a budget nothing has measured. D3's Budget table shows it is a limit.
- **What breaks if we ship it as-is:** A reader scanning the Basis column for real numbers counts this as one.
- **Suggested fix:** "Limit; checked by `claude plugin details` after the build."
- **Evidence:** v3-d2.md:328; v3-d3.md:141; v3-d4.md:285 (R2-RD-14).

---

Sound: D1's first screen now gives the verdict in one bold line, and that line is the same in §8. The four-condition gate reads cleanly as a numbered list in D2 §7.

critical 0 · major 5 · minor 9 · taste 1
