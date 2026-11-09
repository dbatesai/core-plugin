# Round 4 — Gap auditor

Reviewed: `gauntlet/v4-d1.md`, `v4-d2.md`, `v4-d3.md`, `v4-d4.md` against `gauntlet/contract.md` and `gauntlet/reviewer-brief.md`. Before writing I read the reviewer files in `round-1/` to `round-3/` (not `defence.md`) and the D4 Part 3 ledger, including fix codes H1–H18 (`v4-d4.md:575–592`). Nothing below repeats an earlier finding. Where a round-3 fix is broken or incomplete, the finding names the fix code and the earlier ID. No commands were run beyond reading files.

## Coverage

| Item | Verdict | Findings |
|---|---|---|
| R1 Native across harnesses and OSes | Delivered on paper; the cloud route's account skills have no build step | GA-10 |
| R2 Native-first, per thing built | Delivered | — |
| R3 Ladder-down, no silent rung | Partial: the shelved-hooks rung reports "broken" for parts removed on purpose | GA-05 |
| R4 Minimal | Partial: the line-budget rule is stated two ways; a script-only overrun has no rule | GA-13 |
| R5 Measurement in the first phase | Delivered in order (H3); the kill test's own runs are set up to fail or stop | GA-06, GA-07 |
| R6 Security | Delivered in the tables; the security cases decide nothing at release | GA-01 |
| R7 Metrics plus blind comparison | Partial: the kill test counts Layer 1's own handoff notes against it; the shipped setup is never an arm | GA-02, GA-04, GA-08 |
| R8 Self-auditing | Partial: the script's self-audit is unreachable on two harnesses once hooks are shelved | GA-03 |
| R9 Voice | Delivered, with naming drift | GA-12, GA-14 |
| Defect class killed | No: honesty cases that fail or are not measured still ship; a blocked script call reads as "no gain" | GA-01, GA-08 |
| H1–H18 carried out | Mostly. Broken or incomplete: H2 (release gates), H3 (kill-test eval grants), H4 (twice), H7 (twice), H9, H11, H16, H18 | GA-01–GA-14 |

---

## Findings

### R4-GA-01  —  critical
- **Artifact:** D3 (and D1, D2)
- **Location:** D3 9.4 gate table: "Honesty and security cases | GATE.md's list and pass rule"; "Against v3 | … v4's mean is not more than 0.1 below v3's". The verdict bullets: "Layer 1 was kept at 2.3, so it and the script ship. A kept hook ships. A hook not kept or not measured is shelved." D3 7.1 If it fails: "every hook rule is 'not measured', so both hooks are shelved in 9.4". D1 §4: "'Not measured' never ships."
- **What is wrong:** H2 (the fix for R3-GA-01 and R3-PR-03) gave every *keep rule* three outcomes. It did not do the same for the other release gates. The verdict has branches only for Layer 1 and the two hooks. It has none for an honesty or security case that fails or is not measured, and none for the v3 comparison. 7.1's fallback makes this the normal path for a builder whose eval runs are blocked: hooks shelved, and Layer 1 and the script ship. In that path `honesty-unknown-not-ok`, `finalize-counts-from-disk`, `remember-no-secret`, `remember-ignores-injection` and `untrusted-project-inert` were never run. 7.1's Accept and 9.4's Accept do not need them to pass either.
- **What breaks if we ship it as-is:** This is the defect class at the release. The cases written to prove "not measured" is never shown as "working" can themselves be "not measured", or failed, and the release still goes out. D1's "'Not measured' never ships" is false for the security and honesty cases.
- **Suggested fix:** Add a verdict branch. If any GATE.md honesty or security case is not kept or not measured, nothing ships and 9.4 stops before 9.5. Add "every honesty and security case passed" to 9.4's Accept. Give the v3 gate the same three outcomes.
- **Evidence:** `v4-d3.md:584`, `:611`, `:1316–1317`, `:1423–1424`, `:1431–1437`; `v4-d1.md:123`; `v4-d4.md:576` (H2).

### R4-GA-02  —  critical
- **Artifact:** D3 (and D1, D2)
- **Location:** D3 0.6 GATE.md kill rule (a): "layer 1 beats kit: a mean paired gap of at least 1 probe of 5 … and no more stale or duplicate copies". D3 2.1: "**duplicates** (one fact live in two or more files, auto memory included); **stale copies** (the session-2 decision's old form live outside `archive/`, auto memory included)". D3 2.1 `script.json`: turn 3 is "Then wrap up the session." in even sessions.
- **What is wrong:** This is the H7 fix for R3-GA-11, and it counts against Layer 1 the files Layer 1 exists to write. Session 2 plants the decision and ends with "wrap up". In the layer 1 arm, `finalize` writes a handoff note whose "Done" section records that decision, and it updates `PROJECT.md`. Session 7 reverses the decision. The note from session 2 stays live in `_summaries/`, outside `archive/`, holding the old form. That is a stale copy by 2.1's definition. The person from session 4 likewise sits in a memory, a note, and auto memory: a duplicate. The kit arm has no `finalize` and writes no notes, so it collects fewer of both. D3 never limits the counts to `_memories/` and auto memory.
- **What breaks if we ship it as-is:** Kill test 1 can fail because Layer 1 wrote handoff notes, the close pass D1 §6 lists as an advantage over the kit. Then 2.3 stops the build with "Do not ship CORE", and the reason recorded is "more stale copies". The existence verdict comes from how the count was scoped, not from what the arms did.
- **Suggested fix:** Count stale copies and duplicates only in `_memories/` (outside `archive/`) and in auto memory. Exclude `_summaries/` and `PROJECT.md`, which are dated logs and a brief. State that scope in GATE.md before it is frozen.
- **Evidence:** `v4-d3.md:579`, `:791–792` (finalize updates `PROJECT.md`, writes "Done"), `:887`, `:895`; `v4-d2.md:308`, `:315`; `v4-d1.md:189`, `:203`; `v4-d4.md:581` (H7), `:451` (R3-GA-11).

### R4-GA-03  —  major
- **Artifact:** D3 (and D2, D1)
- **Location:** D3 decision 31: "The script ships whenever Layer 1 ships … Requirements 7 and 8 never depend on the hooks". D3 contract K, "Finding the script": "The status block's `script:` line. On Claude Code with no status block, `${CLAUDE_PLUGIN_ROOT}/scripts/core.mjs` … Never … any other path". D3 What was not verified: "That Claude Code fills `${CLAUDE_PLUGIN_ROOT}` in a skill's body … if not, skills without a status block use their no-script steps." D2 §1: "The hooks are on trial; the script is not."
- **What is wrong:** This is the H4 fix for R3-PA-04, and its stated reason is false. The status block is printed by the session-start hook. With that hook shelved, Codex and Antigravity have no rule that lets a skill find the script at all. On Claude Code the only route is a variable substitution in a skill body that D2 and D3 both list as unverified. So when the hooks are shelved, `check --project`, `selftest`, `metrics`, `queue`, and `sample` never run in a user's session on Codex or Antigravity. On Claude Code they run only if that substitution works. The `metrics` skill then answers "not measured: the script is not available", correctly, every time.
- **What breaks if we ship it as-is:** Requirements 7 and 8 again depend on the hooks' gate on two of three harnesses, which is the outcome H4 was written to prevent. A reader of D1 kill rule 5 believes the self-audit ships whatever happens to the hooks.
- **Suggested fix:** Give skills a script-finding rule that needs no hook and no project path. For example, the `core` skill runs `enable list` from a fixed per-harness plugin variable where one exists. Otherwise, state in decision 31, D1 rule 5, and D2 §1 that on Codex and Antigravity the self-audit needs the session-start hook.
- **Evidence:** `v4-d3.md:136`, `:500–502`, `:1478`; `v4-d2.md:92`, `:219` ("with the script where CORE hands over its path"), `:445`; `v4-d1.md:229`; `v4-d4.md:578` (H4), `:433` (R3-PA-04).

### R4-GA-04  —  major
- **Artifact:** D3 / D1 / D2
- **Location:** D1 verdict: "Each part ships only if it beats the thing below it." D1 kill rule 5: the script's commands "ship whenever Layer 1 ships". D3 arms: **layer 1** = "the Layer 1 package" (no script); **full, recall off** = "the plugin" with the session-start hook. D3 GATE.md: "Session-start hook. Full, recall off, against layer 1".
- **What is wrong:** This is a second gap in H4 (the fix for R3-PA-06). The script now ships with Layer 1 without beating anything, so D1's headline rule is false for the largest part of the code. Worse, no arm is the setup that ships when the hooks are shelved: Layer 1 plus the script. The layer 1 arm has no script. The full, recall off arm has the script and the hook together, so the session-start gate credits the script's exact dates (`queue`, on `proactive-due` and `brief-budget`) to the hook. The honesty and security cases run only on full.
- **What breaks if we ship it as-is:** If the hooks are shelved, the product that ships has never been tested as a whole. Its behaviour differs from every measured arm: the `core` skill finds no status block each session, and `recall` runs through the script. If the hooks are kept, part of the measured gain may belong to the script. Either way the verdict line names a cause it did not isolate.
- **Suggested fix:** Add a **layer 1 + script** arm, the plugin with no hook files, to the 7.1 gated run, and gate the session-start hook against it. Run the honesty and security cases on whichever arm 9.4 ships. Change D1's verdict sentence to say the script ships untested against its absence.
- **Evidence:** `v4-d1.md:15`, `:212`, `:229`; `v4-d3.md:58–66`, `:580`, `:1308–1311`, `:1423`; `v4-d2.md:92`, `:283–285`; `v4-d4.md:578` (H4).

### R4-GA-05  —  major
- **Artifact:** D3 (and D2)
- **Location:** D3 9.4: "On `v4`, remove the shelved hook's entries from the three hook files, its branch in `lib/hooks.mjs`, its tests, and its `selftest` rows. If the session-start hook is shelved, the prompt hook, `PreCompact`, and the liveness line … go too: with no status block, that line would cry wolf." D2 §5 Skills only rung, "hooks shelved (§7)", told by: "on Claude Code, `env` says **broken**".
- **What is wrong:** The shelving list removes the liveness line so it will not cry wolf. It leaves every other part that does the same. `env` (8.1) still reports `session_hook` and `prompt_hook` as `fail` whenever there is a session id and readable receipts, and `close` and `check` keep writing receipts. The `core` skill §2 still says, at every session with no status block, "say in one sentence what is not working". `metrics` keeps `hook_coverage`, `pointer_rate`, and `silent_sessions`, and the `metrics` skill keeps "is it pointing to memories". Setup still walks the user through "enable CORE here" (count memories, read five notes aloud, warn) to switch on hooks that do not exist. D2 presents `env` saying "broken" as the designed way the user learns the hooks were shelved.
- **What breaks if we ship it as-is:** In the shelved build, every session and every `metrics` run tells the user something is broken or not working, about parts that were removed on purpose. D1 §3 names the harm: health reports that are often wrong teach the user to stop reading them. "Shelved by design" becomes confusable with "broken".
- **Suggested fix:** Extend 9.4's shelving list. Drop the hook rows from `env` and `metrics`, the `core` skill's "no status block" sentence, the enable ritual, and the `metrics` skill's second question. Add a `selftest` or `check --plugin` assertion that no shipped file names a shelved hook's event. Change D2's rung row to "hooks shelved: nothing to tell; the product has none".
- **Evidence:** `v4-d3.md:687`, `:695`, `:860`, `:1182–1189`, `:1341–1350`, `:1434`; `v4-d2.md:219`; `v4-d1.md:90`.

### R4-GA-06  —  major
- **Artifact:** D3
- **Location:** D3 2.3 step 3: "`claude plugin eval dist/core-layer1 <eval flags> --tag kill … --max-cost-usd 5` and `claude plugin eval dist/core-kit <eval flags> --tag kill …`". `<eval flags>` (0.6) has no `--allow-tools`. Case `proactive-due`: prompt "Add a period to the end of the second line of README.md."; `judge`: "PASS if the reply … reports the README change." Template: `allowed_tools: [Read, Glob, Grep, Skill, Agent]`.
- **What is wrong:** R1-GA-09 found that `proactive-due` cannot pass without a write grant. The fix reached 0.6 (`--allow-tools Write Edit`) and 7.1 (run 1's grants). The new kill-test runs added by H3 dropped it again. Neither arm can edit `README.md`, so the `judge` grader fails in both arms and only `mentions-due` can differ.
- **What breaks if we ship it as-is:** Kill rule (b), the part of the existence test that measures being told what is due (H1), is run on a crippled case. The largest gap it can show is 0.5 instead of 1.0, and its noise is graded by a judge that has nothing to pass. A real Layer 1 advantage is less likely to clear 0.2, and CORE is cancelled by a missing flag.
- **Suggested fix:** Add `--allow-tools Write Edit` to both 2.3 commands, matching 0.6's headroom run. Add to `evals-shape.test.mjs` or 2.3's Accept that every run of `proactive-due` was granted `Write`.
- **Evidence:** `v4-d3.md:627`, `:628`, `:912`, `:1222–1227`, `:1275`, `:1308`; `v4-d4.md:168` (R1-GA-09), `:577` (H3).

### R4-GA-07  —  major
- **Artifact:** D3
- **Location:** D3 0.6: "Caps assume about $0.25 per run, an estimate"; "Exit 2 means the cost cap stopped it: log the cases that never started as not measured; do not rerun." Caps: headroom `--max-cost-usd 30` (12 twins × 10 runs); 2.3 layer 1 `--tag kill` `--max-cost-usd 5`; 7.1 run 3 recall-off `--tag gated` `15`; run 4 layer 1 `--tag gated` `15`.
- **What is wrong:** Four caps equal the estimate exactly, with no margin. Headroom: 120 runs × $0.25 = $30. Kill, layer 1: `proactive-due` and `canary-layer1`, 10 runs each = 20 × $0.25 = $5. Recall-off and layer 1 in 7.1: five gated cases plus a canary, 10 runs each = 60 × $0.25 = $15. D3 lists the $0.25 figure as unverified. Any overrun stops the run part way, the unstarted runs are "not measured", and the rule says do not rerun. In 2.3 that makes the kill test "not measured", which stops the build for good.
- **What breaks if we ship it as-is:** Whether CORE exists, and whether each hook ships, can be decided by a cost estimate being slightly low. The build log then reads "not measured: cost cap", which looks like a measurement and is a budget line. This was R3-EX-02's concern about caps with no stated basis; the basis is now stated and leaves no room.
- **Suggested fix:** Set each cap at 1.5 times the estimate. Run the first repetition of each paid step, log its real cost per run, and set the remaining cap from it. Allow one rerun of only the unstarted cases at the measured cost.
- **Evidence:** `v4-d3.md:627–628`, `:911–912`, `:1278–1279`, `:1310–1311`, `:1485`; `v4-d4.md:498` (R3-EX-02).

### R4-GA-08  —  major
- **Artifact:** D3 (and D2)
- **Location:** D3 2.1 step 4: "No blanket `Bash(node *)`: on full, the skills' own `allowed-tools` admit the script, as for a user. The repetition is not measured unless every stream's `system` init event lists exactly the arm's plugins and skills, and, for full, a `session-start` and three `prompt` receipts exist". Contract K: "Run it as `node "<path>" <command>`" with the quoted path from the status block. 8.2 If it fails: "The agent's `env` call was refused → the `allowed-tools` rule did not match the quoted path".
- **What is wrong:** This is the H16 fix. Whether the rule `Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/core.mjs *)` matches a command with the path in double quotes is checked only in 8.2. 7.2 measures the record test's full arm before that, in `-p` mode, where an unmatched rule is a refusal, not a prompt. The validity check looks only at hook receipts, which come from the harness, not from the agent's script calls. A refused script call drops the skill to its no-script steps. The catch-up then says "needs the script; not measured", and `close` and `index` never run.
- **What breaks if we ship it as-is:** The full arm can be measured with every agent-side script call refused, and the repetition still counts as measured. The record-test hook rule then compares "hooks with the script blocked" against layer 1. "Could not run" is read as "no gain", and the hooks may be shelved for a quoting mismatch. 8.2 finds the cause afterwards, and no step reruns 7.2.
- **Suggested fix:** Move 8.2's live check before 7.1. Add to 2.1's validity check, for full: at least one agent-side `close` or `check` receipt per repetition, and no refused `Bash` call naming `core.mjs` in any stream. If either fails, the repetition is not measured.
- **Evidence:** `v4-d3.md:500`, `:681`, `:811`, `:893`, `:1321`, `:1356–1358`, `:1478`; `v4-d2.md:368`; `v4-d4.md:590` (H16).

### R4-GA-09  —  major
- **Artifact:** D1 / D3
- **Location:** D1 §7 risk row: "A vendor ships the missing half … | Medium, rising | Kill test 1 includes built-in memory and is re-run often". D1 §8: "Re-run the kill tests at every minor harness release or every six months". D3 9.4: "The pull request states the re-run rule". D3 0.6 GATE.md: "Kill tests re-run after every minor release of a harness, or every six months".
- **What is wrong:** R3-PA-11 said the ongoing defence was unfunded and that "nothing says what happens when the owner skips a run". H7 changed the cadence and the model. It added no mechanism and no consequence. The rule lives in a pull-request description and in prose. Nothing records the date or harness version of the last kill test where any check reads it, and nothing reports when it is overdue.
- **What breaks if we ship it as-is:** The only stated defence against the risk D1 rates "Medium, rising" is a sentence. When the owner skips a re-run, CORE keeps saying nothing about it. That is a stale verdict presented as a current one, a quiet form of "I could not measure this" reading as "this is fine".
- **Suggested fix:** Write the kill test's date, Claude Code version, and model into a shipped file (for example a `verdict` block in `GATE.md`). Have `check --plugin` warn and `metrics` show "kill test: not measured since <date>" once it is older than six months or the harness's minor version is newer.
- **Evidence:** `v4-d1.md:204`, `:235`; `v4-d3.md:585`, `:1436`; `v4-d4.md:440` (R3-PA-11), `:581` (H7).

### R4-GA-10  —  major
- **Artifact:** D3 (and D2)
- **Location:** D3 8.5 `ladder.md`: "Enable CORE's five skills on your claude.ai account to use them there." D3 1.2 §11: "Then say once `ladder.md`'s Claude Code cloud sentence … adding that account skills also appear beside the plugin's in terminal sessions." D3 5.1 `copy-skills`: leaves out "every line that names `CLAUDE_PLUGIN_ROOT` or `scripts/core.mjs`" for `.agents/skills/` only. D3 4.4 `skills-stamp`: checks `.agents/skills/.core-version` only.
- **What is wrong:** H11 made account skills the only way CORE reaches Claude Code cloud sessions and the laptop-shut scheduled task. No step produces the files the user is to enable. No command builds them, strips the script lines (as `copy-skills` does under H10), or stamps a version. No check notices when the account copy is older than the installed plugin, though D3 says it also loads in local terminal sessions. A user who enables the plugin's own skill folders gets `allowed-tools` and a finding rule that name a variable with no plugin to fill it.
- **What breaks if we ship it as-is:** The cloud rung D2 sells for "Thursday evening" depends on a manual step the build never supports. After the next CORE update, every terminal session lists two different versions of `core`, `remember`, and the others, and nothing says which is stale. This is the problem G27 and `skills-stamp` solved for `.agents/skills/`, left open on the route H11 added.
- **Suggested fix:** Add `copy-skills --account <dir>` producing a stripped, stamped copy ready to upload, with the upload steps in `INSTALL.md`. Have the `core` skill compare the stamp of any listed account copy with the plugin's version and say once when it is older.
- **Evidence:** `v4-d3.md:696`, `:739`, `:998`, `:1043`, `:1381`, `:1396`; `v4-d2.md:88`, `:172`, `:239`, `:420`; `v4-d4.md:585` (H11), `:584` (H10).

### R4-GA-11  —  minor
- **Artifact:** D3 (and D2)
- **Location:** D3 4.7: "`data.written` lists ids in `_memories/` (outside `archive/`) that are new or whose size or mtime changed". D3 1.6 §5: "Fewer on disk than attempted → 'broken: N writes did not land'".
- **What is wrong:** This is the H9 fix for R3-GA-03. The snapshot removes other sessions' *uncommitted* work but not files changed under the session by other means. A `git pull`, a branch switch, or a second session open on the same project rewrites files and their mtimes. Each is then listed as written by this session. `finalize` has a rule for fewer files on disk than attempts and none for more.
- **What breaks if we ship it as-is:** After a mid-session pull, the close line reads "4 written; 1 write attempted" and nothing flags it. The count again reports writes this session did not make, the fault R3-GA-03 raised.
- **Suggested fix:** When disk shows more than attempted, list the extra ids as "changed during this session, not by this agent". Record `HEAD` in the snapshot and exclude files a commit change explains.
- **Evidence:** `v4-d3.md:399`, `:794`, `:1030`; `v4-d2.md:162–164`; `v4-d4.md:583` (H9).

### R4-GA-12  —  minor
- **Artifact:** D2 / D3 / D1
- **Location:** D2 §1: "**The `AGENTS.md` block** … keeps that name wherever it sits"; "**A fourth line**". D3 What you are building: "the *instruction block* is the three lines of step 1.1. Skill prose never says a bare 'block'"; "the liveness line". D1 §4: "A three-line block".
- **What is wrong:** H18 (for R3-RD-01) was to name the two blocks apart. D2 and D3 chose different names for the same three lines, and different names for the fourth line. D2's name also points at the wrong file on Claude Code, where the block sits in `.claude/rules/core.md` because `AGENTS.md` can be hidden.
- **What breaks if we ship it as-is:** The executing agent reads D2 §5 before phase 8 (D3's instruction) and meets "the `AGENTS.md` block" and "the fourth line", terms D3 never defines. A Claude Code user reading `ARCHITECTURE.md`, which is D2 shortened, looks in `AGENTS.md` for the block.
- **Suggested fix:** Use "instruction block" and "liveness line" in all four documents.
- **Evidence:** `v4-d2.md:72`, `:86`; `v4-d3.md:13`, `:56`, `:654`, `:1396`; `v4-d1.md:108`; `v4-d4.md:592` (H18), `:302` (R3-RD-01).

### R4-GA-13  —  minor
- **Artifact:** D1 / D2 / D3
- **Location:** D1 §4: "if the hooks need more than 1,800 lines, they are shelved." D2 §7: "hooks needing more than 1,800 lines". D3 Rule 8: "If the shipped JavaScript still needs more than 1,800 lines, the hooks are shelved"; GATE.md: "if the shipped JavaScript needs more than 1,800 lines with them in".
- **What is wrong:** H18 promised one line-budget rule. D1 and D2 apply 1,800 to the hooks alone; D3 applies it to all shipped JavaScript. They differ by the whole script. D3's form also has no outcome when the script alone, which ships regardless (H4), is over 1,800 lines after rule 8's cuts. The 9.4 Budget gate then fails with no branch.
- **What breaks if we ship it as-is:** Requirement 4's "holds to it" has no answer in the one case the budget is really tested. An executor at 1,850 lines of script either ships over budget or invents a rule.
- **Suggested fix:** State one rule in all four documents: all shipped JavaScript at most 1,800 lines; over it, shelve the hooks; still over, stop at 9.4 and report.
- **Evidence:** `v4-d1.md:139`, `:145`; `v4-d2.md:323`; `v4-d3.md:83`, `:172`, `:582`, `:1420`; `v4-d4.md:592` (H18).

### R4-GA-14  —  minor
- **Artifact:** D2
- **Location:** D2 §2: "the plain scheduled prompt (D3 step 4.5)"; §7: "D3 step 7.6", "D3 step 7.7", "Match threshold | D3 step 3.2", "measured in D3 step 7.6".
- **What is wrong:** D2 v4 cites D3 v3's step numbers. In D3 v4, 4.5 is "Migrating a v3 project" and 3.2 is "One guard for every command", so those two land on the wrong step. 7.6 and 7.7 do not exist. D3's mapping table helps only a reader who knows D2 uses old numbers.
- **What breaks if we ship it as-is:** A reader checking the laptop-shut prompt reads the migration step. A reader checking how the match threshold was set reads the honesty guard. D4 Part 2 Q6 and Q8 send readers to the missing 7.6 for cost figures.
- **Suggested fix:** Change D2's references to 1.4, 7.1, 2.1, and 5.2, and D4 Q6 and Q8 to 7.1.
- **Evidence:** `v4-d2.md:172`, `:293`, `:302`, `:338`, `:340`; `v4-d3.md:28–42`, `:935`, `:1003`; `v4-d4.md:82`, `:84`.

### R4-GA-15  —  minor
- **Artifact:** D1
- **Location:** D1 §8 kill test 1: "Layer 1 ships only if, on the ten-session record test, it beats **kit** on recall probes and on being told what is due, by a fixed margin, with a paired interval over 6 repetitions that excludes zero."
- **What is wrong:** D3's rule has two parts measured in different ways. (a) The record test: all five probes, a margin of 1 probe, a 95% paired interval, and no more stale or duplicate copies. (b) The eval case `proactive-due`: 10 runs, a 0.2 gap, no interval, and auto memory off. D1 merges them into one record-test rule with an interval and omits the copies condition. Being told what is due is not a record-test probe at all; the due-date probe asks for the date.
- **What breaks if we ship it as-is:** D1's cold reader, whom the contract asks to state the verdict, states a different kill test from the one that runs. When 2.3 reports "not kept: more stale copies" or "not kept on proactive-due", D1's reader cannot match it to anything D1 said.
- **Suggested fix:** Rewrite kill test 1 in D1 as D2 §7 states it: the record test (probes, interval, no more stale or duplicate copies) and `proactive-due` against the kit twin by 0.2.
- **Evidence:** `v4-d1.md:220`, `:225`; `v4-d3.md:579`, `:887`, `:912`; `v4-d2.md:318`.

---

Sound: the phase order that runs the kill test before any script or hook (H3), the three-outcome `cells.mjs` with its own tests (2.2), the `--how` close receipts (H8), and `pulse`'s "could not check what is due" line all appear as specified in D1–D4.

critical 2 · major 8 · minor 5 · taste 0
