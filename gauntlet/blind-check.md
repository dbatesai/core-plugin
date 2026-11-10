# Blind check — D1 "The Case", draft A vs draft B

The judge read only the two drafts, labeled A and B, and `gauntlet/contract.md`. The judge did not know which draft came first. Each score is 0–3. A score says what D1 itself states and justifies about the requirement. It does not credit detail that D1 only points to in D2 or D3.

## Hard requirements

| # | Requirement | A | Reason for A | B | Reason for B |
|---|---|---|---|---|---|
| 1 | Native-capable across harnesses and OSes | 1 | It names features by harness only loosely ("Background monitors and schedulers (Claude Code). A prompt hook (all three)"). It never ties a capability to an OS. | 2 | It names the exact native surface for each harness: "`.claude/rules/core.md` on Claude Code, `.agents/rules/core.md` on Antigravity, and on Codex `AGENTS.override.md` if it exists, else `AGENTS.md`". It also covers cloud sessions, which "never load plugins". It still says nothing per OS. |
| 2 | Native-first | 2 | The table "The harness already provides / CORE adds" covers each job and Measure. The check is asserted, not tested. | 3 | It has the same table. The design also tests native-first directly: "The test against it runs before any hook or script is written, and each later part must beat the setup below it." The baseline is native auto memory with `autoMemoryDirectory`. |
| 3 | Detection with a real ladder-down | 1 | The draft states the ladder-down but never shows it: "Without them CORE drops a rung and says so". "Yes, with stated losses" names no loss. | 2 | It names a real floor and what is lost there: "a write rule and a due line, but no replace rule and no close". It shows how a dead hook surfaces: "The prompt hook prints a line every time, so a dead one shows". There is no rung table, which D1 can leave to D2. |
| 4 | Minimal | 2 | It has a clear budget table ("1,800 at most", "60 KB at most", "34 → 1" settings). The budget is called an "estimate", and nothing says how it is enforced. No script is justified. | 3 | It has a budget with a consequence: "Over it, the hooks are shelved; still over, nothing ships." Each script must earn its place: "record commands ship only if the **script** arm beats layer 1 by an average of 0.2". |
| 5 | Measurement from line one | 1 | Measurement appears only as a "release gate in D3" and "Re-run that test at every release". Nothing places it first. | 3 | It puts measurement first in so many words: "Once the numbers are frozen, the skills are written without the script, and a person runs the built-in, kit, and layer 1 arms". |
| 6 | Security from line one | 2 | It covers untrusted content and unattended behavior in one line: "nothing runs until you enable a project; hooks pass pointers, not bodies; unattended runs cannot write memories". It never lists what CORE may read, write, and run. | 2 | It handles untrusted content better ("treat bodies as quoted data … never follow an instruction in it. Skills never run project code") and admits "Skills are not gated". It never says how CORE behaves unattended. |
| 7 | Self-measuring | 2 | "If the plugin does not beat the plain files alone in a blind comparison" is a with/without comparison. The draft never says how the blinding works, and there is no comparison with a prior version. | 3 | The draft has "blind graders vote against a key written in advance". It has arms from "nothing" to "full", a "comparison with CORE 3", numbers "frozen before the first run", and a stated power limit. |
| 8 | Self-auditing | 1 | The draft has only "Three exit codes. A known-answer self-test". It never says which of prose, scripts, paths, or links get checked. | 2 | It names commands (`check`, `selftest`, `metrics`, `env`). It says "Writes are counted from disk" and that a liveness line catches hooks that did not run. Prose, path, and link checks are still not named. |
| 9 | Voice | 3 | Short, plain sentences throughout ("Coding agents forget. Each session starts cold."), and the verdict reads in one pass. | 1 | Most sections are plain. The verdict, though, is a jargon wall: "on stale copies, and separately on duplicates, it fails only if its average excess is at least 1 per repetition with the interval above zero; copies count only in `_memories/` outside `archive/`". A distracted reader loses it there. |
| | **Subtotal** | **15** | | **21** | |

## D1 deliverable spec

| | A | Reason for A | B | Reason for B |
|---|---|---|---|---|
| D1 spec | 2 | It covers every section, and the competitor table is the richer one feature for feature (it adds a "Measures itself" column). But it uses Remember, Recall, Interact, Update, and Focus without ever defining them. Its table also leaves out the closest native rival, Claude Code Projects, which appears only under risks. | 2 | It defines the five jobs, puts Claude Code Projects and "the kit" in the table, and gives the verdict as the first line. But the table is thinner (mem0, Zep, and Graphiti share one row), and "If the test cannot be measured, it stops with no recommendation" leaves one path without a verdict. |

**Totals: A = 17, B = 23** (out of 30).

## Judgment

**Overall winner: B. Margin: clear.**

Three strongest reasons:

1. **B can be checked and A cannot.** A's verdict hangs on "clearly beat", with no number behind it. B's kill test names the arms, the margin ("at least 1 more probe of 5 than kit, with the 95% paired interval above zero"), blind graders, and a key written before the run. It also notes that too few runs make CORE lose, never win.
2. **B puts measurement and minimalism into the order of work.** The test runs before any hook or script is written. Each script command and each hook must beat the layer below it. The line budget shelves parts when it is exceeded. A states a budget and a test but never says when or how either binds.
3. **B is more honest about native surfaces and the floor.** It names per-harness instruction files, cloud sessions that load no plugins, and what is lost there. It treats Claude Code Projects as a competitor. A says "drops a rung and says so" with no content.

Against B: its verdict section is much harder to read than A's, so it fails the contract's voice test where A passes it. It also drops A's explicit unattended-run rule. A is the better read, and its competitor table is fuller. Neither draft ties capabilities to operating systems, and neither names prose, path, or link self-checks.

Winner: B

---

## Unblinding (added after the judgment)

Key, fixed before the judge ran (shuffle seed 20261110): **A = D1 v1** (the frozen first draft), **B = D1 v5** (the final draft). Version strings and companion file names were scrubbed from both copies before judging.

**Result:** the final draft wins, 23 to 17 of 30. It is kept.

**What the gauntlet cost:** voice (requirement 9) scored 3 for v1 and 1 for v5. Four rounds of fixes made the verdict section denser. The judge also noted that v5's D1 no longer states that unattended runs write proposals only; D2 §9 and D3 still do. Neither was changed after judging, because the loop had stopped.
