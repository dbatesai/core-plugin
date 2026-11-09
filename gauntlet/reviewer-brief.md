# Reviewer brief — shared by every gauntlet reviewer

## What you are reviewing

A plan to rewrite CORE, a plugin for coding agents (Claude Code, OpenAI Codex, Google Antigravity). The plan is four documents:

- `gauntlet/v{N}-d1.md` — **D1, The Case.** For a capable reader who has never seen CORE: problem, why solve it, what happens if we don't, the solution and its premise, why this over others, dependencies/tradeoffs/risks, alternatives rejected, competitors compared feature for feature, and a defensible verdict on whether CORE deserves to exist.
- `gauntlet/v{N}-d2.md` — **D2, The Machine.** How it works end to end through a real session, dependencies, moment-to-moment interaction, how it closes each use case, where it falls short, environment detection and the ladder-down table, measurement design, security design.
- `gauntlet/v{N}-d3.md` — **D3, The Build.** Detailed enough that an agent with zero context can finish it without asking anything: ordered phases, deliverable per phase, file-by-file work, decisions made in advance, an acceptance test per step, what to do when a step fails.
- `gauntlet/v{N}-d4.md` — **D4, The Critic Log.** Criticism of the approach, the questions a professional would ask, and the gauntlet findings ledger.

The round number and file version are given in your task.

## The acceptance criteria

Read `gauntlet/contract.md`. It lists the four deliverables with one-line acceptance tests and the nine hard requirements:

1. Use native harness capability across Claude Code, Codex, Antigravity, on macOS, Windows, Linux.
2. Native-first: check whether the harness already does it before CORE builds it.
3. Environment detection with a real ladder-down that names what is lost at each rung; never a silent no-op.
4. Minimal: progressive disclosure, not a pile of scripts and prose.
5. Quality measurement designed in from the first line.
6. Security designed in from the first line: what CORE may read, write, execute; what it never touches; untrusted content; unattended runs.
7. Self-measuring: metrics AND blind evaluation against its own absence or a prior version.
8. Self-auditing: its own prose, scripts, paths, links; detects instrumentation reading nothing.
9. Voice: plain speech, short sentences, written for a distracted reader.

And the defect class the design must kill: **instrumentation that reports success while doing nothing.** "I could not measure this" must never be confusable with "this is fine."

## Evidence you may use

- `gauntlet/grounding.md` — what was read and verified, with citations.
- `gauntlet/research-*.md` and `gauntlet/source-*.md` — the detailed research and source analyses the plan cites. Tags like `[codex §4]` point into these.
- The CORE 3.20.1 source in this repository (`plugins/core/`, `tests/`, `CHANGELOG.md`, `ARCHITECTURE.md`, `USAGE.md`, `INSTALL.md`).
- The web, where your role needs it. Use direct requests only — no relay, mirror, cache, or archive services. Claude Code docs are at `https://code.claude.com/docs/en/<page>.md`; Codex docs at `https://learn.chatgpt.com/docs/<page>.md`; Antigravity docs at `https://antigravity.google/docs/<page>.md`.

Do not trust a citation because it exists. Open it.

## Finding format

Write each finding as one block:

```
### <ID>  —  <severity>
- **Artifact:** D1 / D2 / D3 / D4
- **Location:** section heading or step number, and a short quote
- **What is wrong:** plain sentences
- **What breaks if we ship it as-is:** concrete consequence — REQUIRED
- **Suggested fix:** one or two sentences
- **Evidence:** file:line, URL with quote, or command output, if your claim depends on a fact
```

- Severity is one of `critical`, `major`, `minor`, `taste`.
  - **critical**: a hard requirement or deliverable spec is not met, a load-bearing claim is false, or the plan would ship the very defect class it exists to kill.
  - **major**: a reader or executing agent would be misled or blocked, or a requirement is met only on paper.
  - **minor**: a real but local problem.
  - **taste**: preference.
- A finding without "What breaks if we ship it as-is" is rejected unread.
- Do not write "could be expanded", "consider elaborating", or "add more detail". Name the specific missing thing and what fails without it.
- One problem per finding. Do not repeat a finding another location already covers; cite both locations in one finding.
- Prefer ten findings that matter over forty that do not.

## Earlier rounds

Findings already raised in an earlier round must not be raised again, whether they were accepted or rebutted. Read the earlier reviewers' files in `gauntlet/round-<n>/` (not `defence.md`) before you write, and the ledger in D4 Part 3. If an earlier finding was accepted but the fix is wrong or incomplete, that is a **new** finding: say what the fix broke or missed, and cite the earlier ID.

## Rules

- Write your findings to the output file named in your task, and nothing else. Do not edit the drafts. No git commands. Install nothing.
- Be adverse. You are not here to make the plan feel good. If something is genuinely sound, you may say so in one line at the end; do not pad.
- End your output file with a one-line count: `critical N · major N · minor N · taste N`.
