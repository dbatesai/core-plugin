# Round 3 — Premise attacker

Reviewing v3 of D1–D4. Mandate: argue that CORE should not exist, and test whether the verdict could ever come out against it.

## The strongest case against CORE

v3 put CORE on trial. It added kill tests, so the plan can now say "do not build CORE". The trial is rigged in CORE's favour at both levels.

Layer 1 is tried against an arm called "files". In the record test, that arm has no instruction file, no block, and auto memory switched off. It is an agent with an empty folder. It will recall almost nothing, so Layer 1 clears "one more probe than files" without trying. The arm that would make the test real is the kit the verdict names as the fallback: built-in memory plus the same three lines. It is never run. Round 2 asked for exactly that arm (R2-PA-06), and it was dropped.

Layer 2 is tried against Layer 1. But the gate is settled by the fixture, not by the wiring. The 295 distractors all have file names like `dc-20260801-note-NNN`. The four real answers sit in files named `retry-header-v2`, `provider-deadline`, `person-alex`, and `data-retention`. Any arm that lists the folder finds them by name. Three recall cases sit at the ceiling in both arms. The null case does too. Only `proactive-due` can open a gap, and the gate needs three. So Layer 2 is shelved before the first run. When it is shelved, the shipped plugin has no script. That means no `check`, no `selftest`, no `metrics`, and no `migrate`. Hard requirements 7 and 8 go with it.

So the likeliest outcome of the plan as written is this. Build everything (1,800 lines, three hook dialects). Find Layer 2 shelved for a reason the fixture decided. Ship five prose skills with no self-audit. Those skills have never been compared with the one native option that matters: Claude Code's auto memory, on by default, with a `project` type whose definition CORE's block copies almost word for word.

That is a convention, the thing Round 1 argued for. The plan may well end there. The trouble is that it gets there by accident, after the build, and without the comparison that would justify it.

The case against mem0, Zep, Letta, claude-mem, and basic-memory as replacements still does not hold. I do not argue it.

---

### R3-PA-01  —  critical
- **Artifact:** D3 / D1 / D2
- **Location:** D3 7.7 step 2, "**Files**, **built-in:** nothing more."; step 1, "`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in every arm but built-in"; D3 0.6 GATE.md, "**Keep Layer 1** only if, in 7.7, layer 1's probe hits exceed files' by at least 1… Otherwise: 'Use the kit and the harness built-ins; do not build CORE.'"; D1 §8 kill test 1.
- **What is wrong:** The test that can retire CORE (G3, the fix for R2-PA-06) cannot fail.
  - The record test's "files" arm starts from an empty `PROJECT.md` and an empty `_memories/`. It has no `AGENTS.md`, no `CLAUDE.md`, and no block, and auto memory is switched off.
  - Nothing tells that agent to write anything, and nothing carries a fact between its sessions. Its probe score is near zero by construction. In practice it is the **nothing** arm under another name.
  - Layer 1 needs only one more hit than that. It clears the bar if the `remember` skill fires once in ten sessions.
  - The arm the verdict names as the fallback, "the kit", is never run. The kit is built-in memory plus an instruction file. R2-PA-06 asked for that arm: auto memory, `autoMemoryDirectory` pointed at `<repo>/_memories/`, plus the block. G3 swapped it for the strawman.
- **What breaks if we ship it as-is:** D1's headline, "Its five skills must beat plain files… or that part does not ship", becomes a test that passes whatever Layer 1 does. CORE's existence is again decided by assumption, which is the defect R2-PA-06 was accepted to remove. If the kit would do as well, the plan never finds out. The owner then keeps a second memory system on every harness with no evidence it earns its place.
- **Suggested fix:** Replace the 7.7 "files" arm with "kit": auto memory on, plus a `CLAUDE.md` and `AGENTS.md` holding the same three-line block with no skills. Keep Layer 1 only if it beats the kit by the frozen margin. Keep a true "nothing" arm as the floor.
- **Evidence:** v3-d3.md:1152–1153, 533, 1268; v3-d1.md:15, 214–222; R2-PA-06 suggested fix ("Add a fourth 7.7 arm, auto memory with `autoMemoryDirectory` set to `<repo>/_memories/` plus the block"); v3-d4.md fix code G3 (no such arm). `https://code.claude.com/docs/en/memory.md` §Storage location: "To store auto memory in a different location, set `autoMemoryDirectory`… The value must be an absolute path or start with `~/`."

### R3-PA-02  —  critical
- **Artifact:** D3 / D2 / D1
- **Location:** D3 0.6 fixture: "`dc-20261002-retry-header-v2`", "`risk-20261015-provider-deadline`", "`person-alex`", "295 distractors `dc-20260801-note-NNN`"; contract C, "`id` equals the file name without `.md`"; GATE.md condition (1), "at least 3 of 5 gated cases have full − layer 1 ≥ 0.2".
- **What is wrong:** The fixture settles the Layer 2 gate before any run. G4 and the R2-PR-03 fix added distractors whose summaries share words with the questions. They do not share file names.
  - A `Glob` or `ls` of `_memories/` shows 295 files called `…note-NNN` and four with names that state the answer: `retry-header-v2`, `provider-deadline`, `person-alex`, `data-retention`. The layer 1 arm has `Glob`, `Grep`, and `Read`, and the block tells it to look in `_memories/`.
  - `recall-past-decision` and `recall-distractors` both contain "v2". No distractor summary contains "v2". The paraphrase case ("money-movement code") points at the one file named after a person.
  - So all three recall cases sit near 1.0 for layer 1, and the paraphrase case gives the prompt hook nothing to match by design (D4 Part 1 item 4). `null-rename` sits near 1.0 in both arms.
  - That leaves `proactive-due` as the only case where full can lead by 0.2. The gate needs three.
- **What breaks if we ship it as-is:** Layer 2 is shelved for a reason the fixture fixed in advance, not because the wiring failed. The plan still builds all of it first: phases 1–3, three hook dialects, receipts, and the self-test. The verdict "code must beat the skills" becomes a property of file naming. The reverse also holds: a fixture with opaque names might show a real recall gain that this one hides.
- **Suggested fix:** Give every fixture memory an opaque id of the same shape (for example `dc-2026MMDD-NNN`), so no file name carries an answer. Include the real items among distractors that share their distinctive tokens ("v2", a person's name). Before freezing GATE.md, check by hand that a single `ls` or `grep` of the question's rarest word does not solve any gated case.
- **Evidence:** v3-d3.md:538–546 (fixture ids and distractor template), contract C (v3-d3.md:262, "`id` equals the file name"), 532 (condition 1), 1101–1105 (case prompts); v3-d4.md:320 (R2-PR-03, "fixture adds 255 distractors with shared words"); v3-d4.md Part 1 item 4.

### R3-PA-03  —  critical
- **Artifact:** D3 / D2
- **Location:** D3 7.7 step 1, "`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in every arm but built-in"; 7.7 measures, "**duplicates** (one fact in two or more live files, `_memories/` and auto memory together)"; D2 §4, "Setup… offers `autoMemoryEnabled: false` for this project; default no… The record test counts duplicates across both (§7)."
- **What is wrong:** CORE ships beside auto memory, but it is only ever tested without it.
  - The shipped default on Claude Code is auto memory **on**: setup's offer to turn it off defaults to no. The full and layer 1 arms run with auto memory **off**.
  - So the counter for duplicates across the two stores, the fix for R2-PR-19, always reads zero in the only arms where a duplicate could arise. That is the defect class the plan exists to kill: an instrument that reports a clean number while looking at nothing.
  - It also breaks CORE's own rule. D2 §6 names "Two records of one state" as one of the six ways checks lie. CORE 4's default on its main harness creates exactly that: auto memory's `project` type saves "ongoing work, deadlines, and decisions that Claude can't derive from the code or git history". CORE's block says to write what "a later session would need and cannot get from the code or git history".
- **What breaks if we ship it as-is:** The results file will show "duplicates: 0" and "stale copies: 0" for CORE. Real users will have every decision in two stores, and a reversed decision still live in auto memory. The release gate and the verdict are scored on a setup no user runs.
- **Suggested fix:** Run full and layer 1 with auto memory **on**, since that is what ships, and add those as the gated arms. Or make "auto memory off for this project" the setup default, and test with it off. Either way, report the duplicate counter as "not measured" in any arm where auto memory is disabled.
- **Evidence:** v3-d3.md:1152, 1157, 782 (setup offer (c), "Default no"); v3-d2.md:183, 241, 289; v3-d4.md:336 (R2-PR-19, fix "7.7 counts duplicates across both"). `https://code.claude.com/docs/en/memory.md` §Auto memory: "`project`: ongoing work, deadlines, and decisions that Claude can't derive from the code or git history"; "Auto memory is on by default in local sessions."

### R3-PA-04  —  critical
- **Artifact:** D3 / D2 / D1
- **Location:** D3 9.4, "**Layer 2 fails** → … On `v4`, replace `plugins/core/` with `dist/core-layer1/` plus the three manifests"; G1, "`dist/core-layer1/`: a plugin holding only the five skills and the block text. No hooks, no monitor, no script."; contract K "Without the script… Skip `index`, `close`, and receipts."; D2 §7, "CORE ships as Layer 1."
- **What is wrong:** The gate's likeliest outcome (R3-PA-02) ships a CORE that fails two hard requirements.
  - Requirement 8 (self-auditing: prose, scripts, paths, links, and instruments reading nothing) lives in `check --plugin`, `check --project`, and `selftest`. Requirement 7's metrics live in `metrics`. All are commands of the script that the Layer 1 package leaves out.
  - `queue` goes too. The plan justifies it because "models misjudge dates", so after a shelve, "what is due" falls to the model the plan says gets dates wrong.
  - `migrate` goes too, which strands every CORE 3 store.
  - Neither D1 §8 nor D2 §7 says that shelving Layer 2 drops these.
- **What breaks if we ship it as-is:** The release can be marked "Layer 2 shelved, ship Layer 1" by following the gate exactly, and the shipped plugin then has no self-audit, no heartbeat, no metrics, and no migration. The `metrics` skill answers "not measured" for every row, forever. The contract's two self-checking requirements are met on a branch nobody installs.
- **Suggested fix:** Split the script out of the Layer 2 verdict. The script (`check`, `selftest`, `metrics`, `queue`, `migrate`) ships with Layer 1 as an on-demand tool, and only the hooks are on trial. Or state in D1 §8 that a Layer 2 shelve means requirements 7 and 8 are not met, and that a person must approve that.
- **Evidence:** v3-d3.md:1270, 452–458, 114 (`queue`: "Models misjudge dates"), 117–118, 436–444; v3-d4.md fix code G1; v3-d2.md:303; contract.md requirements 7 and 8.

### R3-PA-05  —  major
- **Artifact:** D1 / D3
- **Location:** D1 §8 kill test 2, "If built-in recalls more probes than layer 1, use the built-ins on Claude Code."; D3 9.4, "**Built-in beats layer 1** → add 'On Claude Code, use the built-in memory.'"
- **What is wrong:** Kill test 2 kills nothing.
  - When it fires, the build does not stop. A line is added and CORE ships on all three harnesses.
  - Claude Code is the only harness either test measures. If built-in memory wins there, CORE's whole remaining case rests on Codex and Antigravity, where nothing is measured and D1 says the result is "inferred".
  - The comparison is also lopsided. Layer 1 gets the block in both `AGENTS.md` and `CLAUDE.md`, plus five skills. Built-in gets no instruction at all. A single `CLAUDE.md` line ("save decisions, risks, people, and due dates to memory") costs nothing and is never tried.
- **What breaks if we ship it as-is:** The plan can find that the native feature beats CORE on the one harness it can measure, and still ship CORE everywhere on inference. On Claude Code the owner then runs both, which R3-PA-03 shows is never tested.
- **Suggested fix:** If built-in (with a one-line write instruction) matches or beats layer 1, stop before 9.5 as for kill test 1. A person then decides whether an unmeasured two-harness case justifies the build. Give the built-in arm the same instruction text the layer 1 arm gets, minus the skills.
- **Evidence:** v3-d1.md:216–218, 222–224 ("Both tests run on Claude Code only; for Codex and Antigravity the result is inferred"); v3-d3.md:534, 1153, 1268–1269.

### R3-PA-06  —  major
- **Artifact:** D1 / D2 / D3
- **Location:** D1 §4 "Layer 2: the wiring"; D2 §7 "The gate"; D3 GATE.md "**Keep Layer 2** only if all hold".
- **What is wrong:** The two-layer split is the wrong cut for the decision it serves. Layer 2 bundles three things with very different expected value, and the gate keeps or shelves them as one:
  - The session-start hook: brief, due items, resume line. This is where `proactive-due` and the owner's "tell me what is due" live.
  - The per-prompt BM25 pointer hook. Against an agent that greps a folder, it adds little, and it is blind to paraphrase by design.
  - The self-measurement apparatus: receipts, heartbeat, `env`, `selftest`. It mostly exists to check the hooks.

  A strong session-start hook and a useless prompt hook score as one arm. The gate cannot tell which earns its place.
- **What breaks if we ship it as-is:** Either the useful hook is shelved with the useless one (the likely case, R3-PA-02), or a win on `proactive-due` carries the prompt hook, receipts, and their 300 ms per-prompt cost into every session. Either way, "its code must beat the skills" is answered for a bundle nobody chose on evidence.
- **Suggested fix:** Add one arm, "layer 1 + session-start hook only". Gate each hook against the arm below it. Ship the prompt hook only if it beats session-start-only on the recall cases.
- **Evidence:** v3-d1.md:109–113; v3-d2.md:88–96, 292–303; v3-d3.md:532; v3-d4.md Part 1 item 4.

### R3-PA-07  —  major
- **Artifact:** D3 / D1
- **Location:** D3 phase order: phases 1–3 (script, receipts, index, recall, hooks), 4–5 (skills), 7.6–7.7 (tests), 9.4 "**Layer 1 fails** → 'Use the kit and the harness built-ins; do not build CORE.' Stop before 9.5".
- **What is wrong:** The test that decides whether to build CORE runs after CORE is built.
  - Layer 1 is prose by definition. The kit needs nothing built. The record test needs only `sessions.mjs` and a Layer 1 package of five `SKILL.md` files.
  - So the existence question could be answered in Phase 0, before a line of the 1,800-line script. Instead it runs at 7.7, after the script, three hook formats, the self-test, and the migration exist.
  - Step 0.6 measures only whether "files" (no instructions) already pass the eval cases. That is not the existence test.
- **What breaks if we ship it as-is:** "Do not build CORE" arrives as a verdict on something already built, read by the person who built it. Sunk cost then decides the "person decides" step in 9.4. The plan's own words, "Numbers chosen after the results can be fitted to them", apply equally to a verdict reached after the investment.
- **Suggested fix:** Move the layer 1 vs kit and layer 1 vs built-in record-test arms into Phase 0, right after GATE.md is frozen, with the five skills written first in their script-free form. Build phases 1–3 only if Layer 1 survives.
- **Evidence:** v3-d3.md:464–555 (Phase 0 contents), 1145–1162 (7.7), 1268; v3-d3.md:1293 ("Setting the gate after the first run").

### R3-PA-08  —  major
- **Artifact:** D3
- **Location:** D3 0.6, "**Decide:** if files scores 0.9 or more on all four memory cases (all gated but `null-rename`), **stop**".
- **What is wrong:** The one early stop still cannot fire. This is the R1-GA-09 problem in a new form.
  - The four "memory cases" include `proactive-due`, whose `-files` twin has no block and no skill. Its prompt is "Add a period to the end of the second line of README.md."
  - Nothing tells that agent to open `PROJECT.md` or `_memories/`, and its `llm` grader needs a mention of "the data-retention item due today". It fails by construction.
  - R1-GA-09 suggested judging the stop per case. That was not done.
- **What breaks if we ship it as-is:** Even if the record alone answers every recall question, which R3-PA-02 makes likely, the build continues. The native-first check that 0.6 claims to be is an artifact of one case that no instruction-free arm can pass.
- **Suggested fix:** Judge the stop on the three recall cases: if files scores 0.9 or more on all three, stop work on the recall hook and the index. Judge `proactive-due` separately against a files twin that has the block.
- **Evidence:** v3-d3.md:550, 1104 (`proactive-due` row), 1097 (twins have no block); `gauntlet/round-1/gap-auditor.md` R1-GA-09.

### R3-PA-09  —  major
- **Artifact:** D1 / D2
- **Location:** D1 §6, "**Claude Code Projects**… Its threads skip repository skills, so there CORE is the record and the block"; the table row "Claude Code Projects (beta) | … | Not checked | Not checked |"; D2 §5 rung "Files only", "a Claude Code Projects cloud thread (loads `CLAUDE.md`, not skills or plugins)".
- **What is wrong:** The closest native rival is described wrongly, and so is CORE's rung on it.
  - Projects docs say plugins added in **Project settings > Plugins** load into every new cloud thread, and skills enabled on the claude.ai account load too. Only plugins *declared in the repo's* `.claude/settings.json` do not load. So D2's "not skills or plugins" is false.
  - The same page says every cloud thread can use all the account's connectors. So Projects' "Update" cell is answerable, and D1 leaves it "Not checked".
  - The R2-PA-05 rebuttal leaned on the repo-settings line and missed the Project-settings route.
- **What breaks if we ship it as-is:** D1's verdict line, "nothing checked covers it", rests on a rival with two unchecked cells, one of which the docs answer. The ladder tells a Projects user they are on "Files only" when CORE can be installed there. The plan never asks the more useful question: is Projects plus CORE's skills the owner's real setup on Claude Code? Projects already brings memory, "Waiting on you", notifications, scheduled tasks, and connectors.
- **Suggested fix:** Correct the D2 rung: in a Projects thread, CORE's skills load when added in Project settings, and hooks are not enabled there. Fill Projects' Update cell from the docs. State in D1 §6 what CORE adds inside Projects, not instead of it.
- **Evidence:** v3-d1.md:160, 180; v3-d2.md:204, 421. `https://code.claude.com/docs/en/claude-projects.md`: "Plugins: add them in **Project settings > Plugins**; they load into each new cloud thread. Plugins that a repository declares in its `.claude/settings.json` don't load in cloud threads"; "Skills: enable them for your claude.ai account, and cloud threads load the skills you enable there"; "cloud threads get their MCP tools from the connectors on your claude.ai account… Every cloud thread can use all of them".

### R3-PA-10  —  major
- **Artifact:** D1 / D3
- **Location:** D1 §8, "For the owner's own use — … a need to be told what is due: nothing checked covers it."; D1 §6 row "CORE 4, planned | … | Interact: Session start and each prompt"; D3 7.7 probes; 9.4 "Layer 2 fails → … replace `plugins/core/` with `dist/core-layer1/`".
- **What is wrong:** Interact, being told what is due, is what separates CORE from the kit in D1's own table. No existence test measures it.
  - Kill test 1 counts recall probes only. A probe *asks* for the due date, which is recall, not speaking up.
  - `proactive-due` compares full with layer 1 only. It never compares layer 1 with the kit.
  - CORE 4's "Session start and each prompt" Interact cell is all Layer 2 (the status block and the "new item" line). If Layer 2 is shelved, CORE's Interact drops to a model-triggered skill. That is roughly what the kit's `CLAUDE.md` line gives.
  - No step re-derives the D1 table or the verdict after a shelve.
- **What breaks if we ship it as-is:** The plan can ship a Layer-1-only CORE whose stated reason to exist, "a need to be told what is due", was only ever shown, if at all, by the layer it shelved. The verdict sentence survives, unsupported.
- **Suggested fix:** Add `proactive-due` (with the block) to the layer 1 vs kit comparison. In 9.4, after a Layer 2 shelve, rewrite D1 §6's CORE row to Layer 1's measured cells and re-ask the verdict question.
- **Evidence:** v3-d1.md:157–171, 210; v3-d2.md:94–96, 176; v3-d3.md:1150, 1270.

### R3-PA-11  —  major
- **Artifact:** D1 / D3
- **Location:** D1 §8, "Re-run both tests at every release, on a pinned model"; D1 §7 risk row, "Kill test 2 checks built-in memory at every release"; D3 7.7 (no cost cap).
- **What is wrong:** The ongoing defence against "a vendor ships the missing half" is unfunded, and on a pinned model it is blind.
  - The eval runs alone carry caps of $60 + $5 + $40, plus $15 for v3. The record test has no cap at all: per repetition, a control call, 10 sessions, 5 probes, and 5 grader calls; four arms × three repetitions is about 250 `claude -p` calls, plus 2 × 3 runs of 25 turns.
  - CORE 3 shipped 46 releases in five months. Nothing caps the release rate, and nothing says what happens when the owner skips a run.
  - Built-in memory improves with the model as much as with the harness. Re-running on a pinned model hides the change kill test 2 exists to catch.
- **What breaks if we ship it as-is:** Within a few releases the paid tests are skipped, and every verdict number reads "not measured". That is honest, but it becomes the permanent state. The vendor-risk mitigation exists on paper only. An unattended builder agent can also run an uncapped paid loop at 7.7.
- **Suggested fix:** Give `sessions.mjs` a `--max-cost-usd` and stop at it. Re-run the kill tests per minor release or every six months, whichever is first, not per release. Run kill test 2 on the harness's current default model, recording which, as well as on the pinned one.
- **Evidence:** v3-d1.md:198, 228; v3-d3.md:548, 1135–1137, 1145–1162, 1262; v3-d1.md:64 ("Releases | 46 in five months").

---

The record test's isolation (a separate config folder per arm, a control call, the plugin list checked from the init event) is sound engineering. The flaw is in which arms it runs, not how.

critical 4 · major 7 · minor 0 · taste 0
