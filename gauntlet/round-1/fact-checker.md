# Round 1 — Fact-checker findings (v1)

Reviewer: fact-checker. Drafts read: `v1-d1.md`, `v1-d2.md`, `v1-d3.md`, `v1-d4.md`. Every vendor claim below was checked against the vendor's own page fetched in this session (`code.claude.com/docs/en/*.md`, `antigravity.google/docs/*.md`, `raw.githubusercontent.com/openai/codex/rust-v0.167.0/...`), and every CORE 3 number was re-run from the repository.

---

### R1-FC-01  —  critical
- **Artifact:** D2, D3
- **Location:** D2 §5 "How CORE detects its environment": "the `core` skill's own description — which every harness keeps in context — tells the agent to say that CORE's hooks are not running. This is the last line of defense". D3 decision 26: "Every harness keeps skill descriptions in context." D2 rung C: "CORE says 'hooks are not running' in its first reply."
- **What is wrong:** The premise is false on two of the three harnesses. Claude Code drops skill descriptions when the listing goes over its budget. It drops the skills used least first. Codex also caps its skill catalog. When hooks are dead, the `core` skill is never invoked by a hook. That makes it one of the least-used skills, so its description is among the first dropped. The plan's only guard against a silent rung C rests on a promise the harnesses do not make.
- **What breaks if we ship it as-is:** On a machine with many skills installed and dead hooks, CORE says nothing at all. That breaks hard requirement 3 ("no rung is a silent no-op"). It is the defect class the rewrite exists to kill: a session that looks fine while CORE is doing nothing.
- **Suggested fix:** State the real guarantee. A description can be dropped on Claude Code (1% listing budget) and Codex (2% catalog budget). Add a second, non-prose signal for rung C, for example an `AGENTS.md` line offered at enable time, or the next-start `no-handoff` check. Size the `core` description so it survives the budget, and say how that was checked.
- **Evidence:** `https://code.claude.com/docs/en/skills.md` (fetched): "if you have many skills, Claude Code drops some descriptions to fit the listing's character budget … The budget scales at 1% of the model's context window. When the listing overflows, Claude Code drops descriptions starting with the skills you invoke least." `research-codex.md` §3: "The catalog budget is 2% of the context window by default. A configured budget is capped at 10,000 tokens" [SOURCE codex-rs/ext/skills/src/render.rs#L23-L27].

### R1-FC-02  —  major
- **Artifact:** D1, D2, D3
- **Location:** D1 §8: "If the plugin does not clearly beat the files alone on recall, focus, and speaking up". D1 §6 table, CORE 4 row: "Interact: Yes on Claude Code". D2 §7 bar: "+0.3 or more, averaged over recall, focus and interact cases". D3 step 7.6, `proactive-due` case.
- **What is wrong:** The between-prompts watcher is the only thing that makes Interact a "Yes" on Claude Code. It is a plugin monitor, and plugin monitors do not start in `-p` mode. `claude plugin eval` runs every case as a non-interactive (`-p`) session with one prompt. So no eval case can ever start the watcher. The `proactive-due` case can only measure the reminder carried in the session-start brief. The verdict's "speaking up" number therefore never includes the feature that D1 counts as the Interact win.
- **What breaks if we ship it as-is:** The release gate can pass or fail with the watcher fully broken. A dead watcher would score the same as a working one. That is "reports success while doing nothing", built into the release gate.
- **Suggested fix:** Say in D1 §8 and D2 §7 that `claude plugin eval` cannot measure the watcher. Measure it some other way: the `watch --ticks` unit test plus a scripted interactive session. Otherwise report "watcher: not measured" next to the A − B number.
- **Evidence:** `https://code.claude.com/docs/en/plugins/components.md` §Monitors: "plugin monitors don't start in non-interactive mode with the `-p` flag". `https://code.claude.com/docs/en/plugin-evals.md`: "Claude Code starts a fresh, isolated non-interactive session with only your plugin loaded, sends the prompt". `research-claude-code.md` "Unconfirmed": "monitors would not start there."

### R1-FC-03  —  major
- **Artifact:** D2, D3
- **Location:** D3 step 7.6: "Cases marked **W** need `--allow-tools Write Edit`" (for `finalize-handoff`, `remember-supersede`, `catch-up-unclosed`). D3 step 5.2 skill text: "(4) Run `core.mjs verify --since …` and `core.mjs close …` (5) Say one closing line built from the `verify` result line". D2 §2: "Then it runs `core.mjs verify`". D3 step 5.1: "move the old one to `archive/`".
- **What is wrong:** The close flow and the supersede flow need the agent to run a command (`node core.mjs …`) or move a file. Both need Bash. The W cases grant only Write and Edit, so the agent cannot follow its own skill. Granting Bash does not fix it either. Under Bash, the eval sandbox makes the home folder unreadable. `core.mjs` then cannot read `~/.core/projects.json` (decision 15 puts it at `os.userInfo().homedir`), so every agent-run `core.mjs` command sees an untrusted project.
- **What breaks if we ship it as-is:** `finalize-handoff` can pass on the summary file alone while "counts come from the disk" never runs. `remember-supersede` can pass on a Write to `archive/` that leaves the original live, so two live copies of one fact pass the test. Grant Bash instead and every agent-side check returns `unknown`. Either way the eval measures a different path from the one users run.
- **Suggested fix:** Decide how the agent calls `core.mjs` under eval, and test that path. One option: grant `Bash(node *)` and give `core.mjs` a `--core-dir` the eval can point inside the workspace. Add a grader asserting `dc-14` is no longer in `_memories/` after a supersede.
- **Evidence:** `plugin-evals.md` §Grant tools: "When you grant `Bash` in any form, every command runs under Claude Code's OS-level sandbox. Writes are confined to the run's workspace, your home directory and Claude Code configuration are unreadable". `grounding.md` §4.1: "Write, Edit, and Bash need an explicit `--allow-tools` grant."

### R1-FC-04  —  major
- **Artifact:** D1, D2
- **Location:** D1 §1 table: "Remember | Instructions only. In a test, a session where the user said 'Remember that' stored nothing." D2 §4 table, CORE 3 column: "In a test, a session where the user said 'Remember that' produced no memory [runtime §4]".
- **What is wrong:** The cited test did not involve an agent. It fed a transcript to CORE 3's automatic SessionEnd close, which by design makes zero model calls and writes no memories. The source says so: "The automatic close does not remember… **RAN**: a transcript containing 'Dana owns it. Remember that.' gave a receipt with … 0 new files". No model was told "remember that" and then ignored it.
- **What breaks if we ship it as-is:** A reader concludes that CORE 3's agent ignores an explicit "remember that". D1 uses this to justify the Remember redesign. The real finding is narrower: the automatic close never writes. That finding argues for a different fix.
- **Suggested fix:** Reword: "CORE 3's automatic close writes no memories by design; in a test, a transcript containing 'Remember that' produced a receipt and no memory." Cite `process-memory/SKILL.md:42` separately for in-flow writes being suppressed.
- **Evidence:** `source-runtime.md` §4 REMEMBER: "**The automatic close does not remember.** Its own header says why it writes no prose … **RAN**: a transcript containing 'Dana owns it. Remember that.' gave a receipt with `status: recorded`, `Substantive: no`, and 0 new files in `_memories/`." Also the "SessionEnd runner … call a model (`model_calls: 0`)" row in `source-runtime.md` §7.

### R1-FC-05  —  major
- **Artifact:** D1, D2
- **Location:** D2 §5 rung table: "**B — Hooked** | Claude Code headless or cloud; …". D1 §2: "on a laptop and in cloud sessions."
- **What is wrong:** Rung B lists cloud sessions as getting the brief, recall, queue, close, and checks. The cited research says the opposite, or leaves it unconfirmed. Cloud sessions do not install plugins a repository turns on. Project threads skip a repo's hooks and skills. Whether an account-enabled plugin loads, with hooks, in a plain cloud session is listed under "Unconfirmed — do not rely on". The draft drops that hedge and asserts support.
- **What breaks if we ship it as-is:** A user in a cloud session expects rung B and gets no CORE at all. That is rung D or worse, and the plan's own detection never ran to say so. D1 names cloud sessions as part of the problem CORE solves, so the case rests on a capability nobody confirmed.
- **Suggested fix:** Move cloud to its own row marked "not verified". Name what is documented: repo-declared plugins do not load, and Projects load plugins only via Project settings. Add a live cloud check to phase 8, or drop cloud from D1 §2.
- **Evidence:** `research-claude-code.md` lines 292: "A cloud session doesn't install the plugins a repository turns on under [`enabledPlugins`]" [OPENED cloud-environments.md]; line 224: "Cloud threads load each repository's `CLAUDE.md` instructions but not its skills, `.mcp.json` servers, or `.claude/settings.json`"; "Unconfirmed": "Whether a plugin turned on for a claude.ai account loads, with hooks, in a plain cloud session … no page states it."

### R1-FC-06  —  major
- **Artifact:** D1, D3
- **Location:** D1 §7 risk row: "The audit's list of 29 practices worth keeping [evaluation §8] is the checklist." D3 step 0.3 item 4: "`git rm -r … tests/acceptance tests/smoke tests/helpers tests/isolated-controls … docs/regression-guards.md`", and item 5: "`git rm` … `run-suite-isolated.mjs`".
- **What is wrong:** The count of 29 is right. The claim that it is "the checklist" is not. D3 never mentions the list, and phase 0 deletes the exemplars that several items cite. Item 3 cites `run-suite-isolated.mjs` and `tests/acceptance/one-folder-packet.mjs`. Item 4 cites `tests/acceptance`. Item 18 cites `tests/scripts/fs-confine.mjs`. Items 19–20 cite `tests/smoke/source-package-smoke.sh`. Item 23 cites `docs/regression-guards.md`. Item 28 cites the five patterns, which step 9.2 replaces.
- **What breaks if we ship it as-is:** The D1 risk row gets mitigated on paper only. The builder deletes the controls-before-trust runner, the file-access gate, and the empty-answer smoke check without carrying their lessons forward. The rewrite then meets those failures again.
- **Suggested fix:** Either add a D3 step that walks the 29 items, recording for each one where v4 keeps it or why it does not apply, or delete the claim from D1.
- **Evidence:** `source-evaluation.md` §8 Keep, items 1–29 (counted: 29). `grep -n "29 \|practices\|§8" v1-d3.md` → no reference to the list.

### R1-FC-07  —  minor
- **Artifact:** D3
- **Location:** Decision 27: "three manifests, three hook files … Google's own cross-harness sample plugin uses this layout [G 4.3]."
- **What is wrong:** The sample does not use this layout. Its manifest is a root `plugin.json`, and its `.antigravity-plugin/` folder holds only a README. It ships no hooks at all. Google's codelab says hooks are "specific to one agent" and kept "outside the portable core". The citation supports one shared skills folder. It does not support three hook files.
- **What breaks if we ship it as-is:** A builder who hits a hook-loading problem will trust the layout as Google-proven and look elsewhere for the cause. No first-party example ships hooks across all three harnesses.
- **Suggested fix:** Change the reason to: "Each harness documents its own manifest path; Google's sample shares skills across harnesses but ships no hooks."
- **Evidence:** `research-antigravity.md` §7 "A first-party cross-harness example": "the root `plugin.json` is the manifest"; "It ships no hooks. Installing it reports none" [OPENED codelabs … "hooks : skipped (not found)"]; "Anything else, for example hooks or commands, is specific to one agent."

### R1-FC-08  —  minor
- **Artifact:** D1, D2, D4
- **Location:** D1 §7: "A harness changes its hook format. Antigravity's changed three times in three weeks [antigravity, summary 15]. | High". Repeated in D2 §11 and D4 Q20.
- **What is wrong:** The research file never lists the three changes. Summary line 15 asserts it with no tag, and §6 does not list them either. The Antigravity changelog, fetched here, shows hook changes that add things (`lastUserInput`, `terminationBehavior`, hook validation, `PLUGIN_ROOT` from CLI 1.5.3). None of them changes the format. The drafts upgrade "contract" to "format", and a risk rated "High" rests on it.
- **What breaks if we ship it as-is:** The likelihood rating and the D3 8.4 fallback are calibrated to a claim nobody can trace. A reviewer cannot tell whether the risk is real breakage or additive change.
- **Suggested fix:** List the dated changes with changelog quotes, or write "the hook contract gained fields several times in October–November 2026".
- **Evidence:** `research-antigravity.md:21` (no tag); `https://antigravity.google/docs/changelog.md` hook entries (e.g. "Added `lastUserInput` to the JSON that hook commands receive on stdin"; "Added `terminationBehavior` to `PreInvocation` hooks").

### R1-FC-09  —  minor
- **Artifact:** D2
- **Location:** D2 §5 ladder, Antigravity column: "`SessionStart` hook (doc)". The grade key reads: "**doc** means the vendor's documentation or source was opened".
- **What is wrong:** The research grades plugin-bundled hooks in the App and IDE as "implied, not stated on the hooks page". `research-competitors.md` records a third-party report that `agy plugin install` never loads plugin hooks (agy 1.1.27), with the conflict "Not tested here". The plugin variables reach hooks only from CLI 1.5.3, which is not on the docs site. The "(doc)" grade drops all three hedges.
- **What breaks if we ship it as-is:** Users of the Antigravity App and IDE are told rung B, while the only documented hook path for plugins is the CLI.
- **Suggested fix:** Grade the cell "doc (CLI); implied (App, IDE); one contrary third-party report", and pin a minimum CLI version.
- **Evidence:** `research-antigravity.md` §6 "Which surfaces load plugin hooks": "**App and IDE: implied, not stated on the hooks page.**"; `research-competitors.md:493`: "claude-remember's README says `agy plugin install` never loads them (tested on `agy` 1.1.27). Not tested here."

### R1-FC-10  —  minor
- **Artifact:** D1, D2
- **Location:** D1 §5: "files searched by a coding agent scored 72.5% against 48.5% for the best retrieval pipeline". D1 §6: "the test's own answer key is 6.4% wrong". D2 §7: "an audit found a judge model accepting 63% of deliberately wrong answers". D2 alternatives: "Extraction pipelines in the research omit more than half of updates".
- **What is wrong:** Each hedge from the research file was dropped on the way into the drafts.
  - The 72.5% is from a preprint marked "Work in Progress". It covers stored agent trajectories, not project decisions. The same abstract says these methods "have high latency costs". An off-the-shelf coding agent scored 69.3%.
  - The 6.4% and 63% come from an audit by a competing memory vendor. Both were read through a summarizing fetch tool ("WebFetch extract").
  - The HaluMem paper says "most systems", not all. Some of its authors built one of the tested systems.
- **What breaks if we ship it as-is:** D1 §5 is the "why plain files" argument. A reader takes a vendor-disputed or work-in-progress result as settled evidence.
- **Suggested fix:** Keep each number and add its grade in a few words: "(preprint, work in progress; trajectories)", "(audit by a competing vendor)", "most systems".
- **Evidence:** `https://arxiv.org/abs/2605.12493` (fetched): "Work in Progress"; "Despite the strong performance gains, coding agent based methods have high latency costs." `research-memory-layers-a.md` §1.11: "(WebFetch extract) '62.81% of intentionally wrong vague-but-topical answers accepted'"; "An audit by another memory vendor". `research-literature.md` §3: "most systems suffer omission rates above 50%"; "Some HaluMem authors also wrote MemOS".

### R1-FC-11  —  minor
- **Artifact:** D1, D2
- **Location:** D1 §5: "a few hundred relevant tokens beat a full history in every model tested [literature §1]. So CORE 4 passes three pointers, not three documents." D2 alternatives: "Load memory bodies … Rejected … focused context beats full context in every study read".
- **What is wrong:** The Chroma result compares about 300 tokens of relevant content against a 113,000-token full history. Three memory bodies of two to six sentences each are themselves a few hundred focused tokens. The study does not compare pointers with short bodies. CORE 3's own run found pointer-only packs make the model open a file to get the answer.
- **What breaks if we ship it as-is:** The recall design is defended with evidence that does not bear on it. If the four-cell test shows weak recall, the plan has no evidence-based reason to keep pointers except security.
- **Suggested fix:** Rest the pointer decision on the security reason, which does hold. Treat "pointers vs. three short bodies" as a question for the eval.
- **Evidence:** `research-literature.md:49`: "Focused prompts average to ~300 tokens" vs "~113k tokens". `source-runtime.md` §2: "The pack carries titles, not memories … The model has to open the file."

### R1-FC-12  —  minor
- **Artifact:** D1
- **Location:** D1 §5: "the comparison CORE 3's own changelog says 'exists nowhere in this codebase' and later dropped as unobservable [evaluation §2.8]".
- **What is wrong:** It is a misquote, and two things are run together. The changelog says "no matched memory-on/off comparison exists anywhere in this codebase yet". What was later dropped "as unobservable" was the user-benefit row: "measuring what the user did with delivered answers is unobservable". That is not the on/off comparison.
- **What breaks if we ship it as-is:** A quoted string that does not appear in the source undermines the "every claim rests on a file" promise. It also suggests CORE 3 ruled the with/without comparison impossible, which it did not.
- **Suggested fix:** Quote it exactly, and say the user-benefit row was dropped, not the comparison.
- **Evidence:** `CHANGELOG.md:353` "…no matched memory-on/off comparison exists anywhere in this codebase yet"; `CHANGELOG.md:369`; `grep -n "exists nowhere" CHANGELOG.md` → no match.

### R1-FC-13  —  minor
- **Artifact:** D1, D3
- **Location:** D1 §1 "Settings switches | 34 names"; D1 §4 "Settings switches | 34 | 1"; D3 decision 16 "v3 has 35 switches [G 2.1]"; D3 step 0.2 Accept "`switch_names: 34`"; D3 Budget "1 (`CORE_DISABLE`, also accepted as `EVAL_CORE_DISABLE`…)".
- **What is wrong:** Each count is wrong in its own way:
  - D3 says 35 in one place and 34 in another. Step 0.2's command gives 34. Grounding's pattern without `\b` gives 35, because it also matches the substring in `CORE_PRUNE_THRESHOLD`.
  - Of the 34, only 31 are read from the environment, and 5 are test seams, so "settings switches" overstates v3.
  - v4 is not "1". It accepts two names, and it moves other settings into `_core/config.json` (`recall`, `watch_minutes`, `agents_block`, …).
- **What breaks if we ship it as-is:** An executing agent sees two baselines for one number. The headline "34 → 1" compares environment names against environment names plus a config file.
- **Suggested fix:** Use 34 everywhere. Call them "CORE_* names (31 read from the environment)". State v4 as "2 environment names plus N config keys".
- **Evidence:** `grep -rhoE '\bCORE_[A-Z0-9_]+' plugins/core --include=*.mjs --include=*.md --include=*.json | sort -u | wc -l` → 34; `grep -rhoE "CORE_[A-Z][A-Z0-9_]+" plugins/core | sort -u | wc -l` → 35 (extra: `CORE_PRUNE_THRESHOLD`); `source-runtime.md` §8: "**31** are read from the environment".

### R1-FC-14  —  minor
- **Artifact:** D1
- **Location:** D1 §1: "Five defects were reported … All five were checked against the source; four were reproduced by running the shipped scripts [G 3.1–3.5]", followed by a list of five.
- **What is wrong:** All five listed defects were reproduced by running the scripts (G 3.1, 3.2, 3.3, 3.4, and the first part of 3.5). The one that was not reproduced is the unattended pass that "claimed five writes and wrote none" (G 3.5, third part). That one is missing from the list. The real fifth reported defect was swapped for the decoration churn (G 3.4), which grounding files under 3.5 as "This is 3.4". "Four were reproduced" matches neither list.
- **What breaks if we ship it as-is:** A reader cannot map the five to the brief. The one defect closest to "claimed writes that never happened", the defect class itself, disappears from the problem statement.
- **Suggested fix:** List the reported five as grounding numbers them, and mark the unreproduced incident "mechanism confirmed, incident not reproduced".
- **Evidence:** `grounding.md` §3.5: "**The unattended pass that claimed five writes and wrote none — MECHANISM CONFIRMED, incident not reproduced.**" Reproduced here: `audit-memory-boundary.mjs` → "0 native-only candidate(s) / 0 sampled of 0 native entries", exit 0; `read-transcript.mjs --transcript /nonexistent/x.jsonl` → no output, exit 0; `close-pass.mjs begin` then `finish` → marker `"status": "closed"`, `"ops": {}`, exit 0.

### R1-FC-15  —  minor
- **Artifact:** D1, D2
- **Location:** D1 §1: "A separate audit of the measurement code found seventeen more places where it happens [evaluation §6A]." D2 §6: "seventeen more places where an instrument reads nothing and still exits clean".
- **What is wrong:** §6A lists items A1 to A17, but not all are "more" or "reads nothing and exits clean":
  - A9 is defect 1 again (`audit-memory-boundary`).
  - A14 and A15 are weak tests, not instruments.
  - A3 is two readers disagreeing.
  - A12 includes an unchecked answer-key hash.
  - A10 is marked "Code reading only; not run".
- **What breaks if we ship it as-is:** The size of the problem is overstated by a few items, and a reader who opens §6A finds the count does not hold.
- **Suggested fix:** "Sixteen more instances of the class, some by code reading only."
- **Evidence:** `source-evaluation.md` §6A, A9 ("The memory-boundary audit does not say its input was missing"), A10 ("Code reading only; not run"), A14, A15.

### R1-FC-16  —  minor
- **Artifact:** D1, D2, D3 (and `grounding.md`)
- **Location:** Several tags that point at a section that does not hold the claim.
- **What is wrong:** These claims cite the wrong place:
  - D3 decision 4: "`bin/` … refused by some Claude surfaces [G 4.1]". True, but G 4.1 does not say it. The source is `plugins/components.md` ("claude.ai and Cowork don't install a plugin that has a top-level `bin/` directory").
  - D3 decision 17: "1 second on Codex [G 4.2]". G 4.2 does not say it. The source is `research-codex.md` §4.
  - D3 decision 7 cites [G 2.7] for status-by-location. G 2.7 is about failure patterns.
  - D2 §9 and D3 decision 15 cite [G 2.3] for "a project's settings can set `HOME`". G 2.3 is about hooks. The source is `source-runtime.md` §7 gap 6.
  - D3 step 7.1 says `build`/`source_sha` are "reported as unknown fields [G 4.1]". G 4.1 does not say it.
  - D1 §6 "[competitors, finding 3]": the field-report list is §B item 8. Summary item 3 is about Conductor.
  - D1 §6: "Twenty-eight tools … were checked". No research file states or supports 28.
  - `grounding.md:11` says unverifiable facts "are listed in Part 6". There is no Part 6.
- **What breaks if we ship it as-is:** D1 promises that "every claim rests on a file, a command, or a page". A reviewer who follows these tags finds nothing there. An executing agent cannot re-check the claims D3 tells it to rely on.
- **Suggested fix:** Fix each tag to the section that holds the quote. Count the tools or drop the number. Add grounding Part 6 or remove the pointer to it.
- **Evidence:** `grep -n "bin/\|1 second\|unknown field" grounding.md` → no match in §4.1/§4.2; `grep -n "^## " grounding.md` → Parts 1–5 only; `research-competitors.md:429` (§B item 8) holds "chief-of-staff's five silent months".

### R1-FC-17  —  minor
- **Artifact:** D3
- **Location:** Decision 6: "Memory files keep the v3 frontmatter fields … v4 adds three optional fields: `summary`, `trust`, `snooze`." Contract C example and field list include `owner`.
- **What is wrong:** `owner` is not a v3 frontmatter field. It appears nowhere in `data-storage.md`'s schema or in v3's scripts. So v4 adds four fields, not three.
- **What breaks if we ship it as-is:** Migration and `check --project` are built to "zero rewriting of existing memories". A v3 store has no `owner`, so every queue rule that keys on owner reads nothing for migrated memories, and nothing says so.
- **Suggested fix:** List `owner` as a fourth new optional field, and say what the queue does when it is absent.
- **Evidence:** `grep -rn -- "owner:" plugins/core/skills/core/protocols/data-storage.md plugins/core/skills/core/schemas` → no field definition; `by-when`, `deferrals`, `last_deferred`, `pinned` are present in `data-storage.md`.

### R1-FC-18  —  minor
- **Artifact:** D4
- **Location:** Part 1 item 7: "`claude plugin eval` has an early-access note in its own troubleshooting page."
- **What is wrong:** The troubleshooting entry is an error message shown by old builds. Its text reads: "Your build predates general availability of the command. Run `claude update`". It says the command is generally available, which is the opposite of what D4 implies.
- **What breaks if we ship it as-is:** The critic log weighs a false weakness. The real fragility is in the next entry: "Anthropic has switched the command off server-side", meaning the vendor can disable it remotely. That one goes unmentioned.
- **Suggested fix:** Replace it with: "The command can be switched off server-side ('plugin eval is currently unavailable'), and then the release gate cannot run."
- **Evidence:** `https://code.claude.com/docs/en/plugin-evals.md` §Troubleshooting: "Your build predates general availability of the command."; "Anthropic has switched the command off server-side."

### R1-FC-19  —  minor
- **Artifact:** D2, D3
- **Location:** D2 §7: "each case ends with 'do not mention how you found the answer' so the answer does not give the arm away." D2 §2: "The agent opens the file and answers from it, naming `dc-14`." D3 step 7.5: `blind.mjs` strips only lines containing "CORE" or "/core".
- **What is wrong:** In D3 §7.6, only `recall-past-decision` carries that sentence. D2's own model session has the plugin arm name memory ids (`dc-14`). Memory ids are not stripped by `blind.mjs`. The plain-files arm may or may not cite ids.
- **What breaks if we ship it as-is:** The v3-vs-v4 blind pack can reveal which arm is which, so the "blind" judgment is not blind. Requirement 7 says the grader must not be able to tell.
- **Suggested fix:** Add the sentence to every case D3 feeds to `blind.mjs`. Also have `blind.mjs` strip memory-id patterns (`[a-z]+-\d+-[a-z0-9-]+`) and file paths under `_memories/`.
- **Evidence:** `v1-d3.md` step 7.6 table: the phrase appears in one prompt only; step 7.5 strip rule.

### R1-FC-20  —  minor
- **Artifact:** D3
- **Location:** Step 7.6: "The plugin path inside `fixture.sh` is the fixture file's own folder, three levels up."
- **What is wrong:** `fixture.sh` sits at `plugins/core/evals/<case>/fixture.sh`. Its folder is `plugins/core/evals/<case>`. Three levels up from that folder is `plugins/`, not the plugin root `plugins/core`, which is two levels up.
- **What breaks if we ship it as-is:** `node <plugin>/scripts/core.mjs trust add` points at a file that does not exist. The scaffold exits non-zero, and every with-arm run scores 0 with "scaffold failed". The release gate then reads as "the plugin does not beat plain files", and D1 §8 says to drop the plugin.
- **Suggested fix:** "two levels above the fixture file's folder (`$(dirname "$0")/../..`)".
- **Evidence:** D3 target layout: `plugins/core/evals/<case>/…`; `plugin-evals.md`: "If the script exits non-zero … that run scores 0 with a `scaffold failed` error."

---

**What checked out.** These all reproduced:
- **Size:** 100 `.mjs` files, 34,313 lines, and 606,815 prose bytes.
- **Startup read:** 126,923 bytes (23,503 + 88,068 + 6,968 + 8,384).
- **History and tests:** 46 release headings from 2.0.1 to 3.20.1, and 176 `*.test.mjs` files.
- **CORE 3 defects:** the five hard-coded `.claude` paths at the cited lines, the boundary audit's "0 of 0" with exit 0, `read-transcript` exiting 0 on any input, and the close marker reading `closed` over `"ops": {}`. One more on the last: running `detect` without `--ops` prints `{"state":"closed","owed":[]}`, which is worse than grounding reports.
- **Codex:** `HOOK_EVENT_NAMES: [&str; 14]` at tag `rust-v0.167.0`.
- **Claude Code docs:** `claude plugin eval` with `WITH`/`W/OUT`/`Δ` from v2.1.269, `/doctor prompt-audit` from v2.1.283, AGENTS.md from v2.1.277, and the 1.5 s plugin SessionEnd budget.
- **Antigravity docs:** "Agents don't remember conversations" and hook commands running with the plugin root as their working directory.
- **Codex install:** `INSTALL.md:122`'s out-of-date Codex statement.
- **Other sources:** the `40%` line has no source in the repo, and the 29 practices, the 93% approval figure, and 41 of 57 facts surviving all match their sources.

critical 1 · major 5 · minor 14 · taste 0
