# Contract — what this run must deliver

Written before anything else. Date: 2026-11-09. Source under review: CORE 3.20.1 at commit `79b526b`.

## The goal, in one line

Plan a complete rewrite of CORE so that it can **remember, recall, interact, update, and focus**.

## Deliverables

| # | Name | It is accepted when… |
|---|------|----------------------|
| D1 | The Case | A capable reader who has never seen CORE can state the problem, the solution, the rejected alternatives, how CORE compares feature-for-feature against the tools it competes with, and the verdict. The verdict is a position, not "it depends". |
| D2 | The Machine | It walks one real session end to end, names every dependency, shows what the user sees moment to moment, closes each use case, says where it falls short, and contains the environment detection, the ladder-down table, the measurement design, and the security design. |
| D3 | The Build | An agent with zero context can finish it without asking anything. Ordered phases. One deliverable per phase. File-by-file work. Decisions already made. An acceptance test per step. A failure procedure per step. |
| D4 | The Critic Log | It attacks the plan. It lists the questions a professional would ask. It records every gauntlet finding with severity, accepted or rebutted, the reason, and the round. It does not defend the plan. |

Working files, all under `gauntlet/`:

- `grounding.md` — what was read, with a citation per claim.
- `v{n}-d1.md` … `v{n}-d4.md` — one set per draft. Each ends with two sections: *Alternatives considered and rejected* and *What I did not verify*.
- `round-{n}-findings.md` — raw reviewer findings and the defence.
- `blind-check.md` — the Step 6 result.

## Hard requirements, as acceptance tests

| # | Requirement | Test |
|---|-------------|------|
| 1 | Native-capable across harnesses and OSes | Every capability the plan uses is tied to a named native feature of Claude Code, Codex, or Antigravity, with the OS it works on. |
| 2 | Native-first | For each thing CORE builds, the plan shows the check "does the harness already do this?" and its answer. |
| 3 | Detection with a real ladder-down | A table names each rung, how it is detected, and exactly what the user loses on it. No rung is a silent no-op. |
| 4 | Minimal | The plan states a size budget for the new plugin and holds to it. Each script must justify why prose or a native feature could not do the job. |
| 5 | Quality measurement from line one | Measurement appears in the first build phase, not the last. |
| 6 | Security from line one | The plan says what CORE may read, write, and run; what it never touches; how it treats untrusted content; how it behaves unattended. |
| 7 | Self-measuring | Metrics plus a blind comparison against CORE's absence or a prior version, where the grader cannot tell which is which. |
| 8 | Self-auditing | CORE can check its own prose, scripts, paths, and links, and can detect instrumentation that is reading nothing. |
| 9 | Voice | Plain speech. Short sentences. No jargon walls. No hedge piles. Written for a distracted reader. |

## The defect class the design must kill

Instrumentation that reports success while doing nothing. The design must make "I could not measure this" impossible to confuse with "this is fine". Each of the five reported defects gets verified against source before the plan relies on it.

## Process

0. Contract (this file).
1. Ground: read the CORE source and the prior art. Write `grounding.md`.
2. Draft v1 of D1–D4.
3. Gauntlet: seven fresh reviewers per round, in parallel, given file paths and acceptance criteria only. Never the reasoning behind the draft.
4. Defend: accept or rebut each finding in writing. A fresh judge settles disputed rebuttals. Apply accepted findings only.
5. Stop when: two rounds in a row with no new critical or major finding; or four rounds; or only minor and taste remain; or budget runs out. Name which fired.
6. Blind check: a fresh judge compares D1 v1 against D1 final, shuffled and unlabeled.
7. Output: D1–D4, then exactly three closing lines.

Round rules: no round makes the bundle longer unless the added text answers an accepted finding. No plain sentence gets turned into dense prose. No new tooling, scripts, or folders beyond `gauntlet/` and the four deliverables.

## Readings adopted

1. **Five capabilities, not six.** Step 0 of the brief says its capabilities are numbered 1, 2, 3, 4, 6 with no 5. The brief as received names five capabilities and does not number them, so the gap is not visible here. I read it as: there are five, and nothing is missing.
2. **"Minimal" means not over-engineered.** Step 0 says the minimal sentence reads as asking for over-engineering. As received it reads correctly. Either way, the reading is: less machinery, less prose, progressive disclosure.
3. **D4 is the critic log.** Step 7 says "D1–D4 plus the critic log". D4 *is* the critic log. The raw per-round files stay in `gauntlet/` as its evidence.
4. **"Task tool" means this harness's Agent tool.** Each reviewer is a fresh agent with no memory of this conversation.
5. **A round** attacks draft v{n} and produces v{n+1}.

## Known limits of this run, found before grounding

- This is a cloud container. There is no CORE plugin cache install here, no workspace `PROJECT.md`, and no memory store. The brief asked for all three. Only the marketplace checkout is present. The defect history is therefore checked against source and `CHANGELOG.md`, not against the workspace that observed it.
- Outbound network is limited. `arxiv.org`, `developers.openai.com`, `antigravity.google`, `docs.letta.com`, and `research.trychroma.com` were refused by the network policy. The brief says not to ask questions, so no network change was requested. Claims that depend on those hosts are graded by how they were actually obtained, and listed as unverified where no primary page could be opened.
