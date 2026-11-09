# Round 3 — Practitioner review of v3

Reviewer mandate: I build and evaluate agent memory systems. Would this design work, and can its tests tell "helps" from "noise"? I read D1–D4 v3, the round-1 and round-2 reviewer files, and the D4 ledger. I checked claims against `research-claude-code.md`, `grounding.md`, `tests/fixtures/`, and Claude Code's `plugin-evals.md` (fetched 2026-11-09). Probabilities below come from exact binomial sums and a 40,000-trial simulation of the gate (runs independent, graders independent). They are a best case, because real runs share a fixture and are correlated.

Short answer: no, not yet. Each of the three verdict tests is broken in a different direction. The test that decides whether CORE should exist cannot fail. The test that decides whether the code should exist almost cannot pass. The control on the built-in arm cannot fail either. And when a gate reads "not measured", the plan ships the full plugin anyway.

---

### R3-PR-01  —  critical
- **Artifact:** D1 / D2 / D3
- **Location:** D1 §8 kill test 1, "Layer 1 is kept only if, on the record test, it recalls at least 1 more of 5 probes than files … Otherwise: use the kit and the built-ins"; D3 0.6 GATE.md "Keep Layer 1"; D3 7.7 step 2, "**Files**, **built-in:** nothing more."
- **What is wrong:** This is the fix for R2-PA-06 ("no gate can retire CORE"), and it still cannot retire CORE. In the record test, the **files** arm starts with an empty `PROJECT.md` and an empty `_memories/`. It has no block, no skill, and no plugin, and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` turns its auto memory off. Nothing tells that agent to write anything. Across ten one-shot `claude -p` tasks it will write nothing to `_memories/`. It can answer a probe only from what the code shows, which is at most the session-7 reversal. So files scores about 0–1 of 5. Layer 1 has a write rule in its block and a `remember` skill, so it needs about 1–2 hits to "beat" files by one probe. That is a pass by construction. The arm the verdict names as the alternative, "the kit" (AGENTS.md plus built-in memory, D1 §6), is not the files arm. The nearest thing to it in 7.7 is **built-in**. Losing to built-in only adds a sentence to the verdict. It never stops the build.
- **What breaks if we ship it as-is:** The one test that can say "do not build CORE" reports a pass whether or not Layer 1 does anything the kit would not. That is the defect class: a check that reports success while measuring nothing about the claim. D1's verdict, "its five skills must beat plain files", then rests on a comparison against an agent that was never asked to keep notes.
- **Suggested fix:** Make kill test 1 compare layer 1 with a **kit** arm: auto memory on, plus an `AGENTS.md` holding a plain "keep project notes in `_memories/`" line. Use the same margin. Report files only as a floor.
- **Evidence:** v3-d3.md:533; v3-d3.md:1152–1153 (fresh folder, `--norecord`, empty `PROJECT.md`; files gets "nothing more"); v3-d1.md:219; D1 §6, "The kit … AGENTS.md + built-in memory".

### R3-PR-02  —  critical
- **Artifact:** D3 (and D2 §7, D1 "What was not verified")
- **Location:** D3 7.7 step 3, "Built-in must leave a file holding `HERON-7` under `$CLAUDE_CONFIG_DIR/projects/`; other arms must leave none"; "facts written (key regexes over files in the folder and under `$CLAUDE_CONFIG_DIR/projects/`)".
- **What is wrong:** Claude Code writes every session's transcript under that same folder: "Claude Code stores transcripts as JSONL at `~/.claude/projects/<project>/<session-id>.jsonl`". Auto memory is only one subfolder of it (`projects/<project>/memory/`). The control session's own transcript holds the prompt "Remember that the codeword is HERON-7." So:
  1. The built-in control passes even when auto memory saved nothing.
  2. The control fails in full, layer 1, and files, because their transcripts hold the codeword too.
  3. "Facts written" finds every planted fact in every arm, because each planting prompt sits in a transcript.
  4. "Duplicates" counts every fact as stored twice in every arm.

  This was the fix for R2-PA-07, which asked for proof that native memory was on. The proof reads the wrong folder.
- **What breaks if we ship it as-is:** Run as written, 7.7 marks three arms "not measured: auto memory control failed", so neither Keep Layer 1 nor rule 4 of Keep Layer 2 can be measured. Patched loosely, say by skipping the control for non-built-in arms, built-in is certified "on" by a check that cannot fail. Every arm also reports a 100% write rate. This is the exact CORE 3 defect the plan cites: a check that reads the wrong path and reports clean [G 3.1].
- **Suggested fix:** Scan only `$CLAUDE_CONFIG_DIR/projects/*/memory/` for auto memory. Scan the project folder without `_core/` for CORE writes. In the control, also assert that the memory folder is empty in the other arms and that a transcript exists, so the scan can be seen to look in the right place.
- **Evidence:** research-claude-code.md:66 (transcript location, from `sessions.md`); grounding.md:203 (auto memory at `~/.claude/projects/<project>/memory/`); v3-d3.md:1154, 1157. Transcripts are on in 7.7: `--resume` in `--long` and the catch-up's `tp` both need them.

### R3-PR-03  —  critical
- **Artifact:** D3 / D1
- **Location:** D3 9.4 verdict list, "**Layer 1 fails** … **Built-in beats layer 1** … **Layer 2 fails** … **All met** → 'Keep both layers.'"; GATE.md "then the gate is 'not measured'".
- **What is wrong:** The verdict list has no row for "not measured". GATE.md can return it: two errored runs of five, a failed `canary`, a 7.7 arm with fewer than two good repetitions, or 7.6's own fallback with no `claude`. The `v4` branch already holds both layers. Only the "Layer 2 fails" row swaps in `dist/core-layer1/`. So when the gate is unmeasured, 9.5 opens a pull request that ships the full plugin, with the gate listed under "gates not measured". The same holds for Keep Layer 1: "do not build CORE" can fire only on a measured fail. D4 Part 1 item 1 admits a builder without a paid account gets "not measured" for every deciding result. The plan never says what ships then.
- **What breaks if we ship it as-is:** "I could not measure whether the code helps" leads to the same release as "the code helps". That breaks D1's promise, "its code must beat the skills, or that part does not ship". It is the defect class moved from an instrument to the release decision.
- **Suggested fix:** Add verdict rows. If Keep Layer 2 is not measured, ship Layer 1 and push `v4-layer2` until it is measured. If Keep Layer 1 is not measured, stop before 9.5 and leave the decision to a person.
- **Evidence:** v3-d3.md:535, 1267–1271; v3-d1.md:15; D4 Part 1 item 1; D3 7.6 "If it fails … the report says effectiveness is **not measured**", then the step continues.

### R3-PR-04  —  critical
- **Artifact:** D3 / D2
- **Location:** D3 5.3 step 3, "For each older unclosed session, append `not caught up: <sid>`"; step 4, "Run `close --sid <sid> --summary _core/inbox.md` for each of them"; "No usable `tp` … append 'transcript not available' for that session, close it"; 7.4 `handoff_coverage` = "sessions with a `close` row ÷ sessions".
- **What is wrong:** The catch-up writes a normal `close` receipt for sessions it never read: every older unclosed session, and any whose transcript is gone. `close` checks only that `_core/inbox.md` changed in the last ten minutes, and the catch-up has just appended a line to it. Contract H gives the `close` row no field to tell a real wrap-up from "transcript not available". `metrics` then counts all of them as handed off.
- **What breaks if we ship it as-is:** A week of plain quits gets one session caught up and six stamped "closed" over nothing. `handoff_coverage` reads 100% while no handoff happened. That is CORE 3's reported defect 3 again: "a close marker says 'closed' over an empty list of completed steps" (D1 §1). It breaks D2 §6's rule, "a session is closed when one receipt says so".
- **Suggested fix:** Add `how: finalize | catch-up | skipped` to `close` rows. Count only `finalize` in `handoff_coverage`. Report `skipped` as its own number, labeled not caught up.
- **Evidence:** v3-d3.md:900–903, 1009; contract K `close` row; v3-d1.md (problem two, item 3).

### R3-PR-05  —  major
- **Artifact:** D3 / D2 / D1
- **Location:** GATE.md "Gated cases: `recall-past-decision`, `recall-distractors`, `proactive-due`, `recall-paraphrase`, `null-rename` … (1) at least 3 of 5 gated cases have full − layer 1 ≥ 0.2; (2) the mean … ≥ 0.2".
- **What is wrong:** This fix for R2-PR-08, R2-PA-11, and R2-PR-03 (G4) put two cases with an expected gap of zero or less inside the "ahead" rules.
  - `null-rename` is a null case. By design, both arms rename the function and the gap is 0.
  - `recall-paraphrase` is gated because word matching should miss. The query's terms (`responsible`, `money`, `movement`, `code`) share no token with "Alex owns the payments service", and the fixture bans `money` from every distractor. So the hook offers no pointer, and full is at best layer 1 again.

  "3 of 5" therefore means all three of the others. "Mean ≥ 0.2 over 5" means those three must average at least 0.33. Two of those three are literal recall. Layer 1 is told to look in `_memories/` and has `Grep`. `grep -ril "retry header"` returns about 11 small files, one of them the answer. So layer 1 sits near the ceiling there, and its gap is near 0.

  Simulated gate, with Layer 2 truly lifting `proactive-due` from 0.3 to about 0.93 and equal elsewhere: rules 1–3 pass 16%, all four 12%. Add a real +0.15 on both literal recall cases and −0.1 on paraphrase: 33% and 25%. With no effect at all: 1–3%. Also, the null case was asked for to catch a token tax ("no more than X% more tokens", R2-PR-08). GATE.md has no token rule; `cells.mjs` only prints cost.
- **What breaks if we ship it as-is:** A Layer 2 that really helps is shelved three times in four. So "Layer 2 failed" says almost nothing about the wiring. It mostly says whether Layer 1 can grep. And a Layer 2 that triples token cost passes the null case.
- **Suggested fix:** Make `null-rename` and `recall-paraphrase` non-inferiority checks only: rule 3, plus "null-case tokens no more than 15% above layer 1". Apply rules 1–2 to cases where Layer 2 has a mechanism, such as `proactive-due`, `brief-budget`, and `resume-from-handoff`. Freeze that list before any run, as now.
- **Evidence:** v3-d3.md:531–532; fixture at v3-d3.md:541–545 (`person-alex`; "None contains … `money`"); `recall-paraphrase` row in 7.6; R2-PR-08's suggested fix (round-2/practitioner.md:70).

### R3-PR-06  —  major
- **Artifact:** D3 / D2 / D1
- **Location:** GATE.md "**Built-in:** if, in 7.7, built-in's probe hits exceed layer 1's"; "**Keep Layer 1** only if … exceed files' by at least 1 (mean of 3 repetitions)"; 7.7 step 5, a single `claude -p` grader call per probe.
- **What is wrong:** The record test has 5 probes × 3 repetitions = 15 binary outcomes per arm, and its two rules use different bars.
  - "Built-in exceeds layer 1" fires on a margin of one probe in fifteen. With equal true hit rates from 0.4 to 0.8, built-in comes out ahead by chance 41–43% of the time.
  - Keep Layer 1 needs +3 of 15. Its false-pass rate is 13–18%. Against a real gain exactly at the bar (+1 probe per repetition, say 0.6 → 0.8), it passes only 58% of the time.
  - Each repetition's five probes share one record, so they are correlated. The effective sample is nearer 3 than 15, so the real error rates are worse.
  - Each probe gets one judge call, while the eval runner's own `llm` graders take two of three votes.
- **What breaks if we ship it as-is:** Close to half the time, the verdict will say "on Claude Code, use the built-in memory" with no real difference behind it. A real Layer 1 gain at the bar is dropped about four times in ten. Rerun at the next release (D1: "Re-run both tests at every release"), the verdict flips on noise.
- **Suggested fix:** Use one margin for every pairwise rule. Run at least 10 repetitions. Report a paired interval over repetitions, not a bare mean. Use the runner's 2-of-3 judge vote for probes.
- **Evidence:** v3-d3.md:533–534, 1156. Binomial: X, Y ~ Bin(15, p); P(X − Y ≥ 1) = 0.426 at p = 0.6 and 0.409 at p = 0.8; P(X − Y ≥ 3) = 0.176 and 0.125; P(Bin(15, 0.8) − Bin(15, 0.6) ≥ 3) = 0.584.

### R3-PR-07  —  major
- **Artifact:** D3 / D2
- **Location:** D2 §7, "Five sessions end without 'wrap up', so the close pass and catch-up are measured"; D3 7.7 step 4, "Each session: `claude -p "<prompt>"` … After each unclosed session, move every receipt `t` back 3 hours"; contract E `no-handoff`, "a session with ≥ 3 `prompt` rows".
- **What is wrong:** The fix for R2-PR-06 (G7) cannot fire. Each record-test session is one `claude -p` prompt, so it writes one `prompt` row. `no-handoff` needs three or more. No 7.7 session is ever an unclosed session, the catch-up never runs, and moving timestamps back three hours does nothing. Even if the catch-up did run, it only proposes into `_core/inbox.md` and waits for the user's yes. A scripted `-p` session never gives one. Three of the five planted facts sit in sessions that do not wrap up: the risk (3), the commitment (5), and the reversal (7).
- **What breaks if we ship it as-is:** The one record-keeping path Layer 2 adds over Layer 1 is never exercised. Rule 4 of Keep Layer 2 ("full's hits ≥ layer 1's") then compares two arms that use the same mid-task write path, and gives Layer 2 no credit for its main mechanism. D2's sentence claims a measurement that does not happen.
- **Suggested fix:** Make each 7.7 task session at least three turns, using `--resume`. Open each next session with a scripted "yes to all proposals" turn, and count facts that reach `_memories/` through the inbox.
- **Evidence:** v3-d3.md:295, 1155; v3-d2.md:287; 7.7 `script.json` (even sessions wrap up, odd ones do not).

### R3-PR-08  —  major
- **Artifact:** D3 / D2
- **Location:** Contract F, "always exactly one first line … `CORE recall: 0 matches`"; the block, "Before answering a question about past decisions … look in _memories/".
- **What is wrong:** The per-prompt line, added so a dead hook shows (G11), tells the agent that project memory was searched and found nothing. It says that on exactly the questions word matching misses. Nothing tells the agent that zero keyword matches is not zero memories. The Layer 1 arm never sees that line, so it just searches. On `recall-paraphrase`, full gets "CORE recall: 0 matches" next to a memory that answers the question.
- **What breaks if we ship it as-is:** In real use, paraphrased questions about the past get "nothing recorded" answers more often under the full plugin than under Layer 1. In the gate, if full loses two of five runs on `recall-paraphrase`, rule 3 (behind by more than 0.2) vetoes Layer 2 for a reason in one line of text, not in the wiring.
- **Suggested fix:** Change the zero line to "CORE recall: no keyword match; if this is about the past, search _memories/ yourself". Keep the `CORE recall:` prefix so the liveness test still matches.
- **Evidence:** v3-d3.md:362; v3-d2.md:303 (rule 3); fixture summary for `person-alex` in v3-d3.md 0.6.

### R3-PR-09  —  major
- **Artifact:** D3 / D2 / D4
- **Location:** D3 3.2, "Build Lantern (300 memories) … Ten ask for a fact held in one memory"; 0.6, "295 distractors … summary `Note NNN: keep the <a> <b> as it is`, `<a>` cycling 6 words, `<b>` cycling 5"; D2 §7 match-threshold basis; D4 Q5.
- **What is wrong:** The fix for R2-PR-13 (G19) tunes and measures recall on a store that holds four real facts. The rest are 295 copies of one template, built from 30 word pairs, each pair repeated about ten times. Only the four indexed real memories (retry header, data retention, provider deadline, Alex) have a single owner, because each template line is shared by about ten files. So the held-out "ten ask for a fact held in one memory" means about ten paraphrases of four facts. Term frequencies are artificial: "retry" or "cache" sits in 50–60 of 300 lines, and almost every other word is unique. `RARE_FRACTION` is a share of lines, so its tuned value depends on exactly that distribution.
- **What breaks if we ship it as-is:** D4 Q5 and D2's basis table cite a precision and recall measured on four targets in a store that looks nothing like a real project. The thresholds carry over to real stores, with hundreds of distinct summaries and a long tail of shared project words, with no evidence they fit. A wrong `MIN_TERMS` there means either a pointer on every prompt or none.
- **Suggested fix:** Have a separate fresh agent write a varied 300-memory store across 10+ topics, with one fact per memory. Tune and measure on that. Keep Lantern for the gated cases only. Also report results on a migrated real CORE 3 store from the owner's machine, kept local.
- **Evidence:** v3-d3.md:544, 672–676; v3-d2.md:324; v3-d4.md Q5.

### R3-PR-10  —  major
- **Artifact:** D3 / D2
- **Location:** D3 7.5 `blind-check.md`, "a fresh helper writes, per file, one question whose answer it can confirm in the code or git log … (files with none are dropped)"; D2 §7 "On your own project", "you mark each still true or not, which is the answer key".
- **What is wrong:** The fix for R2-PR-20 created two different designs, and the built one cannot show a difference. D3 keeps only memories whose answer is in the code or git log. Those are what the `remember` test says not to write ("Usually no: what the code or git history shows"). The decisions, risks, people, and promises CORE exists for are dropped. The no-record helper still has the code and git, so it finds the same answers. D2 describes a different check: the user marks each memory true and that is the key. A builder follows D3.
- **What breaks if we ship it as-is:** The only check that runs on the owner's real memories tests the wrong slice of the store and ties by construction. `metrics` prints "a direction" that cannot point toward CORE helping or hurting.
- **Suggested fix:** Use D2's design. The user's true or false mark on each sampled memory is the key, and every sampled kind is kept. Drop the code-or-git filter. State one design in both documents.
- **Evidence:** v3-d3.md:1043; v3-d2.md:317; D3 5.1 section 2, "Usually no: what the code or git history shows".

### R3-PR-11  —  major
- **Artifact:** D3 / D2 / D4
- **Location:** D3 2.5 `fork`, "Two memories in `_memories/` have `supersedes` edges to the same target … asks the user which is right"; contract F session-start text; D4 Q16, "caught by `check --project`, which asks which wins".
- **What is wrong:** R2-PR-14 said that a fork made by a git merge is found "only if someone runs `check --project`". The fix (G17) added the `fork` check to `check --project` and nowhere else. The session-start hook, the queue, and the prompt hook never run it. `check --project` runs only when the user asks `metrics` whether CORE works. Meanwhile both forked decisions stay active and indexed. The prompt hook points to both, newest first, and the index line carries no edge to show they conflict.
- **What breaks if we ship it as-is:** In the laptop-plus-cloud case R2-PR-14 described, the user is told "move to v3" and "stay on v2 until January" as two pointers, with no warning. The agent then acts on whichever it opens first. The fork is found weeks later, if ever.
- **Suggested fix:** Run `fork` and `two-live` in the session-start hook. Both are a pass over frontmatter the hook already parses to rebuild the index. Name any fork as a `now` queue item.
- **Evidence:** v3-d3.md:618, 353 (what session-start does); contract E (no fork item); round-2/practitioner.md R2-PR-14.

### R3-PR-12  —  major
- **Artifact:** D3 / D2 / D1
- **Location:** Decision 12, "Hooks need it; skills do not"; contract K "Without the script … Skip `index`"; 5.1 section 11, "run `index`"; D2 §5, "Under Antigravity's sandbox, agent-side commands drop to Layer 1 behaviour; hooks run outside it, so brief and recall still work."
- **What is wrong:** Only the session-start hook rebuilds a stale `INDEX.md`. The prompt hook reads the index as it stands and never checks it. On a rung where hooks run but the agent cannot run the script (Antigravity's sandbox, a Codex sandbox, no Node on the agent's path), the agent replaces a decision by `mv`-ing the old file to `archive/` and cannot run `index`. The same happens on any rung when the agent skips section 11. For the rest of the session, every matching prompt gets a pointer to the old decision's summary, at a path that no longer exists. The new decision is never pointed to.
- **What breaks if we ship it as-is:** "A removed fact stays removed" (D1 §4) fails within the very session that removed it. In D2's own walk-through, the next question about the retry header brings back "Keep the v2 retry header for now".
- **Suggested fix:** Before printing a pointer, the prompt hook checks that the file exists in `_memories/` with status `active`, `done`, or `answered`. That is three file reads, well inside 300 ms. It drops any pointer that fails and writes `index-stale` to the receipt.
- **Evidence:** v3-d3.md:84, 353, 863; contract K "Without the script"; v3-d2.md:215.

### R3-PR-13  —  minor
- **Artifact:** D3 / D2
- **Location:** D3 4.4 section 4(b), "whose id is in no `prompt` or `announce` receipt in that window — only if this machine's oldest receipt is at least that old"; D2 §4, "untouched and unpointed-to for 90 days".
- **What is wrong:** The fix for R2-PR-11 (G16) handles a fresh clone. It misses the steady state for this owner, who works on three machines. Receipts live in git-ignored `_core/`, one set per machine. "Unpointed-to" means "no hook pointed to it on this machine". It also misses every read the agent makes with its own `Grep`, which the block tells it to do and which no receipt records. An explainer used every week on the laptop gets proposed for archive by `pulse` on the desktop, with the claim that it was unread for 90 days.
- **What breaks if we ship it as-is:** The user approves a list whose stated reason is false, and live explainers leave the index. That is a small case of the defect class: the instrument reads one machine and one channel and reports "unread".
- **Suggested fix:** Say what was measured: "not pointed to by CORE's hook on this machine in 90 days". Or require 90 days of receipts on every machine that has touched the project before listing (b).
- **Evidence:** v3-d3.md:808; contract B (`_core/` holds `*` in `.gitignore`); D1 §8 (the owner uses three operating systems, laptop and cloud).

### R3-PR-14  —  minor
- **Artifact:** D3 / D2
- **Location:** Contract E, "`data.recent` lists ids announced on this machine in the last 4 hours"; contract F prompt hook, "A `now` item not in `data.recent` → add `CORE: new item needs you — …`"; `core` skill section 3, "never twice a session"; D2 §3, "You never see … the same reminder twice."
- **What is wrong:** The 4-hour window from R2-PR-10's fix is also used inside a session. An item named in the status block at 9:00 drops out of `data.recent` at 13:00. The next prompt then re-adds it, labeled "new item". This repeats every four hours. The hook labels it new and tells the agent to raise it, while the skill says never twice. Separately, a fourth or later `now` item that did not fit in the status block is also announced as "new" on the first prompt.
- **What breaks if we ship it as-is:** A long working session repeats the same reminder, falsely labeled new, every four hours. Focus fails, and so does D2's "never twice" promise. Whether the agent obeys the hook or the skill is up to the model.
- **Suggested fix:** Also suppress any id with an `announce` row for this session id. Word the line "item needs you", not "new item", unless the item became `now` since the session started.
- **Evidence:** v3-d3.md:301, 363, 774; 3.3 Do, "an `announce` receipt for the items named"; v3-d2.md:169.

### R3-PR-15  —  major
- **Artifact:** D3
- **Location:** D3 7.6 Run, (1) "Normal: `claude plugin eval plugins/core …`" with no `--ablation`; (3) "`claude plugin eval dist/core-layer1 … --ablation none`"; "Record the model each results file names."
- **What is wrong:** The gate subtracts layer 1 from full, and the two scores come from two runner calls with different settings. Neither call passes `--model` or `--judge-model`. The runner's docs say to pin the agent model "so a model rollout isn't mistaken for a plugin regression". The judge defaults to the background-task model, and the docs warn a small judge "can mark a correct answer wrong". That judge scores `proactive-due`'s `llm` grader. The two modes also score differently: "under `--ablation none` nothing is excluded, so the same suite can produce a different absolute score in the two modes". The full run is two-arm and the layer 1 run is one-arm, so any `tool_used: Skill` or `arm: with-only` grader counts in one arm and not the other. R2-PR-22's fix (G7) pinned the model in 7.7 only.
- **What breaks if we ship it as-is:** Full − layer 1 can carry a model change, a judge flip, or a change in which graders are scored. With a 0.2 bar equal to one run, any of these alone can pass or fail Layer 2.
- **Suggested fix:** Pass the same `--model` and `--judge-model sonnet` to all three calls. Run the layer 1 call two-arm as well, or have `cells.mjs` recompute scores from per-grader results over one fixed grader set. Fail the gate as "not measured" if the two results files name different models.
- **Evidence:** v3-d3.md:1135, 1137; https://code.claude.com/docs/en/plugin-evals.md, the `--model` row ("Pin it in CI so a model rollout isn't mistaken for a plugin regression"), "By default, the judge for `llm` and `baseline` graders is the model Claude Code uses for background tasks", and "under `--ablation none` nothing is excluded, so the same suite can produce a different absolute score in the two modes"; round-2/practitioner.md R2-PR-22.

---

Sound and worth keeping: append-only monthly receipts deleted whole; status by folder; proposals-only catch-up; the fixture twins that measure headroom before the build.

critical 4 · major 9 · minor 2 · taste 0
