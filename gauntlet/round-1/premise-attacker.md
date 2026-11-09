# Round 1 — Premise attacker

Reviewing v1 of D1–D4. Mandate: argue that CORE should not exist.

## The strongest case against CORE

CORE 4's own premise is "keep the judgment, drop the machinery", and it says the judgment "fits in a few pages". A few pages of judgment is a convention, not a plugin. Put CORE's file layout in the repo. Put five rules in `AGENTS.md`. Put the write rules in a committed `.agents/skills/` folder. All three harnesses load both natively. Nothing needs installing, trusting, or re-approving, and nothing breaks when a harness changes its hook format. It works on every machine and in every cloud session, because it travels in the repo. Add one native cloud scheduled task that reads the record each morning. That task does what the user actually wants, "tell me the legal reply is due today", even when the laptop is closed, which CORE 4 cannot do. What the plugin adds on top is small. It injects three pointers per prompt. It runs a watcher on one harness, in interactive sessions only. It sends one pre-compaction sentence and works out a due list a model can read from dates. Around those sit 1,800 lines of script, three hook dialects, a trust list, receipts, and a self-test, much of it there to check the rest. CORE 3 shows where that leads. It grew from 8 script files to 100 in 150 days, and two of every three fixes were instruments lying about themselves. A convention has no instruments to lie. The plan's one existential test should settle this, but it cannot. The "files alone" arm has no `AGENTS.md`, cannot load one inside the eval runner, and is graded partly on CORE's own output format. So the plugin passes even if it adds nothing to recall. The case against mem0, Zep, Letta, claude-mem, and basic-memory as replacements does **not** hold, and I do not argue it. The case against shipping CORE as code rather than as a convention holds until a fair test says otherwise.

---

### R1-PA-01  —  critical
- **Artifact:** D1 / D2 / D3
- **Location:** D1 §8, "Claude Code's test runner gives the plain-files-alone score… If the plugin does not clearly beat the files alone… ship the file layout and a two-page `AGENTS.md` pattern". D2 §7, cell B, "the files alone". D3 step 0.6, the Lantern fixture. D3 step 9.4, "The plugin beats plain files".
- **What is wrong:** The verdict names the fallback as "file layout plus an `AGENTS.md` pattern". The test never runs that fallback. Cell B is the file layout with **no instructions at all**. The Lantern fixture writes `README.md`, `PROJECT.md`, `_memories/`, and `_sources/`, but no `AGENTS.md`. Adding one would not help. Claude Code's eval runner loads no project-level instructions. Claude Code reads `AGENTS.md` through a built-in plugin, and the runner loads only the plugin under test. So A − B measures "CORE versus a folder nobody was told to read". It does not measure "CORE versus the convention D1 says we would ship instead".
- **What breaks if we ship it as-is:** The release gate and D1's kill rule both read A − B. A positive A − B gets reported as "the plugin beats plain files". That is the decision the whole plan rests on, and it is decided against a strawman. The owner keeps maintaining 1,800 lines of code that a 40-line `AGENTS.md` might match. Nobody can tell, because the convention was never in the room.
- **Suggested fix:** Add a convention arm K. Make a second plugin target whose only content is the `AGENTS.md` text and CORE's skill files, delivered the way the native loader would deliver them: a one-line SessionStart hook that prints `AGENTS.md`, and the skills as plugin skills. Run the same cases against it, and gate on A − K, not A − B.
- **Evidence:** `https://code.claude.com/docs/en/plugin-evals.md` §How runs are isolated: "Nothing personal or project-level loads… no `.claude/` directory, `CLAUDE.md`, or `.mcp.json` loads from above the workspace or inside it, even one a `scaffold_script` wrote" and "the agent under test runs there… with only your plugin loaded". `https://code.claude.com/docs/en/memory.md` §Choose which instruction files load: AGENTS.md is read by "`cc-plugin-agents-md@builtin`, the ID of the built-in plugin that reads `AGENTS.md`". The fixture's file list is at `gauntlet/v1-d3.md:478-489`. I did not run the eval, so whether `AGENTS.md` loads there is inferred from the isolation text. The fixture has no `AGENTS.md` either way.

### R1-PA-02  —  critical
- **Artifact:** D3 / D2
- **Location:** D3 step 7.6, the `brief-budget` and `proactive-due` graders. Step 9.4, "mean A − B of +0.3 or more across the four **T** cases". Step 0.6, "If every plain-case score is 0.9 or higher, **stop**".
- **What is wrong:** Two of the four gated cases are ones the plain arm cannot win, whether or not the plugin helps. `brief-budget` passes only if the reply is "8 lines or fewer" with the retention item first. Eight lines is CORE's own output rule, and in the fixture `PROJECT.md` puts the retention item under `## Next`, after `## Now`. `proactive-due` asks for a typo fix and passes only if the reply also brings up an item the plain arm was never told about. Assume recall ties at 1.0 in both arms, `brief-budget` B scores 0.5 (the regex passes, the judge fails), and `proactive-due` B scores 0. Then mean A − B = (0 + 0 + 0.5 + 1) / 4 = 0.375. That clears +0.3 with zero gain in recall. The same structure means the step 0.6 stop rule can never fire, because `proactive-due` will not reach 0.9 in the plain arm. Claude Code's own eval docs warn about exactly this: a grader that "can never pass without the plugin… would push the without-arm toward zero and inflate `Δ`". The runner removes such graders from the score only for checks like `tool_used: Skill`. It leaves the plan's regex and judge graders in.
- **What breaks if we ship it as-is:** CORE passes its existential test while being the wrong choice. The "measure first" step cannot stop the build. The verdict's one number reports a gain made of format compliance and of an arm that was never given the instructions.
- **Suggested fix:** Gate per job, not on a pooled mean, and gate recall on its own. Take CORE-specific format rules out of the graders, or give the comparison arm the same rule in its `AGENTS.md`. With R1-PA-01's arm K, `proactive-due` becomes a fair question: does a hook beat a written instruction to mention due items?
- **Evidence:** `gauntlet/v1-d3.md:934-935` (grader text), `:1042` (gate), `:493` (stop rule), `:481` (fixture `PROJECT.md`). `plugin-evals.md` §Score against the no-plugin baseline: "A check like 'the skill was invoked' can never pass without the plugin, so counting it would push the without-arm toward zero and inflate `Δ`."

### R1-PA-03  —  major
- **Artifact:** D1 / D2 / D3
- **Location:** D1 §8, "The proof is one number". D2 §7, the four cells. D3 step 7.6: the `remember-*` and `finalize-*` cases have no `--norecord` twin and are not in the A − B gate.
- **What is wrong:** The test can also fail CORE when CORE is right. Every gated case starts from a record written by hand, so the "files alone" arm gets a curated record for free. Yet the record is the thing at stake. Over months, who writes it, how completely, and whether retired facts stay retired is where a plugin, a convention, or nothing would differ most. The runner is single-session, so it cannot see a record build up, get replaced, or drift. A single session can only test reading, and modern models read files well. That pushes A − B toward zero for reasons unrelated to CORE's real value. It also inflates B against the real-world "plain files" case, where nobody keeps the files current.
- **What breaks if we ship it as-is:** The verdict can go either way for the wrong reason. A small A − B kills a plugin whose value is on the write side. A large one keeps a plugin whose write side was never tested. Either way the owner decides on evidence that does not touch the question.
- **Suggested fix:** Add one longitudinal test. Run about ten scripted sessions from an empty folder per arm (CORE, convention K, Claude Code auto memory on). Each arm writes its own record. Then probe for the decisions, the replaced decision, the risk, the person, and the due item. Report the write rate per arm next to A − K.
- **Evidence:** `gauntlet/v1-d3.md:927` ("Cases marked **T** have a `--norecord` twin"; only four are T). `gauntlet/v1-d4.md` Part 1 §3 already admits that remembering "depends on the model choosing to remember".

### R1-PA-04  —  major
- **Artifact:** D1 / D3
- **Location:** D1 §4, "Keep the judgment. Drop the machinery… That is judgment. It fits in a few pages." D3 Target layout: 14 modules in `scripts/lib/`, three hook files, a monitor.
- **What is wrong:** The premise argues against the conclusion. If the value is judgment that fits in a few pages, the minimal product is those pages. Look at the 14 modules. `result`, `receipts`, `check`, `selftest`, `trust`, `hooks`, and `cli-entry` exist to run, guard, or verify CORE itself. That is half the modules, the same self-servicing shape D1 §1 criticises in CORE 3 ("about 34% measure CORE itself"). `index.mjs` duplicates a native behaviour. Claude Code's auto memory already uses CORE 4's exact shape: a one-line-per-memory `MEMORY.md` index plus one topic file per fact, with a `project` type for "ongoing work, deadlines, and decisions". The agent keeps that index itself, with no script. The native-first test (requirement 2) is never applied to the index, the due list, or the recall matcher one by one.
- **What breaks if we ship it as-is:** The rewrite ships a smaller copy of the pattern it diagnoses as the cause of the defect class. Each kept module is another place an instrument can report success while doing nothing, and each needs its own guard. That is the mechanism D1 §1 blames for "34,000 lines".
- **Suggested fix:** In D1, give each module one line: "Why can't the agent, following the skill, do this?" Delete every module whose answer is "it could, less reliably", unless the convention arm in R1-PA-01 shows the gap is real.
- **Evidence:** `gauntlet/v1-d3.md:149-151` (module list). `https://code.claude.com/docs/en/memory.md` §Auto memory: "`project`: ongoing work, deadlines, and decisions that Claude can't derive from the code or git history" and "`MEMORY.md` # Index, one line per memory, loaded into every session".

### R1-PA-05  —  major
- **Artifact:** D2
- **Location:** D2 Alternatives, "Put the brief in `AGENTS.md` and skip the session-start hook. Rejected… a controlled study found always-loaded context files raised cost by about 20% without a reliable gain in task success".
- **What is wrong:** The study is used against `AGENTS.md` only. CORE's session-start hook does the same thing. It loads up to 6,000 bytes of `PROJECT.md` into every session in an enabled project. Whether that text arrives through `AGENTS.md` or through a hook does not change what the model reads. If the study counts, it counts against CORE's brief too. D4 Part 2 row 24 admits this ("Does the brief itself help? Unknown"). D2 uses it in one direction only.
- **What breaks if we ship it as-is:** The main written reason for a session-start hook over the zero-code alternative is evidence that cuts both ways. A reader takes "hook beats `AGENTS.md`" as supported by research. It is not.
- **Suggested fix:** Drop the study from the rejection. State the real difference: a hook guarantees the brief is injected, while `AGENTS.md` only tells the agent to read it. Then test that difference with arm K.
- **Evidence:** `gauntlet/v1-d2.md:352`. `gauntlet/v1-d3.md:98` (Decision 25: "the first 6,000 bytes of `PROJECT.md`"). `gauntlet/research-literature.md:83` (arXiv 2602.11988: "does not generally improve task success rates, while increasing inference cost by over 20%").

### R1-PA-06  —  major
- **Artifact:** D1 / D2
- **Location:** D1 §6, built-ins row, Interact: "Partial: schedulers exist, nothing uses them for the project". D1 §6, the kit "would lose… anything that speaks up during a session". D2 §11, "CORE cannot refresh anything while every harness is closed".
- **What is wrong:** For the owner's stated need, being told what is due, a native scheduled task beats CORE 4 in the case that matters most: when no session is open. Claude Code's cloud scheduled tasks clone the repo, use the skills committed to it, call connectors, and "keep working when your laptop is closed". Codex has scheduled tasks in its app and on the web, and Antigravity has Automations. Making one of them read `PROJECT.md` and `_memories/` each morning takes one prompt and no code. CORE's only between-prompt feature is a watcher on one harness, in interactive sessions only. It also adds mid-session interruption, the form of proactive help with the weakest evidence. The research CORE cites found that more frequent suggestions halved user preference, and that task boundaries work best. Session start is a boundary, and the convention already covers it.
- **What breaks if we ship it as-is:** "Interact" is CORE 4's main claimed lead over the kit. It is weaker than the native option exactly where the owner needs it. A deadline that falls due on a day the owner does not open Claude Code is never surfaced.
- **Suggested fix:** Add "native scheduled task over the record" as a named rival in D1 §6, and price the watcher against it. If the watcher does not beat a morning task plus a session-start rule, drop it.
- **Evidence:** `https://code.claude.com/docs/en/routines.md`: "Scheduled tasks execute on Anthropic-managed cloud infrastructure… so they keep working when your laptop is closed", and "those skills include the ones committed to the cloned repository". `gauntlet/research-competitors.md` §6.2 and §6.3 (Codex scheduled tasks, Antigravity Automations). `gauntlet/research-literature.md` §8 ("reducing participant preference for the proactive assistant over baseline by half"; "intervening at programmer's task boundary — was the most effective design principle overall").

### R1-PA-07  —  major
- **Artifact:** D1 / D2
- **Location:** D2 §5 rung B, "Claude Code headless or cloud". D2 §9, "Hooks do nothing in a folder until you have enabled CORE there on this machine." D1 §2, "on a laptop and in cloud sessions".
- **What is wrong:** The trust list lives at `~/.core/projects.json` on each machine. A cloud session starts in a fresh container, so it has no trust list, and every project is "not enabled". In the cloud, CORE drops to files-only plus a "not enabled" line, not to rung B as the table says. A scheduled cloud run gets the same. The convention behaves the same on every machine, because everything it needs is in the repo. CORE also needs, per machine: the plugin installed, Node 20 on the PATH, the trust entry, and on Codex, hook re-approval after every CORE update.
- **What breaks if we ship it as-is:** The owner is promised the full brief and recall in cloud sessions and gets none, with no warning in the ladder table. One of the three settings D1 §2 uses to justify CORE is one where the convention beats CORE outright.
- **Suggested fix:** Correct the cloud row of the ladder. Put "works with zero per-machine setup" in D1 §6 as a column, so the comparison shows what the per-machine state costs.
- **Evidence:** `gauntlet/v1-d2.md:179` (rung B), `:294` ("enabled CORE there on this machine"). `gauntlet/v1-d3.md:597` (the trust list read from `os.userInfo().homedir`; "A missing or unparseable list means nothing is trusted"). `gauntlet/v1-d2.md:165` (Codex re-approval "again after every CORE update").

### R1-PA-08  —  major
- **Artifact:** D1
- **Location:** D1 §6, the comparison table. D1 §8, "The nearest fallback is basic-memory for storage plus our own skills on top".
- **What is wrong:** The real runner-up never goes through the comparison. D1's own Alternatives table calls the pragmatic kit "the honest runner-up… If CORE 4 fails its test, this is what to use". Yet the kit has no row in the §6 table. The verdict then answers "does something else replace CORE?" by knocking down basic-memory (Python, AGPL, a local index), a fallback no section recommends. The §6 table also pits a plan ("CORE 4 (planned, not built)", all Yes) against shipped tools, scored on CORE's own five-job breakdown. So "no row is yes across the five jobs" holds partly by construction.
- **What breaks if we ship it as-is:** A reader comes away believing nothing else covers the owner's use. The one alternative that might was never scored, so the "No, not today" verdict was never tested against the option it most needed to beat.
- **Suggested fix:** Add a row for "CORE's file layout + `AGENTS.md` + committed skills + one native scheduled task", with the same columns. Rewrite the §8 answer against that row, not basic-memory.
- **Evidence:** `gauntlet/v1-d1.md` §6 table (no kit row), §8 paragraph 2, Alternatives table last row.

### R1-PA-09  —  major
- **Artifact:** D1
- **Location:** D1 §6, "They would lose: risks and people as records, anything that speaks up during a session, a session close written into the project, one behavior across three harnesses, and any evidence that it helps."
- **What is wrong:** Four of the five losses vanish once the kit uses CORE's own files and skills without hooks or a script.
  1. *Risks and people as records* is a file schema. CORE 4 writes these files with the agent's file tools, guided by prose. A convention does the same.
  2. *A session close written into the project* is a skill instruction. CORE 4's `finalize` is itself a skill.
  3. *One behaviour across three harnesses*: `AGENTS.md` and `SKILL.md` are the one surface all three harnesses share. CORE's hooks are what make it behave differently, across rungs A, B, and C.
  4. *Evidence that it helps*: measurement can live in the repo's CI against the convention. D3 Decision 30 already keeps the blind and cells tools out of the shipped plugin.

  What actually remains is per-prompt pointer injection, the Claude Code watcher, the pre-compaction sentence, a script-computed due list, and receipts.
- **What breaks if we ship it as-is:** The verdict weighs CORE against a kit made to look worse than it is. The owner pays the plugin's full cost for a list of benefits mostly available without it.
- **Suggested fix:** Replace the five losses with the true remainder, and price each item: its evidence, the harnesses it works on, and its upkeep.
- **Evidence:** `gauntlet/v1-d3.md:103` (Decision 30). `gauntlet/v1-d2.md:51-57` (`remember` and `finalize` are skills). `gauntlet/v1-d2.md:176-182` (rungs differ per harness).

### R1-PA-10  —  major
- **Artifact:** D1
- **Location:** D1 §7 risks, "One maintainer. Certain. 1,800 lines is something one person can hold in their head." D1 §8 verdict.
- **What is wrong:** The verdict has a benefit test and no cost test. The base rate is bad. CORE 3 went from 8 script files to 100, and from 70 KB to 1.7 MB, in 150 days. About two of every three "Fixed" bullets were the defect class. Every script line is a place an instrument can lie. A convention has no instruments, so it cannot report false success. D1's own risk table rates harness hook churn as High: Antigravity's hook format changed three times in three weeks, and Codex needs re-approval on every update. None of that upkeep enters the verdict. The plan offers a line budget as the only brake.
- **What breaks if we ship it as-is:** CORE 4 can pass its benefit test and still be the wrong choice, because it costs the owner more hours than it saves. Nothing in the plan would notice. The six-monthly re-read has no number to read.
- **Suggested fix:** Add a cost line to the verdict. Log maintainer hours per month and breakages per harness release. Set a kill trigger: if upkeep exceeds the measured benefit for two releases, fall back to the convention.
- **Evidence:** `gauntlet/source-changelog.md:9-11` ("Shipped scripts went from 8 files to 100, and from 70 KB to 1.7 MB"; "about two in three of all 'Fixed' bullets belong to this family"). `gauntlet/v1-d1.md` §7 risk table, first row.

### R1-PA-11  —  major
- **Artifact:** D1
- **Location:** D1 Alternatives, "Use the harness built-ins only… This is the baseline CORE 4 must beat in its own test."
- **What is wrong:** This is false. The eval runner switches off built-in memory: "memory… absent". Cell C is "nothing", not "built-ins". So CORE 4 is never compared with Claude Code's auto memory, which already stores project decisions and deadlines on the owner's main harness. Codex's own docs also say to keep durable guidance in `AGENTS.md` or checked-in documentation, and to treat memories as "a helpful recall layer". That is the convention, not a plugin.
- **What breaks if we ship it as-is:** A reader believes CORE has beaten the built-ins. It has not been run against them. The cheapest real alternative on Claude Code goes unmeasured, and the claim stands in for the check, which is the defect class this plan exists to kill.
- **Suggested fix:** Correct the sentence. Either add a built-ins arm (auto memory on, run outside the isolated runner, since the runner cannot load it), or state plainly that the built-ins are not measured.
- **Evidence:** `plugin-evals.md` §How runs are isolated: "Your user settings, hooks, `CLAUDE.md` files, MCP servers, other installed plugins, memory, and skills are absent." `https://learn.chatgpt.com/docs/customization/memories.md`: "Keep required team guidance in `AGENTS.md` or checked-in documentation. Treat memories as a helpful recall layer".

---

## What would have to be true for CORE to win

The plugin earns its code only if all four hold:

1. **A − K is clearly positive on recall**, with arm K being the convention from R1-PA-01. That means questions phrased unlike the summaries, where a model told to "check `_memories/INDEX.md`" still does not look, and the per-prompt pointer catches it.
2. **The plugin's record is better over time**, in the longitudinal test of R1-PA-03. It writes more of the planted decisions and risks than the convention does, and fewer retired facts come back.
3. **Upkeep stays below the gain** (R1-PA-10). Hooks survive harness releases without monthly repairs, and Codex re-approval is tolerable.
4. **The owner mostly works where the extras exist**: local, interactive Claude Code, the only place where the watcher and full rung A run.

If 1 and 2 fail, ship CORE as a convention: the file layout, `AGENTS.md`, and committed skills. CORE's judgment survives, and its code does not.

## Where the plan is sound

Rejecting mem0, Zep/Graphiti, Letta Code, claude-mem, basic-memory, and Anthropic's `productivity` plugin as replacements is well supported for this owner. Plain files in the project are the right store.

critical 2 · major 9 · minor 0 · taste 0
